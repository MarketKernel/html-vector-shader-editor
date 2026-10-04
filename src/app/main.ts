// Starts the page: the view, the tools, the panels and the keyboard; a document from the
// autosave if there is one; files dropped on the window; a warning before unsaved work is
// closed; and window.vector for the browser tests.

import { inZOrder, transformNodes } from '../core/actions';
import { locate } from '../core/document';
import { exportGlsl, exportShadertoy, shadertoyStandalone } from '../core/glsl';
import type { Matrix } from '../core/types';
import { canonical, parseDocument, serialize } from '../core/serialize';
import { exportSvg } from '../core/svg';
import { app } from './app';
import { COMMANDS, installKeyboard, runCommand } from './commands';
import { renderPixels } from './export';
import { installAutosave, offerRestore, openDropped, openText } from './io';
import { drawFragment, readFragment } from './render/fragment';
import { TOOLS } from './tools/index';
import { selectionFrame } from './selection';
import { mountLayers } from './ui/layers';
import { mountMenubar } from './ui/menubar';
import { mountProperties } from './ui/properties';
import { mountStatus, mountToolbox } from './ui/toolbox';
import { View } from './view';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

app.tools = TOOLS;
app.tool = TOOLS[0]!;
app.view = new View($('workspace'), $<HTMLCanvasElement>('view'));

mountMenubar($('menubar'));
mountToolbox($('toolbox'));
mountProperties($('properties'));
mountLayers($('layers'));
mountStatus($('status'));
installKeyboard();
installAutosave();

// A narrow window has no room for the panels beside the canvas: they close when it gets
// narrow and open again when it widens.
const narrow = matchMedia('(max-width: 760px)');
const fitPanels = () => {
  document.body.classList.toggle('no-panels', narrow.matches);
  app.emit('view');
};
narrow.addEventListener('change', fitPanels);
if (narrow.matches) fitPanels();

const title = () => {
  document.title = `${app.history.dirty ? '• ' : ''}${app.fileName} — HTML Vector Editor`;
};
app.on('change', () => {
  title();
  app.view.requestRender();
});
app.on('file', title);
app.on('tool', () => app.view.updateCursor());
app.on('view', () => app.view.updateCursor());
title();

window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) {
    e.preventDefault();
    document.body.classList.add('dropping');
  }
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dropping');
});
window.addEventListener('drop', (e) => {
  document.body.classList.remove('dropping');
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  if (document.querySelector('dialog[open]')) return;
  void openDropped(files);
});

window.addEventListener('beforeunload', (e) => {
  if (!app.history.dirty) return;
  e.preventDefault();
  e.returnValue = 'Есть несохранённые изменения.';
});

void offerRestore();

// ---- For the browser tests

// Pictures of the document from the three renderers, as ImageData at the document's size.
const images = {
  png: (scale = 1): ImageData => renderPixels(app.doc, scale),
  glsl(text = exportGlsl(app.doc).text, scale = 1): ImageData {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(app.doc.width * scale);
    canvas.height = Math.round(app.doc.height * scale);
    drawFragment(canvas, text);
    return readFragment(canvas);
  },
  // The Shadertoy export run as Shadertoy would, on a canvas of any size.
  shadertoy(text = exportShadertoy(app.doc).text, width = app.doc.width, height = app.doc.height): ImageData {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    drawFragment(canvas, shadertoyStandalone(text));
    return readFragment(canvas);
  },
  async svg(text = exportSvg(app.doc).text, scale = 1): Promise<ImageData> {
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(app.doc.width * scale);
    canvas.height = Math.round(app.doc.height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(img.src);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  },
};

// How two pictures differ: the share of pixels with any channel off by more than
// `tolerance` (of 255), compared premultiplied so invisible colour does not count.
function diff(a: ImageData, b: ImageData, tolerance: number): { fraction: number; max: number; count: number } {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`Sizes differ: ${a.width}×${a.height} and ${b.width}×${b.height}`);
  let count = 0;
  let max = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let worst = 0;
    const aa = a.data[i + 3]! / 255;
    const ba = b.data[i + 3]! / 255;
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(a.data[i + k]! * aa - b.data[i + k]! * ba));
    worst = Math.max(worst, Math.abs(a.data[i + 3]! - b.data[i + 3]!));
    max = Math.max(max, worst);
    if (worst > tolerance) count++;
  }
  return { fraction: count / (a.width * a.height), max: Math.round(max), count };
}

Object.assign(window, {
  vector: {
    app,
    commands: COMMANDS,
    run: runCommand,
    doc: () => app.doc,
    json: () => serialize(app.doc),
    canonical: () => canonical(app.doc),
    open: (text: string, name = 'test.vector.json') => openText(text, name),
    parse: parseDocument,
    exportSvg: () => exportSvg(app.doc),
    exportGlsl: () => exportGlsl(app.doc, app.fileName),
    exportShadertoy: () => exportShadertoy(app.doc, app.fileName),
    images,
    diff,
    // The selection's frame as [a, b, c, d, e, f] (unit square → document), or null.
    frame: () => selectionFrame(),
    View,
    // The op that moves nodes by a document-space matrix, as the select tool's drags do.
    transform: (ids: string[], delta: Matrix) => transformNodes(app.doc, inZOrder(app.doc, ids).map((id) => locate(app.doc, id)!.node), delta),
  },
});
