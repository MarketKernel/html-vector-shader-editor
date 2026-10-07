// What the shader exports share — GLSL, Shadertoy and WGSL: the document's draw list
// (the renderer's own, draw.ts) written out over the SDF library, with the geometry as
// constants — shapes as numbers in the calls, flattened paths in one constant array — and
// one function per layer and per group, composited with their opacity and blend as the
// renderer's offscreen targets do. A dialect spells each piece in its language; the
// structure, the numbers and the warnings are the same for all of them.

import type { DrawItem, GroupItem, ShapeItem } from './draw';
import { drawList } from './draw';
import { flatten } from './geometry';
import type { Document, Node } from './types';

export interface Dialect {
  vec2(x: number, y: number): string;
  vec4(v: readonly number[]): string;
  transparent: string;
  mat2(m: readonly number[]): string;
  // A function (p, px) → colour that starts transparent and runs `body` on `c`.
  fn(name: string, body: string[]): string;
  local(name: string, value: string): string;
  // The constant array of path data, and pathData() reading it.
  data(vectors: number[][]): string;
  library: string;
  // inBounds(p, box, px): whether p is near enough the box to be worth computing.
  inBounds: string;
  // drawDocument(p, px): the layers composited over the background.
  drawDocument(background: string, calls: string[]): string;
}

// Fine enough to stay smooth when the shader is shown a few times larger than the document.
export const SHADER_TOLERANCE = 0.1;

// Past these, some GPUs and shader compilers take long or refuse.
export const SHADER_DATA_LIMIT = 4096;
export const SHADER_SHAPE_LIMIT = 1000;

// A float literal GLSL and WGSL accept: always with a point or an exponent.
export function glf(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) < 1e-9) return '0.0';
  let s = String(Number(n.toPrecision(7)));
  if (s.includes('e')) {
    if (!s.split('e')[0]!.includes('.')) s = s.replace('e', '.0e');
  } else if (!s.includes('.')) s += '.0';
  return s;
}

// Comment text cannot end a comment early or start a directive.
export const commentSafe = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/\*\//g, '* /').slice(0, 60);

const ident = (prefix: string, i: number) => `${prefix}${i}`;

const describe = (kind: string, name: string | undefined, id: string) => (name ? `${kind} "${commentSafe(name)}" (${commentSafe(id)})` : `${kind} ${commentSafe(id)}`);

// A text is named by its words when it has no name of its own.
const nodeName = (n: Node) => n.name ?? (n.type === 'text' ? n.text : undefined);

class Writer {
  data: number[] = [];
  functions: string[] = [];
  shapes = 0;
  private count = { layer: 0, group: 0 };

  constructor(private d: Dialect) {}

  // A function for a layer or a group; returns its name.
  container(g: GroupItem, prefix: 'layer' | 'group'): string {
    const name = ident(prefix, this.count[prefix]++);
    const body: string[] = [];
    for (const it of g.items) body.push(...this.item(it));
    this.functions.push(`// ${describe(prefix, g.label, g.id)}\n${this.d.fn(name, body)}`);
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
    const { vec2, vec4 } = this.d;
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
      case 'path':
      case 'text': {
        const g = s.path!;
        call = `paintPath(q, ${this.push(g.packed)}, ${g.chunks}, ${s.style === 1}, ${vec4(s.fill)}, ${vec4(s.stroke)}, ${aa})`;
        break;
      }
    }
    const paint = s.opacity < 1 ? `${call} * ${glf(s.opacity)}` : call;
    const linear = Math.abs(m[0] - 1) > 1e-9 || Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9 || Math.abs(m[3] - 1) > 1e-9;
    const moved = Math.abs(m[4]) > 1e-9 || Math.abs(m[5]) > 1e-9;
    // The point in the shape's own coordinates.
    const q = linear ? `${this.d.mat2([m[0], m[1], m[2], m[3]])} * p${moved ? ` + ${vec2(m[4], m[5])}` : ''}` : moved ? `p + ${vec2(m[4], m[5])}` : 'p';
    return [
      `  // ${describe(s.node.type, nodeName(s.node), s.node.id)}`,
      `  if (inBounds(p, ${vec4([b.x, b.y, b.x + b.width, b.y + b.height])}, px)) {`,
      `    ${this.d.local('q', q)}`,
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

// The constants, the SDF library, a function per layer and group, and drawDocument(),
// which composites the layers over the background and returns the premultiplied colour
// at document point p.
export function shaderBody(doc: Document, d: Dialect): { body: string; warnings: string[] } {
  const warnings: string[] = [];
  const list = drawList(doc, { tolerance: SHADER_TOLERANCE, scale: 1 });
  const w = new Writer(d);
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
  if (vectors > SHADER_DATA_LIMIT) warnings.push(`The path data is ${vectors} vec4 constants; above ${SHADER_DATA_LIMIT} some GPUs compile it slowly or not at all.`);
  if (w.shapes > SHADER_SHAPE_LIMIT) warnings.push(`${w.shapes} shapes make a long shader; above ${SHADER_SHAPE_LIMIT} compiling it may take seconds.`);

  const background = list.background ? d.vec4(list.background) : d.transparent;
  const body = `${d.data(chunk(w.data, 4))}
${d.library}
${d.inBounds}

${w.functions.join('\n\n')}

${d.drawDocument(background, calls)}`;
  return { body, warnings };
}

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
