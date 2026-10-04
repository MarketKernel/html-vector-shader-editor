/**
 * Geometry: Bézier curves flattened within their tolerance, the pieces a path's stroke is
 * made of (joins and caps as SVG defines them), the signed distances the shaders also
 * compute, and hit testing.
 */
import { checker, load } from '../tools/load.mjs';

const g = await load('core/geometry.ts', 'core/shapes.ts');
const { check, near, ok, done } = checker();

// Cubic flattening: the polyline stays within the tolerance of the true curve.
{
  const P = [[0, 0], [100, -80], [200, 180], [300, 0]];
  const at = (t) => {
    const u = 1 - t;
    const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [k.reduce((s, w, i) => s + w * P[i][0], 0), k.reduce((s, w, i) => s + w * P[i][1], 0)];
  };
  for (const tol of [1, 0.25, 0.05]) {
    const [sub] = g.flatten([['M', 0, 0], ['C', 100, -80, 200, 180, 300, 0]], tol);
    let worst = 0;
    for (let i = 0; i <= 2000; i++) {
      const [x, y] = at(i / 2000);
      let d = Infinity;
      for (let j = 0; j + 1 < sub.points.length; j++) d = Math.min(d, g.sdSegment(x, y, sub.points[j].x, sub.points[j].y, sub.points[j + 1].x, sub.points[j + 1].y));
      worst = Math.max(worst, d);
    }
    ok(`cubic within ${tol} (worst ${worst.toFixed(4)}, ${sub.points.length} points)`, worst <= tol);
    check(`ends on the end point at ${tol}`, sub.points[sub.points.length - 1], { x: 300, y: 0 });
  }
  const [q] = g.flatten([['M', 0, 0], ['Q', 50, 100, 100, 0]], 0.1);
  ok('quadratic flattened into several', q.points.length > 8);
  check('only the curve’s ends are corners', [q.corners[0], q.corners[1], q.corners[q.corners.length - 1]], [true, false, true]);
}

// Subpaths: Z closes, the closing point is not repeated, a segment after Z starts at the
// start, repeated points are dropped.
{
  const subs = g.flatten([['M', 0, 0], ['L', 10, 0], ['L', 10, 10], ['L', 0, 0], ['Z'], ['L', 5, 5], ['L', 5, 5], ['L', 6, 6]], 1);
  check('two subpaths', subs.length, 2);
  check('closed, without the repeated first point', [subs[0].closed, subs[0].points.length], [true, 3]);
  check('after Z, from the start; repeats dropped', subs[1].points, [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 6, y: 6 }]);
}

// Stroke pieces of an open right angle with each join.
{
  const seg = [['M', 0, 0], ['L', 10, 0], ['L', 10, 10]];
  const stroke = (join, cap = 'butt') => g.pathGeometry({ segments: seg, stroke: { color: '#000000', opacity: 1, width: 2, cap, join } }, 0.1);
  const miter = stroke('miter');
  check('two segment quads and a miter quad', [miter.quads.length / 8, miter.discs.length], [3, 0]);
  check('the miter tip at the outer corner', miter.quads.slice(16, 24).slice(4, 6), [11, -1]);
  const bevel = stroke('bevel');
  check('a bevel is a triangle', bevel.quads.slice(16, 24), [10, 0, 10, -1, 11, 0, 11, 0]);
  const round = stroke('round', 'round');
  check('round join and two round caps are discs', round.discs, [10, 0, 1, 0, 0, 0, 1, 0, 10, 10, 1, 0]);
  const square = stroke('miter', 'square');
  check('square caps extend the end segments', [square.quads.slice(0, 2), square.quads.slice(10, 12)], [[-1, -1], [11, 11]]);
  check('bounds include the caps', square.bounds, { x: -1, y: -1, width: 12, height: 12 });
  // A sharp turn beyond the miter limit gets a bevel.
  const sharp = g.pathGeometry({ segments: [['M', 0, 0], ['L', 100, 0], ['L', 0, 5]], stroke: { color: '#000000', opacity: 1, width: 2, cap: 'butt', join: 'miter' } }, 0.1);
  const j = sharp.quads.slice(16, 24);
  check('past the limit: a bevel', [j[4], j[5]], [j[6], j[7]]);
}

// Distances: the ellipse against brute force, rectangles with each join.
{
  const brute = (px, py, a, b) => {
    let d = Infinity;
    for (let i = 0; i < 20000; i++) {
      const t = (i / 20000) * 2 * Math.PI;
      d = Math.min(d, Math.hypot(px - a * Math.cos(t), py - b * Math.sin(t)));
    }
    return (px / a) ** 2 + (py / b) ** 2 < 1 ? -d : d;
  };
  let worst = 0;
  for (const [a, b] of [[100, 50], [200, 10], [30, 30], [5, 120]]) {
    for (const [px, py] of [[0, 0], [10, 3], [150, 80], [-40, 20], [a, 0], [0, -b * 0.5], [a * 0.9, b * 0.9], [3, 200]]) {
      worst = Math.max(worst, Math.abs(g.sdEllipse(px, py, a, b) - brute(px, py, a, b)));
    }
  }
  ok(`ellipse distance within 0.02 px (worst ${worst.toFixed(5)})`, worst < 0.02);
  const r = { x: 0, y: 0, width: 20, height: 10, rx: 0 };
  near('rect fill inside', g.rectDistances(r, 1, 'miter', 10, 5).fill, -5);
  near('miter: the corner is sharp', g.rectDistances(r, 2, 'miter', 21.9, -1.9).stroke, -0.1, 1e-9);
  ok('round: the corner is round', g.rectDistances(r, 2, 'round', 21.9, -1.9).stroke > 0);
  ok('bevel: the corner is cut', g.rectDistances(r, 2, 'bevel', 21.9, -1.9).stroke > 0 && g.rectDistances(r, 2, 'bevel', 21, -0.5).stroke < 0);
  near('line with butt ends', g.lineDistance({ x1: 0, y1: 0, x2: 10, y2: 0 }, 1, 'butt', 11, 0), 1);
  near('line with square ends', g.lineDistance({ x1: 0, y1: 0, x2: 10, y2: 0 }, 1, 'square', 11, 0), 0);
  near('line with round ends', g.lineDistance({ x1: 0, y1: 0, x2: 10, y2: 0 }, 1, 'round', 13, 4), 4);
}

// Paths: nonzero and even-odd on a square with a square hole drawn the same way round.
{
  const segs = [['M', 0, 0], ['L', 100, 0], ['L', 100, 100], ['L', 0, 100], ['Z'], ['M', 25, 25], ['L', 75, 25], ['L', 75, 75], ['L', 25, 75], ['Z']];
  const geo = g.pathGeometry({ segments: segs, stroke: null }, 0.1);
  ok('nonzero fills the hole', g.pathDistances(geo, false, 50, 50).fill < 0);
  ok('evenodd leaves it', g.pathDistances(geo, true, 50, 50).fill > 0);
  near('distance to the hole’s edge', g.pathDistances(geo, true, 50, 50).fill, 25);
  ok('both fill the ring', g.pathDistances(geo, true, 10, 50).fill < 0 && g.pathDistances(geo, false, 10, 50).fill < 0);
  ok('outside is outside', g.pathDistances(geo, false, 150, 50).fill > 0);
  check('an open path is closed for its fill', g.pathGeometry({ segments: [['M', 0, 0], ['L', 10, 0], ['L', 10, 10]], stroke: null }, 1).segs.length / 4, 3);
}

// Hit testing.
{
  const r = g.makeRect(0, 0, 100, 50);
  ok('inside a filled rect', g.hitShape(r, 50, 25, 0));
  ok('on its stroke outside', g.hitShape(r, 100.9, 25, 0));
  ok('not far away', !g.hitShape(r, 110, 25, 2));
  const hollow = { ...r, fill: null };
  ok('a hollow rect is not hit inside', !g.hitShape(hollow, 50, 25, 2));
  const line = g.makeLine(0, 0, 100, 0);
  ok('a line near it', g.hitShape(line, 50, 2, 1.5));
  ok('and not past its end', !g.hitShape(line, 105, 0, 1));
  ok('nothing to draw in a rect of no width', !g.isDrawable(g.makeRect(0, 0, 0, 10)));
  check('painted bounds of a mitered rect', g.paintedBounds(g.makeRect(0, 0, 10, 10, { fill: null, stroke: { color: '#000000', opacity: 1, width: 2, cap: 'butt', join: 'round' } })), { x: -1, y: -1, width: 12, height: 12 });
}

done('geometry');
