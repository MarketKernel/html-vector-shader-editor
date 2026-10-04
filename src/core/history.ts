// Undo and redo over ops. Every change to the document goes through `run`. A step can
// carry anything the caller wants back on undo or redo (the app keeps the selection).

import type { Op } from './ops';
import type { Document } from './types';

export interface Step<M = unknown> {
  op: Op;
  // Steps with the same key, one right after another, become one (a drag, a nudge).
  key: string | null;
  before: M;
  after: M;
}

export class History<M = unknown> {
  private done: Step<M>[] = [];
  private undone: Step<M>[] = [];
  // The step on top when the document was last saved; null for a document never changed.
  private saved: Step<M> | null = null;

  constructor(private doc: () => Document) {}

  get canUndo(): boolean {
    return this.done.length > 0;
  }
  get canRedo(): boolean {
    return this.undone.length > 0;
  }
  get dirty(): boolean {
    return (this.done[this.done.length - 1] ?? null) !== this.saved;
  }
  get size(): number {
    return this.done.length;
  }
  get top(): Step<M> | null {
    return this.done[this.done.length - 1] ?? null;
  }
  get labels(): string[] {
    return this.done.map((s) => s.op.label);
  }

  run(op: Op, before: M, after: M, key: string | null = null): void {
    op.apply(this.doc());
    this.undone = [];
    const top = this.top;
    if (key !== null && top && top.key === key) {
      const merged = top.op.merge?.(op);
      // A new step object, so a save in between still sees the change.
      this.done[this.done.length - 1] = merged ? { op: merged, key, before: top.before, after } : { op: compose(top.op, op), key, before: top.before, after };
      return;
    }
    this.done.push({ op, key, before, after });
  }

  undo(): Step<M> | null {
    const step = this.done.pop();
    if (!step) return null;
    step.op.revert(this.doc());
    this.undone.push(step);
    return step;
  }

  redo(): Step<M> | null {
    const step = this.undone.pop();
    if (!step) return null;
    step.op.apply(this.doc());
    this.done.push(step);
    return step;
  }

  // A step that may not merge with the next one even with the same key.
  seal(): void {
    const top = this.top;
    if (top) this.done[this.done.length - 1] = { ...top, key: null };
    if (this.saved === top) this.saved = this.top;
  }

  markSaved(): void {
    this.saved = this.top;
  }

  // A document with changes no file holds yet (one restored from the autosave).
  markUnsaved(): void {
    this.saved = UNSAVED as Step<M>;
  }

  clear(): void {
    this.done = [];
    this.undone = [];
    this.saved = null;
  }
}

const UNSAVED: Step<unknown> = { op: { label: '', apply() {}, revert() {} }, key: null, before: null, after: null };

function compose(a: Op, b: Op): Op {
  return {
    label: a.label,
    apply: (doc) => {
      a.apply(doc);
      b.apply(doc);
    },
    revert: (doc) => {
      b.revert(doc);
      a.revert(doc);
    },
  };
}
