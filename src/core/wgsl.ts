// WGSL export: a WebGPU shader module that draws the document on its own — the GLSL
// export's structure (shader.ts) in WGSL, over the WebGPU renderer's own SDF library. A
// vertex entry point covers the viewport with one triangle; the fragment one draws. The
// result depends only on the viewport's size.


import { SDF_LIBRARY_WGSL } from './sdf';
import type { Dialect } from './shader';
import { commentSafe, glf, shaderBody } from './shader';
import type { ExportResult } from './svg';
import type { Document } from './types';

const vec4f = (v: readonly number[]) => `vec4f(${v.map(glf).join(', ')})`;

export const WGSL: Dialect = {
  vec2: (x, y) => `vec2f(${glf(x)}, ${glf(y)})`,
  vec4: vec4f,
  transparent: 'vec4f(0.0)',
  mat2: (m) => `mat2x2f(${m.map(glf).join(', ')})`,
  fn: (name, body) => `fn ${name}(p: vec2f, px: f32) -> vec4f {\n  var c = vec4f(0.0);\n${body.join('\n')}\n  return c;\n}`,
  local: (name, value) => `let ${name} = ${value};`,
  data: (vectors) => {
    const n = Math.max(1, vectors.length);
    const items = vectors.length ? vectors.map((v) => `  ${vec4f(v)}`).join(',\n') : '  vec4f(0.0)';
    return `const DATA = array<vec4f, ${n}>(\n${items}\n);

fn pathData(i: i32) -> vec4f {
  return DATA[i];
}`;
  },
  library: SDF_LIBRARY_WGSL,
  inBounds: `// Skips a shape's arithmetic away from it; the margin keeps its antialiased edge.
fn inBounds(p: vec2f, box: vec4f, px: f32) -> bool {
  return all(p >= box.xy - 2.0 * px) && all(p <= box.zw + 2.0 * px);
}`,
  drawDocument: (background, calls) => `// The whole page at document point p, premultiplied; px is document units per pixel.
fn drawDocument(p: vec2f, px: f32) -> vec4f {
  var c = ${background};
${calls.join('\n')}
  return c;
}`,
};

export function exportWgsl(doc: Document, title = 'Untitled'): ExportResult {
  const { body, warnings } = shaderBody(doc, WGSL);
  const text = `// "${commentSafe(title)}" — ${doc.width} × ${doc.height}, exported from HTML Vector Editor.
//
// To run with WebGPU: a render pipeline with this module — vertex entry point vs_main,
// fragment entry point fs_main — and a draw of 3 vertices, one triangle over the whole
// viewport; at @group(0) @binding(0) a uniform buffer with the viewport's size in pixels
// (two f32). The document is stretched over the viewport; at a size of (${doc.width}, ${doc.height}) its
// pixels are the PNG export's. The colour written is premultiplied by alpha: configure a
// canvas with alphaMode: 'premultiplied', blend with src-factor one, dst-factor
// one-minus-src-alpha.
// p — document coordinates: (0,0) top left, Y down, as WebGPU's own pixels.

struct Viewport {
  size: vec2f,
}

@group(0) @binding(0) var<uniform> viewport: Viewport;

${body}

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  // Corners (-1, -1), (3, -1), (-1, 3): a triangle the viewport fits in.
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let size = vec2f(${glf(doc.width)}, ${glf(doc.height)});
  let p = frag.xy * (size / viewport.size);
  // Document units per screen pixel, for the antialiasing.
  let px = length(fwidth(p)) * 0.70710678;
  return drawDocument(p, px);
}
`;
  return { text, warnings };
}
