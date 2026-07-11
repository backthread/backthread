// the Pyright-driven Python structural extractor.
//
// Asserts the load-bearing contract: FIRST-PARTY imports (absolute, relative,
// submodule, src-layout, namespace-package) become internal edges; THIRD-PARTY
// imports become external nodes; STDLIB imports are dropped (never external, the
// Node-builtin analogue); and none of it executes repo code (NoAccessHost — a
// property, not an assertion, but the "no absolute/system path leaks in" checks
// below would trip if it did). Each case writes a throwaway repo to a temp dir
// and runs the real adapter end-to-end.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PythonExtractor, syntacticResolve, inferSourceRoots } from './python-adapter.js';
import type { NormalizedGraph } from './types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function extractPy(files: Record<string, string>): Promise<NormalizedGraph> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-py967-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content.startsWith('\n') ? content.slice(1) : content);
  }
  return new PythonExtractor().extract(dir);
}

const internalEdge = (g: NormalizedGraph, from: string, to: string): boolean =>
  g.edges.some((e) => !e.external && e.kind === 'import' && e.from === from && e.to === to);
const externalIds = (g: NormalizedGraph): string[] => [...new Set(g.externals.map((n) => n.id))].sort();
const fileIds = (g: NormalizedGraph): string[] => g.files.map((f) => f.id).sort();
const callEdge = (g: NormalizedGraph, from: string, to: string): boolean =>
  g.edges.some((e) => !e.external && e.kind === 'call' && e.from === from && e.to === to);

describe('PythonExtractor — typed call edges', () => {
  it('resolves a cross-module FUNCTION call to a call edge', async () => {
    const g = await extractPy({
      'svc.py': 'def helper(x):\n    return x + 1\n',
      'app.py': 'from svc import helper\n\ndef use():\n    return helper(3)\n',
    });
    expect(callEdge(g, 'app.py', 'svc.py')).toBe(true);
  });

  it('resolves a METHOD call through an inferred receiver type (the typed half)', async () => {
    const g = await extractPy({
      'repo.py': 'class Repo:\n    def find(self, id):\n        return id\n',
      'app.py': 'from repo import Repo\n\ndef use():\n    r = Repo()\n    return r.find(1)\n',
    });
    // r.find resolves through r: Repo → repo.py, even with the checker disabled.
    expect(callEdge(g, 'app.py', 'repo.py')).toBe(true);
  });

  it('does NOT emit a self-call edge (same-file call)', async () => {
    const g = await extractPy({
      'mod.py': 'def a():\n    return 1\n\ndef b():\n    return a()\n',
    });
    expect(callEdge(g, 'mod.py', 'mod.py')).toBe(false);
    expect(g.edges.some((e) => e.kind === 'call')).toBe(false);
  });

  it('does NOT emit call edges to stdlib / third-party callees', async () => {
    const g = await extractPy({
      'app.py': 'import os\n\ndef use():\n    return os.getcwd()\n',
    });
    expect(g.edges.filter((e) => e.kind === 'call' && !e.external)).toEqual([]);
  });

  it('degrades a god-file (> the call-site cap) to import-only, deterministically', async () => {
    // 2501 calls > MAX_CALL_SITES_PER_FILE (2500) → call edges skipped for this
    // file; the IMPORT edge to svc.py still stands.
    const body = Array.from({ length: 2501 }, () => '    helper(1)').join('\n');
    const g = await extractPy({
      'svc.py': 'def helper(x):\n    return x\n',
      'app.py': `from svc import helper\n\ndef use():\n${body}\n`,
    });
    expect(internalEdge(g, 'app.py', 'svc.py')).toBe(true); // import edge survives
    expect(callEdge(g, 'app.py', 'svc.py')).toBe(false); // call edges capped away
  });

  it('is deterministic (identical call edges across two extracts)', async () => {
    const files = {
      'svc.py': 'def helper(x):\n    return x\n',
      'app.py': 'from svc import helper\n\ndef use():\n    return helper(helper(1))\n',
    };
    const a = await extractPy(files);
    const b = await extractPy(files);
    const calls = (g: NormalizedGraph) => g.edges.filter((e) => e.kind === 'call').map((e) => `${e.from}→${e.to}:${e.weight}`).sort();
    expect(calls(a)).toEqual(calls(b));
    // helper called twice → weight 2 on the single app.py→svc.py call edge.
    expect(calls(a)).toEqual(['app.py→svc.py:2']);
  });
});

describe('inferSourceRoots (nested package roots)', () => {
  it('always includes the defaults', () => {
    expect(inferSourceRoots(new Set())).toEqual(['', 'src']);
  });

  it('infers a nested backend root (backend/app package → backend is a source root)', () => {
    const roots = inferSourceRoots(
      new Set(['backend/app/__init__.py', 'backend/app/main.py', 'backend/app/api/__init__.py']),
    );
    expect(roots).toContain('backend');
    // the sub-package api/ does NOT add a root (its parent app/ is a package)
    expect(roots).not.toContain('backend/app');
  });

  it('a root-layout package adds no new root (already the default "")', () => {
    expect(inferSourceRoots(new Set(['app/__init__.py', 'app/main.py']))).toEqual(['', 'src']);
  });

  it('so a nested import resolves via the inferred root', () => {
    const ids = new Set(['backend/app/__init__.py', 'backend/app/api/main.py']);
    const roots = inferSourceRoots(ids);
    expect(syntacticResolve('app.api.main', 'backend/app/main.py', ids, roots)).toBe('backend/app/api/main.py');
    // Without the inferred root, the default roots can't resolve it.
    expect(syntacticResolve('app.api.main', 'backend/app/main.py', ids)).toBeUndefined();
  });

  it('prefers the proximate root when two top-level packages share a name', () => {
    // A `backend/app` package AND a repo-root `app` package both define `x`.
    const ids = new Set(['app/x.py', 'backend/app/__init__.py', 'backend/app/x.py', 'backend/app/main.py']);
    const roots = inferSourceRoots(ids); // ['', 'backend', 'src']
    // A backend file's `from app.x` resolves to ITS OWN app (proximity), not root app/.
    expect(syntacticResolve('app.x', 'backend/app/main.py', ids, roots)).toBe('backend/app/x.py');
    // A root file's `from app.x` still resolves to the root app/.
    expect(syntacticResolve('app.x', 'main.py', ids, roots)).toBe('app/x.py');
  });
});

describe('PythonExtractor — first-party import resolution', () => {
  it('resolves absolute + relative imports and separates third-party from stdlib', async () => {
    const g = await extractPy({
      'app/__init__.py': '',
      'app/main.py': `
import os
import fastapi
from app.services.auth import login
from .util import helper
from typing import List
`,
      'app/util.py': `def helper(): return 1\n`,
      'app/services/__init__.py': '',
      'app/services/auth.py': `
from ..util import helper
import sqlalchemy
def login(): return helper()
`,
    });

    // absolute dotted import → internal
    expect(internalEdge(g, 'app/main.py', 'app/services/auth.py')).toBe(true);
    // relative single-dot → internal
    expect(internalEdge(g, 'app/main.py', 'app/util.py')).toBe(true);
    // relative double-dot (from services/auth.py) → internal
    expect(internalEdge(g, 'app/services/auth.py', 'app/util.py')).toBe(true);
    // third-party → external nodes; stdlib (os, typing) → dropped, NOT external
    expect(externalIds(g)).toEqual(['ext:fastapi', 'ext:sqlalchemy']);
  });

  it('draws submodule edges through empty __init__ (from pkg import submodule)', async () => {
    const g = await extractPy({
      'app/__init__.py': '',
      'app/services/__init__.py': '',
      'app/services/auth.py': `def login(): pass\n`,
      'app/sibling.py': `x = 1\n`,
      'app/main.py': `
from app.services import auth
from . import sibling
`,
    });
    // the submodule is the real dependency — empty __init__ can't re-export it
    expect(internalEdge(g, 'app/main.py', 'app/services/auth.py')).toBe(true);
    expect(internalEdge(g, 'app/main.py', 'app/sibling.py')).toBe(true);
  });

  it('resolves a src/ layout with no config (Pyright src fallback)', async () => {
    const g = await extractPy({
      'src/mypkg/__init__.py': '',
      'src/mypkg/a.py': `
from mypkg.sub.b import thing
from .c import other
`,
      'src/mypkg/c.py': `other = 2\n`,
      'src/mypkg/sub/__init__.py': '',
      'src/mypkg/sub/b.py': `thing = 1\n`,
    });
    expect(internalEdge(g, 'src/mypkg/a.py', 'src/mypkg/sub/b.py')).toBe(true);
    expect(internalEdge(g, 'src/mypkg/a.py', 'src/mypkg/c.py')).toBe(true);
    expect(externalIds(g)).toEqual([]); // nothing third-party
  });

  it('resolves PEP-420 namespace packages (no __init__.py)', async () => {
    const g = await extractPy({
      'ns/api.py': `
from ns.svc.core import run
from .helpers import h
`,
      'ns/svc/core.py': `run = 1\n`,
      'ns/helpers.py': `h = 1\n`,
    });
    expect(internalEdge(g, 'ns/api.py', 'ns/svc/core.py')).toBe(true);
    expect(internalEdge(g, 'ns/api.py', 'ns/helpers.py')).toBe(true);
  });

  it('collapses dotted third-party names to their top-level distribution node', async () => {
    const g = await extractPy({
      'app/__init__.py': '',
      'app/x.py': `
import sqlalchemy.orm
from google.cloud import storage
from fastapi import FastAPI
`,
    });
    // sqlalchemy.orm → ext:sqlalchemy ; google.cloud → ext:google ; fastapi → ext:fastapi
    expect(externalIds(g)).toEqual(['ext:fastapi', 'ext:google', 'ext:sqlalchemy']);
  });

  it('treats an unresolved RELATIVE import as first-party-missing, never external', async () => {
    const g = await extractPy({
      'pkg/__init__.py': '',
      'pkg/a.py': `from .nonexistent import gone\n`,
    });
    // a relative import to a missing sibling is a dangling first-party ref, not a
    // third-party package — it must NOT appear as an external node.
    expect(externalIds(g)).toEqual([]);
  });

  it('emits no self-edges and no call edges (import-only degrade)', async () => {
    const g = await extractPy({
      'pkg/__init__.py': '',
      'pkg/a.py': `
from pkg import a  # self-reference
from pkg.b import thing
`,
      'pkg/b.py': `thing = 1\n`,
    });
    expect(g.edges.some((e) => e.from === e.to)).toBe(false);
    expect(g.edges.every((e) => e.kind === 'import')).toBe(true); // no 'call' edges yet
  });

  it('parses .pyi stub files and tags file language', async () => {
    const g = await extractPy({
      'pkg/__init__.py': '',
      'pkg/core.pyi': `from pkg.util import Helper\n`,
      'pkg/util.py': `class Helper: ...\n`,
    });
    expect(fileIds(g)).toContain('pkg/core.pyi');
    expect(g.files.find((f) => f.id === 'pkg/core.pyi')?.language).toBe('pyi');
    expect(internalEdge(g, 'pkg/core.pyi', 'pkg/util.py')).toBe(true);
  });

  it('is deterministic across repeated extraction', async () => {
    const files = {
      'app/__init__.py': '',
      'app/a.py': `from app.b import x\nimport requests\n`,
      'app/b.py': `x = 1\n`,
    };
    const g1 = await extractPy(files);
    const g2 = await extractPy(files);
    const norm = (g: NormalizedGraph) =>
      JSON.stringify({
        files: fileIds(g),
        edges: g.edges.map((e) => `${e.from}|${e.to}|${e.kind}|${e.external}`).sort(),
        externals: externalIds(g),
      });
    expect(norm(g1)).toBe(norm(g2));
  });

  it('returns an empty graph for a repo with no Python files', async () => {
    const g = await extractPy({ 'README.md': '# hi\n', 'main.ts': `export const x = 1;\n` });
    expect(g.files).toEqual([]);
    expect(g.edges).toEqual([]);
  });
});

describe('syntacticResolve — path-anchored fallback', () => {
  const ids = new Set([
    'app/a.py',
    'app/b.py',
    'app/sub/c.py',
    'app/sub/__init__.py',
    'src/pkg/d.py',
  ]);

  it('resolves an absolute import at the repo root', () => {
    expect(syntacticResolve('app.b', 'app/a.py', ids)).toBe('app/b.py');
  });

  it('resolves an absolute import under a src/ root', () => {
    expect(syntacticResolve('pkg.d', 'anything.py', ids)).toBe('src/pkg/d.py');
  });

  it('resolves a package import to its __init__', () => {
    expect(syntacticResolve('app.sub', 'app/a.py', ids)).toBe('app/sub/__init__.py');
  });

  it('resolves a relative import against the importing package', () => {
    expect(syntacticResolve('.c', 'app/sub/x.py', ids)).toBe('app/sub/c.py');
    expect(syntacticResolve('..b', 'app/sub/x.py', ids)).toBe('app/b.py');
  });

  it('returns undefined for an unknown module or a bare relative', () => {
    expect(syntacticResolve('app.missing', 'app/a.py', ids)).toBeUndefined();
    expect(syntacticResolve('.', 'app/a.py', ids)).toBeUndefined();
    expect(syntacticResolve('...x', 'app/a.py', ids)).toBeUndefined(); // ascends past root
  });
});
