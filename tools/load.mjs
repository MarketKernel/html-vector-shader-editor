/**
 * Compiles a few src/ modules for Node, so the tests exercise the very code the
 * page runs.
 */
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = dirname(dirname(fileURLToPath(import.meta.url)));

export async function load(...modules) {
  const result = await build({
    stdin: {
      contents: modules.map((name) => `export * from './src/${name}';`).join('\n'),
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    write: false,
    logLevel: 'silent',
  });
  const dir = await mkdtemp(join(tmpdir(), 'vector-test-'));
  const file = join(dir, 'bundle.cjs');
  await writeFile(file, result.outputFiles[0].text);
  try {
    return createRequire(import.meta.url)(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function checker() {
  let passed = 0;
  let failed = 0;
  const check = (name, actual, expected) => {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a === b) passed += 1;
    else {
      failed += 1;
      console.error(`FAIL  ${name}\n  expected: ${b}\n  actual:   ${a}`);
    }
  };
  // Numbers, or arrays of numbers, equal to within eps.
  const near = (name, actual, expected, eps = 1e-9) => {
    const a = [actual].flat(Infinity);
    const b = [expected].flat(Infinity);
    if (a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps)) passed += 1;
    else {
      failed += 1;
      console.error(`FAIL  ${name}\n  expected: ${JSON.stringify(expected)} ±${eps}\n  actual:   ${JSON.stringify(actual)}`);
    }
  };
  const ok = (name, condition) => check(name, !!condition, true);
  const done = (label) => {
    console.log(`${label}: ${passed} passed, ${failed} failed`);
    if (failed) process.exit(1);
  };
  return { check, near, ok, done };
}
