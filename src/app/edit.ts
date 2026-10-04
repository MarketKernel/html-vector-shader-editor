// The Edit and Layer menus' work: core/actions.ts builds the ops, this runs them on the
// app's document with the selection that should follow.

import type { Reorder } from '../core/actions';
import { addLayer, copyNodes, deleteLayer, deleteNodes, duplicateLayer, duplicateNodes, groupNodes, inZOrder, moveLayerTo, moveNodesTo, pasteNodes, reorderNodes, ungroupNodes } from '../core/actions';
import { locate } from '../core/document';
import { updateLayer } from '../core/ops';
import type { Layer } from '../core/types';
import { app } from './app';
import { form } from './ui/dialog';

export const hasSelection = (): boolean => app.selection.length > 0;

export function deleteSelection(): void {
  if (!hasSelection()) return;
  app.apply(deleteNodes(app.doc, app.selection).op, { selection: [] });
}

export function selectAll(): void {
  const scope = app.context ? locate(app.doc, app.context)?.node : null;
  if (scope?.type === 'group') {
    app.select(scope.children.filter((c) => c.visible && !c.locked).map((c) => c.id));
    return;
  }
  app.select(app.doc.layers.filter((l) => l.visible && !l.locked).flatMap((l) => l.children.filter((c) => c.visible && !c.locked).map((c) => c.id)));
}

export function copy(): void {
  if (hasSelection()) app.clipboard = copyNodes(app.doc, app.selection);
}

export function cut(): void {
  if (!hasSelection()) return;
  copy();
  const e = deleteNodes(app.doc, app.selection);
  e.op.label = 'Вырезать';
  app.apply(e.op, { selection: [] });
}

// Into the entered group or the active layer, where the copies were drawn.
export function paste(): void {
  if (!app.clipboard.length) return;
  const { parentId } = app.insertTarget();
  const e = pasteNodes(app.doc, app.clipboard, parentId);
  if (e) app.apply(e.op, { selection: e.selection });
}

export function duplicate(): void {
  const e = duplicateNodes(app.doc, app.selection);
  if (e) app.apply(e.op, { selection: e.selection });
}

export function group(): void {
  const e = groupNodes(app.doc, app.selection);
  if (e) app.apply(e.op, { selection: e.selection });
}

export function ungroup(): void {
  const e = ungroupNodes(app.doc, app.selection);
  if (e) app.apply(e.op, { selection: e.selection });
}

export const canUngroup = (): boolean => app.selection.some((id) => locate(app.doc, id)?.node.type === 'group');

export function reorder(how: Reorder): void {
  const e = reorderNodes(app.doc, app.selection, how);
  if (e) app.apply(e.op, { selection: app.selection });
}

// ---- Layers

const nextLayerName = (): string => {
  const used = new Set(app.doc.layers.map((l) => l.name));
  for (let i = app.doc.layers.length + 1; ; i++) if (!used.has(`Слой ${i}`)) return `Слой ${i}`;
};

export function newLayer(): void {
  const index = app.doc.layers.findIndex((l) => l.id === app.activeLayer) + 1;
  const { op, id } = addLayer(app.doc, nextLayerName(), index);
  op.label = 'Новый слой';
  app.apply(op, { layer: id, selection: [] });
}

export function removeLayer(id = app.activeLayer): void {
  const op = deleteLayer(app.doc, id);
  if (!op) return;
  const index = app.doc.layers.findIndex((l) => l.id === id);
  const next = app.doc.layers[index - 1] ?? app.doc.layers[index + 1]!;
  app.apply(op, { layer: next.id, selection: app.selection.filter((s) => locate(app.doc, s)?.layer.id !== id) });
}

export function copyLayer(id = app.activeLayer): void {
  const layer = app.doc.layers.find((l) => l.id === id);
  if (!layer) return;
  const r = duplicateLayer(app.doc, id, `${layer.name} (копия)`);
  if (r) app.apply(r.op, { layer: r.id, selection: [] });
}

export function moveLayer(id: string, to: number): void {
  const op = moveLayerTo(app.doc, id, to);
  if (op) app.apply(op);
}

export function shiftLayer(dir: 1 | -1, id = app.activeLayer): void {
  const index = app.doc.layers.findIndex((l) => l.id === id);
  moveLayer(id, index + dir);
}

export function setLayer(id: string, values: Partial<Omit<Layer, 'id' | 'children'>>, key?: string): void {
  const op = updateLayer(app.doc, id, values);
  if (values.name !== undefined) op.label = 'Переименовать слой';
  app.apply(op, key ? { key } : {});
}

export async function moveSelectionToLayer(): Promise<void> {
  if (!hasSelection()) return;
  const options = [...app.doc.layers].reverse().map((l): [string, string] => [l.id, l.name]);
  const v = await form({ title: 'Перенести на слой', fields: [{ kind: 'select', id: 'layer', label: 'Слой', value: app.activeLayer, options }], ok: 'Перенести' });
  if (!v) return;
  const target = String(v.layer);
  const e = moveNodesTo(app.doc, inZOrder(app.doc, app.selection), target);
  if (e) app.apply(e.op, { selection: e.selection, layer: target });
}
