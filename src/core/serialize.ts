// The .vector.json format: the document model as it is, with its `version`. Reading
// migrates older versions step by step and checks every field, so the editor never holds
// a document it cannot draw; anything it cannot make sense of is an error, not a guess.

import { normalizeHex } from './color';
import { FontError } from './font';
import { BUILTIN_FONT, decodeBase64, faceFromFile, fontId, registerFont } from './fonts';
import type { BlendMode, Document, Fill, FillRule, FontFace, Layer, LineCap, LineJoin, Matrix, Node, Segment, Stroke, TextAlign } from './types';
import { BLEND_MODES, DOCUMENT_VERSION, LINE_CAPS, LINE_JOINS, TEXT_ALIGNS } from './types';

export const FILE_EXTENSION = '.vector.json';

// Indented, but with arrays of plain values — matrices, path segments — on one line.
export function serialize(doc: Document): string {
  return `${format(doc, '')}\n`;
}

function format(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every((v) => v === null || typeof v !== 'object')) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
    const inner = indent + '  ';
    return `[\n${value.map((v) => inner + format(v, inner)).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) return '{}';
    const inner = indent + '  ';
    return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${format(v, inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

export class FormatError extends Error {}

const fail = (where: string, what: string): never => {
  throw new FormatError(`${where}: ${what}`);
};

// Each migration takes a document of version n to n + 1.
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {
  // Version 0 — the drafts before the format had a version — kept blend modes and colours
  // loosely: a layer without `blend`, a fill as a bare colour string.
  0: (raw) => ({
    ...raw,
    version: 1,
    layers: (Array.isArray(raw.layers) ? raw.layers : []).map((l: Record<string, unknown>) => ({ blend: 'normal', ...l, children: upgradePaint0(l.children) })),
  }),
  // Version 2 brought texts, and the fonts a document carries for them.
  1: (raw) => ({ ...raw, version: 2, fonts: [] }),
};

function upgradePaint0(children: unknown): unknown {
  if (!Array.isArray(children)) return children;
  return children.map((n: Record<string, unknown>) => ({
    ...n,
    ...(typeof n.fill === 'string' ? { fill: { color: n.fill, opacity: 1 } } : {}),
    ...(n.children ? { children: upgradePaint0(n.children) } : {}),
  }));
}

export function parseDocument(text: string): Document {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new FormatError(`Not JSON: ${(error as Error).message}`);
  }
  return readDocument(raw);
}

export function readDocument(raw: unknown): Document {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('document', 'not an object');
  let doc = raw as Record<string, unknown>;
  let version = doc.version === undefined ? 0 : doc.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) fail('document', `bad version ${String(version)}`);
  if ((version as number) > DOCUMENT_VERSION) fail('document', `version ${version} is newer than this editor reads (${DOCUMENT_VERSION})`);
  while ((version as number) < DOCUMENT_VERSION) {
    doc = MIGRATIONS[version as number]!(doc);
    version = doc.version as number;
  }
  const width = positive(doc.width, 'document.width');
  const height = positive(doc.height, 'document.height');
  const background = doc.background === null || doc.background === undefined ? null : color(doc.background, 'document.background');
  if (!Array.isArray(doc.layers)) fail('document.layers', 'not a list');
  if (!Array.isArray(doc.fonts)) fail('document.fonts', 'not a list');
  const fonts = (doc.fonts as unknown[]).map((f, i) => readFont(f, `fonts[${i}]`));
  const layers = (doc.layers as unknown[]).map((l, i) => readLayer(l, `layers[${i}]`));
  const known = new Set([BUILTIN_FONT, ...fonts.map((f) => f.id)]);
  const ids = new Set<string>();
  const unique = (id: string, where: string) => {
    if (ids.has(id)) fail(where, `the id ${id} is used twice`);
    ids.add(id);
  };
  const walk = (nodes: Node[], where: string) =>
    nodes.forEach((n, i) => {
      unique(n.id, `${where}[${i}]`);
      if (n.type === 'group') walk(n.children, `${where}[${i}].children`);
      if (n.type === 'text' && !known.has(n.font)) fail(`${where}[${i}].font`, `no font ${n.font} in the document`);
    });
  layers.forEach((l, i) => {
    unique(l.id, `layers[${i}]`);
    walk(l.children, `layers[${i}].children`);
  });
  fonts.forEach(registerFont);
  return { version: DOCUMENT_VERSION, width, height, background, layers, fonts };
}

// A font the document carries: it must read, and its id must be its contents' own.
function readFont(raw: unknown, where: string): FontFace {
  const f = obj(raw, where);
  const id = str(f.id, `${where}.id`);
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(str(f.data, `${where}.data`));
  } catch {
    return fail(`${where}.data`, 'not base64');
  }
  if (fontId(bytes) !== id) fail(`${where}.id`, `${id} is not the id of the font's data`);
  try {
    faceFromFile(bytes);
  } catch (error) {
    if (error instanceof FontError) fail(where, error.message);
    throw error;
  }
  return { id, family: typeof f.family === 'string' ? f.family : '', style: typeof f.style === 'string' ? f.style : '', data: f.data as string };
}

function obj(v: unknown, where: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(where, 'not an object');
  return v as Record<string, unknown>;
}

function num(v: unknown, where: string, fallback?: number): number {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(where, `not a number: ${JSON.stringify(v)}`);
  return v as number;
}

const positive = (v: unknown, where: string): number => {
  const n = num(v, where);
  if (n <= 0) fail(where, 'must be above zero');
  return n;
};

const nonNegative = (v: unknown, where: string, fallback?: number): number => {
  const n = num(v, where, fallback);
  if (n < 0) fail(where, 'must not be negative');
  return n;
};

const unit = (v: unknown, where: string): number => Math.max(0, Math.min(1, num(v, where, 1)));

function bool(v: unknown, where: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') fail(where, 'not true or false');
  return v as boolean;
}

function str(v: unknown, where: string): string {
  if (typeof v !== 'string' || !v) fail(where, 'not a string');
  return v as string;
}

function color(v: unknown, where: string): string {
  const hex = typeof v === 'string' ? normalizeHex(v) : null;
  if (!hex) fail(where, `not a colour: ${JSON.stringify(v)}`);
  return hex!;
}

function oneOf<T extends string>(v: unknown, options: readonly T[], where: string, fallback: T): T {
  if (v === undefined) return fallback;
  if (!options.includes(v as T)) fail(where, `not one of ${options.join(', ')}`);
  return v as T;
}

function matrix(v: unknown, where: string): Matrix {
  if (v === undefined) return [1, 0, 0, 1, 0, 0];
  if (!Array.isArray(v) || v.length !== 6) fail(where, 'not a matrix of six numbers');
  return (v as unknown[]).map((n, i) => num(n, `${where}[${i}]`)) as Matrix;
}

function readLayer(raw: unknown, where: string): Layer {
  const l = obj(raw, where);
  if (!Array.isArray(l.children)) fail(`${where}.children`, 'not a list');
  return {
    id: str(l.id, `${where}.id`),
    name: typeof l.name === 'string' ? l.name : '',
    visible: bool(l.visible, `${where}.visible`, true),
    locked: bool(l.locked, `${where}.locked`, false),
    opacity: unit(l.opacity, `${where}.opacity`),
    blend: oneOf<BlendMode>(l.blend, BLEND_MODES, `${where}.blend`, 'normal'),
    children: (l.children as unknown[]).map((n, i) => readNode(n, `${where}.children[${i}]`)),
  };
}

function readFill(v: unknown, where: string): Fill {
  if (v === null || v === undefined) return null;
  const f = obj(v, where);
  return { color: color(f.color, `${where}.color`), opacity: unit(f.opacity, `${where}.opacity`) };
}

function readStroke(v: unknown, where: string): Stroke {
  if (v === null || v === undefined) return null;
  const s = obj(v, where);
  return {
    color: color(s.color, `${where}.color`),
    opacity: unit(s.opacity, `${where}.opacity`),
    width: nonNegative(s.width, `${where}.width`, 1),
    cap: oneOf<LineCap>(s.cap, LINE_CAPS, `${where}.cap`, 'butt'),
    join: oneOf<LineJoin>(s.join, LINE_JOINS, `${where}.join`, 'miter'),
  };
}

const SEGMENT_SIZE: Record<string, number> = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };

function readSegments(v: unknown, where: string): Segment[] {
  if (!Array.isArray(v)) fail(where, 'not a list');
  return (v as unknown[]).map((s, i) => {
    const at = `${where}[${i}]`;
    if (!Array.isArray(s) || typeof s[0] !== 'string' || !(s[0] in SEGMENT_SIZE)) fail(at, 'not a segment');
    const seg = s as unknown[];
    if (seg.length !== SEGMENT_SIZE[seg[0] as string]! + 1) fail(at, `${String(seg[0])} takes ${SEGMENT_SIZE[seg[0] as string]} numbers`);
    return [seg[0], ...seg.slice(1).map((n, j) => num(n, `${at}[${j + 1}]`))] as Segment;
  });
}

function readNode(raw: unknown, where: string): Node {
  const n = obj(raw, where);
  const base = {
    id: str(n.id, `${where}.id`),
    ...(typeof n.name === 'string' && n.name ? { name: n.name } : {}),
    visible: bool(n.visible, `${where}.visible`, true),
    locked: bool(n.locked, `${where}.locked`, false),
    opacity: unit(n.opacity, `${where}.opacity`),
    transform: matrix(n.transform, `${where}.transform`),
  };
  if (n.type === 'group') {
    if (!Array.isArray(n.children)) fail(`${where}.children`, 'not a list');
    return { ...base, type: 'group', children: (n.children as unknown[]).map((c, i) => readNode(c, `${where}.children[${i}]`)) };
  }
  const paint = { fill: readFill(n.fill, `${where}.fill`), stroke: readStroke(n.stroke, `${where}.stroke`) };
  switch (n.type) {
    case 'rect':
      return {
        ...base,
        type: 'rect',
        ...paint,
        x: num(n.x, `${where}.x`),
        y: num(n.y, `${where}.y`),
        width: nonNegative(n.width, `${where}.width`),
        height: nonNegative(n.height, `${where}.height`),
        rx: nonNegative(n.rx, `${where}.rx`, 0),
      };
    case 'ellipse':
      return { ...base, type: 'ellipse', ...paint, cx: num(n.cx, `${where}.cx`), cy: num(n.cy, `${where}.cy`), rx: nonNegative(n.rx, `${where}.rx`), ry: nonNegative(n.ry, `${where}.ry`) };
    case 'line':
      return { ...base, type: 'line', ...paint, x1: num(n.x1, `${where}.x1`), y1: num(n.y1, `${where}.y1`), x2: num(n.x2, `${where}.x2`), y2: num(n.y2, `${where}.y2`) };
    case 'path':
      return { ...base, type: 'path', ...paint, segments: readSegments(n.segments, `${where}.segments`), fillRule: oneOf<FillRule>(n.fillRule, ['nonzero', 'evenodd'], `${where}.fillRule`, 'nonzero') };
    case 'text':
      if (typeof n.text !== 'string') fail(`${where}.text`, 'not a string');
      return {
        ...base,
        type: 'text',
        ...paint,
        text: n.text as string,
        x: num(n.x, `${where}.x`),
        y: num(n.y, `${where}.y`),
        font: str(n.font, `${where}.font`),
        size: positive(n.size, `${where}.size`),
        lineHeight: positive(n.lineHeight ?? 1.2, `${where}.lineHeight`),
        letterSpacing: num(n.letterSpacing, `${where}.letterSpacing`, 0),
        align: oneOf<TextAlign>(n.align, TEXT_ALIGNS, `${where}.align`, 'start'),
      };
    default:
      return fail(`${where}.type`, `unknown node type ${JSON.stringify(n.type)}`);
  }
}

// Key order does not matter to the model; this compares documents as data.
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}
