// the OpenTofu InfraAdapter.
//
// OpenTofu is a Terraform fork with identical HCL syntax and the same provider
// model (registry.terraform.io namespace is shared; `tofu` CLI is a drop-in
// replacement). This adapter REUSES buildTerraformGraph and parseHcl entirely —
// no new taxonomy, no new classify provider strings. The LLM cache entries
// created by the Terraform adapter are reused verbatim here (the
// `resource_type_classifications` row for `provider = 'terraform/aws'` applies
// to both `*.tf` and `*.tofu` files).
//
// DETECT GUARD — the critical contract:
// detect() returns TRUE only when an OpenTofu-SPECIFIC signal exists: a `*.tofu`
// file, a `*.tofu.json` file, or a `tofu.tfvars` file. A repo with ONLY `*.tf`
// files falls through to the Terraform adapter — this adapter NEVER fires on
// plain Terraform repos, preventing double-counting of nodes.
//
// FILE SCOPE — extract() collects BOTH `*.tofu` AND `*.tf` files, because an
// OpenTofu repo may mix both extensions (providers declared in `providers.tf`,
// resources in `main.tofu` is a common migration pattern). The Terraform adapter
// is NOT run additionally on OpenTofu repos — the registry registers the more
// specific adapter first, and a repo matched by OpenTofu is NOT re-matched by
// Terraform.
//
// DEFERRED: `*.tofu.json` parsing. parseHcl is an HCL text parser; JSON-HCL is
// a structurally different encoding (same semantics, different surface syntax).
// detect() recognises `*.tofu.json` as an OpenTofu signal so the repo is
// claimed by this adapter, but the JSON bodies are skipped in extract() with a
// console.warn. JSON-HCL support is tracked under .

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { InfraAdapter, InfraGraph } from '../types.js';
import { walkRepo } from '../walk.js';
import { buildDockerfileIndex } from '../image-resolve.js';
import { parseHcl } from '../terraform/hcl-parse.js';
import { buildTerraformGraph } from '../terraform/terraform.js';

/** Repo-relative dir of a file path ('' = repo root). */
function dirOfRel(repoDir: string, file: string): string {
  const rel = (relative(repoDir, file) || file).split('\\').join('/');
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

// Same skip-set as the Terraform adapter (OpenTofu shares its `.terraform` noise dir).
const TOFU_SKIP_DIRS = ['node_modules', '.git', 'dist', '.wrangler', '.terraform', '.next', 'build'];

interface TofuFileScan {
  /** `*.tf` and `*.tofu` files (parseable HCL). */
  hclFiles: string[];
  /** `*.tofu.json` files (OpenTofu-specific signal; parsing deferred). */
  tofuJsonFiles: string[];
  /** `tofu.tfvars` files (OpenTofu-specific signal). */
  tofuTfvarsFiles: string[];
}

/**
 * Walk the repo collecting OpenTofu-relevant files (bounded, skips noise dirs).
 * Returns both the files to parse (hclFiles) and the OpenTofu-specific signals
 * (tofuJsonFiles, tofuTfvarsFiles) separately so detect() can check the latter
 * without needing any HCL content.
 */
function scanTofuFiles(repoDir: string): TofuFileScan {
  const hclFiles: string[] = [];
  const tofuJsonFiles: string[] = [];
  const tofuTfvarsFiles: string[] = [];

  walkRepo(repoDir, {
    skipDirs: TOFU_SKIP_DIRS,
    onFile: (abs, e) => {
      // ORDER IS LOAD-BEARING — compound suffixes (.tofu.json, .tofu.tfvars) must
      // be checked BEFORE the bare-suffix arms (.tofu, .tf).  A name like
      // "override.tofu.json" ends with both ".tofu.json" AND ".tofu"; testing
      // the bare arm first would mis-classify it as HCL.  Do NOT reorder.
      if (e.name.endsWith('.tofu.json')) {
        // JSON-HCL: OpenTofu-specific signal; parsing deferred (see module comment).
        tofuJsonFiles.push(abs);
      } else if (e.name === 'tofu.tfvars' || e.name.endsWith('.tofu.tfvars')) {
        // tofu.tfvars / *.tofu.tfvars: OpenTofu-native variables file.
        tofuTfvarsFiles.push(abs);
      } else if (e.name.endsWith('.tofu')) {
        // `.tofu` = OpenTofu-native HCL file; also counts as HCL for parsing.
        // Checked AFTER the compound-suffix arms above (see ORDER note).
        hclFiles.push(abs);
      } else if (e.name.endsWith('.tf')) {
        // Plain Terraform HCL: collect for parsing when the repo has other
        // OpenTofu signals (so we get the full topology, not just *.tofu files).
        hclFiles.push(abs);
      }
    },
  });

  hclFiles.sort();
  return { hclFiles, tofuJsonFiles, tofuTfvarsFiles };
}

/** True iff the repo has at least one OpenTofu-SPECIFIC file. */
function hasOpentofuSignal(scan: TofuFileScan): boolean {
  const tofuHcl = scan.hclFiles.some((f) => f.endsWith('.tofu'));
  return tofuHcl || scan.tofuJsonFiles.length > 0 || scan.tofuTfvarsFiles.length > 0;
}

export const opentofuAdapter: InfraAdapter = {
  name: 'opentofu',

  /**
   * Detect an OpenTofu repo by the presence of at least one OpenTofu-specific
   * file: `*.tofu`, `*.tofu.json`, or `tofu.tfvars` / `*.tofu.tfvars`.
   *
   * A repo with ONLY `*.tf` files is NOT detected here — that is the Terraform
   * adapter's jurisdiction. This is the primary regression guard: registering
   * both adapters and having only `*.tf` files will fire Terraform, never
   * OpenTofu.
   */
  async detect(repoDir: string): Promise<boolean> {
    const scan = scanTofuFiles(repoDir);
    return hasOpentofuSignal(scan);
  },

  /**
   * Extract the infrastructure graph from an OpenTofu repo.
   *
   * Parses all `*.tofu` + `*.tf` files (which may coexist in the same OpenTofu
   * project) via parseHcl, then delegates to buildTerraformGraph for the
   * identical resource-type taxonomy, heuristic kind assignment, and cross-
   * resource edge detection. Returns the graph with `adapter: 'opentofu'` so
   * the registry prefixes nodes as `opentofu:*` (distinct from `terraform:*`).
   *
   * `*.tofu.json` files are noted but skipped — JSON-HCL parsing is deferred.
   */
  async extract(repoDir: string): Promise<InfraGraph> {
    const scan = scanTofuFiles(repoDir);

    // Warn about deferred JSON-HCL files so operators know topology may be
    // incomplete (not an error — the HCL files still yield a useful graph).
    // JSON-HCL is a structurally different encoding that needs its own parser;
    // support is tracked under .
    if (scan.tofuJsonFiles.length > 0) {
      const names = scan.tofuJsonFiles.map((f) => relative(repoDir, f)).join(', ');
      console.warn(
        `  [opentofu] skipping ${scan.tofuJsonFiles.length} .tofu.json file(s) — ` +
          `JSON-HCL parsing is not yet supported (tracked: ). ` +
          `Skipped: ${names}`,
      );
    }

    const blocks: ReturnType<typeof parseHcl> = [];
    for (const file of scan.hclFiles) {
      const dir = dirOfRel(repoDir, file);
      try {
        for (const b of parseHcl(readFileSync(file, 'utf8'))) {
          b.dir = dir; // module dir for source-path resolution
          blocks.push(b);
        }
      } catch (err) {
        console.warn(`  [opentofu] skipping unparseable ${relative(repoDir, file)}: ${(err as Error).message}`);
      }
    }

    // buildTerraformGraph is pure: it takes blocks + root and returns an
    // InfraGraph. We override `adapter` so downstream namespacing is correct.
    //
    // MIXED-REPO NAMESPACING (intended behaviour): a repo that contains both
    // `*.tf` and `*.tofu` files will be claimed by this adapter (detect-positive)
    // AND also by the Terraform adapter if both are registered and run
    // independently.  In that scenario, shared `*.tf` resources appear under
    // BOTH `opentofu:resource:*` and `terraform:resource:*` ids — they are NOT
    // deduplicated at the adapter level.  This is intentional: namespacing by
    // adapter is the design (pure-TF repos get `terraform:*` ids; this adapter
    // owns the full graph for OpenTofu repos including any co-located `.tf`
    // files).  Mixed repos are rare in practice; deduplication is the
    // orchestrator's concern if it ever runs both adapters on the same repo.
    // same Dockerfile-index resolver path as Terraform.
    const graph = buildTerraformGraph(blocks, repoDir, buildDockerfileIndex(repoDir));
    return { ...graph, adapter: 'opentofu' };
  },
};
