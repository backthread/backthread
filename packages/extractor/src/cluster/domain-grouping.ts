// PURE helpers for the LLM domain-pass GROUPING MODEL: the per-repo
// { groups, assignments } artifact that is cached in `subsystem_groups` and
// applied UNIFORMLY to every snapshot (so the time slider never reshuffles a
// box). No I/O, no LLM here — just the deterministic glue the orchestration
// (decisions/subsystem-grouping.ts) and its tests share:
//
//   * content SIGNATURES (the warm-start cache key),
//   * stable group-id minting,
//   * the warm-start PARTITION (which modules can keep their cached group vs
//     which need (re)assignment),
//   * building the model from a FULL or INCREMENTAL LLM reply,
//   * member-overlap id RECONCILIATION (carry ids across a full re-cluster — the
//     stabilizeModuleIds precedent), and
//   * the  TOTALITY finalize (drop empty groups + assert every module is
//     in exactly one non-empty group).

import { createHash } from 'node:crypto';
import { slugify } from './overrides.js';
import { DOMAIN_SUBSYSTEM_PREFIX } from './subsystem.js';

// A domain group as it lives in the cache + on Module.subsystem.
export interface DomainGroup {
  id: string;
  name: string;
  description?: string;
}

// What a module is assigned to + the signal signature that produced it.
export interface ModuleAssignment {
  groupId: string;
  signature: string;
}

// The whole per-repo grouping model (the `subsystem_groups` row payload).
export interface GroupingModel {
  groups: DomainGroup[];
  assignments: Record<string, ModuleAssignment>; // moduleId → assignment
}

// A group as the LLM proposes it — names are all the model knows; we mint ids.
export interface ProposedGroup {
  name: string;
  description?: string;
}

// One LLM reply: proposed groups + every covered module's chosen group NAME.
export interface LlmGrouping {
  groups: ProposedGroup[];
  assignments: Record<string, string>; // moduleId → group name
}

// The per-module signal handed to the LLM (id + summary + the "why"s behind its
// linked decisions and changelog). Defined here (pure) so the LLM layer
// (enrich/domain-groups.ts) and the orchestration share one shape.
export interface ModuleSignal {
  id: string;
  summary: string;
  whys: string[];
}

/**
 * The per-module content SIGNATURE: a short hash of (summary + sorted decision
 * ids + sorted changelog entry ids). It is the warm-start cache key — an
 * unchanged signature means the module's semantic signal didn't materially move,
 * so it keeps its cached group with NO LLM call. Sorted inputs make it
 * order-independent; the slice keeps the cache JSON compact.
 */
export function moduleSignature(input: {
  summary: string;
  decisionIds: readonly string[];
  changelogIds: readonly string[];
}): string {
  const canonical = JSON.stringify({
    s: input.summary ?? '',
    d: [...input.decisionIds].sort(),
    c: [...input.changelogIds].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Mint a STABLE, unique group id from a display name (slugify + de-collide
 * against an in-use set). An empty/garbage name falls back to `group`. The
 * `taken` set is mutated to reserve the returned id.
 *
 * the id is `domain:`-NAMESPACED so a domain-group id can NEVER equal a
 * module id (a bare path-derived slug — slugify strips ':'). The domain-pass
 * overwrites measured modules' `subsystem` with these ids when the gate trips;
 * React Flow keys both module nodes and subsystem super-nodes by id, so a bare
 * `billing-money` group colliding with a `billing-money` module would corrupt its
 * node store (the  camera bug). The de-collision suffix is appended AFTER
 * the namespaced base, so collisions stay namespaced too (`domain:foo-2`).
 */
export function mintGroupId(name: string, taken: Set<string>): string {
  const base = DOMAIN_SUBSYSTEM_PREFIX + (slugify(name) || 'group');
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

/**
 * MIGRATION: ensure every group id in a model is `domain:`-namespaced.
 * A pre CACHED model (`subsystem_groups`) carries BARE ids that can equal
 * a module id; the warm-start / cache-hit paths would otherwise carry those bare
 * ids straight back onto the snapshots on a re-ingest. This maps each non-`domain:`
 * id to `domain:<id>` (de-colliding against any already-namespaced id) and rewrites
 * the assignments to match. Idempotent: an already-namespaced (or empty) model is
 * returned unchanged. Only the OPAQUE id changes — display name/description and the
 * member sets are untouched; the renderer treats subsystem ids opaquely and the
 * uniform-apply rewrites every snapshot, so the one-time re-id is renderer-safe.
 */
export function namespaceModelIds(model: GroupingModel): GroupingModel {
  if (model.groups.every((g) => g.id.startsWith(DOMAIN_SUBSYSTEM_PREFIX))) return model;
  // Reserve the ids already in the right namespace so a bare id can't collide onto one.
  const taken = new Set(
    model.groups.filter((g) => g.id.startsWith(DOMAIN_SUBSYSTEM_PREFIX)).map((g) => g.id),
  );
  const remap = new Map<string, string>(); // old bare id → namespaced id
  const groups: DomainGroup[] = model.groups.map((g) => {
    if (g.id.startsWith(DOMAIN_SUBSYSTEM_PREFIX)) return g;
    let id = DOMAIN_SUBSYSTEM_PREFIX + g.id;
    let n = 2;
    while (taken.has(id)) id = `${DOMAIN_SUBSYSTEM_PREFIX}${g.id}-${n++}`;
    taken.add(id);
    remap.set(g.id, id);
    return { ...g, id };
  });
  const assignments: Record<string, ModuleAssignment> = {};
  for (const [moduleId, a] of Object.entries(model.assignments)) {
    assignments[moduleId] = { groupId: remap.get(a.groupId) ?? a.groupId, signature: a.signature };
  }
  return { groups, assignments };
}

/**
 * The WARM-START partition. Split the union of modules into:
 *   - `kept`: modules whose cached signature is unchanged AND whose cached group
 *     still exists → reuse the cached assignment, ZERO LLM.
 *   - `pendingIds`: new modules (no cache row) or modules whose signal changed →
 *     need (re)assignment by the LLM.
 * With no cache, everything is pending (a first full pass).
 */
export function selectPending(
  unionIds: readonly string[],
  signatures: Record<string, string>,
  cached: GroupingModel | null,
): { kept: Record<string, ModuleAssignment>; pendingIds: string[] } {
  const kept: Record<string, ModuleAssignment> = {};
  const pendingIds: string[] = [];
  const groupIds = new Set((cached?.groups ?? []).map((g) => g.id));
  for (const id of unionIds) {
    const c = cached?.assignments[id];
    if (c && c.signature === signatures[id] && groupIds.has(c.groupId)) {
      kept[id] = c;
    } else {
      pendingIds.push(id);
    }
  }
  return { kept, pendingIds };
}

// Resolve LLM assignments (moduleId → group NAME) to {groupId, signature} via a
// name→id map. A module whose chosen name doesn't resolve is left unassigned —
// finalizeModel's totality assert is the single fail-loud gate for that, so we
// never silently invent a group here.
function resolveAssignments(
  llmAssignments: Record<string, string>,
  nameToId: Map<string, string>,
  signatures: Record<string, string>,
  into: Record<string, ModuleAssignment>,
): void {
  for (const [moduleId, groupName] of Object.entries(llmAssignments)) {
    const groupId = nameToId.get(groupName);
    if (!groupId) continue;
    into[moduleId] = { groupId, signature: signatures[moduleId] ?? '' };
  }
}

/**
 * Build a model from a FULL LLM pass (every module assigned from scratch). Mints
 * a stable id per proposed group and resolves every assignment to it.
 */
export function buildFullModel(
  llm: LlmGrouping,
  signatures: Record<string, string>,
): GroupingModel {
  const taken = new Set<string>();
  const nameToId = new Map<string, string>();
  const groups: DomainGroup[] = llm.groups.map((g) => {
    const id = mintGroupId(g.name, taken);
    nameToId.set(g.name, id);
    return g.description ? { id, name: g.name, description: g.description } : { id, name: g.name };
  });
  const assignments: Record<string, ModuleAssignment> = {};
  resolveAssignments(llm.assignments, nameToId, signatures, assignments);
  return { groups, assignments };
}

/**
 * Build a model from an INCREMENTAL pass: keep the prior groups + the `kept`
 * assignments verbatim (existing modules NEVER move — the zero-churn guarantee),
 * fold in any genuinely-new groups the LLM proposed, and assign the pending
 * modules. A "new" group whose name matches an existing one reuses that id (the
 * LLM just re-named an existing domain), so we don't duplicate it.
 */
export function buildIncrementalModel(
  priorGroups: readonly DomainGroup[],
  kept: Record<string, ModuleAssignment>,
  llm: LlmGrouping,
  signatures: Record<string, string>,
): GroupingModel {
  const taken = new Set(priorGroups.map((g) => g.id));
  const nameToId = new Map<string, string>();
  for (const g of priorGroups) nameToId.set(g.name, g.id);

  const groups: DomainGroup[] = [...priorGroups];
  for (const g of llm.groups) {
    if (nameToId.has(g.name)) continue; // re-proposed existing domain — reuse id
    const id = mintGroupId(g.name, taken);
    nameToId.set(g.name, id);
    groups.push(g.description ? { id, name: g.name, description: g.description } : { id, name: g.name });
  }

  const assignments: Record<string, ModuleAssignment> = { ...kept };
  resolveAssignments(llm.assignments, nameToId, signatures, assignments);
  return { groups, assignments };
}

/** Members (module ids) assigned to each group id, from a model's assignments. */
function membersByGroup(model: GroupingModel): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [moduleId, a] of Object.entries(model.assignments)) {
    (out.get(a.groupId) ?? out.set(a.groupId, new Set()).get(a.groupId)!).add(moduleId);
  }
  return out;
}

/**
 * Carry stable group ids across a FULL re-cluster (the anti-drift safety valve).
 * Greedily map each NEW group to the PRIOR group it overlaps most (by shared
 * member count), carrying the prior id so a re-cluster doesn't rename/re-id a
 * domain that's substantially the same set of modules — the 
 * `stabilizeModuleIds` warm-start precedent. New groups with no prior overlap
 * keep their freshly-minted id (re-minted on collision with a carried id).
 * Returns a NEW model; inputs are untouched.
 */
export function reconcileGroupIds(next: GroupingModel, prior: GroupingModel): GroupingModel {
  const nextMembers = membersByGroup(next);
  const priorMembers = membersByGroup(prior);

  // All (nextId, priorId, overlap>0) pairs, strongest first.
  const pairs: Array<{ nextId: string; priorId: string; overlap: number }> = [];
  for (const [nextId, nMembers] of nextMembers) {
    for (const [priorId, pMembers] of priorMembers) {
      let overlap = 0;
      for (const m of nMembers) if (pMembers.has(m)) overlap += 1;
      if (overlap > 0) pairs.push({ nextId, priorId, overlap });
    }
  }
  pairs.sort((a, b) => b.overlap - a.overlap || (a.nextId < b.nextId ? -1 : 1));

  const remap = new Map<string, string>(); // nextId → priorId
  const claimedPrior = new Set<string>();
  const claimedNext = new Set<string>();
  for (const { nextId, priorId } of pairs) {
    if (claimedNext.has(nextId) || claimedPrior.has(priorId)) continue;
    remap.set(nextId, priorId);
    claimedNext.add(nextId);
    claimedPrior.add(priorId);
  }

  // Reserve carried prior ids; re-mint any unmatched next id that would collide.
  const taken = new Set<string>(remap.values());
  const finalIdFor = new Map<string, string>();
  for (const g of next.groups) {
    const carried = remap.get(g.id);
    if (carried) {
      finalIdFor.set(g.id, carried);
      continue;
    }
    // Unmatched: keep its own id unless a carried id already took it.
    let id = g.id;
    if (taken.has(id)) id = mintGroupId(g.name, taken);
    else taken.add(id);
    finalIdFor.set(g.id, id);
  }

  // Carry the prior group's NAME/description for a matched group (id + label
  // stay together so the carried box reads identically to before).
  const priorById = new Map(prior.groups.map((g) => [g.id, g]));
  const groups: DomainGroup[] = next.groups.map((g) => {
    const id = finalIdFor.get(g.id)!;
    const carried = remap.has(g.id) ? priorById.get(id) : undefined;
    const name = carried?.name ?? g.name;
    const description = g.description ?? carried?.description;
    return description ? { id, name, description } : { id, name };
  });
  const assignments: Record<string, ModuleAssignment> = {};
  for (const [moduleId, a] of Object.entries(next.assignments)) {
    assignments[moduleId] = { groupId: finalIdFor.get(a.groupId) ?? a.groupId, signature: a.signature };
  }
  return { groups, assignments };
}

/**
 * The  finalize: DROP empty groups (an LLM-proposed group nobody landed
 * in — a known Flash-Lite artifact) and ASSERT every module in `unionIds` is
 * assigned to exactly one EXISTING group. Throws on any gap; the caller runs
 * fail-soft, so a broken partition degrades to the directory default rather than
 * persisting. Returns the pruned model.
 */
export function finalizeModel(model: GroupingModel, unionIds: readonly string[]): GroupingModel {
  const members = membersByGroup(model);
  const groups = model.groups.filter((g) => (members.get(g.id)?.size ?? 0) > 0);
  const liveIds = new Set(groups.map((g) => g.id));

  const missing: string[] = [];
  const dangling: string[] = [];
  for (const id of unionIds) {
    const a = model.assignments[id];
    if (!a) {
      missing.push(id);
    } else if (!liveIds.has(a.groupId)) {
      dangling.push(id);
    }
  }
  if (missing.length || dangling.length) {
    const parts: string[] = [];
    if (missing.length) parts.push(`${missing.length} unassigned (${missing.slice(0, 5).join(', ')}…)`);
    if (dangling.length) parts.push(`${dangling.length} in a dropped/unknown group (${dangling.slice(0, 5).join(', ')}…)`);
    throw new Error(`domain grouping is not a complete partition: ${parts.join('; ')}`);
  }
  return { groups, assignments: model.assignments };
}

// A group resolved to a Module.subsystem shape (id + name + optional description).
export function groupToSubsystem(g: DomainGroup): { id: string; name: string; description?: string } {
  return g.description ? { id: g.id, name: g.name, description: g.description } : { id: g.id, name: g.name };
}
