/**
 * SVG export, compared as text: each shape's element, attributes only where they differ
 * from SVG's defaults, rounding, hidden things left out, layers with their blend.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checker, load, root } from '../tools/load.mjs';

const c = await load('core/svg.ts', 'core/serialize.ts', 'core/shapes.ts', 'core/document.ts');
const { check, done } = checker();

check('numbers', ['0.1', '0.3', '12', '0', '-2.5', '1000000'].join(), [c.fmt(0.1), c.fmt(0.1 + 0.2), c.fmt(12.0004), c.fmt(-0.0001), c.fmt(-2.5), c.fmt(1e6)].join());
check('path data', c.pathData([['M', 0, 0], ['L', 1.23456, 2], ['Q', 1, 2, 3, 4], ['C', 1, 2, 3, 4, 5, 6], ['Z']]), 'M0 0L1.235 2Q1 2 3 4C1 2 3 4 5 6Z');

// Every element, on a transparent page.
{
  const doc = c.createDocument(100, 50, null, 'One');
  doc.layers[0].id = 'one';
  const plain = { fill: { color: '#112233', opacity: 1 }, stroke: null };
  const r = c.makeRect(1, 2, 30, 20, plain, 'r');
  r.rx = 4;
  r.opacity = 0.5;
  r.transform = [1, 0, 0, 1, 5, 6];
  const e = c.makeEllipse(50, 25, 10, 10, { fill: null, stroke: { color: '#ff0000', opacity: 0.25, width: 1, cap: 'round', join: 'bevel' } }, 'e');
  const o = c.makeEllipse(50, 25, 20, 10, plain, 'o');
  o.transform = [0, 1, -1, 0, 75, -25];
  const l = c.makeLine(0, 0, 100, 50, { fill: plain.fill, stroke: { color: '#000000', opacity: 1, width: 3, cap: 'square', join: 'miter' } }, 'l');
  const p = c.makePath([['M', 0, 0], ['L', 10, 0], ['L', 5, 8], ['Z']], { fill: { color: '#00ff00', opacity: 0.333333 }, stroke: null }, 'p');
  p.fillRule = 'evenodd';
  const hidden = c.makeRect(0, 0, 1, 1, plain, 'h');
  hidden.visible = false;
  const g = c.makeGroup([p, hidden], 'g');
  g.opacity = 0.75;
  g.transform = [2, 0, 0, 2, 0, 0];
  doc.layers[0].children.push(r, e, o, l, g);
  const off = c.createLayer('Off', 'off');
  off.visible = false;
  off.children.push(c.makeRect(0, 0, 10, 10, plain, 'x'));
  const top = c.createLayer('Top & "quoted"', 'top');
  top.blend = 'screen';
  top.opacity = 0.4;
  doc.layers.push(off, top);
  const { text, warnings } = c.exportSvg(doc);
  check(
    'all the shapes',
    text,
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50">
  <g id="one" data-name="One">
    <rect x="1" y="2" width="30" height="20" rx="4" fill="#112233" transform="translate(5 6)" opacity="0.5"/>
    <circle cx="50" cy="25" r="10" fill="none" stroke="#ff0000" stroke-opacity="0.25" stroke-linecap="round" stroke-linejoin="bevel"/>
    <ellipse cx="50" cy="25" rx="20" ry="10" fill="#112233" transform="matrix(0 1 -1 0 75 -25)"/>
    <line x1="0" y1="0" x2="100" y2="50" stroke="#000000" stroke-width="3" stroke-linecap="square"/>
    <g transform="matrix(2 0 0 2 0 0)" opacity="0.75">
      <path d="M0 0L10 0L5 8Z" fill-rule="evenodd" fill="#00ff00" fill-opacity="0.333"/>
    </g>
  </g>
  <g id="top" data-name="Top &amp; &quot;quoted&quot;" opacity="0.4" style="mix-blend-mode:screen"/>
</svg>
`,
  );
  check('nothing to warn about', warnings, []);
}

// The showcase the browser tests compare against the renderer.
{
  const doc = c.parseDocument(await readFile(join(root, 'tests/fixtures/showcase.vector.json'), 'utf8'));
  check(
    'the showcase',
    c.exportSvg(doc).text,
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320">
  <rect width="480" height="320" fill="#ffffff"/>
  <g id="base" data-name="Base">
    <rect x="20" y="20" width="200" height="120" rx="16" fill="#4f8ef7" stroke="#1d2433" stroke-width="4"/>
    <rect width="120" height="60" fill="#f5b942" stroke="#333333" stroke-width="6" transform="matrix(0.939693 0.34202 -0.34202 0.939693 300 40)"/>
    <ellipse cx="120" cy="230" rx="80" ry="45" fill="#36c28a" stroke="#0b5d3b" stroke-width="3" opacity="0.8"/>
    <circle cx="410" cy="250" r="50" fill="#e5484d"/>
    <path d="M250 150C290 100 380 100 420 150L440 230Q350 310 260 230ZM310 165L380 165L380 215L310 215Z" fill-rule="evenodd" fill="#8e4ec6" fill-opacity="0.9" stroke="#2b1640" stroke-width="3" stroke-linejoin="round"/>
    <g transform="matrix(0.984808 -0.173648 0.173648 0.984808 30 170)" opacity="0.6">
      <rect width="70" height="50" fill="#ff3b8d"/>
      <rect x="40" y="25" width="70" height="50" fill="#3bd4ff"/>
    </g>
    <line x1="20" y1="300" x2="230" y2="170" stroke="#6e56cf" stroke-width="8" stroke-linecap="round"/>
  </g>
  <g id="overlay" data-name="Overlay" opacity="0.9" style="mix-blend-mode:multiply">
    <rect x="150" y="90" width="180" height="120" fill="#ff8a00"/>
    <path d="M40 60L90 120L140 60L190 120" fill="none" stroke="#204060" stroke-width="10" stroke-linecap="square" stroke-linejoin="bevel"/>
  </g>
  <g id="glow" data-name="Glow" style="mix-blend-mode:screen">
    <ellipse cx="440" cy="50" rx="60" ry="40" fill="#2050ff"/>
  </g>
</svg>
`,
  );
}

done('svg');
