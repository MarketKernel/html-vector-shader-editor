// The editor's state: the document and its history, the selection, the active layer, the
// tool, the style new shapes get, the clipboard and the file the document came from.
// Every change to the document goes through `app.apply()`, one history step each.

import { containerMatrix, createDocument, findLayer, locate } from '../core/document';
import { History } from '../core/history';
import { identity, invert } from '../core/matrix';
import type { Op } from '../core/ops';
import type { Style, TextStyle } from '../core/shapes';
import { DEFAULT_STYLE, DEFAULT_TEXT } from '../core/shapes';
import type { Document, Layer, Matrix, Node } from '../core/types';
import type { Tool } from './tools/tool';
import type { View } from './view';

export interface Snapshot {
  selection: string[];
  context: string | null;
  layer: string;
}

type EventName = 'change' | 'selection' | 'tool' | 'view' | 'file' | 'style';

export interface Draft {
  node: Node;
  parentId: string;
}

class App {
  doc: Document = createDocument(800, 600, '#ffffff', 'Слой 1');
  history = new History<Snapshot>(() => this.doc);
  selection: string[] = [];
  // The group entered by a double click: clicks pick its children. Null at layer level.
  context: string | null = null;
  activeLayer: string = this.doc.layers[0]!.id;
  style: Style = structuredClone(DEFAULT_STYLE);
  // How new texts are set.
  textStyle: TextStyle = { ...DEFAULT_TEXT };
  clipboard: Node[] = [];
  tools: Tool[] = [];
  tool!: Tool;
  view!: View;
  // A shape being drawn, shown on top of its layer until it is committed.
  draft: Draft | null = null;
  fileName = 'Без названия';
  fileHandle: FileSystemFileHandle | null = null;

  private listeners = new Map<EventName, Set<() => void>>();

  on(event: EventName, fn: () => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }

  emit(event: EventName): void {
    this.listeners.get(event)?.forEach((fn) => fn());
  }

  get layer(): Layer {
    return findLayer(this.doc, this.activeLayer) ?? this.doc.layers[this.doc.layers.length - 1]!;
  }

  snapshot(): Snapshot {
    return { selection: [...this.selection], context: this.context, layer: this.activeLayer };
  }

  // Runs an op as one history step. `key`: consecutive steps with the same key merge.
  apply(op: Op, o: { selection?: string[]; layer?: string; key?: string } = {}): void {
    const before = this.snapshot();
    const after: Snapshot = { selection: o.selection ?? before.selection, context: before.context, layer: o.layer ?? before.layer };
    this.history.run(op, before, after, o.key ?? null);
    this.restore(after);
    this.emit('change');
  }

  undo(): void {
    // A path half drawn is dropped, not committed and then undone.
    if (this.tool?.pending?.()) {
      this.tool.cancel?.();
      return;
    }
    this.finish();
    const step = this.history.undo();
    if (!step) return;
    this.restore(step.before);
    this.emit('change');
  }

  redo(): void {
    this.finish();
    const step = this.history.redo();
    if (!step) return;
    this.restore(step.after);
    this.emit('change');
  }

  // Selection, entered group and active layer as recorded, minus what no longer exists.
  private restore(s: Snapshot): void {
    this.activeLayer = findLayer(this.doc, s.layer) ? s.layer : this.layer.id;
    this.context = s.context && locate(this.doc, s.context)?.node.type === 'group' ? s.context : null;
    this.select(s.selection);
  }

  select(ids: string[]): void {
    const next = ids.filter((id, i) => ids.indexOf(id) === i && locate(this.doc, id));
    const changed = next.length !== this.selection.length || next.some((id, i) => id !== this.selection[i]);
    this.selection = next;
    // Selecting something on another layer makes that layer the active one.
    const first = next[0] ? locate(this.doc, next[0]) : null;
    if (first && first.layer.id !== this.activeLayer) this.activeLayer = first.layer.id;
    if (changed) this.emit('selection');
    this.view?.requestRender();
  }

  setLayer(id: string): void {
    if (this.activeLayer === id || !findLayer(this.doc, id)) return;
    this.activeLayer = id;
    this.context = null;
    this.select(this.selection.filter((s) => locate(this.doc, s)?.layer.id === id));
    this.emit('selection');
  }

  enter(groupId: string | null): void {
    this.context = groupId;
    this.emit('selection');
    this.view?.requestRender();
  }

  // Where a new shape goes: the entered group, or the active layer; with the matrix that
  // takes document coordinates into it.
  insertTarget(): { parentId: string; inverse: Matrix } {
    if (this.context && locate(this.doc, this.context)) return { parentId: this.context, inverse: invert(containerMatrix(this.doc, this.context)) ?? identity() };
    return { parentId: this.layer.id, inverse: identity() };
  }

  setTool(id: string): void {
    const tool = this.tools.find((t) => t.id === id);
    if (!tool || tool === this.tool) return;
    this.finish();
    this.tool = tool;
    this.emit('tool');
    this.view?.requestRender();
  }

  // Ends whatever the tool has open (a path being drawn) before a command acts.
  finish(): void {
    this.tool?.finish?.();
    this.draft = null;
  }

  setDraft(draft: Draft | null): void {
    this.draft = draft;
    this.view?.requestRender();
  }

  // A different document altogether: a new history.
  load(doc: Document, fileName: string, handle: FileSystemFileHandle | null = null): void {
    this.finish();
    this.doc = doc;
    this.history = new History<Snapshot>(() => this.doc);
    this.selection = [];
    this.context = null;
    this.activeLayer = doc.layers[doc.layers.length - 1]!.id;
    this.fileName = fileName;
    this.fileHandle = handle;
    this.emit('file');
    this.emit('selection');
    this.emit('change');
    this.view?.fit();
  }

  setStyle(style: Style): void {
    this.style = style;
    this.emit('style');
  }

  setTextStyle(style: TextStyle): void {
    this.textStyle = style;
    this.emit('style');
  }
}

export const app = new App();
