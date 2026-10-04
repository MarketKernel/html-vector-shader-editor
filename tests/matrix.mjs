/**
 * Matrices: products in SVG's order, inverses, and the decomposition the properties
 * panel shows, which must compose back to the same matrix.
 */
import { checker, load } from '../tools/load.mjs';

const m = await load('core/matrix.ts');
const { check, near, ok, done } = checker();

const M = [2, 0.5, -0.3, 1.5, 10, 20];
near('identity is neutral', m.multiply(m.IDENTITY, M), M);
near('translate then scale', m.multiply(m.translate(5, 6), m.scale(2)), [2, 0, 0, 2, 5, 6]);
near('a point', [m.apply(m.translate(5, 6), 1, 2).x, m.apply(m.translate(5, 6), 1, 2).y], [6, 8]);
near('scale after translate', m.apply(m.multiply(m.scale(2), m.translate(5, 6)), 1, 2).x, 12);
near('inverse', m.multiply(M, m.invert(M)), m.IDENTITY, 1e-12);
check('a flat matrix has no inverse', m.invert([1, 2, 2, 4, 0, 0]), null);
near('rotate 90° takes x to y', [m.apply(m.rotate(Math.PI / 2), 1, 0).x, m.apply(m.rotate(Math.PI / 2), 1, 0).y], [0, 1], 1e-12);

for (const sample of [M, m.multiplyAll(m.translate(3, 4), m.rotate(0.7), m.scale(2, 3)), [-1, 0, 0, 1, 0, 0], [1, 0, 0.5, 1, 0, 0], m.rotate(-2.5)]) {
  near(`decompose → compose ${JSON.stringify(sample)}`, m.compose(m.decompose(sample)), sample, 1e-9);
}
const d = m.decompose(m.multiplyAll(m.translate(3, 4), m.rotate(Math.PI / 6), m.scale(2, 3)));
near('decomposed parts', [d.translateX, d.translateY, d.rotation, d.scaleX, d.scaleY, d.shear], [3, 4, 30, 2, 3, 0], 1e-9);
near('mean scale', m.meanScale(m.scale(2, 8)), 4);
near('around a pivot keeps it', [m.apply(m.around(m.rotate(1), 5, 5), 5, 5).x, m.apply(m.around(m.rotate(1), 5, 5), 5, 5).y], [5, 5], 1e-12);
const rb = m.transformBox(m.rotate(Math.PI / 2), { x: 0, y: 0, width: 10, height: 20 });
near('box of a rotated box', [rb.x, rb.y, rb.width, rb.height], [-20, 0, 20, 10], 1e-9);
ok('boxes touching intersect', m.boxesIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 10, width: 5, height: 5 }));

done('matrix');
