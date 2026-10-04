// 2D affine matrices in the SVG order [a, b, c, d, e, f]. Every function returns a new
// matrix; none changes its arguments.

import type { Matrix } from './types';

export interface Point {
  x: number;
  y: number;
}

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
export const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
export const scale = (sx: number, sy = sx): Matrix => [sx, 0, 0, sy, 0, 0];
export const rotate = (radians: number): Matrix => {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [c, s, -s, c, 0, 0];
};

// m · n: n is applied first, then m — as in SVG's transform="m n".
export function multiply(m: Matrix, n: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const [A, B, C, D, E, F] = n;
  return [a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f];
}

export const multiplyAll = (...ms: Matrix[]): Matrix => ms.reduce((acc, m) => multiply(acc, m), identity());

export const determinant = (m: Matrix): number => m[0] * m[3] - m[1] * m[2];

// Null for a matrix that flattens the plane to a line or a point.
export function invert(m: Matrix): Matrix | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export const apply = (m: Matrix, x: number, y: number): Point => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

export const isIdentity = (m: Matrix, eps = 1e-9): boolean => equals(m, IDENTITY, eps);

export const equals = (m: Matrix, n: Matrix, eps = 1e-9): boolean => m.every((v, i) => Math.abs(v - n[i]!) <= eps);

// How much the matrix stretches lengths on average: the square root of the area scale.
// Stroke widths and antialiasing go through it.
export const meanScale = (m: Matrix): number => Math.sqrt(Math.abs(determinant(m)));

// The matrix as translate · rotate · shear · scale. A matrix that mirrors gets a negative
// scaleY, so rotation stays in (-180°, 180°] and the parts recompose exactly.
export interface Decomposed {
  translateX: number;
  translateY: number;
  rotation: number; // degrees, clockwise on screen (Y is down)
  scaleX: number;
  scaleY: number;
  shear: number; // tan of the skew angle along X, after scaling
}

export function decompose(m: Matrix): Decomposed {
  const [a, b, c, d, e, f] = m;
  const sx = Math.hypot(a, b);
  if (sx < 1e-12) return { translateX: e, translateY: f, rotation: 0, scaleX: 0, scaleY: Math.hypot(c, d), shear: 0 };
  const cos = a / sx;
  const sin = b / sx;
  // Second column, rotated back: (shear·sy… ) in the unrotated frame.
  const sh = c * cos + d * sin;
  const sy = -c * sin + d * cos;
  return { translateX: e, translateY: f, rotation: (Math.atan2(b, a) * 180) / Math.PI, scaleX: sx, scaleY: sy, shear: sy === 0 ? 0 : sh / sy };
}

export function compose(p: Decomposed): Matrix {
  const r = (p.rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const sh = p.shear * p.scaleY;
  return [p.scaleX * cos, p.scaleX * sin, sh * cos - p.scaleY * sin, sh * sin + p.scaleY * cos, p.translateX, p.translateY];
}

// The matrix that keeps `pivot` in place while applying `m` around it.
export const around = (m: Matrix, px: number, py: number): Matrix => multiplyAll(translate(px, py), m, translate(-px, -py));

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const EMPTY_BOX: Box = { x: 0, y: 0, width: -1, height: -1 };
export const isEmptyBox = (b: Box): boolean => b.width < 0 || b.height < 0;

export function boxOfPoints(points: Point[]): Box {
  if (!points.length) return { ...EMPTY_BOX };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function unionBox(a: Box, b: Box): Box {
  if (isEmptyBox(a)) return { ...b };
  if (isEmptyBox(b)) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

export const boxCorners = (b: Box): Point[] => [
  { x: b.x, y: b.y },
  { x: b.x + b.width, y: b.y },
  { x: b.x + b.width, y: b.y + b.height },
  { x: b.x, y: b.y + b.height },
];

// The axis-aligned box around a box after a transform.
export const transformBox = (m: Matrix, b: Box): Box => (isEmptyBox(b) ? { ...EMPTY_BOX } : boxOfPoints(boxCorners(b).map((p) => apply(m, p.x, p.y))));

export const inflateBox = (b: Box, by: number): Box => (isEmptyBox(b) ? b : { x: b.x - by, y: b.y - by, width: b.width + 2 * by, height: b.height + 2 * by });

export const boxesIntersect = (a: Box, b: Box): boolean =>
  !isEmptyBox(a) && !isEmptyBox(b) && a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
