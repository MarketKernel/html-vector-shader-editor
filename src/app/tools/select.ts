// Select: click to pick, Shift+click to add or remove, drag on empty canvas for a marquee.
// The selection's frame has eight handles that scale it (Shift keeps proportions, Alt
// scales about the centre); just outside a corner it rotates (Shift: 15° steps). Dragging
// inside the frame moves it, the arrow keys nudge it. A double click enters a group, or
// edits a text (so does Enter).
//
// Every drag computes one matrix in document space from where it began and applies it to
// the nodes as they were then (core/actions.ts transformNodes), merged into one step.

import { inZOrder, transformNodes } from '../../core/actions';
import { locate, structuredCloneJson } from '../../core/document';
import type { Point } from '../../core/matrix';
import { apply, around, invert, multiplyAll, rotate, scale, translate } from '../../core/matrix';
import type { Matrix, Node } from '../../core/types';
import { app } from '../app';
import { frameOf, HANDLES, hitTest, nodesIn, selectionFrame } from '../selection';
import { accent } from '../view';
import { editText } from './text';
import type { Tool } from './tool';

const HANDLE_RADIUS = 6;
const ROTATE_REACH = 22;
const DRAG_THRESHOLD = 3;

type Drag =
  | { mode: 'pending'; start: Point; screen: Point; originals: Node[] }
  | { mode: 'move'; start: Point; originals: Node[]; key: string }
  | { mode: 'scale'; handle: Point; frame: Matrix; inverse: Matrix; originals: Node[]; key: string }
  | { mode: 'rotate'; center: Point; from: number; originals: Node[]; key: string }
  | { mode: 'marquee'; start: Point; end: Point; add: boolean; base: string[] };

let drag: Drag | null = null;
let hover: string | null = null;
let drags = 0;
let lastNudge = 0;

const slop = () => 4 / app.view.zoom;

const originals = (): Node[] => inZOrder(app.doc, app.selection).map((id) => structuredCloneJson(locate(app.doc, id)!.node));

const screenOf = (f: Matrix, u: number, v: number) => {
  const d = apply(f, u, v);
  return app.view.toScreen(d.x, d.y);
};

// What is under the pointer on the frame: a handle, the rotation ring, the inside.
function frameHit(sx: number, sy: number): { kind: 'scale'; handle: Point } | { kind: 'rotate' } | { kind: 'inside' } | null {
  const f = selectionFrame();
  if (!f) return null;
  for (const h of HANDLES) {
    const s = screenOf(f, h.x, h.y);
    if (Math.hypot(s.x - sx, s.y - sy) <= HANDLE_RADIUS + 1) return { kind: 'scale', handle: h };
  }
  const inv = invert(f);
  if (!inv) return null;
  const d = app.view.toDoc(sx, sy);
  const u = apply(inv, d.x, d.y);
  const inside = u.x >= 0 && u.x <= 1 && u.y >= 0 && u.y <= 1;
  if (inside) return { kind: 'inside' };
  for (const h of HANDLES.filter((h) => h.x !== 0.5 && h.y !== 0.5)) {
    const s = screenOf(f, h.x, h.y);
    if (Math.hypot(s.x - sx, s.y - sy) <= ROTATE_REACH) return { kind: 'rotate' };
  }
  return null;
}

const RESIZE = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
const ROTATE_CURSOR = `url("data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M5 12a7 7 0 1 1 3 5.7" fill="none" stroke="white" stroke-width="4"/><path d="M5 12a7 7 0 1 1 3 5.7" fill="none" stroke="black" stroke-width="1.8"/><path d="M2 9l3 4 3-4z" fill="black" stroke="white"/></svg>')}") 12 12, crosshair`;

function handleCursor(h: Point): string {
  const f = selectionFrame()!;
  const c = screenOf(f, 0.5, 0.5);
  const s = screenOf(f, h.x, h.y);
  const angle = (Math.atan2(s.y - c.y, s.x - c.x) * 180) / Math.PI;
  const octant = Math.round((((angle % 180) + 180) % 180) / 45) % 4;
  return RESIZE[octant]!;
}

function run(delta: Matrix, d: { originals: Node[]; key: string }, label: string): void {
  app.apply(transformNodes(app.doc, d.originals, delta, label), { key: d.key });
}

export const selectTool: Tool = {
  id: 'select',
  label: 'Выделение',
  key: 'V',
  icon: 'select',
  hint: 'Клик — выбрать, Shift — добавить, протяжка — рамка; ручки масштабируют, за углом — поворот; двойной клик — войти в группу или править текст',

  cursor(e) {
    if (!e) return 'default';
    const hit = frameHit(e.sx, e.sy);
    if (hit?.kind === 'scale') return handleCursor(hit.handle);
    if (hit?.kind === 'rotate') return ROTATE_CURSOR;
    if (hit?.kind === 'inside') return 'move';
    return 'default';
  },

  down(e) {
    const hit = frameHit(e.sx, e.sy);
    const key = `select-${++drags}`;
    if (hit?.kind === 'scale') {
      const frame = selectionFrame()!;
      drag = { mode: 'scale', handle: hit.handle, frame, inverse: invert(frame)!, originals: originals(), key };
      return;
    }
    if (hit?.kind === 'rotate') {
      const f = selectionFrame()!;
      const c = apply(f, 0.5, 0.5);
      drag = { mode: 'rotate', center: c, from: Math.atan2(e.y - c.y, e.x - c.x), originals: originals(), key };
      return;
    }
    const picked = hitTest(app.doc, e.x, e.y, slop(), app.context);
    if (picked) {
      if (e.shift) {
        app.select(app.selection.includes(picked) ? app.selection.filter((id) => id !== picked) : [...app.selection, picked]);
        if (!app.selection.includes(picked)) return;
      } else if (!app.selection.includes(picked)) app.select([picked]);
      drag = { mode: 'pending', start: { x: e.x, y: e.y }, screen: { x: e.sx, y: e.sy }, originals: originals() };
      return;
    }
    if (hit?.kind === 'inside' && !e.shift) {
      drag = { mode: 'pending', start: { x: e.x, y: e.y }, screen: { x: e.sx, y: e.sy }, originals: originals() };
      return;
    }
    // Outside the entered group: back to the layer, and try again there.
    if (app.context && !e.shift) {
      app.enter(null);
      const again = hitTest(app.doc, e.x, e.y, slop(), null);
      if (again) {
        app.select([again]);
        drag = { mode: 'pending', start: { x: e.x, y: e.y }, screen: { x: e.sx, y: e.sy }, originals: originals() };
        return;
      }
    }
    drag = { mode: 'marquee', start: { x: e.x, y: e.y }, end: { x: e.x, y: e.y }, add: e.shift, base: e.shift ? [...app.selection] : [] };
    if (!e.shift) app.select([]);
  },

  move(e) {
    if (!drag) return;
    if (drag.mode === 'pending') {
      if (Math.hypot(e.sx - drag.screen.x, e.sy - drag.screen.y) < DRAG_THRESHOLD) return;
      drag = { mode: 'move', start: drag.start, originals: drag.originals, key: `select-${++drags}` };
    }
    switch (drag.mode) {
      case 'move': {
        let dx = e.x - drag.start.x;
        let dy = e.y - drag.start.y;
        if (e.shift) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        run(translate(dx, dy), drag, 'Перемещение');
        break;
      }
      case 'scale': {
        const h = drag.handle;
        const u = apply(drag.inverse, e.x, e.y);
        const anchor = e.alt ? { x: 0.5, y: 0.5 } : { x: 1 - h.x, y: 1 - h.y };
        const factor = (v: number, hv: number, av: number) => (hv === 0.5 ? 1 : (v - av) / (hv - av || 1));
        let sx = factor(u.x, h.x, anchor.x);
        let sy = factor(u.y, h.y, anchor.y);
        if (e.shift && h.x !== 0.5 && h.y !== 0.5) {
          const m = Math.max(Math.abs(sx), Math.abs(sy));
          sx = (Math.sign(sx) || 1) * m;
          sy = (Math.sign(sy) || 1) * m;
        } else if (e.shift) {
          // A side handle with Shift scales the other side too.
          const m = h.x === 0.5 ? sy : sx;
          sx = sy = m;
        }
        // Never flat: a zero scale could not be undone by scaling again.
        const nonzero = (v: number) => (Math.abs(v) < 1e-3 ? (v < 0 ? -1e-3 : 1e-3) : v);
        const unit = multiplyAll(translate(anchor.x, anchor.y), scale(nonzero(sx), nonzero(sy)), translate(-anchor.x, -anchor.y));
        run(multiplyAll(drag.frame, unit, drag.inverse), drag, 'Масштаб');
        break;
      }
      case 'rotate': {
        let angle = Math.atan2(e.y - drag.center.y, e.x - drag.center.x) - drag.from;
        if (e.shift) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
        run(around(rotate(angle), drag.center.x, drag.center.y), drag, 'Поворот');
        break;
      }
      case 'marquee': {
        drag.end = { x: e.x, y: e.y };
        const box = { x: Math.min(drag.start.x, e.x), y: Math.min(drag.start.y, e.y), width: Math.abs(e.x - drag.start.x), height: Math.abs(e.y - drag.start.y) };
        const inside = nodesIn(app.doc, box, app.context);
        const base = drag.base;
        app.select([...base, ...inside.filter((id) => !base.includes(id))]);
        app.view.requestRender();
        break;
      }
    }
  },

  up() {
    if (drag && drag.mode !== 'pending' && drag.mode !== 'marquee') app.history.seal();
    drag = null;
    app.view.requestRender();
  },

  hover(e) {
    const next = hitTest(app.doc, e.x, e.y, slop(), app.context);
    if (next !== hover) {
      hover = next;
      app.view.requestRender();
    }
  },

  dblclick(e) {
    const picked = hitTest(app.doc, e.x, e.y, slop(), app.context);
    const node = picked ? locate(app.doc, picked)?.node : null;
    if (node?.type === 'text') {
      editText(node.id);
      // The caret where the click was.
      app.tool.down?.(e);
      app.tool.up?.(e);
    } else if (node?.type === 'group') {
      app.enter(node.id);
      const inner = hitTest(app.doc, e.x, e.y, slop(), node.id);
      app.select(inner ? [inner] : []);
    } else if (!picked && app.context) {
      // Out one level.
      const at = locate(app.doc, app.context);
      const outer = at?.groups[at.groups.length - 1];
      const was = app.context;
      app.enter(outer ? outer.id : null);
      app.select([was]);
    }
  },

  keydown(e) {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && app.selection.length === 1) {
      const node = locate(app.doc, app.selection[0]!)?.node;
      if (node?.type === 'text') {
        editText(node.id);
        return true;
      }
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const dir = arrows[e.key];
    if (!dir || !app.selection.length || e.metaKey || e.ctrlKey || e.altKey) return false;
    const step = e.shiftKey ? 10 : 1;
    // Presses in quick succession are one step.
    const now = Date.now();
    if (now - lastNudge > 800) app.history.seal();
    lastNudge = now;
    app.apply(transformNodes(app.doc, originals(), translate(dir[0] * step, dir[1] * step), 'Сдвиг'), { key: 'nudge' });
    return true;
  },

  cancel() {
    if (app.selection.length) {
      app.select([]);
      return true;
    }
    if (app.context) {
      app.enter(null);
      return true;
    }
    return false;
  },

  overlay(ctx) {
    const view = app.view;
    const color = accent();
    if (hover && !app.selection.includes(hover) && !drag) {
      const f = frameOf(app.doc, [hover]);
      if (f) view.strokeFrame(ctx, f, color);
    }
    if (app.selection.length > 1) {
      // Each one's own outline, faintly, inside the common frame.
      ctx.globalAlpha = 0.5;
      for (const id of app.selection) {
        const f = frameOf(app.doc, [id]);
        if (f) view.strokeFrame(ctx, f, color);
      }
      ctx.globalAlpha = 1;
    }
    const f = selectionFrame();
    if (f) {
      view.strokeFrame(ctx, f, color);
      if (!drag || drag.mode === 'pending' || drag.mode === 'marquee') {
        for (const h of HANDLES) {
          const s = screenOf(f, h.x, h.y);
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.fillRect(Math.round(s.x) - 3.5, Math.round(s.y) - 3.5, 7, 7);
          ctx.strokeRect(Math.round(s.x) - 3.5, Math.round(s.y) - 3.5, 7, 7);
        }
      }
    }
    if (drag?.mode === 'marquee') {
      const a = view.toScreen(drag.start.x, drag.start.y);
      const b = view.toScreen(drag.end.x, drag.end.y);
      ctx.fillStyle = 'rgba(47, 109, 246, 0.08)';
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 3]);
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.setLineDash([]);
    }
  },
};
