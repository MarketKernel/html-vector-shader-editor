// GLSL export: a fragment shader that draws the document on its own, and the same for
// shadertoy.com. The SDF library is the renderer's (sdf.ts); the rest is shader.ts, written
// in GLSL. The result depends only on uResolution.

import { SDF_LIBRARY } from './sdf';
import type { Dialect } from './shader';
import { commentSafe, glf, shaderBody } from './shader';
import type { ExportResult } from './svg';
import type { Document } from './types';

export { glf } from './shader';

export const GLSL: Dialect = {
  vec2: (x, y) => `vec2(${glf(x)}, ${glf(y)})`,
  vec4: (v) => `vec4(${v.map(glf).join(', ')})`,
  transparent: 'vec4(0.0)',
  mat2: (m) => `mat2(${m.map(glf).join(', ')})`,
  fn: (name, body) => `vec4 ${name}(vec2 p, float px) {\n  vec4 c = vec4(0.0);\n${body.join('\n')}\n  return c;\n}`,
  local: (name, value) => `vec2 ${name} = ${value};`,
  data: (vectors) =>
    `${
      vectors.length
        ? `const vec4 DATA[${vectors.length}] = vec4[${vectors.length}](\n${vectors.map((v) => `  vec4(${v.map(glf).join(', ')})`).join(',\n')}\n);`
        : 'const vec4 DATA[1] = vec4[1](vec4(0.0));'
    }

vec4 pathData(int i) {
  return DATA[i];
}`,
  library: SDF_LIBRARY,
  inBounds: `// Skips a shape's arithmetic away from it; the margin keeps its antialiased edge.
bool inBounds(vec2 p, vec4 box, float px) {
  return all(greaterThanEqual(p, box.xy - 2.0 * px)) && all(lessThanEqual(p, box.zw + 2.0 * px));
}`,
  drawDocument: (background, calls) => `// The whole page at document point p, premultiplied; px is document units per pixel.
vec4 drawDocument(vec2 p, float px) {
  vec4 c = ${background};
${calls.join('\n')}
  return c;
}`,
};

export function exportGlsl(doc: Document, title = 'Untitled'): ExportResult {
  const { body, warnings } = shaderBody(doc, GLSL);
  const text = `#version 300 es
// "${commentSafe(title)}" — ${doc.width} × ${doc.height}, exported from HTML Vector Editor.
//
// To run: draw a quad (or one big triangle) over the whole viewport with this as the
// fragment shader and set the one uniform, uResolution, to the viewport's size in pixels.
// The document is stretched over the viewport; at uResolution = (${doc.width}, ${doc.height}) its
// pixels are the PNG export's. The colour written is premultiplied by alpha, as WebGL's
// default canvas (premultipliedAlpha: true) and blendFunc(ONE, ONE_MINUS_SRC_ALPHA) expect.
precision highp float;
precision highp int;
uniform vec2 uResolution;      // the viewport's size; the document fills the viewport
out vec4 fragColor;
// p — document coordinates: (0,0) top left, Y down; when uResolution equals the document's
// size, pixels coincide with the PNG export

${body}

void main() {
  vec2 size = vec2(${glf(doc.width)}, ${glf(doc.height)});
  vec2 p = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) * (size / uResolution);
  // Document units per screen pixel, for the antialiasing.
  float px = length(fwidth(p)) * 0.70710678;
  fragColor = drawDocument(p, px);
}
`;
  return { text, warnings };
}

// The same picture for shadertoy.com's Image tab: no #version, precision, uniforms or
// outputs (Shadertoy declares those), mainImage() instead of main(), iResolution for the
// viewport. Shadertoy shows the colour opaque, so the page is fitted into the view with
// its proportions kept, over squares where it is transparent, on a dark surround.
export function exportShadertoy(doc: Document, title = 'Untitled'): ExportResult {
  const { body, warnings } = shaderBody(doc, GLSL);
  const text = `// "${commentSafe(title)}" — ${doc.width} × ${doc.height}, exported from HTML Vector Editor
// for shadertoy.com: paste over the code of a new shader's Image tab and run.
//
// The page is fitted into the view, centred, its proportions kept. Where it is transparent
// it shows over grey squares, outside it a dark surround. At iResolution = (${doc.width}, ${doc.height})
// its pixels are the PNG export's (over the squares).
// p — document coordinates: (0,0) top left, Y down

${body}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 size = vec2(${glf(doc.width)}, ${glf(doc.height)});
  float k = min(iResolution.x / size.x, iResolution.y / size.y);
  vec2 corner = (iResolution.xy - size * k) * 0.5;
  vec2 p = (vec2(fragCoord.x, iResolution.y - fragCoord.y) - corner) / k;
  // Document units per screen pixel, for the antialiasing; taken before any branch.
  float px = length(fwidth(p)) * 0.70710678;
  vec4 c = drawDocument(p, px);
  vec2 cell = floor(fragCoord / 8.0);
  vec3 squares = mod(cell.x + cell.y, 2.0) < 1.0 ? vec3(1.0) : vec3(0.87);
  bool onPage = all(greaterThanEqual(p, vec2(0.0))) && all(lessThan(p, size));
  vec3 back = onPage ? squares : vec3(0.12);
  // Nothing of the document shows off the page, as in every other export.
  vec3 colour = onPage ? c.rgb + back * (1.0 - c.a) : back;
  fragColor = vec4(colour, 1.0);
}
`;
  return { text, warnings };
}

// A Shadertoy shader made runnable on its own (the export dialog's preview and the tests):
// the declarations Shadertoy would add, and a main() that calls mainImage(). The one
// uniform set is uResolution, as for the plain export.
export function shadertoyStandalone(code: string): string {
  return `${SHADERTOY_PREFIX}${code}
void main() {
  mainImage(shadertoyColor, gl_FragCoord.xy);
}
`;
}

const SHADERTOY_PREFIX = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform int iFrame;
uniform vec4 iMouse;
#define iResolution vec3(uResolution, 1.0)
out vec4 shadertoyColor;
`;

// Compiler messages about the wrapped shader, with line numbers of the text as pasted.
export const shadertoyLog = (log: string): string => {
  const shift = SHADERTOY_PREFIX.split('\n').length - 1;
  return log.replace(/\b0:(\d+)/g, (_, n: string) => `0:${Math.max(1, Number(n) - shift)}`);
};

