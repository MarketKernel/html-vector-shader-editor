/**
 * The file format: written and read back to the same document, older versions migrated,
 * and broken files refused with a reason rather than half read.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checker, load, root } from '../tools/load.mjs';

const c = await load('core/serialize.ts', 'core/document.ts');
const { check, ok, done } = checker();

const text = await readFile(join(root, 'tests/fixtures/showcase.vector.json'), 'utf8');
const doc = c.parseDocument(text);
check('reads the showcase', [doc.layers.length, doc.layers[0].children.length], [4, 8]);
const again = c.parseDocument(c.serialize(doc));
check('round trip', c.canonical(again), c.canonical(doc));
check('serialized twice, the same text', c.serialize(again), c.serialize(doc));
ok('arrays of numbers stay on one line', c.serialize(doc).includes('"transform": [1, 0, 0, 1, 0, 0]'));
ok('segments one per line', c.serialize(doc).includes('["C", 290, 100, 380, 100, 420, 150]'));

// Version 0: no version field, layers without blend, fills as bare colours.
const old = c.parseDocument(JSON.stringify({ width: 10, height: 10, background: '#FFF', layers: [{ id: 'a', name: 'A', children: [{ id: 'r', type: 'rect', x: 0, y: 0, width: 5, height: 5, fill: '#F00' }] }] }));
check('migrated to the current version', old.version, 2);
check('layer gets a blend', old.layers[0].blend, 'normal');
check('fill becomes an object', old.layers[0].children[0].fill, { color: '#ff0000', opacity: 1 });
check('short colours expanded', old.background, '#ffffff');
check('defaults filled in', [old.layers[0].children[0].transform, old.layers[0].children[0].visible, old.layers[0].children[0].rx], [[1, 0, 0, 1, 0, 0], true, 0]);

const refuse = (name, value, pattern) => {
  try {
    c.parseDocument(typeof value === 'string' ? value : JSON.stringify(value));
    check(name, 'read', 'refused');
  } catch (e) {
    ok(`${name}: ${e.message}`, pattern.test(e.message));
  }
};
const base = { version: 1, width: 10, height: 10, background: null, layers: [] };
refuse('not JSON', '{nope', /Not JSON/);
refuse('a newer version', { ...base, version: 99 }, /newer/);
refuse('a bad size', { ...base, width: -1 }, /width/);
refuse('an unknown node', { ...base, layers: [{ id: 'l', name: 'l', children: [{ id: 'x', type: 'star' }] }] }, /unknown node type/);
refuse('a bad segment', { ...base, layers: [{ id: 'l', name: 'l', children: [{ id: 'x', type: 'path', segments: [['C', 1, 2]] }] }] }, /takes 6/);
refuse('a bad colour', { ...base, layers: [{ id: 'l', name: 'l', children: [{ id: 'x', type: 'ellipse', cx: 0, cy: 0, rx: 1, ry: 1, fill: { color: 'red' } }] }] }, /colour/);
refuse('a repeated id', { ...base, layers: [{ id: 'l', name: 'l', children: [{ id: 'l', type: 'group', children: [] }] }] }, /twice/);
refuse('a bad blend', { ...base, layers: [{ id: 'l', name: 'l', blend: 'overlay', children: [] }] }, /blend/);

done('serialize');
