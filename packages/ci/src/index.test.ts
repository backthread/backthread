// The barrel is COMPLETE — nothing `./validate.js` exports is missing from `.`.
//
// ⚠ THIS EXISTS BECAUSE THE BARREL LISTS ITS RE-EXPORTS BY HAND, AND HAD TO. A second
// `export *` cannot be used here: `./validate.js` re-exports the byte-budget constants
// from `./payload.js` so that one ceiling is stated once in two units, and two star
// exports of the same name make every one of those names AMBIGUOUS — the ES semantics
// are to drop it from the surface, silently, with no error anywhere.
//
// The cost of listing them is that a new export can be added to `validate.ts`, compile,
// pass every test, and ship absent from the package's main entry — a consumer would see
// "has no exported member" against a symbol that exists in the source they can read.
// Nothing but this test closes that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as index from './index.js';
import * as validate from './validate.js';
import * as payload from './payload.js';
import * as narrow from './narrow.js';
import * as errors from './errors.js';

test('every RUNTIME export of validate, payload, narrow and errors is reachable from the barrel', () => {
  const surface = new Set(Object.keys(index));
  // NEGATIVE CONTROL: a barrel that exported nothing would satisfy an empty loop.
  assert.ok(surface.size > 40, `the barrel should be substantial, saw ${surface.size}`);

  const missing: string[] = [];
  for (const [label, mod] of [
    ['validate', validate],
    ['payload', payload],
    ['narrow', narrow],
    ['errors', errors],
  ] as const) {
    for (const name of Object.keys(mod)) {
      if (!surface.has(name)) missing.push(`${label}.${name}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    'these are exported by a module the barrel claims to re-export, and are absent from it',
  );
});

test('every TYPE exported by validate is named in the barrel source', () => {
  // Types are erased, so the runtime check above cannot see them — and a missing type
  // export is exactly as breaking for a consumer as a missing value.
  const src = readFileSync(new URL('./validate.ts', import.meta.url), 'utf8');
  const barrel = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const declared = [...src.matchAll(/^export (?:interface|type) ([A-Za-z0-9_]+)/gm)].map(
    (m) => m[1],
  );
  // NEGATIVE CONTROL: if the parse stops matching, this test must not go quietly green.
  assert.ok(declared.length >= 3, `expected validate.ts to export types, parsed ${declared.length}`);
  const missing = declared.filter((name) => !new RegExp(`\\b${name}\\b`).test(barrel));
  assert.deepEqual(missing, [], 'types exported by validate.ts that the barrel never names');
});
