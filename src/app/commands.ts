// Every command the menus offer, with its keyboard shortcut, in one table; and the
// keyboard itself: shortcuts and a letter for each tool. Shortcuts go by the key's place
// on the keyboard (KeyboardEvent.code), so they work in any layout.

import { app } from './app';
import * as edit from './edit';
import { exportGlslDialog, exportPngDialog, exportShadertoyDialog, exportSvgDialog, exportWgslDialog } from './export';
import { documentDialog, loadFont, newDocument, open, save, saveAs } from './io';
import { TOOLS } from './tools/index';
import { showHtml } from './ui/dialog';
import type { Backend } from './render/renderer';
import { isTyping, rememberBackend } from './view';

export interface Command {
  id: string;
  label: string;
  keys?: string[];
  icon?: string;
  run(): unknown;
  enabled?(): boolean;
  checked?(): boolean;
}

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);

const has = edit.hasSelection;
const manyLayers = () => app.doc.layers.length > 1;
const layerIndex = () => app.doc.layers.findIndex((l) => l.id === app.activeLayer);

const commands: Command[] = [
  { id: 'new', label: 'Новый…', keys: ['Mod+Alt+N'], icon: 'file', run: newDocument },
  { id: 'open', label: 'Открыть…', keys: ['Mod+O'], icon: 'open', run: open },
  { id: 'save', label: 'Сохранить', keys: ['Mod+S'], icon: 'save', run: save },
  { id: 'save-as', label: 'Сохранить как…', keys: ['Mod+Shift+S'], run: saveAs },
  { id: 'document', label: 'Размер документа…', run: documentDialog },
  { id: 'load-font', label: 'Загрузить шрифт…', icon: 'text', run: loadFont },
  { id: 'export-svg', label: 'Экспорт SVG…', keys: ['Mod+Shift+E'], icon: 'export', run: exportSvgDialog },
  { id: 'export-png', label: 'Экспорт PNG…', icon: 'image', run: exportPngDialog },
  { id: 'export-glsl', label: 'Экспорт GLSL…', icon: 'code', run: exportGlslDialog },
  { id: 'export-shadertoy', label: 'Экспорт для Shadertoy…', icon: 'code', run: exportShadertoyDialog },
  { id: 'export-wgsl', label: 'Экспорт WGSL…', icon: 'code', run: exportWgslDialog },

  { id: 'undo', label: 'Отменить', keys: ['Mod+Z'], icon: 'undo', run: () => app.undo(), enabled: () => app.history.canUndo || !!app.tool?.pending?.() },
  { id: 'redo', label: 'Повторить', keys: ['Mod+Shift+Z', 'Mod+Y'], icon: 'redo', run: () => app.redo(), enabled: () => app.history.canRedo },
  { id: 'cut', label: 'Вырезать', keys: ['Mod+X'], icon: 'cut', run: edit.cut, enabled: has },
  { id: 'copy', label: 'Копировать', keys: ['Mod+C'], icon: 'copy', run: edit.copy, enabled: has },
  { id: 'paste', label: 'Вставить', keys: ['Mod+V'], icon: 'paste', run: edit.paste, enabled: () => app.clipboard.length > 0 },
  { id: 'duplicate', label: 'Дублировать', keys: ['Mod+D'], icon: 'duplicate', run: edit.duplicate, enabled: has },
  { id: 'delete', label: 'Удалить', keys: ['Delete', 'Backspace'], icon: 'trash', run: edit.deleteSelection, enabled: has },
  { id: 'select-all', label: 'Выделить всё', keys: ['Mod+A'], icon: 'select', run: edit.selectAll },
  { id: 'deselect', label: 'Снять выделение', keys: ['Mod+Shift+A'], run: () => app.select([]), enabled: has },
  { id: 'group', label: 'Сгруппировать', keys: ['Mod+G'], icon: 'group', run: edit.group, enabled: has },
  { id: 'ungroup', label: 'Разгруппировать', keys: ['Mod+Shift+G'], icon: 'ungroup', run: edit.ungroup, enabled: edit.canUngroup },
  { id: 'bring-forward', label: 'Переместить вперёд', keys: ['Mod+]'], run: () => edit.reorder('forward'), enabled: has },
  { id: 'send-backward', label: 'Переместить назад', keys: ['Mod+['], run: () => edit.reorder('backward'), enabled: has },
  { id: 'bring-front', label: 'На передний план', keys: ['Mod+Alt+]'], icon: 'front', run: () => edit.reorder('front'), enabled: has },
  { id: 'send-back', label: 'На задний план', keys: ['Mod+Alt+['], icon: 'back', run: () => edit.reorder('back'), enabled: has },

  { id: 'zoom-in', label: 'Приблизить', keys: ['Mod+=', 'Mod++'], icon: 'zoom-in', run: () => app.view.zoomStep(1) },
  { id: 'zoom-out', label: 'Отдалить', keys: ['Mod+-'], icon: 'zoom-out', run: () => app.view.zoomStep(-1) },
  { id: 'zoom-actual', label: 'Масштаб 100 %', keys: ['Mod+1'], run: () => app.view.actualSize() },
  { id: 'zoom-fit', label: 'Вписать в окно', keys: ['Mod+0'], icon: 'fit', run: () => app.view.fit() },
  { id: 'panels', label: 'Панели', keys: ['F8'], icon: 'panel', run: togglePanels, checked: () => !document.body.classList.contains('no-panels') },
  { id: 'renderer-webgpu', label: 'Рисовать через WebGPU', run: () => useBackend('webgpu'), enabled: () => !!navigator.gpu, checked: () => app.view?.renderer?.kind === 'webgpu' },
  { id: 'renderer-webgl2', label: 'Рисовать через WebGL 2', run: () => useBackend('webgl2'), checked: () => app.view?.renderer?.kind === 'webgl2' },

  { id: 'layer-new', label: 'Новый слой', keys: ['Mod+Shift+L'], icon: 'plus', run: edit.newLayer },
  { id: 'layer-duplicate', label: 'Дублировать слой', icon: 'duplicate', run: () => edit.copyLayer() },
  { id: 'layer-delete', label: 'Удалить слой', icon: 'trash', run: () => edit.removeLayer(), enabled: manyLayers },
  { id: 'layer-up', label: 'Слой выше', icon: 'up', run: () => edit.shiftLayer(1), enabled: () => layerIndex() < app.doc.layers.length - 1 },
  { id: 'layer-down', label: 'Слой ниже', icon: 'down', run: () => edit.shiftLayer(-1), enabled: () => layerIndex() > 0 },
  { id: 'move-to-layer', label: 'Перенести на слой…', icon: 'layers', run: edit.moveSelectionToLayer, enabled: () => has() && manyLayers() },

  ...TOOLS.map((t) => ({ id: `tool-${t.id}`, label: t.label, keys: [t.key], icon: t.icon, run: () => app.setTool(t.id), checked: () => app.tool === t })),

  { id: 'shortcuts', label: 'Клавиши', keys: ['F1'], run: () => shortcutsHelp() },
  { id: 'about', label: 'О программе', run: about },
];

export const COMMANDS = new Map(commands.map((c) => [c.id, c]));

export const MENUS: { id: string; label: string; items: string[] }[] = [
  { id: 'file', label: 'Файл', items: ['new', 'open', '-', 'save', 'save-as', '-', 'export-svg', 'export-png', 'export-glsl', 'export-shadertoy', 'export-wgsl', '-', 'document', 'load-font'] },
  { id: 'edit', label: 'Правка', items: ['undo', 'redo', '-', 'cut', 'copy', 'paste', 'duplicate', 'delete', '-', 'select-all', 'deselect', '-', 'group', 'ungroup', '-', 'bring-forward', 'send-backward', 'bring-front', 'send-back'] },
  { id: 'view', label: 'Вид', items: ['zoom-in', 'zoom-out', 'zoom-actual', 'zoom-fit', '-', 'panels', '-', 'renderer-webgpu', 'renderer-webgl2', '-', 'shortcuts', 'about'] },
  { id: 'layer', label: 'Слой', items: ['layer-new', 'layer-duplicate', 'layer-delete', '-', 'layer-up', 'layer-down', '-', 'move-to-layer'] },
];

export function runCommand(id: string): unknown {
  const c = COMMANDS.get(id);
  if (!c || (c.enabled && !c.enabled())) return undefined;
  // Commands that change the document act on finished work, not a path half drawn.
  if (!id.startsWith('tool-') && !['undo', 'zoom-in', 'zoom-out', 'zoom-actual', 'zoom-fit', 'panels'].includes(id)) app.finish();
  return c.run();
}

// Draws with another renderer from now on, and remembers it for the next start.
function useBackend(kind: Backend): Promise<void> {
  rememberBackend(kind);
  return app.view.start(kind);
}

function togglePanels(): void {
  document.body.classList.toggle('no-panels');
  app.emit('view');
}

// "Mod+Shift+S" as the platform writes it: ⇧⌘S on a Mac, Ctrl+Shift+S elsewhere.
export function formatKeys(keys: string): string {
  const parts = keys.split('+').filter(Boolean);
  if (keys.endsWith('++')) parts.push('+');
  const key = parts.pop()!;
  const names: Record<string, string> = IS_MAC ? { Mod: '⌘', Shift: '⇧', Alt: '⌥', Delete: '⌦', Backspace: '⌫' } : { Mod: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Delete: 'Del', Backspace: 'Backspace' };
  if (IS_MAC) {
    const order = ['Alt', 'Shift', 'Mod'];
    return [...order.filter((m) => parts.includes(m)).map((m) => names[m]), names[key] ?? key].join('');
  }
  return [...parts.map((m) => names[m] ?? m), names[key] ?? key].join('+');
}

// The key of an event as written in the table: the physical key for letters and digits.
function keyName(e: KeyboardEvent): string {
  const code = e.code;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const punct: Record<string, string> = { Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', NumpadAdd: '+', NumpadSubtract: '-' };
  return punct[code] ?? e.key;
}

function comboOf(e: KeyboardEvent): string {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  return [mod && 'Mod', e.altKey && 'Alt', e.shiftKey && 'Shift', keyName(e)].filter(Boolean).join('+');
}

const byKey = new Map<string, Command>();
for (const c of commands) for (const k of c.keys ?? []) byKey.set(k, c);

// The command a key press is the shortcut of, if any.
export const commandFor = (e: KeyboardEvent): Command | null => byKey.get(comboOf(e)) ?? null;

export function installKeyboard(): void {
  window.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]') || isTyping(e.target)) return;
    if (document.querySelector('.menu--open') && e.key !== 'Escape') return;
    const control = e.target instanceof Element && e.target.closest('input, button, select, [role="option"]');
    if (control && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(e.key)) return;
    if (app.tool.keydown?.(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      if (app.tool.cancel?.()) e.preventDefault();
      return;
    }
    const command = byKey.get(comboOf(e));
    if (!command) return;
    // Copying with text selected on the page copies the text.
    if ((command.id === 'copy' || command.id === 'cut') && window.getSelection()?.toString()) return;
    e.preventDefault();
    runCommand(command.id);
  });
}

function shortcutsHelp(): void {
  const rows = commands
    .filter((c) => c.keys?.length)
    .map((c) => `<tr><td>${c.label}</td><td>${c.keys!.map((k) => `<kbd>${formatKeys(k)}</kbd>`).join(' ')}</td></tr>`);
  const more = [
    ['Панорама из любого инструмента', 'Пробел + протяжка, средняя кнопка'],
    ['Масштаб к курсору', IS_MAC ? '⌘ + колесо, щипок' : 'Ctrl + колесо, щипок'],
    ['Сдвиг на 1 / 10 px', '← ↑ → ↓, Shift'],
    ['Войти в группу / выйти', 'Двойной клик / Esc'],
  ].map(([label, key]) => `<tr><td>${label}</td><td><kbd>${key}</kbd></td></tr>`);
  showHtml('Клавиши', `<div class="shortcuts"><table>${rows.join('')}${more.join('')}</table></div>`, true);
}

function about(): void {
  showHtml(
    'HTML Vector Editor',
    `<p>Версия ${__APP_VERSION__}.</p><p>Векторный редактор в одном HTML-файле. Документ — векторная модель (JSON); экран рисуется через WebGPU или WebGL 2, а экспорт даёт SVG, PNG, самостоятельные шейдеры GLSL ES 3.00 и WGSL — одну и ту же картинку.</p><p>Ничего не загружается из сети: файл работает офлайн.</p><p>Встроенный шрифт — Inter (латиница и кириллица), © The Inter Project Authors, по лицензии SIL Open Font License 1.1.</p>`,
  );
}
