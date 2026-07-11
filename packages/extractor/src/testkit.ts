// Test harness shim: lets the vitest-authored test suite run under Node's
// built-in test runner (`node --test`) with Jest's `expect` matchers, so the
// package pulls NO vite/esbuild dev-server dependency tree (which the repo's
// full-tree `npm audit` gate rejects). Test bodies are unchanged — they import
// `describe/it/expect/vi/...` from here instead of from `vitest`.

import {
  describe,
  it,
  test,
  before,
  after,
  beforeEach,
  afterEach,
} from 'node:test';
import { expect as jestExpect } from 'expect';
import { ModuleMocker } from 'jest-mock';

// vitest's lifecycle names → node:test's.
const beforeAll = before;
const afterAll = after;

// vitest's `expect` accepts a per-assertion message as an optional 2nd arg
// (`expect(actual, label)`) and a generic on `actual`/matchers
// (`expect(x).toEqual<T>(...)`); jest's `expect` accepts neither. Wrap it so the
// test bodies stay unchanged: drop the (display-only) message at runtime, and
// widen the type so the generic matcher calls type-check. Runtime assertions use
// the real jest matchers. The asymmetric-matcher statics keep their real types.
interface TestExpect {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  <T = unknown>(actual: T, message?: unknown): any;
  objectContaining: typeof jestExpect.objectContaining;
  arrayContaining: typeof jestExpect.arrayContaining;
  stringContaining: typeof jestExpect.stringContaining;
  stringMatching: typeof jestExpect.stringMatching;
}
const expect = Object.assign(
  (actual: unknown, _message?: unknown) => jestExpect(actual),
  jestExpect,
) as unknown as TestExpect;

// Minimal `vi` — only `spyOn`/`fn` are used, and only to silence/inspect
// console during tests. jest-mock's mocks are fully compatible with the `expect`
// matchers above (toHaveBeenCalledWith, .mock.calls, mockImplementation,
// mockRestore).
const mocker = new ModuleMocker(globalThis);
const vi = {
  spyOn: (obj: object, method: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mocker.spyOn as any)(obj, method),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (impl?: (...args: any[]) => any) => mocker.fn(impl),
};

export { describe, it, test, beforeAll, afterAll, beforeEach, afterEach, expect, vi };
