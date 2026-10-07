// The GLSL ES 3.00 library both the WebGL renderer and the exported shader are built on.
// The renderer feeds it uniforms and a data texture, the export feeds it constants; the
// arithmetic is this one text, which is why the two pictures agree. Every function here
// has a twin in geometry.ts (for hit testing), written to compute the same thing, and one
// in WGSL below (for WebGPU and the WGSL export).
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

// A flattened path in pathData from start: so many chunks, each its box (x0, y0, x1, y1)
// and its counts (edges, quads, discs), then its fill edges (a.xy, a.zw), its stroke quads
// (two texels each) and its round joins and caps (centre.xy, radius). A chunk is whole
// closed contours, which wind zero times around a point outside their box, and its edges
// and pieces are farther than its box: away from the box it changes nothing and is skipped.
vec4 paintPath(vec2 p, int start, int chunks, bool evenOdd, vec4 fill, vec4 stroke, float aa) {
  float fd = 1e9;
  float sd = 1e9;
  int winding = 0;
  int at = start;
  for (int c = 0; c < chunks; c++) {
    vec4 box = pathData(at);
    vec4 n = pathData(at + 1);
    int segs = int(n.x);
    int quads = int(n.y);
    int discs = int(n.z);
    at += 2;
    if (all(greaterThanEqual(p, box.xy - aa)) && all(lessThanEqual(p, box.zw + aa))) {
      if (fill.a > 0.0) {
        for (int i = 0; i < segs; i++) {
          vec4 s = pathData(at + i);
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
      }
      if (stroke.a > 0.0) {
        int q = at + segs;
        for (int i = 0; i < quads; i++) {
          vec4 u = pathData(q + 2 * i);
          vec4 v = pathData(q + 2 * i + 1);
          sd = min(sd, sdQuad(p, u.xy, u.zw, v.xy, v.zw));
        }
        int d = q + 2 * quads;
        for (int i = 0; i < discs; i++) {
          vec4 k = pathData(d + i);
          sd = min(sd, length(p - k.xy) - k.z);
        }
      }
    }
    at += segs + 2 * quads + discs;
  }
  bool inside = evenOdd ? (winding & 1) != 0 : winding != 0;
  if (inside) fd = -fd;
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

// The same library in WGSL, for the WebGPU renderer and the WGSL export: line for line
// the arithmetic above, so the two give the same picture — change them together (the
// browser tests compare WebGPU's picture with WebGL's, and the WGSL export's with both).
// The caller defines `fn pathData(i: i32) -> vec4f`.
export const SDF_LIBRARY_WGSL = /* wgsl */ `
const JOIN_MITER: i32 = 0;
const JOIN_ROUND: i32 = 1;
const JOIN_BEVEL: i32 = 2;
const CAP_BUTT: i32 = 0;
const CAP_ROUND: i32 = 1;
const CAP_SQUARE: i32 = 2;

fn coverage(d: f32, aa: f32) -> f32 {
  return clamp(0.5 - d / aa, 0.0, 1.0);
}

fn sdBox(p: vec2f, h: vec2f) -> f32 {
  let q = abs(p) - h;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}

fn sdEllipse(p: vec2f, radii: vec2f) -> f32 {
  let ab = max(radii, vec2f(1e-6));
  let pa = abs(p);
  var t = vec2f(0.70710678);
  for (var i = 0; i < 4; i++) {
    let e = vec2f((ab.x * ab.x - ab.y * ab.y) * t.x * t.x * t.x / ab.x, (ab.y * ab.y - ab.x * ab.x) * t.y * t.y * t.y / ab.y);
    let r = ab * t - e;
    let q = pa - e;
    let ql = length(q);
    if (ql < 1e-9) {
      continue;
    }
    t = clamp((q * length(r) / ql + e) / ab, vec2f(0.0), vec2f(1.0));
    t /= max(length(t), 1e-12);
  }
  let d = length(pa - ab * t);
  let n = pa / ab;
  return select(d, -d, dot(n, n) < 1.0);
}

fn sdSegment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let e = b - a;
  let w = p - a;
  return length(w - e * clamp(dot(w, e) / max(dot(e, e), 1e-12), 0.0, 1.0));
}

fn sdQuad(p: vec2f, a: vec2f, b: vec2f, c: vec2f, d: vec2f) -> f32 {
  var v = array<vec2f, 4>(a, b, c, d);
  var dist = dot(p - a, p - a);
  var s = 1.0;
  var j = 3;
  for (var i = 0; i < 4; i++) {
    let e = v[j] - v[i];
    let w = p - v[i];
    let q = w - e * clamp(dot(w, e) / (dot(e, e) + 1e-12), 0.0, 1.0);
    dist = min(dist, dot(q, q));
    let c1 = p.y >= v[i].y;
    let c2 = p.y < v[j].y;
    let c3 = e.x * w.y > e.y * w.x;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) {
      s = -s;
    }
    j = i;
  }
  return s * sqrt(dist);
}

fn paintShape(fillDist: f32, strokeDist: f32, fill: vec4f, stroke: vec4f, aa: f32) -> vec4f {
  let f = fill * coverage(fillDist, aa);
  let s = stroke * coverage(strokeDist, aa);
  return s + f * (1.0 - s.a);
}

fn paintRect(p: vec2f, r: vec4f, rx: f32, fill: vec4f, stroke: vec4f, hw: f32, join: i32, aa: f32) -> vec4f {
  let h = r.zw * 0.5;
  let c = p - (r.xy + h);
  let rr = clamp(rx, 0.0, min(h.x, h.y));
  let fd = sdBox(c, h - rr) - rr;
  var sd: f32;
  if (rr > 0.0 || join == JOIN_ROUND) {
    sd = abs(fd) - hw;
  } else {
    var outer = sdBox(c, h + hw);
    if (join == JOIN_BEVEL) {
      outer = max(outer, (abs(c.x) + abs(c.y) - (h.x + h.y + hw)) * 0.70710678);
    }
    sd = max(outer, -(fd + hw));
  }
  return paintShape(fd, sd, fill, stroke, aa);
}

fn paintEllipse(p: vec2f, center: vec2f, radii: vec2f, fill: vec4f, stroke: vec4f, hw: f32, aa: f32) -> vec4f {
  let fd = sdEllipse(p - center, radii);
  return paintShape(fd, abs(fd) - hw, fill, stroke, aa);
}

fn paintLine(p: vec2f, a: vec2f, b: vec2f, stroke: vec4f, hw: f32, cap: i32, aa: f32) -> vec4f {
  let d = b - a;
  let len = length(d);
  if (len < 1e-9) {
    return vec4f(0.0);
  }
  var sd: f32;
  if (cap == CAP_ROUND) {
    sd = sdSegment(p, a, b) - hw;
  } else {
    let u = d / len;
    let w = p - (a + b) * 0.5;
    sd = sdBox(vec2f(dot(w, u), dot(w, vec2f(-u.y, u.x))), vec2f(len * 0.5 + select(0.0, hw, cap == CAP_SQUARE), hw));
  }
  return stroke * coverage(sd, aa);
}

fn paintPath(p: vec2f, start: i32, chunks: i32, evenOdd: bool, fill: vec4f, stroke: vec4f, aa: f32) -> vec4f {
  var fd = 1e9;
  var sd = 1e9;
  var winding = 0;
  var at = start;
  for (var c = 0; c < chunks; c++) {
    let box = pathData(at);
    let n = pathData(at + 1);
    let segs = i32(n.x);
    let quads = i32(n.y);
    let discs = i32(n.z);
    at += 2;
    if (all(p >= box.xy - aa) && all(p <= box.zw + aa)) {
      if (fill.a > 0.0) {
        for (var i = 0; i < segs; i++) {
          let s = pathData(at + i);
          let a = s.xy;
          let b = s.zw;
          fd = min(fd, sdSegment(p, a, b));
          let side = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
          if (a.y <= p.y) {
            if (b.y > p.y && side > 0.0) {
              winding++;
            }
          } else if (b.y <= p.y && side < 0.0) {
            winding--;
          }
        }
      }
      if (stroke.a > 0.0) {
        let q = at + segs;
        for (var i = 0; i < quads; i++) {
          let u = pathData(q + 2 * i);
          let v = pathData(q + 2 * i + 1);
          sd = min(sd, sdQuad(p, u.xy, u.zw, v.xy, v.zw));
        }
        let d = q + 2 * quads;
        for (var i = 0; i < discs; i++) {
          let k = pathData(d + i);
          sd = min(sd, length(p - k.xy) - k.z);
        }
      }
    }
    at += segs + 2 * quads + discs;
  }
  let inside = select(winding != 0, (winding & 1) != 0, evenOdd);
  return paintShape(select(fd, -fd, inside), sd, fill, stroke, aa);
}

fn blendNormal(b: vec4f, s: vec4f) -> vec4f {
  return s + b * (1.0 - s.a);
}

fn blendMultiply(b: vec4f, s: vec4f) -> vec4f {
  return vec4f(s.rgb * (1.0 - b.a) + b.rgb * (1.0 - s.a) + s.rgb * b.rgb, s.a + b.a * (1.0 - s.a));
}

fn blendScreen(b: vec4f, s: vec4f) -> vec4f {
  return vec4f(s.rgb + b.rgb - s.rgb * b.rgb, s.a + b.a * (1.0 - s.a));
}
`;
