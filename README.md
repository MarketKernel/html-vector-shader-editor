# HTML Vector Editor

A vector editor as **one standalone HTML file**, drawn with WebGPU or WebGL 2. It opens
from disk, works offline and loads nothing from the network.

One document, several representations. The document is a vector model (JSON) that exists
apart from the renderer, and it exports without loss to:

1. **SVG** — a plain file for browsers and Inkscape;
2. **GLSL ES 3.00** — a stand-alone fragment shader that draws the same picture on a GPU;
3. **WGSL** — the same shader for WebGPU, a module with its vertex and fragment entry
   points;
4. **PNG** — the composited picture, at 1×, 2× or 4× the document's size;
5. **Shadertoy** — the GLSL shader in [shadertoy.com](https://www.shadertoy.com/)'s form,
   ready to paste.

```text
                    Document (JSON, vector model)
                                 │
     ┌───────────┬───────────┬───┴───────┬───────────┬───────────┐
     ↓           ↓           ↓           ↓           ↓           ↓
  WebGPU /     SVG         GLSL        WGSL        PNG       Shadertoy
  WebGL 2     export      export      export      export      export
  (screen)
```

The editor, the SVG and the exported shaders give the same picture, and an automated test
checks it.

## Use it

Download `vector-v<version>.html` from the
[releases](https://github.com/MarketKernel/html-vector-shader-editor/releases), or build it
(below), and open it in Chrome, Edge, Firefox or Safari. That one file is the whole
program: copy it anywhere, mail it, put it on a USB stick.

Or open it on [GitHub Pages](https://marketkernel.github.io/html-vector-shader-editor/) and
install it as an app (the install button in the address bar; Share → Add to Home Screen on
an iPhone). It works offline from then on, and updates itself on the next start after a new
deploy.

Drop a `.vector.json` file on the window to open it, an `.svg` to place it into the
document, or a `.ttf` / `.otf` font to use it.

The interface is in Russian for now.

## What it does

**Tools** — one key each, by its place on the keyboard, so any layout works.

| Tool | Key | |
|---|---|---|
| Select | V | Click picks, Shift+click adds, a drag on empty canvas draws a marquee. Eight handles scale (Shift keeps proportions, Alt scales about the centre); just outside a corner rotates (Shift: 15° steps). Drag inside moves, arrow keys nudge by 1 px (Shift: 10). A double click enters a group or edits a text (so does Enter), Esc leaves it. |
| Rectangle | R | Drag; Shift for a square, Alt from the centre. Corner radius in Properties. |
| Ellipse | E | The same; Shift for a circle. |
| Line | L | Drag; Shift snaps to 45°. |
| Pen | P | Click for a corner, drag for a smooth point (cubic Bézier). A click on the first point closes the path, Enter or a double click ends it open, Backspace removes the last point, Esc drops the path. |
| Text | T | A click starts a text there, a click on a text edits it. Type on the canvas: Enter for a new line, the arrows, Shift to select, a drag or a double click to select, the clipboard and input methods work as in any text field. Esc or a click elsewhere ends it. |
| Zoom, Pan | Z, H | Space or the middle button pans from any tool; ⌘/Ctrl + wheel or a pinch zooms to the pointer. |

Zoom is a property of the view only, 10 % to 6400 %: Zoom in, out, 100 %, Fit.

**Properties** — for the selection: name, X, Y, W, H and angle of its frame, corner
radius, fill (colour, opacity, none), stroke (colour, width, opacity, cap, join), fill
rule of paths, the font of texts (typeface, size, line height, letter spacing,
alignment), opacity, and the matrix of a single object as translate / rotate / scale.
Several objects show the values they share. With nothing selected: the document's size
and background, the style new shapes get, and with the text tool the font new texts get.
Always: the active layer's name, opacity and blend mode.

**Text** — set in the built-in Inter (Latin and Cyrillic) or in a font of your own
(File → Load font, or drop a `.ttf`, `.otf` or `.ttc` on the window): TrueType and CFF
outlines, kerning from GPOS and the `kern` table. A font loaded goes into the document
and travels with it, so it opens the same anywhere; a text pasted into another document
brings its font. Moving a text or scaling it the same both ways changes its position and
size; other transforms go into its matrix. Lines break only where you press Enter; there
are no ligatures and no right-to-left setting.

**Layers** — top first: eye, lock, name (double click renames), drag to reorder; new,
duplicate, delete, up, down. New shapes go into the active layer; objects move between
layers by Cut / Paste or Layer → Move to layer.

**Edit** — Undo / Redo (⌘Z, ⇧⌘Z) of every change; Cut, Copy, Paste, Duplicate (⌘X, C,
V, D), Delete, Select all, Group / Ungroup (⌘G, ⇧⌘G), Bring forward / Send backward (⌘],
⌘[), to front / to back (⌥⌘], ⌥⌘[). The clipboard is internal.

**Files** — New, Open, Save (⌘S), Save as, in the editor's own `.vector.json`. Where the
File System Access API exists, Save writes back to the same file; elsewhere it downloads.
Open also reads an SVG as a new document (Save then asks where to write its
`.vector.json`); File → Import SVG places one into the document — see below.
The document is kept in IndexedDB as it changes and offered back at the next start if it
was never saved; closing the page with unsaved changes asks first.

**Export** — SVG, PNG, GLSL, Shadertoy and WGSL, each with a preview, Copy and Save, and
a list of anything that could not be carried exactly. The shader dialogs compile the
text they show — editable — and draw it beside the editor's picture.

**Renderer** — WebGPU where the browser has it, WebGL 2 otherwise; View → Draw with
WebGPU / WebGL 2 switches and is remembered. The status bar says which is drawing. The PNG
export is drawn by the same kind of renderer as the screen.

## The document model

Document pixels, origin top left, Y down, as in SVG. The file carries a `version`; older
versions are migrated on reading, and a file the editor cannot make sense of is refused
with the reason.

```ts
type Document = { version: 2; width; height; background: string | null; layers: Layer[]; fonts: FontFace[] };
type Layer = { id; name; visible; locked; opacity; blend: 'normal' | 'multiply' | 'screen'; children: Node[] };
type Node = Group | Shape;  // every node: id, name?, visible, locked, opacity, transform: [a, b, c, d, e, f]
type Shape = (Rect | Ellipse | Line | Path | Text) & { fill: Fill; stroke: Stroke };
type Text = { text; x; y; font; size; lineHeight; letterSpacing; align: 'start' | 'middle' | 'end' };
type FontFace = { id; family; style; data };  // the font file, base64; id from its contents
```

A circle is an ellipse with `rx == ry` (exported as `<circle>`); a polygon is a closed
path. A text's (x, y) is the alignment point on its first line's baseline, as for SVG's
`<text>`; it names its font by id — `inter` for the built-in one, otherwise one of the
document's `fonts`. Opacity of a layer or a group applies to the result of compositing
its children. Blend formulas are the W3C Compositing and Blending ones, the same in the
renderers, the SVG (`mix-blend-mode`) and the shaders.

## SVG import

An SVG becomes the model, drawn as a browser draws the file wherever the model can say
it: rectangles, circles, ellipses, lines, polylines, polygons and paths (every command of
`d`; arcs become cubic curves within a few millionths of their radius), groups, `<a>`,
`<switch>`, nested `<svg>`, `<use>` of shapes, groups and `<symbol>`s; transforms,
opacity, fill and stroke with their opacity, width, caps, joins and fill rule; colours as
CSS writes them (names, `#rgb(a)`, `rgb()`, `hsl()`, `currentColor`); lengths in any unit.
Styles cascade as in a browser: presentation attributes, `<style>` sheets with tag, class
and id selectors joined by spaces or `>`, `style=""`, `!important`, inheritance.

Open makes the page the viewBox, so the file's coordinates stay as they were. Top-level
`<g>` elements are the layers when there is nothing else at the top — Inkscape's and
Illustrator's layers and this editor's own: name, visibility, lock, opacity and blend
mode — and a rectangle filling the page under them is the background. An SVG exported by
the editor reads back to the same document, but its texts stay outlines. Import SVG puts
the file into the active layer (or the entered group) as a group named after it, where
the file draws it, selected; its layers become groups.

A text is set in the built-in Inter, its lines from `<tspan>`s with their own y (as
Inkscape writes them). Whatever the model has no place for is listed when the file opens,
counted, never dropped silently: gradients (drawn in the average colour of their stops),
dashes, clipping, masks, filters, images, markers, another font or weight, per-letter
positions, a miter limit other than 4 where a corner is sharp enough for it to matter,
blend modes below a layer.

## Texts in the exports

Every output draws a text by its glyphs' outlines, so none of them depends on the fonts
of the machine that shows it. The SVG has a `<path>` with the words in its `aria-label`
(the export dialog says so: the picture is exact, but the words are no longer text). The
shaders get the outlines as path data, a chunk per glyph with its box: a pixel walks only
the glyphs near it, as a closed contour cannot wind around a point outside its box.

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

## The WGSL export

```wgsl
@group(0) @binding(0) var<uniform> viewport: Viewport;   // struct Viewport { size: vec2f }
@vertex   fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f
@fragment fn fs_main(@builtin(position) frag: vec4f) -> @location(0) vec4f
```

A render pipeline with the two entry points, a draw of three vertices (one triangle that
covers the viewport) and the viewport's size in pixels in the one uniform buffer. The
same constants, layer functions and compositing as the GLSL, over the WebGPU renderer's
own SDF library, the WGSL twin of the GLSL one. The output is premultiplied.

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
(miter limit 4), butt / round / square caps — so joins are exact. The exported shaders
call the same functions, so the PNG and the shaders agree by construction; the browser
draws the SVG itself. The WebGPU and WebGL 2 renderers run the same arithmetic, written
twice (WGSL and GLSL) line for line.

The browser test renders `tests/fixtures/showcase.vector.json` — every shape type, a
group with opacity, a `multiply` layer, a `screen` layer, rotation and a path with curves
and an even-odd hole — and `tests/fixtures/text.vector.json` — texts in the built-in font
and in a CFF font the document carries, kerned, spaced, aligned, turned and outlined —
every way and compares them pixel by pixel. A pixel *differs* if any premultiplied
channel is off by more than 32 / 255 (antialiasing differs between rasterizers; shapes,
colours, order and blending may not):

| | allowed | measured |
|---|---|---|
| PNG against SVG (drawn by Chrome) | 0.5 % of pixels | 0.17 % |
| PNG against GLSL | 0.1 % of pixels | 0 (largest difference 4 / 255) |
| PNG against Shadertoy | 0.1 % of pixels | 0 (largest difference 4 / 255) |
| PNG against WGSL | 0.1 % of pixels | 0 (largest difference 4 / 255) |
| WebGPU against WebGL 2 | 0.1 % of pixels | 0 (largest difference 0 / 255) |
| Texts: PNG against SVG | 1 % of pixels | 0.77 % (0.36 % at 2×) |
| Texts: PNG against GLSL | 0.1 % of pixels | 0 (largest difference 8 / 255) |
| Imported SVG: PNG against the file (drawn by Chrome) | 0.5 % of pixels | 0.26 % |

Small glyphs are mostly edge, where Chrome's area coverage and the shaders' one-pixel
distance ramp part most (corners, thin stems), hence the wider allowance for texts at 1×.
The imported file is `tests/fixtures/import.svg`, written as other editors write SVG:
style sheets, arcs and smooth curves, `<use>`, `<symbol>`, a nested `<svg>`, layers.

## Build and test

Node 20 or later.

```sh
npm install
npm run build          # build/vector.html and build/pages/
npm run watch          # rebuild on every change, unminified
npm run check          # typecheck → unit tests → build → browser tests
npm run shots          # screenshots into shots/
```

Unit tests run in Node with no framework (`tools/load.mjs` compiles the `src/` modules
they need): matrices, the model and its undo / redo, Bézier flattening and stroke
pieces, the file format both ways, the SVG export as exact text, the SVG import (path
data, transforms, colours, the cascade, layers, texts, warnings), the GLSL and WGSL
exports' structure and constants, reading fonts (against fontTools' outlines and
HarfBuzz's kerned advances), setting texts. The browser tests drive the built page in
headless Chrome over the DevTools protocol with Node's own WebSocket
(`CHROME=/path/to/chrome` if it is elsewhere); WebGL and WebGPU both run on SwiftShader.

The build also writes `build/pages/`: the same page as a PWA — a manifest, icons and a
service worker; the browser tests open it over HTTP and again with the server gone. Its PNG
icons are kept in `src/assets/pwa/`; after the icon in `src/app/icons.ts` changes,
`node tools/icons.mjs` draws them again (with Chrome).

The built-in font, `src/assets/Inter-Regular.ttf`, is Inter 4 at weight 400, optical size
14, its overlaps removed and cut down to Latin, Cyrillic and common punctuation, made once
with fontTools:

```sh
fonttools varLib.instancer 'Inter[opsz,wght].ttf' wght=400 opsz=14 --remove-overlaps -o Inter-400.ttf
pyftsubset Inter-400.ttf --unicodes='U+0020-007E,U+00A0-00FF,U+0100-017F,U+0400-045F,U+0490-0491,U+2010-2027,U+2030-203A,U+20AC,U+20BD,U+2116,U+2122,U+2190-2193,U+2212' \
  --layout-features=kern --no-hinting --desubroutinize --name-IDs=0,1,2,4,6,13,14 --drop-tables+=STAT,gasp,GSUB --output-file=Inter-Regular.ttf
```

## Releases

GitHub Actions does the publishing:

- every branch other than `main` and every pull request is tested;
- every push to `main` is tested and deployed to GitHub Pages (Settings → Pages → Source:
  GitHub Actions, once);
- a tag `v<version>` builds, tests and publishes a release with `vector-v<version>.html`
  and its `SHA256SUMS.txt`. The tag must match `package.json`'s version:

  ```sh
  npm version 0.2.0      # writes package.json, commits, tags v0.2.0
  git push --follow-tags
  ```

## Inside

```text
src/core/           no DOM; what the unit tests cover
  types.ts          the model
  ops.ts            the only ways the document changes, each with apply and revert
  history.ts        undo / redo over ops; steps with one key merge (a drag)
  actions.ts        transform, group, ungroup, reorder, move to layer, duplicate, paste
  document.ts       finding nodes, matrices of their groups, copies
  geometry.ts       flattening, stroke pieces, signed distances, hit tests, bounds
  font.ts fonts.ts  reading TrueType / CFF fonts; fonts by id, the built-in one
  text.ts           setting a text: lines, glyphs, kerning, carets
  draw.ts           the document as a renderer-neutral draw list
  sdf.ts            the SDF library in GLSL and in WGSL, shared by renderers and exports
  shader.ts         what the shader exports share; glsl.ts, wgsl.ts spell it out
  svg.ts            the SVG export
  svg-import.ts     the SVG import; xml.ts, the XML it reads
  serialize.ts      the .vector.json format, its checks and migrations
src/app/
  app.ts            state: document, history, selection, tool, style, file
  view.ts           zoom and pan, pointer input, the overlay of handles; which renderer
  render/           the WebGL 2 and WebGPU renderers; running a stand-alone shader
  tools/            select, rectangle, ellipse, line, pen, text, zoom, pan
  ui/               menu bar, toolbox and status, properties, layers, dialogs
  commands.ts       every command with its shortcut; the keyboard
  edit.ts io.ts export.ts
src/assets/         the built-in font and its licence; pwa/, the PWA's PNG icons
src/pwa/sw.js       the service worker of the GitHub Pages build
tools/              load.mjs (compiles src/ for the tests), icons.mjs (draws the icons)
build.mjs           esbuild → one HTML file with everything inlined, and build/pages/
.github/workflows/  tests, the GitHub Pages deploy, releases from v* tags
```

## Not in this version

Raster images, gradients and patterns, dashes, editing a path's points after it is drawn,
boolean operations, alignment and snapping, text along a path, wrapped text in a box,
ligatures and right-to-left scripts, WOFF fonts, other interface languages. `Fill`,
`Stroke` and `Shape` are discriminated unions, so these can join later as new variants.

## License

MIT. The built-in font Inter is © The Inter Project Authors, under the SIL Open Font
License 1.1 (`src/assets/Inter-OFL.txt`).
