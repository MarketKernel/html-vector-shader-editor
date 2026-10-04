// Dialogs: a form built from a list of fields, a question with buttons, and a panel with
// any content (the export dialogs). All are <dialog> elements shown modally that resolve
// a promise when closed. A form can watch its fields as they change, for linked fields.

import { icon } from '../icons';

export type Field =
  | { kind: 'number'; id: string; label: string; value: number; min: number; max: number; step?: number; unit?: string }
  | { kind: 'range'; id: string; label: string; value: number; min: number; max: number; step?: number; unit?: string }
  | { kind: 'select'; id: string; label: string; value: string; options: [string, string][] }
  | { kind: 'check'; id: string; label: string; value: boolean }
  | { kind: 'text'; id: string; label: string; value: string }
  | { kind: 'color'; id: string; label: string; value: string }
  | { kind: 'note'; text: string };

export type Values = Record<string, number | string | boolean>;

export interface FormOptions {
  title: string;
  fields: Field[];
  ok?: string;
  // A preview dialog has no dimmed backdrop and sits aside, so the image shows.
  preview?: boolean;
  onInput?(values: Values, changed: string, set: (id: string, value: number | string | boolean) => void): void;
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function shell(title: string, preview = false): { dialog: HTMLDialogElement; body: HTMLElement; foot: HTMLElement; form: HTMLFormElement } {
  const dialog = document.createElement('dialog');
  dialog.className = preview ? 'dialog dialog--preview' : 'dialog';
  dialog.innerHTML = `<form method="dialog" class="dialog-form"><header class="dialog-head"><h2>${esc(title)}</h2><button type="button" class="icon-button dialog-close" value="" aria-label="${esc('Закрыть')}">${icon('close')}</button></header><div class="dialog-body"></div><footer class="dialog-foot"></footer></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form')!;
  dialog.querySelector('.dialog-close')!.addEventListener('click', () => dialog.close(''));
  dragByHead(dialog);
  return { dialog, body: dialog.querySelector('.dialog-body')!, foot: dialog.querySelector('.dialog-foot')!, form };
}

// A dialog can be dragged aside by its title, to see what it covers.
function dragByHead(dialog: HTMLDialogElement): void {
  const head = dialog.querySelector<HTMLElement>('.dialog-head')!;
  let from: { x: number; y: number; dx: number; dy: number } | null = null;
  let dx = 0;
  let dy = 0;
  head.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    from = { x: e.clientX, y: e.clientY, dx, dy };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (!from) return;
    dx = from.dx + e.clientX - from.x;
    dy = from.dy + e.clientY - from.y;
    dialog.style.translate = `${dx}px ${dy}px`;
  });
  head.addEventListener('pointerup', () => (from = null));
}

function fieldRow(f: Exclude<Field, { kind: 'note' }>): string {
  const id = `f-${f.id}`;
  const label = `<label for="${id}">${esc(f.label)}</label>`;
  switch (f.kind) {
    case 'number':
      return `<div class="field">${label}<span class="field-input"><input id="${id}" name="${f.id}" type="number" min="${f.min}" max="${f.max}" step="${f.step ?? 1}" value="${f.value}" required>${f.unit ? `<span class="unit">${esc(f.unit)}</span>` : ''}</span></div>`;
    case 'range':
      return `<div class="field field--range">${label}<span class="field-input"><input type="range" data-for="${f.id}" min="${f.min}" max="${f.max}" step="${f.step ?? 1}" value="${f.value}" aria-label="${esc(f.label)}"><input id="${id}" name="${f.id}" type="number" min="${f.min}" max="${f.max}" step="${f.step ?? 1}" value="${f.value}" required>${f.unit ? `<span class="unit">${esc(f.unit)}</span>` : ''}</span></div>`;
    case 'select':
      return `<div class="field">${label}<span class="field-input"><select id="${id}" name="${f.id}">${f.options.map(([v, l]) => `<option value="${esc(v)}"${v === f.value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></span></div>`;
    case 'check':
      return `<div class="field field--check"><label class="check"><input id="${id}" name="${f.id}" type="checkbox"${f.value ? ' checked' : ''}> ${esc(f.label)}</label></div>`;
    case 'text':
      return `<div class="field">${label}<span class="field-input"><input id="${id}" name="${f.id}" type="text" value="${esc(f.value)}" autocomplete="off" spellcheck="false"></span></div>`;
    case 'color':
      return `<div class="field">${label}<span class="field-input"><input id="${id}" name="${f.id}" type="color" value="${esc(f.value)}"></span></div>`;
  }
}

function readValues(form: HTMLFormElement, fields: Field[]): Values {
  const out: Values = {};
  for (const f of fields) {
    if (f.kind === 'note') continue;
    const el = form.elements.namedItem(f.id);
    if (f.kind === 'check') out[f.id] = (el as HTMLInputElement).checked;
    else if (f.kind === 'number' || f.kind === 'range') {
      const n = Number((el as HTMLInputElement).value);
      out[f.id] = Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : f.value;
    } else out[f.id] = (el as HTMLInputElement | HTMLSelectElement).value;
  }
  return out;
}

export function form(o: FormOptions): Promise<Values | null> {
  const { dialog, body, foot, form } = shell(o.title, o.preview);
  body.innerHTML = o.fields.map((f) => (f.kind === 'note' ? `<p class="dialog-note">${esc(f.text)}</p>` : fieldRow(f))).join('');
  foot.innerHTML = `<button type="button" class="button" value="">${esc('Отмена')}</button><button type="submit" class="button button--primary" value="ok">${esc(o.ok ?? 'OK')}</button>`;
  foot.querySelector('button[type="button"]')!.addEventListener('click', () => dialog.close(''));

  const set = (id: string, value: number | string | boolean) => {
    const el = form.elements.namedItem(id);
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(value);
    else if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = String(value);
    const slider = form.querySelector<HTMLInputElement>(`input[type="range"][data-for="${id}"]`);
    if (slider) slider.value = String(value);
  };
  form.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    // A slider and its number box move together.
    const id = target.dataset.for ?? target.name;
    if (target.dataset.for) set(id, target.value);
    else if (target.type === 'number') {
      const slider = form.querySelector<HTMLInputElement>(`input[type="range"][data-for="${id}"]`);
      if (slider) slider.value = target.value;
    }
    o.onInput?.(readValues(form, o.fields), id, set);
  });

  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const values = dialog.returnValue === 'ok' ? readValues(form, o.fields) : null;
      dialog.remove();
      resolve(values);
    });
    dialog.showModal();
    const first = body.querySelector<HTMLElement>('input:not([type="range"]):not([type="radio"]), select');
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
    o.onInput?.(readValues(form, o.fields), '', set);
  });
}

export interface Choice {
  id: string;
  label: string;
  primary?: boolean;
}

// A question; resolves the id of the button pressed, or null when dismissed.
export function ask(title: string, text: string, choices: Choice[]): Promise<string | null> {
  const { dialog, body, foot } = shell(title);
  body.innerHTML = text
    .split('\n\n')
    .map((p) => `<p class="dialog-text">${esc(p)}</p>`)
    .join('');
  foot.innerHTML = choices.map((c) => `<button type="${c.primary ? 'submit' : 'button'}" class="button${c.primary ? ' button--primary' : ''}" value="${esc(c.id)}">${esc(c.label)}</button>`).join('');
  foot.querySelectorAll<HTMLButtonElement>('button[type="button"]').forEach((b) => b.addEventListener('click', () => dialog.close(b.value)));
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(dialog.returnValue || null);
    });
    dialog.showModal();
    foot.querySelector<HTMLButtonElement>('.button--primary')?.focus();
  });
}

export function inform(title: string, text: string): Promise<unknown> {
  return ask(title, text, [{ id: 'ok', label: 'OK', primary: true }]);
}

// A dialog with free content, for About and the list of shortcuts.
export function showHtml(title: string, html: string, wide = false): void {
  const { dialog, body, foot } = shell(title);
  if (wide) dialog.classList.add('dialog--wide');
  body.innerHTML = html;
  foot.innerHTML = `<button type="submit" class="button button--primary" value="ok">${esc('Закрыть')}</button>`;
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

export interface Panel {
  dialog: HTMLDialogElement;
  body: HTMLElement;
  foot: HTMLElement;
  closed: Promise<void>;
}

// A dialog the caller fills: the export dialogs, with previews and their own buttons. The
// footer gets a Close button at its end.
export function panel(title: string, className = ''): Panel {
  const { dialog, body, foot } = shell(title);
  if (className) dialog.classList.add(...className.split(' '));
  const close = document.createElement('button');
  close.type = 'submit';
  close.className = 'button';
  close.value = 'ok';
  close.textContent = 'Закрыть';
  foot.append(close);
  const closed = new Promise<void>((resolve) =>
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve();
    }),
  );
  dialog.showModal();
  return { dialog, body, foot, closed };
}

// A short message at the bottom of the window that goes away by itself.
export function toast(text: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  el.setAttribute('role', 'status');
  document.body.append(el);
  setTimeout(() => el.classList.add('toast--out'), 2600);
  setTimeout(() => el.remove(), 3000);
}
