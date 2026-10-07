// The canvas: zoom and pan (a property of the view only — the document's coordinates never
// change), drawing on request, and pointer input passed to the tool in document
// coordinates. The document is drawn with WebGPU where the browser has it, with WebGL 2
// otherwise (or when asked), on one canvas; selection frames, handles and other aids are
// drawn on a 2D canvas over it.

import { locate } from '../core/document';
import { drawList } from '../core/draw';
import { apply } from '../core/matrix';
import type { Matrix } from '../core/types';
import { app } from './app';
import { gpuDevice, onDeviceLost } from './render/gpu';
import type { Backend, Pasteboard, ViewRenderer } from './render/renderer';
import { Renderer } from './render/renderer';
import { WebGpuRenderer } from './render/webgpu';
import { frameOf, selectionFrame } from './selection';
import type { ToolEvent } from './tools/tool';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 64;
// Curves are flattened to within this many device pixels on screen.
const VIEW_TOLERANCE = 0.2;

export const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'range', 'color'].includes(t.type)));

function cssColor(name: string, fallback: [number, number, number]): [number, number, number, number] {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(getComputedStyle(probe).color);
  probe.remove();
  const [r, g, b] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : fallback;
  return [r / 255, g / 255, b / 255, 1];
}

export class View {
  zoom = 1;
  panX = 0;
  panY = 0;
  renderer: ViewRenderer | null = null;
  error: string | null = null;
  cursor: { x: number; y: number } | null = null;
  readonly overlay: HTMLCanvasElement;
  // Settles once a renderer is running, or it is clear none can.
  ready: Promise<void> = Promise.resolve();
  private gl: WebGL2RenderingContext | null = null;
  private used = false;
  private frame = 0;
  private colors: Pasteboard | null = null;
  private spaceHeld = false;
  private panning: { x: number; y: number; panX: number; panY: number } | null = null;
  private pressed = false;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { distance: number; zoom: number; cx: number; cy: number; panX: number; panY: number } | null = null;
  private fitted = false;

  constructor(
    readonly workspace: HTMLElement,
    public canvas: HTMLCanvasElement,
    prefer: Backend = preferredBackend(),
  ) {
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'overlay';
    workspace.append(this.overlay);
    this.start(prefer);
    onDeviceLost(() => {
      if (this.renderer?.kind !== 'webgpu') return;
      this.renderer = null;
      this.showError('Устройство WebGPU потеряно. Пытаюсь восстановить…');
      this.start('webgpu');
    });
    new ResizeObserver(() => this.resize()).observe(workspace);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      this.colors = null;
      this.requestRender();
    });
    this.listen();
  }

  // Starts drawing with `prefer`, or with the other renderer if that one cannot run. A
  // canvas keeps the kind of context it was first given, so a second start gets a fresh one.
  start(prefer: Backend): Promise<void> {
    this.ready = (async () => {
      this.renderer?.dispose();
      this.renderer = null;
      this.gl = null;
      if (this.used) this.freshCanvas();
      this.used = true;
      const reasons: string[] = [];
      for (const kind of prefer === 'webgpu' ? (['webgpu', 'webgl2'] as const) : (['webgl2', 'webgpu'] as const)) {
        try {
          this.renderer = kind === 'webgpu' ? await this.startGpu() : this.startGl();
          break;
        } catch (error) {
          reasons.push((error as Error).message);
          // A canvas that gave one kind of context gives no other.
          this.freshCanvas();
        }
      }
      if (this.renderer) {
        this.error = null;
        this.workspace.querySelector('.view-error')?.remove();
      } else this.showError(`Ни WebGPU, ни WebGL 2 недоступны, поэтому холст не рисуется. Документ можно открыть, сохранить и экспортировать в SVG. ${reasons.join(' ')}`);
      app.emit('view');
      this.requestRender();
    })();
    return this.ready;
  }

  private async startGpu(): Promise<ViewRenderer> {
    if (!navigator.gpu) throw new Error('В браузере нет WebGPU.');
    const device = await gpuDevice();
    if (!device) throw new Error('WebGPU не дал устройство.');
    return new WebGpuRenderer(device, this.canvas);
  }

  private startGl(): ViewRenderer {
    this.gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!this.gl) throw new Error('Браузер не дал контекст WebGL 2.');
    const canvas = this.canvas;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (canvas !== this.canvas) return;
      this.renderer = null;
      this.showError('Контекст WebGL потерян. Пытаюсь восстановить…');
    });
    canvas.addEventListener('webglcontextrestored', () => canvas === this.canvas && this.start('webgl2'));
    return new Renderer(this.gl);
  }

  private freshCanvas(): void {
    const fresh = document.createElement('canvas');
    fresh.id = this.canvas.id;
    fresh.className = this.canvas.className;
    fresh.width = this.canvas.width;
    fresh.height = this.canvas.height;
    this.canvas.replaceWith(fresh);
    this.canvas = fresh;
  }

  private showError(text: string): void {
    this.error = text;
    let box = this.workspace.querySelector<HTMLElement>('.view-error');
    if (!box) {
      box = document.createElement('div');
      box.className = 'view-error';
      box.setAttribute('role', 'alert');
      this.workspace.append(box);
    }
    box.textContent = text;
  }

  // ---- Coordinates

  get dpr(): number {
    return window.devicePixelRatio || 1;
  }

  toScreen(x: number, y: number): { x: number; y: number } {
    return { x: x * this.zoom + this.panX, y: y * this.zoom + this.panY };
  }

  toDoc(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.panX) / this.zoom, y: (sy - this.panY) / this.zoom };
  }

  // Document → screen CSS pixels.
  get matrix(): Matrix {
    return [this.zoom, 0, 0, this.zoom, this.panX, this.panY];
  }

  // ---- Zoom and pan

  zoomTo(zoom: number, sx = this.workspace.clientWidth / 2, sy = this.workspace.clientHeight / 2): void {
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    const p = this.toDoc(sx, sy);
    this.zoom = z;
    this.panX = sx - p.x * z;
    this.panY = sy - p.y * z;
    this.changed();
  }

  // Steps through round numbers: …, 50 %, 66.7 %, 100 %, 150 %, 200 %, …
  zoomStep(dir: 1 | -1, sx?: number, sy?: number): void {
    const steps = [0.1, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
    const next = dir > 0 ? steps.find((s) => s > this.zoom * 1.01) : [...steps].reverse().find((s) => s < this.zoom / 1.01);
    this.zoomTo(next ?? this.zoom, sx, sy);
  }

  fit(): void {
    const w = this.workspace.clientWidth;
    const h = this.workspace.clientHeight;
    if (!w || !h) return;
    const margin = 32;
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min((w - 2 * margin) / app.doc.width, (h - 2 * margin) / app.doc.height)));
    this.zoom = z;
    this.panX = Math.round((w - app.doc.width * z) / 2);
    this.panY = Math.round((h - app.doc.height * z) / 2);
    this.fitted = true;
    this.changed();
  }

  actualSize(): void {
    this.zoomTo(1);
  }

  panBy(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
    this.changed();
  }

  private changed(): void {
    app.emit('view');
    this.requestRender();
  }

  // ---- Drawing

  private resize(): void {
    const w = this.workspace.clientWidth;
    const h = this.workspace.clientHeight;
    for (const c of [this.canvas, this.overlay]) {
      c.width = Math.max(1, Math.round(w * this.dpr));
      c.height = Math.max(1, Math.round(h * this.dpr));
    }
    if (!this.fitted) this.fit();
    this.requestRender();
  }

  requestRender(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  // Draws now; the tests call it so they need not wait for a frame.
  render(): void {
    this.renderDocument();
    this.renderOverlay();
  }

  private pasteboard(): Pasteboard {
    if (!this.colors) {
      this.colors = {
        clear: cssColor('--workspace', [200, 204, 211]),
        checkerLight: cssColor('--checker-light', [255, 255, 255]),
        checkerDark: cssColor('--checker-dark', [221, 224, 229]),
      };
    }
    return this.colors;
  }

  private renderDocument(): void {
    if (!this.renderer || this.gl?.isContextLost()) return;
    const dpr = this.dpr;
    // Whole device pixels for the page's corner, so a 100 % view is sharp.
    const px = Math.round(this.panX * dpr);
    const py = Math.round(this.panY * dpr);
    const device: Matrix = [this.zoom * dpr, 0, 0, this.zoom * dpr, px, py];
    const draft = app.draft;
    // Drafts are drawn in document coordinates, on top of their layer.
    const extra = draft ? { layerId: locate(app.doc, draft.parentId)?.layer.id ?? draft.parentId, node: draft.node, parent: [1, 0, 0, 1, 0, 0] as Matrix } : null;
    const list = drawList(app.doc, { tolerance: VIEW_TOLERANCE, scale: this.zoom * dpr, extra });
    this.renderer.renderView(list, device, this.canvas.width, this.canvas.height, this.pasteboard());
  }

  private renderOverlay(): void {
    const ctx = this.overlay.getContext('2d')!;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The page's edge.
    const a = this.toScreen(0, 0);
    const b = this.toScreen(app.doc.width, app.doc.height);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(a.x) - 0.5, Math.round(a.y) - 0.5, Math.round(b.x - a.x) + 1, Math.round(b.y - a.y) + 1);
    // The entered group, dashed.
    if (app.context) {
      const f = frameOf(app.doc, [app.context]);
      if (f) {
        ctx.setLineDash([4, 3]);
        this.strokeFrame(ctx, f, 'rgba(120, 120, 120, 0.9)');
        ctx.setLineDash([]);
      }
    }
    const frame = selectionFrame();
    if (frame && app.tool.id !== 'select') this.strokeFrame(ctx, frame, accent());
    app.tool.overlay?.(ctx);
  }

  strokeFrame(ctx: CanvasRenderingContext2D, f: Matrix, color: string): void {
    const pts = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ].map(([u, v]) => {
      const d = apply(f, u!, v!);
      return this.toScreen(d.x, d.y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
  }

  // ---- Input

  private event(e: PointerEvent | MouseEvent): ToolEvent {
    const r = this.overlay.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const p = this.toDoc(sx, sy);
    const mod = navigator.platform.startsWith('Mac') || /Mac OS X/.test(navigator.userAgent) ? e.metaKey : e.ctrlKey;
    return { x: p.x, y: p.y, sx, sy, shift: e.shiftKey, alt: e.altKey, mod, button: e.button };
  }

  updateCursor(e: ToolEvent | null = null): void {
    this.overlay.style.cursor = this.panning ? 'grabbing' : this.spaceHeld ? 'grab' : (app.tool.cursor?.(e) ?? 'default');
  }

  private listen(): void {
    const o = this.overlay;
    o.addEventListener('pointerdown', (e) => {
      o.setPointerCapture(e.pointerId);
      if (e.pointerType === 'touch') {
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.touches.size === 2) {
          // A second finger: whatever the first began gives way to pinching.
          if (this.pressed) app.tool.cancel?.();
          this.pressed = false;
          this.startPinch();
          return;
        }
      }
      if (e.button === 1 || this.spaceHeld || app.tool.id === 'pan') {
        e.preventDefault();
        this.panning = { x: e.clientX, y: e.clientY, panX: this.panX, panY: this.panY };
        this.updateCursor();
        return;
      }
      if (e.button !== 0) return;
      // Typing in a panel field ends there; typing a text on the canvas goes on.
      const active = document.activeElement;
      if (active instanceof HTMLElement && isTyping(active) && !active.classList.contains('text-input')) active.blur();
      this.pressed = true;
      app.tool.down?.(this.event(e));
    });
    o.addEventListener('pointermove', (e) => {
      const te = this.event(e);
      this.cursor = { x: te.x, y: te.y };
      app.emit('view');
      if (this.touches.has(e.pointerId)) {
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.pinch) return this.movePinch();
      }
      if (this.panning) {
        this.panX = this.panning.panX + e.clientX - this.panning.x;
        this.panY = this.panning.panY + e.clientY - this.panning.y;
        this.changed();
        return;
      }
      if (this.pressed) app.tool.move?.(te);
      else app.tool.hover?.(te);
      this.updateCursor(te);
    });
    const end = (e: PointerEvent) => {
      this.touches.delete(e.pointerId);
      if (this.pinch) {
        if (this.touches.size < 2) this.pinch = null;
        return;
      }
      if (this.panning) {
        this.panning = null;
        this.updateCursor();
        return;
      }
      if (!this.pressed) return;
      this.pressed = false;
      app.tool.up?.(this.event(e));
      this.updateCursor(this.event(e));
    };
    o.addEventListener('pointerup', end);
    o.addEventListener('pointercancel', end);
    o.addEventListener('pointerleave', () => {
      this.cursor = null;
      app.emit('view');
    });
    o.addEventListener('dblclick', (e) => app.tool.dblclick?.(this.event(e)));
    o.addEventListener('contextmenu', (e) => e.preventDefault());
    o.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = o.getBoundingClientRect();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        // A trackpad pinch arrives as a wheel with ctrlKey.
        if (e.ctrlKey || e.metaKey) this.zoomTo(this.zoom * Math.exp(-e.deltaY * unit * 0.01), e.clientX - r.left, e.clientY - r.top);
        else this.panBy(-(e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit, -(e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit);
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping(e.target) && !document.querySelector('dialog[open]')) {
        e.preventDefault();
        if (!this.spaceHeld) {
          this.spaceHeld = true;
          this.updateCursor();
        }
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceHeld = false;
        this.updateCursor();
      }
    });
    window.addEventListener('blur', () => {
      this.spaceHeld = false;
    });
  }

  private startPinch(): void {
    const [a, b] = [...this.touches.values()];
    const r = this.overlay.getBoundingClientRect();
    this.pinch = { distance: Math.hypot(b!.x - a!.x, b!.y - a!.y), zoom: this.zoom, cx: (a!.x + b!.x) / 2 - r.left, cy: (a!.y + b!.y) / 2 - r.top, panX: this.panX, panY: this.panY };
  }

  private movePinch(): void {
    const p = this.pinch!;
    const [a, b] = [...this.touches.values()];
    const r = this.overlay.getBoundingClientRect();
    const cx = (a!.x + b!.x) / 2 - r.left;
    const cy = (a!.y + b!.y) / 2 - r.top;
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (p.zoom * Math.hypot(b!.x - a!.x, b!.y - a!.y)) / Math.max(1, p.distance)));
    // The document point under the fingers' first midpoint follows the midpoint.
    const docX = (p.cx - p.panX) / p.zoom;
    const docY = (p.cy - p.panY) / p.zoom;
    this.zoom = z;
    this.panX = cx - docX * z;
    this.panY = cy - docY * z;
    this.changed();
  }
}

// The renderer asked for last (View → Renderer), else WebGPU where the browser has it.
export function preferredBackend(): Backend {
  try {
    const saved = localStorage.getItem('vector.renderer');
    if (saved === 'webgpu' || saved === 'webgl2') return saved;
  } catch {
    // Storage refused: the default.
  }
  return navigator.gpu ? 'webgpu' : 'webgl2';
}

export function rememberBackend(kind: Backend): void {
  try {
    localStorage.setItem('vector.renderer', kind);
  } catch {
    // Storage refused: it lasts this session.
  }
}

export const accent = (): string => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2f6df6';
