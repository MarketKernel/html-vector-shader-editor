# HTML Vector Editor

A vector editor as **one standalone HTML file**, drawn with WebGL 2. It opens from disk,
works offline and loads nothing from the network.

One document, several representations. The document is a vector model (JSON) that exists
apart from the renderer, and it exports without loss to:

1. **SVG** — a plain file for browsers and Inkscape;
2. **GLSL ES 3.00** — a stand-alone fragment shader that draws the same picture on a GPU;
3. **PNG** — the composited picture, at 1×, 2× or 4× the document's size;
4. **Shadertoy** — the same shader in [shadertoy.com](https://www.shadertoy.com/)'s form,
   ready to paste.

```text
            Document (JSON, vector model)
                 │
     ┌───────────┼───────────┬───────────┐
     ↓           ↓           ↓           ↓
  WebGL       SVG         GLSL         PNG
 (screen)    export      export      export
```

The editor, the SVG and the exported shader give the same picture, and an automated test
checks it.

## Use it

Build it (below) and open `build/vector.html` in Chrome, Edge, Firefox or Safari. That
file is the whole program. Drop a `.vector.json` file on the window to open it.

The interface is in Russian for now.

## What it does

**Tools** — one key each, by its place on the keyboard, so any layout works.

| Tool | Key | |
|---|---|---|
| Select | V | Click picks, Shift+click adds, a drag on empty canvas draws a marquee. Eight handles scale (Shift keeps proportions, Alt scales about the centre); just outside a corner rotates (Shift: 15° steps). Drag inside moves, arrow keys nudge by 1 px (Shift: 10). A double click enters a group, Esc leaves it. |
| Rectangle | R | Drag; Shift for a square, Alt from the centre. Corner radius in Properties. |
| Ellipse | E | The same; Shift for a circle. |
| Line | L | Drag; Shift snaps to 45°. |
| Pen | P | Click for a corner, drag for a smooth point (cubic Bézier). A click on the first point closes the path, Enter or a double click ends it open, Backspace removes the last point, Esc drops the path. |
| Zoom, Pan | Z, H | Space or the middle button pans from any tool; ⌘/Ctrl + wheel or a pinch zooms to the pointer. |

Zoom is a property of the view only, 10 % to 6400 %: Zoom in, out, 100 %, Fit.

**Properties** — for the selection: name, X, Y, W, H and angle of its frame, corner
radius, fill (colour, opacity, none), stroke (colour, width, opacity, cap, join), fill
rule of paths, opacity, and the matrix of a single object as translate / rotate / scale.
Several objects show the values they share. With nothing selected: the document's size
and background, and the style new shapes get. Always: the active layer's name, opacity
and blend mode.

**Layers** — top first: eye, lock, name (double click renames), drag to reorder; new,
duplicate, delete, up, down. New shapes go into the active layer; objects move between
layers by Cut / Paste or Layer → Move to layer.

**Edit** — Undo / Redo (⌘Z, ⇧⌘Z) of every change; Cut, Copy, Paste, Duplicate (⌘X, C,
V, D), Delete, Select all, Group / Ungroup (⌘G, ⇧⌘G), Bring forward / Send backward (⌘],
⌘[), to front / to back (⌥⌘], ⌥⌘[). The clipboard is internal.

**Files** — New, Open, Save (⌘S), Save as, in the editor's own `.vector.json`. Where the
File System Access API exists, Save writes back to the same file; elsewhere it downloads.
The document is kept in IndexedDB as it changes and offered back at the next start if it
was never saved; closing the page with unsaved changes asks first.

**Export** — SVG, PNG, GLSL and Shadertoy, each with a preview, Copy and Save, and a list
of anything that could not be carried exactly. The shader dialogs compile the text they
show — editable — and draw it beside the editor's picture.

## The document model

Document pixels, origin top left, Y down, as in SVG. The file carries a `version`; older
versions are migrated on reading, and a file the editor cannot make sense of is refused
with the reason.

```ts
type Document = { version: 1; width: number; height: number; background: string | null; layers: Layer[] };
type Layer = { id; name; visible; locked; opacity; blend: 'normal' | 'multiply' | 'screen'; children: Node[] };
type Node = Group | Shape;  // every node: id, name?, visible, locked, opacity, transform: [a, b, c, d, e, f]
type Shape = (Rect | Ellipse | Line | Path) & { fill: Fill; stroke: Stroke };
```

A circle is an ellipse with `rx == ry` (exported as `<circle>`); a polygon is a closed
path. Opacity of a layer or a group applies to the result of compositing its children.
Blend formulas are the W3C Compositing and Blending ones, the same in the renderer, the
SVG (`mix-blend-mode`) and the shader.

## The GLSL export

```glsl
#version 300 es
precision highp float;
uniform vec2 uResolution;      // the viewport's size; the document fills the viewport
out vec4 fragColor;
```

Draw a quad over the whole viewport with it and set the one uniform. At `uResolution`
equal to the document's size its pixels are the PNG export's. Inside: the renderer's own
SDF functions (`src/core/sdf.ts`) with the geometry as constants — shapes as numbers,
flattened paths in one `const vec4 DATA[]` — one function per layer and per group, and
`main` compositing them with their opacity and blend. Antialiasing comes from `fwidth`.
The output is premultiplied, as WebGL's default canvas expects.

## The Shadertoy export

File → Export for Shadertoy gives the same constants, SDF library and layer functions,
in the form Shadertoy's Image tab wants: no `#version`, precision, uniform or output
declarations, `mainImage(out vec4 fragColor, in vec2 fragCoord)` and `iResolution`.
Shadertoy shows colour opaque and its view has its own proportions, so the page is fitted
into the view, centred; transparent parts show over grey squares, the rest is a dark
surround. At `iResolution` equal to the document's size the pixels are the PNG export's.
The dialog's preview runs the text wrapped as Shadertoy runs it.

## How it matches

The editor draws shapes as signed distance fields: a quad per shape, the fragment shader
computes the distance to the rectangle, ellipse, line or flattened path and colours by it.
Path strokes are built from SVG's own pieces — segment quads, miter / bevel / round joins
(miter limit 4), butt / round / square caps — so joins are exact. The exported shader
calls the same functions, so the PNG and the shader agree by construction; the browser
draws the SVG itself.

The browser test renders `tests/fixtures/showcase.vector.json` — every shape type, a
group with opacity, a `multiply` layer, a `screen` layer, rotation and a path with curves
and an even-odd hole — three ways and compares them pixel by pixel. A pixel *differs* if
any premultiplied channel is off by more than 32 / 255 (antialiasing differs between
rasterizers; shapes, colours, order and blending may not):

| | allowed | measured |
|---|---|---|
| PNG against SVG (drawn by Chrome) | 0.5 % of pixels | 0.17 % |
| PNG against GLSL | 0.1 % of pixels | 0 (largest difference 4 / 255) |
| PNG against Shadertoy | 0.1 % of pixels | 0 (largest difference 4 / 255) |

## Build and test

Node 20 or later.

```sh
npm install
npm run build          # build/vector.html
npm run watch          # rebuild on every change, unminified
npm run check          # typecheck → unit tests → build → browser tests
npm run shots          # screenshots into shots/
```

Unit tests run in Node with no framework (`tools/load.mjs` compiles the `src/` modules
they need): matrices, the model and its undo / redo, Bézier flattening and stroke
pieces, the file format both ways, the SVG export as exact text, the GLSL export's
structure and constants. The browser tests drive the built page in headless Chrome over
the DevTools protocol with Node's own WebSocket (`CHROME=/path/to/chrome` if it is
elsewhere).

## Inside

```text
src/core/           no DOM; what the unit tests cover
  types.ts          the model
  ops.ts            the only ways the document changes, each with apply and revert
  history.ts        undo / redo over ops; steps with one key merge (a drag)
  actions.ts        transform, group, ungroup, reorder, move to layer, duplicate, paste
  document.ts       finding nodes, matrices of their groups, copies
  geometry.ts       flattening, stroke pieces, signed distances, hit tests, bounds
  draw.ts           the document as a renderer-neutral draw list
  sdf.ts            the GLSL library shared by the renderer and the export
  svg.ts glsl.ts    the exporters (glsl.ts: the plain shader and the Shadertoy one)
  serialize.ts      the .vector.json format, its checks and migrations
src/app/
  app.ts            state: document, history, selection, tool, style, file
  view.ts           zoom and pan, pointer input, the overlay of handles
  render/           the WebGL 2 renderer; running a stand-alone fragment shader
  tools/            select, rectangle, ellipse, line, pen, zoom, pan
  ui/               menu bar, toolbox and status, properties, layers, dialogs
  commands.ts       every command with its shortcut; the keyboard
  edit.ts io.ts export.ts
build.mjs           esbuild → one HTML file with everything inlined
```

## Not in this version

Text, raster images, gradients and patterns, dashes, editing a path's points after it is
drawn, boolean operations, alignment and snapping, WebGPU, other interface languages.
`Fill`, `Stroke` and `Shape` are discriminated unions, so these can join later as new
variants.

## License

MIT.
