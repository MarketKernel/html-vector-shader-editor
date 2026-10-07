// The editor's edits, as ops built from the document as it is: transform, group, ungroup,
// reorder, move between layers, duplicate. Each returns the op and what should be
// selected after it; the caller runs the op through the history.

import { allNodes, cloneLayer, cloneNode, containerMatrix, createLayer, locate, parentMatrix, uid } from './document';
import { missingFonts } from './fonts';
import { invert, multiply, multiplyAll } from './matrix';
import type { Op } from './ops';
import { addFonts, batch, insertLayer, insertNode, moveLayer, moveNode, nodeChange, removeLayer, removeNode, sequence, updateNodes } from './ops';
import type { Document, Group, Matrix, Node, Segment } from './types';

export interface Edit {
  op: Op;
  selection: string[];
}

// Document order, bottom to top; ids not found are dropped. Ids inside another of the ids
// are dropped too: moving or deleting a group already takes its children.
export function inZOrder(doc: Document, ids: string[]): string[] {
  const wanted = new Set(ids);
  const order: string[] = [];
  for (const n of allNodes(doc)) if (wanted.has(n.id)) order.push(n.id);
  return order.filter((id) => !locate(doc, id)!.groups.some((g) => wanted.has(g.id) && g.id !== id));
}

// ---- Transforms

const EPS = 1e-9;

function mapSegments(segments: Segment[], m: Matrix): Segment[] {
  const p = (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  return segments.map((s): Segment => {
    switch (s[0]) {
      case 'M':
      case 'L':
        return [s[0], ...p(s[1], s[2])];
      case 'Q':
        return ['Q', ...p(s[1], s[2]), ...p(s[3], s[4])];
      case 'C':
        return ['C', ...p(s[1], s[2]), ...p(s[3], s[4]), ...p(s[5], s[6])];
      case 'Z':
        return ['Z'];
    }
  });
}

// The new property values of a node moved by `delta` (in document space), given the
// matrix of its parent. Where the change can be written into the geometry itself it is —
// a path's points, a rectangle's sides when it is only scaled along its own axes, a
// text's place and size when it is moved or scaled the same both ways — so strokes keep
// their width; anything else (a rotation of a rectangle or a text, any change to a group)
// goes into the node's matrix.
export function transformValues(node: Node, parent: Matrix, delta: Matrix): Record<string, unknown> {
  const world = multiply(parent, node.transform);
  const inv = invert(world);
  if (!inv) {
    const parentInv = invert(parent);
    return parentInv ? { transform: multiplyAll(parentInv, delta, parent, node.transform) } : {};
  }
  // The same change, in the node's own coordinates.
  const L = multiplyAll(inv, delta, world);
  const axisAligned = Math.abs(L[1]) < EPS && Math.abs(L[2]) < EPS;
  switch (node.type) {
    case 'path':
      return { segments: mapSegments(node.segments, L) };
    case 'line': {
      const [x1, y1, x2, y2] = [L[0] * node.x1 + L[2] * node.y1 + L[4], L[1] * node.x1 + L[3] * node.y1 + L[5], L[0] * node.x2 + L[2] * node.y2 + L[4], L[1] * node.x2 + L[3] * node.y2 + L[5]];
      return { x1, y1, x2, y2 };
    }
    case 'rect':
      if (axisAligned) {
        let x = L[0] * node.x + L[4];
        let y = L[3] * node.y + L[5];
        let width = L[0] * node.width;
        let height = L[3] * node.height;
        if (width < 0) [x, width] = [x + width, -width];
        if (height < 0) [y, height] = [y + height, -height];
        return { x, y, width, height };
      }
      break;
    case 'ellipse':
      if (axisAligned) return { cx: L[0] * node.cx + L[4], cy: L[3] * node.cy + L[5], rx: Math.abs(L[0]) * node.rx, ry: Math.abs(L[3]) * node.ry };
      break;
    case 'text':
      // Everything a text is set by scales with its size (line height is in ems).
      if (axisAligned && L[0] > 0 && Math.abs(L[0] - L[3]) < EPS * Math.max(1, L[0])) {
        const k = L[0];
        return k === 1 ? { x: node.x + L[4], y: node.y + L[5] } : { x: k * node.x + L[4], y: k * node.y + L[5], size: k * node.size, letterSpacing: k * node.letterSpacing };
      }
      break;
    case 'group':
      break;
  }
  return { transform: multiply(node.transform, L) };
}

// `delta` applied to the nodes as they are in `originals` (the state when a drag began),
// so a drag recomputes from its start and never accumulates rounding.
export function transformNodes(doc: Document, originals: Node[], delta: Matrix, label = 'Transform'): Op {
  const changes = originals.flatMap((orig) => {
    const at = locate(doc, orig.id);
    if (!at) return [];
    return [nodeChange(at.node, transformValues(orig, parentMatrix(doc, orig.id), delta))];
  });
  return updateNodes(changes, label);
}

// ---- Structure

export function deleteNodes(doc: Document, ids: string[]): Edit {
  const order = inZOrder(doc, ids);
  // Top first, so the indices of the rest stay right.
  return { op: batch('Delete', order.reverse().map((id) => removeNode(doc, id))), selection: [] };
}

// The node's matrix for when it is moved under `target` without changing where it is drawn.
function rebased(doc: Document, id: string, targetId: string): Matrix | null {
  const from = parentMatrix(doc, id);
  const to = containerMatrix(doc, targetId);
  const inv = invert(to);
  if (!inv) return null;
  return multiplyAll(inv, from, locate(doc, id)!.node.transform);
}

export function groupNodes(doc: Document, ids: string[], groupId = uid('g')): Edit | null {
  const order = inZOrder(doc, ids);
  if (!order.length) return null;
  const top = locate(doc, order[order.length - 1]!)!;
  const parentId = top.parent.id;
  const group: Group = { id: groupId, type: 'group', visible: true, locked: false, opacity: 1, transform: [1, 0, 0, 1, 0, 0], children: [] };
  const op = sequence(doc, 'Group', (run) => {
    run(insertNode(parentId, top.index + 1, group));
    for (const id of order) {
      const transform = rebased(doc, id, groupId);
      if (transform) run(updateNodes([nodeChange(locate(doc, id)!.node, { transform })]));
      run(moveNode(doc, id, groupId, group.children.length));
    }
  });
  return { op, selection: [groupId] };
}

export function ungroupNodes(doc: Document, ids: string[]): Edit | null {
  const groups = inZOrder(doc, ids).filter((id) => locate(doc, id)!.node.type === 'group');
  if (!groups.length) return null;
  const selection: string[] = [];
  const op = sequence(doc, 'Ungroup', (run) => {
    for (const gid of groups) {
      const at = locate(doc, gid)!;
      const group = at.node as Group;
      const children = [...group.children];
      children.forEach((child, i) => {
        // The group's opacity applied to each child: the same picture unless they overlap.
        run(updateNodes([nodeChange(child, { transform: multiply(group.transform, child.transform), opacity: child.opacity * group.opacity })]));
        run(moveNode(doc, child.id, at.parent.id, at.index + 1 + i));
        selection.push(child.id);
      });
      run(removeNode(doc, gid));
    }
  });
  return { op, selection };
}

export type Reorder = 'forward' | 'backward' | 'front' | 'back';

export function reorderNodes(doc: Document, ids: string[], how: Reorder): Edit | null {
  const order = inZOrder(doc, ids);
  if (!order.length) return null;
  const selected = new Set(order);
  const op = sequence(doc, { forward: 'Bring forward', backward: 'Send backward', front: 'Bring to front', back: 'Send to back' }[how], (run) => {
    const list = how === 'forward' || how === 'back' ? [...order].reverse() : order;
    for (const id of list) {
      const at = locate(doc, id)!;
      const siblings = at.parent.children;
      let to = at.index;
      if (how === 'front') to = siblings.length - 1;
      else if (how === 'back') to = 0;
      else if (how === 'forward' && at.index < siblings.length - 1 && !selected.has(siblings[at.index + 1]!.id)) to = at.index + 1;
      else if (how === 'backward' && at.index > 0 && !selected.has(siblings[at.index - 1]!.id)) to = at.index - 1;
      if (to !== at.index) run(moveNode(doc, id, at.parent.id, to));
    }
  });
  return { op, selection: order };
}

// To the top of another layer or group, drawn where they were.
export function moveNodesTo(doc: Document, ids: string[], targetId: string): Edit | null {
  // Not into itself, nor into a group inside it.
  const around = locate(doc, targetId)?.groups.map((g) => g.id) ?? [];
  const order = inZOrder(doc, ids).filter((id) => id !== targetId && !around.includes(id));
  if (!order.length) return null;
  const op = sequence(doc, 'Move to layer', (run) => {
    for (const id of order) {
      const transform = rebased(doc, id, targetId);
      if (transform) run(updateNodes([nodeChange(locate(doc, id)!.node, { transform })]));
      const target = doc.layers.find((l) => l.id === targetId) ?? (locate(doc, targetId)!.node as Group);
      const sameParent = locate(doc, id)!.parent.id === targetId;
      run(moveNode(doc, id, targetId, target.children.length - (sameParent ? 1 : 0)));
    }
  });
  return { op, selection: order };
}

// Copies of the nodes, each right above its original, moved by (dx, dy).
export function duplicateNodes(doc: Document, ids: string[], dx = 10, dy = 10): Edit | null {
  const order = inZOrder(doc, ids);
  if (!order.length) return null;
  const selection: string[] = [];
  const op = sequence(doc, 'Duplicate', (run) => {
    for (const id of order) {
      const at = locate(doc, id)!;
      const copy = cloneNode(at.node, true);
      const values = transformValues(copy, parentMatrix(doc, id), [1, 0, 0, 1, dx, dy]);
      const moved = { ...copy, ...values } as Node;
      run(insertNode(at.parent.id, at.index + 1, moved, 'Duplicate'));
      selection.push(moved.id);
    }
  });
  return { op, selection };
}

// Nodes as the clipboard keeps them: deep copies with the matrices of their groups folded
// in, so they paste anywhere and land where they were.
export function copyNodes(doc: Document, ids: string[]): Node[] {
  return inZOrder(doc, ids).map((id) => {
    const copy = cloneNode(locate(doc, id)!.node);
    copy.transform = multiply(parentMatrix(doc, id), copy.transform);
    return copy;
  });
}

export function pasteNodes(doc: Document, nodes: Node[], parentId: string): Edit | null {
  if (!nodes.length) return null;
  const inv = invert(containerMatrix(doc, parentId)) ?? [1, 0, 0, 1, 0, 0];
  const selection: string[] = [];
  const op = sequence(doc, 'Paste', (run) => {
    // Texts copied from another document bring their fonts.
    const fonts = missingFonts(doc, nodes);
    if (fonts.length) run(addFonts(fonts));
    for (const n of nodes) {
      const copy = cloneNode(n, true);
      copy.transform = multiply(inv, copy.transform);
      const parent = doc.layers.find((l) => l.id === parentId) ?? (locate(doc, parentId)!.node as Group);
      run(insertNode(parentId, parent.children.length, copy, 'Paste'));
      selection.push(copy.id);
    }
  });
  return { op, selection };
}

// ---- Layers

export function addLayer(doc: Document, name: string, index = doc.layers.length): { op: Op; id: string } {
  const layer = createLayer(name);
  return { op: insertLayer(index, layer), id: layer.id };
}

export function deleteLayer(doc: Document, id: string): Op | null {
  return doc.layers.length > 1 ? removeLayer(doc, id) : null;
}

export function duplicateLayer(doc: Document, id: string, name: string): { op: Op; id: string } | null {
  const index = doc.layers.findIndex((l) => l.id === id);
  if (index < 0) return null;
  const copy = cloneLayer(doc.layers[index]!, true);
  copy.name = name;
  return { op: insertLayer(index + 1, copy, 'Duplicate layer'), id: copy.id };
}

export function moveLayerTo(doc: Document, id: string, to: number): Op | null {
  const from = doc.layers.findIndex((l) => l.id === id);
  const target = Math.max(0, Math.min(doc.layers.length - 1, to));
  return from < 0 || from === target ? null : moveLayer(from, target);
}
