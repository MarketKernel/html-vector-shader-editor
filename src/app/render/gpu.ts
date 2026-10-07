// The one WebGPU device the page uses — for the view, the PNG export and the WGSL
// preview — asked for once and asked for again after it is lost; and running a WGSL
// module the way the WGSL export's header says to.

export class WgslError extends Error {}

let device: Promise<GPUDevice | null> | null = null;
const lostListeners = new Set<() => void>();

// Null where the browser has no WebGPU or no adapter for it.
export function gpuDevice(): Promise<GPUDevice | null> {
  if (device) return device;
  device = (async () => {
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return null;
      const d = await adapter.requestDevice({
        // The path data and the shapes can be large; ask for what the adapter allows.
        requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize },
      });
      void d.lost.then(() => {
        device = null;
        lostListeners.forEach((fn) => fn());
      });
      return d;
    } catch {
      return null;
    }
  })();
  return device;
}

export const onDeviceLost = (fn: () => void): void => void lostListeners.add(fn);

// A shader module's errors as one message, "line:column message" each.
export async function compileWgsl(gpu: GPUDevice, code: string): Promise<GPUShaderModule> {
  gpu.pushErrorScope('validation');
  const module = gpu.createShaderModule({ code });
  const info = await module.getCompilationInfo();
  const scoped = await gpu.popErrorScope();
  const errors = info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
  if (errors.length) throw new WgslError(errors.join('\n'));
  if (scoped) throw new WgslError(scoped.message);
  return module;
}

const blend = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } as const;

// Draws a WGSL module as the export's header says: vs_main and fs_main, three vertices,
// the viewport's size in a uniform buffer at group 0, binding 0. Into an offscreen
// texture, read back as straight-alpha pixels, top row first.
export async function runWgsl(code: string, width: number, height: number): Promise<ImageData> {
  const gpu = await gpuDevice();
  if (!gpu) throw new WgslError('WebGPU недоступен в этом браузере');
  const module = await compileWgsl(gpu, code);
  gpu.pushErrorScope('validation');
  const pipeline = gpu.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm', blend }] },
  });
  const size = gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  gpu.queue.writeBuffer(size, 0, new Float32Array([width, height, 0, 0]));
  const texture = gpu.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const group = gpu.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: size } }] });
  const encoder = gpu.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.draw(3);
  pass.end();
  const error = await gpu.popErrorScope();
  if (error) {
    texture.destroy();
    size.destroy();
    throw new WgslError(error.message);
  }
  try {
    return await readTexture(gpu, texture, encoder);
  } finally {
    texture.destroy();
    size.destroy();
  }
}

// A texture's pixels: copied out after `encoder`'s work, unpremultiplied. Rows of a copy
// are padded to 256 bytes.
export async function readTexture(gpu: GPUDevice, texture: GPUTexture, encoder = gpu.createCommandEncoder()): Promise<ImageData> {
  const { width, height } = texture;
  const stride = Math.ceil((width * 4) / 256) * 256;
  const buffer = gpu.createBuffer({ size: stride * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride, rowsPerImage: height }, [width, height]);
  gpu.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const raw = new Uint8Array(buffer.getMappedRange());
  const out = new ImageData(width, height);
  // bgra8unorm keeps red and blue the other way round.
  const swap = texture.format === 'bgra8unorm';
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = y * stride + x * 4;
      const to = (y * width + x) * 4;
      const a = raw[from + 3]!;
      out.data[to + 3] = a;
      if (!a) continue;
      for (let k = 0; k < 3; k++) out.data[to + k] = Math.min(255, Math.round((raw[from + (swap ? 2 - k : k)]! * 255) / a));
    }
  }
  buffer.unmap();
  buffer.destroy();
  return out;
}
