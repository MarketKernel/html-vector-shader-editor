// New shapes, with the style the tools draw with.

import { uid } from './document';
import type { Ellipse, Fill, Group, Line, Node, Path, Rect, Segment, Stroke } from './types';

export interface Style {
  fill: Fill;
  stroke: Stroke;
}

export const DEFAULT_STYLE: Style = {
  fill: { color: '#4f8ef7', opacity: 1 },
  stroke: { color: '#1d2433', opacity: 1, width: 2, cap: 'butt', join: 'miter' },
};

const base = (id: string) => ({ id, visible: true, locked: false, opacity: 1, transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number] });

const copyStyle = (s: Style): Style => ({ fill: s.fill && { ...s.fill }, stroke: s.stroke && { ...s.stroke } });

export function makeRect(x: number, y: number, width: number, height: number, style: Style = DEFAULT_STYLE, id = uid('r')): Rect {
  return { ...base(id), type: 'rect', ...copyStyle(style), x, y, width, height, rx: 0 };
}

export function makeEllipse(cx: number, cy: number, rx: number, ry: number, style: Style = DEFAULT_STYLE, id = uid('e')): Ellipse {
  return { ...base(id), type: 'ellipse', ...copyStyle(style), cx, cy, rx, ry };
}

// A line takes the stroke only; with no stroke in the style it gets the default one, or
// it would be invisible.
export function makeLine(x1: number, y1: number, x2: number, y2: number, style: Style = DEFAULT_STYLE, id = uid('l')): Line {
  return { ...base(id), type: 'line', fill: null, stroke: { ...(style.stroke ?? DEFAULT_STYLE.stroke!) }, x1, y1, x2, y2 };
}

export function makePath(segments: Segment[], style: Style = DEFAULT_STYLE, id = uid('p')): Path {
  return { ...base(id), type: 'path', ...copyStyle(style), segments, fillRule: 'nonzero' };
}

export function makeGroup(children: Node[], id = uid('g')): Group {
  return { ...base(id), type: 'group', children };
}
