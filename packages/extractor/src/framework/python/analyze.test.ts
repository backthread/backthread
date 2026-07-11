// Shared Python framework-adapter core — tests for the reusable helpers the
// Django/Flask/ORM/… fleet depends on (+).

import { describe, it, expect, afterEach } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePythonScope, buildImportBindings, inScope, isPythonFile } from './analyze.js';
import { PythonExtractor } from '../../graph/python-adapter.js';
import type { FrameworkContext } from '../types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content);
}

describe('shared python analyze helpers', () => {
  it('isPythonFile / inScope', () => {
    expect(isPythonFile('py')).toBe(true);
    expect(isPythonFile('pyi')).toBe(true);
    expect(isPythonFile('ts')).toBe(false);
    expect(inScope('a/b.py', '')).toBe(true);
    expect(inScope('backend/app/x.py', 'backend')).toBe(true);
    expect(inScope('frontend/x.py', 'backend')).toBe(false);
  });

  it('parsePythonScope parses in-scope files + resolves cross-module bindings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bt-pyscope-'));
    dirs.push(dir);
    write(dir, 'pkg/__init__.py', '');
    write(dir, 'pkg/svc.py', 'def helper(x):\n    return x\n');
    write(dir, 'pkg/app.py', 'from pkg.svc import helper\n\ndef use():\n    return helper(1)\n');

    const graph = await new PythonExtractor().extract(dir);
    const ctx: FrameworkContext = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'test', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };

    const scope = parsePythonScope(ctx);
    expect(scope.pyFiles).toEqual(expect.arrayContaining(['pkg/app.py', 'pkg/svc.py']));
    // app.py parsed, and its `helper` binding resolves to svc.py (submodule/symbol).
    const app = scope.parsed.get('pkg/app.py');
    expect(app).toBeDefined();
    expect(app!.bindings.get('helper')).toBe('pkg/svc.py');
    // determinism: a second scope over the same ctx.graph is identical.
    const scope2 = parsePythonScope(ctx);
    expect([...scope2.parsed.get('pkg/app.py')!.bindings.entries()]).toEqual(
      [...app!.bindings.entries()],
    );
  });

  it('buildImportBindings resolves import / from-import forms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bt-pybind-'));
    dirs.push(dir);
    write(dir, 'a/__init__.py', '');
    write(dir, 'a/b.py', 'X = 1\n');
    write(dir, 'a/main.py', 'import a.b as bmod\nfrom a import b\nfrom a.b import X\n');
    const graph = await new PythonExtractor().extract(dir);
    const scope = parsePythonScope({
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'test', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    });
    const binds = scope.parsed.get('a/main.py')!.bindings;
    expect(binds.get('bmod')).toBe('a/b.py'); // import a.b as bmod
    expect(binds.get('b')).toBe('a/b.py'); // from a import b (submodule)
    expect(binds.get('X')).toBe('a/b.py'); // from a.b import X (symbol → its module)
    // buildImportBindings is also callable directly (the piece adapters reuse).
    const direct = buildImportBindings(
      'a/main.py',
      scope.parsed.get('a/main.py')!.nodes.imports,
      scope.internalIds,
      scope.roots,
    );
    expect(direct.get('X')).toBe('a/b.py');
  });
});
