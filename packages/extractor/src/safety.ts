// Source-tree safety budget (/370) — runs inside the ephemeral container
// before extraction. The extractor only READS source (ts-morph, install-free —
// it never eval/requires repo content), so the threat model is DoS/resource
// abuse (zip-bombs, giant files, symlink escapes), not RCE. This caps that.
//
// CPU/mem/disk caps come from the container instance type; wall-time from the
// exec timeout. This guard covers the content budgets the instance limits don't.

import { readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export interface SafetyBudget {
  maxFileBytes: number; // reject any single file larger than this
  maxTotalBytes: number; // reject if the scanned tree exceeds this
  maxFiles: number; // reject if there are more files than this
}

export const DEFAULT_BUDGET: SafetyBudget = {
  maxFileBytes: 8 * 1024 * 1024, // 8 MB — a source file over this is pathological
  maxTotalBytes: 512 * 1024 * 1024, // 512 MB total scanned
  maxFiles: 50_000,
};

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);

/**
 * Walk the clone, enforcing the budget. Throws on the first violation. Symlinks
 * are never followed and any symlink resolving OUTSIDE the clone root is
 * rejected (path-traversal guard).
 */
export function enforceSourceBudget(root: string, budget: SafetyBudget = DEFAULT_BUDGET): void {
  const rootReal = realpathSync(root);
  let totalBytes = 0;
  let fileCount = 0;

  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p); // lstat: do NOT follow symlinks
      if (st.isSymbolicLink()) {
        // Reject any symlink that escapes the clone root.
        let target: string;
        try {
          target = realpathSync(p);
        } catch {
          continue; // dangling symlink — ignore
        }
        // Prefix match with the explicit separator — `target.startsWith(rootReal)`
        // alone would let `/tmp/clone-12345-evil` pass as if inside `/tmp/clone-12345`.
        if (target !== rootReal && !target.startsWith(rootReal + sep)) {
          throw new Error(`safety: symlink escapes clone root: ${p}`);
        }
        continue; // don't traverse into symlinks
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(p);
      } else if (st.isFile()) {
        if (st.size > budget.maxFileBytes) {
          throw new Error(`safety: file exceeds ${budget.maxFileBytes} bytes: ${p}`);
        }
        totalBytes += st.size;
        fileCount += 1;
        if (totalBytes > budget.maxTotalBytes) {
          throw new Error(`safety: tree exceeds ${budget.maxTotalBytes} bytes (zip-bomb guard)`);
        }
        if (fileCount > budget.maxFiles) {
          throw new Error(`safety: more than ${budget.maxFiles} files`);
        }
      }
    }
  };

  walk(resolve(root));
}
