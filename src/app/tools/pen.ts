// Pen: a click puts a corner point, a drag puts a smooth one with its tangents (cubic
// Béziers between points). A click on the first point closes the path; Enter or a double
// click ends it open; Backspace takes back the last point; Esc drops the whole path.

import { DEFAULT_STYLE, makePath } from '../../core/shapes';
import type { Segment } from '../../core/types';
import { app } from '../app';
import { accent } from '../view';
import { canDraw, commitShape } from './shapes';
import type { Tool } from './tool';

interface Anchor {
  x: number;
  y: number;
  // Tangent handles, absolute; equal to the point for a corner.
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

let anchors: Anchor[] = [];
let dragging = false;
let pointer: { x: number; y: number } | null = null;

const CLOSE_RADIUS = 8;

function segment(a: Anchor, b: Anchor): Segment {
  const straight = a.outX === a.x && a.outY === a.y && b.inX === b.x && b.inY === b.y;
  return straight ? ['L', b.x, b.y] : ['C', a.outX, a.outY, b.inX, b.inY, b.x, b.y];
}

export function penSegments(points: Anchor[], closed: boolean): Segment[] {
  if (!points.length) return [];
  const out: Segment[] = [['M', points[0]!.x, points[0]!.y]];
  for (let i = 1; i < points.length; i++) out.push(segment(points[i - 1]!, points[i]!));
  if (closed && points.length > 1) {
    const last = points[points.length - 1]!;
    const first = points[0]!;
    if (!(last.outX === last.x && last.outY === last.y && first.inX === first.x && first.inY === first.y)) out.push(segment(last, first));
    out.push(['Z']);
  }
  return out;
}

function showDraft(): void {
  if (anchors.length < 2) {
    app.setDraft(null);
    return;
  }
  // An open path is drawn without fill until it is closed.
  const style = { fill: null, stroke: app.style.stroke ?? DEFAULT_STYLE.stroke };
  app.setDraft({ node: makePath(penSegments(anchors, false), style, 'pen-draft'), parentId: app.insertTarget().parentId });
}

function reset(): void {
  anchors = [];
  dragging = false;
  app.setDraft(null);
}

function commit(closed: boolean): void {
  if (anchors.length < 2) {
    reset();
    return;
  }
  const style = closed ? app.style : { fill: null, stroke: app.style.stroke ?? DEFAULT_STYLE.stroke };
  const node = makePath(penSegments(anchors, closed), style);
  reset();
  commitShape(node, 'Перо');
}

const nearFirst = (sx: number, sy: number) => {
  if (anchors.length < 2) return false;
  const p = app.view.toScreen(anchors[0]!.x, anchors[0]!.y);
  return Math.hypot(p.x - sx, p.y - sy) <= CLOSE_RADIUS;
};

export const penTool: Tool = {
  id: 'pen',
  label: 'Перо',
  key: 'P',
  icon: 'pen',
  hint: 'Клик — угол, протяжка — гладкая точка; клик по первой точке замыкает, Enter — завершить, Esc — отменить',

  cursor: (e) => (e && nearFirst(e.sx, e.sy) ? 'pointer' : 'crosshair'),

  down(e) {
    if (!anchors.length && !canDraw()) return;
    if (nearFirst(e.sx, e.sy)) {
      commit(true);
      return;
    }
    const last = anchors[anchors.length - 1];
    // The second click of a double click lands on the point just put.
    if (last && Math.hypot(last.x - e.x, last.y - e.y) * app.view.zoom < 2) return;
    anchors.push({ x: e.x, y: e.y, inX: e.x, inY: e.y, outX: e.x, outY: e.y });
    dragging = true;
    showDraft();
  },

  move(e) {
    pointer = { x: e.x, y: e.y };
    const a = anchors[anchors.length - 1];
    if (!dragging || !a) return;
    a.outX = e.x;
    a.outY = e.y;
    a.inX = 2 * a.x - e.x;
    a.inY = 2 * a.y - e.y;
    showDraft();
  },

  up() {
    dragging = false;
  },

  hover(e) {
    pointer = { x: e.x, y: e.y };
    if (anchors.length) app.view.requestRender();
  },

  dblclick() {
    if (anchors.length >= 2) commit(false);
  },

  keydown(e) {
    if (!anchors.length) return false;
    if (e.key === 'Enter') {
      commit(false);
      return true;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      anchors.pop();
      showDraft();
      app.view.requestRender();
      return true;
    }
    return false;
  },

  cancel() {
    if (!anchors.length) return false;
    reset();
    return true;
  },

  pending: () => anchors.length > 0,

  finish() {
    if (anchors.length) commit(false);
  },

  overlay(ctx) {
    if (!anchors.length) return;
    const view = app.view;
    const color = accent();
    const s = (x: number, y: number) => view.toScreen(x, y);
    const last = anchors[anchors.length - 1]!;
    // Where the next segment would go.
    if (pointer && !dragging) {
      const a = s(last.x, last.y);
      const o = s(last.outX, last.outY);
      const p = s(pointer.x, pointer.y);
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(o.x, o.y, p.x, p.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (anchors.length === 1 && dragging) {
      const a = s(last.x, last.y);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(a.x, a.y, 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const a of anchors) {
      const p = s(a.x, a.y);
      if (a.outX !== a.x || a.outY !== a.y) {
        const i = s(a.inX, a.inY);
        const o = s(a.outX, a.outY);
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(i.x, i.y);
        ctx.lineTo(o.x, o.y);
        ctx.stroke();
        for (const h of [i, o]) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(h.x, h.y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.fillStyle = a === anchors[0] && anchors.length > 1 ? color : '#ffffff';
      ctx.strokeStyle = color;
      ctx.fillRect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7);
      ctx.strokeRect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7);
    }
  },
};
