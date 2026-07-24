// Go structural extractor — the import-graph backbone, DIR-GRANULAR.
//
// A Go PACKAGE is exactly one directory of `.go` files (all files in a dir share one
// package; `_test.go` files are excluded upstream). Files in the same package reference
// each other WITHOUT imports, so a per-file node model would leave every package internally
// disconnected. The natural unit is therefore the PACKAGE = the DIRECTORY: one graph node
// per package dir (node id = repo-relative dir path; the module-root package is `.`), loc =
// the sum of its files' loc, and edges are dir→dir.
//
// INSTALL-FREE + PURE-STATIC, like the other hand-rolled adapters. Go's import graph is the
// simplest of any shipped language to recover: an import is a STRING PATH, and a first-party
// path maps DIRECTLY to a directory — `import "<module>/internal/db"` is the dir
// `internal/db` (offset by the go.mod's own dir). No symbol registry is needed.
//
//   1. GROUP — enumerate `.go` files, bucket them by directory → the package nodes.
//   2. RESOLVE — for each file's imports (go-scan): a path under the module prefix →
//      the internal edge (from this file's dir) to the target package dir, if that dir is a
//      package we enumerated; a Go stdlib path (no dot in the first element) → DROPPED
//      (substrate); anything else → an `ext:<module>` external, bucketed by the longest
//      declared-require prefix (go.mod). A first-party import to a dir we didn't enumerate
//      (e.g. a package of only `_test.go`, or a filtered dir) is DROPPED, never mislabeled
//      external.
//
// KNOWN degrades (documented, accepted): no call edges (the locked v1 scope). A go.work
// multi-module repo resolves first-party imports only for its primary (root-preferred)
// module; other modules' internal imports don't resolve (go-manifest v1 scope). A legacy
// GOPATH repo with no go.mod has no module prefix, so no import is first-party — but
// detection requires a go.mod, so this can't occur in practice.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GraphExtractor, NormalizedGraph } from './types.js';
import { graphFromState, type FileRecord } from './file-graph.js';
import { listSourceFiles } from './language.js';
import { readGoModuleInfo, readGoDeps } from './go-manifest.js';
import { scanImports, isGoStdlib, goExternalId } from './go-scan.js';

/** Lines of code for one source file (a size/centrality signal). */
function locOf(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

/** The package directory of a repo-relative file id — the graph node id. Root pkg = '.'. */
export function dirIdOf(fileId: string): string {
  const i = fileId.lastIndexOf('/');
  return i >= 0 ? fileId.slice(0, i) : '.';
}

/**
 * Map a Go import PATH to the repo-relative package DIRECTORY it refers to, or null if the
 * path is not first-party (not under the module prefix). Accounts for the go.mod's own dir
 * offset (`moduleDir`), so a module rooted at `backend/` maps `<module>/db` to `backend/db`.
 * The module-root import (`import "<module>"`) maps to the package `.`/`moduleDir`.
 */
export function importToDir(importPath: string, modulePath: string, moduleDir: string): string | null {
  let sub: string;
  if (importPath === modulePath) sub = '';
  else if (modulePath !== '' && importPath.startsWith(modulePath + '/')) sub = importPath.slice(modulePath.length + 1);
  else return null;
  const dir = moduleDir ? (sub ? `${moduleDir}/${sub}` : moduleDir) : sub;
  return dir === '' ? '.' : dir;
}

export class GoExtractor implements GraphExtractor {
  readonly language = 'go';

  async extract(repoDir: string): Promise<NormalizedGraph> {
    const root = resolve(repoDir);
    const fileIds = listSourceFiles(root, 'go'); // `.go`, excluding `_test.go`
    const files: Record<string, FileRecord> = {};
    if (fileIds.length === 0) return graphFromState(root, { headSha: '', files });

    const { modulePath, moduleDir } = readGoModuleInfo(root);
    const declaredModules = readGoDeps(root);

    // Group files by package directory → the nodes + the valid internal-target set.
    const dirFiles = new Map<string, string[]>();
    for (const id of fileIds) {
      const d = dirIdOf(id);
      (dirFiles.get(d) ?? dirFiles.set(d, []).get(d)!).push(id);
    }
    const packageDirs = new Set(dirFiles.keys());

    for (const [dir, ids] of dirFiles) {
      let loc = 0;
      const importWeights = new Map<string, number>(); // targetDir → weight
      const externalWeights = new Map<string, { specifier: string; weight: number }>();
      const addExternal = (path: string): void => {
        const ext = goExternalId(path, declaredModules);
        const existing = externalWeights.get(ext.id);
        if (existing) existing.weight += 1;
        else externalWeights.set(ext.id, { specifier: ext.specifier, weight: 1 });
      };

      for (const fid of ids) {
        let text = '';
        try {
          text = readFileSync(`${root}/${fid}`, 'utf8');
        } catch {
          text = '';
        }
        loc += locOf(text);
        for (const path of scanImports(text)) {
          const targetDir = importToDir(path, modulePath, moduleDir);
          if (targetDir !== null) {
            // first-party: edge only to an enumerated package dir (else drop, never leak)
            if (targetDir !== dir && packageDirs.has(targetDir)) {
              importWeights.set(targetDir, (importWeights.get(targetDir) ?? 0) + 1);
            }
            continue;
          }
          if (isGoStdlib(path)) continue; // substrate
          addExternal(path);
        }
      }

      files[dir] = {
        loc,
        language: 'go',
        imports: [...importWeights].map(([to, weight]) => ({ to, weight })),
        externals: [...externalWeights].map(([id, v]) => ({ id, specifier: v.specifier, weight: v.weight })),
        calls: [], // v1: import-backbone only (no call edges — the locked scope)
        reexports: [],
      };
    }

    return graphFromState(root, { headSha: '', files });
  }
}
