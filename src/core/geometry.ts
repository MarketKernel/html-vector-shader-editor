// Shapes as distances. The renderer's shader, the exported shader and the hit tests here
// all decide "inside the fill" and "inside the stroke" by the same signed distances, so
// what is drawn, what is exported and what a click picks agree.
//
// Paths are flattened to polylines first. A stroke is then the union of simple convex
// pieces, exactly as SVG defines it: one quad per segment (butt ends), and at each vertex
// a join — a quad for a miter, a triangle for a bevel, a disc for round — plus the caps of
// open subpaths. The shaders only take the distance to that union.

import type { Box, Point } from './matrix';
import { boxOfPoints, EMPTY_BOX, inflateBox, isEmptyBox, multiply, transformBox, unionBox } from './matrix';
import type { Line, LineCap, LineJoin, Matrix, Node, Path, Rect, Segment, Shape } from './types';
import { SVG_MITER_LIMIT } from './types';

// ---- Flattening

export interface Subpath {
  points: Point[];
  // A vertex where the path's own segments meet (as opposed to one inside a flattened
  // curve): the join style applies there.
  corners: boolean[];
  closed: boolean;
}

// Wang's formula: segments enough that the polyline strays at most `tolerance` from the curve.
function curveSteps(degree: 2 | 3, d2: number, tolerance: number): number {
  const n = Math.ceil(Math.sqrt(((degree * (degree - 1)) / 8) * (d2 / Math.max(tolerance, 1e-6))));
  return Math.max(1, Math.min(512, n));
}

export function flatten(segments: Segment[], tolerance: number): Subpath[] {
  const out: Subpath[] = [];
  let cur: Subpath | null = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  const begin = () => {
    if (cur) out.push(cur);
    cur = { points: [{ x, y }], corners: [true], closed: false };
    startX = x;
    startY = y;
    return cur;
  };
  const sub = (): Subpath => cur ?? begin();
  for (const s of segments) {
    switch (s[0]) {
      case 'M':
        x = s[1];
        y = s[2];
        begin();
        break;
      case 'L': {
        const p = sub();
        x = s[1];
        y = s[2];
        p.points.push({ x, y });
        p.corners.push(true);
        break;
      }
      case 'Q': {
        const p = sub();
        const [, x1, y1, x2, y2] = s;
        const n = curveSteps(2, Math.hypot(x - 2 * x1 + x2, y - 2 * y1 + y2), tolerance);
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          p.points.push({ x: u * u * x + 2 * u * t * x1 + t * t * x2, y: u * u * y + 2 * u * t * y1 + t * t * y2 });
          p.corners.push(i === n);
        }
        x = x2;
        y = y2;
        break;
      }
      case 'C': {
        const p = sub();
        const [, x1, y1, x2, y2, x3, y3] = s;
        const d2 = Math.max(Math.hypot(x - 2 * x1 + x2, y - 2 * y1 + y2), Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3));
        const n = curveSteps(3, d2, tolerance);
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          const a = u * u * u;
          const b = 3 * u * u * t;
          const c = 3 * u * t * t;
          const d = t * t * t;
          p.points.push({ x: a * x + b * x1 + c * x2 + d * x3, y: a * y + b * y1 + c * y2 + d * y3 });
          p.corners.push(i === n);
        }
        x = x3;
        y = y3;
        break;
      }
      case 'Z':
        if (cur) {
          (cur as Subpath).closed = true;
          out.push(cur);
          cur = null;
        }
        // A segment after Z without an M starts again where the closed one began.
        x = startX;
        y = startY;
        break;
    }
  }
  if (cur) out.push(cur);
  return out.map(tidy);
}

// Without repeated points, and without the last one of a closed subpath when it comes back
// onto the first: a segment of zero length has no direction to stroke or join by.
function tidy(s: Subpath): Subpath {
  const points: Point[] = [];
  const corners: boolean[] = [];
  s.points.forEach((p, i) => {
    const last = points[points.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-9 && Math.abs(last.y - p.y) < 1e-9) {
      corners[corners.length - 1] ||= s.corners[i]!;
      return;
    }
    points.push(p);
    corners.push(s.corners[i]!);
  });
  if (s.closed && points.length > 1) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    if (Math.abs(last.x - first.x) < 1e-9 && Math.abs(last.y - first.y) < 1e-9) {
      points.pop();
      corners.pop();
      corners[0] = true;
    }
  }
  return { points, corners, closed: s.closed };
}

// ---- Path geometry for the shaders

// Flat arrays, four numbers per vec4 — exactly what goes into the renderer's data texture
// and into the exported shader's constant array.
export interface PathGeometry {
  // Fill edges [ax, ay, bx, by], every subpath closed.
  segs: number[];
  // Stroke pieces: quads [ax, ay, bx, by, cx, cy, dx, dy] and discs [cx, cy, r, 0].
  quads: number[];
  discs: number[];
  // Local bounds of the fill and of everything the stroke covers.
  fillBounds: Box;
  bounds: Box;
}

export function pathGeometry(path: Pick<Path, 'segments' | 'stroke'>, tolerance: number): PathGeometry {
  const subpaths = flatten(path.segments, tolerance);
  const segs: number[] = [];
  const all: Point[] = [];
  for (const s of subpaths) {
    const n = s.points.length;
    all.push(...s.points);
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const a = s.points[i]!;
      const b = s.points[(i + 1) % n]!;
      if (a.x === b.x && a.y === b.y) continue;
      segs.push(a.x, a.y, b.x, b.y);
    }
  }
  const quads: number[] = [];
  const discs: number[] = [];
  if (path.stroke && path.stroke.width > 0) strokePieces(subpaths, path.stroke.width / 2, path.stroke.cap, path.stroke.join, quads, discs);
  const fillBounds = boxOfPoints(all);
  let bounds = fillBounds;
  for (let i = 0; i < quads.length; i += 2) bounds = unionBox(bounds, { x: quads[i]!, y: quads[i + 1]!, width: 0, height: 0 });
  for (let i = 0; i < discs.length; i += 4) bounds = unionBox(bounds, inflateBox({ x: discs[i]!, y: discs[i + 1]!, width: 0, height: 0 }, discs[i + 2]!));
  return { segs, quads, discs, fillBounds, bounds };
}

// Flattened paths cached by node object and tolerance. Nodes are replaced, never changed,
// so a node seen before has the same geometry; dropped nodes free their entries.
const cache = new WeakMap<object, Map<number, PathGeometry>>();

export function cachedPathGeometry(path: Path, tolerance: number): PathGeometry {
  let byTolerance = cache.get(path);
  if (!byTolerance) cache.set(path, (byTolerance = new Map()));
  let g = byTolerance.get(tolerance);
  if (!g) {
    // Zooming visits a few tolerances; more than that is a sign of churn, so start over.
    if (byTolerance.size > 4) byTolerance.clear();
    g = pathGeometry(path, tolerance);
    byTolerance.set(tolerance, g);
  }
  return g;
}

function strokePieces(subpaths: Subpath[], hw: number, cap: LineCap, join: LineJoin, quads: number[], discs: number[]): void {
  for (const s of subpaths) {
    const pts = s.points;
    const n = pts.length;
    // A lone point: SVG would draw a dot for round and square caps. Not drawn here; the
    // GLSL exporter warns about it.
    if (n < 2) continue;
    const segCount = s.closed ? n : n - 1;
    const dirs: Point[] = [];
    for (let i = 0; i < segCount; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % n]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      dirs.push(d);
      const nx = -d.y * hw;
      const ny = d.x * hw;
      const extA = !s.closed && i === 0 && cap === 'square' ? hw : 0;
      const extB = !s.closed && i === segCount - 1 && cap === 'square' ? hw : 0;
      const ax = a.x - d.x * extA;
      const ay = a.y - d.y * extA;
      const bx = b.x + d.x * extB;
      const by = b.y + d.y * extB;
      quads.push(ax - nx, ay - ny, bx - nx, by - ny, bx + nx, by + ny, ax + nx, ay + ny);
    }
    const first = s.closed ? 0 : 1;
    const last = s.closed ? n - 1 : n - 2;
    for (let i = first; i <= last; i++) {
      const v = pts[i]!;
      const d0 = dirs[(i - 1 + segCount) % segCount]!;
      const d1 = dirs[i % segCount]!;
      joinPiece(v, d0, d1, hw, s.corners[i] ? join : 'round', quads, discs);
    }
    if (!s.closed && cap === 'round') {
      discs.push(pts[0]!.x, pts[0]!.y, hw, 0);
      discs.push(pts[n - 1]!.x, pts[n - 1]!.y, hw, 0);
    }
  }
}

function joinPiece(v: Point, d0: Point, d1: Point, hw: number, join: LineJoin, quads: number[], discs: number[]): void {
  const cross = d0.x * d1.y - d0.y * d1.x;
  const dot = d0.x * d1.x + d0.y * d1.y;
  if (Math.abs(cross) < 1e-9 && dot > 0) return;
  if (join === 'round') {
    discs.push(v.x, v.y, hw, 0);
    return;
  }
  // The outer side of the turn: opposite to where the path turns.
  const s = cross > 0 ? -1 : 1;
  const n0 = { x: -d0.y * s, y: d0.x * s };
  const n1 = { x: -d1.y * s, y: d1.x * s };
  const ax = v.x + n0.x * hw;
  const ay = v.y + n0.y * hw;
  const bx = v.x + n1.x * hw;
  const by = v.y + n1.y * hw;
  const mx = n0.x + n1.x;
  const my = n0.y + n1.y;
  const mm = mx * mx + my * my;
  // The miter's length over the stroke width is 1 / sin(θ/2) = 2 / |n0 + n1|.
  if (join === 'miter' && mm > 1e-12 && 2 / Math.sqrt(mm) <= SVG_MITER_LIMIT) {
    const k = (2 * hw) / mm;
    quads.push(v.x, v.y, ax, ay, v.x + mx * k, v.y + my * k, bx, by);
  } else {
    // A triangle, as a quad with its last corner repeated.
    quads.push(v.x, v.y, ax, ay, bx, by, bx, by);
  }
}

// ---- Signed distances (negative inside), the same as the GLSL library's

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function sdBox(px: number, py: number, hx: number, hy: number): number {
  const qx = Math.abs(px) - hx;
  const qy = Math.abs(py) - hy;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
}

export function sdRoundBox(px: number, py: number, hx: number, hy: number, r: number): number {
  return sdBox(px, py, hx - r, hy - r) - r;
}

// Iterative closest point on the ellipse (after Chatfield): robust inside and outside,
// and for very flat ellipses, where the closed forms lose precision.
export function sdEllipse(px: number, py: number, ax: number, ay: number): number {
  ax = Math.max(ax, 1e-6);
  ay = Math.max(ay, 1e-6);
  const x = Math.abs(px);
  const y = Math.abs(py);
  let tx = Math.SQRT1_2;
  let ty = Math.SQRT1_2;
  for (let i = 0; i < 4; i++) {
    const ex = ((ax * ax - ay * ay) * tx * tx * tx) / ax;
    const ey = ((ay * ay - ax * ax) * ty * ty * ty) / ay;
    const r = Math.hypot(ax * tx - ex, ay * ty - ey);
    const qx = x - ex;
    const qy = y - ey;
    const q = Math.hypot(qx, qy);
    // At the centre of curvature every direction is as near: keep the last guess.
    if (q < 1e-9) continue;
    tx = clamp(((qx * r) / q + ex) / ax, 0, 1);
    ty = clamp(((qy * r) / q + ey) / ay, 0, 1);
    const t = Math.max(Math.hypot(tx, ty), 1e-12);
    tx /= t;
    ty /= t;
  }
  const d = Math.hypot(x - ax * tx, y - ay * ty);
  return (x / ax) ** 2 + (y / ay) ** 2 < 1 ? -d : d;
}

export function sdSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = clamp((wx * ex + wy * ey) / Math.max(ex * ex + ey * ey, 1e-12), 0, 1);
  return Math.hypot(wx - ex * t, wy - ey * t);
}

// A convex or concave polygon of four corners (a triangle repeats its last corner).
export function sdQuad(px: number, py: number, v: number[], o = 0): number {
  let d = (px - v[o]!) ** 2 + (py - v[o + 1]!) ** 2;
  let s = 1;
  for (let i = 0, j = 3; i < 4; j = i, i++) {
    const vix = v[o + 2 * i]!;
    const viy = v[o + 2 * i + 1]!;
    const ex = v[o + 2 * j]! - vix;
    const ey = v[o + 2 * j + 1]! - viy;
    const wx = px - vix;
    const wy = py - viy;
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey + 1e-12), 0, 1);
    d = Math.min(d, (wx - ex * t) ** 2 + (wy - ey * t) ** 2);
    const c1 = py >= viy;
    const c2 = py < viy + ey;
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

// Distances to a rectangle's fill and stroke, in its own coordinates.
export function rectDistances(r: Pick<Rect, 'x' | 'y' | 'width' | 'height' | 'rx'>, hw: number, join: LineJoin, px: number, py: number): { fill: number; stroke: number } {
  const hx = r.width / 2;
  const hy = r.height / 2;
  const qx = px - (r.x + hx);
  const qy = py - (r.y + hy);
  const rx = clamp(r.rx, 0, Math.min(hx, hy));
  const fill = sdRoundBox(qx, qy, hx, hy, rx);
  let stroke: number;
  if (rx > 0 || join === 'round') stroke = Math.abs(fill) - hw;
  else {
    let outer = sdBox(qx, qy, hx + hw, hy + hw);
    if (join === 'bevel') outer = Math.max(outer, (Math.abs(qx) + Math.abs(qy) - (hx + hy + hw)) * Math.SQRT1_2);
    stroke = Math.max(outer, -(fill + hw));
  }
  return { fill, stroke };
}

export function lineDistance(l: Pick<Line, 'x1' | 'y1' | 'x2' | 'y2'>, hw: number, cap: LineCap, px: number, py: number): number {
  const dx = l.x2 - l.x1;
  const dy = l.y2 - l.y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return 1e9;
  if (cap === 'round') return sdSegment(px, py, l.x1, l.y1, l.x2, l.y2) - hw;
  const ux = dx / len;
  const uy = dy / len;
  const wx = px - (l.x1 + l.x2) / 2;
  const wy = py - (l.y1 + l.y2) / 2;
  return sdBox(wx * ux + wy * uy, -wx * uy + wy * ux, len / 2 + (cap === 'square' ? hw : 0), hw);
}

export function pathDistances(g: PathGeometry, evenOdd: boolean, px: number, py: number): { fill: number; stroke: number } {
  let d = Infinity;
  let winding = 0;
  const s = g.segs;
  for (let i = 0; i < s.length; i += 4) {
    const ax = s[i]!;
    const ay = s[i + 1]!;
    const bx = s[i + 2]!;
    const by = s[i + 3]!;
    d = Math.min(d, sdSegment(px, py, ax, ay, bx, by));
    const side = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (ay <= py) {
      if (by > py && side > 0) winding++;
    } else if (by <= py && side < 0) winding--;
  }
  const inside = evenOdd ? (winding & 1) !== 0 : winding !== 0;
  let stroke = Infinity;
  for (let i = 0; i < g.quads.length; i += 8) stroke = Math.min(stroke, sdQuad(px, py, g.quads, i));
  for (let i = 0; i < g.discs.length; i += 4) stroke = Math.min(stroke, Math.hypot(px - g.discs[i]!, py - g.discs[i + 1]!) - g.discs[i + 2]!);
  return { fill: inside ? -d : d, stroke };
}

// ---- Bounds

// Does the shape draw anything at all? SVG draws nothing for a rectangle or an ellipse
// with a zero side, and the renderers follow it.
export function isDrawable(s: Shape): boolean {
  switch (s.type) {
    case 'rect':
      return s.width > 0 && s.height > 0;
    case 'ellipse':
      return s.rx > 0 && s.ry > 0;
    case 'line':
      return !!s.stroke && s.stroke.width > 0 && (s.x1 !== s.x2 || s.y1 !== s.y2);
    case 'path':
      return s.segments.length > 1;
  }
}

// The geometry alone, in the shape's own coordinates.
export function geometryBounds(s: Shape, tolerance = 0.25): Box {
  switch (s.type) {
    case 'rect':
      return { x: s.x, y: s.y, width: s.width, height: s.height };
    case 'ellipse':
      return { x: s.cx - s.rx, y: s.cy - s.ry, width: 2 * s.rx, height: 2 * s.ry };
    case 'line':
      return boxOfPoints([
        { x: s.x1, y: s.y1 },
        { x: s.x2, y: s.y2 },
      ]);
    case 'path':
      return cachedPathGeometry(s, tolerance).fillBounds;
  }
}

// Everything the shape may paint, stroke included, in its own coordinates.
export function paintedBounds(s: Shape, tolerance = 0.25): Box {
  if (s.type === 'path') return cachedPathGeometry(s, tolerance).bounds;
  const box = geometryBounds(s, tolerance);
  const hw = s.stroke ? s.stroke.width / 2 : 0;
  if (!hw) return box;
  // Rectangle corners with a miter reach √2 farther; so do square line caps.
  const sharp = (s.type === 'rect' && s.rx <= 0 && s.stroke!.join !== 'round') || (s.type === 'line' && s.stroke!.cap === 'square');
  return inflateBox(box, hw * (sharp ? Math.SQRT2 : 1));
}

// The axis-aligned box of a node in the space `m` maps it to.
export function nodeBounds(node: Node, m: Matrix, painted = true): Box {
  const world = multiply(m, node.transform);
  if (node.type === 'group') return node.children.filter((c) => c.visible).reduce((box, c) => unionBox(box, nodeBounds(c, world, painted)), { ...EMPTY_BOX });
  const local = painted ? paintedBounds(node) : geometryBounds(node);
  return isEmptyBox(local) ? local : transformBox(world, local);
}

// ---- Hit testing

// Does a point in the shape's own coordinates touch it, within `slop`? A shape with neither
// fill nor stroke can still be picked by its outline.
export function hitShape(s: Shape, px: number, py: number, slop: number): boolean {
  const hw = s.stroke ? s.stroke.width / 2 : 0;
  // Far from its box, nothing to compute.
  const b = paintedBounds(s);
  if (px < b.x - slop || py < b.y - slop || px > b.x + b.width + slop || py > b.y + b.height + slop) return false;
  switch (s.type) {
    case 'rect': {
      if (s.width <= 0 || s.height <= 0) return false;
      const d = rectDistances(s, hw, s.stroke?.join ?? 'miter', px, py);
      return (!!s.fill && d.fill <= slop) || (!!s.stroke && d.stroke <= slop) || (!s.fill && !s.stroke && Math.abs(d.fill) <= slop);
    }
    case 'ellipse': {
      if (s.rx <= 0 || s.ry <= 0) return false;
      const d = sdEllipse(px - s.cx, py - s.cy, s.rx, s.ry);
      return (!!s.fill && d <= slop) || Math.abs(d) - hw <= slop;
    }
    case 'line':
      return lineDistance(s, Math.max(hw, 0.5), s.stroke?.cap ?? 'butt', px, py) <= slop;
    case 'path': {
      const g = cachedPathGeometry(s, 0.25);
      const d = pathDistances(g, s.fillRule === 'evenodd', px, py);
      return (!!s.fill && d.fill <= slop) || (!!s.stroke && d.stroke <= slop) || (!s.stroke && Math.abs(d.fill) <= slop);
    }
  }
}
