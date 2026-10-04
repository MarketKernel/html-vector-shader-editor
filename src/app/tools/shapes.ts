// Rectangle, ellipse and line: drag out the shape. Shift makes a square or a circle, or
// snaps a line to 45°; Alt draws a rectangle or an ellipse from its centre. While dragging
// the shape is a draft drawn by the renderer; letting go commits it as one step.

import { transformValues } from '../../core/actions';
import { findContainer } from '../../core/document';
import { insertNode } from '../../core/ops';
import { makeEllipse, makeLine, makeRect } from '../../core/shapes';
import type { Node } from '../../core/types';
import { app } from '../app';
import { toast } from '../ui/dialog';
import type { Tool, ToolEvent } from './tool';

type Make = (a: ToolEvent, b: ToolEvent) => Node | null;

// The box dragged from a to b, with the modifiers applied.
function box(a: ToolEvent, b: ToolEvent): { x: number; y: number; width: number; height: number } {
  let w = b.x - a.x;
  let h = b.y - a.y;
  if (b.shift) {
    const m = Math.max(Math.abs(w), Math.abs(h));
    w = (Math.sign(w) || 1) * m;
    h = (Math.sign(h) || 1) * m;
  }
  if (b.alt) return { x: a.x - Math.abs(w), y: a.y - Math.abs(h), width: 2 * Math.abs(w), height: 2 * Math.abs(h) };
  return { x: Math.min(a.x, a.x + w), y: Math.min(a.y, a.y + h), width: Math.abs(w), height: Math.abs(h) };
}

// Whether the active layer can take a new shape; says why not.
export function canDraw(): boolean {
  const layer = app.layer;
  if (layer.locked) {
    toast(`Слой «${layer.name}» заблокирован`);
    return false;
  }
  if (!layer.visible) {
    toast(`Слой «${layer.name}» скрыт`);
    return false;
  }
  return true;
}

// The node drawn in document coordinates, placed into the entered group's coordinates.
export function commitShape(node: Node, label: string): void {
  const { parentId, inverse } = app.insertTarget();
  const placed = { ...node, ...transformValues(node, [1, 0, 0, 1, 0, 0], inverse) } as Node;
  const parent = findContainer(app.doc, parentId)!;
  app.apply(insertNode(parentId, parent.children.length, placed, label), { selection: [placed.id] });
}

function dragTool(def: Omit<Tool, 'down' | 'move' | 'up' | 'cancel' | 'cursor'>, make: Make, label: string): Tool {
  let start: ToolEvent | null = null;
  return {
    ...def,
    cursor: () => 'crosshair',
    down(e) {
      start = canDraw() ? e : null;
    },
    move(e) {
      if (!start) return;
      const node = make(start, e);
      app.setDraft(node ? { node, parentId: app.insertTarget().parentId } : null);
    },
    up(e) {
      if (!start) return;
      const node = make(start, e);
      start = null;
      app.setDraft(null);
      // A click without a drag draws nothing.
      if (node && hasSize(node)) commitShape(node, label);
    },
    cancel() {
      if (!start) return false;
      start = null;
      app.setDraft(null);
      return true;
    },
  };
}

function hasSize(n: Node): boolean {
  const min = 1 / app.view.zoom;
  if (n.type === 'rect') return n.width > 0 && n.height > 0 && (n.width >= min || n.height >= min);
  if (n.type === 'ellipse') return n.rx > 0 && n.ry > 0 && (n.rx >= min / 2 || n.ry >= min / 2);
  if (n.type === 'line') return Math.hypot(n.x2 - n.x1, n.y2 - n.y1) >= min;
  return true;
}

export const rectTool = dragTool(
  { id: 'rect', label: 'Прямоугольник', key: 'R', icon: 'rect', hint: 'Протяжка — прямоугольник; Shift — квадрат, Alt — от центра' },
  (a, b) => {
    const r = box(a, b);
    return makeRect(r.x, r.y, r.width, r.height, app.style);
  },
  'Прямоугольник',
);

export const ellipseTool = dragTool(
  { id: 'ellipse', label: 'Эллипс', key: 'E', icon: 'ellipse', hint: 'Протяжка — эллипс; Shift — круг, Alt — от центра' },
  (a, b) => {
    const r = box(a, b);
    return makeEllipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, app.style);
  },
  'Эллипс',
);

export const lineTool = dragTool(
  { id: 'line', label: 'Линия', key: 'L', icon: 'line', hint: 'Протяжка — линия; Shift — шаг 45°' },
  (a, b) => {
    let x = b.x;
    let y = b.y;
    if (b.shift) {
      const angle = Math.round(Math.atan2(y - a.y, x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(x - a.x, y - a.y);
      x = a.x + Math.cos(angle) * len;
      y = a.y + Math.sin(angle) * len;
    }
    return makeLine(a.x, a.y, x, y, app.style);
  },
  'Линия',
);
