// Files: New, Open, Save, Save As in the editor's own .vector.json; where the File System
// Access API exists, Save writes back to the file opened or saved last, elsewhere it
// downloads. Open also reads an SVG, as a new document; Import SVG and an SVG dropped on
// the window place one into the document. A dropped .vector.json opens. The document is
// also kept in IndexedDB as it changes, and offered back at the next start.

import { pasteNodes } from '../core/actions';
import { createDocument, locate, walkNodes } from '../core/document';
import { FontError } from '../core/font';
import { faceFromFile, isBuiltinFont } from '../core/fonts';
import type { Op } from '../core/ops';
import { addFonts, batch, nodeChange, updateDocument, updateNodes } from '../core/ops';
import { FILE_EXTENSION, parseDocument, serialize } from '../core/serialize';
import { documentAsGroup, importSvg, SvgImportError } from '../core/svg-import';
import type { Document, FontFace, Text } from '../core/types';
import { app } from './app';
import { ask, esc, form, inform, showHtml, toast } from './ui/dialog';

type Picker = {
  showOpenFilePicker?: (o: object) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle>;
};
type Writable = { createWritable(): Promise<{ write(data: Blob | string): Promise<void>; close(): Promise<void> }> };

const picker = window as unknown as Picker;
const FILE_TYPES = [{ description: 'Векторный документ', accept: { 'application/json': ['.json'] } }];
const OPEN_TYPES = [{ description: 'Векторный документ или SVG', accept: { 'application/json': ['.json'], 'image/svg+xml': ['.svg'] } }];
const SVG_TYPES = [{ description: 'SVG', accept: { 'image/svg+xml': ['.svg'] } }];
const SVG_FILE = /\.svg$/i;

export const baseName = (name: string): string => name.replace(/\.vector\.json$/i, '').replace(/\.(json|svg)$/i, '') || 'Без названия';
const fileNameOf = (base: string) => `${base}${FILE_EXTENSION}`;

const MAX_SIDE = 16384;

// "Unsaved changes will be lost" — true to go on.
export async function confirmDiscard(): Promise<boolean> {
  if (!app.history.dirty) return true;
  const answer = await ask('Несохранённые изменения', `В «${app.fileName}» есть несохранённые изменения. Они пропадут.`, [
    { id: 'cancel', label: 'Отмена' },
    { id: 'discard', label: 'Не сохранять', primary: true },
  ]);
  return answer === 'discard';
}

export async function newDocument(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const v = await form({
    title: 'Новый документ',
    fields: [
      { kind: 'number', id: 'width', label: 'Ширина', value: app.doc.width, min: 1, max: MAX_SIDE, unit: 'px' },
      { kind: 'number', id: 'height', label: 'Высота', value: app.doc.height, min: 1, max: MAX_SIDE, unit: 'px' },
      { kind: 'color', id: 'background', label: 'Фон', value: app.doc.background ?? '#ffffff' },
      { kind: 'check', id: 'transparent', label: 'Прозрачный фон', value: app.doc.background === null },
    ],
    ok: 'Создать',
  });
  if (!v) return;
  app.load(createDocument(Number(v.width), Number(v.height), v.transparent ? null : String(v.background), 'Слой 1'), 'Без названия');
  await clearAutosave();
}

// The document's size and background, as an undoable step.
export async function documentDialog(): Promise<void> {
  const v = await form({
    title: 'Размер документа',
    fields: [
      { kind: 'number', id: 'width', label: 'Ширина', value: app.doc.width, min: 1, max: MAX_SIDE, unit: 'px' },
      { kind: 'number', id: 'height', label: 'Высота', value: app.doc.height, min: 1, max: MAX_SIDE, unit: 'px' },
      { kind: 'color', id: 'background', label: 'Фон', value: app.doc.background ?? '#ffffff' },
      { kind: 'check', id: 'transparent', label: 'Прозрачный фон', value: app.doc.background === null },
      { kind: 'note', text: 'Фигуры остаются на своих координатах; меняется только холст.' },
    ],
  });
  if (!v) return;
  app.apply(updateDocument(app.doc, { width: Number(v.width), height: Number(v.height), background: v.transparent ? null : String(v.background) }, 'Размер документа'));
  app.view.fit();
}

export function openText(text: string, name: string, handle: FileSystemFileHandle | null = null): boolean {
  if (SVG_FILE.test(name)) return openSvg(text, name);
  let doc: Document;
  try {
    doc = parseDocument(text);
  } catch (error) {
    void inform('Не удалось открыть', `${name}: ${(error as Error).message}`);
    return false;
  }
  app.load(doc, baseName(name), handle);
  return true;
}

// ---- SVG

// The import's result, or null when the file is not SVG (and that said).
function readSvg(text: string, name: string): ReturnType<typeof importSvg> | null {
  try {
    return importSvg(text);
  } catch (error) {
    if (!(error instanceof SvgImportError)) throw error;
    void inform('Не удалось импортировать SVG', `${name}: ${error.message}`);
    return null;
  }
}

function svgWarnings(name: string, warnings: string[]): void {
  if (!warnings.length) return;
  showHtml(
    'Импорт SVG',
    `<p class="dialog-text">«${esc(name)}» прочитан, но не всё в нём есть в редакторе:</p><ul class="export-warnings">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`,
  );
}

// An SVG as a new document. It is not this editor's file, so Save asks where to write the
// .vector.json rather than overwriting the SVG.
export function openSvg(text: string, name: string): boolean {
  const result = readSvg(text, name);
  if (!result) return false;
  app.load(result.doc, baseName(name), null);
  app.history.markUnsaved();
  app.emit('change');
  svgWarnings(name, result.warnings);
  return true;
}

// An SVG into the entered group or the active layer, as one group (or one shape) where the
// file draws it, selected; one step to undo.
export function placeSvg(text: string, name: string): boolean {
  const result = readSvg(text, name);
  if (!result) return false;
  const { group, warnings } = documentAsGroup(result.doc, baseName(name));
  const node = group.children.length === 1 ? group.children[0]! : group;
  if (!group.children.length) {
    svgWarnings(name, result.warnings);
    return false;
  }
  const e = pasteNodes(app.doc, [node], app.insertTarget().parentId);
  if (!e) return false;
  e.op.label = 'Импорт SVG';
  app.apply(e.op, { selection: e.selection });
  svgWarnings(name, [...result.warnings, ...warnings]);
  return true;
}

export async function importSvgFile(): Promise<void> {
  if (picker.showOpenFilePicker) {
    let handle: FileSystemFileHandle | undefined;
    try {
      [handle] = await picker.showOpenFilePicker({ types: SVG_TYPES });
    } catch {
      return; // Cancelled.
    }
    if (!handle) return;
    const file = await handle.getFile();
    placeSvg(await file.text(), file.name);
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.svg,image/svg+xml';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) placeSvg(await file.text(), file.name);
  });
  input.click();
}

export async function open(): Promise<void> {
  if (!(await confirmDiscard())) return;
  if (picker.showOpenFilePicker) {
    let handle: FileSystemFileHandle | undefined;
    try {
      [handle] = await picker.showOpenFilePicker({ types: OPEN_TYPES, excludeAcceptAllOption: false });
    } catch {
      return; // Cancelled.
    }
    if (!handle) return;
    const file = await handle.getFile();
    openText(await file.text(), file.name, SVG_FILE.test(file.name) ? null : handle);
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json,.svg,image/svg+xml';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) openText(await file.text(), file.name);
  });
  input.click();
}

export async function openDropped(files: File[]): Promise<void> {
  // Fonts dropped are loaded, as by File → Load font.
  const fonts = files.filter((f) => FONT_FILE.test(f.name));
  for (const f of fonts) {
    const face = await readFontFile(f);
    if (face) useFont(face);
  }
  if (fonts.length) return;
  // SVGs dropped are placed into the document, as by File → Import SVG.
  const svgs = files.filter((f) => SVG_FILE.test(f.name) || f.type === 'image/svg+xml');
  for (const f of svgs) placeSvg(await f.text(), f.name);
  if (svgs.length) return;
  const file = files.find((f) => /\.json$/i.test(f.name)) ?? files[0];
  if (!file) return;
  if (!(await confirmDiscard())) return;
  openText(await file.text(), file.name);
}

// ---- Fonts

const FONT_FILE = /\.(ttf|otf|ttc)$/i;

export async function readFontFile(file: File): Promise<FontFace | null> {
  try {
    return faceFromFile(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    if (!(error instanceof FontError)) throw error;
    void inform('Не удалось загрузить шрифт', `${file.name}: ${error.message}`);
    return null;
  }
}

function chooseFontFile(): Promise<FontFace | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ttf,.otf,.ttc,font/ttf,font/otf,font/collection';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      resolve(file ? await readFontFile(file) : null);
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

// Texts in the selection, groups opened up.
const selectedTexts = (): Text[] => [...walkNodes(app.selection.map((id) => locate(app.doc, id)?.node).filter((n) => !!n))].filter((n): n is Text => n.type === 'text');

// A font for the selected texts, or for new ones when no text is selected; the document
// carries it from now on.
export function useFont(face: FontFace): void {
  const ops: Op[] = [];
  if (!isBuiltinFont(face.id) && !app.doc.fonts.some((f) => f.id === face.id)) ops.push(addFonts([face], 'Шрифт'));
  const texts = selectedTexts();
  if (texts.length) ops.push(updateNodes(texts.map((t) => nodeChange(t, { font: face.id }))));
  else app.setTextStyle({ ...app.textStyle, font: face.id });
  if (ops.length) app.apply(batch('Шрифт', ops));
  toast(`Шрифт: ${face.family} ${face.style}`);
}

export async function loadFont(): Promise<void> {
  const face = await chooseFontFile();
  if (face) useFont(face);
}

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function saved(name?: string): void {
  if (name) app.fileName = baseName(name);
  app.history.markSaved();
  app.emit('file');
  app.emit('change');
  void clearAutosave();
}

export async function save(): Promise<void> {
  if (!app.fileHandle) return saveAs();
  try {
    await write(app.fileHandle, serialize(app.doc));
    saved();
    toast(`Сохранено: ${app.fileHandle.name}`);
  } catch (error) {
    // Permission refused or the file gone: ask where instead.
    if ((error as Error).name !== 'AbortError') await saveAs();
  }
}

export async function saveAs(): Promise<void> {
  const text = serialize(app.doc);
  const name = fileNameOf(app.fileName);
  if (picker.showSaveFilePicker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await picker.showSaveFilePicker({ suggestedName: name, types: FILE_TYPES });
    } catch {
      return; // Cancelled.
    }
    await write(handle, text);
    app.fileHandle = handle;
    saved(handle.name);
    toast(`Сохранено: ${handle.name}`);
    return;
  }
  download(new Blob([text], { type: 'application/json' }), name);
  saved(name);
}

async function write(handle: FileSystemFileHandle, text: string): Promise<void> {
  const w = await (handle as unknown as Writable).createWritable();
  await w.write(text);
  await w.close();
}

// ---- Autosave

const DB = 'html-vector-editor';
const STORE = 'autosave';
const KEY = 'current';

interface Saved {
  text: string;
  name: string;
  time: number;
}

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(d.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    d.close();
  }
}

export const readAutosave = (): Promise<Saved | undefined> => store<Saved | undefined>('readonly', (s) => s.get(KEY)).catch(() => undefined);
export const clearAutosave = (): Promise<void> => store<void>('readwrite', (s) => s.delete(KEY)).catch(() => undefined);
const writeAutosave = (v: Saved): Promise<void> => store<void>('readwrite', (s) => s.put(v, KEY)).catch(() => undefined);

// Keeps the document in IndexedDB a moment after each change, while it is unsaved.
export function installAutosave(): void {
  let timer = 0;
  app.on('change', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (app.history.dirty) void writeAutosave({ text: serialize(app.doc), name: app.fileName, time: Date.now() });
    }, 800);
  });
}

// At start: the document from last time, if it was never saved.
export async function offerRestore(): Promise<void> {
  const last = await readAutosave();
  if (!last) return;
  const when = new Date(last.time).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
  const answer = await ask('Восстановить документ?', `«${last.name}» не был сохранён (изменён ${when}).`, [
    { id: 'discard', label: 'Начать заново' },
    { id: 'restore', label: 'Восстановить', primary: true },
  ]);
  if (answer === 'restore' && openText(last.text, last.name)) app.history.markUnsaved();
  else await clearAutosave();
  app.emit('change');
}
