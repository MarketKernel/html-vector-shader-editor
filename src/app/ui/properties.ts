// The Properties panel. For a selection: name, X, Y, W, H and angle of its frame, corner
// radius, fill, stroke and opacity — common values shown, differing ones blank — and the
// matrix of a single node as translate / rotate / scale. With nothing selected: the
// document and the style new shapes get. Always: the active layer's name, opacity, blend.
//
// The fields are rebuilt when what they describe changes (another selection, another
// layer) and only refreshed in place otherwise, so a colour picker stays open while its
// colour is applied live.

import { transformNodes } from '../../core/actions';
import { normalizeHex } from '../../core/color';
import { locate, walkNodes } from '../../core/document';
import { around, decompose, invert, multiplyAll, rotate, scale, translate } from '../../core/matrix';
import { nodeChange, updateDocument, updateNodes } from '../../core/ops';
import type { BlendMode, FillRule, Matrix, LineCap, LineJoin, Node, Shape, SolidFill, SolidStroke } from '../../core/types';
import { app } from '../app';
import { setLayer } from '../edit';
import { frameMetrics, selectionFrame } from '../selection';
import { esc } from './dialog';

type Value = number | string | boolean | null;

interface Field {
  kind: 'number' | 'percent' | 'color' | 'check' | 'select' | 'text' | 'info';
  label: string;
  get(): Value;
  // `live`: an intermediate value while a control is being dragged; such steps merge.
  set?(v: Value, live: boolean): void;
  options?: [string, string][];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  wide?: boolean;
}

interface Section {
  title: string;
  fields: Field[];
}

const BLEND_LABELS: Record<BlendMode, string> = { normal: 'Обычный', multiply: 'Умножение', screen: 'Экран' };
const CAP_LABELS: [LineCap, string][] = [
  ['butt', 'Плоский'],
  ['round', 'Круглый'],
  ['square', 'Квадратный'],
];
const JOIN_LABELS: [LineJoin, string][] = [
  ['miter', 'Острый'],
  ['round', 'Круглый'],
  ['bevel', 'Срезанный'],
];
const RULE_LABELS: [FillRule, string][] = [
  ['nonzero', 'Ненулевое (nonzero)'],
  ['evenodd', 'Чётно-нечётное (evenodd)'],
];

// One value if all agree, null otherwise.
function common<T>(items: T[], get: (t: T) => Value): Value {
  if (!items.length) return null;
  const first = get(items[0]!);
  return items.every((i) => get(i) === first) ? first : null;
}

const selectedNodes = (): Node[] => app.selection.map((id) => locate(app.doc, id)?.node).filter((n): n is Node => !!n);

// Shapes in the selection, groups opened up.
const selectedShapes = (): Shape[] => [...walkNodes(selectedNodes())].filter((n): n is Shape => n.type !== 'group');
const filled = (): Shape[] => selectedShapes().filter((s) => s.type !== 'line');

let session = 0;
const liveKey = (what: string) => `prop:${what}:${app.selection.join(',')}:${session}`;

function patchShapes(shapes: Shape[], values: (s: Shape) => Record<string, unknown>, label: string, live: boolean, what: string): void {
  if (!shapes.length) return;
  const changes = shapes.map((s) => nodeChange(s, values(s)));
  app.apply(updateNodes(changes, label), live ? { key: liveKey(what) } : {});
}

// The frame changed by a matrix in document space, as one step.
function transformSelection(delta: Matrix, label: string): void {
  app.apply(transformNodes(app.doc, selectedNodes(), delta, label));
}

function geometryFields(): Field[] {
  const f = selectionFrame();
  if (!f) return [];
  const m = () => frameMetrics(selectionFrame() ?? f);
  const resize = (sx: number, sy: number) => {
    const frame = selectionFrame()!;
    transformSelection(multiplyAll(frame, scale(sx, sy), invert(frame)!), 'Размер');
  };
  return [
    { kind: 'number', label: 'X', get: () => m().x, set: (v) => transformSelection(translate(Number(v) - m().x, 0), 'Положение') },
    { kind: 'number', label: 'Y', get: () => m().y, set: (v) => transformSelection(translate(0, Number(v) - m().y), 'Положение') },
    { kind: 'number', label: 'W', min: 0.01, get: () => m().width, set: (v) => resize(Number(v) / m().width, 1) },
    { kind: 'number', label: 'H', min: 0.01, get: () => m().height, set: (v) => resize(1, Number(v) / m().height) },
    {
      kind: 'number',
      label: 'Угол',
      unit: '°',
      step: 1,
      get: () => m().angle,
      set: (v) => {
        const frame = selectionFrame()!;
        const c = multiplyAll(frame, translate(0.5, 0.5));
        transformSelection(around(rotate(((Number(v) - m().angle) * Math.PI) / 180), c[4], c[5]), 'Поворот');
      },
    },
  ];
}

function fillFields(shapes: () => Shape[], target: 'selection' | 'style'): Field[] {
  const fills = () => (target === 'style' ? [app.style.fill] : shapes().map((s) => s.fill));
  const set = (make: (f: SolidFill | null) => SolidFill | null, live: boolean, what: string) => {
    if (target === 'style') return app.setStyle({ ...app.style, fill: make(app.style.fill) });
    patchShapes(shapes(), (s) => ({ fill: make(s.fill) }), 'Заливка', live, what);
    const first = shapes()[0];
    if (first) app.setStyle({ ...app.style, fill: first.fill });
  };
  const color = () => app.style.fill?.color ?? '#4f8ef7';
  return [
    { kind: 'check', label: 'Заливка', get: () => common(fills(), (f) => !!f), set: (v) => set((f) => (v ? (f ?? { color: color(), opacity: 1 }) : null), false, 'fill') },
    { kind: 'color', label: 'Цвет', get: () => common(fills(), (f) => f?.color ?? null), set: (v, live) => set((f) => ({ color: String(v), opacity: f?.opacity ?? 1 }), live, 'fill-color') },
    { kind: 'percent', label: 'Непрозрачность', get: () => common(fills(), (f) => (f ? f.opacity : null)), set: (v) => set((f) => (f ? { ...f, opacity: Number(v) } : f), false, 'fill-opacity') },
  ];
}

function strokeFields(shapes: () => Shape[], target: 'selection' | 'style'): Field[] {
  const strokes = () => (target === 'style' ? [app.style.stroke] : shapes().map((s) => s.stroke));
  const fallback = (): SolidStroke => app.style.stroke ?? { color: '#1d2433', opacity: 1, width: 2, cap: 'butt', join: 'miter' };
  const set = (make: (s: SolidStroke | null) => SolidStroke | null, live: boolean, what: string) => {
    if (target === 'style') return app.setStyle({ ...app.style, stroke: make(app.style.stroke) });
    patchShapes(shapes(), (s) => ({ stroke: make(s.stroke) }), 'Обводка', live, what);
    const first = shapes()[0];
    if (first) app.setStyle({ ...app.style, stroke: first.stroke });
  };
  const edit = (patch: Partial<SolidStroke>) => (s: SolidStroke | null) => ({ ...(s ?? fallback()), ...patch });
  return [
    { kind: 'check', label: 'Обводка', get: () => common(strokes(), (s) => !!s), set: (v) => set((s) => (v ? (s ?? fallback()) : null), false, 'stroke') },
    { kind: 'color', label: 'Цвет', get: () => common(strokes(), (s) => s?.color ?? null), set: (v, live) => set(edit({ color: String(v) }), live, 'stroke-color') },
    { kind: 'number', label: 'Толщина', min: 0, step: 0.5, unit: 'px', get: () => common(strokes(), (s) => s?.width ?? null), set: (v) => set(edit({ width: Math.max(0, Number(v)) }), false, 'stroke-width') },
    { kind: 'percent', label: 'Непрозрачность', get: () => common(strokes(), (s) => s?.opacity ?? null), set: (v) => set(edit({ opacity: Number(v) }), false, 'stroke-opacity') },
    { kind: 'select', label: 'Концы', options: CAP_LABELS, get: () => common(strokes(), (s) => s?.cap ?? null), set: (v) => set(edit({ cap: v as LineCap }), false, 'cap') },
    { kind: 'select', label: 'Углы', options: JOIN_LABELS, get: () => common(strokes(), (s) => s?.join ?? null), set: (v) => set(edit({ join: v as LineJoin }), false, 'join') },
  ];
}

function selectionSections(): Section[] {
  const nodes = selectedNodes();
  const sections: Section[] = [];
  const one = nodes.length === 1 ? nodes[0]! : null;
  const head: Field[] = [];
  if (one)
    head.push({
      kind: 'text',
      label: 'Имя',
      wide: true,
      get: () => locate(app.doc, one.id)?.node.name ?? '',
      set: (v) => app.apply(updateNodes([nodeChange(locate(app.doc, one.id)!.node, { name: String(v).trim() || undefined })], 'Имя')),
    });
  head.push(...geometryFields());
  head.push({
    kind: 'percent',
    label: 'Непрозрачность',
    get: () => common(selectedNodes(), (n) => n.opacity),
    set: (v, live) =>
      app.apply(
        updateNodes(
          selectedNodes().map((n) => nodeChange(n, { opacity: Number(v) })),
          'Непрозрачность',
        ),
        live ? { key: liveKey('opacity') } : {},
      ),
  });
  const rects = nodes.filter((n) => n.type === 'rect');
  if (rects.length === nodes.length)
    head.push({
      kind: 'number',
      label: 'Скругление',
      min: 0,
      unit: 'px',
      get: () => common(selectedNodes(), (n) => (n.type === 'rect' ? n.rx : null)),
      set: (v) => patchShapes(selectedShapes(), () => ({ rx: Math.max(0, Number(v)) }), 'Скругление', false, 'rx'),
    });
  if (one) {
    head.push({
      kind: 'info',
      label: 'Матрица',
      wide: true,
      get: () => {
        const n = locate(app.doc, one.id)?.node;
        if (!n) return '';
        const d = decompose(n.transform);
        const r = (x: number, k = 2) => String(Math.round(x * 10 ** k) / 10 ** k);
        return `translate(${r(d.translateX)}, ${r(d.translateY)}) · rotate(${r(d.rotation)}°) · scale(${r(d.scaleX, 3)}, ${r(d.scaleY, 3)})${Math.abs(d.shear) > 1e-6 ? ` · skew ${r((Math.atan(d.shear) * 180) / Math.PI)}°` : ''}`;
      },
    });
  }
  const label = one ? `${{ rect: 'Прямоугольник', ellipse: one.type === 'ellipse' && one.rx === one.ry ? 'Круг' : 'Эллипс', line: 'Линия', path: 'Контур', group: 'Группа' }[one.type]}` : `Объекты: ${nodes.length}`;
  sections.push({ title: label, fields: head });
  if (filled().length) sections.push({ title: 'Заливка', fields: fillFields(filled, 'selection') });
  if (selectedShapes().length) sections.push({ title: 'Обводка', fields: strokeFields(selectedShapes, 'selection') });
  const paths = () => selectedShapes().filter((s) => s.type === 'path');
  if (paths().length)
    sections.push({
      title: 'Контур',
      fields: [{ kind: 'select', label: 'Правило', options: RULE_LABELS, wide: true, get: () => common(paths(), (p) => (p.type === 'path' ? p.fillRule : null)), set: (v) => patchShapes(paths(), () => ({ fillRule: v }), 'Правило заливки', false, 'rule') }],
    });
  return sections;
}

function documentSections(): Section[] {
  return [
    {
      title: 'Документ',
      fields: [
        { kind: 'number', label: 'Ширина', min: 1, max: 16384, unit: 'px', get: () => app.doc.width, set: (v) => app.apply(updateDocument(app.doc, { width: Math.max(1, Number(v)) }, 'Размер документа')) },
        { kind: 'number', label: 'Высота', min: 1, max: 16384, unit: 'px', get: () => app.doc.height, set: (v) => app.apply(updateDocument(app.doc, { height: Math.max(1, Number(v)) }, 'Размер документа')) },
        { kind: 'check', label: 'Фон', get: () => app.doc.background !== null, set: (v) => app.apply(updateDocument(app.doc, { background: v ? '#ffffff' : null }, 'Фон')) },
        { kind: 'color', label: 'Цвет фона', get: () => app.doc.background, set: (v, live) => app.apply(updateDocument(app.doc, { background: String(v) }, 'Фон'), live ? { key: liveKey('bg') } : {}) },
      ],
    },
    { title: 'Заливка новых фигур', fields: fillFields(() => [], 'style') },
    { title: 'Обводка новых фигур', fields: strokeFields(() => [], 'style') },
  ];
}

function layerSection(): Section {
  const layer = () => app.layer;
  return {
    title: 'Слой',
    fields: [
      { kind: 'text', label: 'Имя', wide: true, get: () => layer().name, set: (v) => setLayer(layer().id, { name: String(v).trim() || layer().name }) },
      { kind: 'percent', label: 'Непрозрачность', get: () => layer().opacity, set: (v, live) => setLayer(layer().id, { opacity: Number(v) }, live ? liveKey(`layer-opacity-${layer().id}`) : undefined) },
      {
        kind: 'select',
        label: 'Наложение',
        options: (Object.keys(BLEND_LABELS) as BlendMode[]).map((b) => [b, BLEND_LABELS[b]]),
        get: () => layer().blend,
        set: (v) => setLayer(layer().id, { blend: v as BlendMode }),
      },
    ],
  };
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);

function control(f: Field, i: number): string {
  const id = `prop-${i}`;
  const label = `<label for="${id}">${esc(f.label)}</label>`;
  const unit = f.unit ? `<span class="unit">${esc(f.unit)}</span>` : '';
  switch (f.kind) {
    case 'number':
      return `<div class="prop">${label}<span class="prop-input"><input id="${id}" data-field="${i}" type="number" step="${f.step ?? 'any'}"${f.min !== undefined ? ` min="${f.min}"` : ''}${f.max !== undefined ? ` max="${f.max}"` : ''}>${unit}</span></div>`;
    case 'percent':
      return `<div class="prop prop--wide">${label}<span class="prop-input"><input type="range" data-field="${i}" data-range min="0" max="100" step="1" aria-label="${esc(f.label)}"><input id="${id}" data-field="${i}" type="number" min="0" max="100" step="1"><span class="unit">%</span></span></div>`;
    case 'color':
      return `<div class="prop">${label}<span class="prop-input"><input id="${id}" data-field="${i}" type="color"><input data-field="${i}" data-hex type="text" class="hex" maxlength="7" spellcheck="false" aria-label="${esc(f.label)} hex"></span></div>`;
    case 'check':
      return `<div class="prop prop--wide prop--check"><label class="check"><input id="${id}" data-field="${i}" type="checkbox"> ${esc(f.label)}</label></div>`;
    case 'select':
      return `<div class="prop${f.wide ? ' prop--wide' : ''}">${label}<span class="prop-input"><select id="${id}" data-field="${i}">${f.options!.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select></span></div>`;
    case 'text':
      return `<div class="prop prop--wide">${label}<span class="prop-input"><input id="${id}" data-field="${i}" type="text" autocomplete="off" spellcheck="false"></span></div>`;
    case 'info':
      return `<div class="prop prop--wide prop--info"><span class="prop-label">${esc(f.label)}</span><output data-field="${i}"></output></div>`;
  }
}

export function mountProperties(root: HTMLElement): void {
  let fields: Field[] = [];
  let signature = '';

  const build = () => {
    const sections = [...(app.selection.length ? selectionSections() : documentSections()), layerSection()];
    fields = sections.flatMap((s) => s.fields);
    let i = 0;
    root.innerHTML = `<h2 class="panel-title">Свойства</h2>${sections.map((s) => `<section class="props"><h3 class="props-title">${esc(s.title)}</h3><div class="props-grid">${s.fields.map((f) => control(f, i++)).join('')}</div></section>`).join('')}`;
    sync();
  };

  // Values into the controls, except the one being typed in.
  const sync = () => {
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLOutputElement>('[data-field]').forEach((el) => {
      if (el === document.activeElement && !(el instanceof HTMLInputElement && (el.type === 'range' || el.type === 'checkbox' || el.type === 'color'))) return;
      const f = fields[Number(el.dataset.field)];
      if (!f) return;
      const v = f.get();
      if (el instanceof HTMLOutputElement) el.textContent = String(v ?? '');
      else if (el instanceof HTMLSelectElement) el.value = v === null ? '' : String(v);
      else if (el.type === 'checkbox') {
        el.checked = v === true;
        el.indeterminate = v === null;
      } else if (el.type === 'color') el.value = typeof v === 'string' ? v : '#000000';
      else if (el.dataset.hex !== undefined) el.value = typeof v === 'string' ? v : '';
      else if (f.kind === 'percent') el.value = v === null ? '' : String(Math.round(Number(v) * 100));
      else if (typeof v === 'number') el.value = fmt(v);
      else el.value = v === null ? '' : String(v);
      if (el instanceof HTMLInputElement && v === null) el.placeholder = '—';
    });
    // Fields that make no sense without a fill or a stroke are dimmed.
    root.querySelectorAll('.props').forEach((fs) => {
      const toggle = fs.querySelector<HTMLInputElement>('.prop--check input');
      fs.classList.toggle('props--off', !!toggle && !toggle.checked && !toggle.indeterminate);
    });
  };

  const refresh = () => {
    const sig = [app.selection.join(','), app.activeLayer, app.selection.map((id) => locate(app.doc, id)?.node.type).join(','), app.selection.length ? '' : 'doc'].join('|');
    if (sig !== signature) {
      signature = sig;
      build();
    } else sync();
  };

  const commit = (el: HTMLInputElement | HTMLSelectElement, live: boolean) => {
    const f = fields[Number(el.dataset.field)];
    if (!f?.set) return;
    let v: Value;
    if (el instanceof HTMLSelectElement) v = el.value;
    else if (el.type === 'checkbox') v = el.checked;
    else if (el.dataset.hex !== undefined) {
      v = normalizeHex(el.value);
      if (!v) return sync();
    } else if (el.type === 'color') v = el.value;
    else if (f.kind === 'percent') {
      if (el.value === '') return;
      v = Math.max(0, Math.min(100, Number(el.value))) / 100;
    } else if (f.kind === 'number') {
      if (el.value === '' || !Number.isFinite(Number(el.value))) return sync();
      v = Math.max(f.min ?? -Infinity, Math.min(f.max ?? Infinity, Number(el.value)));
    } else v = el.value;
    f.set(v, live);
  };

  root.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    // Colours and sliders apply as they move; one step per drag.
    if (el.type === 'color' || el.dataset.range !== undefined) commit(el, true);
  });
  root.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    if (el instanceof HTMLInputElement && (el.type === 'color' || el.dataset.range !== undefined)) {
      commit(el, true);
      session++;
      app.history.seal();
      return;
    }
    commit(el, false);
  });
  root.addEventListener('keydown', (e) => {
    const el = e.target as HTMLInputElement;
    if (e.key === 'Enter' && el instanceof HTMLInputElement) el.blur();
    if (e.key === 'Escape' && el instanceof HTMLInputElement) {
      sync();
      el.blur();
    }
  });

  app.on('change', refresh);
  app.on('selection', refresh);
  app.on('style', refresh);
  build();
}
