/**
 * The model and its history: ops applied and taken back, drags merged into one step,
 * grouping and ungrouping that keep every shape where it is drawn, reordering, moving
 * between layers, and transforms written into geometry where they can be.
 */
import { checker, load } from '../tools/load.mjs';

const c = await load('core/document.ts', 'core/ops.ts', 'core/history.ts', 'core/actions.ts', 'core/shapes.ts', 'core/serialize.ts', 'core/matrix.ts', 'core/geometry.ts');
const { check, near, ok, done } = checker();

const snapshot = (doc) => c.canonical(doc);
const fresh = () => {
  const doc = c.createDocument(400, 300, '#ffffff', 'Layer 1');
  doc.layers[0].id = 'L1';
  return doc;
};

// Inserting, updating and removing, each undone and redone.
{
  const doc = fresh();
  const h = new c.History(() => doc);
  const empty = snapshot(doc);
  h.run(c.insertNode('L1', 0, c.makeRect(10, 10, 50, 40, undefined, 'r1')), null, null);
  h.run(c.insertNode('L1', 1, c.makeEllipse(100, 100, 30, 20, undefined, 'e1')), null, null);
  h.run(c.updateNodes([c.nodeChange(c.findNode(doc, 'r1'), { rx: 5, fill: { color: '#ff0000', opacity: 0.5 } })]), null, null);
  const full = snapshot(doc);
  check('three steps', h.size, 3);
  check('the update took', c.findNode(doc, 'r1').rx, 5);
  ok('dirty', h.dirty);
  while (h.canUndo) h.undo();
  check('undone to empty', snapshot(doc), empty);
  ok('clean at the start', !h.dirty);
  while (h.canRedo) h.redo();
  check('redone to full', snapshot(doc), full);
  h.markSaved();
  ok('saved is clean', !h.dirty);
  h.run(c.removeNode(doc, 'e1'), null, null);
  check('removed', c.findNode(doc, 'e1'), null);
  h.undo();
  check('back where it was', doc.layers[0].children.map((n) => n.id), ['r1', 'e1']);
  ok('undo to the saved step is clean', !h.dirty);
}

// A drag: many merged moves are one step, undone to the start.
{
  const doc = fresh();
  const h = new c.History(() => doc);
  h.run(c.insertNode('L1', 0, c.makeRect(0, 0, 10, 10, undefined, 'r1')), null, null);
  const before = snapshot(doc);
  const orig = [c.structuredCloneJson(c.findNode(doc, 'r1'))];
  for (let i = 1; i <= 20; i++) h.run(c.transformNodes(doc, orig, c.translate(i, 2 * i)), null, null, 'drag-1');
  check('one step for the drag', h.size, 2);
  check('moved into the geometry', [c.findNode(doc, 'r1').x, c.findNode(doc, 'r1').y], [20, 40]);
  check('matrix untouched', c.findNode(doc, 'r1').transform, [1, 0, 0, 1, 0, 0]);
  h.undo();
  check('the drag undone at once', snapshot(doc), before);
  h.redo();
  check('and redone', [c.findNode(doc, 'r1').x, c.findNode(doc, 'r1').y], [20, 40]);
  h.run(c.transformNodes(doc, [c.findNode(doc, 'r1')], c.translate(1, 0)), null, null, 'drag-2');
  check('another key, another step', h.size, 3);
}

// Transforms: rotation into the matrix, scaling along own axes into the sides.
{
  const doc = fresh();
  const r = c.makeRect(0, 0, 100, 50, undefined, 'r1');
  doc.layers[0].children.push(r);
  const rot = c.around(c.rotate(Math.PI / 2), 50, 25);
  c.transformNodes(doc, [r], rot).apply(doc);
  const turned = c.findNode(doc, 'r1');
  check('a rotation goes into the matrix', [turned.x, turned.y, turned.width, turned.height], [0, 0, 100, 50]);
  near('rotated about the centre', c.apply(turned.transform, 50, 25).x, 50, 1e-9);
  // Its own width doubled: in the document that is along Y now.
  const world = turned.transform;
  const stretch = c.multiplyAll(world, c.scale(2, 1), c.invert(world));
  c.transformNodes(doc, [turned], stretch).apply(doc);
  const scaled = c.findNode(doc, 'r1');
  near('scaled along its axis into the width', [scaled.width, scaled.height], [200, 50], 1e-9);
  near('matrix unchanged by that', scaled.transform, world, 1e-9);
  const flipped = c.transformValues(c.makeRect(10, 0, 20, 10), c.IDENTITY, c.scale(-1, 1));
  near('a mirror keeps the width positive', [flipped.x, flipped.width], [-30, 20]);
  const p = c.makePath([['M', 0, 0], ['L', 10, 0], ['C', 10, 10, 0, 10, 0, 0]]);
  check('a path takes any transform into its points', c.transformValues(p, c.IDENTITY, c.rotate(Math.PI)).segments.map((s) => s.slice(1).map((v) => Math.round(v) + 0)), [[0, 0], [-10, 0], [-10, -10, 0, -10, 0, 0]]);
  ok('a group takes it into its matrix', 'transform' in c.transformValues(c.makeGroup([]), c.IDENTITY, c.translate(1, 1)));
}

// Group and ungroup, with nested matrices and nodes from two layers.
{
  const doc = fresh();
  doc.layers.push({ ...c.createLayer('Layer 2'), id: 'L2' });
  const h = new c.History(() => doc);
  h.run(c.insertNode('L1', 0, c.makeRect(0, 0, 10, 10, undefined, 'a')), null, null);
  h.run(c.insertNode('L1', 1, c.makeEllipse(50, 50, 5, 5, undefined, 'b')), null, null);
  h.run(c.insertNode('L2', 0, c.makeLine(0, 0, 10, 10, undefined, 'x')), null, null);
  h.run(c.insertNode('L1', 2, c.makeRect(90, 90, 5, 5, undefined, 'top')), null, null);
  const start = snapshot(doc);
  const g = c.groupNodes(doc, ['b', 'a', 'x'], 'G');
  h.run(g.op, null, null);
  check('group in the topmost one’s layer, above it', doc.layers[1].children.map((n) => n.id), ['G']);
  check('children in z-order', c.findNode(doc, 'G').children.map((n) => n.id), ['a', 'b', 'x']);
  check('layer 1 keeps the rest', doc.layers[0].children.map((n) => n.id), ['top']);
  check('selects the group', g.selection, ['G']);
  // Move the group, then ungroup: the shapes end up moved, in place, in order.
  h.run(c.updateNodes([c.nodeChange(c.findNode(doc, 'G'), { transform: [1, 0, 0, 1, 100, 0], opacity: 0.5 })]), null, null);
  const u = c.ungroupNodes(doc, ['G']);
  h.run(u.op, null, null);
  check('ungrouped in order', doc.layers[1].children.map((n) => n.id), ['a', 'b', 'x']);
  check('the group’s matrix passed on', c.findNode(doc, 'a').transform, [1, 0, 0, 1, 100, 0]);
  check('and its opacity', c.findNode(doc, 'b').opacity, 0.5);
  while (h.size > 4) h.undo();
  check('undo restores the layers', snapshot(doc), start);
}

// A group inside a transformed group: the shape keeps its place in the document.
{
  const doc = fresh();
  const inner = c.makeRect(0, 0, 10, 10, undefined, 'r');
  const outer = c.makeGroup([inner], 'O');
  outer.transform = [2, 0, 0, 2, 30, 40];
  doc.layers[0].children.push(outer, c.makeRect(0, 0, 1, 1, undefined, 's'));
  const before = c.worldMatrix(doc, 'r');
  const e = c.moveNodesTo(doc, ['r'], 'L1');
  e.op.apply(doc);
  near('moved out, drawn the same', c.worldMatrix(doc, 'r'), before);
  check('to the top of the layer', doc.layers[0].children.map((n) => n.id), ['O', 's', 'r']);
  e.op.revert(doc);
  check('and back', c.findNode(doc, 'O').children.map((n) => n.id), ['r']);
}

// Reordering several at once.
{
  const doc = fresh();
  for (const id of ['a', 'b', 'c', 'd', 'e']) doc.layers[0].children.push(c.makeRect(0, 0, 1, 1, undefined, id));
  const ids = () => doc.layers[0].children.map((n) => n.id).join('');
  const run = (sel, how) => c.reorderNodes(doc, sel, how).op.apply(doc);
  run(['b', 'c'], 'forward');
  check('forward', ids(), 'adbce');
  run(['b', 'c'], 'front');
  check('to front', ids(), 'adebc');
  run(['e', 'c'], 'back');
  check('to back', ids(), 'ecadb');
  run(['a'], 'backward');
  check('backward', ids(), 'eacdb');
  run(['e'], 'backward');
  check('already at the bottom', ids(), 'eacdb');
}

// Duplicate, copy and paste: new ids, the same drawing.
{
  const doc = fresh();
  const g = c.makeGroup([c.makeRect(0, 0, 10, 10, undefined, 'r')], 'G');
  g.transform = [1, 0, 0, 1, 5, 5];
  doc.layers[0].children.push(g);
  const d = c.duplicateNodes(doc, ['G']);
  d.op.apply(doc);
  check('duplicated above', doc.layers[0].children.length, 2);
  ok('new ids', d.selection[0] !== 'G' && c.findNode(doc, d.selection[0]).children[0].id !== 'r');
  check('moved by 10', c.findNode(doc, d.selection[0]).transform, [1, 0, 0, 1, 15, 15]);
  const clip = c.copyNodes(doc, ['r']);
  check('copied with its group’s matrix', clip[0].transform, [1, 0, 0, 1, 5, 5]);
  const p = c.pasteNodes(doc, clip, 'G');
  p.op.apply(doc);
  near('pasted into the group, drawn in the same place', c.worldMatrix(doc, p.selection[0]), [1, 0, 0, 1, 5, 5]);
}

// Layers.
{
  const doc = fresh();
  const h = new c.History(() => doc);
  const added = c.addLayer(doc, 'Top');
  h.run(added.op, null, null);
  h.run(c.updateLayer(doc, added.id, { opacity: 0.5 }), null, null, 'op');
  h.run(c.updateLayer(doc, added.id, { opacity: 0.3, blend: 'multiply' }), null, null, 'op');
  check('merged layer changes', h.size, 2);
  check('blend', doc.layers[1].blend, 'multiply');
  h.run(c.moveLayerTo(doc, added.id, 0), null, null);
  check('moved to the bottom', doc.layers.map((l) => l.name), ['Top', 'Layer 1']);
  const dup = c.duplicateLayer(doc, 'L1', 'Layer 1 copy');
  h.run(dup.op, null, null);
  check('duplicated above', doc.layers.map((l) => l.name), ['Top', 'Layer 1', 'Layer 1 copy']);
  h.run(c.deleteLayer(doc, added.id), null, null);
  check('deleted', doc.layers.length, 2);
  while (h.canUndo) h.undo();
  check('all undone', doc.layers.map((l) => [l.name, l.opacity, l.blend]), [['Layer 1', 1, 'normal']]);
  check('the last layer cannot go', c.deleteLayer(doc, 'L1'), null);
}

done('model');
