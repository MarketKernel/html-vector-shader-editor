// The only ways the document changes. Each op knows how to apply itself and how to take
// itself back, so the history keeps ops rather than snapshots. Nodes and layers are
// replaced, never edited in place, when their properties change: anything cached by
// object identity (the renderer's flattened paths) goes stale by itself.

import { findContainer, locate } from './document';
import { registerFont } from './fonts';
import type { Container, Document, FontFace, Layer, Node } from './types';

export interface Op {
  label: string;
  apply(doc: Document): void;
  revert(doc: Document): void;
  // The op that does both this and `next`, for steps that should stay one — a drag.
  merge?(next: Op): Op | null;
}

// A copy of `target` with `values` set; an undefined value removes the key.
function patched<T extends object>(target: T, values: Record<string, unknown>): T {
  const copy = { ...target } as Record<string, unknown>;
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete copy[k];
    else copy[k] = v;
  }
  return copy as T;
}

function container(doc: Document, id: string): Container {
  const c = findContainer(doc, id);
  if (!c) throw new Error(`No layer or group ${id}`);
  return c;
}

export function insertNode(parentId: string, index: number, node: Node, label = 'Insert'): Op {
  return {
    label,
    apply: (doc) => void container(doc, parentId).children.splice(index, 0, node),
    revert: (doc) => void container(doc, parentId).children.splice(index, 1),
  };
}

export function removeNode(doc: Document, id: string, label = 'Delete'): Op {
  const at = locate(doc, id);
  if (!at) throw new Error(`No node ${id}`);
  const parentId = at.parent.id;
  const { index, node } = at;
  return {
    label,
    apply: (d) => void container(d, parentId).children.splice(index, 1),
    revert: (d) => void container(d, parentId).children.splice(index, 0, node),
  };
}

// To `toIndex` in the target's children as they are once the node has left its place.
export function moveNode(doc: Document, id: string, toParentId: string, toIndex: number, label = 'Move'): Op {
  const at = locate(doc, id);
  if (!at) throw new Error(`No node ${id}`);
  const fromParentId = at.parent.id;
  const fromIndex = at.index;
  return {
    label,
    apply: (d) => {
      const [node] = container(d, fromParentId).children.splice(fromIndex, 1);
      container(d, toParentId).children.splice(toIndex, 0, node!);
    },
    revert: (d) => {
      const [node] = container(d, toParentId).children.splice(toIndex, 1);
      container(d, fromParentId).children.splice(fromIndex, 0, node!);
    },
  };
}

export interface NodeChange {
  id: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

// Property changes on any number of nodes. Merging keeps the first `before` and the last
// `after` of each node, so a drag of a thousand moves is still one small step.
export function updateNodes(changes: NodeChange[], label = 'Change'): Op {
  const set = (doc: Document, which: 'before' | 'after') => {
    for (const c of changes) {
      const at = locate(doc, c.id);
      if (!at) throw new Error(`No node ${c.id}`);
      at.parent.children[at.index] = patched(at.node, c[which]);
    }
  };
  return {
    label,
    apply: (doc) => set(doc, 'after'),
    revert: (doc) => set(doc, 'before'),
    merge(next) {
      const more = (next as Op & { changes?: NodeChange[] }).changes;
      if (!more) return null;
      const byId = new Map(changes.map((c) => [c.id, { id: c.id, before: { ...c.before }, after: { ...c.after } }]));
      for (const c of more) {
        const mine = byId.get(c.id);
        if (!mine) byId.set(c.id, { id: c.id, before: { ...c.before }, after: { ...c.after } });
        else {
          for (const [k, v] of Object.entries(c.before)) if (!(k in mine.before)) mine.before[k] = v;
          Object.assign(mine.after, c.after);
        }
      }
      return updateNodes([...byId.values()], label);
    },
    changes,
  } as Op & { changes: NodeChange[] };
}

// The change that sets `values` on a node as it is now.
export function nodeChange(node: Node, values: Record<string, unknown>): NodeChange {
  const before: Record<string, unknown> = {};
  const source = node as unknown as Record<string, unknown>;
  for (const k of Object.keys(values)) before[k] = source[k];
  return { id: node.id, before, after: values };
}

export function insertLayer(index: number, layer: Layer, label = 'New layer'): Op {
  return {
    label,
    apply: (doc) => void doc.layers.splice(index, 0, layer),
    revert: (doc) => void doc.layers.splice(index, 1),
  };
}

export function removeLayer(doc: Document, id: string, label = 'Delete layer'): Op {
  const index = doc.layers.findIndex((l) => l.id === id);
  if (index < 0) throw new Error(`No layer ${id}`);
  const layer = doc.layers[index]!;
  return {
    label,
    apply: (d) => void d.layers.splice(index, 1),
    revert: (d) => void d.layers.splice(index, 0, layer),
  };
}

export function moveLayer(from: number, to: number, label = 'Move layer'): Op {
  const move = (doc: Document, a: number, b: number) => {
    const [layer] = doc.layers.splice(a, 1);
    doc.layers.splice(b, 0, layer!);
  };
  return { label, apply: (doc) => move(doc, from, to), revert: (doc) => move(doc, to, from) };
}

export function updateLayer(doc: Document, id: string, values: Partial<Omit<Layer, 'id' | 'children'>>, label = 'Layer properties'): Op {
  const layer = doc.layers.find((l) => l.id === id);
  if (!layer) throw new Error(`No layer ${id}`);
  const before: Record<string, unknown> = {};
  for (const k of Object.keys(values)) before[k] = layer[k as keyof Layer];
  return layerOp(id, before, values, label);
}

type LayerOp = Op & { layerId: string; before: Record<string, unknown>; after: Record<string, unknown> };

function layerOp(id: string, before: Record<string, unknown>, after: Record<string, unknown>, label: string): LayerOp {
  const set = (d: Document, v: Record<string, unknown>) => {
    const i = d.layers.findIndex((l) => l.id === id);
    d.layers[i] = patched(d.layers[i]!, v);
  };
  return {
    label,
    layerId: id,
    before,
    after,
    apply: (d) => set(d, after),
    revert: (d) => set(d, before),
    merge(next) {
      const n = next as Partial<LayerOp>;
      if (n.layerId !== id || !n.after || !n.before) return null;
      return layerOp(id, { ...n.before, ...before }, { ...after, ...n.after }, label);
    },
  };
}

export type DocumentProps = Pick<Document, 'width' | 'height' | 'background'>;

export function updateDocument(doc: Document, values: Partial<DocumentProps>, label = 'Document properties'): Op {
  const before: Partial<DocumentProps> = {};
  for (const k of Object.keys(values) as (keyof DocumentProps)[]) (before as Record<string, unknown>)[k] = doc[k];
  return {
    label,
    apply: (d) => void Object.assign(d, values),
    revert: (d) => void Object.assign(d, before),
  };
}

// Fonts the document carries from now on.
export function addFonts(faces: FontFace[], label = 'Add font'): Op {
  const ids = new Set(faces.map((f) => f.id));
  return {
    label,
    apply: (doc) => {
      faces.forEach(registerFont);
      doc.fonts.push(...faces);
    },
    revert: (doc) => void (doc.fonts = doc.fonts.filter((f) => !ids.has(f.id))),
  };
}

// Several ops as one step; they are applied in order and reverted in reverse.
export function batch(label: string, ops: Op[]): Op {
  return {
    label,
    apply: (doc) => ops.forEach((op) => op.apply(doc)),
    revert: (doc) => [...ops].reverse().forEach((op) => op.revert(doc)),
  };
}

// Ops whose construction needs the document as each earlier one leaves it (moving several
// nodes, where every move shifts the indices of the next): applied while being built.
export function sequence(doc: Document, label: string, build: (run: (op: Op) => void) => void): Op {
  const done: Op[] = [];
  try {
    build((op) => {
      op.apply(doc);
      done.push(op);
    });
  } finally {
    // Leave the document as it was; the history applies the result again.
    for (const op of [...done].reverse()) op.revert(doc);
  }
  return batch(label, done);
}
