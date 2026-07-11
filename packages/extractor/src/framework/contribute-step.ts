// (Slice A) — the GENERIC framework contribution-consumption step.
//
// The post-cluster sibling of scripts/ingest/infra/infra-step.ts. Where the
// detect-step ( Slice 1) only LOGS the detected-stack manifest, THIS step
// is what finally consumes it: for every detected adapter it runs the
// `syntheticEdges` + `roleTags` hooks and folds their contributions into the
// render graph. It is FRAMEWORK-AGNOSTIC — the RN adapter is the first client,
// and Next/Nest/Node/ORM reuse it unchanged.
//
// Founder decision (2026-06-26): render-only, POST-CLUSTER ("connect now, group
// later") — this runs AFTER clusterGraph + enrich, BEFORE assemble.
//
// What it does:
//   * resolves each contribution's FILE-id endpoints → MODULE ids via the
//     cluster's fileModuleMap (a screen file lands in its module);
//   * DROPS self-edges (intra-module navigation collapses) + dedupes on
//     (source, target, kind); validates every edge is one of the 8 verbs
//     (parseEdgeKind — the same fail-loud boundary assemble + persist trust);
//   * collapses role tags to ONE per module (highest RoleTag.priority, lexical
//     tiebreak) — pure metadata; the module's `kind` is UNCHANGED (roles never
//     widen the Module-kind enum);
//   * consumes each adapter's `groupingPrior` (FrameworkGroup[]) and
//     OVERRIDES the subsystem of every claimed module (see SUBSYSTEM OVERRIDE
//     below). This is the only place that mutates `cluster`;
//   * LOGS counts + everything unresolved/dropped — no silent caps.
//
// ── SUBSYSTEM OVERRIDE — the shared framework-grouping mechanism ──
// A framework's `groupingPrior` declares the AUTHORITATIVE grouping (a NestJS
// `@Module`, a Next route group): a named set of FILE ids that belong in ONE
// subsystem regardless of where they sit on disk. We resolve each group's files
// to MODULE ids and, for every claimed module, set its subsystem to the group.
//
// HOW (without touching assemble / cluster code): subsystems are computed inside
// assemble by computeSubsystems(cluster.modules), whose precedence is
//     external  >  workspace-package (packageId)  >  directory.
// `packageId` is the EXISTING "a declared boundary beats directory
// clustering" lever, read ONLY by computeSubsystems. A framework group is exactly
// that shape, so we ride it: we MUTATE the claimed ClusteredModule in place —
// packageId = `<adapter>:<group.id>` (namespaced, deterministic, never an index),
// packageName = the group label, packageRole = cleared (a framework group is a
// domain boundary, not an app/lib/tooling package). assemble then renders the
// override naturally. This runs BEFORE assemble, so the rendered grouping — and
// the semantic-zoom subsystem super-nodes that aggregate by `Module.subsystem`
// — reflect it with no change to the zoom machinery.
//
// PRECEDENCE we implement: framework group  >  workspace-package  >  directory.
// (We overwrite packageId, so the group beats both an inherited workspace package
// AND the directory heuristic.) `external` / infra-namespaced modules are NEVER
// claimed (they have no source files in a group anyway, and we skip them
// defensively), so the `external` subsystem still wins — the partition stays total.
//
// A module claimed by more than one group goes to the group that claims the MOST
// of its files (lexical group-id tiebreak); the collision is LOGGED, never a
// silent pick. When no adapter supplies a group, this is a complete no-op — the
// cluster is untouched and assemble is byte-identical (the headline invariant).
//
// Detection runs INTERNALLY here (not reusing the once-per-clone detect-step log)
// so the manifest matches THIS tree: the hosted merge walk re-runs the step at
// each checkpoint's checked-out tree, and a repo may have adopted RN partway
// through its history. Cheap (file-exists + one package.json read per adapter).
//
// Degrade, don't abort (mirrors extractInfra's call-site discipline): a malformed
// adapter must never sink an otherwise-good snapshot — a throw anywhere degrades
// to the empty contribution + a warning, and the snapshot assembles without it.

import { ModuleId, parseEdgeKind, type Edge } from '../types.js';
import type { ClusterResult } from '../cluster/louvain.js';
import type { NormalizedGraph } from '../graph/types.js';
import { crossLanguageApiEdges } from '../graph/cross-language.js';
import { registerBuiltinFrameworkAdapters } from './register.js';
import { detectFrameworks, listFrameworkAdapters } from './registry.js';
import type { FrameworkAdapter, FrameworkContext, FrameworkEdge, RoleTag } from './types.js';

export interface FrameworkContributions {
  /** Module-resolved, self-edge-free, deduped, 8-verb-validated edges. */
  edges: Edge[];
  /** moduleId → RoleTag (collapsed to the highest-priority role per module). */
  roles: Map<string, RoleTag>;
  /**
   * moduleId → the adapter-authoritative subsystem assigned to it (the
   * namespaced group id + its label). Informational/observability: the ACTUAL
   * effect is the in-place override of `cluster.modules[].packageId/packageName`
   * (see below), so assemble's computeSubsystems renders the framework grouping.
   */
  subsystems: Map<string, { id: string; label: string }>;
  counts: {
    adapters: number;
    rawEdges: number;
    edges: number;
    droppedSelf: number;
    droppedUnresolved: number;
    droppedBadKind: number;
    roles: number;
    groups: number;
    groupedModules: number;
    droppedGroupUnresolved: number;
  };
}

const EMPTY: FrameworkContributions = {
  edges: [],
  roles: new Map(),
  subsystems: new Map(),
  counts: {
    adapters: 0,
    rawEdges: 0,
    edges: 0,
    droppedSelf: 0,
    droppedUnresolved: 0,
    droppedBadKind: 0,
    roles: 0,
    groups: 0,
    groupedModules: 0,
    droppedGroupUnresolved: 0,
  },
};

export async function contributeFrameworkGraph(args: {
  repoDir: string;
  graph: NormalizedGraph;
  cluster: ClusterResult;
}): Promise<FrameworkContributions> {
  const { repoDir, graph, cluster } = args;
  try {
    registerBuiltinFrameworkAdapters();
    const manifest = await detectFrameworks(repoDir);

    // the cross-language full-stack seam (frontend→backend HTTP-API
    // edges) is computed from the graph + a direct FastAPI-surface parse, NOT from
    // the framework manifest, so it fires even when the FastAPI backend sits in a
    // nested package the root detect didn't claim. Empty for a single-language repo
    // (so single-language output stays byte-identical). File-id space; folded
    // through the SAME resolve/dedup as the adapters' syntheticEdges below.
    let xlangEdges: FrameworkEdge[] = [];
    try {
      xlangEdges = crossLanguageApiEdges({ repoDir, graph });
    } catch (err) {
      console.warn(
        `  ⚠ cross-language linking failed (${(err as Error).message}) — continuing without the full-stack seam`,
      );
    }

    if (manifest.matches.length === 0 && xlangEdges.length === 0) {
      // No framework detected AND no cross-language seam → generic behavior unchanged.
      return EMPTY;
    }

    const adaptersByName = new Map<string, FrameworkAdapter>(
      listFrameworkAdapters().map((a) => [a.name, a]),
    );
    const moduleIds = new Set(cluster.modules.map((m) => m.id));
    const fileModuleMap = cluster.fileModuleMap;
    // file id or module id → module id (or null when it resolves to nothing on
    // the canvas — a dropped file, or an endpoint outside the cluster).
    const resolve = (id: string): string | null => {
      if (moduleIds.has(id)) return id;
      const viaFile = fileModuleMap[id];
      if (viaFile && moduleIds.has(viaFile)) return viaFile;
      return null;
    };

    const edgesByKey = new Map<string, Edge>();
    // moduleId → the highest-priority role seen + the distinct roles that landed
    // on it (for the collapse log).
    const roleByModule = new Map<string, RoleTag>();
    const distinctRolesByModule = new Map<string, Set<string>>();
    let rawEdges = 0;
    let droppedSelf = 0;
    let droppedUnresolved = 0;
    let droppedBadKind = 0;
    const unresolvedEndpoints = new Set<string>();

    // grouping priors collected across adapters, namespaced by adapter
    // (`<adapter>:<group.id>`) so two adapters' groups never collide. Resolved +
    // applied as a subsystem override AFTER the loop (see below).
    const groupsByKey = new Map<string, { label: string; fileIds: string[] }>();
    let rawGroups = 0;
    let droppedGroupUnresolved = 0;

    for (const match of manifest.matches) {
      const adapter = adaptersByName.get(match.adapter);
      if (!adapter) continue;
      const ctx: FrameworkContext = {
        repoDir,
        rootPath: match.rootPath,
        match,
        graph,
        cluster: { fileModuleMap, moduleIds },
      };

      // --- syntheticEdges ---------------------------------------------------
      if (adapter.syntheticEdges) {
        let fwEdges = [] as Awaited<ReturnType<NonNullable<FrameworkAdapter['syntheticEdges']>>>;
        try {
          fwEdges = await adapter.syntheticEdges(ctx);
        } catch (err) {
          console.warn(
            `  ⚠ framework adapter '${match.adapter}' syntheticEdges failed (${(err as Error).message}) — skipping its edges`,
          );
          fwEdges = [];
        }
        for (const fe of fwEdges) {
          rawEdges++;
          const src = resolve(fe.source);
          const tgt = resolve(fe.target);
          if (!src || !tgt) {
            droppedUnresolved++;
            if (!src) unresolvedEndpoints.add(fe.source);
            if (!tgt) unresolvedEndpoints.add(fe.target);
            continue;
          }
          if (src === tgt) {
            // Intra-module contribution (e.g. navigation within one cluster)
            // collapses to a self-edge — dropped at the producer, exactly as
            // aggregateModuleEdges + the infra join do.
            droppedSelf++;
            continue;
          }
          let kind;
          try {
            kind = parseEdgeKind(fe.kind);
          } catch (err) {
            // A non-8-verb framework edge is a producer bug; drop + log it
            // rather than sink the snapshot (degrade-on-throw).
            droppedBadKind++;
            console.warn(`  ⚠ framework adapter '${match.adapter}' emitted ${(err as Error).message}`);
            continue;
          }
          const key = `${src}→${tgt}:${kind}`;
          if (!edgesByKey.has(key)) {
            edgesByKey.set(key, { source: ModuleId(src), target: ModuleId(tgt), kind });
          }
        }
      }

      // --- roleTags ---------------------------------------------------------
      if (adapter.roleTags) {
        let tags = new Map<string, RoleTag>();
        try {
          tags = await adapter.roleTags(ctx);
        } catch (err) {
          console.warn(
            `  ⚠ framework adapter '${match.adapter}' roleTags failed (${(err as Error).message}) — skipping its roles`,
          );
          tags = new Map();
        }
        for (const [endpoint, tag] of tags) {
          const moduleId = resolve(endpoint);
          if (!moduleId) {
            unresolvedEndpoints.add(endpoint);
            continue;
          }
          let seen = distinctRolesByModule.get(moduleId);
          if (!seen) {
            seen = new Set();
            distinctRolesByModule.set(moduleId, seen);
          }
          seen.add(tag.role);
          const cur = roleByModule.get(moduleId);
          if (cur === undefined || beats(tag, cur)) roleByModule.set(moduleId, tag);
        }
      }

      // --- groupingPrior ------------------------------------------
      // Collect now (in FILE-id space); resolve + apply as a subsystem override
      // after the loop, so a group spanning several adapters'/modules' files is
      // arbitrated globally. classificationsNeeded is deferred (not run here).
      if (adapter.groupingPrior) {
        let prior;
        try {
          prior = await adapter.groupingPrior(ctx);
        } catch (err) {
          console.warn(
            `  ⚠ framework adapter '${match.adapter}' groupingPrior failed (${(err as Error).message}) — skipping its groups`,
          );
          prior = undefined;
        }
        for (const group of prior?.groups ?? []) {
          rawGroups++;
          // Namespace the id by adapter (the documented FrameworkGroup contract)
          // so it's a unique, deterministic subsystem id across adapters.
          const key = `${match.adapter}:${group.id}`;
          const existing = groupsByKey.get(key);
          if (existing) existing.fileIds.push(...group.fileIds);
          else groupsByKey.set(key, { label: group.label, fileIds: [...group.fileIds] });
        }
      }
    }

    // --- cross-language full-stack seam ----------------------------
    // Fold the frontend→backend HTTP-API edges through the SAME file-id→module
    // resolution + self-edge drop + 8-verb validation + dedup as the adapter
    // syntheticEdges above (so a seam edge that duplicates a structural edge, or
    // collapses to one module, is handled identically).
    for (const fe of xlangEdges) {
      rawEdges++;
      const src = resolve(fe.source);
      const tgt = resolve(fe.target);
      if (!src || !tgt) {
        droppedUnresolved++;
        if (!src) unresolvedEndpoints.add(fe.source);
        if (!tgt) unresolvedEndpoints.add(fe.target);
        continue;
      }
      if (src === tgt) {
        droppedSelf++;
        continue;
      }
      let kind;
      try {
        kind = parseEdgeKind(fe.kind);
      } catch (err) {
        droppedBadKind++;
        console.warn(`  ⚠ cross-language edge emitted ${(err as Error).message}`);
        continue;
      }
      const key = `${src}→${tgt}:${kind}`;
      if (!edgesByKey.has(key)) {
        edgesByKey.set(key, { source: ModuleId(src), target: ModuleId(tgt), kind });
      }
    }
    if (xlangEdges.length > 0) {
      console.log(`  [cross-language] ${xlangEdges.length} frontend→backend API edge(s) contributed`);
    }

    // --- apply the grouping override -------------------------------
    // Resolve every group's FILE ids → MODULE ids, tally per-module group claims,
    // assign each claimed module to the group claiming the MOST of its files
    // (lexical group-key tiebreak), and MUTATE that ClusteredModule's packageId/
    // packageName so assemble's computeSubsystems renders the framework grouping
    // (precedence: framework group > workspace-package > directory). See the
    // SUBSYSTEM OVERRIDE note at the top of this file.
    const subsystems = new Map<string, { id: string; label: string }>();
    if (groupsByKey.size > 0) {
      const moduleById = new Map(cluster.modules.map((m) => [m.id, m]));
      // moduleId → groupKey → count of that group's files landing in the module.
      const claims = new Map<string, Map<string, number>>();
      const labelByKey = new Map<string, string>();
      const unresolvedGroupFiles = new Set<string>();
      for (const [key, group] of groupsByKey) {
        labelByKey.set(key, group.label);
        for (const fileId of group.fileIds) {
          const moduleId = resolve(fileId);
          const mod = moduleId ? moduleById.get(moduleId) : undefined;
          // Never claim an external / infra-namespaced module (it has no source
          // dir → it belongs to the fixed `external` subsystem, which outranks).
          if (!moduleId || !mod || mod.kind === 'external' || moduleId.includes(':')) {
            droppedGroupUnresolved++;
            unresolvedGroupFiles.add(fileId);
            continue;
          }
          let byKey = claims.get(moduleId);
          if (!byKey) {
            byKey = new Map();
            claims.set(moduleId, byKey);
          }
          byKey.set(key, (byKey.get(key) ?? 0) + 1);
        }
      }

      // Deterministic assignment + collision logging (no silent pick).
      for (const moduleId of [...claims.keys()].sort()) {
        const byKey = claims.get(moduleId)!;
        let winner = '';
        let winnerCount = -1;
        for (const [key, count] of byKey) {
          if (count > winnerCount || (count === winnerCount && key < winner)) {
            winner = key;
            winnerCount = count;
          }
        }
        if (byKey.size > 1) {
          const all = [...byKey.entries()].map(([k, c]) => `${k}×${c}`).sort().join(', ');
          console.log(`  [framework] module '${moduleId}' claimed by ${byKey.size} groups {${all}} → kept '${winner}'`);
        }
        const mod = moduleById.get(moduleId)!;
        const label = labelByKey.get(winner) ?? winner;
        // The override: ride 's packageId lever (read ONLY by
        // computeSubsystems). Clear packageRole — a framework group is a domain
        // boundary, not an app/lib/tooling package.
        mod.packageId = winner;
        mod.packageName = label;
        mod.packageRole = undefined;
        subsystems.set(moduleId, { id: winner, label });
      }

      // No silent caps: log group files that didn't resolve to a claimable
      // module (mirrors the unresolved-endpoints log on the edges path).
      if (unresolvedGroupFiles.size > 0) {
        const sample = [...unresolvedGroupFiles].sort().slice(0, 10);
        console.log(
          `  [framework] ${unresolvedGroupFiles.size} group file(s) didn't resolve to a claimable module (not regrouped): ${sample.join(', ')}` +
            (unresolvedGroupFiles.size > sample.length ? ' …' : ''),
        );
      }
    }

    // No silent caps: log unresolved endpoints + per-module role collapses.
    if (unresolvedEndpoints.size > 0) {
      const sample = [...unresolvedEndpoints].sort().slice(0, 10);
      console.log(
        `  [framework] ${unresolvedEndpoints.size} endpoint(s) didn't resolve to a module (dropped): ${sample.join(', ')}` +
          (unresolvedEndpoints.size > sample.length ? ' …' : ''),
      );
    }
    for (const [moduleId, set] of distinctRolesByModule) {
      if (set.size > 1) {
        const winner = roleByModule.get(moduleId)?.role;
        console.log(
          `  [framework] module '${moduleId}' had ${set.size} roles {${[...set].sort().join(', ')}} → kept '${winner}'`,
        );
      }
    }

    const edges = [...edgesByKey.values()];
    console.log(
      `→ framework contributions: ${edges.length} edge(s)` +
        (droppedSelf ? ` · ${droppedSelf} self-edge(s) collapsed` : '') +
        (droppedUnresolved ? ` · ${droppedUnresolved} unresolved` : '') +
        (droppedBadKind ? ` · ${droppedBadKind} bad-kind` : '') +
        ` · ${roleByModule.size} role(s)` +
        (subsystems.size ? ` · ${subsystems.size} module(s) regrouped into ${new Set([...subsystems.values()].map((s) => s.id)).size} subsystem(s)` : ''),
    );

    return {
      edges,
      roles: roleByModule,
      subsystems,
      counts: {
        adapters: manifest.matches.length,
        rawEdges,
        edges: edges.length,
        droppedSelf,
        droppedUnresolved,
        droppedBadKind,
        roles: roleByModule.size,
        groups: rawGroups,
        groupedModules: subsystems.size,
        droppedGroupUnresolved,
      },
    };
  } catch (err) {
    console.warn(
      `  ⚠ framework contribution failed (${(err as Error).message}) — continuing without framework edges/roles`,
    );
    return EMPTY;
  }
}

// Higher RoleTag.priority wins; lexical role tiebreak keeps it deterministic
// regardless of adapter/iteration order.
function beats(incoming: RoleTag, incumbent: RoleTag): boolean {
  const a = incoming.priority ?? 0;
  const b = incumbent.priority ?? 0;
  if (a !== b) return a > b;
  return incoming.role < incumbent.role;
}
