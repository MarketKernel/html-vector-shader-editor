// Text: a click on empty canvas starts a new text there, a click on a text edits it.
// Typing goes into a hidden <textarea> — so the keyboard, input methods, the clipboard and
// the textarea's own undo all work as usual — and the text is set and drawn from it as it
// changes; the caret and the selection are drawn over the canvas by the text's own layout.
// Esc or a click elsewhere ends the editing: a new text is committed as one step, the
// changes to an existing one are one step too.

import { locate, worldMatrix } from '../../core/document';
import { fontOf, missingFonts } from '../../core/fonts';
import type { Point } from '../../core/matrix';
import { apply, invert } from '../../core/matrix';
import { addFonts, nodeChange, removeNode, updateNodes } from '../../core/ops';
import { makeText } from '../../core/shapes';
import type { TextLayout } from '../../core/text';
import { cachedLayout, caretAt, caretPosition, isLowSurrogate } from '../../core/text';
import type { Matrix, Text } from '../../core/types';
import { app } from '../app';
import { commandFor, runCommand } from '../commands';
import { hitTest } from '../selection';
import { accent } from '../view';
import { canDraw, commitShape } from './shapes';
import type { Tool, ToolEvent } from './tool';

interface Session {
  // The node being edited, or null for a new text not yet in the document.
  id: string | null;
  // The text as it is now: the document's node, or the draft.
  node: Text;
  key: string;
}

let session: Session | null = null;
let sessions = 0;
let selecting: number | null = null;
let pressed = false;
let blink = true;
let blinkTimer = 0;
let input: HTMLTextAreaElement | null = null;

// The text's own coordinates → document: a draft is drawn in document coordinates.
const world = (s: Session): Matrix => (s.id ? worldMatrix(app.doc, s.id) : [1, 0, 0, 1, 0, 0]);

const layoutOf = (s: Session): TextLayout => cachedLayout(s.node);

function textarea(): HTMLTextAreaElement {
  if (input) return input;
  const t = document.createElement('textarea');
  t.className = 'text-input';
  t.setAttribute('aria-label', 'Текст');
  t.setAttribute('autocomplete', 'off');
  t.setAttribute('autocapitalize', 'off');
  t.spellcheck = false;
  t.wrap = 'off';
  app.view.workspace.append(t);
  t.addEventListener('input', () => {
    if (!session) return;
    setText(t.value);
    restartBlink();
  });
  t.addEventListener('keydown', keydown);
  t.addEventListener('keyup', () => app.view.requestRender());
  t.addEventListener('select', () => app.view.requestRender());
  // Typing elsewhere (a panel field, a menu) ends the editing; a click on the canvas,
  // which takes the focus too, does not.
  t.addEventListener('blur', () => {
    if (pressed) {
      setTimeout(() => session && t.focus());
      return;
    }
    finish();
  });
  input = t;
  return t;
}

function setText(text: string): void {
  const s = session!;
  if (text === s.node.text) return;
  if (!s.id) {
    s.node = { ...s.node, text };
    app.setDraft({ node: s.node, parentId: app.insertTarget().parentId });
    return;
  }
  const current = locate(app.doc, s.id)?.node;
  if (current?.type !== 'text') return;
  app.apply(updateNodes([nodeChange(current, { text })], 'Текст'), { key: s.key, selection: [s.id] });
  s.node = locate(app.doc, s.id)!.node as Text;
}

function restartBlink(): void {
  blink = true;
  clearInterval(blinkTimer);
  blinkTimer = window.setInterval(() => {
    blink = !blink;
    app.view.requestRender();
  }, 530);
  app.view.requestRender();
}

// Starts editing a text of the document, with the caret at `at` (a text index).
export function editText(id: string, at?: number): void {
  const node = locate(app.doc, id)?.node;
  if (node?.type !== 'text') return;
  finish();
  if (app.tool.id !== 'text') app.setTool('text');
  session = { id, node, key: `text-${++sessions}` };
  app.select([id]);
  begin(at ?? node.text.length);
}

function begin(at: number): void {
  const t = textarea();
  t.value = session!.node.text;
  t.focus();
  t.setSelectionRange(at, at);
  restartBlink();
}

// A new text whose first line's top left is at the point.
function start(e: ToolEvent): void {
  const s = app.textStyle;
  const font = fontOf(s.font);
  const ascent = (font.ascender / font.unitsPerEm) * s.size;
  const node = makeText('', e.x, e.y + ascent, app.style, s);
  session = { id: null, node, key: `text-${++sessions}` };
  app.select([]);
  app.setDraft({ node, parentId: app.insertTarget().parentId });
  begin(0);
}

// Ends the editing: a new text goes into the document, an emptied one goes away.
function finish(): void {
  const s = session;
  if (!s) return;
  session = null;
  selecting = null;
  clearInterval(blinkTimer);
  if (!s.id) {
    app.setDraft(null);
    if (s.node.text.trim()) {
      // Its font goes into the document with it, if it is not there yet.
      const fonts = missingFonts(app.doc, [s.node]);
      commitShape(s.node, 'Текст', fonts.length ? [addFonts(fonts)] : []);
    }
  } else {
    const at = locate(app.doc, s.id);
    if (at && at.node.type === 'text' && !at.node.text.trim()) app.apply(removeNode(app.doc, s.id, 'Текст'), { key: s.key, selection: [] });
    app.history.seal();
  }
  if (input && document.activeElement === input) input.blur();
  app.view.requestRender();
}

// The text index under a document point, if it is on the session's text (within slop).
function indexAt(e: ToolEvent, slop: number): number | null {
  const s = session!;
  const inv = invert(world(s));
  if (!inv) return null;
  const p = apply(inv, e.x, e.y);
  const l = layoutOf(s);
  const b = l.box;
  const k = slop * Math.hypot(inv[0], inv[1]);
  if (p.x < b.x - k || p.y < b.y - k || p.x > b.x + b.width + k || p.y > b.y + b.height + k) return null;
  return caretAt(l, p.x, p.y, s.node.text);
}

function select(anchor: number, focus: number): void {
  const t = textarea();
  if (focus >= anchor) t.setSelectionRange(anchor, focus, 'forward');
  else t.setSelectionRange(focus, anchor, 'backward');
  restartBlink();
}

// Up and down by the text's own lines, keeping the caret's x.
function keydown(e: KeyboardEvent): void {
  const s = session;
  if (!s) return;
  const t = textarea();
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape' || (e.key === 'Enter' && mod)) {
    e.preventDefault();
    const id = s.id;
    finish();
    app.setTool('select');
    if (id && locate(app.doc, id)) app.select([id]);
    return;
  }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !mod && !e.altKey) {
    e.preventDefault();
    const l = layoutOf(s);
    const focus = t.selectionDirection === 'backward' ? t.selectionStart : t.selectionEnd;
    const anchor = t.selectionDirection === 'backward' ? t.selectionEnd : t.selectionStart;
    const at = caretPosition(l, focus);
    const line = at.line + (e.key === 'ArrowUp' ? -1 : 1);
    const target = line < 0 ? 0 : line >= l.lines.length ? s.node.text.length : caretAt(l, at.x, l.lines[line]!.baseline, s.node.text);
    select(e.shiftKey ? anchor : target, target);
    return;
  }
  // The editor's own shortcuts (save, export…) end the editing and run; the text ones
  // (select all, copy, paste, undo) stay the textarea's.
  if (mod && !['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY'].includes(e.code)) {
    const command = commandFor(e);
    if (command) {
      e.preventDefault();
      finish();
      runCommand(command.id);
    }
  }
}

const WORD = /[\p{L}\p{N}_]/u;

export const textTool: Tool = {
  id: 'text',
  label: 'Текст',
  key: 'T',
  icon: 'text',
  hint: 'Клик — новый текст, клик по тексту — править; Esc — закончить',
  cursor: () => 'text',

  down(e) {
    pressed = true;
    const slop = 4 / app.view.zoom;
    if (session) {
      const at = indexAt(e, slop);
      if (at !== null) {
        const t = textarea();
        const anchor = e.shift ? (t.selectionDirection === 'backward' ? t.selectionEnd : t.selectionStart) : at;
        selecting = anchor;
        select(anchor, at);
        return;
      }
      finish();
    }
    const picked = hitTest(app.doc, e.x, e.y, slop, app.context);
    const node = picked ? locate(app.doc, picked)?.node : null;
    if (node?.type === 'text') {
      editText(node.id, 0);
      const at = indexAt(e, slop);
      if (at !== null) {
        selecting = at;
        select(at, at);
      }
      return;
    }
    if (canDraw()) start(e);
  },

  move(e) {
    if (selecting === null || !session) return;
    const at = indexAt(e, Infinity);
    if (at !== null) select(selecting, at);
  },

  up() {
    pressed = false;
    selecting = null;
    if (session) textarea().focus();
  },

  dblclick(e) {
    if (!session) return;
    // The word under the pointer.
    const at = indexAt(e, 4 / app.view.zoom);
    if (at === null) return;
    const text = session.node.text;
    let a = at;
    let b = at;
    while (a > 0 && WORD.test(text[a - 1]!)) a--;
    while (b < text.length && WORD.test(text[b]!)) b++;
    if (a !== b) select(a, b);
  },

  cancel() {
    if (!session) return false;
    finish();
    return true;
  },

  // A new text not yet committed is dropped by Undo, not committed and then undone.
  pending: () => !!session && !session.id,

  finish,

  overlay(ctx) {
    const s = session;
    if (!s) return;
    if (s.id) {
      const node = locate(app.doc, s.id)?.node;
      if (node?.type !== 'text') return;
      s.node = node;
    }
    const t = textarea();
    const l = layoutOf(s);
    const m = world(s);
    const view = app.view;
    const screen = (x: number, y: number): Point => {
      const d = apply(m, x, y);
      return view.toScreen(d.x, d.y);
    };
    const quad = (x0: number, y0: number, x1: number, y1: number) => {
      const pts = [screen(x0, y0), screen(x1, y0), screen(x1, y1), screen(x0, y1)];
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
    };
    const color = accent();
    // The text's frame, faintly.
    ctx.globalAlpha = 0.5;
    quad(l.box.x, l.box.y, l.box.x + Math.max(l.box.width, 1 / view.zoom), l.box.y + l.box.height);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
    const from = Math.min(t.selectionStart, t.selectionEnd);
    const to = Math.max(t.selectionStart, t.selectionEnd);
    if (from !== to) {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.25;
      for (const line of l.lines) {
        const a = Math.max(from, line.start);
        const b = Math.min(to, line.end);
        if (a > b || (a === b && !(from <= line.end && to > line.end))) continue;
        const x0 = line.carets[a - line.start]!;
        // A selection running past the line's end shows the line break as a little room.
        const x1 = line.carets[b - line.start]! + (to > line.end && line.end < s.node.text.length ? s.node.size * 0.25 : 0);
        quad(x0, line.baseline - l.ascent, x1, line.baseline + l.descent);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    const focus = t.selectionDirection === 'backward' ? t.selectionStart : t.selectionEnd;
    const at = caretPosition(l, isLowSurrogate(s.node.text, focus) ? focus - 1 : focus);
    const line = l.lines[at.line]!;
    const top = screen(at.x, line.baseline - l.ascent);
    const bottom = screen(at.x, line.baseline + l.descent);
    if (blink && from === to) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bottom.x, bottom.y);
      ctx.stroke();
    }
    // Input methods show their candidates by the textarea: keep it at the caret.
    t.style.left = `${Math.round(bottom.x)}px`;
    t.style.top = `${Math.round(Math.min(top.y, bottom.y))}px`;
  },
};

// The editing session's text, for the tests.
export const editingText = (): { id: string | null; text: string } | null => (session ? { id: session.id, text: session.node.text } : null);
