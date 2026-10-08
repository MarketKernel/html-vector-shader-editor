/**
 * SVG import: this editor's own export read back to the same picture, path data and
 * transforms, colours, units, the CSS cascade, <use> and <symbol>, layers, texts, and a
 * warning for whatever the model cannot carry.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checker, load, root } from '../tools/load.mjs';

const c = await load('core/svg-import.ts', 'core/svg.ts', 'core/serialize.ts', 'core/color.ts', 'core/xml.ts', 'core/fonts.ts');
const { check, near, ok, done } = checker();
// The exported texts are drawn by their glyphs.
c.registerFont({ id: c.BUILTIN_FONT, family: 'Inter', style: 'Regular', data: c.encodeBase64(new Uint8Array(await readFile(join(root, 'src/assets/Inter-Regular.ttf')))) });

const SVG = (body, attrs = 'width="100" height="100"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const nodes = (text) => c.importSvg(SVG(text)).doc.layers.flatMap((l) => l.children);
const warnings = (text, attrs) => c.importSvg(SVG(text, attrs)).warnings;
const first = (text) => nodes(text)[0];
// A <g> alone at the top is a layer; beside something else it stays a group.
const grouped = (text) => nodes(`${text}<circle r="1"/>`)[0];

// ---- The export read back
{
  for (const name of ['showcase', 'text']) {
    const doc = c.parseDocument(await readFile(join(root, `tests/fixtures/${name}.vector.json`), 'utf8'));
    const svg = c.exportSvg(doc).text;
    const back = c.importSvg(svg);
    check(`${name}: nothing to warn about`, back.warnings, []);
    check(`${name}: exported again, the same SVG`, c.exportSvg(back.doc).text.replace(/ aria-label="[^"]*"/g, ''), svg.replace(/ aria-label="[^"]*"/g, ''));
    ok(`${name}: a valid document`, c.parseDocument(c.serialize(back.doc)));
  }
  const doc = c.parseDocument(await readFile(join(root, 'tests/fixtures/showcase.vector.json'), 'utf8'));
  const back = c.importSvg(c.exportSvg(doc).text).doc;
  check('layers keep their ids, names, opacity and blend', back.layers.map((l) => [l.id, l.name, l.opacity, l.blend]), [
    ['base', 'Base', 1, 'normal'],
    ['overlay', 'Overlay', 0.9, 'multiply'],
    ['glow', 'Glow', 1, 'screen'],
  ]);
  check('the background rectangle is the background again', [back.background, back.width, back.height], ['#ffffff', 480, 320]);
  check('shapes keep their kinds', back.layers[0].children.map((n) => n.type), ['rect', 'rect', 'ellipse', 'ellipse', 'path', 'group', 'line']);
}

// ---- Path data
{
  const p = (d) => c.parsePathData(d);
  check('relative, H, V, Z and pairs after M', p('m10 10h5v5H0zl1 1 2 2'), {
    segments: [['M', 10, 10], ['L', 15, 10], ['L', 15, 15], ['L', 0, 15], ['Z'], ['L', 11, 11], ['L', 13, 13]],
    error: false,
  });
  check('numbers run together', p('M1.5.5-2-3e1L.1.2').segments, [['M', 1.5, 0.5], ['L', -2, -30], ['L', 0.1, 0.2]]);
  check('S reflects the last control point, T the last quadratic one', p('M0 0C0 10 10 10 10 0S20-10 20 0Q25 5 30 0T40 0').segments, [
    ['M', 0, 0], ['C', 0, 10, 10, 10, 10, 0], ['C', 10, -10, 20, -10, 20, 0], ['Q', 25, 5, 30, 0], ['Q', 35, -5, 40, 0],
  ]);
  check('S after a line starts at the current point', p('M0 0L5 0S10 5 10 0').segments[2], ['C', 5, 0, 10, 5, 10, 0]);
  const arc = p('M0 0a10 10 0 012 0 10 10 0 0 1-2 0').segments;
  // Flags written together: "01" is large-arc 0, sweep 1.
  check('arcs with their flags run together', [arc.length > 2, arc.at(-1).slice(-2)], [true, [0, 0]]);
  const half = p('M-10 0A10 10 0 0 1 10 0').segments;
  check('a half circle: four cubic pieces ending exactly at the end point', [half.length, half.at(-1).slice(5)], [5, [10, 0]]);
  // A cubic eighth of a circle is off it by a few millionths of the radius.
  let worst = 0;
  let [x, y] = [-10, 0];
  for (const s of half.slice(1)) {
    for (let t = 0; t <= 1; t += 0.125) {
      const u = 1 - t;
      const px = u * u * u * x + 3 * u * u * t * s[1] + 3 * u * t * t * s[3] + t * t * t * s[5];
      const py = u * u * u * y + 3 * u * u * t * s[2] + 3 * u * t * t * s[4] + t * t * t * s[6];
      worst = Math.max(worst, Math.abs(Math.hypot(px, py) - 10));
    }
    [x, y] = [s[5], s[6]];
  }
  ok(`the half circle stays on the circle (off by ${worst.toExponential(1)})`, worst < 1e-4);
  ok('sweep 1 goes through negative y (up on screen)', half.some((s) => s[2] < -5));
  check('an arc too small for its end points is scaled up to reach them', p('M0 0A1 1 0 0 1 20 0').segments.at(-1).slice(5), [20, 0]);
  check('an arc with a zero radius is a line', p('M0 0A0 5 0 0 1 20 0').segments[1], ['L', 20, 0]);
  check('drawn up to the first error', p('M0 0L10 10L20').segments, [['M', 0, 0], ['L', 10, 10]]);
  check('and the error said', p('M0 0L10 10L20').error, true);
  check('not starting with M: nothing', p('L10 10'), { segments: [], error: true });
}

// ---- Transforms, view boxes, lengths
{
  near('translate rotate scale skew', c.parseTransform('translate(10) rotate(90 5 5), scale(2 3)skewX(45)'), [0, 2, -3, 2, 20, 0]);
  check('matrix', c.parseTransform(' matrix(1,2,3,4,5,6) '), [1, 2, 3, 4, 5, 6]);
  check('a broken transform is not a transform', [c.parseTransform('rotate(1 2)'), c.parseTransform('translate(1) junk')], [null, null]);
  check('viewBox, meet: centred', c.viewBoxMatrix([0, 0, 10, 20], 100, 100), [5, 0, 0, 5, 25, 0]);
  check('viewBox, slice at the end', c.viewBoxMatrix([0, 0, 10, 20], 100, 100, 'xMaxYMax slice'), [10, 0, 0, 10, 0, -100]);
  check('viewBox, none: stretched', c.viewBoxMatrix([5, 5, 10, 20], 100, 100, 'none'), [10, 0, 0, 5, -50, -25]);
  const vp = { width: 200, height: 100 };
  near('units', ['1in', '25.4mm', '72pt', '50%', '2em', '10'].map((s, i) => c.parseLength(s, vp, i === 3 ? 'x' : 'xy', 12)), [96, 96, 96, 100, 24, 10]);
  ok('not a length', Number.isNaN(c.parseLength('1 2')));
}

// ---- Colours
{
  const col = (s) => c.parseCssColor(s);
  check('names', [col('Red'), col('rebeccapurple'), col('transparent').alpha], [{ hex: '#ff0000', alpha: 1 }, { hex: '#663399', alpha: 1 }, 0]);
  check('hex of 3, 4, 6 and 8 digits', ['#abc', '#abcd', '#a0b1c2', '#a0b1c280'].map(col), [
    { hex: '#aabbcc', alpha: 1 }, { hex: '#aabbcc', alpha: 0xdd / 255 }, { hex: '#a0b1c2', alpha: 1 }, { hex: '#a0b1c2', alpha: 128 / 255 },
  ]);
  check('rgb() with commas, spaces, percentages and alpha', ['rgb(255, 0, 10)', 'rgba(0,0,0,.5)', 'rgb(100% 50% 0% / 25%)'].map(col), [
    { hex: '#ff000a', alpha: 1 }, { hex: '#000000', alpha: 0.5 }, { hex: '#ff8000', alpha: 0.25 },
  ]);
  check('hsl()', [col('hsl(120, 100%, 25%)'), col('hsla(0 100% 50% / 0.5)')], [{ hex: '#008000', alpha: 1 }, { hex: '#ff0000', alpha: 0.5 }]);
  check('not colours', ['nope', '#12', 'rgb(1,2)', 'lab(50 0 0)'].map(col), [null, null, null, null]);
  check('148 named colours', c.COLOR_NAMES.length, 148);
}

// ---- Shapes and their paint
{
  const r = first('<rect x="1" y="2" width="30" height="20" rx="4" fill="#123" stroke="red" stroke-width="3" stroke-linecap="round" stroke-linejoin="bevel" opacity="0.5" fill-opacity="50%"/>');
  check('a rectangle', [r.type, r.x, r.y, r.width, r.height, r.rx, r.opacity, r.fill, r.stroke], ['rect', 1, 2, 30, 20, 4, 0.5, { color: '#112233', opacity: 0.5 }, { color: '#ff0000', opacity: 1, width: 3, cap: 'round', join: 'bevel' }]);
  check('ry alone rounds both ways; a radius is at most half a side', [first('<rect width="10" height="40" ry="3"/>').rx, first('<rect width="10" height="40" rx="30"/>').type], [3, 'path']);
  const rr = first('<rect width="40" height="20" rx="10" ry="4"/>');
  check('corners of two radii: a path', [rr.type, rr.segments[0], rr.segments.at(-1)], ['path', ['M', 10, 0], ['Z']]);
  check('nothing for a rectangle without area', nodes('<rect width="0" height="5"/>'), []);
  const e = nodes('<circle cx="5" cy="6" r="7"/><ellipse cx="1" cy="2" rx="3"/>');
  check('circle and ellipse (ry from rx)', e.map((n) => [n.type, n.cx, n.cy, n.rx, n.ry]), [['ellipse', 5, 6, 7, 7], ['ellipse', 1, 2, 3, 3]]);
  const l = first('<line x1="1" y1="2" x2="3" y2="4" stroke="blue" fill="red"/>');
  check('a line takes no fill', [l.type, l.fill, l.stroke.color], ['line', null, '#0000ff']);
  const poly = nodes('<polyline points="0,0 10,0 10,10"/><polygon points="0 0 10 0 10 10 5"/>');
  check('polyline and polygon', poly.map((n) => n.segments), [[['M', 0, 0], ['L', 10, 0], ['L', 10, 10]], [['M', 0, 0], ['L', 10, 0], ['L', 10, 10], ['Z']]]);
  check('fill-rule', first('<path d="M0 0L1 1L0 1Z" fill-rule="evenodd"/>').fillRule, 'evenodd');
  check('the default paint: black fill, no stroke', [first('<path d="M0 0L1 1"/>').fill, first('<path d="M0 0L1 1"/>').stroke], [{ color: '#000000', opacity: 1 }, null]);
  check('no stroke of width 0', first('<path d="M0 0L1 1" stroke="red" stroke-width="0"/>').stroke, null);
  check('currentColor', grouped('<g color="#0a0"><path d="M0 0L1 1" fill="currentColor"/></g>').children[0].fill.color, '#00aa00');
  check('rgba alpha times fill-opacity', first('<path d="M0 0L1 1" fill="rgba(255,0,0,0.5)" fill-opacity="0.5"/>').fill, { color: '#ff0000', opacity: 0.25 });
  check('hidden: kept, not shown', [first('<path d="M0 0L1 1" visibility="hidden"/>').visible, first('<path d="M0 0L1 1" style="display:none"/>').visible], [false, false]);
  const t = grouped('<g transform="translate(5 5)"><rect width="1" height="1" transform="rotate(90)"/></g>');
  check('transforms stay on their nodes', [t.transform, t.children[0].transform.map((v) => Math.round(v))], [[1, 0, 0, 1, 5, 5], [0, 1, -1, 0, 0, 0]]);
}

// ---- The cascade
{
  const sheet = '<style>rect { fill: blue } .a { fill: green; stroke: black } #x { fill: yellow } g > .b { fill: purple } .imp { fill: gray !important }</style>';
  const [byTag, byClass, byId, inStyle, attrUnder, child, important] = nodes(
    `${sheet}<rect width="1" height="1"/><rect class="a" width="1" height="1"/><rect id="x" class="a" width="1" height="1"/><rect class="a" style="fill:red" width="1" height="1"/><rect class="a" fill="white" width="1" height="1"/><g><rect class="b" width="1" height="1"/></g><rect class="imp" style="fill:red" width="1" height="1"/>`,
  );
  check('tag < class < id < style=""; attributes under everything', [byTag, byClass, byId, inStyle, attrUnder].map((n) => n.fill.color), ['#0000ff', '#008000', '#ffff00', '#ff0000', '#008000']);
  check('child combinator', child.children[0].fill.color, '#800080');
  check('!important beats style=""', important.fill.color, '#808080');
  const inherited = grouped('<g fill="red" stroke="blue" stroke-width="4" opacity="0.5"><path d="M0 0L1 1"/><path d="M0 0L1 1" fill="inherit" stroke="none"/></g>');
  check('fill and stroke inherit, opacity does not', inherited.children.map((n) => [n.fill?.color, n.stroke?.width ?? null, n.opacity]), [['#ff0000', 4, 1], ['#ff0000', null, 1]]);
  check('a selector it cannot match is said', warnings('<style>rect:hover{fill:red}</style><rect width="1" height="1"/>'), ['Селектор CSS «rect:hover» не поддерживается; его правила пропущены.']);
}

// ---- <use>, <symbol>, nested <svg>
{
  const [u] = nodes('<defs><path id="p" d="M0 0L10 0" stroke="red"/></defs><use href="#p" x="5" y="6" opacity="0.5"/>');
  check('a <use> of one shape: the shape, moved', [u.type, u.transform, u.opacity, u.stroke.color], ['path', [1, 0, 0, 1, 5, 6], 0.5, '#ff0000']);
  const [s] = nodes('<symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol><use xlink:href="#s" width="20" height="20" fill="lime"/>');
  check('a symbol fitted to the size of its <use>, styles inherited from the <use>', [s.type, s.transform, s.children[0].fill.color], ['group', [2, 0, 0, 2, 0, 0], '#00ff00']);
  check('a loop of <use> is cut', warnings('<g id="g"><use href="#g"/><rect width="1" height="1"/></g>').length, 1);
  const n = first('<svg x="10" y="10" width="20" height="20" viewBox="0 0 10 10" overflow="visible"><rect width="10" height="10"/></svg>');
  check('a nested <svg>: a group with its viewBox', n.transform, [2, 0, 0, 2, 10, 10]);
}

// ---- The page and layers
{
  const page = c.importSvg(SVG('<rect width="10" height="10"/>', 'width="10cm" height="5cm" viewBox="-5 -5 100 50"')).doc;
  check('the viewBox is the page; its origin moved to 0, 0', [page.width, page.height, page.layers[0].children[0].x], [100, 50, 5]);
  const mm = c.importSvg(SVG('<rect width="10" height="10"/>', 'width="100mm" height="1in"')).doc;
  near('no viewBox: width and height in pixels', [mm.width, mm.height], [377.952756, 96], 1e-5);
  check('neither: 300 × 150', [c.importSvg(SVG('<rect width="1" height="1"/>', '')).doc.width, c.importSvg(SVG('<rect width="1" height="1"/>', '')).doc.height], [300, 150]);
  const inkscape = c.importSvg(
    SVG(
      '<sodipodi:namedview pagecolor="#fff"/><g inkscape:groupmode="layer" id="layer1" inkscape:label="Back" sodipodi:insensitive="true" transform="translate(0 10)"><rect width="5" height="5"/></g><g inkscape:groupmode="layer" id="layer2" inkscape:label="Front" style="display:none;mix-blend-mode:multiply" opacity="0.5"><circle r="3"/></g>',
      'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" viewBox="0 0 100 100"',
    ),
  );
  check(
    'Inkscape layers: name, lock, visibility, opacity, blend; a layer moved moves its shapes',
    inkscape.doc.layers.map((l) => [l.id, l.name, l.locked, l.visible, l.opacity, l.blend, l.children.map((n) => [n.type, n.y ?? n.cy])]),
    [
      ['layer1', 'Back', true, true, 1, 'normal', [['rect', 10]]],
      ['layer2', 'Front', false, false, 0.5, 'multiply', [['ellipse', 0]]],
    ],
  );
  check('and its editor metadata ignored quietly', inkscape.warnings, []);
  const mixed = c.importSvg(SVG('<g><rect width="1" height="1"/></g><circle r="1"/>')).doc;
  check('groups among other things: one layer', [mixed.layers.length, mixed.layers[0].children.map((n) => n.type)], [1, ['group', 'ellipse']]);
  check('a blend mode inside a layer is said', warnings('<rect width="1" height="1"/><rect width="1" height="1" style="mix-blend-mode:multiply"/>').length, 1);
  const { group, warnings: placed } = c.documentAsGroup(c.importSvg(SVG('<rect width="100" height="100" fill="#fff"/><g id="a"><rect width="1" height="1"/></g><g id="b" style="mix-blend-mode:screen"><rect width="1" height="1"/></g>')).doc, 'file');
  check('as a group: the background a rectangle, layers groups', [group.name, group.children.map((n) => [n.type, n.name ?? ''])], ['file', [['rect', 'Фон'], ['group', 'a'], ['group', 'b']]]);
  check('and the lost blend said', placed.length, 1);
}

// ---- Texts
{
  const t = first('<text x="10" y="20" font-size="12" text-anchor="middle" letter-spacing="1" fill="red" font-family="Inter, sans-serif">  Hello\n   world  </text>');
  check('a text in the built-in font', [t.type, t.text, t.x, t.y, t.size, t.align, t.letterSpacing, t.font, t.fill.color], ['text', 'Hello world', 10, 20, 12, 'middle', 1, 'inter', '#ff0000']);
  const lines = c.importSvg(
    SVG('<text xml:space="preserve" style="font-size:10px;font-family:Inter"><tspan sodipodi:role="line" x="5" y="15">One</tspan><tspan sodipodi:role="line" x="5" y="27">Two</tspan><tspan x="5" y="39">Three</tspan></text>', 'xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" viewBox="0 0 100 100"'),
  );
  const l = lines.doc.layers[0].children[0];
  check('Inkscape lines: one text, its line height from the baselines', [l.text, l.x, l.y, l.lineHeight], ['One\nTwo\nThree', 5, 15, 1.2]);
  check('in Inter: nothing to warn about', lines.warnings, []);
  check('another font, bold, said', warnings('<text y="10" font-family="Arial" font-weight="bold">A</text>'), ['Тексты набраны встроенным шрифтом Inter вместо «Arial».', 'Полужирное начертание текста не перенесено: Inter встроен только обычный.']);
  check('nothing for an empty text', nodes('<text x="1" y="1">   </text>'), []);
}

// ---- What the model has no place for
{
  const gradient = c.importSvg(SVG('<linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><rect width="1" height="1" fill="url(#g)"/>'));
  check('a gradient: its average colour', gradient.doc.layers[0].children[0].fill, { color: '#808080', opacity: 0.5 });
  check('and said', gradient.warnings.length, 1);
  check('url() with a fallback colour', first('<rect width="1" height="1" fill="url(#none) red"/>').fill.color, '#ff0000');
  const said = warnings('<image href="x.png" width="1" height="1"/><rect width="1" height="1" clip-path="url(#c)" stroke="red" stroke-dasharray="2 2"/><path d="M0 0L5 5" stroke="red" marker-end="url(#m)"/>');
  check('images, clipping, dashes, markers: each said', said.length, 4);
  check('the same warning once, counted', warnings('<rect width="1" height="1" filter="url(#f)"/><rect width="1" height="1" filter="url(#f)"/>'), ['Фильтры (filter) не поддерживаются: нарисовано без них. (×2)']);
  // Illustrator writes stroke-miterlimit="10" everywhere; it matters only for corners
  // sharp enough for 4 and 10 to cut differently.
  check('miterlimit: right angles and smooth curves are the same at any limit', warnings('<path d="M0 0L10 0L10 10Z" stroke="red" stroke-miterlimit="10"/><rect width="5" height="5" stroke="red" stroke-miterlimit="10"/>'), []);
  check('miterlimit: a 20° corner is cut at 4 and not at 10', warnings('<path d="M0 0L100 0L0 36" stroke="red" stroke-miterlimit="10"/>').length, 1);
}

// ---- Files that are not SVG, and files that are
{
  const refuse = (text) => {
    try {
      c.importSvg(text);
      return null;
    } catch (error) {
      return error instanceof c.SvgImportError;
    }
  };
  check('not XML', refuse('<svg><rect></svg>'), true);
  check('XML, not SVG', refuse('<html/>'), true);
  const illustrator = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 27.0.0 -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
  <!ENTITY ns_svg "http://www.w3.org/2000/svg">
  <!ENTITY fill "#FF0000">
]>
<svg version="1.1" id="Layer_1" xmlns="&ns_svg;" x="0px" y="0px" viewBox="0 0 50 50" style="enable-background:new 0 0 50 50;" xml:space="preserve">
<style type="text/css">
  <![CDATA[ .st0{fill:&fill;} ]]>
</style>
<g id="Layer_1" data-name="Layer 1"><rect class="st0" width="10" height="10"/><path style="fill:&fill;" d="M0,0h5v5z"/></g>
</svg>`;
  const ai = c.importSvg(illustrator);
  check('Illustrator: entities, CDATA, a layer named by data-name', [ai.doc.layers[0].name, ai.doc.layers[0].children.map((n) => n.fill?.color)], ['Layer 1', ['#000000', '#ff0000']]);
  check('entities are not expanded inside CDATA', ai.warnings, []);
  const xml = c.parseXml('<a x="1 &amp; &#x41;&#66;"><b/>t<!-- c --><![CDATA[<x>]]></a>');
  check('XML: attributes, entities, children, CDATA', [xml.attrs.x, xml.children.length, xml.children[2]], ['1 & AB', 3, '<x>']);
}

done('svg import');
