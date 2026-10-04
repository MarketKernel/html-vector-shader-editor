// GLSL export: a fragment shader that draws the document on its own. The SDF library is
// the renderer's (sdf.ts); the geometry goes in as constants — shapes as numbers in the
// calls, flattened paths in one constant array. One function per layer and per group,
// composited in main() with their opacity and blend, as the renderer's offscreen targets
// do. The result depends only on uResolution.

import type { DrawItem, GroupItem, ShapeItem } from './draw';
import { drawList } from './draw';
import { flatten } from './geometry';
import { SDF_LIBRARY } from './sdf';
import type { ExportResult } from './svg';
import type { Document, Node } from './types';

// Fine enough to stay smooth when the shader is shown a few times larger than the document.
export const GLSL_TOLERANCE = 0.1;

// Past these, some GPUs and ANGLE back ends compile slowly or refuse.
export const GLSL_DATA_LIMIT = 4096;
export const GLSL_SHAPE_LIMIT = 1000;

// A float literal GLSL accepts: always with a point or an exponent.
export function glf(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) < 1e-9) return '0.0';
  let s = String(Number(n.toPrecision(7)));
  if (s.includes('e')) {
    if (!s.split('e')[0]!.includes('.')) s = s.replace('e', '.0e');
  } else if (!s.includes('.')) s += '.0';
  return s;
}

const vec4 = (v: readonly number[]) => `vec4(${v.map(glf).join(', ')})`;
const vec2 = (x: number, y: number) => `vec2(${glf(x)}, ${glf(y)})`;

// Comment text cannot end a comment early or start a directive.
const commentSafe = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/\*\//g, '* /').slice(0, 60);

const ident = (prefix: string, i: number) => `${prefix}${i}`;

const describe = (kind: string, name: string | undefined, id: string) => (name ? `${kind} "${commentSafe(name)}" (${commentSafe(id)})` : `${kind} ${commentSafe(id)}`);

class Writer {
  data: number[] = [];
  functions: string[] = [];
  shapes = 0;
  private count = { layer: 0, group: 0 };

  // A function for a layer or a group; returns its name.
  container(g: GroupItem, prefix: 'layer' | 'group'): string {
    const name = ident(prefix, this.count[prefix]++);
    const body: string[] = [];
    for (const it of g.items) body.push(...this.item(it));
    this.functions.push(`// ${describe(prefix, g.label, g.id)}\nvec4 ${name}(vec2 p, float px) {\n  vec4 c = vec4(0.0);\n${body.join('\n')}\n  return c;\n}`);
    return name;
  }

  item(it: DrawItem): string[] {
    if (it.kind === 'group') {
      const fn = this.container(it, 'group');
      const call = `${fn}(p, px)`;
      return [`  c = blendNormal(c, ${it.opacity < 1 ? `${call} * ${glf(it.opacity)}` : call});`];
    }
    this.shapes++;
    return this.shape(it);
  }

  shape(s: ShapeItem): string[] {
    const m = s.inverse;
    const b = s.bounds;
    const aa = `px * ${glf(s.aaScale)}`;
    let call: string;
    switch (s.node.type) {
      case 'rect':
        call = `paintRect(q, ${vec4(s.a)}, ${glf(s.b[0])}, ${vec4(s.fill)}, ${vec4(s.stroke)}, ${glf(s.halfWidth)}, ${s.style}, ${aa})`;
        break;
      case 'ellipse':
        call = `paintEllipse(q, ${vec2(s.a[0], s.a[1])}, ${vec2(s.a[2], s.a[3])}, ${vec4(s.fill)}, ${vec4(s.stroke)}, ${glf(s.halfWidth)}, ${aa})`;
        break;
      case 'line':
        call = `paintLine(q, ${vec2(s.a[0], s.a[1])}, ${vec2(s.a[2], s.a[3])}, ${vec4(s.stroke)}, ${glf(s.halfWidth)}, ${s.style}, ${aa})`;
        break;
      case 'path': {
        const g = s.path!;
        const seg = this.push(g.segs);
        const quad = this.push(g.quads);
        const disc = this.push(g.discs);
        call = `paintPath(q, ${seg}, ${g.segs.length / 4}, ${quad}, ${g.quads.length / 8}, ${disc}, ${g.discs.length / 4}, ${s.style === 1}, ${vec4(s.fill)}, ${vec4(s.stroke)}, ${aa})`;
        break;
      }
    }
    const paint = s.opacity < 1 ? `${call} * ${glf(s.opacity)}` : call;
    const linear = Math.abs(m[0] - 1) > 1e-9 || Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9 || Math.abs(m[3] - 1) > 1e-9;
    const moved = Math.abs(m[4]) > 1e-9 || Math.abs(m[5]) > 1e-9;
    // The point in the shape's own coordinates.
    const q = linear ? `mat2(${[m[0], m[1], m[2], m[3]].map(glf).join(', ')}) * p${moved ? ` + ${vec2(m[4], m[5])}` : ''}` : moved ? `p + ${vec2(m[4], m[5])}` : 'p';
    return [
      `  // ${describe(s.node.type, s.node.name, s.node.id)}`,
      `  if (inBounds(p, ${vec4([b.x, b.y, b.x + b.width, b.y + b.height])}, px)) {`,
      `    vec2 q = ${q};`,
      `    c = blendNormal(c, ${paint});`,
      '  }',
    ];
  }

  // Adds vec4s to the constant array; returns the index of the first.
  private push(values: number[]): number {
    const at = this.data.length / 4;
    this.data.push(...values);
    return at;
  }
}

const BLEND_FN = { normal: 'blendNormal', multiply: 'blendMultiply', screen: 'blendScreen' } as const;

// What both shader flavours share: the constants, the SDF library, a function per layer
// and group, and drawDocument(), which composites the layers over the background and
// returns the premultiplied colour at document point p.
function shaderBody(doc: Document): { body: string; warnings: string[] } {
  const warnings: string[] = [];
  const list = drawList(doc, { tolerance: GLSL_TOLERANCE, scale: 1 });
  const w = new Writer();
  const calls = list.layers.map((layer) => {
    const fn = w.container(layer, 'layer');
    const call = `${fn}(p, px)`;
    return `  c = ${BLEND_FN[layer.blend]}(c, ${layer.opacity < 1 ? `${call} * ${glf(layer.opacity)}` : call});`;
  });

  const vectors = w.data.length / 4;
  for (const n of visibleNodes(doc)) {
    if (n.type === 'path' && n.stroke && n.stroke.cap !== 'butt' && flatten(n.segments, 1).some((s) => s.points.length === 1))
      warnings.push(`Path "${n.name ?? n.id}": a subpath of one point is not drawn (SVG draws it as a dot with a ${n.stroke.cap} cap).`);
  }
  if (vectors > GLSL_DATA_LIMIT) warnings.push(`The path data is ${vectors} vec4 constants; above ${GLSL_DATA_LIMIT} some GPUs compile it slowly or not at all.`);
  if (w.shapes > GLSL_SHAPE_LIMIT) warnings.push(`${w.shapes} shapes make a long shader; above ${GLSL_SHAPE_LIMIT} compiling it may take seconds.`);

  const data = vectors
    ? `const vec4 DATA[${vectors}] = vec4[${vectors}](\n${chunk(w.data, 4)
        .map((v) => `  ${vec4(v)}`)
        .join(',\n')}\n);`
    : 'const vec4 DATA[1] = vec4[1](vec4(0.0));';
  const background = list.background ? vec4(list.background) : 'vec4(0.0)';

  const body = `${data}

vec4 pathData(int i) {
  return DATA[i];
}
${SDF_LIBRARY}
// Skips a shape's arithmetic away from it; the margin keeps its antialiased edge.
bool inBounds(vec2 p, vec4 box, float px) {
  return all(greaterThanEqual(p, box.xy - 2.0 * px)) && all(lessThanEqual(p, box.zw + 2.0 * px));
}

${w.functions.join('\n\n')}

// The whole page at document point p, premultiplied; px is document units per pixel.
vec4 drawDocument(vec2 p, float px) {
  vec4 c = ${background};
${calls.join('\n')}
  return c;
}`;
  return { body, warnings };
}

export function exportGlsl(doc: Document, title = 'Untitled'): ExportResult {
  const { body, warnings } = shaderBody(doc);
  const text = `#version 300 es
// "${commentSafe(title)}" — ${doc.width} × ${doc.height}, exported from HTML Vector Editor.
//
// To run: draw a quad (or one big triangle) over the whole viewport with this as the
// fragment shader and set the one uniform, uResolution, to the viewport's size in pixels.
// The document is stretched over the viewport; at uResolution = (${doc.width}, ${doc.height}) its
// pixels are the PNG export's. The colour written is premultiplied by alpha, as WebGL's
// default canvas (premultipliedAlpha: true) and blendFunc(ONE, ONE_MINUS_SRC_ALPHA) expect.
precision highp float;
precision highp int;
uniform vec2 uResolution;      // the viewport's size; the document fills the viewport
out vec4 fragColor;
// p — document coordinates: (0,0) top left, Y down; when uResolution equals the document's
// size, pixels coincide with the PNG export

${body}

void main() {
  vec2 size = vec2(${glf(doc.width)}, ${glf(doc.height)});
  vec2 p = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) * (size / uResolution);
  // Document units per screen pixel, for the antialiasing.
  float px = length(fwidth(p)) * 0.70710678;
  fragColor = drawDocument(p, px);
}
`;
  return { text, warnings };
}

// The same picture for shadertoy.com's Image tab: no #version, precision, uniforms or
// outputs (Shadertoy declares those), mainImage() instead of main(), iResolution for the
// viewport. Shadertoy shows the colour opaque, so the page is fitted into the view with
// its proportions kept, over squares where it is transparent, on a dark surround.
export function exportShadertoy(doc: Document, title = 'Untitled'): ExportResult {
  const { body, warnings } = shaderBody(doc);
  const text = `// "${commentSafe(title)}" — ${doc.width} × ${doc.height}, exported from HTML Vector Editor
// for shadertoy.com: paste over the code of a new shader's Image tab and run.
//
// The page is fitted into the view, centred, its proportions kept. Where it is transparent
// it shows over grey squares, outside it a dark surround. At iResolution = (${doc.width}, ${doc.height})
// its pixels are the PNG export's (over the squares).
// p — document coordinates: (0,0) top left, Y down

${body}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 size = vec2(${glf(doc.width)}, ${glf(doc.height)});
  float k = min(iResolution.x / size.x, iResolution.y / size.y);
  vec2 corner = (iResolution.xy - size * k) * 0.5;
  vec2 p = (vec2(fragCoord.x, iResolution.y - fragCoord.y) - corner) / k;
  // Document units per screen pixel, for the antialiasing; taken before any branch.
  float px = length(fwidth(p)) * 0.70710678;
  vec4 c = drawDocument(p, px);
  vec2 cell = floor(fragCoord / 8.0);
  vec3 squares = mod(cell.x + cell.y, 2.0) < 1.0 ? vec3(1.0) : vec3(0.87);
  bool onPage = all(greaterThanEqual(p, vec2(0.0))) && all(lessThan(p, size));
  vec3 back = onPage ? squares : vec3(0.12);
  // Nothing of the document shows off the page, as in every other export.
  vec3 colour = onPage ? c.rgb + back * (1.0 - c.a) : back;
  fragColor = vec4(colour, 1.0);
}
`;
  return { text, warnings };
}

// A Shadertoy shader made runnable on its own (the export dialog's preview and the tests):
// the declarations Shadertoy would add, and a main() that calls mainImage(). The one
// uniform set is uResolution, as for the plain export.
export function shadertoyStandalone(code: string): string {
  return `${SHADERTOY_PREFIX}${code}
void main() {
  mainImage(shadertoyColor, gl_FragCoord.xy);
}
`;
}

const SHADERTOY_PREFIX = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform int iFrame;
uniform vec4 iMouse;
#define iResolution vec3(uResolution, 1.0)
out vec4 shadertoyColor;
`;

// Compiler messages about the wrapped shader, with line numbers of the text as pasted.
export const shadertoyLog = (log: string): string => {
  const shift = SHADERTOY_PREFIX.split('\n').length - 1;
  return log.replace(/\b0:(\d+)/g, (_, n: string) => `0:${Math.max(1, Number(n) - shift)}`);
};

function chunk(values: number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function* visibleNodes(doc: Document): Generator<Node> {
  function* walk(nodes: Node[]): Generator<Node> {
    for (const n of nodes) {
      if (!n.visible) continue;
      yield n;
      if (n.type === 'group') yield* walk(n.children);
    }
  }
  for (const l of doc.layers) if (l.visible) yield* walk(l.children);
}
