// The GLSL ES 3.00 library both the WebGL renderer and the exported shader are built on.
// The renderer feeds it uniforms and a data texture, the export feeds it constants; the
// arithmetic is this one text, which is why the two pictures agree. Every function here
// has a twin in geometry.ts (for hit testing), written to compute the same thing.
//
// Colours are premultiplied. Distances are signed, negative inside. The caller defines
// `vec4 pathData(int i)` — a texel of the renderer's data texture, or an element of the
// export's constant array — before this text.

export const SDF_LIBRARY = /* glsl */ `
const int JOIN_MITER = 0;
const int JOIN_ROUND = 1;
const int JOIN_BEVEL = 2;
const int CAP_BUTT = 0;
const int CAP_ROUND = 1;
const int CAP_SQUARE = 2;

// Area of a pixel covered at signed distance d, for a pixel aa units wide: a linear ramp
// over one pixel, centred on the edge.
float coverage(float d, float aa) {
  return clamp(0.5 - d / aa, 0.0, 1.0);
}

float sdBox(vec2 p, vec2 h) {
  vec2 q = abs(p) - h;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

// Closest point by iteration (after Chatfield): stable inside and outside, and for very
// flat ellipses where the closed forms lose precision.
float sdEllipse(vec2 p, vec2 ab) {
  ab = max(ab, vec2(1e-6));
  vec2 pa = abs(p);
  vec2 t = vec2(0.70710678);
  for (int i = 0; i < 4; i++) {
    vec2 e = vec2((ab.x * ab.x - ab.y * ab.y) * t.x * t.x * t.x / ab.x, (ab.y * ab.y - ab.x * ab.x) * t.y * t.y * t.y / ab.y);
    vec2 r = ab * t - e;
    vec2 q = pa - e;
    float ql = length(q);
    // At the centre of curvature every direction is as near: keep the last guess.
    if (ql < 1e-9) continue;
    t = clamp((q * length(r) / ql + e) / ab, 0.0, 1.0);
    t /= max(length(t), 1e-12);
  }
  float d = length(pa - ab * t);
  vec2 n = pa / ab;
  return dot(n, n) < 1.0 ? -d : d;
}

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 e = b - a;
  vec2 w = p - a;
  return length(w - e * clamp(dot(w, e) / max(dot(e, e), 1e-12), 0.0, 1.0));
}

// Four corners, any orientation; a triangle repeats its last corner.
float sdQuad(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d) {
  vec2 v[4] = vec2[4](a, b, c, d);
  float dist = dot(p - a, p - a);
  float s = 1.0;
  for (int i = 0, j = 3; i < 4; j = i, i++) {
    vec2 e = v[j] - v[i];
    vec2 w = p - v[i];
    vec2 q = w - e * clamp(dot(w, e) / (dot(e, e) + 1e-12), 0.0, 1.0);
    dist = min(dist, dot(q, q));
    bool c1 = p.y >= v[i].y;
    bool c2 = p.y < v[j].y;
    bool c3 = e.x * w.y > e.y * w.x;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * sqrt(dist);
}

// Fill, then the stroke over it, as SVG paints them.
vec4 paintShape(float fillDist, float strokeDist, vec4 fill, vec4 stroke, float aa) {
  vec4 f = fill * coverage(fillDist, aa);
  vec4 s = stroke * coverage(strokeDist, aa);
  return s + f * (1.0 - s.a);
}

// r = (x, y, width, height); hw = half the stroke width.
vec4 paintRect(vec2 p, vec4 r, float rx, vec4 fill, vec4 stroke, float hw, int join, float aa) {
  vec2 h = r.zw * 0.5;
  vec2 c = p - (r.xy + h);
  float rr = clamp(rx, 0.0, min(h.x, h.y));
  float fd = sdBox(c, h - rr) - rr;
  float sd;
  if (rr > 0.0 || join == JOIN_ROUND) {
    sd = abs(fd) - hw;
  } else {
    // Sharp outer corners for a miter (a right angle is always within the limit), cut
    // ones for a bevel; the inner edge is the same either way.
    float outer = sdBox(c, h + hw);
    if (join == JOIN_BEVEL) outer = max(outer, (abs(c.x) + abs(c.y) - (h.x + h.y + hw)) * 0.70710678);
    sd = max(outer, -(fd + hw));
  }
  return paintShape(fd, sd, fill, stroke, aa);
}

vec4 paintEllipse(vec2 p, vec2 center, vec2 radii, vec4 fill, vec4 stroke, float hw, float aa) {
  float fd = sdEllipse(p - center, radii);
  return paintShape(fd, abs(fd) - hw, fill, stroke, aa);
}

vec4 paintLine(vec2 p, vec2 a, vec2 b, vec4 stroke, float hw, int cap, float aa) {
  vec2 d = b - a;
  float len = length(d);
  if (len < 1e-9) return vec4(0.0);
  float sd;
  if (cap == CAP_ROUND) {
    sd = sdSegment(p, a, b) - hw;
  } else {
    vec2 u = d / len;
    vec2 w = p - (a + b) * 0.5;
    sd = sdBox(vec2(dot(w, u), dot(w, vec2(-u.y, u.x))), vec2(len * 0.5 + (cap == CAP_SQUARE ? hw : 0.0), hw));
  }
  return stroke * coverage(sd, aa);
}

// A flattened path in pathData: fill edges (a.xy, a.zw) from segStart, stroke quads (two
// texels each) from quadStart, round joins and caps (centre.xy, radius) from discStart.
vec4 paintPath(vec2 p, int segStart, int segCount, int quadStart, int quadCount, int discStart, int discCount, bool evenOdd, vec4 fill, vec4 stroke, float aa) {
  float fd = 1e9;
  if (fill.a > 0.0) {
    int winding = 0;
    for (int i = 0; i < segCount; i++) {
      vec4 s = pathData(segStart + i);
      vec2 a = s.xy;
      vec2 b = s.zw;
      fd = min(fd, sdSegment(p, a, b));
      float side = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      if (a.y <= p.y) {
        if (b.y > p.y && side > 0.0) winding++;
      } else if (b.y <= p.y && side < 0.0) {
        winding--;
      }
    }
    bool inside = evenOdd ? (winding & 1) != 0 : winding != 0;
    if (inside) fd = -fd;
  }
  float sd = 1e9;
  if (stroke.a > 0.0) {
    for (int i = 0; i < quadCount; i++) {
      vec4 u = pathData(quadStart + 2 * i);
      vec4 v = pathData(quadStart + 2 * i + 1);
      sd = min(sd, sdQuad(p, u.xy, u.zw, v.xy, v.zw));
    }
    for (int i = 0; i < discCount; i++) {
      vec4 c = pathData(discStart + i);
      sd = min(sd, length(p - c.xy) - c.z);
    }
  }
  return paintShape(fd, sd, fill, stroke, aa);
}

// W3C Compositing and Blending, premultiplied: co = cs(1 - ab) + cb(1 - as) + as·ab·B(Cb, Cs).
// For normal B = Cs, for multiply B = Cb·Cs, for screen B = Cb + Cs - Cb·Cs.
vec4 blendNormal(vec4 b, vec4 s) {
  return s + b * (1.0 - s.a);
}

vec4 blendMultiply(vec4 b, vec4 s) {
  return vec4(s.rgb * (1.0 - b.a) + b.rgb * (1.0 - s.a) + s.rgb * b.rgb, s.a + b.a * (1.0 - s.a));
}

vec4 blendScreen(vec4 b, vec4 s) {
  return vec4(s.rgb + b.rgb - s.rgb * b.rgb, s.a + b.a * (1.0 - s.a));
}
`;
