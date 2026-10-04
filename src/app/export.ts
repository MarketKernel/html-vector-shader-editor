// Export → SVG, PNG, GLSL and Shadertoy: the exporters' text or pixels, their warnings, a
// preview, Copy and Save. The PNG is drawn by a renderer of its own on an offscreen canvas
// at the document's size (times 1, 2 or 4), whatever the view's zoom. The shader dialogs
// compile the very text they show and draw it beside the editor's picture.

import { drawList } from '../core/draw';
import { exportGlsl, exportShadertoy, GLSL_TOLERANCE, shadertoyLog, shadertoyStandalone } from '../core/glsl';
import { exportSvg } from '../core/svg';
import type { Document } from '../core/types';
import { app } from './app';
import { download } from './io';
import { drawFragment } from './render/fragment';
import { Renderer } from './render/renderer';
import { esc, panel, toast } from './ui/dialog';

let offscreen: Renderer | null = null;

function exportRenderer(): Renderer {
  if (offscreen && !offscreen.gl.isContextLost()) return offscreen;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false });
  if (!gl) throw new Error('WebGL 2 недоступен: PNG не нарисовать');
  offscreen = new Renderer(gl);
  return offscreen;
}

// The document's pixels at `scale`, drawn as the GLSL export would draw them at that size.
export function renderPixels(doc: Document, scale = 1): ImageData {
  return exportRenderer().readDocument(drawList(doc, { tolerance: GLSL_TOLERANCE, scale }), scale);
}

export function pngBlob(doc: Document, scale = 1): Promise<Blob> {
  const pixels = renderPixels(doc, scale);
  const canvas = document.createElement('canvas');
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  canvas.getContext('2d')!.putImageData(pixels, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
}

const base = () => app.fileName.replace(/[\\/:*?"<>|]+/g, '_') || 'vector';

function warningsHtml(warnings: string[]): string {
  if (!warnings.length) return '<p class="export-ok">Передано без потерь.</p>';
  return `<ul class="export-warnings">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
}

function button(label: string, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = primary ? 'button button--primary' : 'button';
  b.textContent = label;
  return b;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Скопировано');
  } catch {
    toast('Буфер обмена недоступен');
  }
}

export function exportSvgDialog(): void {
  const { text, warnings } = exportSvg(app.doc);
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  const p = panel('Экспорт SVG', 'dialog--wide dialog--export');
  p.body.innerHTML = `<div class="export-grid"><textarea class="export-code" readonly spellcheck="false">${esc(text)}</textarea><figure class="export-preview"><img alt="SVG" src="${url}"><figcaption>${app.doc.width} × ${app.doc.height} · ${(text.length / 1024).toFixed(1)} КБ</figcaption></figure></div>${warningsHtml(warnings)}`;
  const copy = button('Копировать');
  const save = button('Сохранить .svg', true);
  copy.addEventListener('click', () => void copyText(text));
  save.addEventListener('click', () => download(new Blob([text], { type: 'image/svg+xml' }), `${base()}.svg`));
  p.foot.prepend(copy, save);
  void p.closed.then(() => URL.revokeObjectURL(url));
}

export function exportPngDialog(): void {
  const p = panel('Экспорт PNG', 'dialog--export');
  let scale = 1;
  let url = '';
  p.body.innerHTML = `<div class="field"><span class="field-label">Масштаб</span><span class="segmented" role="radiogroup">${[1, 2, 4].map((s) => `<button type="button" role="radio" data-scale="${s}" aria-checked="${s === 1}">${s}×</button>`).join('')}</span></div><figure class="export-preview export-preview--png"><img alt="PNG"><figcaption></figcaption></figure><div class="export-status"></div>`;
  const img = p.body.querySelector('img')!;
  const caption = p.body.querySelector('figcaption')!;
  const status = p.body.querySelector<HTMLElement>('.export-status')!;
  let blob: Blob | null = null;
  const update = async () => {
    p.body.querySelectorAll<HTMLElement>('[data-scale]').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.scale) === scale)));
    const w = Math.round(app.doc.width * scale);
    const h = Math.round(app.doc.height * scale);
    caption.textContent = `${w} × ${h} px${app.doc.background ? '' : ' · прозрачный фон'}`;
    try {
      blob = await pngBlob(app.doc, scale);
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob);
      img.src = url;
      status.innerHTML = warningsHtml([]);
    } catch (error) {
      blob = null;
      status.innerHTML = warningsHtml([(error as Error).message]);
    }
  };
  p.body.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-scale]');
    if (!b) return;
    scale = Number(b.dataset.scale);
    void update();
  });
  const save = button('Сохранить .png', true);
  save.addEventListener('click', () => blob && download(blob, `${base()}${scale > 1 ? `@${scale}x` : ''}.png`));
  p.foot.prepend(save);
  void update();
  void p.closed.then(() => url && URL.revokeObjectURL(url));
}

export const exportGlslDialog = (): void => shaderDialog('glsl');
export const exportShadertoyDialog = (): void => shaderDialog('shadertoy');

// GLSL and Shadertoy: the code (editable), and beside the editor's picture the shader
// compiled from that very text — a Shadertoy one wrapped as Shadertoy would run it.
function shaderDialog(kind: 'glsl' | 'shadertoy'): void {
  const toy = kind === 'shadertoy';
  const { text, warnings } = toy ? exportShadertoy(app.doc, app.fileName) : exportGlsl(app.doc, app.fileName);
  const p = panel(toy ? 'Экспорт для Shadertoy' : 'Экспорт GLSL', 'dialog--wide dialog--export dialog--glsl');
  const w = app.doc.width;
  const h = app.doc.height;
  const how = toy
    ? 'Вставьте текст вместо кода вкладки Image нового шейдера на shadertoy.com. Страница вписывается в окно с сохранением пропорций; при iResolution = размеру документа пиксели совпадают с PNG.'
    : `uResolution = (${w}, ${h}) даёт пиксели PNG-экспорта.`;
  p.body.innerHTML = `<div class="export-grid"><textarea class="export-code" spellcheck="false" aria-label="Шейдер">${esc(text)}</textarea><div class="export-previews"><figure class="export-preview"><canvas class="glsl-editor" width="${w}" height="${h}"></canvas><figcaption>Редактор (PNG-экспорт)</figcaption></figure><figure class="export-preview"><canvas class="glsl-live" width="${w}" height="${h}"></canvas><figcaption>${toy ? 'Shadertoy-шейдер' : 'Шейдер'}, скомпилированный из этого текста</figcaption></figure><pre class="glsl-log" hidden></pre></div></div>${warningsHtml(warnings)}<p class="export-note">${(text.length / 1024).toFixed(1)} КБ · ${esc(how)} Текст можно править — превью пересобирается.</p>`;
  const code = p.body.querySelector('textarea')!;
  const editor = p.body.querySelector<HTMLCanvasElement>('.glsl-editor')!;
  const live = p.body.querySelector<HTMLCanvasElement>('.glsl-live')!;
  const log = p.body.querySelector<HTMLElement>('.glsl-log')!;
  try {
    editor.getContext('2d')!.putImageData(renderPixels(app.doc, 1), 0, 0);
  } catch (error) {
    log.hidden = false;
    log.textContent = (error as Error).message;
  }
  const compileNow = () => {
    try {
      drawFragment(live, toy ? shadertoyStandalone(code.value) : code.value);
      log.hidden = true;
      live.classList.remove('stale');
    } catch (error) {
      log.hidden = false;
      log.textContent = toy ? shadertoyLog((error as Error).message) : (error as Error).message;
      live.classList.add('stale');
    }
  };
  let timer = 0;
  code.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(compileNow, 300);
  });
  compileNow();
  const copy = button('Копировать');
  const save = button(toy ? 'Сохранить .glsl' : 'Сохранить .frag', true);
  copy.addEventListener('click', () => void copyText(code.value));
  save.addEventListener('click', () => download(new Blob([code.value], { type: 'text/plain' }), `${base()}${toy ? '.shadertoy.glsl' : '.frag'}`));
  p.foot.prepend(copy, save);
}
