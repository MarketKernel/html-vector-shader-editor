// The part of WebGPU this editor uses. TypeScript's DOM library does not describe WebGPU
// yet, and a package of its types would be a dependency; these are written from the W3C
// specification, for what the renderer, the export and the shader preview call.

interface Navigator {
  readonly gpu?: GPU;
}

interface HTMLCanvasElement {
  getContext(contextId: 'webgpu'): GPUCanvasContext | null;
}

interface GPU {
  requestAdapter(options?: { powerPreference?: 'low-power' | 'high-performance' }): Promise<GPUAdapter | null>;
  getPreferredCanvasFormat(): GPUTextureFormat;
}

type GPUTextureFormat = 'rgba8unorm' | 'bgra8unorm' | (string & {});

interface GPUAdapter {
  readonly info?: { vendor: string; architecture: string; device: string; description: string };
  readonly limits: GPUSupportedLimits;
  requestDevice(descriptor?: { requiredLimits?: Record<string, number> }): Promise<GPUDevice>;
}

interface GPUSupportedLimits {
  readonly maxTextureDimension2D: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxBufferSize: number;
}

interface GPUDeviceLostInfo {
  readonly reason: 'unknown' | 'destroyed';
  readonly message: string;
}

interface GPUError {
  readonly message: string;
}

interface GPUDevice {
  readonly limits: GPUSupportedLimits;
  readonly queue: GPUQueue;
  readonly lost: Promise<GPUDeviceLostInfo>;
  createShaderModule(descriptor: { code: string; label?: string }): GPUShaderModule;
  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline;
  createBuffer(descriptor: { size: number; usage: number; mappedAtCreation?: boolean; label?: string }): GPUBuffer;
  createTexture(descriptor: { size: [number, number] | { width: number; height: number }; format: GPUTextureFormat; usage: number; label?: string }): GPUTexture;
  createBindGroup(descriptor: { layout: GPUBindGroupLayout; entries: GPUBindGroupEntry[] }): GPUBindGroup;
  createBindGroupLayout(descriptor: { entries: GPUBindGroupLayoutEntry[] }): GPUBindGroupLayout;
  createPipelineLayout(descriptor: { bindGroupLayouts: GPUBindGroupLayout[] }): GPUPipelineLayout;
  createCommandEncoder(): GPUCommandEncoder;
  pushErrorScope(filter: 'validation' | 'out-of-memory' | 'internal'): void;
  popErrorScope(): Promise<GPUError | null>;
  destroy(): void;
}

interface GPUQueue {
  writeBuffer(buffer: GPUBuffer, offset: number, data: BufferSource, dataOffset?: number, size?: number): void;
  submit(commands: GPUCommandBuffer[]): void;
  onSubmittedWorkDone(): Promise<void>;
}

interface GPUCompilationMessage {
  readonly message: string;
  readonly type: 'error' | 'warning' | 'info';
  readonly lineNum: number;
  readonly linePos: number;
}

interface GPUShaderModule {
  getCompilationInfo(): Promise<{ readonly messages: readonly GPUCompilationMessage[] }>;
}

type GPUBlendFactor = 'zero' | 'one' | 'src' | 'one-minus-src' | 'src-alpha' | 'one-minus-src-alpha' | 'dst' | 'one-minus-dst' | 'dst-alpha' | 'one-minus-dst-alpha';

interface GPUBlendComponent {
  srcFactor: GPUBlendFactor;
  dstFactor: GPUBlendFactor;
  operation?: 'add';
}

interface GPUColorTargetState {
  format: GPUTextureFormat;
  blend?: { color: GPUBlendComponent; alpha: GPUBlendComponent };
}

interface GPUBindGroupLayoutEntry {
  binding: number;
  visibility: number;
  buffer?: { type: 'uniform' | 'read-only-storage' };
  texture?: { sampleType: 'float' | 'unfilterable-float' };
}

interface GPUPipelineLayout {
  readonly __brand?: 'GPUPipelineLayout';
}

interface GPURenderPipelineDescriptor {
  layout: GPUPipelineLayout | 'auto';
  vertex: { module: GPUShaderModule; entryPoint: string };
  fragment: { module: GPUShaderModule; entryPoint: string; targets: GPUColorTargetState[] };
  primitive?: { topology: 'triangle-list' };
}

interface GPURenderPipeline {
  getBindGroupLayout(index: number): GPUBindGroupLayout;
}

interface GPUBindGroupLayout {
  readonly __brand?: 'GPUBindGroupLayout';
}

interface GPUBindGroup {
  readonly __brand?: 'GPUBindGroup';
}

interface GPUBindGroupEntry {
  binding: number;
  resource: GPUTextureView | { buffer: GPUBuffer; offset?: number; size?: number };
}

interface GPUBuffer {
  readonly size: number;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

interface GPUTexture {
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  createView(): GPUTextureView;
  destroy(): void;
}

interface GPUTextureView {
  readonly __brand?: 'GPUTextureView';
}

interface GPUCommandBuffer {
  readonly __brand?: 'GPUCommandBuffer';
}

interface GPURenderPassColorAttachment {
  view: GPUTextureView;
  loadOp: 'clear' | 'load';
  storeOp: 'store' | 'discard';
  clearValue?: [number, number, number, number];
}

interface GPUCommandEncoder {
  beginRenderPass(descriptor: { colorAttachments: GPURenderPassColorAttachment[] }): GPURenderPassEncoder;
  copyTextureToBuffer(source: { texture: GPUTexture }, destination: { buffer: GPUBuffer; bytesPerRow: number; rowsPerImage?: number }, size: [number, number]): void;
  finish(): GPUCommandBuffer;
}

interface GPURenderPassEncoder {
  setPipeline(pipeline: GPURenderPipeline): void;
  setBindGroup(index: number, group: GPUBindGroup): void;
  setScissorRect(x: number, y: number, width: number, height: number): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
  end(): void;
}

interface GPUCanvasContext {
  configure(configuration: { device: GPUDevice; format: GPUTextureFormat; alphaMode?: 'opaque' | 'premultiplied' }): void;
  unconfigure(): void;
  getCurrentTexture(): GPUTexture;
}

declare const GPUBufferUsage: { readonly MAP_READ: number; readonly COPY_SRC: number; readonly COPY_DST: number; readonly UNIFORM: number; readonly STORAGE: number };
declare const GPUTextureUsage: { readonly COPY_SRC: number; readonly COPY_DST: number; readonly TEXTURE_BINDING: number; readonly RENDER_ATTACHMENT: number };
declare const GPUMapMode: { readonly READ: number };
declare const GPUShaderStage: { readonly VERTEX: number; readonly FRAGMENT: number };
