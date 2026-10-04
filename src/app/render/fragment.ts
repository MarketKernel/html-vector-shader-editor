// Runs a stand-alone fragment shader the way the GLSL export's header says to: a quad
// over the whole viewport and one uniform, uResolution. The export dialog's live preview
// and the browser tests both go through here, with the text exactly as exported.

import { compile, unitQuad } from './renderer';

const VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() {
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}`;

const contexts = new WeakMap<HTMLCanvasElement, { gl: WebGL2RenderingContext; quad: WebGLVertexArrayObject; program: WebGLProgram | null }>();

// Draws `source` over the canvas at its pixel size; throws ShaderError when it does not
// compile. The canvas keeps its picture (preserveDrawingBuffer) so it can be read back.
export function drawFragment(canvas: HTMLCanvasElement, source: string): void {
  let c = contexts.get(canvas);
  if (!c) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('WebGL 2 недоступен');
    c = { gl, quad: unitQuad(gl), program: null };
    contexts.set(canvas, c);
  }
  const { gl } = c;
  const program = compile(gl, VS, source);
  if (c.program) gl.deleteProgram(c.program);
  c.program = program;
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);
  gl.uniform2f(gl.getUniformLocation(program, 'uResolution'), canvas.width, canvas.height);
  gl.bindVertexArray(c.quad);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.bindVertexArray(null);
}

// The canvas's pixels after drawFragment, straight alpha, top row first.
export function readFragment(canvas: HTMLCanvasElement): ImageData {
  const c = contexts.get(canvas);
  if (!c) throw new Error('Nothing drawn on this canvas');
  const { gl } = c;
  const w = canvas.width;
  const h = canvas.height;
  const raw = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const from = (h - 1 - y) * w * 4;
    const to = y * w * 4;
    for (let i = 0; i < w * 4; i += 4) {
      const a = raw[from + i + 3]!;
      out.data[to + i + 3] = a;
      if (a) for (let k = 0; k < 3; k++) out.data[to + i + k] = Math.min(255, Math.round((raw[from + i + k]! * 255) / a));
    }
  }
  return out;
}
