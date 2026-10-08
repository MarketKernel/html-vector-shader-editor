/**
 * Drives the built page in headless Chrome: shapes drawn with every tool, moved, scaled,
 * rotated, restyled and grouped, then undone to an empty document and redone; layers
 * created, renamed, reordered, hidden, faded and blended; a file saved and opened again;
 * texts typed, edited, restyled and set in a font dropped on the window; and the three
 * renderings compared — the PNG export against the SVG export drawn by the
 * browser, and against the exported GLSL shader compiled on its own; an SVG imported and
 * drawn as the browser draws the file; then the PWA of build/pages/ over HTTP, offline
 * from its service worker.
 *
 * Needs `npm run build` first and a local Chrome (or `CHROME=/path/to/chrome`). No
 * dependencies beyond Node: the DevTools protocol is spoken over the built-in WebSocket.
 * WebGL runs on SwiftShader, so the pictures do not depend on the machine's GPU.
 *
 * `--shots DIR` also saves screenshots of the main screen, the export dialog and a narrow
 * window into DIR.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checker, load, root } from '../tools/load.mjs';

const APP = join(root, 'build', 'vector.html');
const PAGES = join(root, 'build', 'pages');
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
const CHROME =
  process.env.CHROME ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((path) => existsSync(path));

// The pictures may differ only along edges, where the three rasterizers antialias each
// in their own way: at most this share of pixels may be off by more than TOLERANCE / 255
// in any premultiplied channel. Shapes, colours, order and blending must all agree for
// that to hold. The PNG and the shader share the SDF code, so they must agree closely.
const TOLERANCE = 32;
const SVG_SHARE = 0.005;
const GLSL_SHARE = 0.001;

if (!CHROME) {
  console.log('No Chrome found — set CHROME=/path/to/chrome. Skipping the browser tests.');
  process.exit(0);
}
if (typeof WebSocket === 'undefined') {
  console.error('Run with `node --experimental-websocket` on Node 20.');
  process.exit(1);
}
if (!existsSync(APP)) {
  console.error('No build/vector.html: run `npm run build` first.');
  process.exit(1);
}

const { check, ok, done } = checker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// build/pages/ over HTTP, as GitHub Pages serves it; `pagesDown` plays the network gone.
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
let pagesDown = false;
const server = createServer(async (req, res) => {
  if (pagesDown) return req.socket.destroy();
  const path = new URL(req.url, 'http://localhost').pathname;
  const name = path.endsWith('/') ? 'index.html' : basename(path);
  try {
    const body = await readFile(join(PAGES, name));
    res.setHeader('content-type', TYPES[extname(name)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const profile = await mkdtemp(join(tmpdir(), 'vector-chrome-'));
const flags = [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--window-size=1280,820',
  '--hide-scrollbars',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--allow-file-access-from-files',
];
// WebGPU in headless Chrome: on SwiftShader too, so the pictures stay the machine's own.
// Not on CI: a GitHub runner's Chrome on Linux gives an adapter now and then and loses its
// device in the middle of a run, so there the page draws with WebGL 2, as it does in a
// browser without WebGPU, and the WebGPU and WGSL checks are skipped.
if (!process.env.CI) flags.push('--enable-unsafe-webgpu');
if (process.platform === 'linux') flags.push('--no-sandbox');
const chrome = spawn(CHROME, [...flags, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve) => {
  let buf = '';
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
    if (m) resolve(m[1]);
  });
});
const debugPort = new URL(wsUrl).port;
const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const waiting = new Map();
const errors = [];
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    errors.push(msg.params.entry.text);
  } else if (msg.method === 'Page.javascriptDialogOpening') {
    send('Page.handleJavaScriptDialog', { accept: true });
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expr}\n${r.exceptionDetails.exception?.description ?? 'eval failed'}`);
  return r.result.value;
};
const shot = async (name) => {
  if (!SHOTS) return;
  await sleep(200);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
};

const MOD = process.platform === 'darwin' ? 4 : 2;
const ALT = 1;
const SHIFT = 8;
const KEYS = {
  Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13 },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  '[': { code: 'BracketLeft', windowsVirtualKeyCode: 219 },
  ']': { code: 'BracketRight', windowsVirtualKeyCode: 221 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
};
const press = async (key, modifiers = 0) => {
  const k = KEYS[key] ?? { code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, modifiers, ...k });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers, ...k });
  await sleep(30);
};
const click = async (selector, clickCount = 1) => {
  const box = await evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; const r = n.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (!box) throw new Error(`Nothing to click: ${selector}`);
  for (let i = 1; i <= clickCount; i++)
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box[0], y: box[1], button: 'left', clickCount: i });
  await sleep(50);
};
// Document coordinates to the window's.
const screen = (x, y) => evaluate(`(() => { const r = vector.app.view.overlay.getBoundingClientRect(); const p = vector.app.view.toScreen(${x}, ${y}); return [r.left + p.x, r.top + p.y]; })()`);
const drag = async (points, { modifiers = 0 } = {}) => {
  const at = [];
  for (const [x, y] of points) at.push(await screen(x, y));
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0][0], y: at[0][1], modifiers });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at[0][0], y: at[0][1], button: 'left', buttons: 1, clickCount: 1, modifiers });
  for (const [x, y] of at.slice(1)) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, modifiers });
    await sleep(8);
  }
  const [x, y] = at[at.length - 1];
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers });
  await sleep(40);
};
const clickAt = (x, y, opts) => drag([[x, y]], opts);
// The same in window coordinates.
const dragScreen = async (at, modifiers = 0) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0][0], y: at[0][1], modifiers });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at[0][0], y: at[0][1], button: 'left', buttons: 1, clickCount: 1, modifiers });
  for (const [x, y] of at.slice(1)) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, modifiers });
    await sleep(8);
  }
  const [x, y] = at[at.length - 1];
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers });
  await sleep(40);
};
// A point of the selection's frame (unit square coordinates), in window coordinates.
const framePoint = (u, v) =>
  evaluate(`(() => { const f = vector.frame(); const r = vector.app.view.overlay.getBoundingClientRect(); const p = vector.app.view.toScreen(f[0] * ${u} + f[2] * ${v} + f[4], f[1] * ${u} + f[3] * ${v} + f[5]); return [r.left + p.x, r.top + p.y]; })()`);
// Sets a properties-panel field as typing into it and pressing Enter would.
const setField = (label, value, section = null) =>
  evaluate(`(() => {
    const sections = [...document.querySelectorAll('#properties .props')].filter((s) => ${JSON.stringify(section)} === null || s.querySelector('.props-title').textContent === ${JSON.stringify(section)});
    for (const s of sections) for (const p of s.querySelectorAll('.prop')) {
      const l = p.querySelector('label');
      if (!l || l.textContent.trim() !== ${JSON.stringify(label)}) continue;
      const input = p.querySelector('input[type=number], input[type=text], select, input[type=checkbox]');
      if (input.type === 'checkbox') input.checked = ${JSON.stringify(value)};
      else input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  })()`);
const node = (i, layer = 0) => evaluate(`vector.doc().layers[${layer}].children[${i}]`);
const children = (layer = 0) => evaluate(`vector.doc().layers[${layer}].children.map((n) => n.type)`);
// Waits for a condition rather than for a while: CI machines are several times slower.
const until = async (expr, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    if (await evaluate(expr).catch(() => false)) return true;
  }
  return false;
};
const round = (v) => (Array.isArray(v) ? v.map(round) : Math.round(v * 100) / 100);

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: pathToFileURL(APP).href });
  await sleep(800);
  await evaluate('vector.app.view.ready');

  check('starts with an empty document', await evaluate(`[vector.doc().width, vector.doc().height, vector.doc().layers.length, vector.doc().layers[0].children.length]`), [800, 600, 1, 0]);
  // navigator.gpu alone says little: Chrome on Linux has it and still gives no adapter.
  const gpu = await evaluate('navigator.gpu?.requestAdapter().then((adapter) => !!adapter) ?? false');
  check('draws with WebGPU where there is one, else WebGL 2', await evaluate(`!vector.app.view.error && vector.app.view.renderer?.kind`), gpu ? 'webgpu' : 'webgl2');
  if (!gpu) console.log(`  No WebGPU ${process.env.CI ? 'on CI' : 'adapter in this Chrome'}: its renderer and the WGSL export are not tested.`);
  check('the status bar says which', await evaluate(`document.querySelector('.status-renderer').textContent`), gpu ? 'WebGPU' : 'WebGL 2');
  const noGl = await evaluate(`(async () => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = () => null;
    const ws = document.createElement('section');
    const c = document.createElement('canvas');
    ws.append(c);
    document.body.append(ws);
    try {
      await new vector.View(ws, c).ready;
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
    }
    const text = ws.querySelector('.view-error')?.textContent ?? '';
    ws.remove();
    return text;
  })()`);
  ok(`without WebGPU or WebGL 2, a message instead of a blank canvas: "${noGl.slice(0, 40)}…"`, noGl.startsWith('Ни WebGPU, ни WebGL 2 недоступны'));
  check('menus', await evaluate(`[...document.querySelectorAll('.menu-button')].map((b) => b.textContent)`), ['Файл', 'Правка', 'Вид', 'Слой']);
  check('eight tools', await evaluate(`[...document.querySelectorAll('.tool')].map((b) => b.dataset.tool)`), ['select', 'rect', 'ellipse', 'line', 'pen', 'text', 'zoom', 'pan']);
  await shot('empty');
  const empty = await evaluate('vector.canonical()');

  // ---- 1. Drawing, transforming, restyling and grouping; then all undone and redone
  await press('r');
  check('R is the rectangle', await evaluate('vector.app.tool.id'), 'rect');
  await drag([[100, 100], [180, 160], [250, 200]]);
  await press('e');
  await drag([[400, 300], [500, 380]], { modifiers: SHIFT });
  await press('l');
  await drag([[100, 400], [300, 420]], { modifiers: SHIFT });
  await press('p');
  await clickAt(500, 100);
  await drag([[650, 150], [700, 200]]);
  await clickAt(560, 250);
  await clickAt(500, 100);
  check('four shapes drawn', await children(), ['rect', 'ellipse', 'line', 'path']);
  // Esc drops a path half drawn; Alt draws a rectangle from its centre (undone after).
  await clickAt(300, 500);
  await clickAt(350, 520);
  await press('Escape');
  check('Esc drops the pen path', (await children()).length, 4);
  await press('r');
  await drag([[700, 500], [720, 530]], { modifiers: ALT });
  const centred = await node(4);
  check('Alt draws from the centre', round([centred.x, centred.y, centred.width, centred.height]), [680, 470, 40, 60]);
  await press('z', MOD);
  check('and undo takes it away', (await children()).length, 4);
  const rect = await node(0);
  check('the rectangle where it was dragged', round([rect.x, rect.y, rect.width, rect.height]), [100, 100, 150, 100]);
  const circle = await node(1);
  check('Shift makes a circle', round([circle.rx, circle.ry]), [100, 100].map((v) => v / 2 + 0));
  const line = await node(2);
  check('Shift snaps the line to 0°', round([line.y1, line.y2]), [400, 400]);
  const pen = await node(3);
  check('the pen path: corner, smooth, corner, closed by Z', pen.segments.map((s) => s[0]), ['M', 'C', 'C', 'Z']);
  check('a closed path keeps its fill', !!pen.fill, true);
  check('new shapes are selected', await evaluate('vector.app.selection.length'), 1);

  await press('v');
  await clickAt(120, 120);
  check('a click selects the rectangle', await evaluate('vector.app.selection'), [rect.id]);
  await drag([[150, 150], [170, 160], [180, 170]]);
  check('dragged by (30, 20)', round([(await node(0)).x, (await node(0)).y]), [130, 120]);
  const steps = await evaluate('vector.app.history.size');
  const zoom = await evaluate('vector.app.view.zoom');
  const handle = await framePoint(1, 1);
  await dragScreen([handle, [handle[0] + 25 * zoom, handle[1] + 20 * zoom], [handle[0] + 50 * zoom, handle[1] + 40 * zoom]]);
  const scaled = await node(0);
  check('the corner handle scales the sides', round([scaled.x, scaled.y, scaled.width, scaled.height]), [130, 120, 200, 140]);
  check('one step for the whole drag', await evaluate('vector.app.history.size'), steps + 1);
  const corner = await framePoint(1, 0);
  const centre = await framePoint(0.5, 0.5);
  const from = [corner[0] + 8, corner[1] - 8];
  const angle = Math.atan2(from[1] - centre[1], from[0] - centre[0]) + Math.PI / 2;
  const radius = Math.hypot(from[0] - centre[0], from[1] - centre[1]);
  await dragScreen([from, [centre[0] + radius * Math.cos(angle - 0.3), centre[1] + radius * Math.sin(angle - 0.3)], [centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)]], SHIFT);
  const turned = await node(0);
  check('outside a corner rotates, Shift by 15° steps: 90°', round(turned.transform.slice(0, 4)), [0, 1, -1, 0]);
  check('the sides untouched by rotating', round([turned.width, turned.height]), [200, 140]);

  check('fill colour from the panel', await setField('Цвет', '#ff0000', 'Заливка') && (await node(0)).fill.color, '#ff0000');
  check('stroke width from the panel', await setField('Толщина', '5') && (await node(0)).stroke.width, 5);
  check('stroke join from the panel', await setField('Углы', 'round') && (await node(0)).stroke.join, 'round');
  check('no fill', await setField('Заливка', false, 'Заливка') && (await node(0)).fill, null);
  check('X from the panel', await setField('X', '20') && round((await evaluate('vector.frame()'))[4]), 20);

  await press('a', MOD);
  check('select all', await evaluate('vector.app.selection.length'), 4);
  await press('g', MOD);
  check('grouped into one', await children(), ['group']);
  check('four inside', (await node(0)).children.length, 4);
  const groupId = (await node(0)).id;
  const inside = await screen(450, 340);
  for (const clickCount of [1, 2])
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: inside[0], y: inside[1], button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount });
  await sleep(60);
  check('a double click enters the group', await evaluate('vector.app.context'), groupId);
  check('and picks the shape in it', await evaluate(`vector.app.selection.map((id) => vector.doc().layers[0].children[0].children.find((n) => n.id === id)?.type)`), ['ellipse']);
  await press('Escape');
  await press('Escape');
  check('Esc twice: deselected, then out of the group', await evaluate('[vector.app.selection.length, vector.app.context]'), [0, null]);
  await press(']', MOD | ALT);
  const full = await evaluate('vector.canonical()');
  const total = await evaluate('vector.app.history.size');
  ok(`a step for each change (${total})`, total >= 12);
  while (await evaluate('vector.app.history.canUndo')) await press('z', MOD);
  check('undone to the empty document', await evaluate('vector.canonical()'), empty);
  while (await evaluate('vector.app.history.canRedo')) await press('z', MOD | SHIFT);
  check('redone to the same model', await evaluate('vector.canonical()'), full);

  // Ungroup, reorder, duplicate, delete, nudge, through the shortcuts.
  await clickAt(510, 120);
  await press('g', MOD | SHIFT);
  check('ungrouped', await children(), ['rect', 'ellipse', 'line', 'path']);
  await press('Escape');
  check('Esc deselects', await evaluate('vector.app.selection'), []);
  await clickAt(450, 340);
  check('the circle picked', await evaluate('vector.app.selection.map((id) => vector.doc().layers[0].children.find((n) => n.id === id).type)'), ['ellipse']);
  await press(']', MOD | ALT);
  check('to the front', await children(), ['rect', 'line', 'path', 'ellipse']);
  await press('[', MOD);
  check('one back', await children(), ['rect', 'line', 'ellipse', 'path']);
  await press('d', MOD);
  check('duplicated above', await children(), ['rect', 'line', 'ellipse', 'ellipse', 'path']);
  await press('ArrowRight', SHIFT);
  check('nudged 10 px', round((await node(3)).cx - (await node(2)).cx), 20);
  await press('Delete');
  check('deleted', await children(), ['rect', 'line', 'ellipse', 'path']);
  await press('c', MOD);
  await press('v', MOD);
  check('nothing to paste without a selection copied', (await children()).length, 4);

  // ---- 2. Layers
  await click('[data-command="layer-new"]');
  check('a new layer on top, active', await evaluate('[vector.doc().layers.length, vector.app.layer.name]'), [2, 'Слой 2']);
  await click('.layer--active .layer-name', 2);
  await evaluate(`(() => { const i = document.querySelector('.layer-rename'); i.value = 'Тени'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  check('renamed by a double click', await evaluate('vector.doc().layers[1].name'), 'Тени');
  await press('r');
  await drag([[600, 400], [700, 500]]);
  check('drawn on the active layer', await evaluate('vector.doc().layers[1].children.length'), 1);
  await click('[data-command="layer-down"]');
  check('moved down', await evaluate('vector.doc().layers.map((l) => l.name)'), ['Тени', 'Слой 1']);
  // Dragged back up in the list: dropped on the upper half of the top row.
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.layer')];
    const dt = new DataTransfer();
    const at = (row, y) => ({ bubbles: true, cancelable: true, dataTransfer: dt, clientX: row.getBoundingClientRect().left + 40, clientY: y });
    const from = rows[1], to = rows[0], r = to.getBoundingClientRect();
    from.dispatchEvent(new DragEvent('dragstart', at(from, from.getBoundingClientRect().top + 5)));
    to.dispatchEvent(new DragEvent('dragover', at(to, r.top + 3)));
    to.dispatchEvent(new DragEvent('drop', at(to, r.top + 3)));
    from.dispatchEvent(new DragEvent('dragend', at(from, r.top + 3)));
  })()`);
  check('dragged back to the top', await evaluate('vector.doc().layers.map((l) => l.name)'), ['Слой 1', 'Тени']);
  await click('.layer[data-layer="' + (await evaluate('vector.doc().layers[1].id')) + '"] [data-toggle="visible"]');
  check('hidden by its eye', await evaluate('vector.doc().layers[1].visible'), false);
  await click('.layer--active [data-toggle="visible"]');
  check('shown again', await evaluate('vector.doc().layers[1].visible'), true);
  await press('Escape');
  await evaluate('vector.app.select([])');
  check('layer opacity', (await setField('Непрозрачность', '40', 'Слой')) && (await evaluate('vector.doc().layers[1].opacity')), 0.4);
  check('layer blend', (await setField('Наложение', 'multiply', 'Слой')) && (await evaluate('vector.doc().layers[1].blend')), 'multiply');
  await click('[data-command="layer-duplicate"]');
  check('duplicated', await evaluate('vector.doc().layers.map((l) => l.name)'), ['Слой 1', 'Тени', 'Тени (копия)']);
  await click('[data-command="layer-delete"]');
  check('deleted', await evaluate('vector.doc().layers.length'), 2);
  await press('z', MOD);
  check('undo brings it back', await evaluate('vector.doc().layers.length'), 3);
  await press('z', MOD | SHIFT);
  check('layer menu commands are in the menu', await evaluate(`vector.app && [...document.querySelectorAll('.menu-button')].length`), 4);
  // Move a shape to the other layer through the command. The dialog opens at once, the move
  // comes after its close event: wait for the command, not for a while — a slow CI machine
  // took longer than any pause chosen here.
  await evaluate(`vector.app.select([vector.doc().layers[0].children[0].id])`);
  await evaluate(`(async () => {
    const done = vector.run('move-to-layer');
    document.querySelector('dialog select').value = vector.doc().layers[1].id;
    document.querySelector('dialog .button--primary').click();
    await done;
  })()`);
  check('moved to the other layer', await evaluate('[vector.doc().layers[0].children.length, vector.doc().layers[1].children.length]'), [3, 2]);

  // ---- 3. Saved and opened again
  const json = await evaluate('vector.json()');
  const before = await evaluate('vector.canonical()');
  check('opens what it saved', await evaluate(`vector.open(${JSON.stringify(json)})`), true);
  check('the same document', await evaluate('vector.canonical()'), before);
  check('a fresh history', await evaluate('vector.app.history.size'), 0);
  // Dropped on the window as a file.
  await evaluate(`vector.open(JSON.stringify({ version: 1, width: 10, height: 10, background: null, layers: [{ id: 'x', name: 'x', children: [] }] }))`);
  await evaluate(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(json)}], 'dropped.vector.json', { type: 'application/json' }));
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  })()`);
  await until(`vector.app.fileName === 'dropped'`);
  check('a dropped file opens', await evaluate('vector.canonical()'), before);
  check('named after the file', await evaluate('vector.app.fileName'), 'dropped');
  // Kept in IndexedDB while unsaved, and offered back after a reload.
  await press('a', MOD);
  await press('Delete');
  const edited = await evaluate('vector.canonical()');
  await sleep(1200);
  await send('Page.reload');
  await until(`document.querySelector('dialog h2')?.textContent === 'Восстановить документ?'`);
  check('offers the unsaved document back', await evaluate(`document.querySelector('dialog h2')?.textContent`), 'Восстановить документ?');
  await evaluate(`document.querySelector('dialog .button--primary').click()`);
  await until(`vector.canonical() === ${JSON.stringify(edited)}`);
  check('restored', await evaluate('vector.canonical()'), edited);
  check('and still unsaved', await evaluate('vector.app.history.dirty'), true);

  // ---- 4. Text: typed on the canvas, edited, restyled, set in a font of its own
  await evaluate(`vector.open(JSON.stringify({ version: 2, width: 600, height: 400, background: '#ffffff', fonts: [], layers: [{ id: 'words', name: 'Слой 1', children: [] }] }))`);
  await press('t');
  check('T is the text tool', await evaluate('vector.app.tool.id'), 'text');
  await clickAt(40, 40);
  ok('a click starts a text, the keys go to it', await evaluate(`document.activeElement?.classList.contains('text-input') && vector.editing()?.id === null`));
  await send('Input.insertText', { text: 'Привет, AV' });
  await send('Input.insertText', { text: '\n' });
  await send('Input.insertText', { text: 'Мир' });
  check('typed into a draft, nothing committed yet', [await evaluate('vector.editing().text'), (await children()).length], ['Привет, AV\nМир', 0]);
  await shot('text-editing');
  await press('Escape');
  check('Esc commits the text', await children(), ['text']);
  const typed = await node(0);
  check('with what was typed, in the built-in font', [typed.text, typed.font, typed.size], ['Привет, AV\nМир', 'inter', 32]);
  check('Esc goes back to selecting, the text selected', [await evaluate('vector.app.tool.id'), await evaluate('vector.app.selection')], ['select', [typed.id]]);
  check('one step', await evaluate('vector.app.history.size'), 1);
  const typedFrame = await evaluate('vector.frame()');
  ok(`its frame is two lines high (${round(typedFrame[3])})`, typedFrame[3] > 2 * 32 && typedFrame[3] < 3 * 32);
  ok('the first line starts where it was clicked', Math.abs(typedFrame[4] - 40) < 0.01 && Math.abs(typedFrame[5] - 40) < 0.01);
  await press('z', MOD);
  check('undo takes the text away', (await children()).length, 0);
  await press('z', MOD | SHIFT);
  check('redo brings it back', (await node(0)).text, 'Привет, AV\nМир');
  // A double click with the select tool edits it, the caret where the click was.
  const word = await screen(60, 55);
  for (const clickCount of [1, 2])
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: word[0], y: word[1], button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount });
  await sleep(60);
  check('a double click edits the text', await evaluate('vector.editing()?.id'), typed.id);
  await evaluate(`document.querySelector('.text-input').setSelectionRange(6, 6)`);
  await send('Input.insertText', { text: ' мой' });
  await press('Escape');
  check('edited in place', (await node(0)).text, 'Привет мой, AV\nМир');
  check('the edit is one more step', await evaluate('vector.app.history.size'), 2);
  check('size from the panel', (await setField('Размер', '48', 'Шрифт')) && (await node(0)).size, 48);
  check('alignment from the panel', (await setField('Выравнивание', 'middle', 'Шрифт')) && (await node(0)).align, 'middle');
  await evaluate(`vector.app.apply(vector.transform([${JSON.stringify(typed.id)}], [2, 0, 0, 2, -40, -40]))`);
  const doubled = await node(0);
  check('scaled the same both ways: into its size, not its matrix', [doubled.size, doubled.transform], [96, [1, 0, 0, 1, 0, 0]]);
  await evaluate(`vector.app.apply(vector.transform([${JSON.stringify(typed.id)}], [0, 1, -1, 0, 400, 0]))`);
  check('turned: into its matrix', round((await node(0)).transform.slice(0, 4)), [0, 1, -1, 0]);
  await press('z', MOD);
  await press('z', MOD);
  // A font dropped on the window: carried by the document, set on the selected text.
  const cffFont = (await readFile(join(root, 'tests/fixtures/inter-cff-test.otf'))).toString('base64');
  await evaluate(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(cffFont)}), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'InterCFFTest.otf', { type: 'font/otf' }));
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  })()`);
  await until('vector.doc().fonts.length > 0');
  const fonts = await evaluate('vector.doc().fonts.map((f) => [f.family, f.style])');
  check('the dropped font is in the document', fonts, [['Inter CFF Test', 'Regular']]);
  check('and the text is set in it', (await node(0)).font, await evaluate('vector.doc().fonts[0].id'));
  check('the font list offers it', await evaluate(`[...document.querySelectorAll('#properties select option')].map((o) => o.textContent).filter((t) => t.startsWith('Inter'))`), ['Inter Regular', 'Inter CFF Test Regular']);
  await press('z', MOD);
  check('undo: the old font, and the document without the new one', [(await node(0)).font, await evaluate('vector.doc().fonts.length')], ['inter', 0]);
  await press('z', MOD | SHIFT);
  const withFont = await evaluate('vector.canonical()');
  check('saved with its font and opened again, the same', await evaluate(`vector.open(vector.json())`) && (await evaluate('vector.canonical()')), withFont);
  // Copied into another document, the text brings its font along.
  await evaluate(`vector.app.select([vector.doc().layers[0].children[0].id])`);
  await press('c', MOD);
  await evaluate(`vector.open(JSON.stringify({ version: 2, width: 300, height: 200, background: null, fonts: [], layers: [{ id: 'other', name: 'Other', children: [] }] }))`);
  await press('v', MOD);
  check('pasted into another document, with its font', [await children(), await evaluate('vector.doc().fonts.length')], [['text'], 1]);
  check('which then saves and opens', await evaluate(`vector.open(vector.json())`), true);

  // ---- The three renderings of the showcase document
  const showcase = await readFile(join(root, 'tests/fixtures/showcase.vector.json'), 'utf8');
  check('opens the showcase', await evaluate(`vector.open(${JSON.stringify(showcase)}, 'showcase.vector.json')`), true);
  const compare = async (a, b, name, share) => {
    const r = await evaluate(`(async () => vector.diff(await ${a}, await ${b}, ${TOLERANCE}))()`);
    console.log(`  ${name}: ${(r.fraction * 100).toFixed(3)} % of pixels off by more than ${TOLERANCE} (${r.count}), worst ${r.max}`);
    ok(`${name} within ${share * 100} %`, r.fraction <= share);
    return r;
  };
  await compare('vector.images.png(1)', 'vector.images.svg()', 'PNG against SVG', SVG_SHARE);
  if (SHOTS) {
    // The three pictures side by side, and where the SVG differs, for a look by eye.
    const strip = await evaluate(`(async () => {
      const png = await vector.images.png(1), svg = await vector.images.svg(), glsl = vector.images.glsl();
      const w = png.width, h = png.height;
      const c = document.createElement('canvas'); c.width = w * 4; c.height = h;
      const ctx = c.getContext('2d');
      ctx.putImageData(png, 0, 0); ctx.putImageData(svg, w, 0); ctx.putImageData(glsl, 2 * w, 0);
      const d = new ImageData(w, h);
      for (let i = 0; i < png.data.length; i += 4) {
        let m = 0;
        for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(png.data[i + k] - svg.data[i + k]));
        d.data[i] = m > ${TOLERANCE} ? 255 : m * 4; d.data[i + 1] = m > ${TOLERANCE} ? 0 : m * 4; d.data[i + 2] = m > ${TOLERANCE} ? 0 : m * 4; d.data[i + 3] = 255;
      }
      ctx.putImageData(d, 3 * w, 0);
      return c.toDataURL('image/png').split(',')[1];
    })()`);
    await writeFile(join(SHOTS, 'compare.png'), Buffer.from(strip, 'base64'));
  }
  await compare('vector.images.png(1)', 'vector.images.glsl()', 'PNG against GLSL', GLSL_SHARE);
  await compare('vector.images.png(1)', 'vector.images.shadertoy()', 'PNG against Shadertoy', GLSL_SHARE);
  // In a wider view the page is centred with its proportions kept, on a dark surround.
  const wide = await evaluate(`(() => { const d = vector.images.shadertoy(undefined, 960, 320); const at = (x, y) => Array.from(d.data.slice((y * 960 + x) * 4, (y * 960 + x) * 4 + 4)); return [at(10, 160), at(950, 160), at(240 + 470, 300)]; })()`);
  check('Shadertoy: the page fitted into a wider view', wide.slice(0, 2), [[31, 31, 31, 255], [31, 31, 31, 255]]);
  check('Shadertoy: and the page itself where it should be', wide[2], await evaluate(`(async () => Array.from((await vector.images.png(1)).data.slice((300 * 480 + 470) * 4, (300 * 480 + 470) * 4 + 4)))()`));
  if (gpu) {
    // The two renderers share the SDF arithmetic line for line (sdf.ts and its WGSL twin)
    // and the blend states; the WGSL export is the renderer's library with constants.
    await compare("vector.images.png(1, 'webgpu')", "vector.images.png(1, 'webgl2')", 'WebGPU against WebGL 2', GLSL_SHARE);
    await compare('vector.images.png(1)', 'vector.images.wgsl()', 'PNG against WGSL', GLSL_SHARE);
  }
  await compare('vector.images.png(2)', 'vector.images.svg(undefined, 2)', 'PNG ×2 against SVG ×2', SVG_SHARE);
  await compare('vector.images.png(2)', 'vector.images.glsl(undefined, 2)', 'PNG ×2 against GLSL ×2', GLSL_SHARE);

  // Texts: the built-in font and one the document carries, kerned, spaced, aligned, in
  // two lines, turned and outlined.
  const textDoc = await readFile(join(root, 'tests/fixtures/text.vector.json'), 'utf8');
  check('opens the texts', await evaluate(`vector.open(${JSON.stringify(textDoc)}, 'text.vector.json')`), true);
  // Small glyphs are mostly edge, where Chrome's area coverage and the shaders' distance
  // ramp part most (at corners and thin stems): at 1× the allowance is doubled.
  await compare('vector.images.png(1)', 'vector.images.svg()', 'texts: PNG against SVG', SVG_SHARE * 2);
  await compare('vector.images.png(1)', 'vector.images.glsl()', 'texts: PNG against GLSL', GLSL_SHARE);
  await compare('vector.images.png(2)', 'vector.images.svg(undefined, 2)', 'texts ×2: PNG against SVG', SVG_SHARE);
  if (gpu) await compare("vector.images.png(1, 'webgpu')", "vector.images.png(1, 'webgl2')", 'texts: WebGPU against WebGL 2', GLSL_SHARE);
  if (SHOTS) {
    await evaluate(`vector.app.select(['lines'])`);
    await evaluate('vector.app.view.render()');
    await shot('text');
  }

  // A transparent page: blending onto nothing, half-transparent fills, a group's opacity.
  const clear = {
    version: 1, width: 200, height: 120, background: null,
    layers: [
      { id: 'a', name: 'A', visible: true, locked: false, opacity: 1, blend: 'normal', children: [
        { id: 'r', type: 'rect', visible: true, locked: false, opacity: 1, transform: [1, 0, 0, 1, 0, 0], fill: { color: '#3366ff', opacity: 0.5 }, stroke: null, x: 10, y: 10, width: 100, height: 60, rx: 8 },
      ] },
      { id: 'b', name: 'B', visible: true, locked: false, opacity: 0.7, blend: 'multiply', children: [
        { id: 'e', type: 'ellipse', visible: true, locked: false, opacity: 1, transform: [1, 0, 0, 1, 0, 0], fill: { color: '#ffaa00', opacity: 1 }, stroke: { color: '#000000', opacity: 0.5, width: 4, cap: 'butt', join: 'miter' }, cx: 110, cy: 60, rx: 60, ry: 40 },
      ] },
      { id: 'c', name: 'C', visible: true, locked: false, opacity: 1, blend: 'screen', children: [
        { id: 'g', type: 'group', visible: true, locked: false, opacity: 0.5, transform: [1, 0, 0, 1, 0, 0], children: [
          { id: 'p', type: 'path', visible: true, locked: false, opacity: 1, transform: [1, 0, 0, 1, 0, 0], fill: { color: '#00cc66', opacity: 1 }, stroke: null, segments: [['M', 120, 20], ['Q', 190, 20, 190, 100], ['L', 120, 100], ['Z']], fillRule: 'nonzero' },
          { id: 'l', type: 'line', visible: true, locked: false, opacity: 1, transform: [1, 0, 0, 1, 0, 0], fill: null, stroke: { color: '#ff0000', opacity: 1, width: 6, cap: 'square', join: 'miter' }, x1: 20, y1: 100, x2: 180, y2: 15 },
        ] },
      ] },
    ],
  };
  await evaluate(`vector.open(${JSON.stringify(JSON.stringify(clear))})`);
  check('a transparent corner stays transparent', await evaluate('(async () => Array.from((await vector.images.png(1)).data.slice(0, 4)))()'), [0, 0, 0, 0]);
  const half = await evaluate('(async () => Array.from((await vector.images.png(1)).data.slice((30 * 200 + 30) * 4, (30 * 200 + 30) * 4 + 4)))()');
  check('a half-transparent fill on nothing keeps its alpha', [half[2], half[3]], [255, 128]);
  await compare('vector.images.png(1)', 'vector.images.svg()', 'transparent: PNG against SVG', SVG_SHARE * 2);
  await compare('vector.images.png(1)', 'vector.images.glsl()', 'transparent: PNG against GLSL', GLSL_SHARE);
  if (gpu) {
    await compare("vector.images.png(1, 'webgpu')", "vector.images.png(1, 'webgl2')", 'transparent: WebGPU against WebGL 2', GLSL_SHARE);
    await compare('vector.images.png(1)', 'vector.images.wgsl()', 'transparent: PNG against WGSL', GLSL_SHARE);
  }

  // ---- SVG import: a file as other editors write them, drawn as Chrome draws the file
  const svgFile = await readFile(join(root, 'tests/fixtures/import.svg'), 'utf8');
  check('opens an SVG', await evaluate(`vector.open(${JSON.stringify(svgFile)}, 'import.svg')`), true);
  check('with nothing to warn about', await evaluate(`!document.querySelector('dialog[open]')`), true);
  check(
    'its layers and background; Save will not write over the SVG',
    await evaluate(`[vector.doc().layers.map((l) => [l.name, l.opacity, l.blend]), vector.doc().background, vector.app.fileHandle, vector.app.fileName]`),
    [[['Shapes', 1, 'normal'], ['Marks', 0.9, 'multiply']], '#fbfaf7', null, 'import'],
  );
  await compare('vector.images.png(1)', `vector.images.svg(${JSON.stringify(svgFile)})`, 'imported SVG: PNG against the file', SVG_SHARE);
  await compare('vector.images.png(2)', `vector.images.svg(${JSON.stringify(svgFile)}, 2)`, 'imported SVG ×2: PNG against the file ×2', SVG_SHARE);
  await compare('vector.images.png(1)', 'vector.images.svg()', 'imported SVG: PNG against its SVG export', SVG_SHARE);
  await compare('vector.images.png(1)', 'vector.images.glsl()', 'imported SVG: PNG against GLSL', GLSL_SHARE);
  if (SHOTS) {
    await evaluate('vector.app.view.render()');
    await shot('import-svg');
  }
  // Every named colour read as Chrome reads it.
  const { COLOR_NAMES, parseCssColor } = await load('core/color.ts');
  const chromeColors = await evaluate(`(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    return ${JSON.stringify(COLOR_NAMES)}.map((name) => { ctx.fillStyle = '#000000'; ctx.fillStyle = name; return ctx.fillStyle; });
  })()`);
  check('148 colour names, as Chrome has them', COLOR_NAMES.map((n) => parseCssColor(n).hex), chromeColors);
  // An SVG dropped on the window goes into the document, selected, as one step.
  await evaluate(`vector.open(JSON.stringify({ version: 2, width: 300, height: 200, background: null, fonts: [], layers: [{ id: 'one', name: 'One', children: [] }] }))`);
  const mark = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50"><rect width="10" height="10"/><circle cx="30" cy="30" r="5" fill="red" stroke="black" stroke-dasharray="2 2"/></svg>';
  await evaluate(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(mark)}], 'mark.svg', { type: 'image/svg+xml' }));
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  })()`);
  await until('vector.doc().layers[0].children.length > 0');
  check(
    'an SVG dropped: placed as a group named after the file, and selected',
    await evaluate(`(() => { const g = vector.doc().layers[0].children[0]; return [g.type, g.name, g.children.map((n) => n.type), vector.app.selection[0] === g.id]; })()`),
    ['group', 'mark', ['rect', 'ellipse'], true],
  );
  await until(`!!document.querySelector('dialog[open]')`);
  ok('what it could not carry is said', await evaluate(`document.querySelector('dialog[open]').textContent.includes('stroke-dasharray')`));
  await shot('import-warnings');
  await evaluate(`document.querySelector('dialog[open]').close()`);
  await press('z', MOD);
  check('one step to undo', await evaluate('vector.doc().layers[0].children.length'), 0);

  // ---- 5. Hundreds of objects: drawing and dragging stay quick
  await evaluate(`(() => {
    const shapes = [];
    for (let i = 0; i < 600; i++) {
      const x = (i * 37) % 760, y = (i * 53) % 560, kind = i % 4;
      const base = { id: 's' + i, visible: true, locked: false, opacity: 1, transform: [1, 0, 0, 1, 0, 0], fill: { color: '#4f8ef7', opacity: 0.8 }, stroke: { color: '#1d2433', opacity: 1, width: 2, cap: 'round', join: 'round' } };
      if (kind === 0) shapes.push({ ...base, type: 'rect', x, y, width: 30, height: 20, rx: 3 });
      else if (kind === 1) shapes.push({ ...base, type: 'ellipse', cx: x + 15, cy: y + 15, rx: 15, ry: 10 });
      else if (kind === 2) shapes.push({ ...base, type: 'line', fill: null, x1: x, y1: y, x2: x + 30, y2: y + 25 });
      else shapes.push({ ...base, type: 'path', segments: [['M', x, y], ['C', x + 10, y - 10, x + 30, y + 10, x + 30, y + 25], ['L', x, y + 25], ['Z']], fillRule: 'nonzero' });
    }
    vector.open(JSON.stringify({ version: 1, width: 800, height: 600, background: '#ffffff', layers: [{ id: 'many', name: 'Many', visible: true, locked: false, opacity: 1, blend: 'normal', children: shapes }] }));
  })()`);
  const timing = await evaluate(`(async () => {
    const renderer = vector.app.view.renderer;
    const frame = async () => { const t = performance.now(); vector.app.view.render(); await renderer.finish(); return performance.now() - t; };
    await frame();
    const draw = Math.min(await frame(), await frame(), await frame());
    vector.run('select-all');
    const t = performance.now();
    for (let i = 1; i <= 10; i++) vector.app.apply(vector.transform(vector.app.selection, [1, 0, 0, 1, i, i]), { key: 'perf' });
    const move = (performance.now() - t) / 10;
    return { draw, move, steps: vector.app.history.size };
  })()`);
  console.log(`  600 shapes: a frame in ${timing.draw.toFixed(1)} ms (${await evaluate('vector.app.view.renderer.kind')} on SwiftShader, no GPU), moving all of them ${timing.move.toFixed(1)} ms a step`);
  // A shared CI machine runs SwiftShader slower than a desktop and unevenly: there the
  // times are only printed, and the limits hold on a developer's machine.
  if (process.env.CI) console.log('  CI: the time limits are not checked.');
  else {
    ok('600 shapes draw in under 250 ms even on SwiftShader', timing.draw < 250);
    ok('moving 600 shapes takes under 50 ms a step', timing.move < 50);
  }
  check('ten moves, one step', timing.steps, 1);

  // ---- 6. The screens, for a look
  check('opens the showcase again', await evaluate(`vector.open(${JSON.stringify(showcase)}, 'showcase.vector.json')`), true);
  await evaluate(`vector.app.select(['tilted'])`);
  await evaluate('vector.app.view.render()');
  await shot('main');
  await evaluate(`vector.run('export-glsl')`);
  await until(`!!document.querySelector('.glsl-live') && document.querySelector('.glsl-log').hidden`);
  check('the GLSL dialog compiled its text', await evaluate(`!!document.querySelector('.glsl-live') && document.querySelector('.glsl-log').hidden`), true);
  await shot('export-glsl');
  // An edit that breaks the shader shows the compiler's message.
  await evaluate(`(() => { const t = document.querySelector('dialog textarea'); t.value = t.value.replace('void main()', 'void main(') ; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until(`!document.querySelector('.glsl-log').hidden && document.querySelector('.glsl-log').textContent.length > 0`);
  check('a broken shader shows its error', await evaluate(`!document.querySelector('.glsl-log').hidden && document.querySelector('.glsl-log').textContent.length > 0`), true);
  await evaluate(`document.querySelector('dialog .dialog-close').click()`);
  await evaluate(`vector.run('export-shadertoy')`);
  await until(`document.querySelector('dialog h2')?.textContent === 'Экспорт для Shadertoy' && document.querySelector('.glsl-log').hidden`);
  check('the Shadertoy dialog compiled its text', await evaluate(`document.querySelector('dialog h2').textContent === 'Экспорт для Shadertoy' && document.querySelector('.glsl-log').hidden && document.querySelector('dialog textarea').value.includes('void mainImage(')`), true);
  await shot('export-shadertoy');
  await evaluate(`document.querySelector('dialog .dialog-close').click()`);
  if (gpu) {
    await evaluate(`vector.run('export-wgsl')`);
    const compiled = await evaluate(`new Promise((resolve) => {
      const started = Date.now();
      const look = () => {
        const live = document.querySelector('.glsl-live');
        const drawn = live && live.getContext('2d').getImageData(live.width / 2, live.height / 2, 1, 1).data[3] > 0;
        if (drawn || !document.querySelector('.glsl-log').hidden || Date.now() - started > 20000) resolve(drawn && document.querySelector('.glsl-log').hidden);
        else setTimeout(look, 100);
      };
      look();
    })`);
    check('the WGSL dialog ran its text with WebGPU', [await evaluate(`document.querySelector('dialog h2').textContent`), compiled], ['Экспорт WGSL', true]);
    await shot('export-wgsl');
    await evaluate(`document.querySelector('dialog .dialog-close').click()`);
    // The other renderer on request, on a canvas of its own; and back.
    await evaluate(`vector.run('renderer-webgl2')`);
    await evaluate('vector.app.view.ready');
    check('View → WebGL 2 switches the renderer', await evaluate(`[vector.app.view.renderer.kind, document.querySelectorAll('#view').length, document.querySelector('.status-renderer').textContent]`), ['webgl2', 1, 'WebGL 2']);
    await evaluate(`vector.run('renderer-webgpu')`);
    await evaluate('vector.app.view.ready');
    check('and back to WebGPU', await evaluate('vector.app.view.renderer.kind'), 'webgpu');
  }
  await evaluate(`vector.run('export-svg')`);
  await until(`(document.querySelector('dialog textarea')?.value ?? '').startsWith('<svg')`);
  check('the SVG dialog shows the text', await evaluate(`document.querySelector('dialog textarea').value.startsWith('<svg')`), true);
  await shot('export-svg');
  await evaluate(`document.querySelector('dialog .dialog-close').click()`);
  await evaluate(`vector.run('export-png')`);
  // The preview is drawn and encoded asynchronously: wait for it to show the width wanted.
  const previewWidth = (want) =>
    evaluate(`new Promise((resolve) => {
      const started = Date.now();
      const look = () => {
        const w = document.querySelector('dialog img')?.naturalWidth ?? 0;
        if (w === ${want} || Date.now() - started > 5000) resolve(w);
        else setTimeout(look, 50);
      };
      look();
    })`);
  check('the PNG dialog has a preview', await previewWidth(480), 480);
  await evaluate(`document.querySelector('dialog [data-scale="2"]').click()`);
  check('at 2×', await previewWidth(960), 960);
  await evaluate(`document.querySelector('dialog .dialog-close').click()`);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
  await until(`document.body.classList.contains('no-panels')`);
  check('the panels close in a narrow window', await evaluate(`document.body.classList.contains('no-panels')`), true);
  await evaluate('vector.app.view.fit()');
  await shot('narrow');
  await evaluate(`vector.run('panels')`);
  await shot('narrow-panels');
  check('no horizontal scroll when narrow', await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);

  // The PWA: its CSP lets in the manifest and the service worker, which keeps it offline.
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  const editor = `document.readyState === 'complete' && typeof vector === 'object' && document.querySelectorAll('.tool').length === 8`;
  check('pwa: service worker in control', await until(`navigator.serviceWorker.controller !== null`), true);
  check('pwa: the editor', await until(editor), true);
  check('pwa: manifest parsed', (await send('Page.getAppManifest')).errors, []);
  check('pwa: installable', (await send('Page.getInstallabilityErrors')).installabilityErrors, []);
  pagesDown = true;
  await send('Page.reload');
  check('pwa: offline', await until(editor), true);
  check('pwa: offline, it draws', await evaluate(`vector.app.view.ready.then(() => !vector.app.view.error && !!vector.app.view.renderer)`), true);
  pagesDown = false;
} finally {
  if (errors.length) check('no errors on the page', errors, []);
  ws.close();
  chrome.kill();
  server.close();
  await sleep(200);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
done('browser');
// Chrome's helper processes can hold its stderr pipe open after it quits.
process.exit(0);
