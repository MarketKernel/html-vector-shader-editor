// The picture as a list of things to draw, independent of how: every shape with its
// matrix from its own coordinates to the document, its colours premultiplied, its
// parameters packed the way the GLSL library takes them; layers and groups as nested
// lists with their opacity and blend. The WebGL renderer and the GLSL exporter both read
// this, so they cannot disagree about what the document means.

import { premultiplied } from './color';
import { cachedPathGeometry, geometryBounds, isDrawable, paintedBounds, type PathGeometry } from './geometry';
import type { Box } from './matrix';
import { identity, invert, meanScale, multiply, transformBox } from './matrix';
import type { BlendMode, Document, Matrix, Node, Shape } from './types';

// A text is drawn as the path of its glyphs.
export const KIND = { rect: 0, ellipse: 1, line: 2, path: 3, text: 3 } as const;
export const JOIN = { miter: 0, round: 1, bevel: 2 } as const;
export const CAP = { butt: 0, round: 1, square: 2 } as const;

export type Vec4 = [number, number, number, number];

export interface ShapeItem {
  kind: 'shape';
  node: Shape;
  // Local → document, and back.
  world: Matrix;
  inverse: Matrix;
  // Document pixels to local units, for the antialiasing width.
  aaScale: number;
  // What it may paint, in its own coordinates and in the document's.
  localBounds: Box;
  bounds: Box;
  shape: number;
  // Shape parameters: rect (x, y, w, h) + (rx); ellipse (cx, cy, rx, ry); line (x1, y1, x2, y2).
  a: Vec4;
  b: Vec4;
  fill: Vec4;
  stroke: Vec4;
  halfWidth: number;
  // The join for a rectangle, the cap for a line, 1 for an even-odd path (never a text).
  style: number;
  opacity: number;
  path: PathGeometry | null;
}

export interface GroupItem {
  kind: 'group';
  id: string;
  label: string;
  opacity: number;
  blend: BlendMode;
  items: DrawItem[];
  bounds: Box | null;
}

export type DrawItem = ShapeItem | GroupItem;

export interface DrawList {
  width: number;
  height: number;
  background: Vec4 | null;
  layers: GroupItem[];
}

// Needs its own buffer: drawn through an offscreen target, not straight onto what is below.
export const isolated = (g: GroupItem): boolean => g.opacity < 1 || g.blend !== 'normal';

// Tolerances snap to powers of two, so zooming re-flattens only now and then.
const snapTolerance = (t: number) => 2 ** Math.floor(Math.log2(Math.max(t, 1e-4)));

export interface DrawOptions {
  // The largest error allowed when flattening curves, in document pixels as they end up on
  // the target — 0.25 means a quarter of an output pixel.
  tolerance: number;
  // Document pixels per output pixel is 1/scale.
  scale: number;
  // Extra nodes drawn on top of a layer, for a shape still being drawn.
  extra?: { layerId: string; node: Node; parent: Matrix } | null;
}

export function drawList(doc: Document, o: DrawOptions): DrawList {
  const layers: GroupItem[] = [];
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    const items = nodeItems(layer.children, identity(), o);
    if (o.extra && o.extra.layerId === layer.id) items.push(...nodeItems([o.extra.node], o.extra.parent, o));
    layers.push({ kind: 'group', id: layer.id, label: layer.name, opacity: layer.opacity, blend: layer.blend, items, bounds: unionOf(items) });
  }
  return { width: doc.width, height: doc.height, background: doc.background ? premultiplied(doc.background, 1) : null, layers };
}

function unionOf(items: DrawItem[]): Box | null {
  let box: Box | null = null;
  for (const it of items) {
    const b = it.bounds;
    if (!b) continue;
    if (!box) box = { ...b };
    else {
      const x = Math.min(box.x, b.x);
      const y = Math.min(box.y, b.y);
      box = { x, y, width: Math.max(box.x + box.width, b.x + b.width) - x, height: Math.max(box.y + box.height, b.y + b.height) - y };
    }
  }
  return box;
}

function nodeItems(nodes: Node[], parent: Matrix, o: DrawOptions): DrawItem[] {
  const out: DrawItem[] = [];
  for (const n of nodes) {
    if (!n.visible || n.opacity <= 0) continue;
    const world = multiply(parent, n.transform);
    if (n.type === 'group') {
      const items = nodeItems(n.children, world, o);
      if (items.length) out.push({ kind: 'group', id: n.id, label: n.name ?? '', opacity: n.opacity, blend: 'normal', items, bounds: unionOf(items) });
      continue;
    }
    const item = shapeItem(n, world, o);
    if (item) out.push(item);
  }
  return out;
}

export function shapeItem(s: Shape, world: Matrix, o: DrawOptions): ShapeItem | null {
  if (!isDrawable(s)) return null;
  const inverse = invert(world);
  if (!inverse) return null;
  const scale = meanScale(world);
  const aaScale = 1 / (scale * o.scale);
  const fill: Vec4 = s.fill && s.type !== 'line' ? premultiplied(s.fill.color, s.fill.opacity) : [0, 0, 0, 0];
  const stroke: Vec4 = s.stroke && s.stroke.width > 0 ? premultiplied(s.stroke.color, s.stroke.opacity) : [0, 0, 0, 0];
  const halfWidth = s.stroke ? s.stroke.width / 2 : 0;
  if (fill[3] === 0 && stroke[3] === 0) return null;
  let a: Vec4 = [0, 0, 0, 0];
  let b: Vec4 = [0, 0, 0, 0];
  let style = 0;
  let path: PathGeometry | null = null;
  let local: Box;
  switch (s.type) {
    case 'rect':
      a = [s.x, s.y, s.width, s.height];
      b = [s.rx, 0, 0, 0];
      style = JOIN[s.stroke?.join ?? 'miter'];
      local = paintedBounds(s);
      break;
    case 'ellipse':
      a = [s.cx, s.cy, s.rx, s.ry];
      local = paintedBounds(s);
      break;
    case 'line':
      a = [s.x1, s.y1, s.x2, s.y2];
      style = CAP[s.stroke?.cap ?? 'butt'];
      local = paintedBounds(s);
      break;
    case 'path':
    case 'text':
      path = cachedPathGeometry(s, snapTolerance(o.tolerance / (scale * o.scale)));
      style = s.type === 'path' && s.fillRule === 'evenodd' ? 1 : 0;
      local = stroke[3] > 0 ? path.bounds : path.fillBounds;
      // Spaces only: nothing to draw.
      if (s.type === 'text' && !path.chunks) return null;
      if (local.width < 0) local = geometryBounds(s);
      break;
  }
  // Room for the antialiased fringe: a pixel and a bit, in local units.
  const fringe = 1.5 * aaScale;
  const localBounds = { x: local.x - fringe, y: local.y - fringe, width: local.width + 2 * fringe, height: local.height + 2 * fringe };
  return {
    kind: 'shape',
    node: s,
    world,
    inverse,
    aaScale,
    localBounds,
    bounds: transformBox(world, localBounds),
    shape: KIND[s.type],
    a,
    b,
    fill,
    stroke,
    halfWidth,
    style,
    opacity: s.opacity,
    path,
  };
}
