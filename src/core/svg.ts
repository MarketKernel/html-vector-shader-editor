// SVG export: one element per node, only the attributes that differ from SVG's defaults,
// numbers rounded to a thousandth (matrix coefficients to a millionth, as they multiply
// whole coordinates). Hidden layers and nodes are left out: they are not in the picture.
// A text becomes the path of its glyphs, so it looks the same without its font.

import { isIdentity } from './matrix';
import { cachedLayout, textSegments } from './text';
import type { Document, Fill, Group, Layer, Matrix, Node, Segment, Shape, Stroke } from './types';

export interface ExportResult {
  text: string;
  warnings: string[];
}

// 0.1 + 0.2 → "0.3", -0 → "0", 12.0004 → "12".
export function fmt(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

// Matrix coefficients scale whole coordinates, so they keep more digits.
const fmtScale = (n: number): string => {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

export function pathData(segments: Segment[]): string {
  return segments.map((s) => s[0] + (s.slice(1) as number[]).map(fmt).join(' ')).join('');
}

function transformAttr(m: Matrix): string {
  if (isIdentity(m)) return '';
  if (Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[3] - 1) < 1e-9) return ` transform="translate(${fmt(m[4])} ${fmt(m[5])})"`;
  return ` transform="matrix(${[m[0], m[1], m[2], m[3]].map(fmtScale).join(' ')} ${fmt(m[4])} ${fmt(m[5])})"`;
}

const opacityAttr = (name: string, v: number) => (v < 1 ? ` ${name}="${fmt(v)}"` : '');

function paintAttrs(fill: Fill, stroke: Stroke, hasFill: boolean): string {
  let out = '';
  if (hasFill) out += fill ? ` fill="${fill.color}"${opacityAttr('fill-opacity', fill.opacity)}` : ' fill="none"';
  if (stroke) {
    out += ` stroke="${stroke.color}"`;
    if (stroke.width !== 1) out += ` stroke-width="${fmt(stroke.width)}"`;
    out += opacityAttr('stroke-opacity', stroke.opacity);
    if (stroke.cap !== 'butt') out += ` stroke-linecap="${stroke.cap}"`;
    if (stroke.join !== 'miter') out += ` stroke-linejoin="${stroke.join}"`;
  }
  return out;
}

function shapeElement(s: Shape): string {
  const common = `${transformAttr(s.transform)}${opacityAttr('opacity', s.opacity)}`;
  switch (s.type) {
    case 'rect': {
      const rx = s.rx > 0 ? ` rx="${fmt(s.rx)}"` : '';
      // x and y default to 0.
      const xy = `${s.x ? ` x="${fmt(s.x)}"` : ''}${s.y ? ` y="${fmt(s.y)}"` : ''}`;
      return `<rect${xy} width="${fmt(s.width)}" height="${fmt(s.height)}"${rx}${paintAttrs(s.fill, s.stroke, true)}${common}/>`;
    }
    case 'ellipse':
      if (s.rx === s.ry) return `<circle cx="${fmt(s.cx)}" cy="${fmt(s.cy)}" r="${fmt(s.rx)}"${paintAttrs(s.fill, s.stroke, true)}${common}/>`;
      return `<ellipse cx="${fmt(s.cx)}" cy="${fmt(s.cy)}" rx="${fmt(s.rx)}" ry="${fmt(s.ry)}"${paintAttrs(s.fill, s.stroke, true)}${common}/>`;
    case 'line':
      // A line has no inside: its fill would never show.
      return `<line x1="${fmt(s.x1)}" y1="${fmt(s.y1)}" x2="${fmt(s.x2)}" y2="${fmt(s.y2)}"${paintAttrs(null, s.stroke, false)}${common}/>`;
    case 'path': {
      const rule = s.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : '';
      return `<path d="${pathData(s.segments)}"${rule}${paintAttrs(s.fill, s.stroke, true)}${common}/>`;
    }
    case 'text':
      // The words stay readable to screen readers and searches.
      return `<path d="${pathData(textSegments(cachedLayout(s)))}" aria-label="${esc(s.text)}"${paintAttrs(s.fill, s.stroke, true)}${common}/>`;
  }
}

function nodeLines(n: Node, indent: string, out: string[]): void {
  if (!n.visible) return;
  if (n.type === 'group') return groupLines(n, indent, out);
  out.push(indent + shapeElement(n));
}

function groupLines(g: Group, indent: string, out: string[]): void {
  const visible = g.children.filter((c) => c.visible);
  const open = `<g${transformAttr(g.transform)}${opacityAttr('opacity', g.opacity)}`;
  if (!visible.length) {
    out.push(`${indent}${open}/>`);
    return;
  }
  out.push(`${indent}${open}>`);
  for (const c of visible) nodeLines(c, indent + '  ', out);
  out.push(`${indent}</g>`);
}

function layerLines(l: Layer, out: string[]): void {
  const blend = l.blend !== 'normal' ? ` style="mix-blend-mode:${l.blend}"` : '';
  const open = `<g id="${esc(l.id)}" data-name="${esc(l.name)}"${opacityAttr('opacity', l.opacity)}${blend}`;
  const visible = l.children.filter((c) => c.visible);
  if (!visible.length) {
    out.push(`  ${open}/>`);
    return;
  }
  out.push(`  ${open}>`);
  for (const c of visible) nodeLines(c, '    ', out);
  out.push('  </g>');
}

export function exportSvg(doc: Document): ExportResult {
  const w = fmt(doc.width);
  const h = fmt(doc.height);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`];
  if (doc.background) out.push(`  <rect width="${w}" height="${h}" fill="${doc.background}"/>`);
  for (const l of doc.layers) if (l.visible) layerLines(l, out);
  out.push('</svg>');
  // Everything in the model has an SVG equivalent; nothing is approximated. Texts are
  // drawn exactly, but as shapes: that is worth saying.
  const warnings: string[] = [];
  const texts = (nodes: Node[]): number => nodes.reduce((n, c) => n + (!c.visible ? 0 : c.type === 'text' ? 1 : c.type === 'group' ? texts(c.children) : 0), 0);
  const count = doc.layers.reduce((n, l) => n + (l.visible ? texts(l.children) : 0), 0);
  if (count) warnings.push(`${count === 1 ? 'A text is' : `${count} texts are`} written as glyph outlines (<path>): the picture is exact and needs no font, but the words can no longer be edited as text.`);
  return { text: `${out.join('\n')}\n`, warnings };
}
