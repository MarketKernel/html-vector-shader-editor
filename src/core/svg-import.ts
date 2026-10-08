// SVG import: an SVG file read into the model, drawn the same wherever the model can say
// it. Shapes, paths (arcs become cubic curves within a hundred-thousandth of the radius),
// groups, transforms, opacity, fills and strokes keep their meaning exactly; styles come
// from attributes, style="" and <style> sheets with simple selectors, as a browser
// cascades them; <use> and <symbol> become copies. A text is set in the built-in font.
// Whatever the model has no place for — gradients, dashes, clipping, masks, filters,
// images, markers — is said in the warnings, never dropped silently.
//
// The document takes the size of the viewBox, so the file's own coordinates stay as they
// were; top-level <g> elements become layers when the file is made of nothing else (as
// Inkscape, Illustrator and this editor's export write layers), and a rectangle filling
// the whole page under them becomes the document's background.

import { transformValues } from './actions';
import { parseCssColor } from './color';
import { createLayer, uid } from './document';
import { BUILTIN_FONT } from './fonts';
import { identity, isIdentity, multiply, multiplyAll, rotate, scale, translate } from './matrix';
import type { BlendMode, Document, Fill, FillRule, Group, Layer, LineCap, LineJoin, Matrix, Node, Segment, Shape, Stroke, TextAlign } from './types';
import { DOCUMENT_VERSION, LINE_CAPS, SVG_MITER_LIMIT } from './types';
import type { XmlElement } from './xml';
import { localName, parseXml, XmlError } from './xml';

export interface ImportResult {
  doc: Document;
  warnings: string[];
}

export class SvgImportError extends Error {}

// ---- Numbers, lengths, transforms

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
const NUMBERS = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

export const numberList = (s: string | undefined): number[] => (s ? (s.match(NUMBERS) ?? []).map(Number) : []);

// CSS pixels per unit.
const UNITS: Record<string, number> = { '': 1, px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, q: 96 / 101.6 };

interface Viewport {
  width: number;
  height: number;
}

type Axis = 'x' | 'y' | 'xy';

// A length in user units; NaN when it is not one.
export function parseLength(s: string | undefined, viewport: Viewport = { width: 0, height: 0 }, axis: Axis = 'xy', fontSize = 16): number {
  if (s === undefined) return NaN;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(%|[a-zA-Z]*)\s*$/.exec(s);
  if (!m) return NaN;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (unit === '%') {
    const ref = axis === 'x' ? viewport.width : axis === 'y' ? viewport.height : Math.hypot(viewport.width, viewport.height) / Math.SQRT2;
    return (n / 100) * ref;
  }
  if (unit === 'em') return n * fontSize;
  if (unit === 'ex') return (n * fontSize) / 2;
  const k = UNITS[unit];
  return k === undefined ? NaN : n * k;
}

// transform="…" as one matrix; null when it does not parse (a browser then ignores it).
export function parseTransform(s: string): Matrix | null {
  let m = identity();
  const re = /\s*,?\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/y;
  let at = 0;
  const text = s.trim();
  while (at < text.length) {
    re.lastIndex = at;
    const f = re.exec(text);
    if (!f) return null;
    at = re.lastIndex;
    const a = numberList(f[2]);
    const deg = (v: number) => (v * Math.PI) / 180;
    let t: Matrix;
    switch (f[1]) {
      case 'matrix':
        if (a.length !== 6) return null;
        t = a as Matrix;
        break;
      case 'translate':
        if (a.length < 1 || a.length > 2) return null;
        t = translate(a[0]!, a[1] ?? 0);
        break;
      case 'scale':
        if (a.length < 1 || a.length > 2) return null;
        t = scale(a[0]!, a[1] ?? a[0]!);
        break;
      case 'rotate':
        if (a.length !== 1 && a.length !== 3) return null;
        t = a.length === 3 ? multiplyAll(translate(a[1]!, a[2]!), rotate(deg(a[0]!)), translate(-a[1]!, -a[2]!)) : rotate(deg(a[0]!));
        break;
      case 'skewX':
        if (a.length !== 1) return null;
        t = [1, 0, Math.tan(deg(a[0]!)), 1, 0, 0];
        break;
      default:
        if (a.length !== 1) return null;
        t = [1, Math.tan(deg(a[0]!)), 0, 1, 0, 0];
    }
    m = multiply(m, t);
  }
  return m;
}

// The matrix that fits a viewBox into a viewport, as preserveAspectRatio says.
export function viewBoxMatrix(vb: number[], width: number, height: number, par = ''): Matrix {
  const [x, y, w, h] = vb as [number, number, number, number];
  let sx = width / w;
  let sy = height / h;
  const [align = 'xMidYMid', fit = 'meet'] = par.trim().split(/\s+/).filter(Boolean);
  if (align === 'none') return [sx, 0, 0, sy, -x * sx, -y * sy];
  sx = sy = fit === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
  const along = (a: string, room: number) => (a === 'Min' ? 0 : a === 'Max' ? room : room / 2);
  const tx = along(align.slice(1, 4), width - w * sx);
  const ty = along(align.slice(5, 8), height - h * sy);
  return [sx, 0, 0, sy, tx - x * sx, ty - y * sy];
}

// ---- Path data

// Cubic pieces of an elliptical arc (SVG 1.1, F.6.5), each at most an eighth of a turn,
// where a cubic is off the ellipse by about four millionths of its radius.
function arcSegments(x1: number, y1: number, rx: number, ry: number, angle: number, large: boolean, sweep: boolean, x2: number, y2: number): Segment[] {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return [['L', x2, y2]];
  const phi = (angle * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy;
  const yp = -sin * dx + cos * dy;
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const coef = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * yp) / ry;
  const cyp = (-coef * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const turn = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (xp - cxp) / rx;
  const uy = (yp - cyp) / ry;
  const theta = turn(1, 0, ux, uy);
  let delta = turn(ux, uy, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 4) - 1e-9));
  const step = delta / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const point = (t: number): [number, number] => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const tangent = (t: number): [number, number] => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  const out: Segment[] = [];
  let [px, py] = [x1, y1];
  for (let i = 0; i < n; i++) {
    const t1 = theta + i * step;
    const t2 = t1 + step;
    const [d1x, d1y] = tangent(t1);
    const [d2x, d2y] = tangent(t2);
    const [ex, ey] = i === n - 1 ? [x2, y2] : point(t2);
    // Rounded to a billionth, so a control point on an axis is not 1e-17 off it.
    const r = (v: number) => Math.round(v * 1e9) / 1e9;
    out.push(['C', r(px + k * d1x), r(py + k * d1y), r(ex - k * d2x), r(ey - k * d2y), ex, ey]);
    [px, py] = [ex, ey];
  }
  return out;
}

// d="…" as the model's absolute M, L, Q, C and Z. A browser draws a path up to its first
// error; so does this, and says whether there was one.
export function parsePathData(d: string): { segments: Segment[]; error: boolean } {
  const out: Segment[] = [];
  let i = 0;
  const space = () => {
    while (i < d.length && ' \t\r\n,'.includes(d[i]!)) i++;
  };
  const num = (): number | null => {
    space();
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(d);
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = (): number | null => {
    space();
    const c = d[i];
    if (c !== '0' && c !== '1') return null;
    i++;
    return Number(c);
  };
  const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  // The last control point, for S after C or S and for T after Q or T.
  let lastC: [number, number] | null = null;
  let lastQ: [number, number] | null = null;
  let cmd = '';
  for (;;) {
    space();
    if (i >= d.length) return { segments: out, error: false };
    const c = d[i]!;
    if (/[a-zA-Z]/.test(c)) {
      if (!(c.toUpperCase() in ARGS)) return { segments: out, error: true };
      cmd = c;
      i++;
    } else if (!cmd || cmd === 'Z' || cmd === 'z') return { segments: out, error: true };
    const up = cmd.toUpperCase();
    if (!out.length && up !== 'M') return { segments: out, error: true };
    const rel = cmd !== up;
    const args: number[] = [];
    for (let k = 0; k < ARGS[up]!; k++) {
      const v = up === 'A' && (k === 3 || k === 4) ? flag() : num();
      if (v === null) return { segments: out, error: true };
      args.push(v);
    }
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    let nextC: [number, number] | null = null;
    let nextQ: [number, number] | null = null;
    switch (up) {
      case 'M':
        x = sx = ox + args[0]!;
        y = sy = oy + args[1]!;
        out.push(['M', x, y]);
        // Pairs after a moveto are linetos.
        cmd = rel ? 'l' : 'L';
        break;
      case 'L':
        x = ox + args[0]!;
        y = oy + args[1]!;
        out.push(['L', x, y]);
        break;
      case 'H':
        x = ox + args[0]!;
        out.push(['L', x, y]);
        break;
      case 'V':
        y = oy + args[0]!;
        out.push(['L', x, y]);
        break;
      case 'C':
      case 'S': {
        const [x1, y1]: [number, number] = up === 'C' ? [ox + args[0]!, oy + args[1]!] : lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y];
        const o = up === 'C' ? 2 : 0;
        const [x2, y2] = [ox + args[o]!, oy + args[o + 1]!];
        x = ox + args[o + 2]!;
        y = oy + args[o + 3]!;
        out.push(['C', x1, y1, x2, y2, x, y]);
        nextC = [x2, y2];
        break;
      }
      case 'Q':
      case 'T': {
        const control: [number, number] = up === 'Q' ? [ox + args[0]!, oy + args[1]!] : lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y];
        const [x1, y1] = control;
        const o = up === 'Q' ? 2 : 0;
        x = ox + args[o]!;
        y = oy + args[o + 1]!;
        out.push(['Q', x1, y1, x, y]);
        nextQ = [x1, y1];
        break;
      }
      case 'A': {
        const [ex, ey] = [ox + args[5]!, oy + args[6]!];
        out.push(...arcSegments(x, y, args[0]!, args[1]!, args[2]!, args[3] === 1, args[4] === 1, ex, ey));
        x = ex;
        y = ey;
        break;
      }
      case 'Z':
        out.push(['Z']);
        x = sx;
        y = sy;
        break;
    }
    lastC = nextC;
    lastQ = nextQ;
  }
}

// ---- Styles

// Properties passed down to children, and those that are not.
const INHERITED = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'color', 'visibility', 'font-family', 'font-size', 'font-weight', 'font-style',
  'text-anchor', 'letter-spacing', 'paint-order', 'marker-start', 'marker-mid', 'marker-end', 'dominant-baseline',
] as const;
const OWN = ['opacity', 'display', 'mix-blend-mode', 'clip-path', 'mask', 'filter', 'vector-effect', 'alignment-baseline', 'baseline-shift', 'stop-color', 'stop-opacity', 'overflow'];
const PROPERTIES = new Set<string>([...INHERITED, ...OWN, 'marker', 'font', 'transform']);
const INHERITS = new Set<string>(INHERITED);

const INITIAL: Record<string, string> = {
  fill: 'black', 'fill-opacity': '1', 'fill-rule': 'nonzero', stroke: 'none', 'stroke-opacity': '1', 'stroke-width': '1',
  'stroke-linecap': 'butt', 'stroke-linejoin': 'miter', 'stroke-miterlimit': '4', 'stroke-dasharray': 'none', color: 'black',
  visibility: 'visible', 'font-family': '', 'font-size': '16', 'font-weight': 'normal', 'font-style': 'normal',
  'text-anchor': 'start', 'letter-spacing': 'normal', 'paint-order': 'normal', 'marker-start': 'none', 'marker-mid': 'none',
  'marker-end': 'none', 'dominant-baseline': 'auto', opacity: '1', display: 'inline', 'mix-blend-mode': 'normal',
  'clip-path': 'none', mask: 'none', filter: 'none', 'vector-effect': 'none', 'alignment-baseline': 'auto', 'baseline-shift': 'baseline',
  'stop-color': 'black', 'stop-opacity': '1',
};

type Style = Record<string, string>;

interface Declaration {
  property: string;
  value: string;
  important: boolean;
}

function declarations(text: string): Declaration[] {
  return text
    .split(';')
    .map((d) => {
      const colon = d.indexOf(':');
      if (colon < 0) return null;
      let value = d.slice(colon + 1).trim();
      const important = /!\s*important\s*$/i.test(value);
      if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
      return { property: d.slice(0, colon).trim().toLowerCase(), value, important };
    })
    .filter((d): d is Declaration => !!d && !!d.property && d.value !== '');
}

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
}

interface Rule {
  // Right to left: the element's own compound first, then its ancestors'.
  parts: Compound[];
  // Between parts[i] and parts[i + 1]: '>' a parent, ' ' any ancestor.
  combinators: string[];
  specificity: number;
  order: number;
  declarations: Declaration[];
}

// A selector of tags, classes and ids joined by descendant or child combinators; null for
// anything else (attributes, pseudo-classes, siblings).
function parseSelector(s: string): { parts: Compound[]; combinators: string[]; specificity: number } | null {
  const tokens = s.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  const parts: Compound[] = [];
  const combinators: string[] = [];
  let pending = ' ';
  let specificity = 0;
  for (const t of tokens) {
    if (t === '>') {
      if (!parts.length || pending === '>') return null;
      pending = '>';
      continue;
    }
    const m = /^(\*|[a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(t);
    if (!m || (!m[1] && !m[2])) return null;
    const c: Compound = { tag: m[1] && m[1] !== '*' ? m[1] : null, id: null, classes: [] };
    for (const [, kind, name] of m[2]!.matchAll(/([.#])([\w-]+)/g)) {
      if (kind === '#') c.id = name!;
      else c.classes.push(name!);
    }
    specificity += (c.id ? 10000 : 0) + c.classes.length * 100 + (c.tag ? 1 : 0);
    if (parts.length) combinators.unshift(pending);
    parts.unshift(c);
    pending = ' ';
  }
  if (!parts.length || pending === '>') return null;
  return { parts, combinators, specificity };
}

const compoundMatches = (el: XmlElement, c: Compound): boolean => {
  if (c.tag && localName(el) !== c.tag) return false;
  if (c.id && el.attrs.id !== c.id) return false;
  if (!c.classes.length) return true;
  const classes = (el.attrs.class ?? '').split(/\s+/);
  return c.classes.every((k) => classes.includes(k));
};

function ruleMatches(el: XmlElement, r: Rule, at = 0): boolean {
  if (!compoundMatches(el, r.parts[at]!)) return false;
  if (at === r.parts.length - 1) return true;
  if (r.combinators[at] === '>') return !!el.parent && ruleMatches(el.parent, r, at + 1);
  for (let p = el.parent; p; p = p.parent) if (ruleMatches(p, r, at + 1)) return true;
  return false;
}

// ---- The importer

// A browser ignores a declaration it cannot read and takes the value from below in the
// cascade; for paints, the ones that matter, so does this. A colour function it does not
// know (lab(), color()) still counts as a paint, so that it is warned about.
function valid(property: string, value: string): boolean {
  if (property !== 'fill' && property !== 'stroke') return true;
  const v = value.toLowerCase();
  return v === 'none' || v === 'currentcolor' || v === 'inherit' || v === 'initial' || v === 'unset' || v.startsWith('url(') || !!parseCssColor(v) || /^[a-z-]+\(.*\)$/.test(v);
}

const blendOf = (v: string): BlendMode | null => (v === 'normal' || v === 'multiply' || v === 'screen' ? v : null);

const clampUnit = (n: number) => Math.max(0, Math.min(1, n));

// An opacity: a number or a percentage; the fallback when neither.
function opacityValue(v: string | undefined, fallback = 1): number {
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return clampUnit(v.trim().endsWith('%') ? n / 100 : n);
}

const base = (id: string, name: string | undefined) => ({ id, ...(name ? { name } : {}), visible: true, locked: false, opacity: 1, transform: identity() });

// Elements that are not drawn where they stand: definitions, metadata, paint servers.
const NOT_DRAWN = new Set(['defs', 'symbol', 'style', 'title', 'desc', 'metadata', 'linearGradient', 'radialGradient', 'pattern', 'clipPath', 'mask', 'marker', 'filter', 'script', 'font', 'font-face', 'view', 'cursor', 'stop']);

interface Context {
  style: Style;
  viewport: Viewport;
}

class Importer {
  private readonly counts = new Map<string, number>();
  private readonly ids = new Map<string, XmlElement>();
  private readonly rules: Rule[] = [];
  private readonly declared = new Map<XmlElement, Style>();
  private readonly using = new Set<XmlElement>();
  // Nodes made from elements with a blend mode: kept by a layer, warned about otherwise.
  readonly blends = new Map<Node, string>();
  readonly sources = new Map<Node, XmlElement>();

  constructor(readonly root: XmlElement) {
    const walk = (el: XmlElement) => {
      if (el.attrs.id && !this.ids.has(el.attrs.id)) this.ids.set(el.attrs.id, el);
      if (localName(el) === 'style' && (!el.attrs.type || el.attrs.type === 'text/css')) this.readSheet(el.children.filter((c) => typeof c === 'string').join(''));
      for (const c of el.children) if (typeof c !== 'string') walk(c);
    };
    walk(root);
  }

  warn(text: string): void {
    this.counts.set(text, (this.counts.get(text) ?? 0) + 1);
  }

  warnings(): string[] {
    return [...this.counts].map(([text, n]) => (n > 1 ? `${text} (×${n})` : text));
  }

  private readSheet(css: string): void {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      // A block's end, counting nested braces (@media holds rules).
      let depth = 1;
      let j = open + 1;
      for (; j < text.length && depth; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
      }
      const body = text.slice(open + 1, j - 1);
      i = j;
      if (prelude.startsWith('@')) {
        if (!/^@(font-face|import|charset|namespace)/i.test(prelude)) this.warn(`Правила ${prelude.split(/\s/)[0]} в <style> пропущены.`);
        continue;
      }
      const decls = declarations(body);
      for (const s of prelude.split(',')) {
        const sel = parseSelector(s);
        if (!sel) {
          this.warn(`Селектор CSS «${s.trim()}» не поддерживается; его правила пропущены.`);
          continue;
        }
        this.rules.push({ ...sel, order: this.rules.length, declarations: decls });
      }
    }
    this.rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  }

  // What the element itself says about each property: presentation attributes, then the
  // style sheets by specificity, then style="", then !important declarations.
  private declaredStyle(el: XmlElement): Style {
    const cached = this.declared.get(el);
    if (cached) return cached;
    const out: Style = {};
    for (const [k, v] of Object.entries(el.attrs)) if (PROPERTIES.has(k) && k !== 'transform' && valid(k, v.trim())) out[k] = v.trim();
    const important: Declaration[] = [];
    const take = (ds: Declaration[]) => {
      for (const d of ds) {
        if (d.important) important.push(d);
        else this.set(out, d);
      }
    };
    for (const r of this.rules) if (ruleMatches(el, r)) take(r.declarations);
    if (el.attrs.style) take(declarations(el.attrs.style));
    for (const d of important) this.set(out, d);
    this.declared.set(el, out);
    return out;
  }

  private set(out: Style, d: Declaration): void {
    if (d.property === 'marker') {
      for (const k of ['marker-start', 'marker-mid', 'marker-end']) out[k] = d.value;
    } else if (d.property === 'transform') {
      this.warn('Свойство CSS transform не поддерживается: работает только атрибут transform.');
    } else if (d.property === 'font') {
      // The shorthand: only its size and family matter here.
      const m = /(?:^|\s)([-+]?[\d.]+(?:px|pt|em|%)?)(?:\/\S+)?\s+(.+)$/.exec(d.value);
      if (m) {
        out['font-size'] = m[1]!;
        out['font-family'] = m[2]!;
        if (/\bbold\b|\b[6-9]00\b/.test(d.value)) out['font-weight'] = 'bold';
        if (/\bitalic\b|\boblique\b/.test(d.value)) out['font-style'] = 'italic';
      }
    } else if (PROPERTIES.has(d.property) && valid(d.property, d.value)) out[d.property] = d.value;
  }

  // The element's computed style: inherited values from its parent, its own on top.
  style(el: XmlElement, parent: Style): Style {
    const out: Style = {};
    for (const k of INHERITS) out[k] = parent[k] ?? INITIAL[k]!;
    for (const [k, v] of Object.entries(this.declaredStyle(el))) {
      if (v === 'inherit') out[k] = parent[k] ?? INITIAL[k] ?? '';
      else if (v === 'initial' || v === 'unset') out[k] = v === 'unset' && INHERITS.has(k) ? (parent[k] ?? INITIAL[k]!) : (INITIAL[k] ?? '');
      else if (k === 'font-size') out[k] = String(this.fontSize(v, Number(parent['font-size'] ?? 16)));
      else out[k] = v;
    }
    return out;
  }

  private fontSize(v: string, inherited: number): number {
    const named: Record<string, number> = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32 };
    if (named[v] !== undefined) return named[v]!;
    if (v === 'larger') return inherited * 1.2;
    if (v === 'smaller') return inherited / 1.2;
    const n = v.trim().endsWith('%') ? (parseFloat(v) / 100) * inherited : parseLength(v, { width: 0, height: 0 }, 'xy', inherited);
    return Number.isFinite(n) && n > 0 ? n : inherited;
  }

  length(el: XmlElement, name: string, ctx: Context, axis: Axis, fallback = 0): number {
    const v = el.attrs[name];
    if (v === undefined || v === 'auto') return fallback;
    const n = parseLength(v, ctx.viewport, axis, Number(ctx.style['font-size']));
    return Number.isFinite(n) ? n : fallback;
  }

  // ---- Paint

  private paint(value: string, opacity: string, style: Style, what: string): Fill {
    let v = value.trim();
    if (v === 'none') return null;
    const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/.exec(v);
    if (url) {
      const target = this.ids.get(url[1]!);
      const fallback = url[2]!.trim();
      const kind = target ? localName(target) : '';
      if (fallback && fallback !== 'none') {
        this.warn(`${what}: вместо «${url[1]}» взят запасной цвет ${fallback}.`);
        v = fallback;
      } else if (fallback === 'none') return null;
      else if (kind === 'linearGradient' || kind === 'radialGradient') {
        const avg = this.gradientColor(target!);
        this.warn(`Градиенты заменены средним цветом своих точек: градиентов в редакторе пока нет.`);
        return avg ? { color: avg.color, opacity: avg.opacity * opacityValue(opacity) } : null;
      } else {
        this.warn(`${what}: ${target ? `<${kind}>` : `ссылка на «${url[1]}»`} не поддерживается; не закрашено.`);
        return null;
      }
    }
    if (v.toLowerCase() === 'currentcolor') v = style.color ?? 'black';
    const c = parseCssColor(v);
    if (!c) {
      this.warn(`${what}: цвет «${v}» не распознан; не закрашено.`);
      return null;
    }
    return { color: c.hex, opacity: clampUnit(c.alpha * opacityValue(opacity)) };
  }

  // A gradient's stops, averaged: the colour it looks like from afar.
  private gradientColor(g: XmlElement): { color: string; opacity: number } | null {
    let stops: XmlElement[] = [];
    for (let el: XmlElement | undefined = g, depth = 0; el && depth < 8 && !stops.length; depth++) {
      stops = el.children.filter((c): c is XmlElement => typeof c !== 'string' && localName(c) === 'stop');
      const href: string | undefined = el.attrs.href ?? el.attrs['xlink:href'];
      el = href?.startsWith('#') ? this.ids.get(href.slice(1)) : undefined;
    }
    if (!stops.length) return null;
    let r = 0;
    let gg = 0;
    let b = 0;
    let a = 0;
    for (const s of stops) {
      const st = this.style(s, {});
      const c = parseCssColor(st['stop-color'] ?? 'black') ?? { hex: '#000000', alpha: 1 };
      const n = parseInt(c.hex.slice(1), 16);
      r += (n >> 16) & 255;
      gg += (n >> 8) & 255;
      b += n & 255;
      a += c.alpha * opacityValue(st['stop-opacity']);
    }
    const k = stops.length;
    const hex = (v: number) => Math.round(v / k).toString(16).padStart(2, '0');
    return { color: `#${hex(r)}${hex(gg)}${hex(b)}`, opacity: clampUnit(a / k) };
  }

  private fill(style: Style): Fill {
    return this.paint(style.fill ?? 'black', style['fill-opacity'] ?? '1', style, 'Заливка');
  }

  private stroke(style: Style, ctx: Context): Stroke {
    const paint = this.paint(style.stroke ?? 'none', style['stroke-opacity'] ?? '1', style, 'Обводка');
    if (!paint) return null;
    const width = parseLength(style['stroke-width'], ctx.viewport, 'xy', Number(style['font-size']));
    if (!(width > 0)) return null;
    const capValue = style['stroke-linecap'] ?? 'butt';
    const cap: LineCap = (LINE_CAPS as readonly string[]).includes(capValue) ? (capValue as LineCap) : 'butt';
    let join: LineJoin = 'miter';
    const j = style['stroke-linejoin'] ?? 'miter';
    if (j === 'round' || j === 'bevel') join = j;
    else if (j !== 'miter') this.warn(`Соединение stroke-linejoin="${j}" заменено острым (miter).`);
    const dashes = style['stroke-dasharray'] ?? 'none';
    if (dashes !== 'none' && numberList(dashes).some((v) => v > 0)) this.warn('Пунктир (stroke-dasharray) не поддерживается: обводка сплошная.');
    if (style['vector-effect'] === 'non-scaling-stroke') this.warn('vector-effect="non-scaling-stroke" не поддерживается: толщина обводки масштабируется.');
    const order = (style['paint-order'] ?? 'normal').trim();
    if (order !== 'normal' && !order.startsWith('fill') && !order.startsWith('markers fill')) this.warn(`paint-order="${order}" не поддерживается: обводка рисуется поверх заливки.`);
    return { color: paint.color, opacity: paint.opacity, width, cap, join };
  }

  // ---- Elements

  // What every node takes from its element: name, transform, opacity, visibility; and
  // warnings for the effects the model does not have.
  private common<T extends Node>(node: T, el: XmlElement, style: Style, extra: Matrix = identity()): T {
    const t = el.attrs.transform;
    let m = identity();
    if (t !== undefined && t.trim() !== '' && t.trim() !== 'none') {
      const parsed = parseTransform(t);
      if (parsed) m = parsed;
      else this.warn(`transform="${t}" не разобран; пропущен, как это делает браузер.`);
    }
    node.transform = multiply(m, extra);
    node.opacity = opacityValue(style.opacity);
    if (style.display === 'none') node.visible = false;
    for (const effect of ['clip-path', 'mask', 'filter'] as const) {
      const v = style[effect];
      if (v && v !== 'none') this.warn(`${{ 'clip-path': 'Обрезка (clip-path)', mask: 'Маски (mask)', filter: 'Фильтры (filter)' }[effect]} не поддерживаются: нарисовано без них.`);
    }
    const blend = style['mix-blend-mode'];
    if (blend && blend !== 'normal') this.blends.set(node, blend);
    this.sources.set(node, el);
    return node;
  }

  private nameOf(el: XmlElement): string | undefined {
    return el.attrs['data-name'] ?? el.attrs['inkscape:label'] ?? el.attrs.id;
  }

  // The element as a node, or null when it draws nothing.
  node(el: XmlElement, ctx: Context): Node | null {
    // Other namespaces — sodipodi:namedview, editors' metadata — are not drawn.
    if (el.name.includes(':') && !el.name.startsWith('svg:')) return null;
    const kind = localName(el);
    if (NOT_DRAWN.has(kind)) return null;
    const style = this.style(el, ctx.style);
    const here: Context = { style, viewport: ctx.viewport };
    switch (kind) {
      case 'g':
      case 'a':
        return this.group(el, here, this.childElements(el));
      case 'switch': {
        // The first child a browser would pick; it has no extensions to require.
        const first = this.childElements(el).find((c) => !c.attrs.requiredExtensions && localName(c) !== 'foreignObject' && !c.attrs.systemLanguage);
        return this.group(el, here, first ? [first] : []);
      }
      case 'svg':
        return this.nestedSvg(el, here);
      case 'use':
        return this.use(el, here);
      case 'rect':
      case 'circle':
      case 'ellipse':
      case 'line':
      case 'polyline':
      case 'polygon':
      case 'path':
        return this.shape(el, kind, here);
      case 'text':
        return this.text(el, here);
      case 'image':
        this.warn('Растровые изображения (<image>) не перенесены: в редакторе их пока нет.');
        return null;
      case 'foreignObject':
        this.warn('<foreignObject> (HTML внутри SVG) не перенесён.');
        return null;
      default:
        this.warn(`Элемент <${kind}> не поддерживается и пропущен.`);
        return null;
    }
  }

  private childElements(el: XmlElement): XmlElement[] {
    return el.children.filter((c): c is XmlElement => typeof c !== 'string');
  }

  private group(el: XmlElement, ctx: Context, children: XmlElement[], extra: Matrix = identity(), childCtx: Context = ctx): Group | null {
    const nodes = children.map((c) => this.node(c, childCtx)).filter((n): n is Node => !!n);
    if (!nodes.length) return null;
    return this.common({ ...base(uid('g'), this.nameOf(el)), type: 'group', children: nodes }, el, ctx.style, extra);
  }

  private nestedSvg(el: XmlElement, ctx: Context): Node | null {
    const width = this.length(el, 'width', ctx, 'x', ctx.viewport.width);
    const height = this.length(el, 'height', ctx, 'y', ctx.viewport.height);
    if (!(width > 0 && height > 0)) return null;
    const vb = numberList(el.attrs.viewBox);
    const fits = vb.length === 4 && vb[2]! > 0 && vb[3]! > 0;
    const extra = multiply(translate(this.length(el, 'x', ctx, 'x'), this.length(el, 'y', ctx, 'y')), fits ? viewBoxMatrix(vb, width, height, el.attrs.preserveAspectRatio) : identity());
    if (!['visible', 'auto'].includes(ctx.style.overflow ?? 'hidden')) this.warn('Вложенный <svg> не обрезает своё содержимое по своим границам.');
    const inner: Context = { style: ctx.style, viewport: fits ? { width: vb[2]!, height: vb[3]! } : { width, height } };
    return this.group(el, ctx, this.childElements(el), extra, inner);
  }

  private use(el: XmlElement, ctx: Context): Node | null {
    const href = el.attrs.href ?? el.attrs['xlink:href'] ?? '';
    if (!href.startsWith('#')) {
      this.warn(`<use> на внешний файл (${href || 'без ссылки'}) не перенесён.`);
      return null;
    }
    const target = this.ids.get(href.slice(1));
    if (!target) {
      this.warn(`<use>: элемента «${href}» нет в файле.`);
      return null;
    }
    if (this.using.has(target)) {
      this.warn(`<use> ссылается на себя же («${href}»); цикл прерван.`);
      return null;
    }
    this.using.add(target);
    try {
      const at = translate(this.length(el, 'x', ctx, 'x'), this.length(el, 'y', ctx, 'y'));
      let child: Node | null;
      if (localName(target) === 'symbol') {
        // A symbol is drawn like a nested <svg>, sized by the <use>.
        const style = this.style(target, ctx.style);
        const width = this.length(el, 'width', ctx, 'x', this.length(target, 'width', ctx, 'x', ctx.viewport.width));
        const height = this.length(el, 'height', ctx, 'y', this.length(target, 'height', ctx, 'y', ctx.viewport.height));
        const vb = numberList(target.attrs.viewBox);
        const fits = vb.length === 4 && vb[2]! > 0 && vb[3]! > 0 && width > 0 && height > 0;
        const inner: Context = { style, viewport: fits ? { width: vb[2]!, height: vb[3]! } : ctx.viewport };
        child = this.group(target, { style, viewport: ctx.viewport }, this.childElements(target), fits ? viewBoxMatrix(vb, width, height, target.attrs.preserveAspectRatio) : identity(), inner);
      } else child = this.node(target, ctx);
      if (!child) return null;
      const wrapper = this.common({ ...base(uid('g'), this.nameOf(el)), type: 'group' as const, children: [child] }, el, ctx.style, at);
      // One copy needs no group of its own: its transform and opacity fold into it (the
      // opacity of a group of one is the opacity of the one).
      if (this.blends.has(wrapper) || this.blends.has(child)) return wrapper;
      child.transform = multiply(wrapper.transform, child.transform);
      child.opacity *= wrapper.opacity;
      child.visible &&= wrapper.visible;
      if (wrapper.name) child.name = wrapper.name;
      return child;
    } finally {
      this.using.delete(target);
    }
  }

  private shape(el: XmlElement, kind: string, ctx: Context): Shape | null {
    const style = ctx.style;
    const len = (name: string, axis: Axis, fallback = 0) => this.length(el, name, ctx, axis, fallback);
    const paint = { fill: this.fill(style), stroke: this.stroke(style, ctx) };
    const name = this.nameOf(el);
    let shape: Shape;
    switch (kind) {
      case 'rect': {
        const [x, y, width, height] = [len('x', 'x'), len('y', 'y'), len('width', 'x'), len('height', 'y')];
        if (!(width > 0 && height > 0)) return null;
        let rx = len('rx', 'x', NaN);
        let ry = len('ry', 'y', NaN);
        if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
        if (Number.isNaN(ry)) ry = rx;
        rx = Math.max(0, Math.min(rx, width / 2));
        ry = Math.max(0, Math.min(ry, height / 2));
        if (Math.abs(rx - ry) < 1e-9) shape = { ...base(uid('r'), name), type: 'rect', ...paint, x, y, width, height, rx };
        else {
          // Corners of two radii: a path with an elliptical arc for each.
          const arc = (x1: number, y1: number, x2: number, y2: number) => arcSegments(x1, y1, rx, ry, 0, false, true, x2, y2);
          const segments: Segment[] = [
            ['M', x + rx, y],
            ['L', x + width - rx, y],
            ...arc(x + width - rx, y, x + width, y + ry),
            ['L', x + width, y + height - ry],
            ...arc(x + width, y + height - ry, x + width - rx, y + height),
            ['L', x + rx, y + height],
            ...arc(x + rx, y + height, x, y + height - ry),
            ['L', x, y + ry],
            ...arc(x, y + ry, x + rx, y),
            ['Z'],
          ];
          shape = { ...base(uid('p'), name), type: 'path', ...paint, segments, fillRule: 'nonzero' };
        }
        break;
      }
      case 'circle': {
        const r = len('r', 'xy');
        if (!(r > 0)) return null;
        shape = { ...base(uid('e'), name), type: 'ellipse', ...paint, cx: len('cx', 'x'), cy: len('cy', 'y'), rx: r, ry: r };
        break;
      }
      case 'ellipse': {
        let rx = len('rx', 'x', NaN);
        let ry = len('ry', 'y', NaN);
        if (Number.isNaN(rx)) rx = ry;
        if (Number.isNaN(ry)) ry = rx;
        if (!(rx > 0 && ry > 0)) return null;
        shape = { ...base(uid('e'), name), type: 'ellipse', ...paint, cx: len('cx', 'x'), cy: len('cy', 'y'), rx, ry };
        break;
      }
      case 'line':
        // A line has no inside to fill.
        shape = { ...base(uid('l'), name), type: 'line', fill: null, stroke: paint.stroke, x1: len('x1', 'x'), y1: len('y1', 'y'), x2: len('x2', 'x'), y2: len('y2', 'y') };
        break;
      case 'polyline':
      case 'polygon': {
        const n = numberList(el.attrs.points);
        if (n.length % 2) this.warn(`У <${kind}> нечётное число координат: последняя пропущена, как это делает браузер.`);
        const segments: Segment[] = [];
        for (let i = 0; i + 1 < n.length; i += 2) segments.push([i ? 'L' : 'M', n[i]!, n[i + 1]!]);
        if (segments.length < 2) return null;
        if (kind === 'polygon') segments.push(['Z']);
        shape = { ...base(uid('p'), name), type: 'path', ...paint, segments, fillRule: this.fillRule(style) };
        break;
      }
      default: {
        const { segments, error } = parsePathData(el.attrs.d ?? '');
        if (error) this.warn('В данных пути (d) ошибка: путь нарисован до неё, как это делает браузер.');
        if (segments.length < 2) return null;
        shape = { ...base(uid('p'), name), type: 'path', ...paint, segments, fillRule: this.fillRule(style) };
      }
    }
    if (kind !== 'rect' && kind !== 'circle' && kind !== 'ellipse' && ['marker-start', 'marker-mid', 'marker-end'].some((k) => (style[k] ?? 'none') !== 'none')) this.warn('Маркеры (стрелки на концах линий) не перенесены.');
    if (shape.stroke?.join === 'miter') this.checkMiter(shape, style);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') shape.visible = false;
    return this.common(shape, el, style);
  }

  // The model's miter limit is SVG's default, 4; another limit changes the picture only
  // where a corner is sharp enough for one limit to cut it and not the other.
  private checkMiter(shape: Shape, style: Style): void {
    const limit = parseFloat(style['stroke-miterlimit'] ?? '4');
    if (!(limit >= 1) || limit === SVG_MITER_LIMIT) return;
    const cut = (ratio: number, l: number) => ratio > l + 1e-9;
    const differs = (ratio: number) => cut(ratio, limit) !== cut(ratio, SVG_MITER_LIMIT);
    const corners = shape.type === 'rect' ? (shape.rx > 0 ? [] : [Math.SQRT2]) : shape.type === 'path' ? miterRatios(shape.segments) : shape.type === 'text' ? [Infinity] : [];
    if (corners.some(differs)) this.warn(`stroke-miterlimit="${limit}" заменён на ${SVG_MITER_LIMIT}: часть острых углов обводки срезана иначе, чем в файле.`);
  }

  private fillRule(style: Style): FillRule {
    return style['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero';
  }

  // A text, set in the built-in font. Its lines are the runs a <tspan> with its own y or
  // dy starts (Inkscape writes lines so); the first line's position is the text's.
  private text(el: XmlElement, ctx: Context): Node | null {
    const style = ctx.style;
    const size = Number(style['font-size']) || 16;
    const preserve = (el.attrs['xml:space'] ?? '') === 'preserve';
    interface TextLine {
      x: number;
      y: number;
      text: string;
    }
    const first = (s: string | undefined, axis: Axis, fallback: number, inherited: Style) => {
      const values = (s ?? '').trim().split(/[\s,]+/).filter(Boolean);
      if (values.length > 1) this.warn('Позиции отдельных букв текста (x, y, dx, dy списком) не перенесены.');
      const n = values.length ? parseLength(values[0], ctx.viewport, axis, Number(inherited['font-size'])) : NaN;
      return Number.isFinite(n) ? n : fallback;
    };
    const lines: TextLine[] = [{ x: first(el.attrs.x, 'x', 0, style) + first(el.attrs.dx, 'x', 0, style), y: first(el.attrs.y, 'y', 0, style) + first(el.attrs.dy, 'y', 0, style), text: '' }];
    let positioned = false;
    const keys = ['fill', 'stroke', 'font-size', 'font-family', 'font-weight', 'font-style', 'stroke-width'];
    const walk = (node: XmlElement, parentStyle: Style) => {
      for (const c of node.children) {
        if (typeof c === 'string') {
          lines[lines.length - 1]!.text += c;
          continue;
        }
        const k = localName(c);
        if (c.name.includes(':') && !c.name.startsWith('svg:')) continue;
        if (k !== 'tspan' && k !== 'textPath' && k !== 'a') {
          if (!NOT_DRAWN.has(k)) this.warn(`<${k}> внутри текста пропущен.`);
          continue;
        }
        if (k === 'textPath') this.warn('Текст по контуру (<textPath>) набран прямой строкой.');
        const s = this.style(c, parentStyle);
        if (keys.some((p) => s[p] !== style[p])) this.warn('Части текста со своим стилем набраны стилем всего текста.');
        const at = lines[lines.length - 1]!;
        if (c.attrs.y !== undefined || c.attrs.dy !== undefined) {
          const y = first(c.attrs.y, 'y', at.y, s) + first(c.attrs.dy, 'y', 0, s);
          const x = first(c.attrs.x, 'x', at.x, s) + first(c.attrs.dx, 'x', 0, s);
          // The first positioned run places the first line; each one after starts a line.
          if (positioned || at.text.trim()) lines.push({ x, y, text: '' });
          else Object.assign(at, { x, y });
          positioned = true;
        } else if (c.attrs.x !== undefined || c.attrs.dx !== undefined) this.warn('Сдвиги частей текста по горизонтали (x, dx у <tspan>) не перенесены.');
        walk(c, s);
      }
    };
    walk(el, style);
    for (const line of lines) {
      line.text = preserve ? line.text.replace(/[\r\n\t]/g, ' ') : line.text.replace(/[\r\n]/g, '').replace(/\t/g, ' ').replace(/ {2,}/g, ' ').trim();
    }
    if (!lines.some((l) => l.text)) return null;
    let lineHeight = 1.2;
    if (lines.length > 1) {
      const step = lines[1]!.y - lines[0]!.y;
      const even = lines.every((l, i) => Math.abs(l.y - lines[0]!.y - i * step) < 0.01 && Math.abs(l.x - lines[0]!.x) < 0.01);
      if (step > 0) lineHeight = step / size;
      if (!even || !(step > 0)) this.warn('Строки текста стоят неровно: расставлены с одинаковым шагом от первой.');
    }
    const family = (style['font-family'] ?? '').replace(/["']/g, '').trim();
    if (!/^inter\b/i.test(family)) this.warn(`Тексты набраны встроенным шрифтом Inter вместо ${family ? `«${family}»` : 'шрифта по умолчанию'}.`);
    const weight = style['font-weight'] ?? 'normal';
    if (weight === 'bold' || weight === 'bolder' || Number(weight) >= 600) this.warn('Полужирное начертание текста не перенесено: Inter встроен только обычный.');
    if (/italic|oblique/.test(style['font-style'] ?? '')) this.warn('Курсив не перенесён: Inter встроен только прямой.');
    const baseline = style['dominant-baseline'] ?? 'auto';
    if ((baseline !== 'auto' && baseline !== 'alphabetic') || (style['alignment-baseline'] ?? 'auto') !== 'auto' || (style['baseline-shift'] ?? 'baseline') !== 'baseline')
      this.warn('Выравнивание текста по иной линии, чем базовая, не перенесено.');
    const anchor = style['text-anchor'] ?? 'start';
    const align: TextAlign = anchor === 'middle' || anchor === 'end' ? anchor : 'start';
    const spacing = style['letter-spacing'] === 'normal' ? 0 : parseLength(style['letter-spacing'], ctx.viewport, 'x', size);
    const node: Shape = {
      ...base(uid('t'), this.nameOf(el)),
      type: 'text',
      fill: this.fill(style),
      stroke: this.stroke(style, ctx),
      text: lines.map((l) => l.text).join('\n'),
      x: lines[0]!.x,
      y: lines[0]!.y,
      font: BUILTIN_FONT,
      size,
      lineHeight,
      letterSpacing: Number.isFinite(spacing) ? spacing : 0,
      align,
    };
    if (node.stroke?.join === 'miter') this.checkMiter(node, style);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') node.visible = false;
    return this.common(node, el, style);
  }
}

// For every join of a path's outline, the miter length over the stroke width: 1 / sin(θ/2)
// for the angle θ between the two pieces.
function miterRatios(segments: Segment[]): number[] {
  const out: number[] = [];
  type V = [number, number];
  const unit = (x: number, y: number): V | null => {
    const l = Math.hypot(x, y);
    return l > 1e-12 ? [x / l, y / l] : null;
  };
  const join = (into: V | null, from: V | null) => {
    if (!into || !from) return;
    const cos = -(into[0] * from[0] + into[1] * from[1]);
    const s = Math.sqrt(Math.max(0, (1 - cos) / 2));
    out.push(s > 1e-12 ? 1 / s : Infinity);
  };
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let first: V | null = null;
  let last: V | null = null;
  for (const s of segments) {
    let start: V | null = null;
    let end: V | null = null;
    let to: V = [x, y];
    switch (s[0]) {
      case 'M':
        [x, y, sx, sy] = [s[1], s[2], s[1], s[2]];
        first = last = null;
        continue;
      case 'L':
        to = [s[1], s[2]];
        start = end = unit(s[1] - x, s[2] - y);
        break;
      case 'Q':
        to = [s[3], s[4]];
        start = unit(s[1] - x, s[2] - y) ?? unit(s[3] - x, s[4] - y);
        end = unit(s[3] - s[1], s[4] - s[2]) ?? unit(s[3] - x, s[4] - y);
        break;
      case 'C':
        to = [s[5], s[6]];
        start = unit(s[1] - x, s[2] - y) ?? unit(s[3] - x, s[4] - y) ?? unit(s[5] - x, s[6] - y);
        end = unit(s[5] - s[3], s[6] - s[4]) ?? unit(s[5] - s[1], s[6] - s[2]) ?? unit(s[5] - x, s[6] - y);
        break;
      case 'Z': {
        const closing = unit(sx - x, sy - y);
        if (closing) {
          join(last, closing);
          last = closing;
        }
        join(last, first);
        [x, y] = [sx, sy];
        first = last = null;
        continue;
      }
    }
    if (!start) continue;
    join(last, start);
    first ??= start;
    last = end;
    [x, y] = to;
  }
  return out;
}

// `m` applied to a node from outside: into its geometry when it only moves it, as a drag
// would, otherwise into its matrix.
function place(node: Node, m: Matrix): Node {
  if (isIdentity(m)) return node;
  if (Math.abs(m[0] - 1) < 1e-12 && Math.abs(m[1]) < 1e-12 && Math.abs(m[2]) < 1e-12 && Math.abs(m[3] - 1) < 1e-12) return { ...node, ...transformValues(node, identity(), m) } as Node;
  return { ...node, transform: multiply(m, node.transform) };
}

export function importSvg(text: string): ImportResult {
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch (error) {
    if (error instanceof XmlError) throw new SvgImportError(`Не XML: ${error.message}`);
    throw error;
  }
  if (localName(root) !== 'svg') throw new SvgImportError(`Это не SVG: корневой элемент <${root.name}>, а не <svg>.`);
  const im = new Importer(root);

  // The page: the viewBox, or the width and height, or a browser's default 300 × 150.
  const vb = numberList(root.attrs.viewBox);
  const style = im.style(root, {});
  const outer: Viewport = { width: 300, height: 150 };
  const sized = (name: 'width' | 'height') => {
    const v = root.attrs[name];
    return v && !v.trim().endsWith('%') ? parseLength(v, outer, name === 'width' ? 'x' : 'y', Number(style['font-size'])) : NaN;
  };
  let width: number;
  let height: number;
  let page: Matrix;
  if (vb.length === 4 && vb[2]! > 0 && vb[3]! > 0) {
    [width, height] = [vb[2]!, vb[3]!];
    page = translate(-vb[0]!, -vb[1]!);
  } else {
    width = sized('width');
    height = sized('height');
    if (!(width > 0)) width = 300;
    if (!(height > 0)) height = 150;
    page = identity();
  }
  const t = root.attrs.transform ? parseTransform(root.attrs.transform) : null;
  if (t) page = multiply(page, t);
  const ctx: Context = { style, viewport: { width, height } };
  if (style.display === 'none') im.warn('Корневой <svg> скрыт (display: none); содержимое перенесено видимым.');
  for (const effect of ['clip-path', 'mask', 'filter'] as const) if ((style[effect] ?? 'none') !== 'none') im.warn(`${effect} у корневого <svg> не поддерживается.`);

  const top: Node[] = [];
  for (const c of root.children) if (typeof c !== 'string') {
    const n = im.node(c, ctx);
    if (n) top.push(n);
  }

  // A rectangle under everything that fills the page with one opaque colour is its
  // background, as this editor's export writes it.
  let background: string | null = null;
  const bottom = top[0];
  if (bottom?.type === 'rect' && top.length > 1) {
    const r = place(bottom, page) as typeof bottom;
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    if (r.visible && r.opacity === 1 && r.rx === 0 && !r.stroke && r.fill?.opacity === 1 && isIdentity(r.transform) && near(r.x, 0) && near(r.y, 0) && near(r.width, width) && near(r.height, height) && !im.blends.has(bottom)) {
      background = r.fill.color;
      top.shift();
    }
  }

  // Layers: top-level <g> elements, when there is nothing else at the top.
  const isLayer = (n: Node) => n.type === 'group' && localName(im.sources.get(n)!) === 'g';
  const layers: Layer[] = [];
  const layerIds = new Set<string>();
  if (top.length && top.every(isLayer)) {
    for (const g of top as Group[]) {
      const el = im.sources.get(g)!;
      const blend = im.blends.get(g);
      im.blends.delete(g);
      const layer = createLayer(g.name ?? `Слой ${layers.length + 1}`);
      if (el.attrs.id && !layerIds.has(el.attrs.id)) layer.id = el.attrs.id;
      layerIds.add(layer.id);
      layer.visible = g.visible;
      layer.locked = el.attrs['sodipodi:insensitive'] === 'true';
      layer.opacity = g.opacity;
      if (blend) {
        layer.blend = blendOf(blend) ?? 'normal';
        if (!blendOf(blend)) im.warn(`Режим наложения ${blend} заменён обычным: в редакторе есть normal, multiply и screen.`);
      }
      const m = multiply(page, g.transform);
      layer.children = g.children.map((c) => place(c, m));
      layers.push(layer);
    }
  } else if (top.length) {
    const layer = createLayer('Слой 1');
    layer.children = top.map((n) => place(n, page));
    layers.push(layer);
  }
  if (!layers.length) {
    layers.push(createLayer('Слой 1'));
    im.warn('В файле нечего рисовать.');
  }
  // Only layers blend; nodes keep the place, not the mode.
  for (const mode of im.blends.values()) im.warn(`Режим наложения ${mode} у объекта внутри слоя не поддерживается: только у слоёв.`);
  const rootOpacity = opacityValue(style.opacity);
  if (rootOpacity < 1) {
    for (const l of layers) l.opacity *= rootOpacity;
    if (layers.length > 1) im.warn('Прозрачность корневого <svg> разнесена по слоям: где слои перекрываются, картинка светлее.');
  }

  const doc: Document = { version: DOCUMENT_VERSION, width, height, background, layers, fonts: [] };
  return { doc, warnings: im.warnings() };
}

// An imported document as one group, for placing into another document: its layers
// become groups (their opacity kept, their blend mode not) and its background a rectangle.
export function documentAsGroup(doc: Document, name: string): { group: Group; warnings: string[] } {
  const warnings: string[] = [];
  const children: Node[] = [];
  if (doc.background) children.push({ ...base(uid('r'), 'Фон'), type: 'rect', fill: { color: doc.background, opacity: 1 }, stroke: null, x: 0, y: 0, width: doc.width, height: doc.height, rx: 0 });
  for (const l of doc.layers) {
    if (l.blend !== 'normal') warnings.push(`Слой «${l.name}»: режим наложения ${l.blend} есть только у слоёв, а импорт кладёт слои группами — он пропал.`);
    if (doc.layers.length === 1 && l.opacity === 1 && l.visible) children.push(...l.children);
    else if (l.children.length) children.push({ ...base(uid('g'), l.name), type: 'group', visible: l.visible, opacity: l.opacity, children: l.children });
  }
  return { group: { ...base(uid('g'), name), type: 'group', children }, warnings };
}
