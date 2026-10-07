// Setting a text: its lines, where each glyph goes (advances, kerning, letter spacing,
// alignment), the glyphs' outlines in the text's own coordinates, and where the caret can
// stand. Everything that draws, exports or picks a text goes through here.

import type { Font } from './font';
import { fontOf } from './fonts';
import type { Box } from './matrix';
import type { Segment, Text } from './types';

export type TextSetting = Pick<Text, 'text' | 'x' | 'y' | 'font' | 'size' | 'lineHeight' | 'letterSpacing' | 'align'>;

export interface TextLine {
  // The line's characters in the text, as UTF-16 indices: [start, end), without the '\n'.
  start: number;
  end: number;
  left: number;
  width: number;
  baseline: number;
  // The caret's x before each index from start to end, both included.
  carets: number[];
}

export interface TextLayout {
  lines: TextLine[];
  // Each glyph's outline, Y down, in the text's coordinates; glyphs without one left out.
  glyphs: Segment[][];
  // Above and below the baseline, in the text's units.
  ascent: number;
  descent: number;
  // From the top of the first line to the bottom of the last, as wide as the widest.
  box: Box;
}

function placed(segments: Segment[], k: number, dx: number, dy: number): Segment[] {
  return segments.map((s): Segment => {
    switch (s[0]) {
      case 'M':
      case 'L':
        return [s[0], dx + s[1] * k, dy - s[2] * k];
      case 'Q':
        return ['Q', dx + s[1] * k, dy - s[2] * k, dx + s[3] * k, dy - s[4] * k];
      case 'C':
        return ['C', dx + s[1] * k, dy - s[2] * k, dx + s[3] * k, dy - s[4] * k, dx + s[5] * k, dy - s[6] * k];
      case 'Z':
        return ['Z'];
    }
  });
}

export function layoutText(t: TextSetting, font: Font = fontOf(t.font)): TextLayout {
  const k = t.size / font.unitsPerEm;
  const step = t.size * t.lineHeight;
  const ascent = font.ascender * k;
  const descent = -font.descender * k;
  const lines: TextLine[] = [];
  const glyphs: Segment[][] = [];
  let start = 0;
  for (const [n, line] of t.text.split('\n').entries()) {
    const baseline = t.y + n * step;
    const ids: number[] = [];
    const at: number[] = [];
    for (let i = 0; i < line.length; ) {
      const cp = line.codePointAt(i)!;
      ids.push(font.glyphIndex(cp));
      at.push(i);
      i += cp > 0xffff ? 2 : 1;
    }
    // Pen positions in font units, kerning included; letter spacing between characters.
    const advance = ids.map((g) => font.glyph(g).advance);
    for (let i = 0; i + 1 < ids.length; i++) {
      const [a, b] = font.kerning(ids[i]!, ids[i + 1]!);
      advance[i]! += a;
      advance[i + 1]! += b;
    }
    const pen: number[] = [];
    let x = 0;
    for (let i = 0; i < ids.length; i++) {
      pen.push(x);
      x += advance[i]! * k + (i + 1 < ids.length ? t.letterSpacing : 0);
    }
    const width = x;
    const left = t.align === 'middle' ? t.x - width / 2 : t.align === 'end' ? t.x - width : t.x;
    const carets: number[] = new Array(line.length + 1);
    for (let i = 0; i < ids.length; i++) {
      carets[at[i]!] = left + pen[i]!;
      // The middle of a surrogate pair: no place for a caret, given its pair's.
      if (at[i]! + 1 < (at[i + 1] ?? line.length)) carets[at[i]! + 1] = left + pen[i]!;
      const outline = font.glyph(ids[i]!).segments;
      if (outline.length) glyphs.push(placed(outline, k, left + pen[i]!, baseline));
    }
    carets[line.length] = left + width;
    lines.push({ start, end: start + line.length, left, width, baseline, carets });
    start += line.length + 1;
  }
  const x0 = Math.min(...lines.map((l) => l.left));
  const x1 = Math.max(...lines.map((l) => l.left + l.width));
  const top = t.y - ascent;
  const bottom = lines[lines.length - 1]!.baseline + descent;
  return { lines, glyphs, ascent, descent, box: { x: x0, y: top, width: x1 - x0, height: bottom - top } };
}

// Layouts cached by node: nodes are replaced, never changed, so a node seen before is set
// the same way.
const layouts = new WeakMap<Text, TextLayout>();

export function cachedLayout(t: Text): TextLayout {
  let l = layouts.get(t);
  if (!l) layouts.set(t, (l = layoutText(t)));
  return l;
}

export const textSegments = (l: TextLayout): Segment[] => l.glyphs.flat();

// The line a point (in the text's coordinates) is on, by its band of baselines.
export function lineAt(l: TextLayout, y: number): number {
  const first = l.lines[0]!;
  const step = l.lines.length > 1 ? l.lines[1]!.baseline - first.baseline : 0;
  if (step <= 0) return 0;
  // The middle of each line's band, from its ascent to its descent.
  const i = Math.round((y - first.baseline - (l.descent - l.ascent) / 2) / step);
  return Math.max(0, Math.min(l.lines.length - 1, i));
}

// The text index where a click at (x, y) puts the caret: the nearest caret on that line.
export function caretAt(l: TextLayout, x: number, y: number, text: string): number {
  const line = l.lines[lineAt(l, y)]!;
  let best = line.start;
  let bestDist = Infinity;
  for (let i = line.start; i <= line.end; i++) {
    if (isLowSurrogate(text, i)) continue;
    const d = Math.abs(line.carets[i - line.start]! - x);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

export const isLowSurrogate = (text: string, i: number): boolean => {
  const c = text.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff && i > 0 && (text.charCodeAt(i - 1) & 0xfc00) === 0xd800;
};

// The line holding a text index, and the caret's x there.
export function caretPosition(l: TextLayout, index: number): { line: number; x: number } {
  for (let n = 0; n < l.lines.length; n++) {
    const line = l.lines[n]!;
    if (index >= line.start && index <= line.end) return { line: n, x: line.carets[index - line.start]! };
  }
  const last = l.lines[l.lines.length - 1]!;
  return { line: l.lines.length - 1, x: last.carets[last.carets.length - 1]! };
}
