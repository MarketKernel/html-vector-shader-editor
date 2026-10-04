// Colours are '#rrggbb' in the model. The renderer and the shader want them as numbers.

const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

// '#RGB', 'rgb', '#RRGGBB' → '#rrggbb'; null when it is not a colour.
export function normalizeHex(text: string): string | null {
  const m = HEX.exec(text.trim());
  if (!m) return null;
  let hex = m[1]!.toLowerCase();
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  return `#${hex}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex) ?? '#000000';
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Straight colour and alpha → premultiplied, 0…1: what the renderer and the shader blend.
export function premultiplied(hex: string, alpha: number): [number, number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  const a = Math.max(0, Math.min(1, alpha));
  return [(r / 255) * a, (g / 255) * a, (b / 255) * a, a];
}
