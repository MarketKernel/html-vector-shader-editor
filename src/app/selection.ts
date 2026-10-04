// Picking and framing: which node a click lands on, and the frame drawn around what is
// selected. The frame is a matrix from the unit square to the document — for one node its
// own (possibly rotated) box, for several the box around them all — so handles, scaling
// and rotation work the same for both.

import { locate, parentMatrix } from '../core/document';
import { geometryBounds, hitShape, nodeBounds } from '../core/geometry';
import type { Box, Point } from '../core/matrix';
import { apply, EMPTY_BOX, invert, isEmptyBox, meanScale, multiply, multiplyAll, scale, translate, unionBox } from '../core/matrix';
import type { Document, Matrix, Node } from '../core/types';
import { app } from './app';

// Is a point (document coordinates) on the node? `m` takes the node's parent space to the
// document; `slop` is in document units.
export function hitNode(node: Node, m: Matrix, x: number, y: number, slop: number): boolean {
  if (!node.visible) return false;
  const world = multiply(m, node.transform);
  if (node.type === 'group') return node.children.some((c) => hitNode(c, world, x, y, slop));
  const inv = invert(world);
  if (!inv) return false;
  const p = apply(inv, x, y);
  return hitShape(node, p.x, p.y, slop / meanScale(world));
}

// The node a click picks: the topmost one hit, as the child of the entered group (or of
// its layer) that holds it. Hidden and locked layers and nodes cannot be picked.
export function hitTest(doc: Document, x: number, y: number, slop: number, context: string | null): string | null {
  const scope = context ? locate(doc, context) : null;
  if (scope && scope.node.type === 'group') {
    const g = scope.node;
    const m = multiply(parentMatrix(doc, g.id), g.transform);
    for (let i = g.children.length - 1; i >= 0; i--) {
      const c = g.children[i]!;
      if (!c.locked && hitNode(c, m, x, y, slop)) return c.id;
    }
    return null;
  }
  for (let l = doc.layers.length - 1; l >= 0; l--) {
    const layer = doc.layers[l]!;
    if (!layer.visible || layer.locked) continue;
    for (let i = layer.children.length - 1; i >= 0; i--) {
      const c = layer.children[i]!;
      if (!c.locked && hitNode(c, [1, 0, 0, 1, 0, 0], x, y, slop)) return c.id;
    }
  }
  return null;
}

// Nodes of the current scope whose box meets a document rectangle.
export function nodesIn(doc: Document, box: Box, context: string | null): string[] {
  const touches = (n: Node, m: Matrix) => {
    const b = nodeBounds(n, m, false);
    return !isEmptyBox(b) && b.x <= box.x + box.width && box.x <= b.x + b.width && b.y <= box.y + box.height && box.y <= b.y + b.height;
  };
  const scope = context ? locate(doc, context) : null;
  if (scope && scope.node.type === 'group') {
    const m = multiply(parentMatrix(doc, scope.node.id), scope.node.transform);
    return scope.node.children.filter((c) => c.visible && !c.locked && touches(c, m)).map((c) => c.id);
  }
  return doc.layers.filter((l) => l.visible && !l.locked).flatMap((l) => l.children.filter((c) => c.visible && !c.locked && touches(c, [1, 0, 0, 1, 0, 0])).map((c) => c.id));
}

// The node's geometry box in its own coordinates (a group's: its children's, in its own).
export function localBox(node: Node): Box {
  if (node.type !== 'group') return geometryBounds(node);
  return node.children.reduce((b, c) => (c.visible ? unionBox(b, nodeBounds(c, [1, 0, 0, 1, 0, 0], false)) : b), { ...EMPTY_BOX });
}

// A box with no thickness (a horizontal line) gets a little, so the frame can be inverted.
function solid(b: Box): Box {
  const out = { ...b };
  if (out.width < 1e-6) {
    out.x -= 0.5;
    out.width = 1;
  }
  if (out.height < 1e-6) {
    out.y -= 0.5;
    out.height = 1;
  }
  return out;
}

export function frameOf(doc: Document, ids: string[]): Matrix | null {
  const nodes = ids.map((id) => locate(doc, id)).filter((at) => !!at);
  if (!nodes.length) return null;
  if (nodes.length === 1) {
    const at = nodes[0]!;
    const box = localBox(at.node);
    if (isEmptyBox(box)) return null;
    const b = solid(box);
    return multiplyAll(parentMatrix(doc, at.node.id), at.node.transform, translate(b.x, b.y), scale(b.width, b.height));
  }
  let box: Box = { ...EMPTY_BOX };
  for (const at of nodes) box = unionBox(box, nodeBounds(at.node, parentMatrix(doc, at.node.id), false));
  if (isEmptyBox(box)) return null;
  const b = solid(box);
  return multiply(translate(b.x, b.y), scale(b.width, b.height));
}

export const selectionFrame = (): Matrix | null => frameOf(app.doc, app.selection);

// The eight handles, in unit-square coordinates, clockwise from the top left.
export const HANDLES: Point[] = [
  { x: 0, y: 0 },
  { x: 0.5, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 0.5 },
  { x: 1, y: 1 },
  { x: 0.5, y: 1 },
  { x: 0, y: 1 },
  { x: 0, y: 0.5 },
];

// The frame's size and angle as the properties panel shows them.
export function frameMetrics(f: Matrix): { x: number; y: number; width: number; height: number; angle: number } {
  const o = apply(f, 0, 0);
  return { x: o.x, y: o.y, width: Math.hypot(f[0], f[1]), height: Math.hypot(f[2], f[3]), angle: (Math.atan2(f[1], f[0]) * 180) / Math.PI };
}
