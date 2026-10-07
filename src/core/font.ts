// Reading OpenType fonts: TrueType outlines (glyf) and CFF ones, a .ttc collection's first
// face. Only what laying out a line of text needs — the character map, advances, kerning
// (the kern table and GPOS pair adjustments of the `kern` feature) and the outlines as
// path segments. No shaping beyond that: no ligatures, no right-to-left, no marks.
//
// Text is drawn by these outlines everywhere — the renderer, the SVG, the shader — so the
// three agree whatever fonts the machine that shows them has.

import type { Segment } from './types';

export class FontError extends Error {}

export interface Glyph {
  advance: number;
  // In font units, Y up, as the font has them.
  segments: Segment[];
}

export interface Font {
  family: string;
  style: string;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  numGlyphs: number;
  glyphIndex(codePoint: number): number;
  glyph(index: number): Glyph;
  // Advance adjustments of the first and the second glyph of a pair, in font units.
  kerning(left: number, right: number): [number, number];
}

class Reader {
  constructor(
    readonly data: DataView,
    public pos = 0,
  ) {}
  u8 = () => this.data.getUint8(this.pos++);
  i8 = () => this.data.getInt8(this.pos++);
  u16 = () => ((this.pos += 2), this.data.getUint16(this.pos - 2));
  i16 = () => ((this.pos += 2), this.data.getInt16(this.pos - 2));
  u32 = () => ((this.pos += 4), this.data.getUint32(this.pos - 4));
  i32 = () => ((this.pos += 4), this.data.getInt32(this.pos - 4));
  tag = () => String.fromCharCode(this.u8(), this.u8(), this.u8(), this.u8());
  at(pos: number): Reader {
    return new Reader(this.data, pos);
  }
}

const f2dot14 = (r: Reader) => r.i16() / 16384;

export function parseFont(bytes: Uint8Array): Font {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    return readFont(view);
  } catch (error) {
    if (error instanceof FontError) throw error;
    // A read past the end, a bad offset: the file is not what it says.
    throw new FontError(`Повреждённый файл шрифта (${(error as Error).message})`);
  }
}

function readFont(view: DataView): Font {
  if (view.byteLength < 12) throw new FontError('Это не файл шрифта');
  let r = new Reader(view);
  let tag = r.tag();
  if (tag === 'ttcf') {
    // A collection: its first face.
    r.u32();
    if (r.u32() < 1) throw new FontError('Пустая коллекция шрифтов');
    r = r.at(r.u32());
    tag = r.tag();
  }
  if (tag === 'wOFF' || tag === 'wOF2') throw new FontError('WOFF и WOFF2 не поддерживаются — нужен TTF или OTF');
  if (tag !== '\0\x01\0\0' && tag !== 'true' && tag !== 'OTTO') throw new FontError('Это не файл шрифта TrueType или OpenType');
  const numTables = r.u16();
  r.pos += 6;
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i++) {
    const t = r.tag();
    r.u32();
    const offset = r.u32();
    const length = r.u32();
    if (offset + length > view.byteLength) throw new FontError(`Таблица ${t.trim()} выходит за конец файла`);
    tables.set(t, { offset, length });
  }
  const table = (t: string, required = true): Reader | null => {
    const at = tables.get(t);
    if (!at) {
      if (required) throw new FontError(`В шрифте нет таблицы ${t.trim()}`);
      return null;
    }
    return r.at(at.offset);
  };

  const head = table('head')!;
  head.pos += 18;
  const unitsPerEm = head.u16();
  if (unitsPerEm < 16 || unitsPerEm > 16384) throw new FontError(`Неверный размер em: ${unitsPerEm}`);
  head.pos += 30;
  const longLoca = head.i16() === 1;

  const hhea = table('hhea')!;
  hhea.pos += 4;
  const ascender = hhea.i16();
  const descender = hhea.i16();
  hhea.pos += 26;
  const numberOfHMetrics = hhea.u16();

  const maxp = table('maxp')!;
  maxp.pos += 4;
  const numGlyphs = maxp.u16();

  const hmtx = table('hmtx')!;
  const advances = new Uint16Array(numGlyphs);
  for (let i = 0; i < numGlyphs; i++) {
    if (i < numberOfHMetrics) {
      advances[i] = hmtx.u16();
      hmtx.pos += 2;
    } else advances[i] = advances[numberOfHMetrics - 1] ?? 0;
  }

  const cmap = readCmap(table('cmap')!);
  const names = readNames(table('name', false));

  let outline: (index: number) => Segment[];
  if (tables.has('glyf')) {
    const loca = table('loca')!;
    const offsets = new Uint32Array(numGlyphs + 1);
    for (let i = 0; i <= numGlyphs; i++) offsets[i] = longLoca ? loca.u32() : loca.u16() * 2;
    const glyf = tables.get('glyf')!;
    outline = (index) => trueTypeOutline(r, glyf.offset, offsets, index, 0);
  } else if (tables.has('CFF ')) {
    outline = cffOutlines(table('CFF ')!, unitsPerEm);
  } else if (tables.has('CFF2')) throw new FontError('Вариативные шрифты CFF2 не поддерживаются');
  else throw new FontError('В шрифте нет контуров глифов');

  const kerning = gposKerning(table('GPOS', false)) ?? kernTable(table('kern', false)) ?? (() => [0, 0] as [number, number]);

  const glyphs = new Map<number, Glyph>();
  return {
    family: names.family || 'Шрифт',
    style: names.style || 'Regular',
    unitsPerEm,
    ascender,
    descender,
    numGlyphs,
    glyphIndex: (cp) => {
      const g = cmap(cp);
      return g < numGlyphs ? g : 0;
    },
    glyph(index) {
      let g = glyphs.get(index);
      if (!g) {
        const i = index >= 0 && index < numGlyphs ? index : 0;
        g = { advance: advances[i]!, segments: outline(i) };
        glyphs.set(index, g);
      }
      return g;
    },
    kerning,
  };
}

// ---- Character map

function readCmap(t: Reader): (cp: number) => number {
  const base = t.pos;
  t.u16();
  const count = t.u16();
  const subtables: { platform: number; encoding: number; offset: number }[] = [];
  for (let i = 0; i < count; i++) subtables.push({ platform: t.u16(), encoding: t.u16(), offset: t.u32() });
  const rank = (s: { platform: number; encoding: number }, format: number) => {
    if (format === 12 && (s.platform === 0 || (s.platform === 3 && s.encoding === 10))) return 3;
    if (format === 4 && (s.platform === 0 || (s.platform === 3 && s.encoding === 1))) return 2;
    if (format === 4 && s.platform === 3 && s.encoding === 0) return 1;
    return 0;
  };
  let best: { r: Reader; format: number } | null = null;
  let bestRank = 0;
  for (const s of subtables) {
    const r = t.at(base + s.offset);
    const format = r.data.getUint16(r.pos);
    const k = rank(s, format);
    if (k > bestRank) {
      bestRank = k;
      best = { r, format };
    }
  }
  if (!best) throw new FontError('В шрифте нет юникодной таблицы символов');
  const { r, format } = best;
  const start = r.pos;
  if (format === 4) {
    const segX2 = r.at(start + 6).u16();
    const ends = start + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const rangeOffsets = deltas + segX2;
    const n = segX2 / 2;
    const v = r.data;
    return (cp) => {
      if (cp > 0xffff) return 0;
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (v.getUint16(ends + mid * 2) < cp) lo = mid + 1;
        else hi = mid;
      }
      if (v.getUint16(starts + lo * 2) > cp || v.getUint16(ends + lo * 2) < cp) return 0;
      const delta = v.getInt16(deltas + lo * 2);
      const ro = v.getUint16(rangeOffsets + lo * 2);
      if (!ro) return (cp + delta) & 0xffff;
      const g = v.getUint16(rangeOffsets + lo * 2 + ro + (cp - v.getUint16(starts + lo * 2)) * 2);
      return g ? (g + delta) & 0xffff : 0;
    };
  }
  const groups = r.at(start + 12).u32();
  const v = r.data;
  const at = start + 16;
  return (cp) => {
    let lo = 0;
    let hi = groups - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const g = at + mid * 12;
      if (v.getUint32(g + 4) < cp) lo = mid + 1;
      else if (v.getUint32(g) > cp) hi = mid - 1;
      else return v.getUint32(g + 8) + cp - v.getUint32(g);
    }
    return 0;
  };
}

// ---- Names

function readNames(t: Reader | null): { family: string; style: string } {
  if (!t) return { family: '', style: '' };
  const base = t.pos;
  t.u16();
  const count = t.u16();
  const strings = base + t.u16();
  const found = new Map<number, { text: string; score: number }>();
  for (let i = 0; i < count; i++) {
    const platform = t.u16();
    const encoding = t.u16();
    const language = t.u16();
    const id = t.u16();
    const length = t.u16();
    const offset = t.u16();
    if (![1, 2, 16, 17].includes(id)) continue;
    let text = '';
    let score = 0;
    const s = t.at(strings + offset);
    if (platform === 3 || platform === 0) {
      for (let k = 0; k < length / 2; k++) text += String.fromCharCode(s.u16());
      score = platform === 3 && language === 0x409 ? 3 : 2;
    } else if (platform === 1 && encoding === 0) {
      for (let k = 0; k < length; k++) text += String.fromCharCode(s.u8());
      score = 1;
    } else continue;
    const have = found.get(id);
    if (!have || have.score < score) found.set(id, { text, score });
  }
  return { family: (found.get(16) ?? found.get(1))?.text ?? '', style: (found.get(17) ?? found.get(2))?.text ?? '' };
}

// ---- TrueType outlines

function trueTypeOutline(r: Reader, glyfOffset: number, loca: Uint32Array, index: number, depth: number): Segment[] {
  const start = loca[index]!;
  const end = loca[index + 1]!;
  if (end <= start || depth > 8) return [];
  const g = r.at(glyfOffset + start);
  const contours = g.i16();
  g.pos += 8;
  if (contours >= 0) return simpleGlyph(g, contours);
  // A composite: other glyphs, each placed by its own matrix.
  const out: Segment[] = [];
  for (;;) {
    const flags = g.u16();
    const component = g.u16();
    let dx: number;
    let dy: number;
    if (flags & 1) {
      dx = g.i16();
      dy = g.i16();
    } else {
      dx = g.i8();
      dy = g.i8();
    }
    // Points matched by number rather than offsets: rare, placed without the offset.
    if (!(flags & 2)) dx = dy = 0;
    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    if (flags & 8) a = d = f2dot14(g);
    else if (flags & 0x40) {
      a = f2dot14(g);
      d = f2dot14(g);
    } else if (flags & 0x80) {
      a = f2dot14(g);
      b = f2dot14(g);
      c = f2dot14(g);
      d = f2dot14(g);
    }
    if (flags & 0x800) {
      // Offsets in the component's own scaled space (Apple's reading).
      const x = dx;
      dx = a * x + c * dy;
      dy = b * x + d * dy;
    }
    for (const s of trueTypeOutline(r, glyfOffset, loca, component, depth + 1)) out.push(mapSegment(s, a, b, c, d, dx, dy));
    if (!(flags & 0x20)) break;
  }
  return out;
}

function mapSegment(s: Segment, a: number, b: number, c: number, d: number, e: number, f: number): Segment {
  const n = s.length;
  const out = [s[0]] as unknown[];
  for (let i = 1; i < n; i += 2) {
    const x = s[i] as number;
    const y = s[i + 1] as number;
    out.push(a * x + c * y + e, b * x + d * y + f);
  }
  return out as Segment;
}

function simpleGlyph(g: Reader, contours: number): Segment[] {
  const ends: number[] = [];
  for (let i = 0; i < contours; i++) ends.push(g.u16());
  const count = contours ? ends[contours - 1]! + 1 : 0;
  const instructions = g.u16();
  g.pos += instructions;
  const flags = new Uint8Array(count);
  for (let i = 0; i < count; ) {
    const f = g.u8();
    flags[i++] = f;
    if (f & 8) for (let k = g.u8(); k > 0 && i < count; k--) flags[i++] = f;
  }
  const coords = (short: number, same: number) => {
    const out = new Float64Array(count);
    let v = 0;
    for (let i = 0; i < count; i++) {
      const f = flags[i]!;
      if (f & short) v += f & same ? g.u8() : -g.u8();
      else if (!(f & same)) v += g.i16();
      out[i] = v;
    }
    return out;
  };
  const xs = coords(2, 16);
  const ys = coords(4, 32);
  const out: Segment[] = [];
  let first = 0;
  for (const last of ends) {
    quadraticContour(xs, ys, flags, first, last, out);
    first = last + 1;
  }
  return out;
}

// A contour of on- and off-curve points; two off-curve points in a row have an on-curve
// one implied halfway between them.
function quadraticContour(xs: Float64Array, ys: Float64Array, flags: Uint8Array, first: number, last: number, out: Segment[]): void {
  const n = last - first + 1;
  if (n < 2) return;
  const on = (i: number) => (flags[first + (i % n)]! & 1) !== 0;
  const pt = (i: number): [number, number] => [xs[first + (i % n)]!, ys[first + (i % n)]!];
  // Start on a point of the curve; with none at all, halfway between the first two.
  let k = 0;
  while (k < n && !on(k)) k++;
  let start: [number, number];
  let rest: number;
  if (k < n) {
    start = pt(k);
    rest = n - 1;
  } else {
    const [ax, ay] = pt(0);
    const [bx, by] = pt(1);
    start = [(ax + bx) / 2, (ay + by) / 2];
    k = 0;
    rest = n;
  }
  out.push(['M', start[0], start[1]]);
  let control: [number, number] | null = null;
  for (let i = 1; i <= rest; i++) {
    const p = pt(k + i);
    if (on(k + i)) {
      out.push(control ? ['Q', control[0], control[1], p[0], p[1]] : ['L', p[0], p[1]]);
      control = null;
    } else {
      if (control) out.push(['Q', control[0], control[1], (control[0] + p[0]) / 2, (control[1] + p[1]) / 2]);
      control = p;
    }
  }
  if (control) out.push(['Q', control[0], control[1], start[0], start[1]]);
  out.push(['Z']);
}

// ---- CFF outlines

interface CffIndex {
  count: number;
  item(i: number): [number, number];
  end: number;
}

function cffIndex(r: Reader, pos: number): CffIndex {
  const v = r.data;
  const count = v.getUint16(pos);
  if (!count) return { count: 0, item: () => [0, 0], end: pos + 2 };
  const offSize = v.getUint8(pos + 2);
  const offsetAt = (i: number) => {
    let o = 0;
    for (let k = 0; k < offSize; k++) o = o * 256 + v.getUint8(pos + 3 + i * offSize + k);
    return o;
  };
  const data = pos + 3 + (count + 1) * offSize - 1;
  return { count, item: (i) => [data + offsetAt(i), data + offsetAt(i + 1)], end: data + offsetAt(count) };
}

function cffDict(r: Reader, start: number, end: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const v = r.data;
  let operands: number[] = [];
  let p = start;
  while (p < end) {
    const b0 = v.getUint8(p++);
    if (b0 <= 21) {
      let op = b0;
      if (b0 === 12) op = 1200 + v.getUint8(p++);
      out.set(op, operands);
      operands = [];
    } else if (b0 === 28) {
      operands.push(v.getInt16(p));
      p += 2;
    } else if (b0 === 29) {
      operands.push(v.getInt32(p));
      p += 4;
    } else if (b0 === 30) {
      let s = '';
      for (let done = false; !done; ) {
        const b = v.getUint8(p++);
        for (const nib of [b >> 4, b & 15]) {
          if (nib === 15) {
            done = true;
            break;
          }
          s += ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', 'E', 'E-', '', '-'][nib];
        }
      }
      operands.push(Number(s));
    } else if (b0 >= 32 && b0 <= 246) operands.push(b0 - 139);
    else if (b0 >= 247 && b0 <= 250) operands.push((b0 - 247) * 256 + v.getUint8(p++) + 108);
    else if (b0 >= 251 && b0 <= 254) operands.push(-(b0 - 251) * 256 - v.getUint8(p++) - 108);
  }
  return out;
}

const subrBias = (count: number) => (count < 1240 ? 107 : count < 33900 ? 1131 : 32768);

function cffOutlines(t: Reader, unitsPerEm: number): (index: number) => Segment[] {
  const base = t.pos;
  const v = t.data;
  const names = cffIndex(t, base + v.getUint8(base + 2));
  const topDicts = cffIndex(t, names.end);
  const strings = cffIndex(t, topDicts.end);
  const gsubrs = cffIndex(t, strings.end);
  const [ts, te] = topDicts.item(0);
  const top = cffDict(t, ts, te);
  if ((top.get(1206)?.[0] ?? 2) !== 2) throw new FontError('Глифы CFF не второго типа');
  const charStrings = cffIndex(t, base + (top.get(17)?.[0] ?? 0));
  const matrix = top.get(1207);
  // Outline units per font unit: 1 unless the FontMatrix says otherwise.
  const k = matrix ? matrix[0]! * unitsPerEm : 1;
  const privateSubrs = (dict: Map<number, number[]>): CffIndex | null => {
    const p = dict.get(18);
    if (!p || p.length < 2) return null;
    const [size, offset] = p as [number, number];
    const priv = cffDict(t, base + offset, base + offset + size);
    const subrs = priv.get(19)?.[0];
    return subrs ? cffIndex(t, base + offset + subrs) : null;
  };
  let localFor: (glyph: number) => CffIndex | null;
  if (top.has(1236)) {
    // CID-keyed: each glyph's font dictionary, by FDSelect, has its own subroutines.
    const fdArray = cffIndex(t, base + top.get(1236)![0]!);
    const fds: (CffIndex | null)[] = [];
    for (let i = 0; i < fdArray.count; i++) {
      const [s, e] = fdArray.item(i);
      fds.push(privateSubrs(cffDict(t, s, e)));
    }
    const sel = base + (top.get(1237)?.[0] ?? 0);
    const format = v.getUint8(sel);
    localFor = (glyph) => {
      if (format === 0) return fds[v.getUint8(sel + 1 + glyph)] ?? null;
      const ranges = v.getUint16(sel + 1);
      for (let i = 0; i < ranges; i++) {
        const first = v.getUint16(sel + 3 + i * 3);
        const next = v.getUint16(sel + 3 + (i + 1) * 3);
        if (glyph >= first && glyph < next) return fds[v.getUint8(sel + 5 + i * 3)] ?? null;
      }
      return null;
    };
  } else {
    const subrs = privateSubrs(top);
    localFor = () => subrs;
  }
  return (index) => {
    if (index >= charStrings.count) return [];
    const segs = type2(t, charStrings.item(index), gsubrs, localFor(index));
    return k === 1 ? segs : segs.map((s) => mapSegment(s, k, 0, 0, k, 0, 0));
  };
}

// The Type 2 charstring interpreter: hints are skipped, only the path is kept.
function type2(t: Reader, [start, end]: [number, number], gsubrs: CffIndex, lsubrs: CffIndex | null): Segment[] {
  const v = t.data;
  const out: Segment[] = [];
  const stack: number[] = [];
  let x = 0;
  let y = 0;
  let stems = 0;
  let open = false;
  let widthDone = false;
  let depth = 0;
  const close = () => {
    if (open) out.push(['Z']);
    open = false;
  };
  const moveTo = (dx: number, dy: number) => {
    close();
    x += dx;
    y += dy;
    out.push(['M', x, y]);
    open = true;
  };
  const lineTo = (dx: number, dy: number) => {
    x += dx;
    y += dy;
    out.push(['L', x, y]);
  };
  const curveTo = (a: number, b: number, c: number, d: number, e: number, f: number) => {
    const x1 = x + a;
    const y1 = y + b;
    const x2 = x1 + c;
    const y2 = y1 + d;
    x = x2 + e;
    y = y2 + f;
    out.push(['C', x1, y1, x2, y2, x, y]);
  };
  // The first stack-clearing operator may carry the advance width first; it is not needed.
  const width = (even: boolean) => {
    if (!widthDone && stack.length % 2 === (even ? 1 : 0)) stack.shift();
    widthDone = true;
  };
  const run = (from: number, to: number): boolean => {
    if (++depth > 10) throw new FontError('Слишком глубокие подпрограммы CFF');
    let p = from;
    while (p < to) {
      const b0 = v.getUint8(p++);
      if (b0 >= 32 || b0 === 28) {
        if (b0 === 28) {
          stack.push(v.getInt16(p));
          p += 2;
        } else if (b0 <= 246) stack.push(b0 - 139);
        else if (b0 <= 250) stack.push((b0 - 247) * 256 + v.getUint8(p++) + 108);
        else if (b0 <= 254) stack.push(-(b0 - 251) * 256 - v.getUint8(p++) - 108);
        else {
          stack.push(v.getInt32(p) / 65536);
          p += 4;
        }
        continue;
      }
      switch (b0) {
        case 1:
        case 3:
        case 18:
        case 23:
          width(true);
          stems += stack.length >> 1;
          stack.length = 0;
          break;
        case 19:
        case 20:
          width(true);
          stems += stack.length >> 1;
          stack.length = 0;
          p += (stems + 7) >> 3;
          break;
        case 21:
          width(true);
          moveTo(stack[stack.length - 2]!, stack[stack.length - 1]!);
          stack.length = 0;
          break;
        case 22:
          width(false);
          moveTo(stack[stack.length - 1]!, 0);
          stack.length = 0;
          break;
        case 4:
          width(false);
          moveTo(0, stack[stack.length - 1]!);
          stack.length = 0;
          break;
        case 5:
          for (let i = 0; i + 1 < stack.length; i += 2) lineTo(stack[i]!, stack[i + 1]!);
          stack.length = 0;
          break;
        case 6:
        case 7: {
          let horizontal = b0 === 6;
          for (const d of stack) {
            if (horizontal) lineTo(d, 0);
            else lineTo(0, d);
            horizontal = !horizontal;
          }
          stack.length = 0;
          break;
        }
        case 8:
          for (let i = 0; i + 5 < stack.length; i += 6) curveTo(stack[i]!, stack[i + 1]!, stack[i + 2]!, stack[i + 3]!, stack[i + 4]!, stack[i + 5]!);
          stack.length = 0;
          break;
        case 24: {
          let i = 0;
          for (; i + 7 < stack.length; i += 6) curveTo(stack[i]!, stack[i + 1]!, stack[i + 2]!, stack[i + 3]!, stack[i + 4]!, stack[i + 5]!);
          lineTo(stack[i]!, stack[i + 1]!);
          stack.length = 0;
          break;
        }
        case 25: {
          let i = 0;
          for (; i + 7 < stack.length; i += 2) lineTo(stack[i]!, stack[i + 1]!);
          curveTo(stack[i]!, stack[i + 1]!, stack[i + 2]!, stack[i + 3]!, stack[i + 4]!, stack[i + 5]!);
          stack.length = 0;
          break;
        }
        case 26: {
          let i = 0;
          let dx1 = 0;
          if (stack.length % 4) dx1 = stack[i++]!;
          for (; i + 3 < stack.length; i += 4) {
            curveTo(dx1, stack[i]!, stack[i + 1]!, stack[i + 2]!, 0, stack[i + 3]!);
            dx1 = 0;
          }
          stack.length = 0;
          break;
        }
        case 27: {
          let i = 0;
          let dy1 = 0;
          if (stack.length % 4) dy1 = stack[i++]!;
          for (; i + 3 < stack.length; i += 4) {
            curveTo(stack[i]!, dy1, stack[i + 1]!, stack[i + 2]!, stack[i + 3]!, 0);
            dy1 = 0;
          }
          stack.length = 0;
          break;
        }
        case 30:
        case 31: {
          let horizontal = b0 === 31;
          let i = 0;
          while (i + 3 < stack.length) {
            const last = stack.length - i === 5;
            const extra = last ? stack[i + 4]! : 0;
            if (horizontal) curveTo(stack[i]!, 0, stack[i + 1]!, stack[i + 2]!, extra, stack[i + 3]!);
            else curveTo(0, stack[i]!, stack[i + 1]!, stack[i + 2]!, stack[i + 3]!, extra);
            i += last ? 5 : 4;
            horizontal = !horizontal;
          }
          stack.length = 0;
          break;
        }
        case 10:
        case 29: {
          const subrs = b0 === 10 ? lsubrs : gsubrs;
          const n = stack.pop()!;
          if (!subrs) throw new FontError('Вызов несуществующей подпрограммы CFF');
          const i = n + subrBias(subrs.count);
          if (i < 0 || i >= subrs.count) throw new FontError('Номер подпрограммы CFF вне таблицы');
          const [s, e] = subrs.item(i);
          if (run(s, e)) {
            depth--;
            return true;
          }
          break;
        }
        case 11:
          depth--;
          return false;
        case 14:
          width(true);
          close();
          stack.length = 0;
          depth--;
          return true;
        case 12: {
          const op = v.getUint8(p++);
          const s = stack;
          if (op === 35) {
            curveTo(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, s[5]!);
            curveTo(s[6]!, s[7]!, s[8]!, s[9]!, s[10]!, s[11]!);
          } else if (op === 34) {
            const y0 = y;
            curveTo(s[0]!, 0, s[1]!, s[2]!, s[3]!, 0);
            curveTo(s[4]!, 0, s[5]!, y0 - y, s[6]!, 0);
          } else if (op === 36) {
            const y0 = y;
            curveTo(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, 0);
            curveTo(s[5]!, 0, s[6]!, s[7]!, s[8]!, y0 - y - s[7]!);
          } else if (op === 37) {
            // The last delta goes along the flex's longer direction; the other comes back.
            const dx = s[0]! + s[2]! + s[4]! + s[6]! + s[8]!;
            const dy = s[1]! + s[3]! + s[5]! + s[7]! + s[9]!;
            curveTo(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, s[5]!);
            if (Math.abs(dx) > Math.abs(dy)) curveTo(s[6]!, s[7]!, s[8]!, s[9]!, s[10]!, -dy);
            else curveTo(s[6]!, s[7]!, s[8]!, s[9]!, -dx, s[10]!);
          }
          // Arithmetic and storage operators do not occur in fonts made today.
          stack.length = 0;
          break;
        }
        default:
          stack.length = 0;
      }
    }
    depth--;
    return false;
  };
  run(start, end);
  close();
  return out;
}

// ---- Kerning

function coverageIndex(r: Reader, pos: number, glyph: number): number {
  const v = r.data;
  const format = v.getUint16(pos);
  const count = v.getUint16(pos + 2);
  let lo = 0;
  let hi = count - 1;
  if (format === 1) {
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const g = v.getUint16(pos + 4 + mid * 2);
      if (g < glyph) lo = mid + 1;
      else if (g > glyph) hi = mid - 1;
      else return mid;
    }
    return -1;
  }
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = pos + 4 + mid * 6;
    if (v.getUint16(at + 2) < glyph) lo = mid + 1;
    else if (v.getUint16(at) > glyph) hi = mid - 1;
    else return v.getUint16(at + 4) + glyph - v.getUint16(at);
  }
  return -1;
}

function classOf(r: Reader, pos: number, glyph: number): number {
  const v = r.data;
  const format = v.getUint16(pos);
  if (format === 1) {
    const first = v.getUint16(pos + 2);
    const count = v.getUint16(pos + 4);
    return glyph >= first && glyph < first + count ? v.getUint16(pos + 6 + (glyph - first) * 2) : 0;
  }
  const count = v.getUint16(pos + 2);
  let lo = 0;
  let hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = pos + 4 + mid * 6;
    if (v.getUint16(at + 2) < glyph) lo = mid + 1;
    else if (v.getUint16(at) > glyph) hi = mid - 1;
    else return v.getUint16(at + 4);
  }
  return 0;
}

const valueSize = (format: number) => {
  let n = 0;
  for (let f = format & 0xff; f; f >>= 1) n += f & 1;
  return n * 2;
};

// The X advance in a value record, if the record has one (it follows any X/Y placement).
function xAdvance(v: DataView, pos: number, format: number): number {
  if (!(format & 4)) return 0;
  return v.getInt16(pos + ((format & 1) + ((format >> 1) & 1)) * 2);
}

// Pair adjustments of every lookup the `kern` feature uses, applied in lookup order: each
// lookup adds the value of its first subtable that has the pair.
function gposKerning(t: Reader | null): ((l: number, r: number) => [number, number]) | null {
  if (!t) return null;
  const base = t.pos;
  const v = t.data;
  const featureList = base + v.getUint16(base + 6);
  const lookupList = base + v.getUint16(base + 8);
  const lookups = new Set<number>();
  const features = v.getUint16(featureList);
  for (let i = 0; i < features; i++) {
    const rec = featureList + 2 + i * 6;
    if (String.fromCharCode(v.getUint8(rec), v.getUint8(rec + 1), v.getUint8(rec + 2), v.getUint8(rec + 3)) !== 'kern') continue;
    const feature = featureList + v.getUint16(rec + 4);
    const n = v.getUint16(feature + 2);
    for (let k = 0; k < n; k++) lookups.add(v.getUint16(feature + 4 + k * 2));
  }
  const subtables: number[][] = [];
  for (const index of [...lookups].sort((a, b) => a - b)) {
    if (index >= v.getUint16(lookupList)) continue;
    const lookup = lookupList + v.getUint16(lookupList + 2 + index * 2);
    const type = v.getUint16(lookup);
    const count = v.getUint16(lookup + 4);
    const list: number[] = [];
    for (let k = 0; k < count; k++) {
      let st = lookup + v.getUint16(lookup + 6 + k * 2);
      if (type === 9) {
        if (v.getUint16(st + 2) !== 2) continue;
        st += v.getUint32(st + 4);
      } else if (type !== 2) continue;
      list.push(st);
    }
    if (list.length) subtables.push(list);
  }
  if (!subtables.length) return null;
  const pair = (st: number, left: number, right: number): [number, number] | null => {
    const format = v.getUint16(st);
    const covered = coverageIndex(t, st + v.getUint16(st + 2), left);
    if (covered < 0) return null;
    const vf1 = v.getUint16(st + 4);
    const vf2 = v.getUint16(st + 6);
    const s1 = valueSize(vf1);
    const s2 = valueSize(vf2);
    if (format === 1) {
      if (covered >= v.getUint16(st + 8)) return null;
      const set = st + v.getUint16(st + 10 + covered * 2);
      const n = v.getUint16(set);
      const size = 2 + s1 + s2;
      let lo = 0;
      let hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const rec = set + 2 + mid * size;
        const g = v.getUint16(rec);
        if (g < right) lo = mid + 1;
        else if (g > right) hi = mid - 1;
        else return [xAdvance(v, rec + 2, vf1), xAdvance(v, rec + 2 + s1, vf2)];
      }
      return null;
    }
    if (format !== 2) return null;
    const c1 = classOf(t, st + v.getUint16(st + 8), left);
    const c2 = classOf(t, st + v.getUint16(st + 10), right);
    const count1 = v.getUint16(st + 12);
    const count2 = v.getUint16(st + 14);
    if (c1 >= count1 || c2 >= count2) return null;
    const rec = st + 16 + (c1 * count2 + c2) * (s1 + s2);
    return [xAdvance(v, rec, vf1), xAdvance(v, rec + s1, vf2)];
  };
  const cache = new Map<number, [number, number]>();
  return (left, right) => {
    const key = left * 65536 + right;
    let out = cache.get(key);
    if (out) return out;
    out = [0, 0];
    for (const list of subtables) {
      for (const st of list) {
        const p = pair(st, left, right);
        if (!p) continue;
        out = [out[0] + p[0], out[1] + p[1]];
        break;
      }
    }
    if (cache.size > 4096) cache.clear();
    cache.set(key, out);
    return out;
  };
}

// The old kern table, Microsoft's version 0, horizontal format 0 subtables.
function kernTable(t: Reader | null): ((l: number, r: number) => [number, number]) | null {
  if (!t) return null;
  const v = t.data;
  const base = t.pos;
  if (v.getUint16(base) !== 0) return null;
  const pairs = new Map<number, number>();
  let st = base + 4;
  for (let i = v.getUint16(base + 2); i > 0; i--) {
    const length = v.getUint16(st + 2);
    const coverage = v.getUint16(st + 4);
    if (coverage >> 8 === 0 && coverage & 1 && !(coverage & 4)) {
      const n = v.getUint16(st + 6);
      for (let k = 0; k < n; k++) {
        const rec = st + 14 + k * 6;
        const key = v.getUint16(rec) * 65536 + v.getUint16(rec + 2);
        pairs.set(key, (pairs.get(key) ?? 0) + v.getInt16(rec + 4));
      }
    }
    st += length;
  }
  return pairs.size ? (l, r) => [pairs.get(l * 65536 + r) ?? 0, 0] : null;
}
