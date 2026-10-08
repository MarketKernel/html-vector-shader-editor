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

// The named colours of CSS, for the SVG import.
const NAMED = Object.fromEntries(
  (
    'aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 ' +
    'blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 ' +
    'chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b ' +
    'darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b ' +
    'darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a ' +
    'darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 ' +
    'darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff ' +
    'firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff ' +
    'gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 ' +
    'hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 ' +
    'lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff ' +
    'lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 ' +
    'lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 ' +
    'lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff ' +
    'maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db ' +
    'mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc ' +
    'mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 ' +
    'navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 ' +
    'orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 ' +
    'papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 ' +
    'rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 ' +
    'sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd ' +
    'slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 ' +
    'thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 ' +
    'yellow ffff00 yellowgreen 9acd32'
  )
    .split(' ')
    .flatMap((w, i, all) => (i % 2 ? [] : [[w, `#${all[i + 1]}`]])),
) as Record<string, string>;

export const COLOR_NAMES: readonly string[] = Object.keys(NAMED);

export interface CssColor {
  hex: string;
  alpha: number;
}

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

// A CSS colour as SVG files write it — a name, #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(),
// rgba(), hsl(), hsla(), transparent — as '#rrggbb' and an alpha; null for anything else.
export function parseCssColor(text: string): CssColor | null {
  const t = text.trim().toLowerCase();
  if (NAMED[t]) return { hex: NAMED[t]!, alpha: 1 };
  if (t === 'transparent') return { hex: '#000000', alpha: 0 };
  const h = /^#([0-9a-f]{3,8})$/.exec(t);
  if (h) {
    let d = h[1]!;
    if (d.length === 3 || d.length === 4) d = [...d].map((c) => c + c).join('');
    if (d.length !== 6 && d.length !== 8) return null;
    return { hex: `#${d.slice(0, 6)}`, alpha: d.length === 8 ? parseInt(d.slice(6), 16) / 255 : 1 };
  }
  const f = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(t);
  if (!f) return null;
  // Commas or spaces between the parts, the alpha after a comma or a slash.
  const parts = f[2]!.split(/\s*,\s*|\s*\/\s*|\s+/).filter(Boolean);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const value = (p: string, full: number): number | null => {
    const n = parseFloat(p);
    if (!Number.isFinite(n) || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?(%|deg)?$/.test(p)) return null;
    return p.endsWith('%') ? (n / 100) * full : n;
  };
  const alpha = parts[3] === undefined ? 1 : value(parts[3], 1);
  if (alpha === null) return null;
  let rgb: (number | null)[];
  if (f[1]!.startsWith('rgb')) rgb = parts.slice(0, 3).map((p) => value(p, 255));
  else {
    const [hue, s, l] = [value(parts[0]!, 360), value(parts[1]!, 1), value(parts[2]!, 1)];
    if (hue === null || s === null || l === null || !parts[1]!.endsWith('%') || !parts[2]!.endsWith('%')) return null;
    rgb = hslToRgb(((hue % 360) + 360) % 360, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l)));
  }
  if (rgb.some((v) => v === null)) return null;
  return { hex: `#${rgb.map((v) => hex2(v!)).join('')}`, alpha: Math.max(0, Math.min(1, alpha)) };
}
