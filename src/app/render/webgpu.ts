// The WebGPU renderer, the WebGL one's twin (renderer.ts): it draws the same DrawList with
// the WGSL twin of the SDF library (core/sdf.ts), one quad per shape over its bounds;
// layers and groups that need it go through offscreen targets and are composited with
// the same fixed-function blend states, which equal the W3C formulas:
//   normal    co = cs + cb(1 - as)                 one, one-minus-src-alpha
//   screen    co = cs(1 - cb) + cb                 one-minus-dst, one
//   multiply  co = cs·cb + cb(1 - as) + cs(1 - ab) two passes: dst, one-minus-src-alpha
//                                                  (alpha kept), then one-minus-dst-alpha, one
//
// What differs is the plumbing: every shape of a frame is a record in one storage buffer
// and the path data another, so a run of shapes is one instanced draw rather than a draw
// with its own uniforms each.

import type { DrawItem, DrawList, GroupItem, ShapeItem } from '../../core/draw';
import { isolated } from '../../core/draw';
import type { Box } from '../../core/matrix';
import { multiply, transformBox } from '../../core/matrix';
import { SDF_LIBRARY_WGSL } from '../../core/sdf';
import type { Matrix } from '../../core/types';
import { readTexture } from './gpu';
import type { Pasteboard, ViewRenderer } from './renderer';

// A shape's record: nine vec4.
const SHAPE_FLOATS = 36;
const OFFSCREEN: GPUTextureFormat = 'rgba8unorm';

const SHAPES = /* wgsl */ `
struct Shape {
  m: vec4f,      // local → target pixels: a, b, c, d
  t: vec4f,      // e, f; the antialiasing width in local units; the opacity
  box: vec4f,    // the quad in local units: x, y, width, height
  a: vec4f,
  b: vec4f,
  fill: vec4f,
  stroke: vec4f,
  info: vec4f,   // kind, style, where its path starts in the data, its chunks
  extra: vec4f,  // half the stroke width
}

struct Frame {
  size: vec2f,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> shapes: array<Shape>;
@group(0) @binding(2) var<storage, read> paths: array<vec4f>;

fn pathData(i: i32) -> vec4f {
  return paths[i];
}
${SDF_LIBRARY_WGSL}
struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) shape: u32,
}

@vertex
fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Varyings {
  var corners = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let s = shapes[i];
  let local = s.box.xy + corners[v] * s.box.zw;
  let d = vec2f(s.m.x * local.x + s.m.z * local.y + s.t.x, s.m.y * local.x + s.m.w * local.y + s.t.y);
  var out: Varyings;
  out.position = vec4f(d.x / frame.size.x * 2.0 - 1.0, 1.0 - d.y / frame.size.y * 2.0, 0.0, 1.0);
  out.local = local;
  out.shape = i;
  return out;
}

@fragment
fn fs(v: Varyings) -> @location(0) vec4f {
  let s = shapes[v.shape];
  let kind = i32(s.info.x);
  let style = i32(s.info.y);
  var c: vec4f;
  if (kind == 0) {
    c = paintRect(v.local, s.a, s.b.x, s.fill, s.stroke, s.extra.x, style, s.t.z);
  } else if (kind == 1) {
    c = paintEllipse(v.local, s.a.xy, s.a.zw, s.fill, s.stroke, s.extra.x, s.t.z);
  } else if (kind == 2) {
    c = paintLine(v.local, s.a.xy, s.a.zw, s.stroke, s.extra.x, style, s.t.z);
  } else {
    c = paintPath(v.local, i32(s.info.z), i32(s.info.w), style == 1, s.fill, s.stroke, s.t.z);
  }
  return c * s.t.w;
}
`;

// A full-target triangle; the fragment shader picks its pixels by position. The instance
// is which opacity of the frame's list to use.
const FULL = /* wgsl */ `
struct Full {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) k: u32,
}

@vertex
fn full(@builtin(vertex_index) i: u32, @builtin(instance_index) k: u32) -> Full {
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: Full;
  out.position = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  out.k = k;
  return out;
}
`;

const COMPOSITE = /* wgsl */ `${FULL}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read> opacities: array<vec4f>;

@fragment
fn composite(f: Full) -> @location(0) vec4f {
  return textureLoad(source, vec2i(f.position.xy), 0) * opacities[f.k].x;
}
`;

// A transparent document shows on squares, in device pixels.
const CHECKER = /* wgsl */ `${FULL}
struct Squares {
  rect: vec4f,
  light: vec4f,
  dark: vec4f,
  cell: vec4f,
}

@group(0) @binding(0) var<uniform> squares: Squares;

@fragment
fn checker(f: Full) -> @location(0) vec4f {
  let p = f.position.xy;
  if (p.x < squares.rect.x || p.y < squares.rect.y || p.x > squares.rect.z || p.y > squares.rect.w) {
    discard;
  }
  let cell = floor((p - squares.rect.xy) / squares.cell.x);
  return select(squares.dark, squares.light, (cell.x + cell.y) % 2.0 < 1.0);
}
`;

type Blend = 'normal' | 'screen' | 'multiply-1' | 'multiply-2' | 'none';

const BLENDS: Record<Exclude<Blend, 'none'>, { color: GPUBlendComponent; alpha: GPUBlendComponent }> = {
  normal: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } },
  screen: { color: { srcFactor: 'one-minus-dst', dstFactor: 'one' }, alpha: { srcFactor: 'one-minus-dst-alpha', dstFactor: 'one' } },
  'multiply-1': { color: { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } },
  'multiply-2': { color: { srcFactor: 'one-minus-dst-alpha', dstFactor: 'one' }, alpha: { srcFactor: 'one-minus-dst-alpha', dstFactor: 'one' } },
};

interface Target {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  composite: GPUBindGroup | null;
}

const growTo = (need: number, have: number) => Math.max(need, have * 2, 256);

export class WebGpuRenderer implements ViewRenderer {
  readonly kind = 'webgpu';
  readonly maxSize: number;
  private readonly context: GPUCanvasContext | null;
  private readonly canvasFormat: GPUTextureFormat;
  private readonly modules: { shapes: GPUShaderModule; composite: GPUShaderModule; checker: GPUShaderModule };
  private readonly layouts: { shapes: GPUBindGroupLayout; composite: GPUBindGroupLayout; checker: GPUBindGroupLayout };
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly frameBuffer: GPUBuffer;
  private readonly squaresBuffer: GPUBuffer;
  private shapesBuffer: GPUBuffer;
  private pathsBuffer: GPUBuffer;
  private opacityBuffer: GPUBuffer;
  private shapesGroup: GPUBindGroup | null = null;
  private squaresGroup: GPUBindGroup | null = null;
  // Offscreen targets, reused frame to frame: one per depth of isolated groups, plus the
  // document's own.
  private pool: Target[] = [];
  private inUse = 0;
  private size = { width: 1, height: 1 };
  private view: Matrix = [1, 0, 0, 1, 0, 0];
  // Each shape's record, by item; the frame's composite opacities, by use.
  private index = new Map<ShapeItem, number>();
  private opacities: number[] = [];
  private encoder: GPUCommandEncoder | null = null;
  private pass: GPURenderPassEncoder | null = null;
  private passPipeline: string | null = null;

  constructor(
    readonly device: GPUDevice,
    canvas: HTMLCanvasElement | null,
  ) {
    const gpu = device;
    this.maxSize = gpu.limits.maxTextureDimension2D;
    this.canvasFormat = navigator.gpu!.getPreferredCanvasFormat();
    this.context = canvas ? canvas.getContext('webgpu') : null;
    if (canvas && !this.context) throw new Error('Браузер не дал контекст WebGPU.');
    this.context?.configure({ device: gpu, format: this.canvasFormat, alphaMode: 'opaque' });
    const VERTEX = GPUShaderStage.VERTEX;
    const FRAGMENT = GPUShaderStage.FRAGMENT;
    this.layouts = {
      shapes: gpu.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: VERTEX, buffer: { type: 'uniform' } },
          { binding: 1, visibility: VERTEX | FRAGMENT, buffer: { type: 'read-only-storage' } },
          { binding: 2, visibility: FRAGMENT, buffer: { type: 'read-only-storage' } },
        ],
      }),
      composite: gpu.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 1, visibility: FRAGMENT, buffer: { type: 'read-only-storage' } },
        ],
      }),
      checker: gpu.createBindGroupLayout({ entries: [{ binding: 0, visibility: FRAGMENT, buffer: { type: 'uniform' } }] }),
    };
    this.modules = {
      shapes: gpu.createShaderModule({ code: SHAPES, label: 'shapes' }),
      composite: gpu.createShaderModule({ code: COMPOSITE, label: 'composite' }),
      checker: gpu.createShaderModule({ code: CHECKER, label: 'checker' }),
    };
    const uniform = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    this.frameBuffer = gpu.createBuffer({ size: 16, usage: uniform });
    this.squaresBuffer = gpu.createBuffer({ size: 64, usage: uniform });
    this.shapesBuffer = this.storage(SHAPE_FLOATS * 4 * 64);
    this.pathsBuffer = this.storage(16 * 256);
    this.opacityBuffer = this.storage(16 * 64);
  }

  private storage(bytes: number): GPUBuffer {
    return this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  // ---- Pipelines

  private pipeline(kind: 'shapes' | 'composite' | 'checker', format: GPUTextureFormat, blend: Blend): GPURenderPipeline {
    const key = `${kind}/${format}/${blend}`;
    let p = this.pipelines.get(key);
    if (p) return p;
    const module = this.modules[kind];
    p = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layouts[kind]] }),
      vertex: { module, entryPoint: kind === 'shapes' ? 'vs' : 'full' },
      fragment: { module, entryPoint: kind === 'shapes' ? 'fs' : kind, targets: [{ format, ...(blend === 'none' ? {} : { blend: BLENDS[blend] }) }] },
      primitive: { topology: 'triangle-list' },
    });
    this.pipelines.set(key, p);
    return p;
  }

  // ---- Frames

  // Every shape's record and every path's data into their buffers, in drawing order; the
  // background first.
  private upload(list: DrawList, page: ShapeItem | null): void {
    this.index.clear();
    const shapes: ShapeItem[] = page ? [page] : [];
    const paths: number[][] = [];
    let groups = 0;
    const visit = (items: DrawItem[]) => {
      for (const it of items) {
        if (it.kind === 'group') {
          if (isolated(it)) groups++;
          visit(it.items);
        } else shapes.push(it);
      }
    };
    for (const l of list.layers) {
      if (isolated(l)) groups++;
      visit(l.items);
    }
    const records = new Float32Array(Math.max(1, shapes.length) * SHAPE_FLOATS);
    let texels = 0;
    shapes.forEach((s, i) => {
      this.index.set(s, i);
      const m = multiply(this.view, s.world);
      const lb = s.localBounds;
      let start = 0;
      if (s.path) {
        start = texels;
        paths.push(s.path.packed);
        texels += s.path.packed.length / 4;
      }
      records.set([m[0], m[1], m[2], m[3], m[4], m[5], s.aaScale, s.opacity, lb.x, lb.y, lb.width, lb.height, ...s.a, ...s.b, ...s.fill, ...s.stroke, s.shape, s.style, start, s.path?.chunks ?? 0, s.halfWidth, 0, 0, 0], i * SHAPE_FLOATS);
    });
    const data = new Float32Array(Math.max(4, texels * 4));
    let at = 0;
    for (const p of paths) {
      data.set(p, at);
      at += p.length;
    }
    let rebind = false;
    if (records.byteLength > this.shapesBuffer.size) {
      this.shapesBuffer.destroy();
      this.shapesBuffer = this.storage(growTo(records.byteLength, this.shapesBuffer.size));
      rebind = true;
    }
    if (data.byteLength > this.pathsBuffer.size) {
      this.pathsBuffer.destroy();
      this.pathsBuffer = this.storage(growTo(data.byteLength, this.pathsBuffer.size));
      rebind = true;
    }
    // The view's two composites come after the groups'.
    if ((groups + 2) * 16 > this.opacityBuffer.size) {
      this.opacityBuffer.destroy();
      this.opacityBuffer = this.storage(growTo((groups + 2) * 16, this.opacityBuffer.size));
      for (const t of this.pool) t.composite = null;
    }
    if (rebind || !this.shapesGroup)
      this.shapesGroup = this.device.createBindGroup({
        layout: this.layouts.shapes,
        entries: [
          { binding: 0, resource: { buffer: this.frameBuffer } },
          { binding: 1, resource: { buffer: this.shapesBuffer } },
          { binding: 2, resource: { buffer: this.pathsBuffer } },
        ],
      });
    const q = this.device.queue;
    q.writeBuffer(this.frameBuffer, 0, new Float32Array([this.size.width, this.size.height, 0, 0]));
    q.writeBuffer(this.shapesBuffer, 0, records);
    q.writeBuffer(this.pathsBuffer, 0, data);
    this.opacities = [];
  }

  // The document into `target` (cleared first). `view` maps document coordinates to the
  // target's pixels, Y down.
  private renderDocument(list: DrawList, view: Matrix, target: Target): void {
    this.view = view;
    this.size = { width: target.width, height: target.height };
    let page: ShapeItem | null = null;
    if (list.background) {
      page = {
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
    }
    this.upload(list, page);
    this.begin(target, true);
    if (page) this.drawShapes([page]);
    for (const layer of list.layers) this.drawGroup(layer, target);
    this.end();
  }

  // The document as it shows in the editor: the pasteboard, squares under the page, then
  // the page itself, through an offscreen copy so its blend modes see only the page.
  renderView(list: DrawList, view: Matrix, width: number, height: number, pasteboard: Pasteboard): void {
    if (!this.context) throw new Error('No canvas to draw on');
    this.encoder = this.device.createCommandEncoder();
    const page = this.target(0, width, height);
    this.inUse = 1;
    this.renderDocument(list, view, page);
    this.inUse = 0;
    const out = this.context.getCurrentTexture();
    const screen: Target = { texture: out, view: out.createView(), width, height, composite: null };
    this.size = { width, height };
    // The page in whole device pixels, for the squares and for the page's own picture alike.
    const corners = transformBox(view, { x: 0, y: 0, width: list.width, height: list.height });
    const x0 = Math.max(0, Math.round(corners.x));
    const y0 = Math.max(0, Math.round(corners.y));
    const x1 = Math.min(width, Math.round(corners.x + corners.width));
    const y1 = Math.min(height, Math.round(corners.y + corners.height));
    const q = this.device.queue;
    q.writeBuffer(this.squaresBuffer, 0, new Float32Array([x0, y0, x1, y1, ...pasteboard.checkerLight, ...pasteboard.checkerDark, 8 * Math.max(1, Math.round(window.devicePixelRatio || 1)), 0, 0, 0]));
    this.squaresGroup ??= this.device.createBindGroup({ layout: this.layouts.checker, entries: [{ binding: 0, resource: { buffer: this.squaresBuffer } }] });
    this.begin(screen, true, pasteboard.clear);
    // What lies off the page is shown faintly: it is in the document but not in any export.
    this.composite(page, 0.3, 'normal', this.canvasFormat);
    const pass = this.pass!;
    pass.setPipeline(this.pipeline('checker', this.canvasFormat, 'none'));
    pass.setBindGroup(0, this.squaresGroup);
    pass.draw(3);
    this.passPipeline = null;
    if (x1 > x0 && y1 > y0) {
      pass.setScissorRect(x0, y0, x1 - x0, y1 - y0);
      this.composite(page, 1, 'normal', this.canvasFormat);
    }
    this.end();
    q.writeBuffer(this.opacityBuffer, 0, this.opacityData());
    q.submit([this.encoder.finish()]);
    this.encoder = null;
  }

  // Pixels of the document at `scale`, straight (not premultiplied) alpha, top row first.
  async readDocument(list: DrawList, scale: number): Promise<ImageData> {
    const width = Math.max(1, Math.round(list.width * scale));
    const height = Math.max(1, Math.round(list.height * scale));
    if (width > this.maxSize || height > this.maxSize) throw new Error(`${width} × ${height} is beyond this GPU's ${this.maxSize} pixels`);
    // Targets of their own, above the view's, freed at once: exports at 4× can be large.
    const base = this.pool.length;
    const target = this.target(base, width, height);
    this.inUse = base + 1;
    try {
      const encoder = (this.encoder = this.device.createCommandEncoder());
      this.renderDocument(list, [scale, 0, 0, scale, 0, 0], target);
      this.device.queue.writeBuffer(this.opacityBuffer, 0, this.opacityData());
      this.encoder = null;
      return await readTexture(this.device, target.texture, encoder);
    } finally {
      this.inUse = 0;
      while (this.pool.length > base) this.release(this.pool[this.pool.length - 1]!);
    }
  }

  finish(): Promise<void> {
    return this.device.queue.onSubmittedWorkDone();
  }

  dispose(): void {
    for (const t of this.pool) this.release(t);
    this.pool = [];
    this.context?.unconfigure();
    for (const b of [this.frameBuffer, this.squaresBuffer, this.shapesBuffer, this.pathsBuffer, this.opacityBuffer]) b.destroy();
  }

  // ---- Drawing

  private begin(t: Target, clear: boolean, color: [number, number, number, number] = [0, 0, 0, 0]): void {
    this.pass = this.encoder!.beginRenderPass({ colorAttachments: [{ view: t.view, loadOp: clear ? 'clear' : 'load', storeOp: 'store', clearValue: color }] });
    this.passPipeline = null;
  }

  private end(): void {
    this.pass?.end();
    this.pass = null;
  }

  // A run of shapes: their records are consecutive, so one instanced draw.
  private drawShapes(run: ShapeItem[]): void {
    if (!run.length) return;
    const pass = this.pass!;
    if (this.passPipeline !== 'shapes') {
      pass.setPipeline(this.pipeline('shapes', OFFSCREEN, 'normal'));
      pass.setBindGroup(0, this.shapesGroup!);
      this.passPipeline = 'shapes';
    }
    pass.draw(6, run.length, 0, this.index.get(run[0]!)!);
  }

  private drawItems(items: DrawItem[], target: Target): void {
    let run: ShapeItem[] = [];
    for (const it of items) {
      if (it.kind === 'shape') {
        run.push(it);
        continue;
      }
      this.drawShapes(run);
      run = [];
      this.drawGroup(it, target);
    }
    this.drawShapes(run);
  }

  private drawGroup(g: GroupItem, target: Target): void {
    if (!g.items.length) return;
    if (!isolated(g)) {
      this.drawItems(g.items, target);
      return;
    }
    const box = g.bounds ? this.deviceBox(g.bounds) : null;
    if (!box) {
      // Its shapes' records are in the frame all the same; nothing of them shows.
      return;
    }
    this.end();
    const own = this.target(this.inUse++, this.size.width, this.size.height);
    this.begin(own, true);
    this.drawItems(g.items, own);
    this.end();
    this.begin(target, false);
    this.pass!.setScissorRect(box.x, box.y, box.width, box.height);
    this.composite(own, g.opacity, g.blend, OFFSCREEN);
    this.pass!.setScissorRect(0, 0, this.size.width, this.size.height);
    this.inUse--;
  }

  private composite(source: Target, opacity: number, blend: GroupItem['blend'], format: GPUTextureFormat): void {
    const pass = this.pass!;
    source.composite ??= this.device.createBindGroup({
      layout: this.layouts.composite,
      entries: [
        { binding: 0, resource: source.view },
        { binding: 1, resource: { buffer: this.opacityBuffer } },
      ],
    });
    const k = this.opacities.push(opacity) - 1;
    const passes: Blend[] = blend === 'multiply' ? ['multiply-1', 'multiply-2'] : [blend];
    for (const b of passes) {
      pass.setPipeline(this.pipeline('composite', format, b));
      pass.setBindGroup(0, source.composite);
      pass.draw(3, 1, 0, k);
    }
    this.passPipeline = null;
  }

  private opacityData(): Float32Array<ArrayBuffer> {
    const out = new Float32Array(Math.max(1, this.opacities.length) * 4);
    this.opacities.forEach((o, i) => (out[i * 4] = o));
    return out;
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

  // ---- Targets

  private target(index: number, width: number, height: number): Target {
    const have = this.pool[index];
    if (have && have.width === width && have.height === height) return have;
    if (have) this.release(have);
    const texture = this.device.createTexture({
      size: [width, height],
      format: OFFSCREEN,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const t: Target = { texture, view: texture.createView(), width, height, composite: null };
    this.pool[index] = t;
    return t;
  }

  private release(t: Target): void {
    t.texture.destroy();
    const i = this.pool.indexOf(t);
    if (i >= 0) this.pool.splice(i, 1);
  }
}
