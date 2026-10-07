// The document model. It knows nothing of how it is drawn: the WebGL view, the SVG, the
// GLSL and the PNG are all made from it, and a renderer can be swapped without touching
// the format. Coordinates are document pixels, origin top left, Y down — as in SVG.
//
// Fill, Stroke and Shape are discriminated unions so gradients, text and images can join
// them later as new variants rather than as optional fields on the old ones.

export const DOCUMENT_VERSION = 2;

// [a, b, c, d, e, f], the SVG order: x' = a·x + c·y + e, y' = b·x + d·y + f.
export type Matrix = [number, number, number, number, number, number];

export type BlendMode = 'normal' | 'multiply' | 'screen';
export const BLEND_MODES: readonly BlendMode[] = ['normal', 'multiply', 'screen'];

export interface Document {
  version: typeof DOCUMENT_VERSION;
  width: number;
  height: number;
  // '#rrggbb', or null for transparent.
  background: string | null;
  // Bottom to top.
  layers: Layer[];
  // Fonts loaded into the document, carried in it so it draws the same anywhere. The
  // built-in font is not among them.
  fonts: FontFace[];
}

export interface FontFace {
  // Made from the file's contents (fonts.ts fontId): the same file has the same id in
  // every document.
  id: string;
  family: string;
  style: string;
  // The font file, base64.
  data: string;
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
  // Bottom to top.
  children: Node[];
}

export interface Base {
  id: string;
  name?: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  transform: Matrix;
}

export interface Group extends Base {
  type: 'group';
  children: Node[];
}

export type Fill = null | SolidFill;
export interface SolidFill {
  color: string;
  opacity: number;
}

export type LineCap = 'butt' | 'round' | 'square';
export type LineJoin = 'miter' | 'round' | 'bevel';
export const LINE_CAPS: readonly LineCap[] = ['butt', 'round', 'square'];
export const LINE_JOINS: readonly LineJoin[] = ['miter', 'round', 'bevel'];

export type Stroke = null | SolidStroke;
export interface SolidStroke {
  color: string;
  opacity: number;
  width: number;
  cap: LineCap;
  join: LineJoin;
}

export interface Painted extends Base {
  fill: Fill;
  stroke: Stroke;
}

export interface Rect extends Painted {
  type: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
}

export interface Ellipse extends Painted {
  type: 'ellipse';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface Line extends Painted {
  type: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type Segment =
  | ['M', number, number]
  | ['L', number, number]
  | ['Q', number, number, number, number]
  | ['C', number, number, number, number, number, number]
  | ['Z'];

export type FillRule = 'nonzero' | 'evenodd';

export interface Path extends Painted {
  type: 'path';
  segments: Segment[];
  fillRule: FillRule;
}

export type TextAlign = 'start' | 'middle' | 'end';
export const TEXT_ALIGNS: readonly TextAlign[] = ['start', 'middle', 'end'];

// Lines of text set in one font, drawn by the glyphs' outlines. (x, y) is the alignment
// point on the first line's baseline, as for SVG's <text>; lines are split at '\n' and
// never wrapped. Its fill rule is nonzero, as fonts are drawn.
export interface Text extends Painted {
  type: 'text';
  text: string;
  x: number;
  y: number;
  font: string;
  // The em size, in the text's own units.
  size: number;
  // From one baseline to the next, in ems.
  lineHeight: number;
  // Added between characters, in the text's own units.
  letterSpacing: number;
  align: TextAlign;
}

export type Shape = Rect | Ellipse | Line | Path | Text;
export type Node = Group | Shape;
export type NodeType = Node['type'];

// Whatever holds nodes: a layer or a group.
export type Container = Layer | Group;

export const SVG_MITER_LIMIT = 4;
