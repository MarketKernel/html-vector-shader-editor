// What a tool is: pointer events in document coordinates, an optional key handler, and
// whatever it wants drawn over the canvas (handles, a marquee, a path being drawn).

export interface ToolEvent {
  // Document coordinates.
  x: number;
  y: number;
  // Screen (CSS pixel) coordinates within the canvas.
  sx: number;
  sy: number;
  shift: boolean;
  alt: boolean;
  mod: boolean;
  button: number;
}

export interface Tool {
  id: string;
  label: string;
  // The letter of its key, by KeyboardEvent.code (KeyV → 'V').
  key: string;
  icon: string;
  hint: string;
  cursor?(e: ToolEvent | null): string;
  down?(e: ToolEvent): void;
  move?(e: ToolEvent): void;
  up?(e: ToolEvent): void;
  // Pointer moves with no button held.
  hover?(e: ToolEvent): void;
  dblclick?(e: ToolEvent): void;
  // True when the key was the tool's.
  keydown?(e: KeyboardEvent): boolean;
  // Esc: true when there was something to cancel.
  cancel?(): boolean;
  // Work in progress that Undo should drop rather than commit (a path being drawn).
  pending?(): boolean;
  // Commits work in progress before a command or another tool.
  finish?(): void;
  overlay?(ctx: CanvasRenderingContext2D): void;
}
