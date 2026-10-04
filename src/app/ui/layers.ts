// The Layers panel: top layer first. Each row has an eye and a lock; a click makes the
// layer active (new shapes go there), a double click on the name renames it, dragging a
// row reorders. Below: new, duplicate, delete, up, down.

import { app } from '../app';
import { runCommand } from '../commands';
import { moveLayer, setLayer } from '../edit';
import { icon } from '../icons';
import { esc } from './dialog';

export function mountLayers(root: HTMLElement): void {
  root.innerHTML = `<h2 class="panel-title">Слои</h2><ul class="layers" role="listbox" aria-label="Слои"></ul><div class="panel-actions">${[
    ['layer-new', 'plus', 'Новый слой'],
    ['layer-duplicate', 'duplicate', 'Дублировать слой'],
    ['layer-delete', 'trash', 'Удалить слой'],
    ['layer-up', 'up', 'Слой выше'],
    ['layer-down', 'down', 'Слой ниже'],
  ]
    .map(([id, ic, label]) => `<button type="button" class="icon-button small" data-command="${id}" title="${label}" aria-label="${label}">${icon(ic!)}</button>`)
    .join('')}</div>`;
  const list = root.querySelector<HTMLElement>('.layers')!;
  let renaming: string | null = null;
  let dragged: string | null = null;

  const render = () => {
    if (renaming) return;
    const rows = [...app.doc.layers].reverse().map((l) => {
      const count = l.children.length;
      return `<li class="layer${l.id === app.activeLayer ? ' layer--active' : ''}${l.visible ? '' : ' layer--hidden'}" role="option" aria-selected="${l.id === app.activeLayer}" draggable="true" data-layer="${esc(l.id)}">
<button type="button" class="icon-button small" data-toggle="visible" aria-pressed="${l.visible}" title="${l.visible ? 'Скрыть' : 'Показать'}" aria-label="Видимость">${icon(l.visible ? 'eye' : 'eye-off')}</button>
<button type="button" class="icon-button small" data-toggle="locked" aria-pressed="${l.locked}" title="${l.locked ? 'Разблокировать' : 'Заблокировать'}" aria-label="Блокировка">${icon(l.locked ? 'lock' : 'unlock')}</button>
<span class="layer-name" title="Двойной клик — переименовать">${esc(l.name)}</span>
<span class="layer-meta">${l.blend !== 'normal' ? `${l.blend === 'multiply' ? 'умн.' : 'экран'} · ` : ''}${l.opacity < 1 ? `${Math.round(l.opacity * 100)} % · ` : ''}${count}</span></li>`;
    });
    list.innerHTML = rows.join('');
    sync();
  };

  const sync = () => {
    root.querySelectorAll<HTMLButtonElement>('.panel-actions [data-command]').forEach((b) => {
      const id = b.dataset.command!;
      const enabled = id === 'layer-delete' ? app.doc.layers.length > 1 : id === 'layer-up' ? app.doc.layers[app.doc.layers.length - 1]?.id !== app.activeLayer : id === 'layer-down' ? app.doc.layers[0]?.id !== app.activeLayer : true;
      b.disabled = !enabled;
    });
  };

  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const command = target.closest<HTMLElement>('.panel-actions [data-command]');
    if (command) {
      runCommand(command.dataset.command!);
      return;
    }
    const row = target.closest<HTMLElement>('[data-layer]');
    if (!row) return;
    const id = row.dataset.layer!;
    const layer = app.doc.layers.find((l) => l.id === id);
    if (!layer) return;
    const toggle = target.closest<HTMLElement>('[data-toggle]');
    if (toggle) {
      const prop = toggle.dataset.toggle as 'visible' | 'locked';
      setLayer(id, { [prop]: !layer[prop] });
      return;
    }
    app.setLayer(id);
  });

  list.addEventListener('dblclick', (e) => {
    const name = (e.target as HTMLElement).closest<HTMLElement>('.layer-name');
    const row = name?.closest<HTMLElement>('[data-layer]');
    if (!name || !row) return;
    const id = row.dataset.layer!;
    const layer = app.doc.layers.find((l) => l.id === id)!;
    renaming = id;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'layer-rename';
    input.value = layer.name;
    input.setAttribute('aria-label', 'Имя слоя');
    name.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      renaming = null;
      const value = input.value.trim();
      if (keep && value && value !== layer.name) setLayer(id, { name: value });
      else render();
    };
    input.addEventListener('keydown', (k) => {
      if (k.key === 'Enter') finish(true);
      else if (k.key === 'Escape') finish(false);
      k.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
  });

  // Reordering by drag: the row lands above or below the one it is dropped on.
  list.addEventListener('dragstart', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-layer]');
    if (!row || renaming) return;
    dragged = row.dataset.layer!;
    e.dataTransfer?.setData('text/plain', dragged);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    row.classList.add('layer--dragging');
  });
  list.addEventListener('dragover', (e) => {
    if (!dragged) return;
    e.preventDefault();
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-layer]');
    list.querySelectorAll('.layer').forEach((r) => r.classList.remove('drop-above', 'drop-below'));
    if (!row) return;
    const r = row.getBoundingClientRect();
    row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-above' : 'drop-below');
  });
  list.addEventListener('drop', (e) => {
    if (!dragged) return;
    e.preventDefault();
    e.stopPropagation();
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-layer]');
    if (row && row.dataset.layer !== dragged) {
      const r = row.getBoundingClientRect();
      const above = e.clientY < r.top + r.height / 2;
      const ids = app.doc.layers.map((l) => l.id).filter((id) => id !== dragged);
      // The list shows the top first: "above" a row is after it in the document.
      const at = ids.indexOf(row.dataset.layer!) + (above ? 1 : 0);
      moveLayer(dragged, at);
    }
    dragged = null;
    render();
  });
  list.addEventListener('dragend', () => {
    dragged = null;
    render();
  });

  app.on('change', render);
  app.on('selection', render);
  render();
}
