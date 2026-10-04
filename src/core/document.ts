// Finding things in the tree of layers and groups, and making new documents and nodes.

import { identity, multiply } from './matrix';
import type { Container, Document, Group, Layer, Matrix, Node } from './types';
import { DOCUMENT_VERSION } from './types';

let counter = 0;
// Unique enough within one document and short enough to read in an SVG.
export function uid(prefix = 'n'): string {
  counter = (counter + 1) % 0x10000;
  return `${prefix}${Date.now().toString(36).slice(-5)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function createLayer(name: string, id = uid('layer-')): Layer {
  return { id, name, visible: true, locked: false, opacity: 1, blend: 'normal', children: [] };
}

export function createDocument(width: number, height: number, background: string | null, layerName = 'Layer 1'): Document {
  return { version: DOCUMENT_VERSION, width, height, background, layers: [createLayer(layerName)] };
}

export interface Location {
  node: Node;
  // The layer or group whose children hold it, and where.
  parent: Container;
  index: number;
  layer: Layer;
  // Groups from the layer down to the parent, outermost first.
  groups: Group[];
}

export function locate(doc: Document, id: string): Location | null {
  for (const layer of doc.layers) {
    const found = search(layer.children, id, layer, layer, []);
    if (found) return found;
  }
  return null;
}

function search(children: Node[], id: string, parent: Container, layer: Layer, groups: Group[]): Location | null {
  for (let i = 0; i < children.length; i++) {
    const node = children[i]!;
    if (node.id === id) return { node, parent, index: i, layer, groups };
    if (node.type === 'group') {
      const found = search(node.children, id, node, layer, [...groups, node]);
      if (found) return found;
    }
  }
  return null;
}

export const findNode = (doc: Document, id: string): Node | null => locate(doc, id)?.node ?? null;

export const findLayer = (doc: Document, id: string): Layer | null => doc.layers.find((l) => l.id === id) ?? null;

// A layer or a group, by id.
export function findContainer(doc: Document, id: string): Container | null {
  const layer = findLayer(doc, id);
  if (layer) return layer;
  const node = findNode(doc, id);
  return node?.type === 'group' ? node : null;
}

// From the node's parent space to the document: every enclosing group's transform.
export function parentMatrix(doc: Document, id: string): Matrix {
  const at = locate(doc, id);
  if (!at) return identity();
  return at.groups.reduce((m, g) => multiply(m, g.transform), identity());
}

// From the node's own coordinates to the document.
export function worldMatrix(doc: Document, id: string): Matrix {
  const at = locate(doc, id);
  if (!at) return identity();
  return multiply(parentMatrix(doc, id), at.node.transform);
}

// The matrix that takes a container's children to the document: identity for a layer.
export function containerMatrix(doc: Document, id: string): Matrix {
  const at = locate(doc, id);
  return at?.node.type === 'group' ? multiply(parentMatrix(doc, id), at.node.transform) : identity();
}

export function* walkNodes(children: Node[]): Generator<Node> {
  for (const node of children) {
    yield node;
    if (node.type === 'group') yield* walkNodes(node.children);
  }
}

export function* allNodes(doc: Document): Generator<Node> {
  for (const layer of doc.layers) yield* walkNodes(layer.children);
}

// A deep copy; with `fresh`, every node gets a new id, as a paste or a duplicate needs.
export function cloneNode<T extends Node>(node: T, fresh = false): T {
  const copy = structuredCloneJson(node);
  if (fresh) for (const n of walkNodes([copy])) n.id = uid(n.type === 'group' ? 'g' : n.type[0]);
  return copy;
}

export function cloneLayer(layer: Layer, fresh = false): Layer {
  const copy = structuredCloneJson(layer);
  if (fresh) {
    copy.id = uid('layer-');
    for (const n of walkNodes(copy.children)) n.id = uid(n.type === 'group' ? 'g' : n.type[0]);
  }
  return copy;
}

// The model is plain JSON, so this is a faithful copy and works the same in Node.
export const structuredCloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
