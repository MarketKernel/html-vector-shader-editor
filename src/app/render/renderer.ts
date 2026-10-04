// The WebGL 2 renderer. It draws a DrawList (core/draw.ts): one quad per shape over its
// bounds, coloured by the shared SDF library (core/sdf.ts) — the same functions the GLSL
// export calls with constants. Layers and groups that need it (opacity below 1, a blend
// mode) are drawn into an offscreen target and composited; the rest go straight onto
// what is below. Everything is premultiplied.
//
// Blending uses fixed-function blend states equal to the W3C formulas in sdf.ts:
//   normal    co = cs + cb(1 - as)                 ONE, ONE_MINUS_SRC_ALPHA
//   screen    co = cs(1 - cb) + cb                 ONE_MINUS_DST_COLOR, ONE
//   multiply  co = cs·cb + cb(1 - as) + cs(1 - ab) two passes: DST_COLOR, ONE_MINUS_SRC_ALPHA
//                                                  (alpha kept), then ONE_MINUS_DST_ALPHA, ONE
// so no copy of the backdrop is needed.
//
// Nothing here knows about documents: a renderer for WebGPU would take the same list.

import type { DrawItem, DrawList, GroupItem, ShapeItem } from '../../core/draw';
import { isolated } from '../../core/draw';
import type { Box } from '../../core/matrix';
import type { Matrix } from '../../core/types';
import { multiply, transformBox } from '../../core/matrix';
import { SDF_LIBRARY } from '../../core/sdf';

const DATA_WIDTH = 1024;

const SHAPE_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
uniform vec4 uBox;
uniform mat3 uMatrix;
uniform vec2 uSize;
out vec2 vLocal;
void main() {
  vLocal = uBox.xy + aPos * uBox.zw;
  vec2 d = (uMatrix * vec3(vLocal, 1.0)).xy;
  gl_Position = vec4(d.x / uSize.x * 2.0 - 1.0, 1.0 - d.y / uSize.y * 2.0, 0.0, 1.0);
}`;

const SHAPE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uData;
vec4 pathData(int i) {
  return texelFetch(uData, ivec2(i & ${DATA_WIDTH - 1}, i >> ${Math.log2(DATA_WIDTH)}), 0);
}
${SDF_LIBRARY}
in vec2 vLocal;
uniform int uKind;
uniform vec4 uA;
uniform vec4 uB;
uniform vec4 uFill;
uniform vec4 uStroke;
uniform float uHalfWidth;
uniform int uStyle;
uniform float uAA;
uniform ivec4 uPath;
uniform ivec2 uDiscs;
uniform float uOpacity;
out vec4 fragColor;
void main() {
  vec4 c;
  if (uKind == 0) c = paintRect(vLocal, uA, uB.x, uFill, uStroke, uHalfWidth, uStyle, uAA);
  else if (uKind == 1) c = paintEllipse(vLocal, uA.xy, uA.zw, uFill, uStroke, uHalfWidth, uAA);
  else if (uKind == 2) c = paintLine(vLocal, uA.xy, uA.zw, uStroke, uHalfWidth, uStyle, uAA);
  else c = paintPath(vLocal, uPath.x, uPath.y, uPath.z, uPath.w, uDiscs.x, uDiscs.y, uStyle == 1, uFill, uStroke, uAA);
  fragColor = c * uOpacity;
}`;

// A full-target quad; the fragment shader picks its pixels by position.
const FULL_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() {
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform float uOpacity;
out vec4 fragColor;
void main() {
  fragColor = texelFetch(uTexture, ivec2(gl_FragCoord.xy), 0) * uOpacity;
}`;

// A transparent document shows on squares, in device pixels.
const CHECKER_FS = `#version 300 es
precision highp float;
uniform vec4 uRect;
uniform vec4 uLight;
uniform vec4 uDark;
uniform float uCell;
uniform float uHeight;
out vec4 fragColor;
void main() {
  vec2 p = vec2(gl_FragCoord.x, uHeight - gl_FragCoord.y);
  if (p.x < uRect.x || p.y < uRect.y || p.x > uRect.z || p.y > uRect.w) discard;
  vec2 cell = floor((p - uRect.xy) / uCell);
  fragColor = mod(cell.x + cell.y, 2.0) < 1.0 ? uLight : uDark;
}`;

export interface Target {
  fb: WebGLFramebuffer | null;
  tex: WebGLTexture | null;
  width: number;
  height: number;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

interface Program {
  program: WebGLProgram;
  u: Uniforms;
}

export class ShaderError extends Error {}

export function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(s) ?? '';
      gl.deleteShader(s);
      throw new ShaderError(log.trim() || 'The shader did not compile');
    }
    return s;
  };
  const program = gl.createProgram()!;
  const v = shader(gl.VERTEX_SHADER, vs);
  const f = shader(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(program, v);
  gl.attachShader(program, f);
  gl.linkProgram(program);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) throw new ShaderError(gl.getProgramInfoLog(program)?.trim() || 'The shader did not link');
  return program;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string, names: string[]): Program {
  const p = compile(gl, vs, fs);
  return { program: p, u: Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)])) };
}

// The unit square as two triangles, for every quad drawn.
export function unitQuad(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

export interface Pasteboard {
  // Premultiplied, 0…1.
  clear: [number, number, number, number];
  checkerLight: [number, number, number, number];
  checkerDark: [number, number, number, number];
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private shape: Program;
  private composite: Program;
  private checker: Program;
  private quad: WebGLVertexArrayObject;
  private data: WebGLTexture;
  private dataRows = 0;
  // Offscreen targets, reused frame to frame: one per depth of isolated groups, plus the
  // document's own.
  private pool: Target[] = [];
  private inUse = 0;
  private size = { width: 1, height: 1 };
  private view: Matrix = [1, 0, 0, 1, 0, 0];
  private offsets = new Map<ShapeItem, [number, number, number]>();
  readonly maxSize: number;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.shape = program(gl, SHAPE_VS, SHAPE_FS, ['uBox', 'uMatrix', 'uSize', 'uData', 'uKind', 'uA', 'uB', 'uFill', 'uStroke', 'uHalfWidth', 'uStyle', 'uAA', 'uPath', 'uDiscs', 'uOpacity']);
    this.composite = program(gl, FULL_VS, COMPOSITE_FS, ['uTexture', 'uOpacity']);
    this.checker = program(gl, FULL_VS, CHECKER_FS, ['uRect', 'uLight', 'uDark', 'uCell', 'uHeight']);
    this.quad = unitQuad(gl);
    this.data = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, DATA_WIDTH, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(DATA_WIDTH * 4));
    this.dataRows = 1;
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
  }

  // The document into `target` (cleared first). `view` maps document coordinates to the
  // target's pixels, Y down.
  renderDocument(list: DrawList, view: Matrix, target: Target): void {
    const gl = this.gl;
    this.view = view;
    this.size = { width: target.width, height: target.height };
    this.uploadPaths(list);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    this.bind(target);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (list.background) {
      const page: ShapeItem = {
        kind: 'shape',
        node: null as never,
        world: [1, 0, 0, 1, 0, 0],
        inverse: [1, 0, 0, 1, 0, 0],
        aaScale: 1 / Math.sqrt(Math.abs(view[0] * view[3] - view[1] * view[2])),
        localBounds: { x: -1, y: -1, width: list.width + 2, height: list.height + 2 },
        bounds: { x: -1, y: -1, width: list.width + 2, height: list.height + 2 },
        shape: 0,
        a: [0, 0, list.width, list.height],
        b: [0, 0, 0, 0],
        fill: list.background,
        stroke: [0, 0, 0, 0],
        halfWidth: 0,
        style: 0,
        opacity: 1,
        path: null,
      };
      this.drawShape(page);
    }
    for (const layer of list.layers) this.drawGroup(layer, target);
  }

  // The document as it shows in the editor: the pasteboard, squares under the page, then
  // the page itself, through an offscreen copy so its blend modes see only the page.
  renderView(list: DrawList, view: Matrix, width: number, height: number, pasteboard: Pasteboard): void {
    const gl = this.gl;
    const page = this.target(0, width, height);
    this.inUse = 1;
    this.renderDocument(list, view, page);
    this.inUse = 0;
    this.bind(null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(...pasteboard.clear);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // The page in whole device pixels, for the squares and for the page's own picture alike.
    const corners = transformBox(view, { x: 0, y: 0, width: list.width, height: list.height });
    const x0 = Math.max(0, Math.round(corners.x));
    const y0 = Math.max(0, Math.round(corners.y));
    const x1 = Math.min(width, Math.round(corners.x + corners.width));
    const y1 = Math.min(height, Math.round(corners.y + corners.height));
    // What lies off the page is shown faintly: it is in the document but not in any export.
    gl.enable(gl.BLEND);
    this.compositeTarget(page, 0.3, 'normal');
    gl.disable(gl.BLEND);
    gl.useProgram(this.checker.program);
    gl.uniform4f(this.checker.u.uRect!, x0, y0, x1, y1);
    gl.uniform4f(this.checker.u.uLight!, ...pasteboard.checkerLight);
    gl.uniform4f(this.checker.u.uDark!, ...pasteboard.checkerDark);
    gl.uniform1f(this.checker.u.uCell!, 8 * Math.max(1, Math.round(window.devicePixelRatio || 1)));
    gl.uniform1f(this.checker.u.uHeight!, height);
    this.drawQuad();
    gl.enable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    if (x1 > x0 && y1 > y0) {
      gl.scissor(x0, height - y1, x1 - x0, y1 - y0);
      this.compositeTarget(page, 1, 'normal');
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  // Pixels of the document at `scale`, straight (not premultiplied) alpha, top row first.
  readDocument(list: DrawList, scale: number): ImageData {
    const gl = this.gl;
    const width = Math.max(1, Math.round(list.width * scale));
    const height = Math.max(1, Math.round(list.height * scale));
    if (width > this.maxSize || height > this.maxSize) throw new Error(`${width} × ${height} is beyond this GPU's ${this.maxSize} pixels`);
    // Targets of their own, above the view's, freed at once: exports at 4× can be large.
    const base = this.pool.length;
    const target = this.target(base, width, height);
    this.inUse = base + 1;
    const raw = new Uint8Array(width * height * 4);
    try {
      this.renderDocument(list, [scale, 0, 0, scale, 0, 0], target);
      this.bind(target);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    } finally {
      this.inUse = 0;
      while (this.pool.length > base) this.release(this.pool[this.pool.length - 1]!);
    }
    const out = new ImageData(width, height);
    for (let y = 0; y < height; y++) {
      const from = (height - 1 - y) * width * 4;
      const to = y * width * 4;
      for (let i = 0; i < width * 4; i += 4) {
        const a = raw[from + i + 3]!;
        out.data[to + i + 3] = a;
        if (a === 0) continue;
        for (let k = 0; k < 3; k++) out.data[to + i + k] = Math.min(255, Math.round((raw[from + i + k]! * 255) / a));
      }
    }
    return out;
  }

  dispose(): void {
    for (const t of this.pool) this.release(t);
    this.pool = [];
  }

  // ---- Drawing

  private drawItems(items: DrawItem[], target: Target): void {
    for (const it of items) {
      if (it.kind === 'group') this.drawGroup(it, target);
      else this.drawShape(it);
    }
  }

  private drawGroup(g: GroupItem, target: Target): void {
    if (!g.items.length) return;
    if (!isolated(g)) {
      this.drawItems(g.items, target);
      return;
    }
    const gl = this.gl;
    const box = g.bounds ? this.deviceBox(g.bounds) : null;
    if (!box) return;
    const own = this.target(this.inUse++, this.size.width, this.size.height);
    this.bind(own);
    // Only the group's own rectangle needs clearing and compositing.
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(box.x, this.size.height - box.y - box.height, box.width, box.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
    this.drawItems(g.items, own);
    this.bind(target);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(box.x, this.size.height - box.y - box.height, box.width, box.height);
    this.compositeTarget(own, g.opacity, g.blend);
    gl.disable(gl.SCISSOR_TEST);
    this.inUse--;
  }

  // The device-pixel rectangle a document box covers, clipped to the target; null if none.
  private deviceBox(b: Box): { x: number; y: number; width: number; height: number } | null {
    const d = transformBox(this.view, b);
    const x0 = Math.max(0, Math.floor(d.x) - 1);
    const y0 = Math.max(0, Math.floor(d.y) - 1);
    const x1 = Math.min(this.size.width, Math.ceil(d.x + d.width) + 1);
    const y1 = Math.min(this.size.height, Math.ceil(d.y + d.height) + 1);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
  }

  private drawShape(s: ShapeItem): void {
    if (!this.deviceBox(s.bounds)) return;
    const gl = this.gl;
    const { u } = this.shape;
    gl.useProgram(this.shape.program);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const m = multiply(this.view, s.world);
    gl.uniformMatrix3fv(u.uMatrix!, false, [m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);
    gl.uniform2f(u.uSize!, this.size.width, this.size.height);
    const lb = s.localBounds;
    gl.uniform4f(u.uBox!, lb.x, lb.y, lb.width, lb.height);
    gl.uniform1i(u.uKind!, s.shape);
    gl.uniform4f(u.uA!, ...s.a);
    gl.uniform4f(u.uB!, ...s.b);
    gl.uniform4f(u.uFill!, ...s.fill);
    gl.uniform4f(u.uStroke!, ...s.stroke);
    gl.uniform1f(u.uHalfWidth!, s.halfWidth);
    gl.uniform1i(u.uStyle!, s.style);
    gl.uniform1f(u.uAA!, s.aaScale);
    gl.uniform1f(u.uOpacity!, s.opacity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.data);
    gl.uniform1i(u.uData!, 0);
    const at = this.offsets.get(s);
    if (s.path && at) {
      gl.uniform4i(u.uPath!, at[0], s.path.segs.length / 4, at[1], s.path.quads.length / 8);
      gl.uniform2i(u.uDiscs!, at[2], s.path.discs.length / 4);
    } else {
      gl.uniform4i(u.uPath!, 0, 0, 0, 0);
      gl.uniform2i(u.uDiscs!, 0, 0);
    }
    this.drawQuad();
  }

  private compositeTarget(source: Target, opacity: number, blend: GroupItem['blend']): void {
    const gl = this.gl;
    gl.useProgram(this.composite.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source.tex);
    gl.uniform1i(this.composite.u.uTexture!, 0);
    gl.uniform1f(this.composite.u.uOpacity!, opacity);
    if (blend === 'multiply') {
      gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      this.drawQuad();
      gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);
      this.drawQuad();
    } else if (blend === 'screen') {
      gl.blendFuncSeparate(gl.ONE_MINUS_DST_COLOR, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);
      this.drawQuad();
    } else {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.drawQuad();
    }
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private drawQuad(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  // ---- Data and targets

  // Every path's flattened geometry, one after another, into the data texture.
  private uploadPaths(list: DrawList): void {
    this.offsets.clear();
    const chunks: number[][] = [];
    let texels = 0;
    const visit = (items: DrawItem[]) => {
      for (const it of items) {
        if (it.kind === 'group') visit(it.items);
        else if (it.path) {
          const g = it.path;
          this.offsets.set(it, [texels, texels + g.segs.length / 4, texels + g.segs.length / 4 + g.quads.length / 4]);
          chunks.push(g.segs, g.quads, g.discs);
          texels += (g.segs.length + g.quads.length + g.discs.length) / 4;
        }
      }
    };
    for (const l of list.layers) visit(l.items);
    if (!texels) return;
    const rows = Math.ceil(texels / DATA_WIDTH);
    const data = new Float32Array(rows * DATA_WIDTH * 4);
    let at = 0;
    for (const c of chunks) {
      data.set(c, at);
      at += c.length;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.data);
    if (rows > this.dataRows) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, DATA_WIDTH, rows, 0, gl.RGBA, gl.FLOAT, data);
      this.dataRows = rows;
    } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, DATA_WIDTH, rows, gl.RGBA, gl.FLOAT, data);
  }

  private target(index: number, width: number, height: number): Target {
    const gl = this.gl;
    const have = this.pool[index];
    if (have && have.width === width && have.height === height) return have;
    if (have) this.release(have);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const t = { fb, tex, width, height };
    this.pool[index] = t;
    return t;
  }

  private release(t: Target): void {
    this.gl.deleteFramebuffer(t.fb);
    this.gl.deleteTexture(t.tex);
    const i = this.pool.indexOf(t);
    if (i >= 0) this.pool.splice(i, 1);
  }

  private bind(t: Target | null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    gl.viewport(0, 0, t ? t.width : this.size.width, t ? t.height : this.size.height);
  }
}
