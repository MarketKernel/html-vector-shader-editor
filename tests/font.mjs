/**
 * Font reading: the built-in Inter (TrueType outlines, composite glyphs, GPOS kerning) and
 * a small CFF font made from it (Type 2 charstrings with subroutines, a kern table). The
 * expected numbers come from fontTools (outlines, metrics) and HarfBuzz (kerned advances).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checker, load, root } from '../tools/load.mjs';

const c = await load('core/font.ts', 'core/geometry.ts');
const { check, near, ok, done } = checker();

const inter = c.parseFont(new Uint8Array(await readFile(join(root, 'src/assets/Inter-Regular.ttf'))));
const cff = c.parseFont(new Uint8Array(await readFile(join(root, 'tests/fixtures/inter-cff-test.otf'))));

check('names', [inter.family, inter.style, cff.family, cff.style], ['Inter', 'Regular', 'Inter CFF Test', 'Regular']);
check('metrics', [inter.unitsPerEm, inter.ascender, inter.descender, cff.unitsPerEm, cff.ascender, cff.descender], [2048, 1984, -494, 1000, 969, -241]);

// The outline's box, from the curves flattened finely, and its number of contours.
const shape = (font, ch) => {
  const g = font.glyph(font.glyphIndex(ch.codePointAt(0)));
  const pts = c.flatten(g.segments, 0.01).flatMap((s) => s.points);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const box = pts.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null;
  return { advance: g.advance, box, contours: g.segments.filter((s) => s[0] === 'Z').length };
};

// [character, glyph id, advance, box, contours] as fontTools reads them.
const INTER = [
  ['A', 1, 1413, [52, 0, 1361, 1490], 2],
  ['V', 117, 1413, [52, 0, 1361, 1490], 1],
  ['o', 211, 1228, [104, -24, 1124, 1132], 2],
  ['é', 156, 1194, [104, -24, 1094, 1558], 3],
  ['Ё', 35, 1231, [180, 0, 1097, 1910], 3],
  [',', 382, 590, [128, -359, 422, 208], 1],
];
for (const [ch, id, advance, box, contours] of INTER) {
  check(`Inter: ${ch} is glyph ${id}`, inter.glyphIndex(ch.codePointAt(0)), id);
  const s = shape(inter, ch);
  check(`Inter: ${ch} advance and contours`, [s.advance, s.contours], [advance, contours]);
  near(`Inter: ${ch} outline box`, s.box, box, 0.5);
}
check('Inter: a space has no outline', inter.glyph(inter.glyphIndex(32)).segments, []);
check('a character the font lacks is glyph 0', inter.glyphIndex(0x4e2d), 0);

const CFF = [
  ['A', 1, 690, [25, 0, 665, 728], 2],
  ['V', 2, 690, [25, 0, 665, 728], 1],
  ['o', 3, 600, [51, -12, 549, 553], 2],
  ['Ё', 8, 601, [88, 0, 536, 933], 3],
  [',', 6, 288, [63, -175, 206, 102], 1],
];
for (const [ch, id, advance, box, contours] of CFF) {
  check(`CFF: ${ch} is glyph ${id}`, cff.glyphIndex(ch.codePointAt(0)), id);
  const s = shape(cff, ch);
  check(`CFF: ${ch} advance and contours`, [s.advance, s.contours], [advance, contours]);
  near(`CFF: ${ch} outline box`, s.box, box, 0.5);
}
ok('CFF outlines are cubic', cff.glyph(3).segments.some((s) => s[0] === 'C'));
ok('TrueType outlines are quadratic', inter.glyph(211).segments.some((s) => s[0] === 'Q'));

// Advances with kerning, glyph by glyph, as HarfBuzz gives them with only `kern` on.
const advances = (font, text) => {
  const ids = [...text].map((ch) => font.glyphIndex(ch.codePointAt(0)));
  const out = ids.map((g) => font.glyph(g).advance);
  for (let i = 0; i + 1 < ids.length; i++) {
    const [a, b] = font.kerning(ids[i], ids[i + 1]);
    out[i] += a;
    out[i + 1] += b;
  }
  return out;
};
check('Inter: AVATAR kerned', advances(inter, 'AVATAR'), [1273, 1273, 1239, 1148, 1413, 1318]);
check('Inter: Cyrillic kerned', advances(inter, 'Ук Г.'), [1207, 1110, 576, 1116, 590]);
check('Inter: Typo, Lot', advances(inter, 'Typo, Lot'), [1194, 1151, 1254, 1228, 590, 576, 1158, 1228, 670]);
check('Inter: VA av', advances(inter, 'VA av'), [1273, 1413, 576, 1120, 1151]);
// HarfBuzz splits a kern table's value between the pair; the total is what counts.
check('CFF: the kern table', advances(cff, 'AVA').reduce((a, b) => a + b), 660 + 660 + 690);

const refuse = (name, bytes, pattern) => {
  try {
    c.parseFont(bytes);
    check(name, 'read', 'refused');
  } catch (e) {
    ok(`${name}: ${e.message}`, e instanceof c.FontError && pattern.test(e.message));
  }
};
refuse('not a font', new TextEncoder().encode('hello, this is not a font at all'), /не файл шрифта/);
refuse('WOFF2', new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]), /WOFF/);
const cut = new Uint8Array(await readFile(join(root, 'src/assets/Inter-Regular.ttf'))).slice(0, 4000);
refuse('a truncated file', cut, /за конец файла|Повреждённый/);

done('font');
