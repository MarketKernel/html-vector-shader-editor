// Fonts by id: the built-in one and every one a document has carried, each parsed once.
// Ids are made from the file's contents, so an id always means the same outlines — a font
// can be looked up wherever a text is measured, drawn or hit, without the document at
// hand, and a face once seen stays known for the session (a text pasted into another
// document brings its font along).

import type { Font } from './font';
import { FontError, parseFont } from './font';
import type { Document, FontFace, Node } from './types';

export const BUILTIN_FONT = 'inter';

const faces = new Map<string, FontFace>();
const parsed = new Map<string, Font>();

export function registerFont(face: FontFace): void {
  if (!faces.has(face.id)) faces.set(face.id, face);
}

export const fontFace = (id: string): FontFace | null => faces.get(id) ?? null;

export const isBuiltinFont = (id: string): boolean => id === BUILTIN_FONT;

// The font a text names; one the session has never seen is drawn in the built-in one.
export function fontOf(id: string): Font {
  let font = parsed.get(id);
  if (font) return font;
  const face = faces.get(id) ?? faces.get(BUILTIN_FONT);
  if (!face) throw new FontError(`Шрифт ${id} не загружен`);
  font = parseFont(decodeBase64(face.data));
  parsed.set(face.id, font);
  return font;
}

// A content hash (cyrb53): short, and the same for the same file anywhere.
export function fontId(bytes: Uint8Array): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    h1 = Math.imul(h1 ^ b, 2654435761);
    h2 = Math.imul(h2 ^ b, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `font-${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
}

// A face from a font file; throws FontError if it cannot be read.
export function faceFromFile(bytes: Uint8Array): FontFace {
  const font = parseFont(bytes);
  // Every glyph read once, so a broken outline shows now rather than when drawn.
  for (let i = 0; i < font.numGlyphs; i++) font.glyph(i);
  const id = fontId(bytes);
  parsed.set(id, font);
  return { id, family: font.family, style: font.style, data: encodeBase64(bytes) };
}

// The fonts a document's texts can use: the built-in one first.
export function availableFonts(doc: Document): FontFace[] {
  const builtin = faces.get(BUILTIN_FONT);
  return [...(builtin ? [builtin] : []), ...doc.fonts];
}

// Fonts the nodes' texts use that the document does not carry yet (built-in excepted).
export function missingFonts(doc: Document, nodes: Node[]): FontFace[] {
  const have = new Set(doc.fonts.map((f) => f.id));
  const out: FontFace[] = [];
  const visit = (n: Node) => {
    if (n.type === 'group') n.children.forEach(visit);
    else if (n.type === 'text' && !isBuiltinFont(n.font) && !have.has(n.font)) {
      const face = faces.get(n.font);
      if (face) {
        out.push(face);
        have.add(face.id);
      }
    }
  };
  nodes.forEach(visit);
  return out;
}

export function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeBase64(bytes: Uint8Array): string {
  let bin = '';
  // In slices: String.fromCharCode takes only so many arguments.
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
