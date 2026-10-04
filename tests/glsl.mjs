/**
 * GLSL export: the shader's structure (version, the one uniform, a function per layer and
 * group, blends in main), the geometry as constants, and the float literals GLSL needs.
 * The browser tests compile it and compare its picture with the PNG export.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checker, load, root } from '../tools/load.mjs';

const c = await load('core/glsl.ts', 'core/serialize.ts', 'core/shapes.ts', 'core/document.ts', 'core/sdf.ts');
const { check, ok, done } = checker();

check('float literals', ['1.0', '-0.5', '0.0', '1.0e-7', '1234568.0', '0.3333333'], [c.glf(1), c.glf(-0.5), c.glf(-0), c.glf(1e-7), c.glf(1234567.89), c.glf(1 / 3)]);

const doc = c.parseDocument(await readFile(join(root, 'tests/fixtures/showcase.vector.json'), 'utf8'));
const { text, warnings } = c.exportGlsl(doc, 'Showcase');
const lines = text.split('\n');
check('#version first', lines[0], '#version 300 es');
ok('one uniform, uResolution', (text.match(/^uniform /gm) ?? []).length === 1 && /^uniform vec2 uResolution;/m.test(text));
ok('an output', /^out vec4 fragColor;/m.test(text));
ok('says how to run it', text.includes('// To run:'));
ok('the library is in it', text.includes(c.SDF_LIBRARY.trim()));
check('a function per visible layer', [...text.matchAll(/^vec4 (layer\d+)\(vec2 p, float px\)/gm)].map((m) => m[1]), ['layer0', 'layer1', 'layer2']);
check('and per group', [...text.matchAll(/^vec4 (group\d+)\(/gm)].map((m) => m[1]), ['group0']);
ok('groups come before the layer that calls them', text.indexOf('vec4 group0(') < text.indexOf('vec4 layer0('));
check(
  'main composites with opacity and blend',
  lines.filter((l) => /^ {2}c = blend\w+\(c, layer/.test(l)),
  ['  c = blendNormal(c, layer0(p, px));', '  c = blendMultiply(c, layer1(p, px) * 0.9);', '  c = blendScreen(c, layer2(p, px));'],
);
ok('the group with its opacity', text.includes('c = blendNormal(c, group0(p, px) * 0.6);'));
ok('white background', text.includes('vec4 c = vec4(1.0, 1.0, 1.0, 1.0);'));
ok('antialiasing from fwidth', text.includes('fwidth(p)'));
ok('the hidden rect is not drawn', !text.includes('hidden') && !text.includes('Hidden layer'));
ok('a rect with its numbers', text.includes('paintRect(q, vec4(20.0, 20.0, 200.0, 120.0), 16.0, vec4(0.3098039, 0.5568627, 0.9686275, 1.0), vec4(0.1137255, 0.1411765, 0.2, 1.0), 2.0, 0, px * 1.0)'));
ok('the tilted one through its inverse matrix', text.includes('vec2 q = mat2(0.9396927, -0.3420201, 0.3420201, 0.9396927) * p + vec2(-295.5886, 65.01833);'));
ok('a circle', text.includes('paintEllipse(q, vec2(410.0, 250.0), vec2(50.0, 50.0)'));
ok('opacity of a shape', /paintEllipse\(q, vec2\(120\.0, 230\.0\).*\) \* 0\.8\);/.test(text));
ok('a round-capped line', text.includes('paintLine(q, vec2(20.0, 300.0), vec2(230.0, 170.0), vec4(0.4313725, 0.3372549, 0.8117647, 1.0), 4.0, 1, px * 1.0)'));
const dataSize = Number(/const vec4 DATA\[(\d+)\]/.exec(text)[1]);
const entries = text.slice(text.indexOf('const vec4 DATA'), text.indexOf(');', text.indexOf('const vec4 DATA'))).match(/vec4\(/g).length;
check('the data array holds what it declares', entries, dataSize);
const ring = /paintPath\(q, (\d+), (\d+), (\d+), (\d+), (\d+), (\d+), (true|false)/.exec(text);
check('the ring: even-odd, edges first', [ring[1], ring[7]], ['0', 'true']);
ok('the ring’s edges, then its stroke quads and joins', Number(ring[3]) === Number(ring[2]) && Number(ring[5]) === Number(ring[3]) + 2 * Number(ring[4]) && Number(ring[6]) > 0);
ok('the zigzag’s bevel stroke has no discs', /paintPath\(q, \d+, 4, \d+, 5, \d+, 0, false/.test(text));
ok('the first edge of the ring starts at its first point', text.includes('vec4(250.0, 150.0,'));
check('nothing to warn about', warnings, []);

// An empty document still compiles: the data array cannot be empty.
const empty = c.exportGlsl(c.createDocument(10, 10, null), 'Empty');
ok('a placeholder array', empty.text.includes('const vec4 DATA[1] = vec4[1](vec4(0.0));'));
ok('transparent', empty.text.includes('vec4 c = vec4(0.0);'));

// A lone point with a round cap: SVG would draw a dot; the shader says it does not.
const dotted = c.createDocument(10, 10, null);
const p = c.makePath([['M', 1, 1], ['L', 5, 5], ['M', 8, 8]], { fill: null, stroke: { color: '#000000', opacity: 1, width: 2, cap: 'round', join: 'round' } }, 'dots');
dotted.layers[0].children.push(p);
check('warns about a lost dot', c.exportGlsl(dotted).warnings.length, 1);

// Shadertoy: the same body, its own entry point and nothing Shadertoy declares itself.
{
  const toy = c.exportShadertoy(doc, 'Showcase');
  const t = toy.text;
  ok('no #version', !/^#version/m.test(t));
  ok('no precision, uniform or out declarations', !/^(precision|uniform|out|in) /m.test(t));
  ok('mainImage, not main', /^void mainImage\(out vec4 fragColor, in vec2 fragCoord\) \{$/m.test(t) && !/^void main\(\)/m.test(t));
  ok('sized by iResolution', t.includes('iResolution.x / size.x'));
  ok('opaque output', t.includes('fragColor = vec4(colour, 1.0);'));
  ok('says where to paste it', t.includes('shadertoy.com'));
  const body = (s) => s.slice(s.indexOf('const vec4 DATA'), s.indexOf('// The whole page at document point p'));
  check('the very same geometry and library as the plain export', body(t), body(text));
  ok('the same compositing', t.includes('c = blendMultiply(c, layer1(p, px) * 0.9);'));
  check('the same warnings', toy.warnings, warnings);
  const wrapped = c.shadertoyStandalone(t);
  check('the stand-alone wrapper starts with #version', wrapped.split('\n')[0], '#version 300 es');
  const shift = wrapped.split('\n').findIndex((l) => l.startsWith('// "Showcase"'));
  check('compiler lines point into the pasted text', c.shadertoyLog(`ERROR: 0:${shift + 3}: oops`), 'ERROR: 0:3: oops');
  ok('and calls mainImage', wrapped.includes('mainImage(shadertoyColor, gl_FragCoord.xy);') && wrapped.includes('#define iResolution vec3(uResolution, 1.0)'));
}

done('glsl');
