// The toolbox down the left, and the status bar along the bottom: the tool's hint, the
// pointer in document coordinates, the zoom.

import { app } from '../app';
import { icon } from '../icons';
import { esc } from './dialog';

export function mountToolbox(root: HTMLElement): void {
  root.innerHTML = app.tools
    .map((t) => `<button type="button" class="tool" data-tool="${t.id}" title="${esc(t.label)} (${t.key})" aria-label="${esc(t.label)}" aria-pressed="false">${icon(t.icon)}</button>`)
    .join('');
  const sync = () => root.querySelectorAll<HTMLElement>('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === app.tool.id)));
  root.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tool]');
    if (b) app.setTool(b.dataset.tool!);
  });
  app.on('tool', sync);
  sync();
}

export function mountStatus(root: HTMLElement): void {
  root.innerHTML = `<span class="status-hint"></span><span class="status-cursor"></span><span class="status-selection"></span><span class="status-zoom"></span>`;
  const hint = root.querySelector<HTMLElement>('.status-hint')!;
  const cursor = root.querySelector<HTMLElement>('.status-cursor')!;
  const selection = root.querySelector<HTMLElement>('.status-selection')!;
  const zoom = root.querySelector<HTMLElement>('.status-zoom')!;
  const r = (v: number) => (Math.round(v * 10) / 10).toString();
  const sync = () => {
    hint.textContent = app.tool.hint;
    const c = app.view?.cursor;
    cursor.textContent = c ? `${r(c.x)}, ${r(c.y)}` : '';
    const n = app.selection.length;
    selection.textContent = n ? `Выделено: ${n}` : '';
    zoom.textContent = `${app.view ? Math.round(app.view.zoom * 1000) / 10 : 100} %`;
  };
  app.on('tool', sync);
  app.on('view', sync);
  app.on('selection', sync);
  sync();
}
