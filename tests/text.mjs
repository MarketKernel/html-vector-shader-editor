/**
 * Texts: setting lines (advances, kerning, letter spacing, alignment), where the caret
 * stands, the outlines as one chunked path, transforms written into the text's place and
 * size, the file format's fonts, and texts in the SVG and GLSL exports.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checker, load, root } from '../tools/load.mjs';

const c = await load('core/fonts.ts', 'core/text.ts', 'core/geometry.ts', 'core/actions.ts', 'core/serialize.ts', 'core/shapes.ts', 'core/document.ts', 'core/svg.ts', 'core/glsl.ts', 'core/draw.ts', 'core/ops.ts');
const { check, near, ok, done } = checker();

const interBytes = new Uint8Array(await readFile(join(root, 'src/assets/Inter-Regular.ttf')));
c.registerFont({ id: c.BUILTIN_FONT, family: 'Inter', style: 'Regular', data: c.encodeBase64(interBytes) });
const cffBytes = new Uint8Array(await readFile(join(root, 'tests/fixtures/inter-cff-test.otf')));

const k = 20.48 / 2048;
const text = (words, more = {}) => c.makeText(words, 10, 100, undefined, { ...c.DEFAULT_TEXT, size: 20.48, ...more }, 't');

// "AV": 1413 − 140 (GPOS) + 1413 font units.
{
  const l = c.layoutText(text('AV'));
  check('one line', l.lines.length, 1);
  near('kerned width', l.lines[0].width, (1273 + 1413) * k);
  near('carets before, between and after', l.lines[0].carets, [10, 10 + 1273 * k, 10 + 2686 * k]);
  near('the box: ascent above the baseline, descent below', [l.box.x, l.box.y, l.box.height], [10, 100 - 1984 * k, (1984 + 494) * k]);
  check('two glyph outlines', l.glyphs.length, 2);
  const spaced = c.layoutText(text('AV', { letterSpacing: 3 }));
  near('letter spacing between characters, not after the last', spaced.lines[0].width, (1273 + 1413) * k + 3);
  const middle = c.layoutText(text('AV', { align: 'middle' }));
  near('centred on x', middle.lines[0].left, 10 - middle.lines[0].width / 2);
  const end = c.layoutText(text('AV', { align: 'end' }));
  near('ending on x', end.lines[0].left + end.lines[0].width, 10);
}

// Lines, an empty one among them, and a character beyond the Basic Multilingual Plane.
{
  const words = 'Ab\n\n😀x';
  const l = c.layoutText(text(words, { lineHeight: 1.5 }));
  check('three lines', l.lines.map((x) => [x.start, x.end]), [[0, 2], [3, 3], [4, 7]]);
  near('baselines a line height apart', l.lines.map((x) => x.baseline), [100, 100 + 1.5 * 20.48, 100 + 3 * 20.48]);
  check('an empty line has its caret at the start', l.lines[1].carets, [10]);
  check('the surrogate pair is one glyph: carets at 0, 0, after it, after x', l.lines[2].carets.length, 4);
  near('both halves of the pair share a caret', l.lines[2].carets[0], l.lines[2].carets[1]);
  check('a click at the right of the first line', c.caretAt(l, 1000, 95, words), 2);
  check('a click on the third line, left', c.caretAt(l, 0, 100 + 3 * 20.48, words), 4);
  check('a click between the halves of the pair lands after it', c.caretAt(l, l.lines[2].carets[2] - 0.01, 100 + 3 * 20.48, words), 6);
  check('the caret position of index 3', c.caretPosition(l, 3), { line: 1, x: 10 });
}

// Glyph outlines as one chunked path: a chunk per glyph, nonzero.
{
  const t = text('oo');
  const g = c.cachedPathGeometry(t, 0.1);
  check('a chunk per glyph', g.chunks, 2);
  check('each chunk: box, counts, then its edges', g.packed.length, 2 * 8 + g.segs.length);
  // A point in the hole of the first o: outside, though inside the glyph's box.
  const l = c.cachedLayout(t);
  const o = l.lines[0];
  const holeX = (o.carets[0] + o.carets[1]) / 2;
  const holeY = 100 - (1132 - 24) * k / 2 + 0;
  const d = c.pathDistances(g, false, holeX, holeY);
  ok('the hole of the o is not filled', d.fill > 0);
  ok('the ring of the o is', c.pathDistances(g, false, 10 + 130 * k, holeY).fill < 0);
  ok('a click anywhere in the frame hits the text', c.hitShape(t, 10 + 1228 * k, 95, 0.5));
  ok('and nowhere near it does not', !c.hitShape(t, 200, 95, 0.5));
}

// Moved or scaled the same both ways: written into the text; anything else, its matrix.
{
  const t = text('Hi');
  check('a move into x and y', c.transformValues(t, [1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 5, -5]), { x: 15, y: 95 });
  check('a uniform scale into size and spacing', c.transformValues({ ...t, letterSpacing: 1 }, [1, 0, 0, 1, 0, 0], [2, 0, 0, 2, 0, 0]), { x: 20, y: 200, size: 40.96, letterSpacing: 2 });
  check('a stretch into the matrix', Object.keys(c.transformValues(t, [1, 0, 0, 1, 0, 0], [2, 0, 0, 1, 0, 0])), ['transform']);
  check('a mirror into the matrix', Object.keys(c.transformValues(t, [1, 0, 0, 1, 0, 0], [-1, 0, 0, -1, 0, 0])), ['transform']);
}

// The file format: fonts carried, checked against their id, migrated from version 1.
{
  const face = c.faceFromFile(cffBytes);
  check('a face from a file: its names and a content id', [face.family, face.style, face.id], ['Inter CFF Test', 'Regular', c.fontId(cffBytes)]);
  check('the same file, the same id', c.fontId(cffBytes.slice()), face.id);
  const doc = c.createDocument(100, 50, null);
  doc.fonts.push(face);
  doc.layers[0].children.push({ ...text('AV'), font: face.id });
  const back = c.parseDocument(c.serialize(doc));
  check('round trip with a font', c.canonical(back), c.canonical(doc));
  const v1 = c.parseDocument(JSON.stringify({ version: 1, width: 10, height: 10, background: null, layers: [] }));
  check('version 1 gets no fonts', [v1.version, v1.fonts], [2, []]);
  const refuse = (name, value, pattern) => {
    try {
      c.parseDocument(JSON.stringify(value));
      check(name, 'read', 'refused');
    } catch (e) {
      ok(`${name}: ${e.message}`, pattern.test(e.message));
    }
  };
  const base = { version: 2, width: 10, height: 10, background: null, fonts: [], layers: [] };
  refuse('a text in a font the document lacks', { ...base, layers: [{ id: 'l', name: 'l', children: [{ id: 't', type: 'text', text: 'x', x: 0, y: 0, font: 'font-0000', size: 10 }] }] }, /no font font-0000/);
  refuse('a font whose data is not its id', { ...base, fonts: [{ ...face, id: 'font-1234' }] }, /not the id/);
  refuse('a font that is no font', { ...base, fonts: [{ id: c.fontId(new Uint8Array([1, 2, 3])), family: 'x', style: 'y', data: c.encodeBase64(new Uint8Array([1, 2, 3])) }] }, /шрифт/i);
  refuse('a text of no size', { ...base, layers: [{ id: 'l', name: 'l', children: [{ id: 't', type: 'text', text: 'x', x: 0, y: 0, font: 'inter', size: 0 }] }] }, /size/);

  // Pasted into a document without its font, the font comes along.
  const other = c.createDocument(100, 50, null);
  const e = c.pasteNodes(other, c.copyNodes(doc, ['t']), other.layers[0].id);
  e.op.apply(other);
  check('a pasted text brings its font', other.fonts.map((f) => f.id), [face.id]);
  e.op.revert(other);
  check('and takes it back on undo', other.fonts, []);
}

// Exports: the SVG draws the outlines and says so; the shader takes them as path data.
{
  const doc = c.createDocument(200, 100, null);
  doc.layers[0].id = 'l';
  doc.layers[0].children.push(text('AV & <o>'));
  const svg = c.exportSvg(doc);
  ok('a path with the words as its label', /<path d="M[^"]+Z" aria-label="AV &amp; &lt;o&gt;" fill="#4f8ef7"\/>/.test(svg.text));
  check('one note about it', svg.warnings.length, 1);
  const glsl = c.exportGlsl(doc).text;
  ok('the shader names the text by its words', glsl.includes('// text "AV & <o>" (t)'));
  ok('and draws it as a path, a chunk per glyph (spaces have none)', /paintPath\(q, 0, 6, false/.test(glsl));
  const spaces = c.createDocument(10, 10, null);
  spaces.layers[0].children.push(text('   '));
  check('a text of spaces draws nothing', c.drawList(spaces, { tolerance: 0.25, scale: 1 }).layers[0].items, []);
}

done('text');
