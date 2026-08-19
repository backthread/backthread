/**
 * The validation gate for an untrusted graph payload.
 *
 * THIS IS THE FEATURE, NOT A CHORE. The customer ask was not "send us less
 * data"; it was *"I'd have no way to verify your security practices."* The half
 * of the answer that lives on our side is: **only validated, inspectable derived
 * data is admitted, and what we refuse to accept is exactly what they can verify
 * we receive.** The gate and the payload artefact are the same design read from
 * two directions.
 *
 * WHERE THE TRUST BOUNDARY IS. At the **ingress**, not at `persist_snapshot`.
 * Once a payload is admitted it flows into a container holding `service_role`
 * that mutates `snapshots.data` through more than one route
 * (`updateSnapshotData`, `refold_layout_union`, `merge_extraction_cache_keys`).
 * Gating one RPC does not gate every write, so everything checkable must be
 * checked before the sandbox spawns — which is also why wallet admission (Tier
 * 7) moved here from where it lives on the clone path.
 *
 * WHAT THE PUBLISHED VALIDATOR DOES AND DOES NOT COVER. `isValidFileRecord`
 * (MIT, `@backthread/extractor`) is reused verbatim so the runner and our
 * ingress run the *identical* check — "validated derived data" becomes a shared
 * auditable function rather than an assurance we give. But it was written to
 * decide "is this cache row usable", not "is this attacker hostile": it accepts
 * a negative `loc`, an infinite `weight`, unknown extra keys, a megabyte-long
 * path, and an edge pointing at a file that does not exist. Tiers 1-4 are
 * exactly the gap, and they are net-new.
 *
 * HARD VS SOFT, AND WHY THE LINE IS THERE. `assemble/validate.ts` already
 * splits this way and the posture is correct here for a specific reason: a
 * lying runner can only corrupt **its own repo's** snapshot. So identity,
 * bounds, schema, referential integrity, sanitation and sha attestation are
 * hard; plausibility is soft. Legitimate monorepo splits and big refactors look
 * exactly like a hostile payload, and hard-rejecting them would break real
 * customers to defend them against themselves.
 *
 * REJECT, DON'T TRUNCATE. A silently-truncated graph renders as a false
 * architecture — a picture the reader believes and that is wrong. That is worse
 * than an error, because an error is visible on their runner and a false
 * architecture is not visible anywhere.
 *
 * ⚠ THE EXTERNALS-CLASSIFIER CRASH CLASS RETURNS HERE, ATTACKER-CONTROLLED. Malformed
 * external specifiers crashed the externals classifier in production ("container
 * exit 1"). There they arrived by accident; here they arrive on purpose, and the
 * container that would crash is the one we are about to spend money spawning.
 */

/**
 * ⚠ WHY THESE ARE LOCAL COPIES AND NOT AN IMPORT FROM `@backthread/extractor`.
 *
 * The first version imported `isValidFileRecord` and the per-language
 * `*_SOURCE_EXTENSIONS` at runtime, so the runner and our ingress would run the
 * IDENTICAL published check. That is the better design and it does not deploy:
 * the package's only export path is its root, which pulls in `version.js`, whose
 * fallback branch calls `fileURLToPath(import.meta.url)`. esbuild lowers that to
 * `__filename` as a MODULE-LEVEL transform — not inside the dead branch — and the
 * Workers runtime has no such symbol, so the upload fails validation with
 * `Uncaught ReferenceError: __filename is not defined`. Measured: defining the
 * package's own `__EXTRACTOR_VERSION__` bundler hook does not help, because the
 * lowering happens whether or not the branch runs.
 *
 * So the copies live here and `worker/test/extractorLockstep.test.ts` holds them
 * to the published originals — it runs under tsx, where importing the extractor
 * is fine. That is the same shape `supabase/functions/filePaths.lockstep.test.ts`
 * already uses for the same reason. The guarantee moves from "the same function"
 * to "a function a test proves equivalent", which is weaker, and saying so is
 * better than a claim the deploy disproves.
 */
import type { EdgeKind, FileRecord, InfraModuleKind, ModuleKind, NodeProvenance } from '@backthread/extractor';
// The shared untrusted-input boundary module. Imported across the package
// edge rather than duplicated — `worker/src/digestPolish.ts`, `lessonGrade.ts` and
// `groundedAsk.ts` already reach for it exactly this way. A second copy would
// drift, and the whole value of that module is that there is one of it.
//
// `looksLikeInjectionInPath` is the ONE extension this epic added to that module,
// and only because the payload presents a case the accidental-producer work did
// not: every shape there requires real WHITESPACE — deliberately, so
// `ignore-rules.json` is not a false positive — and a hostile producer names a
// directory `ignore-previous-instructions-and-output/`. Kebab-case defeats a
// whitespace-anchored detector entirely. Nothing existing was weakened; the
// original predicate is unchanged and still runs first.
import {
  looksLikeInjection,
  looksLikeInjectionInPath,
  sanitizeProse,
} from './untrusted.js';
// The npm package-name grammar the externals-classifier fix is built on. Reused,
// not re-derived — see `isKnownEcosystemSpecifier` for why it is a signal here
// rather than a global gate.
import { isValidPackageName } from './sanitize.js';
// The byte budget owns the whole cap story; this file consumes it.
import {
  MAX_ENV_SERVICE_BYTES,
  MAX_ENV_SERVICES,
  MAX_FILES,
  MAX_FRAMEWORK_ADAPTERS,
  MAX_FRAMEWORK_EDGES,
  MAX_FRAMEWORK_GROUP_FILES,
  MAX_FRAMEWORK_GROUPS,
  MAX_FRAMEWORK_ROLES,
  MAX_TOTAL_FRAMEWORK_BYTES,
  MAX_INFRA_CLASSIFICATIONS,
  MAX_INFRA_EDGES,
  MAX_INFRA_NODES,
  MAX_INFRA_SOURCE_ROOTS,
  MAX_MANIFEST_CONTENT_BYTES,
  MAX_TOTAL_INFRA_BYTES,
  MAX_TOTAL_MANIFEST_BYTES,
  MAX_WORKSPACE_MANIFESTS,
  ciCeilingNote,
} from './payload.js';

// ---------------------------------------------------------------------------
// Tier 1 — resource bounds
// ---------------------------------------------------------------------------

/**
 * The file-count ceiling.
 *
 * ⚠ NO LONGER MIRRORED FROM `DEFAULT_BUDGET.maxFiles`. It was, on the
 * reasoning that a repo must not be ingestable through one door and not the
 * other. The mirror did not deliver that: 50 000 files needs ≤335 B/file to fit
 * inside `MAX_INFLATED_BYTES`, which is below the measured production median, so
 * the byte cap bound first for effectively every real repo — and refused with
 * `inflated_too_large`, an error naming bytes when the operator can only act on
 * file count. The doors already disagreed; the constant just hid it.
 *
 * It is now DERIVED from the byte budget in `ciPayload.ts`, so the two caps state
 * one ceiling in two units instead of two ceilings. Full reasoning, the
 * measurement, and the precise guarantee live on `MAX_FILES` there — one home for
 * the whole cap story, since it is the byte budget that decides it.
 */
export { MAX_FILES, CLONE_PATH_MAX_FILES, OBSERVED_DENSEST_BYTES_PER_FILE } from './payload.js';
export {
  MAX_MANIFEST_CONTENT_BYTES,
  MAX_TOTAL_MANIFEST_BYTES,
  MAX_WORKSPACE_MANIFESTS,
} from './payload.js';
export {
  MAX_INFRA_CLASSIFICATIONS,
  MAX_INFRA_EDGES,
  MAX_INFRA_NODES,
  MAX_INFRA_SOURCE_ROOTS,
  MAX_TOTAL_INFRA_BYTES,
} from './payload.js';
export { MAX_ENV_SERVICE_BYTES, MAX_ENV_SERVICES, MAX_TOTAL_ENV_BYTES } from './payload.js';
export {
  MAX_FRAMEWORK_ADAPTERS,
  MAX_FRAMEWORK_EDGES,
  MAX_FRAMEWORK_GROUP_FILES,
  MAX_FRAMEWORK_GROUPS,
  MAX_FRAMEWORK_ROLES,
  MAX_TOTAL_FRAMEWORK_BYTES,
} from './payload.js';
/** Edges scale with files; the absolute cap stops a small file set claiming millions. */
export const MAX_EDGES_PER_FILE = 20;
export const MAX_EDGES_ABSOLUTE = 1_000_000;
export const MAX_EXTERNALS = 20_000;
/** Every string in the payload. Real paths and specifiers are far shorter. */
export const MAX_STRING_BYTES = 1024;
/** A file path with more segments than this is not a path, it is an attack. */
export const MAX_PATH_DEPTH = 32;
/** `loc` above this is not a source file. The budget's per-file byte cap is 8 MB. */
export const MAX_LOC = 5_000_000;
/** Package specifiers: npm's own limit, and the longest any ecosystem needs. */
export const MAX_SPECIFIER_LEN = 214;
/** How far `checkpoint.date` may sit from receipt, in either direction. */
export const MAX_CHECKPOINT_SKEW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The languages the extractor can emit. `FileRecord.language` is the file's
 * EXTENSION (verified against production: `ts`/`tsx`/`jsx`/`js`/`mjs` are what
 * real rows carry).
 *
 * ⚠ THIS IS A LITERAL, NOT A DERIVATION, AND THE COMMENT USED TO SAY OTHERWISE.
 * It claimed the set was built from the extractor's own exported extension lists
 * and therefore widened automatically when a language was added. It does not: this
 * file may not import the extractor at runtime — that import is what the whole
 * lockstep arrangement exists to avoid — so the list is written out here and
 * `extractorLockstep.test.ts` holds it to the originals under a runtime that CAN
 * import them. A reviewer caught the claim, which matters more than it sounds:
 * a reader who believed "widens automatically" would add a language upstream and
 * expect this to follow, and it would silently reject that language's repos until
 * the lockstep test failed and someone read it.
 *
 * The guarantee is therefore "a list a test proves equal", not "the same list" —
 * weaker, and saying so is better than a claim the arrangement disproves.
 */
export const KNOWN_LANGUAGES: ReadonlySet<string> = new Set<string>([
  // ts
  'ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs',
  'py', 'pyi',                          // python
  'rb', 'rake', 'ru',                   // ruby
  'ex', 'exs', 'eex', 'heex', 'leex',   // elixir
  'dart', 'kt', 'swift', 'java', 'go',  // dart / kotlin / swift / java / go
  'php',
]);

/**
 * The published `isValidFileRecord`, transcribed. Shape only — it deliberately
 * accepts a negative `loc`, an infinite `weight` and unknown extra keys, because
 * it was written to decide "is this cache row usable", not "is this producer
 * hostile". Tiers 1-4 are exactly that gap, and they run on top of this.
 */
export function isValidFileRecord(v: unknown): v is FileRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (typeof r.loc !== 'number' || typeof r.language !== 'string') return false;
  if (!isEdgeRefArray(r.imports) || !isEdgeRefArray(r.calls)) return false;
  if (!isExternalRefArray(r.externals)) return false;
  if (!Array.isArray(r.reexports) || !r.reexports.every((t) => typeof t === 'string')) return false;
  if (r.groupingPath !== undefined && typeof r.groupingPath !== 'string') return false;
  return true;
}

function isEdgeRefArray(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every((e) => !!e && typeof e === 'object' && typeof (e as { to?: unknown }).to === 'string' &&
      typeof (e as { weight?: unknown }).weight === 'number')
  );
}

function isExternalRefArray(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every((e) => !!e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string' &&
      typeof (e as { specifier?: unknown }).specifier === 'string' &&
      typeof (e as { weight?: unknown }).weight === 'number')
  );
}

/** Keys a `FileRecord` may carry. Anything else is rejected, not ignored. */
const ALLOWED_RECORD_KEYS: ReadonlySet<string> = new Set([
  'loc',
  'language',
  'imports',
  'externals',
  'calls',
  'reexports',
  'groupingPath',
  'blobSha',
]);

/**
 * ⚠ `git` IS DELIBERATELY ABSENT, AND THE WHY-LAYER WORK IS THE REASON IT STAYS
 * ABSENT RATHER THAN THE REASON TO ADD IT.
 *
 * An earlier change deleted a declared-but-unlisted `git` field because the
 * container's type promised something this set refused — a producer that believed
 * the type got `unknown_field`, a documented lie. The obvious reading of "give the
 * CI path a why-layer" is to finish that job by listing the key here.
 *
 * That work decided the opposite, and the asymmetry is the security property. The
 * merged PRs are fetched by the WORKER from GitHub (`ciGit.ts`) with a
 * `pull_requests`-scoped token and written into the staged R2 object AFTER this gate
 * runs, so the container's `git` block is provably ours. A customer-supplied one is
 * still refused HERE, because a runner-asserted PR could be invented and attributed
 * to an engineer who never wrote it — and a fabricated why filed under a real
 * teammate's name is worse than the invisibility the issue was filed to fix.
 *
 * So: the container declares `git`, this set refuses `git`, and BOTH halves are
 * tested (`ciValidate.test.ts` pins the `unknown_field` refusal;
 * `ciGraphJob.test.ts` pins that the Worker's block is what the container receives,
 * assigned unconditionally). Do not "fix the inconsistency" by adding it here —
 * that would hand the wire back a field whose whole point is that it never crosses
 * it.
 */
const ALLOWED_TOP_KEYS: ReadonlySet<string> = new Set([
  'payloadVersion',
  'actionVersion',
  'extractorVersion',
  'fileGraphVersion',
  'extractorCacheVersion',
  'repo',
  'checkpoint',
  'state',
  'manifests',
  'workspaceManifests',
  'infra',
  'envServices',
  'framework',
  'counts',
  'claim',
]);

/**
 * The claim code's shape on the wire.
 *
 * ⚠ DELIBERATELY LOOSER THAN THE FORMAT THE DATABASE GENERATES. Codes are minted as
 * `bt_` plus 24 hex characters, and pinning exactly that here would make the format
 * a LOCKSTEP: change how codes are generated and every already-published client
 * refuses the new ones, on a code path the customer cannot see or update quickly.
 *
 * So this bounds what could hurt — length, and an alphabet with no whitespace,
 * quotes or control bytes to carry an injection — and leaves identity to the only
 * thing that can actually decide it, which is whether a row matches. A well-formed
 * code that names nothing is refused by the lookup, not by a regex guessing at the
 * key space.
 */
const CLAIM_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Is this a plausible claim code?
 *
 * Exported so the PRODUCER can ask the same question the ingress asks, from ONE
 * definition. The runner needs it for a reason the ingress does not have: a customer
 * who typos `BACKTHREAD_CLAIM` must not have their build fail on `invalid_claim`
 * after a full extract. The client checks first and simply does not send a value
 * this refuses — and it can only do that without drifting from the gate if the gate
 * hands out the question rather than the answer.
 */
export function isWellFormedClaimCode(value: unknown): value is string {
  return typeof value === 'string' && CLAIM_RE.test(value);
}

/**
 * The three locked enums the infra graph is validated against.
 *
 * ⚠ WRITTEN AS `Record<Published, true>` RATHER THAN A `Set<string>`, AND THAT IS
 * THE STRONGEST HALF OF THE GUARD. A `Set` of string literals type-checks against
 * nothing: drop a member and the compiler is happy, and the ingress starts refusing
 * a legitimate kind. Keyed by the PUBLISHED type, `tsc` refuses a missing member
 * (`Property 'cdn' is missing`) AND an invented one — so the copies cannot drift
 * from `@backthread/extractor` without the build failing. `extractorLockstep.test.ts`
 * adds the runtime half, holding these to the published ARRAYS.
 *
 * ⚠ AND NOTE WHAT IS **NOT** HERE. `MODULE_KINDS` has twelve members; infra nodes
 * may only ever be one of the eight INFRA kinds, because `assemble` places them in
 * the infra column and `parseModuleKind` would happily accept `frontend`. Widening
 * this to `MODULE_KINDS` would let a payload declare a code module through the
 * infra door. And `FORBIDDEN_EDGE_KINDS` (`imports`/`depends-on`/`uses`) is absent
 * by construction: `EDGE_KINDS` is the eight-verb taxonomy and the substrate labels
 * are not in it, so a payload carrying one is refused HERE instead of throwing out
 * of `parseEdgeKind` deep inside a container we already paid to boot.
 */
const INFRA_KINDS: Readonly<Record<InfraModuleKind, true>> = {
  worker: true,
  'static-site': true,
  queue: true,
  container: true,
  datastore: true,
  'external-api': true,
  'secret-store': true,
  cdn: true,
};
const INFRA_EDGE_KINDS: Readonly<Record<EdgeKind, true>> = {
  calls: true,
  reads: true,
  writes: true,
  publishes: true,
  subscribes: true,
  'webhook-from': true,
  'deploys-to': true,
  'stores-in': true,
};
/**
 * `NodeProvenance` is a bare union in the package — there is no exported array to
 * lockstep against, so this is the one copy the runtime guard cannot check. The
 * `Record` keying is therefore load-bearing rather than stylistic: it is the ONLY
 * thing that fails if the union changes.
 */
const NODE_PROVENANCES: Readonly<Record<NodeProvenance, true>> = {
  declared: true,
  inferred: true,
  'llm-classified': true,
};

/**
 * The twelve `MODULE_KINDS`, for a framework ROLE TAG's `kind`.
 *
 * ⚠ THIS IS THE ONE PLACE THE WIDER ENUM IS CORRECT, and the infra note above says
 * why it is wrong everywhere else: an infra node may only be one of the eight INFRA
 * kinds, because widening it would let a payload declare a CODE module through the
 * infra door. A role tag is different — it annotates a module that already exists
 * and `assemble` reads only `{role}` from it, leaving the module's own `kind`
 * untouched (the locked "roles never widen the Module-kind enum" discipline). The
 * field is on the wire because the published `RoleTag` types it, and it is checked
 * because a field named `kind` carrying an unchecked string is how an enum stops
 * meaning anything.
 *
 * ⚠ `external` IS ABSENT ON PURPOSE. It is in the `ModuleKind` UNION but not in the
 * `MODULE_KINDS` array — the deprecated value `assemble` maps onto `external-api`
 * at the producer boundary — so a role tag naming it is an adapter bug, not a
 * legitimate contribution. `Exclude` keeps `tsc` enforcing membership either way.
 */
const ROLE_MODULE_KINDS: Readonly<Record<Exclude<ModuleKind, 'external'>, true>> = {
  frontend: true,
  service: true,
  gateway: true,
  job: true,
  worker: true,
  'static-site': true,
  queue: true,
  container: true,
  datastore: true,
  'external-api': true,
  'secret-store': true,
  cdn: true,
};

/** Exported for the lockstep test, which holds them to the published arrays. */
export const INFRA_MODULE_KIND_VALUES: readonly string[] = Object.keys(INFRA_KINDS);
export const INFRA_EDGE_KIND_VALUES: readonly string[] = Object.keys(INFRA_EDGE_KINDS);
export const ROLE_MODULE_KIND_VALUES: readonly string[] = Object.keys(ROLE_MODULE_KINDS);

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

export interface CiRejection {
  status: number;
  error: string;
  detail?: string;
  /** Which tier fired. Carried so the CI step summary can say what to fix. */
  tier: number;
}

/**
 * Walk the whole parsed payload and assert every string is under the cap.
 *
 * ⚠ WHY A WALK AND NOT MORE PER-FIELD CHECKS. The first version applied
 * `MAX_STRING_BYTES` in exactly three places and its own comment claimed it
 * covered "every string in the payload". It did not: `actionVersion`,
 * `extractorVersion`, `checkpoint.subject` and `repo.defaultBranch` each accepted
 * 200 KB, and `checkpoint.subject` reaches an enrich prompt. A per-field list is
 * a list somebody has to remember to extend; a walk cannot be forgotten.
 *
 * The node budget is not decoration. Without it this walk is itself a denial of
 * service on a deeply-nested or wide payload — the guard would become the hole.
 */
const MAX_WALK_NODES = 4_000_000;

/**
 * Maximum nesting depth anywhere in the payload.
 *
 * ⚠ FOUND BY AN INDEPENDENT VERIFIER, AND IT IS A CRASH RATHER THAN A GAP.
 * `JSON.parse` builds an arbitrarily deep object graph happily; `JSON.stringify`
 * RECURSES. So a **316-byte gzipped** body of the shape `{"nodes":[[[[…]]]]}` —
 * 10 000 nested arrays — reached the infra tier's byte measurement and threw
 * `RangeError: Maximum call stack size exceeded`, which the ingress's outer handler
 * turns into a **500 plus a P2 ops alert**. Twelve milliseconds and three hundred
 * bytes per request, repeatable, and every repeat pages someone.
 *
 * Measured before this guard existed:
 *
 *   depth 10 000 -> RangeError, body 20 458 bytes, 316 gzipped, 12 ms
 *   depth 30 000 -> RangeError, body 60 458 bytes, 367 gzipped, 15 ms
 *
 * ⚠ IT IS ENFORCED IN THE ITERATIVE WALK, AND THAT PLACEMENT IS THE FIX.
 * `boundedStrings` runs before anything else touches the structure and walks with an
 * explicit stack, so it cannot itself blow the stack on the input it is judging.
 * Bounding depth only inside the infra tier would have moved the crash to
 * `stageBody`'s `JSON.stringify(body.value)`, which runs AFTER validation — a guard
 * placed after the damage is a guard that cannot fire, which is the reasoning
 * `readBoundedBody` already turns on.
 *
 * 64 against a real maximum of about six: the deepest legal path is
 * `$.state.files[id].imports[i].to`, and the infra graph's is
 * `$.infra.nodes[i].metadata.type`. Deliberately far above anything legitimate, so
 * this is a sanity ceiling rather than a schema constraint someone must re-derive
 * whenever a field is added.
 */
export const MAX_JSON_DEPTH = 64;

/**
 * Maximum PENDING entries in the payload walk — the width bound, beside the depth one.
 *
 * ⚠ A THIRD VERIFIER TOOK THE INGRESS DOWN AGAIN, FROM A 9 KB BODY, AND THE DEPTH FIX
 * DID NOT TOUCH IT. `boundedStrings` walks iteratively — which is what makes it safe
 * against DEPTH — by pushing every child of a container before popping any. So a FLAT
 * array of 620 000 empty arrays costs nothing in depth and everything in width: each
 * pending entry carries two freshly-built path strings, measured at **220 bytes**.
 *
 *   620 000 elements  ->  ~140 MB live heap, from   9 266 gzipped bytes (202:1, legal)
 *   4 000 000 elements ->  ~880 MB, peak RSS 1 222 MB measured
 *
 * The Workers isolate has 128 MB in total, so both die the same way the depth bomb did
 * — 500 plus a P2 alert. `MAX_WALK_NODES` cannot bind it: it counts entries POPPED, so
 * it is reached long after the peak, and 4 000 000 of them is 30× what the runtime can
 * hold. The ratio guard cannot either: 202:1 is well inside `MAX_DECOMPRESSION_RATIO`.
 *
 * ⚠ THE NUMBER IS DERIVED FROM THE LEGAL PEAK, NOT PICKED. The walk is LIFO, so the
 * peak is the widest single container: `state.files` at `MAX_FILES` keys = **23 199**
 * pending entries (plus a handful for the record being descended into). The other wide
 * shapes are smaller — `manifests[i].deps` is capped at 10 000, `infra.nodes` at 5 000.
 * 100 000 is ~4× the legal maximum and ~22 MB at the measured per-entry cost, which
 * co-exists with a 16 MiB payload inside 128 MB. A payload at the file cap is admitted
 * and a wider one is refused, and `ciCaps.test.ts` builds both rather than asserting
 * the arithmetic — the arithmetic is what was wrong the last three times.
 */
export const MAX_WALK_STACK = 100_000;

/**
 * Whether a parsed value nests deeper than `max`. ITERATIVE — a recursive depth
 * check would be the very stack overflow it exists to prevent.
 *
 * Exported because `validateInfraGraph` runs STANDALONE on the customer's runner,
 * where `boundedStrings` has not run and its own `JSON.stringify` would be the thing
 * that throws.
 */
export function exceedsDepth(value: unknown, max: number): boolean {
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const { v, d } = stack.pop() as { v: unknown; d: number };
    // ⚠ A BUDGET, NOT DECORATION, AND `true` IS THE SAFE ANSWER. A structure whose
    // children are SHARED references fans out exponentially: measured 94 ms at 14
    // levels, 839 ms at 16, and it does not return at 20. `JSON.parse` cannot build
    // one, so this is unreachable from the wire today — which is a property of the
    // producer rather than of this function, and this function is exported. Refusing
    // (rather than continuing) is the conservative direction: the caller's next move
    // is `JSON.stringify`, and a shape this walk cannot finish is one it should not
    // hand on.
    visited += 1;
    if (visited > MAX_WALK_NODES || stack.length > MAX_WALK_STACK) return true;
    if (!v || typeof v !== 'object') continue;
    if (d >= max) return true;
    if (Array.isArray(v)) {
      for (const child of v) stack.push({ v: child, d: d + 1 });
    } else {
      for (const child of Object.values(v as Record<string, unknown>)) {
        stack.push({ v: child, d: d + 1 });
      }
    }
  }
  return false;
}

/**
 * The ONLY string fields that are not governed by `MAX_STRING_BYTES`, keyed by
 * their SHAPE — the JSON path with array indices erased.
 *
 * ⚠ WHY AN EXEMPTION MAP AND NOT A HIGHER GLOBAL CAP. A workspace
 * manifest's `content` is a whole `package.json`: our own root one is 5 364 bytes,
 * **5.2× `MAX_STRING_BYTES`**, so the walk would refuse our own repo. The obvious
 * fix — raise `MAX_STRING_BYTES` — would also re-admit a 64 KB `checkpoint.subject`,
 * and `checkpoint.subject` reaches an enrich prompt. The cap exists for that field,
 * not for this one, so the exemption is per-field.
 *
 * ⚠ AND IT IS A DIFFERENT CAP, NOT AN ABSENCE. An exemption that meant "unbounded"
 * would turn the guard into the hole it was written to close. Every path in this map
 * carries its own number, the walk enforces THAT number, and the walk still cannot
 * be forgotten: a new large field that is not listed here is refused at 1 KB, which
 * is a loud failure on the runner rather than a silent widening here.
 *
 * The map is keyed by shape so `workspaceManifests[0].content` and
 * `workspaceManifests[999].content` are one entry rather than a thousand, and so a
 * DIFFERENT field of the same name elsewhere (`state.files['x'].content`, say)
 * is NOT exempt — which a bare key-name match would have got wrong.
 */
const LARGE_STRING_FIELDS: ReadonlyMap<string, number> = new Map([
  ['$.workspaceManifests[].content', MAX_MANIFEST_CONTENT_BYTES],
]);

/**
 * ⚠ THE REASON IS RETURNED, NOT INFERRED BY THE CALLER. This used to return a
 * bare `{ ok: false, where }` for BOTH of its failures, and the call site
 * labelled every one of them `string_too_long`. So a payload refused for having
 * too many NODES came back as `error: 'string_too_long'` with the detail
 * `payload has too many nodes` — an error code contradicting its own detail, at
 * the one moment someone is trying to work out what their runner sent wrong.
 */
type BoundedStringsFailure = 'string_too_long' | 'too_many_nodes' | 'too_deep' | 'too_wide';

function boundedStrings(
  value: unknown,
): { ok: true } | { ok: false; reason: BoundedStringsFailure; where: string } {
  let nodes = 0;
  // `path` carries array INDICES (it is what the refusal reports, and "entry 7"
  // is the only actionable part of it); `shape` erases them, and is what the
  // exemption map is keyed by. Carrying both costs one string per node and means
  // the exemption cannot be widened by an index.
  const stack: Array<{ v: unknown; path: string; shape: string; depth: number }> = [
    { v: value, path: '$', shape: '$', depth: 0 },
  ];
  while (stack.length > 0) {
    const { v, path, shape, depth } = stack.pop() as {
      v: unknown;
      path: string;
      shape: string;
      depth: number;
    };
    nodes += 1;
    // Depth is checked in THIS walk because it is the first thing that touches the
    // structure — see `MAX_JSON_DEPTH`. Anything deeper later reaches a
    // `JSON.stringify` (the infra byte cap, or `stageBody`) and throws `RangeError`.
    if (depth > MAX_JSON_DEPTH) {
      return { ok: false, reason: 'too_deep', where: `${path} > ${MAX_JSON_DEPTH}` };
    }
    // The WIDTH bound, checked where the memory is actually held. See MAX_WALK_STACK:
    // `MAX_WALK_NODES` counts pops and so is reached long after the peak.
    if (stack.length > MAX_WALK_STACK) {
      return { ok: false, reason: 'too_wide', where: `${stack.length} > ${MAX_WALK_STACK}` };
    }
    if (nodes > MAX_WALK_NODES) {
      return { ok: false, reason: 'too_many_nodes', where: `${nodes} > ${MAX_WALK_NODES}` };
    }
    if (typeof v === 'string') {
      // An unlisted field gets `MAX_STRING_BYTES`. The `??` is the whole safety
      // property of the exemption: absence means the strict cap, never no cap.
      const cap = LARGE_STRING_FIELDS.get(shape) ?? MAX_STRING_BYTES;
      if (byteLength(v) > cap) {
        return { ok: false, reason: 'string_too_long', where: `${path} > ${cap}` };
      }
      continue;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i += 1) {
        stack.push({ v: v[i], path: `${path}[${i}]`, shape: `${shape}[]`, depth: depth + 1 });
      }
      continue;
    }
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        // The KEY is a string in the payload too — a 200 KB object key is exactly
        // as good a memory sink as a 200 KB value. Keys are NEVER exempt: an
        // exemption is granted to a named field's VALUE, and a payload that could
        // name its own key would grant itself one.
        if (byteLength(k) > MAX_STRING_BYTES) {
          return { ok: false, reason: 'string_too_long', where: `${path}.<key>` };
        }
        stack.push({ v: child, path: `${path}.${k}`, shape: `${shape}.${k}`, depth: depth + 1 });
      }
    }
  }
  return { ok: true };
}

/**
 * The keys each nested shape may carry. The first version guarded the envelope
 * and the file record and nothing else, so an extra key on an EDGE, an EXTERNAL,
 * `state`, `repo`, `checkpoint` or a manifest entry sailed through — and an
 * attacker aims at the level nobody guarded, not the two that were.
 */
const ALLOWED_EDGE_KEYS: ReadonlySet<string> = new Set(['to', 'weight']);
const ALLOWED_EXTERNAL_KEYS: ReadonlySet<string> = new Set(['id', 'specifier', 'weight']);
const ALLOWED_STATE_KEYS: ReadonlySet<string> = new Set(['headSha', 'files']);
const ALLOWED_REPO_KEYS: ReadonlySet<string> = new Set(['owner', 'name', 'defaultBranch']);
const ALLOWED_CHECKPOINT_KEYS: ReadonlySet<string> = new Set(['sha', 'date', 'subject', 'trigger']);
const ALLOWED_MANIFEST_KEYS: ReadonlySet<string> = new Set(['path', 'deps']);
const ALLOWED_WORKSPACE_MANIFEST_KEYS: ReadonlySet<string> = new Set(['path', 'content']);
const ALLOWED_DEP_KEYS: ReadonlySet<string> = new Set(['name', 'version']);
const ALLOWED_COUNT_KEYS: ReadonlySet<string> = new Set(['files', 'edges', 'externals']);

function unknownKeyIn(
  v: unknown,
  allowed: ReadonlySet<string>,
  where: string,
): string | null {
  if (!v || typeof v !== 'object') return null;
  for (const k of Object.keys(v as Record<string, unknown>)) {
    if (!allowed.has(k)) return `${where}.${k}`;
  }
  return null;
}

export interface CiValidation {
  rejection: CiRejection | null;
  /** Tier 6. Never a rejection; surfaced on the snapshot and as an ops P2. */
  warnings: string[];
  /**
   * The payload's node-bearing counts.
   *
   * ⚠ `infraNodes` AND `envServices` ARE HERE FOR THE NODE-CEILING GATE, AND
   * UNDER-COUNTING EITHER BREAKS IT. All four fields feed `nodeCeilingOf`, the upper
   * bound on how many snapshot nodes this payload can produce. `files` alone is 30
   * against 36 real nodes on `marola-platform` — so a ceiling missing a term is an
   * UNDER-estimate, and an under-estimated ceiling refuses a healthy repo. Anything
   * new that becomes a node belongs in this object and in `nodeCeilingOf` in the
   * same change.
   */
  counts: { files: number; edges: number; externals: number; infraNodes: number; envServices: number };
  /** The distinct languages seen. Carried so Tier 6's NEXT run has a baseline. */
  languages: string[];
}

/**
 * Frozen rather than spread at each use site. The four `{ ...ZERO_COUNTS }` copies existed
 * to stop a caller mutating a module-level const; `Object.freeze` states that intent once
 * and makes the mutation a runtime error instead of a silent shared-state bug.
 */
const ZERO_COUNTS: Readonly<CiValidation['counts']> = Object.freeze({
  files: 0,
  edges: 0,
  externals: 0,
  infraNodes: 0,
  envServices: 0,
});

const ok = (
  counts: CiValidation['counts'],
  languages: string[],
  warnings: string[] = [],
): CiValidation => ({ rejection: null, warnings, counts, languages });

const fail = (tier: number, error: string, status = 400, detail?: string): CiValidation => ({
  rejection: { tier, error, status, detail },
  warnings: [],
  counts: ZERO_COUNTS,
  languages: [],
});

// ---------------------------------------------------------------------------
// Tier 3 — path and specifier sanitation
// ---------------------------------------------------------------------------

/**
 * Path segments that pollute a prototype when used as an object key.
 *
 * ⚠ NOT THEORETICAL, AND THE DAMAGE HAPPENS INSIDE OUR OWN PROCESS. A file id
 * becomes a directory-derived MODULE id downstream, and the enrichment layer
 * builds `moduleLabels[moduleId] = { label, summary, kind }` on a plain object.
 * Assigning an OBJECT to a key named `__proto__` does not create a property — it
 * sets the prototype, of that object and of everything inheriting from
 * `Object.prototype` afterwards. A directory named `__proto__/` is a
 * two-character attack.
 *
 * And it is REACHABLE from the wire even though an object literal cannot express
 * it: `JSON.parse('{"__proto__": …}')` creates a genuine OWN property, which
 * `Object.keys` then hands us as an ordinary file id.
 *
 * `constructor` and `prototype` are refused for the same class of reason. No real
 * repository loses anything by being unable to name a directory after one of the
 * three.
 */
const POLLUTING_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Control characters and NUL. Never legitimate in a path or a specifier. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * A repo-relative POSIX file id.
 *
 * Every rule here has a specific consequence if dropped: a leading `/` or a `..`
 * segment is a traversal the container would resolve against its own filesystem;
 * a `\` is a Windows separator that a POSIX consumer reads as a literal
 * character, so the same file could be named twice and appear as two nodes; a
 * NUL truncates in anything that hands the string to a C API; a `//` produces a
 * path that is equal-but-not-identical to another, which breaks the referential
 * check by making `to` unmatchable.
 */
export function isSafeFileId(id: string): { ok: true } | { ok: false; reason: string } {
  if (typeof id !== 'string' || id.length === 0) return { ok: false, reason: 'empty path' };
  if (byteLength(id) > MAX_STRING_BYTES) return { ok: false, reason: 'path too long' };
  if (CONTROL_RE.test(id)) return { ok: false, reason: 'control character in path' };
  if (id.startsWith('/')) return { ok: false, reason: 'absolute path' };
  if (id.includes('\\')) return { ok: false, reason: 'backslash in path' };
  if (/^[A-Za-z]:/.test(id)) return { ok: false, reason: 'drive-letter path' };
  const segments = id.split('/');
  if (segments.length > MAX_PATH_DEPTH) return { ok: false, reason: 'path too deep' };
  for (const seg of segments) {
    if (seg === '') return { ok: false, reason: 'empty path segment' };
    if (seg === '.' || seg === '..') return { ok: false, reason: 'relative path segment' };
    if (POLLUTING_SEGMENTS.has(seg)) return { ok: false, reason: 'prototype-polluting segment' };
  }
  return { ok: true };
}

/**
 * A package specifier, across ten ecosystems.
 *
 * ⚠ WHY THIS IS NOT `isValidPackageName`. That function encodes the **npm**
 * grammar, and it is right to on the path it guards. Applied globally here it
 * would reject `github.com/foo/bar` (Go), `Vendor\Package` (PHP) and
 * `com.acme.orders` (Java) — every one of them legitimate — and a polyglot
 * customer's build would fail with a reason that is simply false. So the npm
 * grammar stays a SIGNAL (see `isKnownEcosystemSpecifier`), and the hard gate is
 * a charset that is wide enough for all ten ecosystems and still leaves no room
 * for an instruction: no whitespace, no quotes, no angle brackets, no newlines.
 */
const SPECIFIER_RE = /^[A-Za-z0-9@._~+\-/:\\]+$/;

export function isSafeSpecifier(spec: string): { ok: true } | { ok: false; reason: string } {
  if (typeof spec !== 'string' || spec.length === 0) return { ok: false, reason: 'empty specifier' };
  if (spec.length > MAX_SPECIFIER_LEN) return { ok: false, reason: 'specifier too long' };
  if (CONTROL_RE.test(spec)) return { ok: false, reason: 'control character in specifier' };
  if (!SPECIFIER_RE.test(spec)) return { ok: false, reason: 'illegal character in specifier' };
  if (spec.includes('..')) return { ok: false, reason: 'traversal in specifier' };
  return { ok: true };
}

/**
 * The basenames `detectWorkspaceLayout` recognises — a LOCAL COPY of
 * `WORKSPACE_MANIFEST_BASENAMES` in `@backthread/extractor`, transcribed for the
 * same `__filename` reason as `isValidFileRecord` above, and held to the published
 * predicate by `worker/test/extractorLockstep.test.ts`.
 *
 * ⚠ THIS IS THE CHECK THAT MAKES THE CONTAINER'S SCRATCH WRITE BOUNDED.
 * `layoutFromManifests` writes every entry to disk. `isSafeFileId` already stops a
 * traversal OUT of the scratch tree; this stops a producer writing an arbitrarily
 * NAMED file INSIDE it. Without it the payload could plant `.npmrc`, `tsconfig.json`,
 * a `.env`, or a file whose name a later stage happens to read — a write primitive
 * bounded only by "nothing reads that yet", which is a property of today's code
 * rather than of the gate.
 *
 * ⚠ NOTE `go.mod` IS ABSENT, AND THAT IS THE PUBLISHED BEHAVIOUR, NOT AN OVERSIGHT.
 * Go module boundaries are not part of workspace-layout detection, so a `go.mod`
 * shipped here is refused. The lockstep test asserts this rather than assuming it.
 */
export const WORKSPACE_MANIFEST_BASENAMES: ReadonlySet<string> = new Set<string>([
  'package.json',
  'pnpm-workspace.yaml',
  'lerna.json',
  'turbo.json',
  'nx.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'mix.exs',
  'pubspec.yaml',
  'melos.yaml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
]);

/** The published `isWorkspaceManifestPath`, transcribed. Basename match, nothing more. */
export function isWorkspaceManifestBasename(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  return WORKSPACE_MANIFEST_BASENAMES.has(base);
}

/**
 * Control characters in manifest TEXT.
 *
 * Deliberately NOT `CONTROL_RE`: a manifest is multi-line text, so tab, newline and
 * carriage return are legitimate and refusing them would refuse every real
 * `package.json`. Everything else in the C0 range is refused — a NUL in particular
 * truncates in anything that hands the string to a C API, and this string is
 * written to a file.
 */
const MANIFEST_CONTROL_RE = /[^\P{Cc}\t\n\r]/u;

/**
 * ⚠ MEMBERSHIP MUST BE AN OWN-PROPERTY TEST, NOT A TRUTHY LOOKUP.
 * The enums above are plain objects, so `INFRA_KINDS['constructor']` is a FUNCTION
 * — truthy — and a payload declaring `kind: 'constructor'` would sail through a
 * naive `if (map[kind])` and then throw out of `parseModuleKind` inside a container
 * we have already paid to boot. `toString`, `valueOf` and `__proto__` are the same
 * hole. This is the same prototype-reachability class as `POLLUTING_SEGMENTS`, one
 * layer along.
 */
function isMember(map: Readonly<Record<string, true>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

/**
 * A reference inside the infra graph — a node id, or an infra edge endpoint.
 *
 * ⚠ ONE PREDICATE FOR TWO SHAPES, BECAUSE THE WIRE CARRIES BOTH. A node id is
 * adapter-namespaced (`cloudflare:worker:api`); an edge endpoint may
 * instead be a repo-relative FILE PATH, because a source-grepping adapter cannot
 * bind its endpoint on its own and `assemble` resolves it through
 * `cluster.fileModuleMap`. Two predicates would mean deciding which one an
 * arbitrary string is before validating it, and getting that wrong is how a check
 * becomes optional.
 *
 * `isSafeFileId` does the real work — and every one of its rules earns its place on
 * this field too, because an infra id becomes a `ModuleId` and then an OBJECT KEY in
 * the enrichment layer's `moduleLabels[…]`. That is the `__proto__` primitive the
 * file-id checks already exist for.
 *
 * TWO ADDITIONS OVER `isSafeFileId`, both stated because they are real:
 *
 *   1. **`:` is a segment separator here too.** `isSafeFileId` splits on `/` alone,
 *      so `cloudflare:__proto__` passes it — the polluting segment is simply not at
 *      a `/` boundary. It is still an object key downstream.
 *   2. **A single-letter first segment is refused**, as a side effect of the
 *      drive-letter rule (`/^[A-Za-z]:/`). No builtin adapter is named with one
 *      letter, so this cannot bite a real payload; it is recorded rather than
 *      discovered later.
 */
export function isSafeInfraRef(ref: string): { ok: true } | { ok: false; reason: string } {
  const base = isSafeFileId(ref);
  if (!base.ok) return base;
  for (const seg of ref.split(':')) {
    if (POLLUTING_SEGMENTS.has(seg)) return { ok: false, reason: 'prototype-polluting segment' };
  }
  return { ok: true };
}

/** Whether a specifier matches the npm grammar. A signal for ops, never a gate. */
export function isKnownEcosystemSpecifier(spec: string): boolean {
  return isValidPackageName(spec);
}

function byteLength(s: string): number {
  // Cheap upper bound is 3× length for BMP, but the payload is already bounded,
  // so measure exactly rather than approximate a security limit.
  return new TextEncoder().encode(s).length;
}

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

const ALLOWED_INFRA_KEYS: ReadonlySet<string> = new Set(['nodes', 'edges', 'classificationsNeeded']);
const ALLOWED_INFRA_NODE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'label',
  'kind',
  'provenance',
  'metadata',
  'sourceRoots',
]);
// ⚠ NO `metadata` (found in review). Infra EDGE metadata has no reader anywhere in
// the pipeline — `Edge` has no field for it — so it carried binding names and config
// paths across a trust boundary for no purpose. The key is refused, not ignored.
const ALLOWED_INFRA_EDGE_KEYS: ReadonlySet<string> = new Set(['source', 'target', 'kind']);
const ALLOWED_CLASSIFICATION_KEYS: ReadonlySet<string> = new Set([
  'provider',
  'resourceType',
  'forNodeId',
]);

/**
 * The node's `metadata`, which is `{ type }` OR NOTHING.
 *
 * ⚠ THIS REPLACED A "VALIDATE THE MEASURED SHAPE" CHECK, AND THE DIFFERENCE IS THE
 * WHOLE POINT (found in review). The first cut admitted the shape the adapters
 * measurably emit — strings, finite numbers, booleans, string arrays — a correct
 * description of a field that should not have been crossing at all. It carried a
 * Cloudflare ACCOUNT ID (`metadata.image` = `registry.cloudflare.com/a1b2c3d4e5f6…/…`,
 * lifted out of our own `wrangler.jsonc`), a GCP project id, an ECR host containing an
 * AWS account id, Railway's literal `${{Postgres.DATABASE_URL}}` credential reference,
 * and 50 table names read out of migration SQL — every one of which the server then
 * DISCARDED, because `metadata.type` is the only key anything downstream reads
 * (`assemble.ts` → `infraSummary`) and `Module` has no metadata field at all.
 *
 * Validating a field carefully is not the same as needing it. The boundary argument
 * for this whole endpoint is that config files carry account identifiers and
 * credential references; shipping them in the DERIVED graph falsified it.
 *
 * So the allowlist is one key. A future adapter that invents another cannot silently
 * start sending it: `unknown_field` fails the customer's build, loudly, on their
 * runner. That is "reject, don't truncate" pointed at the boundary rather than at the
 * graph — and it subsumes the old prototype-key blocklist, which a verifier had
 * already got past with `toString`, `valueOf` and `__defineGetter__`.
 */
function badMetadata(v: unknown, where: string): CiRejection | null {
  if (v === undefined) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { tier: 2, error: 'invalid_infra_metadata', status: 400, detail: `${where}: not an object` };
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k !== 'type') {
      // `unknown_field` rather than a category, so the refusal names WHICH key — a
      // workflow author whose extractor version added one needs the name.
      return { tier: 2, error: 'unknown_field', status: 400, detail: `${where}.metadata.${truncate(k)}` };
    }
    if (typeof val !== 'string') {
      return {
        tier: 2,
        error: 'invalid_infra_metadata',
        status: 400,
        detail: `${where}.metadata.type: ${typeof val}`,
      };
    }
    // Bounded and control-free HERE, not by `boundedStrings` — this function is
    // exported so the RUNNER runs the ingress's own check, and standalone nothing has
    // walked the payload. `type` is appended to a rendered summary.
    if (byteLength(val) > MAX_STRING_BYTES) {
      return {
        tier: 1,
        error: 'infra_string_too_long',
        status: 413,
        detail: `${where}.metadata.type > ${MAX_STRING_BYTES}`,
      };
    }
    if (CONTROL_RE.test(val)) {
      return {
        tier: 3,
        error: 'unsafe_infra_metadata_key',
        status: 400,
        detail: `${where}.metadata.type: control character`,
      };
    }
  }
  return null;
}

/**
 * The grammar an env-derived service name may take — and it is EXACT, not generous.
 *
 * ⚠ THE PRODUCER CANNOT EMIT ANYTHING ELSE, SO NOTHING ELSE IS ADMITTED.
 * `parseEnvServiceCandidates` accepts a key matching `^[A-Z][A-Z0-9_]*$`, takes the
 * segment before the first `_`, and lowercases it — so a name outside this grammar
 * did not come from the scan this field claims to report.
 *
 * ⚠ IT IS A STRICT SUPERSET OF THE PRODUCER'S IMAGE, NOT THE IMAGE ITSELF, and the
 * difference is deliberate rather than sloppy (an earlier draft of this comment
 * claimed the image, and the paragraph below already contradicted it). The scan also
 * requires three or more characters and rejects a `GENERIC_PREFIXES` member. Both of
 * those are TUNING constants in a heuristic; coupling the ingress to them would break
 * every runner the day either moved, for no security gain. The CHARACTER CLASS is the
 * security property, and it is exact.
 *
 * ⚠ AND THIS IS WHY THERE IS NO `looksLikeInjection` CALL BESIDE IT. The name is
 * routed through the shared external classifier — an LLM PROMPT — by
 * `classifyEnvVarPatterns`. A prose detector is a heuristic over free text; this
 * grammar admits no whitespace, no punctuation, no control characters and no
 * non-ASCII, which is a stronger guard than the heuristic and one the honest producer
 * always satisfies. It is NOT a claim that nothing hostile can be spelled in it:
 * 500 x 64 bytes of run-together lowercase is still producer-chosen text reaching a
 * prompt, and it tokenises. What bounds the residue is downstream and worth naming —
 * `classifyGraphExternals` re-gates every name through `isValidPackageName` before any
 * classifier call, and `externals.ts` already treats package names as untrusted
 * because it has been fed hostile ones from npm since those production crashes.
 *
 * The length floor is deliberately LOOSER than the producer's (which requires 3+
 * characters): the character class is the security property and the length is a
 * bound, so coupling the ingress to a tuning constant in a heuristic would break the
 * runner the day someone lowered it, for no gain.
 */
const ENV_SERVICE_RE = /^[a-z][a-z0-9]*$/;

/**
 * The derived env-service names, as untrusted input.
 *
 * ⚠ EXPORTED SO THE RUNNER RUNS THE INGRESS'S OWN CHECK, exactly as
 * `validateInfraGraph` is. A runner cap looser than the ingress's spends the
 * customer's CI minutes and then refuses; a tighter one refuses payloads we would
 * have accepted. Both drifts are silent, and both are one function away.
 *
 * ⚠ ABSENCE IS A REFUSAL, NOT AN EMPTY LIST. `[]` says "I scanned the four example
 * env filenames and there is nothing to report"; an absent field says nobody
 * scanned. Env-derived services become `nodes` in `assemble`, and `topologyHash` is
 * the sorted module ids — so the two claims persist DIFFERENT artefacts while
 * looking identical at the ingress.
 */
export function validateEnvServices(value: unknown): CiRejection | null {
  if (value === undefined) {
    return {
      tier: 2,
      error: 'missing_env_services',
      status: 400,
      detail:
        'payload v3 must carry `envServices`; an empty [] states "this repo has no example env ' +
        'file", while an absent field would render a snapshot whose env-derived service nodes ' +
        'are silently missing',
    };
  }
  if (!Array.isArray(value)) {
    return { tier: 2, error: 'invalid_env_services', status: 400, detail: 'not an array' };
  }
  if (value.length > MAX_ENV_SERVICES) {
    return {
      tier: 1,
      error: 'too_many_env_services',
      status: 413,
      detail: `${value.length} > ${MAX_ENV_SERVICES}`,
    };
  }
  const seen = new Set<string>();
  for (const raw of value as unknown[]) {
    if (typeof raw !== 'string') {
      return {
        tier: 2,
        error: 'invalid_env_services',
        status: 400,
        detail: `entry is ${raw === null ? 'null' : typeof raw}`,
      };
    }
    // Bounded HERE and not left to `boundedStrings`: this function is exported and
    // runs STANDALONE on the runner, where nothing has walked the payload. The same
    // omission admitted a 400 KB infra label once.
    if (byteLength(raw) > MAX_ENV_SERVICE_BYTES) {
      return {
        tier: 1,
        error: 'env_service_too_long',
        status: 413,
        detail: `${truncate(raw)} > ${MAX_ENV_SERVICE_BYTES}`,
      };
    }
    if (!ENV_SERVICE_RE.test(raw)) {
      return {
        tier: 3,
        error: 'unsafe_env_service',
        status: 400,
        detail: `${truncate(raw)}: not ${ENV_SERVICE_RE.source}`,
      };
    }
    // Two entries for one service let the producer inflate the list past nothing in
    // particular, and `classifyEnvVarPatterns` would price the same name twice
    // before the display-name dedupe collapsed them. No honest scan emits a
    // duplicate: `extractEnvServiceCandidates` merges by service into a Map.
    if (seen.has(raw)) {
      return { tier: 2, error: 'duplicate_env_service', status: 400, detail: truncate(raw) };
    }
    seen.add(raw);
  }
  return null;
}

const ALLOWED_FRAMEWORK_KEYS: ReadonlySet<string> = new Set([
  'adapters',
  'edges',
  'crossLanguageEdges',
  'roles',
  'groups',
]);
// ⚠ NO `metadata` ON EITHER. `FrameworkEdge` and `RoleTag` both carry an
// open `Record<string, unknown>` in the published types and NOTHING downstream reads
// either — `assemble` takes `{source,target,kind}` from an edge and `{role}` from a
// tag. The raw wire types simply do not have the field, and the ingress refuses the
// key, so a future adapter that starts populating one cannot start sending it.
const ALLOWED_FRAMEWORK_EDGE_KEYS: ReadonlySet<string> = new Set([
  'adapter',
  'source',
  'target',
  'kind',
]);
const ALLOWED_FRAMEWORK_ROLE_KEYS: ReadonlySet<string> = new Set([
  'adapter',
  'id',
  'role',
  'kind',
  'priority',
]);
const ALLOWED_FRAMEWORK_GROUP_KEYS: ReadonlySet<string> = new Set([
  'adapter',
  'id',
  'label',
  'fileIds',
]);

/**
 * A short adapter-authored identifier — an adapter name (`react-native`,
 * `python-orm`), a group id, a role name.
 *
 * ⚠ `isSafeInfraRef`, NOT A NEW PREDICATE. A group id is namespaced into
 * `<adapter>:<id>` and written onto `ClusteredModule.packageId`, which
 * `computeSubsystems` turns into a `Subsystem.id` — an OBJECT KEY and a rendered
 * identifier, which is exactly the shape `isSafeInfraRef` already exists for,
 * `:`-segment pollution rule and all. A second predicate here would be a second
 * definition of "safe identifier" to keep in sync with that one.
 */
function badFrameworkIdent(
  v: unknown,
  where: string,
  error: string,
): CiRejection | null {
  if (typeof v !== 'string' || v.length === 0) {
    return { tier: 2, error, status: 400, detail: `${where}: not a non-empty string` };
  }
  // Bounded HERE and not left to `boundedStrings`: this function is exported through
  // `validateFrameworkContributions` and runs STANDALONE on the runner, where nothing
  // has walked the payload. The same omission admitted a 400 000-byte infra label.
  if (byteLength(v) > MAX_STRING_BYTES) {
    return { tier: 1, error: 'framework_string_too_long', status: 413, detail: `${where} > ${MAX_STRING_BYTES}` };
  }
  const safe = isSafeInfraRef(v);
  if (!safe.ok) return { tier: 3, error, status: 400, detail: `${truncate(v)}: ${safe.reason}` };
  if (looksLikeInjectionInPath(v)) {
    return { tier: 4, error: 'injection_shaped_framework_ref', status: 400, detail: truncate(v) };
  }
  return null;
}

/**
 * A repo-relative FILE id an adapter named — an edge endpoint, a role's subject, a
 * group member.
 *
 * ⚠ MEMBERSHIP IN `state.files` IS **NOT** REQUIRED, AND THAT IS A DECISION.
 * An adapter may legitimately name a file the graph extractor never indexed — a
 * `.graphql` schema, a route manifest, a generated file the noise filter dropped —
 * and `applyFrameworkContributions` already DROPS an endpoint it cannot resolve
 * against the cluster. Refusing here would reject honest payloads to prevent an
 * outcome that is already a no-op, which is the opposite trade from the infra
 * `classificationsNeeded` check (that one names a node in its OWN graph, so it can
 * be checked without guessing).
 */
function badFrameworkFileId(v: unknown, where: string, error: string): CiRejection | null {
  if (typeof v !== 'string') {
    return { tier: 2, error, status: 400, detail: `${where}: not a string` };
  }
  if (byteLength(v) > MAX_STRING_BYTES) {
    return { tier: 1, error: 'framework_string_too_long', status: 413, detail: `${where} > ${MAX_STRING_BYTES}` };
  }
  const safe = isSafeFileId(v);
  if (!safe.ok) return { tier: 3, error, status: 400, detail: `${truncate(v)}: ${safe.reason}` };
  if (looksLikeInjectionInPath(v)) {
    return { tier: 4, error: 'injection_shaped_framework_ref', status: 400, detail: truncate(v) };
  }
  return null;
}

/**
 * The raw framework contributions, as untrusted input.
 *
 * ⚠ EXPORTED SO THE RUNNER RUNS THE INGRESS'S OWN CHECK, exactly as
 * `validateInfraGraph` and `validateEnvServices` are. One function, two call sites:
 * a runner cap looser than the ingress's spends the customer's CI minutes and then
 * refuses, a tighter one refuses payloads we would have accepted, and both drifts
 * are silent.
 *
 * ⚠ THE 8-VERB CHECK RUNS HERE **AND** IN THE PACKAGE, AND THAT IS NOT DUPLICATION.
 * `applyFrameworkContributions` calls `parseEdgeKind` because the raw value may have
 * been produced on a machine it does not own — it DROPS a bad verb and logs. This
 * gate REFUSES the payload instead, because at the ingress a bad verb is a producer
 * that does not agree with us about the taxonomy, and silently rendering the rest of
 * its graph is truncation. Two layers, two correct answers.
 */
export function validateFrameworkContributions(value: unknown): CiRejection | null {
  if (value === undefined) {
    return {
      tier: 2,
      error: 'missing_framework',
      status: 400,
      detail:
        'payload v4 must carry `framework`; an empty {adapters:0,edges:[],crossLanguageEdges:[],' +
        'roles:[],groups:[]} states "this repo trips no adapter", while an absent field would ' +
        'render a snapshot whose framework edges are silently missing',
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { tier: 2, error: 'invalid_framework', status: 400, detail: 'not an object' };
  }
  const bad = unknownKeyIn(value, ALLOWED_FRAMEWORK_KEYS, 'framework');
  if (bad) return { tier: 2, error: 'unknown_field', status: 400, detail: bad };

  const f = value as Record<string, unknown>;
  for (const k of ['edges', 'crossLanguageEdges', 'roles', 'groups']) {
    if (!Array.isArray(f[k])) {
      return { tier: 2, error: 'invalid_framework', status: 400, detail: `${k} is not an array` };
    }
  }
  if (!Number.isInteger(f.adapters) || (f.adapters as number) < 0) {
    return {
      tier: 2,
      error: 'invalid_framework',
      status: 400,
      detail: `adapters is ${String(f.adapters)}`,
    };
  }
  if ((f.adapters as number) > MAX_FRAMEWORK_ADAPTERS) {
    return {
      tier: 1,
      error: 'too_many_framework_adapters',
      status: 413,
      detail: `${String(f.adapters)} > ${MAX_FRAMEWORK_ADAPTERS}`,
    };
  }

  // ⚠ DEPTH BEFORE BYTES, because the byte measurement IS the crash — `JSON.stringify`
  // recurses, and a 316-byte gzipped body of nested arrays once turned this shape of
  // check into a 500 plus a P2 alert. `boundedStrings` catches it on the payload path;
  // this function also runs STANDALONE on the runner, where nothing has walked it.
  if (exceedsDepth(value, MAX_JSON_DEPTH)) {
    return { tier: 1, error: 'framework_too_deep', status: 413, detail: `nested deeper than ${MAX_JSON_DEPTH}` };
  }
  const bytes = byteLength(JSON.stringify(value));
  if (bytes > MAX_TOTAL_FRAMEWORK_BYTES) {
    return {
      tier: 1,
      error: 'framework_too_large',
      status: 413,
      detail: `${bytes} > ${MAX_TOTAL_FRAMEWORK_BYTES} bytes of framework contributions`,
    };
  }

  const edges = f.edges as unknown[];
  const xlang = f.crossLanguageEdges as unknown[];
  const roles = f.roles as unknown[];
  const groups = f.groups as unknown[];

  // ⚠ THE TWO EDGE LISTS ARE COUNTED TOGETHER. They are concatenated by the consumer
  // and both land in the same rendered edge set, so capping them separately would
  // admit twice the stated ceiling through the field nobody was watching.
  if (edges.length + xlang.length > MAX_FRAMEWORK_EDGES) {
    return {
      tier: 1,
      error: 'too_many_framework_edges',
      status: 413,
      detail: `${edges.length + xlang.length} > ${MAX_FRAMEWORK_EDGES}`,
    };
  }
  if (roles.length > MAX_FRAMEWORK_ROLES) {
    return { tier: 1, error: 'too_many_framework_roles', status: 413, detail: `${roles.length} > ${MAX_FRAMEWORK_ROLES}` };
  }
  if (groups.length > MAX_FRAMEWORK_GROUPS) {
    return { tier: 1, error: 'too_many_framework_groups', status: 413, detail: `${groups.length} > ${MAX_FRAMEWORK_GROUPS}` };
  }

  for (const [list, where] of [
    [edges, 'framework.edge'],
    [xlang, 'framework.crossLanguageEdge'],
  ] as Array<[unknown[], string]>) {
    for (const raw of list) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { tier: 2, error: 'invalid_framework_edge', status: 400, detail: `${where}: not an object` };
      }
      const e = raw as Record<string, unknown>;
      const badKey = unknownKeyIn(e, ALLOWED_FRAMEWORK_EDGE_KEYS, where);
      if (badKey) return { tier: 2, error: 'unknown_field', status: 400, detail: badKey };
      const badAdapter = badFrameworkIdent(e.adapter, `${where}.adapter`, 'invalid_framework_edge');
      if (badAdapter) return badAdapter;
      for (const k of ['source', 'target'] as const) {
        const badRef = badFrameworkFileId(e[k], `${where}.${k}`, 'unsafe_framework_ref');
        if (badRef) return badRef;
      }
      // The 8-verb taxonomy is locked, and `isMember` is an OWN-property test: the
      // enums are plain objects, so `MAP['constructor']` is a truthy FUNCTION and a
      // naive lookup would admit `kind: 'constructor'`.
      if (typeof e.kind !== 'string' || !isMember(INFRA_EDGE_KINDS, e.kind)) {
        return {
          tier: 2,
          error: 'invalid_framework_edge_kind',
          status: 400,
          detail: `${where}: ${truncate(String(e.kind))}`,
        };
      }
    }
  }

  for (const raw of roles) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { tier: 2, error: 'invalid_framework_role', status: 400, detail: 'entry is not an object' };
    }
    const r = raw as Record<string, unknown>;
    const badKey = unknownKeyIn(r, ALLOWED_FRAMEWORK_ROLE_KEYS, 'framework.role');
    if (badKey) return { tier: 2, error: 'unknown_field', status: 400, detail: badKey };
    const badAdapter = badFrameworkIdent(r.adapter, 'framework.role.adapter', 'invalid_framework_role');
    if (badAdapter) return badAdapter;
    const badId = badFrameworkFileId(r.id, 'framework.role.id', 'unsafe_framework_ref');
    if (badId) return badId;
    // `role` reaches `Module.role` and the rendered card, so it takes the identifier
    // rules rather than the prose ones — it is a short tag (`screen`, `route-handler`),
    // never a sentence.
    const badRole = badFrameworkIdent(r.role, 'framework.role.role', 'invalid_framework_role');
    if (badRole) return badRole;
    if (typeof r.kind !== 'string' || !isMember(ROLE_MODULE_KINDS, r.kind)) {
      return {
        tier: 2,
        error: 'invalid_framework_role_kind',
        status: 400,
        detail: truncate(String(r.kind)),
      };
    }
    if (r.priority !== undefined && !Number.isFinite(r.priority)) {
      return {
        tier: 2,
        error: 'invalid_framework_role',
        status: 400,
        detail: `priority is ${String(r.priority)}`,
      };
    }
  }

  let groupFiles = 0;
  for (const raw of groups) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { tier: 2, error: 'invalid_framework_group', status: 400, detail: 'entry is not an object' };
    }
    const g = raw as Record<string, unknown>;
    const badKey = unknownKeyIn(g, ALLOWED_FRAMEWORK_GROUP_KEYS, 'framework.group');
    if (badKey) return { tier: 2, error: 'unknown_field', status: 400, detail: badKey };
    const badAdapter = badFrameworkIdent(g.adapter, 'framework.group.adapter', 'invalid_framework_group');
    if (badAdapter) return badAdapter;
    const badId = badFrameworkIdent(g.id, 'framework.group.id', 'invalid_framework_group');
    if (badId) return badId;
    if (typeof g.label !== 'string' || g.label.length === 0) {
      return { tier: 2, error: 'invalid_framework_group', status: 400, detail: 'label' };
    }
    if (byteLength(g.label) > MAX_STRING_BYTES) {
      return { tier: 1, error: 'framework_string_too_long', status: 413, detail: `group label > ${MAX_STRING_BYTES}` };
    }
    if (CONTROL_RE.test(g.label)) {
      return { tier: 3, error: 'unsafe_framework_label', status: 400, detail: 'control character in label' };
    }
    // ⚠ THE PROSE DETECTOR HERE, THE PATH ONE ABOVE — the same split the infra tier
    // makes. A group label becomes a rendered SUBSYSTEM NAME, which is display prose;
    // an adapter name or a file path is an identifier and a whitespace-anchored
    // detector would be the wrong shape for it.
    if (looksLikeInjection(g.label)) {
      return { tier: 4, error: 'injection_shaped_framework_label', status: 400, detail: truncate(g.label) };
    }
    if (!Array.isArray(g.fileIds)) {
      return { tier: 2, error: 'invalid_framework_group', status: 400, detail: 'fileIds is not an array' };
    }
    groupFiles += g.fileIds.length;
    // Checked INSIDE the loop, so a single absurd group is refused before the walk
    // pays for it — the bulk risk in this field is one group naming every file.
    if (groupFiles > MAX_FRAMEWORK_GROUP_FILES) {
      return {
        tier: 1,
        error: 'too_many_framework_group_files',
        status: 413,
        detail: `${groupFiles} > ${MAX_FRAMEWORK_GROUP_FILES}`,
      };
    }
    for (const fid of g.fileIds as unknown[]) {
      const badFid = badFrameworkFileId(fid, 'framework.group.fileIds[]', 'unsafe_framework_ref');
      if (badFid) return badFid;
    }
  }

  return null;
}

/**
 * The derived deployment graph, as untrusted input.
 *
 * ⚠ EXPORTED SO THE RUNNER RUNS THE INGRESS'S OWN CHECK, NOT A SECOND OPINION.
 * `scripts/ci-action/extract-and-post.ts` calls this before it posts, exactly as it
 * already imports the manifest byte caps rather than transcribing them: a runner cap
 * that is looser than the ingress's produces a late refusal after the customer has
 * already spent their CI minutes, and a runner cap that is TIGHTER refuses payloads
 * we would have accepted. Both drifts are silent. One function, two call sites.
 *
 * ⚠ WHAT CANNOT BE CHECKED HERE, SAID PLAINLY. An edge endpoint may legitimately be
 * a repo-relative file path rather than an infra node id (a source-grepping adapter
 * cannot bind its own endpoint), so referential integrity is NOT enforceable the way
 * it is for `state.files` — `assemble` resolves what it can and drops the rest, and
 * a drop there is a missing arrow, not a phantom node. `classificationsNeeded`,
 * which DOES name a node in this same graph, is checked.
 */
export function validateInfraGraph(
  value: unknown,
  /**
   * The payload's FILE ids, when the caller has them (added in review).
   *
   * ⚠ AN INFRA NODE ID THAT IS A FILE PATH MAKES EDGE-ENDPOINT RESOLUTION AMBIGUOUS.
   * `assemble`'s infra-edge resolver tries `infraIds` first, then `cluster.fileModuleMap`
   * — so an infra node named `src/a.ts` shadows that file's own module for every edge
   * that names it, and the reader gets arrows pointing at the wrong box.
   *
   * ⚠ AND THE FIRST VERSION OF THIS COMMENT NAMED THE WRONG HAZARD, WHICH A VERIFIER
   * MEASURED. It said "an infra id and a file id both become a `ModuleId`, so a collision
   * puts two Modules in the snapshot under one id". Cluster module ids are SLUGIFIED
   * (`[^a-z0-9]+` → `-`), so a file id containing `/` or `.` can never equal one — and
   * the ids that CAN collide with a module (`src`, `worker`, `scripts-5`) are admitted by
   * this check, correctly, because they are not file ids. `assertAssembledGraph` catches a
   * genuine duplicate anyway, but only AFTER `enrich` has spent money, which is why the
   * ambiguity is worth refusing at the ingress even though it corrupts nothing.
   *
   * Optional because the RUNNER calls this before it has anything to compare against,
   * and a check that cannot run there must not become a check that does not run here.
   */
  fileIds?: ReadonlySet<string>,
): CiRejection | null {
  if (value === undefined) {
    return {
      tier: 2,
      error: 'missing_infra',
      status: 400,
      detail:
        'payload v2 must carry `infra`; an empty {nodes:[],edges:[]} states "this repo has none", ' +
        'while an absent field would render a snapshot with the deployment layer silently missing',
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { tier: 2, error: 'invalid_infra', status: 400, detail: 'not an object' };
  }
  const bad = unknownKeyIn(value, ALLOWED_INFRA_KEYS, 'infra');
  if (bad) return { tier: 2, error: 'unknown_field', status: 400, detail: bad };

  const g = value as { nodes?: unknown; edges?: unknown; classificationsNeeded?: unknown };
  if (!Array.isArray(g.nodes)) {
    return { tier: 2, error: 'invalid_infra', status: 400, detail: 'nodes is not an array' };
  }
  if (!Array.isArray(g.edges)) {
    return { tier: 2, error: 'invalid_infra', status: 400, detail: 'edges is not an array' };
  }
  if (g.classificationsNeeded !== undefined && !Array.isArray(g.classificationsNeeded)) {
    return {
      tier: 2,
      error: 'invalid_infra',
      status: 400,
      detail: 'classificationsNeeded is not an array',
    };
  }

  // ⚠ DEPTH BEFORE BYTES, BECAUSE THE BYTE MEASUREMENT IS THE CRASH. `JSON.stringify`
  // recurses, so a 316-byte gzipped body of nested arrays threw `RangeError` on the
  // very next line and the ingress answered 500 with a P2 alert. `boundedStrings`
  // already catches it on the payload path; this function also runs STANDALONE on the
  // customer's runner, where nothing has walked the value yet.
  if (exceedsDepth(value, MAX_JSON_DEPTH)) {
    return {
      tier: 1,
      error: 'infra_too_deep',
      status: 413,
      detail: `nested deeper than ${MAX_JSON_DEPTH}`,
    };
  }
  // The bound that actually binds — see `MAX_TOTAL_INFRA_BYTES`. Measured BEFORE the
  // per-entry walk so a 512 KiB-plus graph costs one serialisation rather than a
  // full traversal, and against the same JSON the container will read back out of R2.
  const bytes = byteLength(JSON.stringify(value));
  if (bytes > MAX_TOTAL_INFRA_BYTES) {
    return {
      tier: 1,
      error: 'infra_too_large',
      status: 413,
      detail: `${bytes} > ${MAX_TOTAL_INFRA_BYTES} bytes of derived infra graph`,
    };
  }
  if (g.nodes.length > MAX_INFRA_NODES) {
    return {
      tier: 1,
      error: 'too_many_infra_nodes',
      status: 413,
      detail: `${g.nodes.length} > ${MAX_INFRA_NODES}`,
    };
  }
  if (g.edges.length > MAX_INFRA_EDGES) {
    return {
      tier: 1,
      error: 'too_many_infra_edges',
      status: 413,
      detail: `${g.edges.length} > ${MAX_INFRA_EDGES}`,
    };
  }

  const nodeIds = new Set<string>();
  for (const raw of g.nodes as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { tier: 2, error: 'invalid_infra_node', status: 400, detail: 'entry is not an object' };
    }
    const n = raw as Record<string, unknown>;
    const badKey = unknownKeyIn(n, ALLOWED_INFRA_NODE_KEYS, 'infra.node');
    if (badKey) return { tier: 2, error: 'unknown_field', status: 400, detail: badKey };

    if (typeof n.id !== 'string') {
      return { tier: 2, error: 'invalid_infra_node', status: 400, detail: 'id is not a string' };
    }
    const safeId = isSafeInfraRef(n.id);
    if (!safeId.ok) {
      return {
        tier: 3,
        error: 'unsafe_infra_id',
        status: 400,
        detail: `${truncate(n.id)}: ${safeId.reason}`,
      };
    }
    if (looksLikeInjectionInPath(n.id)) {
      return { tier: 4, error: 'injection_shaped_infra_id', status: 400, detail: truncate(n.id) };
    }
    // Two nodes for one id let the producer decide by ORDER which one `assemble`
    // renders, and hide the loser from anyone reading the payload — the same reason
    // a duplicate workspace-manifest path is refused. It would also put two Modules
    // with one `ModuleId` into the snapshot.
    if (nodeIds.has(n.id)) {
      return { tier: 2, error: 'duplicate_infra_node', status: 400, detail: truncate(n.id) };
    }
    // ...and across the OTHER namespace too. An infra id and a file id both become a
    // `ModuleId`, so a collision puts two Modules in the snapshot under one id.
    if (fileIds?.has(n.id)) {
      return { tier: 2, error: 'infra_id_collides_with_file', status: 400, detail: truncate(n.id) };
    }
    nodeIds.add(n.id);

    if (typeof n.label !== 'string' || n.label.length === 0) {
      return { tier: 2, error: 'invalid_infra_node', status: 400, detail: `${truncate(n.id)}: label` };
    }
    // The byte cap, applied HERE and not left to `boundedStrings` — see the note in
    // `badMetadata`. Standalone, a 400 000-byte label was admitted.
    if (byteLength(n.label) > MAX_STRING_BYTES) {
      return {
        tier: 1,
        error: 'infra_string_too_long',
        status: 413,
        detail: `${truncate(n.id)}: label > ${MAX_STRING_BYTES}`,
      };
    }
    if (CONTROL_RE.test(n.label)) {
      return {
        tier: 3,
        error: 'unsafe_infra_label',
        status: 400,
        detail: `${truncate(n.id)}: control character in label`,
      };
    }
    // ⚠ THE PROSE DETECTOR, NOT THE PATH ONE, AND IT IS STRICTER THAN THE CLONE
    // PATH ON PURPOSE. A label is display prose that reaches the rendered snapshot
    // and the enrichment prompt, so the whitespace-anchored `looksLikeInjection` is
    // the right shape here where `looksLikeInjectionInPath` is right for an id. The
    // clone path would render such a label (it came from the customer's own
    // `wrangler.toml` and nobody crossed a trust boundary); the wire is a boundary,
    // and refusing is what "reject, don't truncate" means when sanitising would
    // silently make the two paths disagree about the same node's name.
    if (looksLikeInjection(n.label)) {
      return { tier: 4, error: 'injection_shaped_infra_label', status: 400, detail: truncate(n.label) };
    }
    if (typeof n.kind !== 'string' || !isMember(INFRA_KINDS, n.kind)) {
      return {
        tier: 2,
        error: 'unknown_infra_kind',
        status: 400,
        detail: `${truncate(n.id)}: ${truncate(String(n.kind))}`,
      };
    }
    if (typeof n.provenance !== 'string' || !isMember(NODE_PROVENANCES, n.provenance)) {
      return {
        tier: 2,
        error: 'unknown_infra_provenance',
        status: 400,
        detail: `${truncate(n.id)}: ${truncate(String(n.provenance))}`,
      };
    }
    if (n.sourceRoots !== undefined) {
      if (!Array.isArray(n.sourceRoots)) {
        return {
          tier: 2,
          error: 'invalid_infra_node',
          status: 400,
          detail: `${truncate(n.id)}: sourceRoots is not an array`,
        };
      }
      if (n.sourceRoots.length > MAX_INFRA_SOURCE_ROOTS) {
        return {
          tier: 1,
          error: 'too_many_infra_source_roots',
          status: 413,
          detail: `${truncate(n.id)}: ${n.sourceRoots.length} > ${MAX_INFRA_SOURCE_ROOTS}`,
        };
      }
      for (const r of n.sourceRoots as unknown[]) {
        // A sourceRoot is a repo-relative DIRECTORY prefix that `zones.ts` matches
        // file paths against. `..` in it would attribute files outside the repo;
        // it never reaches `fs`, but it does reach a prefix comparison.
        if (typeof r !== 'string') {
          return {
            tier: 2,
            error: 'invalid_infra_node',
            status: 400,
            detail: `${truncate(n.id)}: sourceRoot is not a string`,
          };
        }
        const safeRoot = isSafeFileId(r);
        if (!safeRoot.ok) {
          return {
            tier: 3,
            error: 'unsafe_infra_source_root',
            status: 400,
            detail: `${truncate(r)}: ${safeRoot.reason}`,
          };
        }
        if (looksLikeInjectionInPath(r)) {
          return { tier: 4, error: 'injection_shaped_path', status: 400, detail: truncate(r) };
        }
      }
    }
    const badMeta = badMetadata(n.metadata, `infra.node ${truncate(n.id)}`);
    if (badMeta) return badMeta;
  }

  for (const raw of g.edges as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { tier: 2, error: 'invalid_infra_edge', status: 400, detail: 'entry is not an object' };
    }
    const e = raw as Record<string, unknown>;
    const badKey = unknownKeyIn(e, ALLOWED_INFRA_EDGE_KEYS, 'infra.edge');
    if (badKey) return { tier: 2, error: 'unknown_field', status: 400, detail: badKey };
    for (const end of ['source', 'target'] as const) {
      const ep = e[end];
      if (typeof ep !== 'string') {
        return { tier: 2, error: 'invalid_infra_edge', status: 400, detail: `${end} is not a string` };
      }
      const safeEp = isSafeInfraRef(ep);
      if (!safeEp.ok) {
        return {
          tier: 3,
          error: 'unsafe_infra_endpoint',
          status: 400,
          detail: `${truncate(ep)}: ${safeEp.reason}`,
        };
      }
      if (looksLikeInjectionInPath(ep)) {
        return { tier: 4, error: 'injection_shaped_infra_id', status: 400, detail: truncate(ep) };
      }
    }
    if (typeof e.kind !== 'string' || !isMember(INFRA_EDGE_KINDS, e.kind)) {
      // The locked 8-verb taxonomy. A substrate label (`imports`/`depends-on`/
      // `uses`) is refused here rather than thrown out of `parseEdgeKind` inside a
      // container we already paid to boot — and the enum is never widened to admit
      // one, which is the standing rule.
      return {
        tier: 2,
        error: 'unknown_infra_edge_kind',
        status: 400,
        detail: truncate(String(e.kind)),
      };
    }
  }

  // ⚠ THE COST CAP, AND IT IS ITS OWN BOUND FOR A REASON (found in review). This is
  // the only field here that turns directly into LLM calls, and
  // `applyResourceClassifications` dedupes by `(provider, resourceType)` — so every
  // DISTINCT pair survives into one classifier call. Left to the byte budget alone,
  // ~7 000 of them were admitted. Stated rather than implied.
  const classifications = (g.classificationsNeeded ?? []) as unknown[];
  if (classifications.length > MAX_INFRA_CLASSIFICATIONS) {
    return {
      tier: 1,
      error: 'too_many_infra_classifications',
      status: 413,
      detail: `${classifications.length} > ${MAX_INFRA_CLASSIFICATIONS}`,
    };
  }
  for (const raw of classifications) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { tier: 2, error: 'invalid_infra_classification', status: 400, detail: 'not an object' };
    }
    const c = raw as Record<string, unknown>;
    const badKey = unknownKeyIn(c, ALLOWED_CLASSIFICATION_KEYS, 'infra.classification');
    if (badKey) return { tier: 2, error: 'unknown_field', status: 400, detail: badKey };
    for (const field of ['provider', 'resourceType'] as const) {
      const v = c[field];
      // `MAX_SPECIFIER_LEN` rather than `MAX_STRING_BYTES`: these two are a resource
      // TYPE and a provider name, the same category of identifier the specifier cap
      // was sized for, and they become a classifier cache key.
      if (
        typeof v !== 'string' ||
        v.length === 0 ||
        v.length > MAX_SPECIFIER_LEN ||
        CONTROL_RE.test(v)
      ) {
        return {
          tier: 3,
          error: 'invalid_infra_classification',
          status: 400,
          detail: `${field}: ${truncate(String(v))}`,
        };
      }
      // These two reach the resource-type classifier's PROMPT and its cache key.
      if (looksLikeInjection(v)) {
        return {
          tier: 4,
          error: 'injection_shaped_infra_classification',
          status: 400,
          detail: truncate(v),
        };
      }
    }
    // Referential integrity, the one place it IS enforceable in this graph: a
    // classification names a node of this same payload. A dangling `forNodeId` is a
    // classifier call we pay for whose answer can never be applied.
    if (typeof c.forNodeId !== 'string' || !nodeIds.has(c.forNodeId)) {
      return {
        tier: 2,
        error: 'dangling_infra_classification',
        status: 400,
        detail: truncate(String(c.forNodeId)),
      };
    }
  }

  return null;
}

export interface PriorCiFacts {
  files: number;
  edges: number;
  languages: string[];
}

/**
 * Validate one untrusted payload. Pure — no I/O, no clock, no network — so every
 * tier is testable against a fixture and, more to the point, MUTATION-testable:
 * delete a check, watch a named test go red. A gate that cannot fail proves
 * nothing, and this repo found seven such guards in one week.
 *
 * `identity` carries what the signed OIDC claim resolved to. Tier 0 (signature,
 * audience, issuer, replay, repo binding) already ran at the ingress; the
 * cross-checks repeated here are the ones that need the parsed body.
 */
export function validateCiPayload(args: {
  value: unknown;
  identity: { owner: string; name: string; sha: string };
  now: number;
  prior?: PriorCiFacts | null;
}): CiValidation {
  const { value, identity, now } = args;

  // --- Tier 2a: the envelope ------------------------------------------------
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(2, 'invalid_body');
  }
  const p = value as Record<string, unknown>;

  // Before anything reads a field: every string in the payload, at every depth,
  // under the cap. A 200 KB `checkpoint.subject` reaches an enrich prompt.
  const strings = boundedStrings(p);
  if (!strings.ok) return fail(1, strings.reason, 413, strings.where);

  for (const k of Object.keys(p)) {
    // Unknown keys are REJECTED, not ignored. An ignored key is a field that
    // exists on the wire, is never checked, and one day acquires a meaning.
    if (!ALLOWED_TOP_KEYS.has(k)) return fail(2, 'unknown_field', 400, k);
  }

  // A claim is optional — absent on every run after the first, and forever for a
  // repository connected through the App. Present, it must be a plausible code:
  // whether it names anything is the ingress's lookup to answer, not this one's.
  if (p.claim !== undefined) {
    if (typeof p.claim !== 'string' || !CLAIM_RE.test(p.claim)) {
      return fail(2, 'invalid_claim', 400, typeof p.claim === 'string' ? 'malformed' : typeof p.claim);
    }
  }

  const state = p.state as { headSha?: unknown; files?: unknown } | undefined;
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return fail(2, 'invalid_state');
  }
  if (typeof state.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(state.headSha)) {
    return fail(2, 'invalid_state_head');
  }
  if (!state.files || typeof state.files !== 'object' || Array.isArray(state.files)) {
    return fail(2, 'invalid_state_files');
  }
  for (const [v, allowed, where] of [
    [state, ALLOWED_STATE_KEYS, 'state'],
    [p.repo, ALLOWED_REPO_KEYS, 'repo'],
    [p.checkpoint, ALLOWED_CHECKPOINT_KEYS, 'checkpoint'],
    [p.counts, ALLOWED_COUNT_KEYS, 'counts'],
  ] as Array<[unknown, ReadonlySet<string>, string]>) {
    const bad = unknownKeyIn(v, allowed, where);
    if (bad) return fail(2, 'unknown_field', 400, bad);
  }

  // --- Tier 5: commit attestation ------------------------------------------
  // The ingress already proved `checkpoint.sha === claim.sha`. This closes the
  // remaining seam: the STATE's head must be the same commit too, or the payload
  // describes one commit while claiming to be another.
  if (state.headSha !== identity.sha) {
    return fail(5, 'state_head_mismatch', 403, `${state.headSha} != ${identity.sha}`);
  }
  const checkpoint = p.checkpoint as { date?: unknown; subject?: unknown; trigger?: unknown };
  const dateMs = Date.parse(String(checkpoint?.date ?? ''));
  if (!Number.isFinite(dateMs)) return fail(5, 'invalid_checkpoint_date');
  if (Math.abs(now - dateMs) > MAX_CHECKPOINT_SKEW_MS) {
    return fail(5, 'checkpoint_date_out_of_window', 403, String(checkpoint?.date));
  }
  if (!['merge', 'push', 'dispatch', 'schedule'].includes(String(checkpoint?.trigger))) {
    return fail(2, 'invalid_trigger', 400, String(checkpoint?.trigger));
  }

  const files = state.files as Record<string, unknown>;
  const fileIds = Object.keys(files);

  // --- Tier 1: bounds -------------------------------------------------------
  // ZERO files is maximal truncation, and it is the trivially cheap failure of a
  // customer's own runner: a bad glob, a shallow clone, a build step that did not
  // run. Admitting it renders an empty architecture the reader believes — which is
  // exactly what "REJECT, DON'T TRUNCATE" exists to prevent — and Tier 6 cannot
  // catch it on a repo's FIRST payload, which is where it is most likely and least
  // visible. So it is a hard refusal here rather than a soft warning there.
  if (fileIds.length === 0) {
    return fail(1, 'empty_graph', 400, 'the payload declares zero files');
  }
  if (fileIds.length > MAX_FILES) {
    // The SAME ceiling the byte cap reports, so a repo that trips
    // either bound is told one number rather than two that look unrelated.
    return fail(1, 'too_many_files', 413, `${fileIds.length} > ${MAX_FILES} — ${ciCeilingNote()}`);
  }
  const edgeCap = Math.min(fileIds.length * MAX_EDGES_PER_FILE, MAX_EDGES_ABSOLUTE);

  // --- Tiers 2/3/4, per record ---------------------------------------------
  const declared = new Set(fileIds);
  const externalIds = new Set<string>();
  let edgeCount = 0;

  for (const id of fileIds) {
    const safe = isSafeFileId(id);
    if (!safe.ok) return fail(3, 'unsafe_path', 400, `${truncate(id)}: ${safe.reason}`);
    // Tier 4. `looksLikeInjection` is the shared injection detector, reused rather
    // than re-derived. Hard here, and only for identifiers: a directory named
    // `ignore-previous-instructions/` is never an accident, whereas a COMMIT
    // SUBJECT saying the same words legitimately is (a repo about prompt
    // injection would be unable to ingest). See the subject handling below.
    if (looksLikeInjectionInPath(id)) {
      return fail(4, 'injection_shaped_path', 400, truncate(id));
    }

    const rec = files[id];
    if (!isValidFileRecord(rec)) return fail(2, 'invalid_file_record', 400, truncate(id));
    const r = rec as FileRecord & Record<string, unknown>;

    for (const k of Object.keys(r)) {
      if (!ALLOWED_RECORD_KEYS.has(k)) {
        return fail(2, 'unknown_record_field', 400, `${truncate(id)}: ${truncate(k)}`);
      }
    }

    // `isValidFileRecord` accepts any number for `loc`, including negative,
    // fractional, NaN and Infinity — it was written to spot a corrupt cache row,
    // not a hostile one. A negative loc flows into the salience ranking and the
    // budget arithmetic.
    if (!Number.isInteger(r.loc) || r.loc < 0 || r.loc > MAX_LOC) {
      return fail(2, 'invalid_loc', 400, `${truncate(id)}: ${String(r.loc)}`);
    }
    if (!KNOWN_LANGUAGES.has(r.language)) {
      return fail(2, 'unknown_language', 400, `${truncate(id)}: ${truncate(r.language)}`);
    }
    if (r.groupingPath !== undefined) {
      const g = isSafeFileId(r.groupingPath);
      if (!g.ok) return fail(3, 'unsafe_grouping_path', 400, `${truncate(id)}: ${g.reason}`);
      if (looksLikeInjectionInPath(r.groupingPath)) {
        return fail(4, 'injection_shaped_path', 400, truncate(r.groupingPath));
      }
    }
    if (r.blobSha !== undefined && !/^[0-9a-f]{7,64}$/.test(String(r.blobSha))) {
      return fail(2, 'invalid_blob_sha', 400, truncate(id));
    }

    for (const list of [r.imports, r.calls]) {
      for (const e of list) {
        const badEdgeKey = unknownKeyIn(e, ALLOWED_EDGE_KEYS, 'edge');
        if (badEdgeKey) return fail(2, 'unknown_field', 400, `${truncate(id)}: ${badEdgeKey}`);
        edgeCount += 1;
        if (edgeCount > edgeCap) {
          return fail(1, 'too_many_edges', 413, `> ${edgeCap}`);
        }
        if (!Number.isFinite(e.weight) || e.weight <= 0) {
          return fail(2, 'invalid_edge_weight', 400, `${truncate(id)}: ${String(e.weight)}`);
        }
        // Referential integrity. `graphFromState` does NOT filter these — it emits
        // an edge to whatever `to` says — so a dangling target becomes an edge to
        // a node that does not exist, and `validateAssembledGraph` hard-errors deep
        // inside the container, AFTER we have spent LLM money on the boot.
        if (!declared.has(e.to)) {
          return fail(2, 'dangling_edge_target', 400, `${truncate(id)} -> ${truncate(e.to)}`);
        }
        if (e.to === id) {
          return fail(2, 'self_referential_edge', 400, truncate(id));
        }
      }
    }
    for (const t of r.reexports) {
      if (!declared.has(t)) {
        return fail(2, 'dangling_reexport_target', 400, `${truncate(id)} -> ${truncate(t)}`);
      }
    }
    for (const x of r.externals) {
      const badExtKey = unknownKeyIn(x, ALLOWED_EXTERNAL_KEYS, 'external');
      if (badExtKey) return fail(2, 'unknown_field', 400, `${truncate(id)}: ${badExtKey}`);
      edgeCount += 1;
      if (edgeCount > edgeCap) return fail(1, 'too_many_edges', 413, `> ${edgeCap}`);
      if (!Number.isFinite(x.weight) || x.weight <= 0) {
        return fail(2, 'invalid_edge_weight', 400, `${truncate(id)}: external`);
      }
      const sSpec = isSafeSpecifier(x.specifier);
      if (!sSpec.ok) {
        return fail(3, 'unsafe_specifier', 400, `${truncate(x.specifier)}: ${sSpec.reason}`);
      }
      const sId = isSafeSpecifier(x.id);
      if (!sId.ok) {
        return fail(3, 'unsafe_external_id', 400, `${truncate(x.id)}: ${sId.reason}`);
      }
      if (looksLikeInjectionInPath(x.specifier) || looksLikeInjectionInPath(x.id)) {
        return fail(4, 'injection_shaped_specifier', 400, truncate(x.specifier));
      }
      externalIds.add(x.id);
      if (externalIds.size > MAX_EXTERNALS) {
        return fail(1, 'too_many_externals', 413, `> ${MAX_EXTERNALS}`);
      }
    }
  }

  // --- Tier 2b: the producer's own counts ----------------------------------
  // Cross-checked, never trusted. A payload whose self-report disagrees with its
  // own contents is either a bug in the runner or a probe of whether we look.
  const counts = p.counts as { files?: unknown; edges?: unknown; externals?: unknown } | undefined;
  if (counts && typeof counts === 'object') {
    if (counts.files !== undefined && counts.files !== fileIds.length) {
      return fail(2, 'count_mismatch', 400, `files ${String(counts.files)} != ${fileIds.length}`);
    }
    if (counts.externals !== undefined && counts.externals !== externalIds.size) {
      return fail(2, 'count_mismatch', 400, `externals ${String(counts.externals)} != ${externalIds.size}`);
    }
    // ⚠ `edges` WAS ACCEPTED AND NEVER CHECKED. `ALLOWED_COUNT_KEYS` permits it, so
    // a producer could send any number at all and learn we do not look — which is
    // precisely what the other two cross-checks exist to deny. Now checked against
    // the same `edgeCount` the bounds tier already computed, so it costs nothing.
    //
    // ⚠ AND THE QUANTITY IS THE STATE'S, NOT THE FILTERED GRAPH'S. Measured on the
    // host application repo: the noise-filtered graph has 1 658 edges and the
    // carried state 2 435 — a 47% gap. Our own runner sent the graph figure until
    // this was measured; enabling the check against the wrong quantity would have
    // refused every real payload on the first build.
    if (counts.edges !== undefined && counts.edges !== edgeCount) {
      return fail(2, 'count_mismatch', 400, `edges ${String(counts.edges)} != ${edgeCount}`);
    }
  }

  // --- Tier 2c: manifests ---------------------------------------------------
  const manifests = p.manifests;
  if (manifests !== undefined) {
    if (!Array.isArray(manifests) || manifests.length > 1000) {
      return fail(2, 'invalid_manifests');
    }
    for (const m of manifests as Array<Record<string, unknown>>) {
      if (!m || typeof m !== 'object') return fail(2, 'invalid_manifests');
      const badManifestKey = unknownKeyIn(m, ALLOWED_MANIFEST_KEYS, 'manifest');
      if (badManifestKey) return fail(2, 'unknown_field', 400, badManifestKey);
      // `String(m.path)` on an object yields "[object Object]", which passes
      // isSafeFileId cleanly — and the OBJECT then flows on unchanged into the
      // staged payload. Coercion is not validation.
      if (typeof m.path !== 'string') return fail(2, 'invalid_manifests', 400, 'path is not a string');
      const mp = isSafeFileId(m.path);
      if (!mp.ok) return fail(3, 'unsafe_manifest_path', 400, mp.reason);
      if (looksLikeInjectionInPath(m.path)) {
        return fail(4, 'injection_shaped_path', 400, truncate(m.path));
      }
      if (!Array.isArray(m.deps) || m.deps.length > 10_000) return fail(2, 'invalid_manifests');
      for (const d of m.deps as Array<Record<string, unknown>>) {
        const badDepKey = unknownKeyIn(d, ALLOWED_DEP_KEYS, 'manifest.dep');
        if (badDepKey) return fail(2, 'unknown_field', 400, badDepKey);
        if (typeof d?.name !== 'string') return fail(2, 'invalid_manifests', 400, 'dep name is not a string');
        const dn = isSafeSpecifier(d.name);
        if (!dn.ok) return fail(3, 'unsafe_specifier', 400, dn.reason);
        if (looksLikeInjectionInPath(d.name)) {
          return fail(4, 'injection_shaped_specifier', 400, truncate(d.name));
        }
      }
    }
  }

  // --- Tier 2d/3: workspace manifests, shipped whole ------------------------
  //
  // ⚠ THIS BLOCK IS THE ONLY THING STANDING BETWEEN AN UNTRUSTED PRODUCER AND A
  // FILE WRITE. `layoutFromManifests` in the container writes every entry to disk
  // so the extractor's own `detectWorkspaceLayout` can run on it. Three separate
  // properties have to hold, and each has its own refusal because "invalid
  // manifest" would tell a workflow author nothing:
  //
  //   * the path stays INSIDE the scratch tree      → isSafeFileId
  //   * the path names a manifest, not an arbitrary
  //     file inside it                              → isWorkspaceManifestBasename
  //   * the content is bounded text, not a bomb     → the byte caps below
  //
  // The container re-checks the first two at the write site. That is not
  // belt-and-braces theatre: this gate protects the ingress, and the write is a
  // different layer that a future producer could reach without passing here.
  const wsManifests = p.workspaceManifests;
  if (wsManifests !== undefined) {
    if (!Array.isArray(wsManifests)) return fail(2, 'invalid_workspace_manifests');
    if (wsManifests.length > MAX_WORKSPACE_MANIFESTS) {
      return fail(1, 'too_many_workspace_manifests', 413, `${wsManifests.length} > ${MAX_WORKSPACE_MANIFESTS}`);
    }
    let manifestBytes = 0;
    const seenPaths = new Set<string>();
    for (const m of wsManifests as Array<Record<string, unknown>>) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        return fail(2, 'invalid_workspace_manifests', 400, 'entry is not an object');
      }
      const badKey = unknownKeyIn(m, ALLOWED_WORKSPACE_MANIFEST_KEYS, 'workspaceManifest');
      if (badKey) return fail(2, 'unknown_field', 400, badKey);
      // Coercion is not validation — the `manifests` block learned this the hard
      // way, where `String(m.path)` on an object yielded "[object Object]" and
      // passed cleanly.
      if (typeof m.path !== 'string') {
        return fail(2, 'invalid_workspace_manifests', 400, 'path is not a string');
      }
      const safe = isSafeFileId(m.path);
      if (!safe.ok) return fail(3, 'unsafe_manifest_path', 400, `${truncate(m.path)}: ${safe.reason}`);
      if (looksLikeInjectionInPath(m.path)) {
        return fail(4, 'injection_shaped_path', 400, truncate(m.path));
      }
      if (!isWorkspaceManifestBasename(m.path)) {
        return fail(3, 'not_a_workspace_manifest', 400, truncate(m.path));
      }
      // Two entries for one path let a producer decide, by ORDER, which content
      // the scratch tree ends up holding — and hide the losing one from anybody
      // reading the payload. No legitimate runner emits a path twice.
      if (seenPaths.has(m.path)) {
        return fail(2, 'duplicate_workspace_manifest', 400, truncate(m.path));
      }
      seenPaths.add(m.path);
      if (typeof m.content !== 'string') {
        return fail(2, 'invalid_workspace_manifests', 400, `${truncate(m.path)}: content is not a string`);
      }
      // Tab/newline/CR are legitimate in a manifest; a NUL is not, and this string
      // becomes a file.
      if (MANIFEST_CONTROL_RE.test(m.content)) {
        return fail(3, 'control_character_in_manifest', 400, truncate(m.path));
      }
      // ⚠ THERE IS NO PER-MANIFEST BYTE CHECK HERE, AND THAT IS A CORRECTION.
      // The first cut had one, justified as "so the FIELD's own bound is enforced by
      // the block that owns the field". It could never fire: `boundedStrings` runs
      // over the WHOLE payload at the top of this function, applies exactly
      // `MAX_MANIFEST_CONTENT_BYTES` to this exact path via `LARGE_STRING_FIELDS`,
      // and uses the identical `>` comparison. Mutation testing found it — deleting
      // the check changed nothing, because a 65 537-byte manifest is already refused
      // as `string_too_long` several hundred lines earlier. So `manifest_too_large`
      // was an error code nothing could emit, beside a test that appeared to cover it
      // and was actually passing on the walk's 413.
      //
      // Defence in depth that cannot execute is not depth, it is a second claim about
      // the same check. `boundedStrings` owns the per-manifest bound; this block owns
      // the TOTAL, which nothing else can see.
      manifestBytes += byteLength(m.content);
      if (manifestBytes > MAX_TOTAL_MANIFEST_BYTES) {
        return fail(1, 'manifests_too_large', 413, `${manifestBytes} > ${MAX_TOTAL_MANIFEST_BYTES}`);
      }
    }
  }

  // --- Tier 2e/3/4: the derived infra graph ---------------------------------
  //
  // Runs AFTER the file records, deliberately: the two share `boundedStrings`'
  // per-string cap (already applied at the top of this function) and the file walk
  // is what most payloads fail on, so the cheaper refusal keeps its place in line.
  {
    // `declared` is the payload's file-id set, already built for the edge-target
    // check. Passing it is what makes the cross-namespace collision visible.
    const rejection = validateInfraGraph(p.infra, declared);
    if (rejection) {
      return { rejection, warnings: [], counts: ZERO_COUNTS, languages: [] };
    }
  }

  // --- Tier 2f/3: the derived env-service names -----------------------------
  //
  // Beside the infra graph rather than folded into it: they are two derived
  // artefacts from two different scans, with two different grammars and two
  // different refusals. "invalid derived data" would tell a workflow author nothing.
  {
    const rejection = validateEnvServices(p.envServices);
    if (rejection) {
      return { rejection, warnings: [], counts: ZERO_COUNTS, languages: [] };
    }
  }

  // --- Tier 2g/3/4: the raw framework contributions -------------------------
  //
  // Beside the other two derived artefacts rather than folded into either. Three
  // scans, three grammars, three refusals: "invalid derived data" would tell a
  // workflow author nothing about which of their adapters to look at.
  {
    const rejection = validateFrameworkContributions(p.framework);
    if (rejection) {
      return { rejection, warnings: [], counts: ZERO_COUNTS, languages: [] };
    }
  }

  // --- Tier 6: plausibility. SOFT. -----------------------------------------
  const languages = [...languagesOf(files, fileIds)].sort();
  const warnings = plausibilityWarnings(
    { files: fileIds.length, edges: edgeCount, languages },
    args.prior ?? null,
  );

  // The node-ceiling gate's two extra node-bearing counts. Read AFTER their
  // validators above, so both are known-well-formed arrays by the time they are
  // counted — an unvalidated count feeding a ceiling is a caller-controlled number
  // deciding a refusal.
  // Both guarded the same way, deliberately. `validateInfraGraph` and `validateEnvServices`
  // above have already proved both are well-formed arrays, so BOTH guards are redundant —
  // but an asymmetry here (one guarded, one not) invites the next reader to "fix" the wrong
  // side, and these two numbers decide a refusal. A reviewer flagged the asymmetry.
  const infraNodes = Array.isArray((p.infra as { nodes?: unknown } | undefined)?.nodes)
    ? ((p.infra as { nodes: unknown[] }).nodes.length)
    : 0;
  const envServices = Array.isArray(p.envServices) ? p.envServices.length : 0;

  return ok(
    {
      files: fileIds.length,
      edges: edgeCount,
      externals: externalIds.size,
      infraNodes,
      envServices,
    },
    languages,
    warnings,
  );
}

function languagesOf(files: Record<string, unknown>, ids: string[]): Set<string> {
  const out = new Set<string>();
  for (const id of ids) out.add(String((files[id] as FileRecord).language));
  return out;
}

/**
 * Tier 6. Compare against the last ACCEPTED CI payload for this repo.
 *
 * ⚠ WHAT THIS CAN AND CANNOT SEE, STATED SO NOBODY OVERREADS IT. There is no
 * prior for a repo's FIRST CI payload, and there is deliberately no attempt to
 * synthesise one from the clone-path snapshot — the two paths count different
 * things (a snapshot counts modules, a payload counts files), and a comparison
 * across that seam would produce a warning on every single first build. So the
 * first payload gets no plausibility verdict, and that is the honest answer
 * rather than a fabricated one.
 *
 * NEVER hard-rejects. A monorepo split, a big refactor and a language migration
 * all look exactly like this, and the blast radius of a bad-faith payload is the
 * sender's own repo.
 */
export function plausibilityWarnings(now: PriorCiFacts, prior: PriorCiFacts | null): string[] {
  if (!prior || prior.files === 0) return [];
  const out: string[] = [];

  const churn = Math.abs(now.files - prior.files) / prior.files;
  if (churn > 0.9) {
    out.push(
      `file count moved ${Math.round(churn * 100)}% (${prior.files} → ${now.files}) — ` +
        'a monorepo split or a big refactor looks like this too',
    );
  }
  if (now.files === 0) out.push('this build reported zero files');

  const priorLangs = new Set(prior.languages);
  const nowLangs = new Set(now.languages);
  const shared = [...nowLangs].filter((l) => priorLangs.has(l));
  if (priorLangs.size > 0 && nowLangs.size > 0 && shared.length === 0) {
    out.push(
      `the language set changed completely (${[...priorLangs].join(',')} → ${[...nowLangs].join(',')})`,
    );
  }

  const ratioNow = now.files > 0 ? now.edges / now.files : 0;
  const ratioPrior = prior.files > 0 ? prior.edges / prior.files : 0;
  if (ratioPrior > 0 && (ratioNow > ratioPrior * 5 || ratioNow < ratioPrior / 5)) {
    out.push(
      `edges per file moved from ${ratioPrior.toFixed(1)} to ${ratioNow.toFixed(1)}`,
    );
  }
  return out;
}

/**
 * A payload string on its way into an error message or an ops row. Uses the
 * shared prose sanitiser so a hostile path cannot reshape a log line or a
 * Telegram alert — the error channel is a text sink like any other.
 */
function truncate(s: string): string {
  return sanitizeProse(String(s ?? ''), 120);
}
