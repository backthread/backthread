/**
 * The CI-Action payload wire contract, and the bounded body reader that
 * materialises it.
 *
 * WHAT THIS CARRIES, AND WHY THAT IS THE PRODUCT. The payload is a
 * `FileGraphState` — per-file line counts, a language name, resolved edge
 * targets, package specifiers, a git blob sha. **No file contents, no symbol
 * names, no identifiers, no snippets.** That is not a promise about our
 * practices; it is a property of the artefact, and a security reviewer can
 * confirm it in a text editor in thirty seconds. It is the entire reason this
 * endpoint exists.
 *
 * WHY `FileGraphState` AND NOT `NormalizedGraph`. `@backthread/extractor`
 * already ships a versioned, validated, round-tripped serialization of exactly
 * this data, with an MIT-licensed validator (`isValidFileRecord`) — so the
 * customer's runner and our ingress run the IDENTICAL published check. And
 * because WE run `graphFromState()` to derive the graph, the untrusted surface
 * shrinks to a flat per-file record map instead of a graph PLUS a derived edge
 * list we would then have to cross-check for consistency. One less untrusted
 * artefact.
 *
 * THE BODY READER IS PART OF THE TRUST BOUNDARY. A gzip body from an untrusted
 * producer is a decompression bomb until proven otherwise, so `readBoundedBody`
 * counts bytes AS THEY INFLATE and aborts mid-stream. Inflating first and
 * measuring after would mean the guard can only fire once the damage is done —
 * which is to say it could never fire at all, because the isolate would be gone.
 */

import type { FileGraphState } from '@backthread/extractor';
import { errorMessage } from './errors.js';

/**
 * Wire-format version. An unknown value is a hard 400 — see the version ladder.
 *
 * ⚠ BUMPED 1 → 2 FOR THE INFRA LAYER, AND THE REFUSAL OF v1 IS THE FEATURE. v2 carries a
 * REQUIRED `infra` field. A v1 payload cannot carry one, and a payload with no
 * infra graph is indistinguishable at the ingress from a repo that genuinely has
 * no infrastructure — so admitting it means persisting a snapshot whose deployment
 * layer is silently absent. That is a false architecture, which this epic's
 * "reject, don't truncate" rule exists to prevent, so the version ladder refuses
 * the old producer rather than guessing on its behalf.
 *
 * ⚠ BUMPED 2 → 3 BY THE SAME WORK AGAIN, FOR THE SECOND OF THE SAME SHAPE. v3 carries a
 * REQUIRED `envServices`. The clone path reads `.env.example` / `.env.sample` /
 * `.env.template` / `.env.dist` for credential-shaped keys and turns the leading
 * segment into an external SERVICE node — a node with no import to hang off, which
 * is the entire reason the scan exists. Those nodes land in `assemble`'s `nodes`,
 * and `topologyHash` is the sorted module ids, so a CI payload without them
 * persists a DIFFERENT artefact rather than a thinner one. `[]` and absent are again
 * two opposite claims that render identically, so absence is refused rather than
 * defaulted. Measured on our own repo: 5 services (`anthropic`, `cloudflare`,
 * `gemini`, `supabase`, `telegram`).
 *
 * ⚠ BUMPED 3 → 4 BY IT ONE LAST TIME, FOR THE THIRD AND FINAL LAYER. v4
 * carries a REQUIRED `framework`. `contributeFrameworkGraph`'s synthetic edges are
 * appended to the rendered edge set and `topologyHash` is the sorted
 * `source|target|kind` triples, so a repo tripping ANY of the ~29 adapters that
 * implement `syntheticEdges` persisted a different artefact on the CI path. Same
 * rule for the same reason: an empty contribution set is a measurement, an absent
 * field is a missing one, and only one of them may render.
 */
export const CI_PAYLOAD_VERSION = 4;

/**
 * Max bytes we will read off the wire — the GZIPPED cap.
 *
 * RECONCILED AGAINST THE TICKET. The epic's Tier 1 says "gzipped body ≤ 8 MB".
 * This is 8 MiB (8 388 608 bytes), the binary reading, which is what "8 MB"
 * means in every other size constant in this codebase — 4.9% above the decimal
 * reading. Named here rather than left ambiguous, because a validator
 * re-measuring this bound needs to know which of the two it is checking.
 *
 * It is applied to whatever arrives, gzipped or not, because it is the only
 * figure enforceable before memory is spent. See `MAX_INFLATED_BYTES` for the
 * one bound that genuinely departs from the ticket, and why.
 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Max INFLATED bytes.
 *
 * ⚠ THE ONE DELIBERATE DEVIATION FROM THE TICKET, DERIVED FROM MEASUREMENT.
 * The epic's Tier 1 names 128 MB. This ships **16 MiB**. Recorded here, in the
 * commit, in the PR body and on the tracking issues — a limit that silently
 * disagrees with its own ticket reads as a defect to the next person who
 * measures it, and it should.
 *
 * WHY. A Workers isolate has 128 MB in TOTAL, and a JSON text buffer becomes a
 * parsed object graph several times its own size — so a 128 MB cap is a guard
 * that can never fire: the isolate dies first and "reject, don't truncate"
 * silently becomes "crash, and let the queue decide".
 *
 * Parsed, 16 MiB of JSON text is roughly 50-100 MB of V8 object graph, which is
 * the largest thing that plausibly co-exists with the request, the response and
 * the runtime inside 128 MB. The largest real payload is 310 kB, so this is ~54×
 * the biggest thing anyone has actually sent.
 *
 * The production measurement that justifies it now lives on
 * `OBSERVED_DENSEST_BYTES_PER_FILE` below, RE-MEASURED for the ceiling reconciliation
 * — keeping a second, older table here would leave two sets of numbers disagreeing
 * about the same repos, which is the failure this file exists to avoid.
 *
 * THE FILE CAP HAS SINCE BEEN RECONCILED AGAINST THIS ONE — see `MAX_FILES`
 * below. The note that used to live here (that a 50 000-file cap could never bind
 * because the byte cap refuses first) was correct, and is now fixed rather than
 * merely recorded.
 */
export const MAX_INFLATED_BYTES = 16 * 1024 * 1024;

/**
 * Densest per-file encoding observed in production.
 *
 * RE-MEASURED 2026-08-15 against every `extraction_cache.fileGraph` in production,
 * serialising exactly what the CI payload's `state` field carries
 * (`{headSha, files}`). n=5, spread 252..620 B/file, median 321:
 *
 *   backthread/test-elixir-papercups   192 files   118 974 B   620 B/file  ← densest
 *   harsha93460/influencer-kart         78 files    29 864 B   383 B/file
 *   the host application repo          967 files   310 408 B   321 B/file
 *   backthread/marola-platform          30 files     8 500 B   283 B/file
 *   dkorobtsov/plinter                   1 file        252 B   252 B/file
 *
 * The epic's ticket said 670 B/file; the same repo now encodes at 620, so the
 * figure moved and this constant is the re-derived one, not the inherited one.
 * It is deliberately the DENSEST rather than the median: the guarantee below is
 * only worth stating if it holds for the worst encoding we have actually seen.
 */
export const OBSERVED_DENSEST_BYTES_PER_FILE = 620;

/**
 * Per-manifest and total byte caps for `workspaceManifests`.
 *
 * ⚠ WHY A MANIFEST'S CONTENT IS ON THE WIRE AT ALL, AND WHY IT IS STILL NOT
 * SOURCE. `clusterGraph` takes a `WorkspaceLayout` from `detectWorkspaceLayout(dir)`
 * — an fs-READING function that returns an object with METHODS, so it cannot cross
 * the wire. Passing `undefined` instead is not a small degrade: measured on
 * the host application repo, it costs eleven modules and a different
 * `topology_hash`, which is exactly the quantity this widening's acceptance
 * criterion is about. So the runner ships its workspace-DEFINING manifests, we
 * write them into a scratch tree, and we call the SAME published function on it.
 *
 * A `package.json` / `pnpm-workspace.yaml` / `pubspec.yaml` carries dependency
 * names, workspace globs, a package name and scripts. It contains no source code,
 * so "your source is never sent" survives intact — but this IS more than the
 * `{path, deps}` "manifest facts" the original contract described, and the
 * widening is named here rather than left in a diff for a reviewer to discover.
 *
 * ⚠ ONE OF THESE NUMBERS IS MEASURED AND ONE IS A PROJECTION, AND THEY ARE NOT THE
 * SAME KIND OF CLAIM. The host application repo (the densest connected repo,
 * 967 files) ships **4 manifests / 9 810 bytes, largest 5 364 B**. So 64 KiB per
 * manifest is 12× the largest one anybody has actually sent — that bound is
 * measured. The 1 MiB total is 107× our whole measured set, sized instead for a
 * shape nobody has sent us yet: a ~200-package monorepo at 5 KB each. Calling that
 * "measured" would be the overclaim; it is a projection, and it is deliberately
 * the smaller of the two candidates considered, because every byte reserved here
 * comes straight out of `MAX_FILES`.
 *
 * ⚠ AND NOTE WHAT THE LARGEST FIGURE PROVES: 5 364 B is **5.2× `MAX_STRING_BYTES`**.
 * A manifest's content therefore CANNOT be governed by the payload-wide string cap
 * — our own root `package.json` would be refused. That is why `ciValidate.ts`
 * carries an explicit per-field exemption instead of a raised global cap: raising
 * the global one would silently re-admit a 64 KB `checkpoint.subject` into an
 * enrich prompt, which is the thing the walk exists to stop.
 */
export const MAX_MANIFEST_CONTENT_BYTES = 64 * 1024;
export const MAX_TOTAL_MANIFEST_BYTES = 1024 * 1024;
/** Entries, matching the `manifests` cap. The TOTAL byte cap is what really binds. */
export const MAX_WORKSPACE_MANIFESTS = 1000;

/**
 * Caps for `infra` — the DERIVED deployment graph the runner extracts.
 *
 * ⚠ WHY A DERIVED GRAPH CROSSES THE WIRE AND THE CONFIG FILES DO NOT. The infra
 * adapters read `wrangler.toml`, HCL and Supabase migrations, and NONE of those is
 * a workspace manifest, so on the CI path they never ran at all and the deployment
 * layer was simply absent. The obvious fix — widen the payload to carry the config
 * files, the way the manifest widening did for `package.json` — is STRICTLY WORSE
 * than the widening it imitates: a `package.json` carries dependency names, and a
 * `wrangler.toml` carries account identifiers and credential references. So the
 * adapters run on the CUSTOMER'S runner (they are regex/TOML/JSON scanners and
 * never execute repo code) and only their OUTPUT crosses — nodes, edges, kinds.
 * The graph already crosses the wire; this extends an existing contract instead of
 * opening a new one, and "we don't receive your code, only validated inspectable
 * derived data" survives unchanged, which is the entire reason CI mode exists.
 *
 * ⚠ THE GRAPH IS NOT SENT AS `MergedInfraGraph`. That type carries `root`, an
 * ABSOLUTE PATH on the customer's machine (`/home/runner/work/…`). It is provenance
 * for a local extract and has no business on the wire, so the runner strips it and
 * the container supplies its own scratch root. A field we would have to redact is a
 * field we should not carry.
 *
 * ⚠ WHICH OF THESE THREE ACTUALLY BINDS, STATED RATHER THAN LEFT TO ARITHMETIC.
 * The BYTE cap binds. Measured on the host application repo (2026-08-16, the
 * densest connected repo and the one with the most infrastructure): **21 nodes /
 * 76 edges / 18 075 wire bytes**, i.e. 861 B per node. 512 KiB is therefore ~29×
 * the measured graph and admits roughly 600 nodes at that density — well below
 * `MAX_INFRA_NODES`. The count caps are structural sanity ceilings that stop a
 * tiny-but-absurd graph (a million zero-byte edges is not a byte problem), exactly
 * as `MAX_WORKSPACE_MANIFESTS` sits beside `MAX_TOTAL_MANIFEST_BYTES`. Naming which
 * one fires is the ceiling-reconciliation lesson: a stated ceiling that another
 * bound refuses first is a number the operator cannot act on.
 *
 * ⚠ AND THE COUNT CAPS ARE SIZED TO BE REACHABLE, WHICH TOOK MEASURING. The first
 * cut wrote `MAX_INFRA_EDGES = 50 000`, and that cap could never fire: the smallest
 * legal edge encodes as 42 bytes (`{"source":"a","target":"b","kind":"calls"}`), so
 * 50 001 of them is 2.1 MB and the BYTE cap refuses first — a limit stated in the
 * unit an operator can act on, that nothing can ever reach. That is precisely the
 * unreachable-ceiling defect, re-committed one field along. The reachable ceilings inside
 * 512 KiB are ~8 594 nodes (61 B minimum each) and ~12 483 edges, so both caps sit
 * BELOW their own byte-reachable ceiling and `ciValidate.test.ts` builds a payload
 * that trips each one, proving it. A payload maxing out BOTH still trips the byte
 * cap — the reservation is a budget, not a guarantee, exactly as for manifests.
 */
export const MAX_TOTAL_INFRA_BYTES = 512 * 1024;
export const MAX_INFRA_NODES = 5000;
export const MAX_INFRA_EDGES = 10_000;
// ⚠ `MAX_INFRA_METADATA_KEYS` / `MAX_INFRA_METADATA_ARRAY` ARE GONE, AND THEIR
// ABSENCE IS THE FIX RATHER THAN A REGRESSION (found in review). They bounded a
// free-form metadata bag that should never have crossed: the wire now carries
// `{ type }` and the ingress refuses every other key, so "how wide may the bag be"
// and "how long may its arrays be" are questions with no subject. A cap on a field
// that cannot exist is the unreachable-guard defect this file already tombstones
// once (`manifest_too_large`).
/** `sourceRoots` entries on one node. Measured max on our own repo: 1. */
export const MAX_INFRA_SOURCE_ROOTS = 64;
/**
 * `classificationsNeeded` entries — THE ONE FIELD ON THIS PAYLOAD THAT TURNS
 * DIRECTLY INTO LLM CALLS, and the reason it gets a cap of its own.
 *
 * ⚠ FOUND IN REVIEW, AND IT IS THE SAME CEILING SHAPE AGAIN. Without this the field was
 * bounded only by `MAX_TOTAL_INFRA_BYTES`, which admits ~7 000 entries — measured, by
 * building the payload. Because `applyResourceClassifications` dedupes by
 * `(provider, resourceType)`, 7 000 DISTINCT pairs all survive the dedupe and reach
 * `classifyResourceTypes` in a single call. On the clone path that quantity is
 * bounded by what the repo actually contains; here the producer chooses it. The
 * blast radius is the sender's own wallet — the epic's documented posture — but
 * every other cost-bearing quantity here has a stated ceiling, and a real limit
 * nobody stated is precisely the defect the ceiling reconciliation exists to remove.
 *
 * 2 000 against a measured 0 on our own repo, and REACHABLE: 2 001 entries encode
 * at ~70 B each ≈ 140 KB, well inside the byte cap, so the count is the bound that
 * fires and `ciInfra.test.ts` builds the payload that trips it.
 */
export const MAX_INFRA_CLASSIFICATIONS = 2000;

/**
 * Caps for `envServices` — the derived env-service names.
 *
 * ⚠ WHY A DERIVED NAME LIST CROSSES AND THE `.env` FILES DO NOT, WHICH SHOULD NOT
 * NEED SAYING AND DOES. `.env.example` is a TEMPLATE of a credential file. It is
 * committed, it usually holds placeholders — and "usually" is not a boundary. The
 * scan runs on the customer's runner and only the derived NAMES cross: the parser
 * splits each line at the first `=` and never looks right of it, requires the key to
 * match `^[A-Z][A-Z0-9_]*$` and end in a credential-shaped suffix, then takes the
 * segment before the first `_` and lowercases it. A service name is therefore
 * `^[a-z][a-z0-9]*$` by construction — a vendor, never a value.
 *
 * ⚠ AND `vars` IS DROPPED, WHICH IS THE SAME NARROWING `metadata` GOT. The local
 * `EnvServiceCandidate` carries the env var KEYS it was derived from
 * (`STRIPE_SECRET_KEY`). Nothing downstream reads them — `classifyEnvVarPatterns`
 * maps `c.service` and nothing else — so they are the names a customer's
 * credentials are filed under, crossing a trust boundary in order to be discarded.
 * The wire carries the service name alone and the ingress refuses anything else.
 *
 * ⚠ AND THE NAME REACHES AN LLM PROMPT, WHICH IS WHY THE GRAMMAR IS ENFORCED RATHER
 * THAN THE LENGTH ALONE. `classifyEnvVarPatterns` routes each name through the
 * shared external classifier. `^[a-z][a-z0-9]{0,63}$` admits no whitespace, no
 * punctuation and no control characters, so there is no prose for an injection to
 * live in — a strictly stronger guard than `looksLikeInjection` on a free-form
 * string, and one this producer can always satisfy.
 *
 * WHICH ONE BINDS: the COUNT. 500 against a measured 5 on our own repo, and the
 * byte reservation below is derived from the two, so neither can outrun the other.
 */
export const MAX_ENV_SERVICES = 500;
// ⚠ AND WHAT 500 ACTUALLY BUYS AN ATTACKER, SINCE "the blast radius is the sender's
// own wallet" is not the whole story here. Each accepted name becomes a lookup in
// `external_classifications`, which is a GLOBAL, cross-tenant classify-once cache —
// so a payload can seed up to 500 rows of it per build with names of the sender's
// choosing. The cost is billed to the sender and the rows are keyed by the name, so
// this is cache POLLUTION rather than a leak or a cross-tenant cost transfer; it is
// named because a limit whose real consequence is unstated is a limit nobody can
// size. Measured against 5 on our own repo.
export const MAX_ENV_SERVICE_BYTES = 64;
/**
 * Per-entry JSON overhead: `"name",` is two quotes and a separator, and the fourth
 * byte carries the FIELD's own cost — `"envServices":[]` plus the one comma the last
 * entry does not have.
 *
 * ⚠ MEASURED, AND THE FIRST STATEMENT OF THIS MEASUREMENT WAS ITSELF WRONG. At three
 * the worst legal ARRAY is 33 501 bytes against a 33 500 reservation — over by one —
 * and the worst legal FIELD is 33 517, over by seventeen. The earlier comment quoted
 * the array's figure while the test measures the field's, which is the same
 * off-by-a-little that made `MAX_FILES` unreachable twice, one level up.
 * `ciEnv.test.ts` builds the worst legal FIELD and compares it, rather than asserting
 * the arithmetic — the arithmetic is what was wrong both times.
 */
export const ENV_SERVICE_JSON_OVERHEAD_BYTES = 4;
/**
 * DERIVED, not chosen — the exact worst case of the two caps above.
 *
 * A separately-picked byte cap here would be the unreachable-guard defect this file
 * tombstones twice already: whichever of the two was smaller would fire first and
 * the other would be a number nobody could reach. This one cannot disagree with the
 * count cap, because it is computed from it.
 */
// ⚠ ONE LINE ON PURPOSE, exactly like `PAYLOAD_ENVELOPE_BUDGET_BYTES` below.
// `src/lib/ingestModeCaps.lockstep.test.ts` resolves an operand with
// `export const NAME = ([^;]+);` and requires a space after the `=`; wrapping this
// declaration makes the app-side lockstep guard THROW instead of comparing — which
// is a guard failing open, discovered here by running it.
export const MAX_TOTAL_ENV_BYTES = MAX_ENV_SERVICES * (MAX_ENV_SERVICE_BYTES + ENV_SERVICE_JSON_OVERHEAD_BYTES);

/**
 * Caps for `framework` — the raw, file-id-space adapter contributions.
 *
 * ⚠ WHY A DERIVED CONTRIBUTION SET CROSSES AND NOTHING ELSE DOES. The framework
 * adapters READ SOURCE — Nest reads decorators and constructors, Next reads a route
 * tree, the ORM adapters read entity classes. That is precisely why the step cannot
 * move to our side and the FILES cannot move to the wire: this is the one adapter
 * family whose input is application code. So the hooks run on the customer's runner
 * against their own checkout, and what crosses is what they DERIVED — repo-relative
 * file paths, an 8-verb edge label, a role name, a group label. Every one of those
 * paths is already on the wire inside `state.files`; this adds no new class of fact,
 * only a new relation over facts we already carry.
 *
 * ⚠ AND THE SPLIT IS IN THE PUBLISHED PACKAGE, NOT HERE. `@backthread/extractor`
 * 0.15.0 divides `contributeFrameworkGraph` into `collectFrameworkContributions`
 * (the tree phase) and `applyFrameworkContributions` (the cluster phase), and the
 * old entry point is their composition. A reimplementation on either side would be a
 * second definition of what a framework contributes, and the two paths' edge sets
 * would drift for a reason no hash diff could explain.
 *
 * ⚠ `metadata` DOES NOT CROSS, ON EITHER EDGES OR ROLE TAGS. `FrameworkEdge` and
 * `RoleTag` both carry an open `Record<string, unknown>` that nothing downstream
 * reads — `assemble` takes `{role}` from a tag and `{source,target,kind}` from an
 * edge — so the raw types simply do not have the field. Same narrowing
 * `InfraNode.metadata` got, applied at the producer rather than at the ingress.
 *
 * ⚠ WHICH ONE BINDS: the BYTE cap, and the counts are sized BELOW their own
 * byte-reachable ceilings so each can still fire. Measured on `nestjs/nest` itself
 * (1 386 files, the densest framework tree to hand): **2 adapters, 10 edges, 116
 * role tags, 0 groups, 15 816 wire bytes** — 11 bytes per source file. 512 KiB is
 * ~33x that, and admits a repo of roughly 47 000 files at the same density, which is
 * twice `MAX_FILES`. Inside 512 KiB the reachable ceilings are ~9 198 edges (57 B
 * minimum each), ~10 082 role tags and ~131 072 group file ids, so the counts below
 * sit under each. `ciFramework.test.ts` builds the payload that trips every one.
 */
export const MAX_TOTAL_FRAMEWORK_BYTES = 512 * 1024;
export const MAX_FRAMEWORK_EDGES = 8000;
export const MAX_FRAMEWORK_ROLES = 9000;
export const MAX_FRAMEWORK_GROUPS = 2000;
/**
 * File ids summed across every group — the bulk risk in the field, so it gets its own
 * cap.
 *
 * ⚠ 50 000 AND NOT 100 000, AND THE REASON IS A DIFFERENT GUARD ENTIRELY. The first
 * cut wrote 100 000 from the byte-reachable ceiling (4 bytes per minimal entry inside
 * 512 KiB admits ~131 000). It could never fire: `boundedStrings` walks the payload
 * before this tier runs and bounds the PENDING stack at `MAX_WALK_STACK` = 100 000,
 * and one group's `fileIds` array pushes one entry per member — so 100 001 members
 * came back `too_wide`, a refusal naming a walk budget when the thing the operator
 * can act on is a grouping prior. Measured by building the payload, which is the only
 * way any of these ceilings has ever been got right.
 *
 * 50 000 is ~2x `MAX_FILES`, so a prior may claim every file in the largest admissible
 * repo twice over, and it sits below the walk bound, the byte cap and the entry cap.
 */
export const MAX_FRAMEWORK_GROUP_FILES = 50_000;
/**
 * `adapters` is the producer's own count of detected framework matches. It feeds
 * `counts.adapters`, which is logged and nothing else — so this is a sanity ceiling
 * on a number, not a resource bound. There are 51 registered adapters today.
 */
export const MAX_FRAMEWORK_ADAPTERS = 1000;

/**
 * Bytes reserved for everything in the payload that is NOT `state.files`.
 *
 * ⚠ WHY THIS EXISTS — THE FIRST CUT'S CEILING WAS UNREACHABLE. `MAX_FILES` was
 * derived as `MAX_INFLATED_BYTES / OBSERVED_DENSEST_BYTES_PER_FILE`, which left
 * **16 bytes** of headroom. But `MAX_INFLATED_BYTES` bounds the WHOLE inflated
 * body, and the density was measured over `state` alone — so the envelope
 * (`payloadVersion`, `actionVersion`, `extractorVersion`, `repo`, `checkpoint`,
 * `counts`, `manifests`) had nowhere to live. Measured: a payload at exactly
 * `MAX_FILES` files at exactly the densest density was **refused** with
 * `inflated_too_large`, while that very refusal said "admits at most 27060
 * files". The stated ceiling could not be reached, and the test that certified it
 * asserted `MAX_FILES * D <= MAX_INFLATED_BYTES` — true of `state`, false of the
 * thing actually inflated. An independent validator found it; the shipped tests
 * all passed because they pinned the wrong quantity.
 *
 * 256 KiB, against a measured envelope of **330 bytes** for a manifest-free
 * payload. Deliberately ~800× the measured figure, because `manifests` is bounded
 * only at 1 000 entries × 10 000 deps and so is not small in the worst case — and
 * because the reservation must exceed one file's cost for the FILE cap to be the
 * one that fires at the boundary rather than the byte cap.
 *
 * ⚠ IT IS A BUDGET, NOT A GUARANTEE. A payload whose envelope exceeds this still
 * trips the byte cap. That is the third residue, stated rather than hidden — the
 * defect being fixed here was a ceiling that lied, and a silent new one would be
 * the same bug again.
 *
 * ⚠ AND `MAX_TOTAL_FRAMEWORK_BYTES` IS THE LAST TERM, AND THE SECOND-LARGEST.
 * `MAX_FILES` drops **24 046 → 23 199**. That is a 3.5% cut in the stated ceiling
 * for a field measured at 15 816 bytes on the densest framework tree to hand — and
 * it is taken anyway, because the reservation has to cover what the ingress ADMITS,
 * not what the median payload sends. 23 199 is still 24x the largest connected repo.
 *
 * ⚠ `MAX_TOTAL_ENV_BYTES` WAS ADDED TOO, AND IT IS THE CHEAPEST TERM IN THE
 * SUM BY TWO ORDERS OF MAGNITUDE. `envServices` is 500 names of at most 64 bytes
 * plus 4 of JSON overhead each, so the reservation is 34 000 bytes and `MAX_FILES`
 * drops **24 100 → 24 045**. (An earlier draft said 33 500 / 24 046 — the `+ 3`
 * figures, never re-derived when the overhead constant moved to 4. A frozen number
 * in a comment goes stale the moment the constant beside it changes, which is why
 * `ingestModeCaps.lockstep.test.ts` resolves the operands rather than the answer.) It
 * is in the sum anyway, because the whole point of writing the reservation as a sum
 * is that a field admitted into the envelope has a term in it — a small field
 * omitted "because it is small" is how the next one gets omitted too.
 *
 * ⚠ `MAX_TOTAL_INFRA_BYTES` WAS ADDED FOR THE SAME REASON, AND PAID FOR IT IN
 * FILES. `infra` lives in the envelope too and the ingress admits up to that much
 * of it, so leaving the reservation alone would have re-committed the same
 * ceiling defect one field along: a stated file ceiling the byte cap refuses first.
 * `MAX_FILES` drops **24 945 → 24 100** — still 24× the largest connected repo
 * (967 files), and a ceiling that holds beats a larger one that does not.
 *
 * ⚠ `MAX_TOTAL_MANIFEST_BYTES` WAS ADDED TO IT, AND THAT IS THE WHOLE POINT
 * OF WRITING IT AS A SUM. `workspaceManifests` lives in the envelope, and the
 * ingress admits up to `MAX_TOTAL_MANIFEST_BYTES` of it. A reservation of 256 KiB
 * beside a cap that admits a megabyte would be a budget that does not cover what it
 * budgets for — precisely the defect the ceiling reconciliation removed, re-committed
 * with a new number. (The figure is deliberately NOT repeated in prose here: an
 * earlier draft said "2 MiB" in three comments after the constant moved to 1 MiB,
 * which is the same defect class one layer up.) So the reservation is the sum, and `MAX_FILES` falls out of it.
 *
 * WHAT THAT COSTS, STATED: `MAX_FILES` drops from **26 637 to 24 945**. The
 * largest connected repo is 967 files, so the new ceiling is still 25× anything
 * real — and a stated ceiling that holds beats a larger one that does not.
 */
// ⚠ ONE LINE ON PURPOSE. `src/lib/ingestModeCaps.lockstep.test.ts` extracts this
// with `export const NAME = ([^;]+);` and then requires the substituted expression
// to match `^[\d_ *+/()]+$` — a class that does NOT admit a newline. Wrapping this
// declaration makes the app-side lockstep guard throw instead of comparing.
export const PAYLOAD_ENVELOPE_BUDGET_BYTES = 256 * 1024 + MAX_TOTAL_MANIFEST_BYTES + MAX_TOTAL_INFRA_BYTES + MAX_TOTAL_ENV_BYTES + MAX_TOTAL_FRAMEWORK_BYTES;

/**
 * The file-count ceiling — DERIVED from the byte budget, not mirrored from the
 * clone path.
 *
 * ⚠ WHAT THIS FIXES. It used to be 50 000, copied from
 * `DEFAULT_BUDGET.maxFiles` in `scripts/ingest/safety.ts` on the reasoning that
 * "if the two disagreed, a repo could be ingestable through one door and not the
 * other". That reasoning was right and the constant did not achieve it: 50 000
 * files needs an average of 335 B/file to fit inside 16 MiB, which is BELOW the
 * production median of 321... by 4%. In practice the byte cap fired first for
 * essentially every real repo, and it fired with `inflated_too_large` — an error
 * naming a bound in bytes when the thing the operator can act on is file count.
 *
 * THE REAL DEFECT WAS NON-DETERMINISM, NOT THE NUMBER. Between ~27 000 and
 * 50 000 files, whether a repo was admitted depended on how densely its file
 * records happened to encode — invisible to the person connecting it, and
 * different for two repos of identical size. Deriving the cap trades a larger
 * but unpredictable envelope for a smaller stated one that always answers the
 * same way. No connected repo is near either figure: the largest is 967 files,
 * 28× below this ceiling.
 *
 * THE GUARANTEE, STATED PRECISELY: for a COMPRESSED payload whose per-file
 * encoding is at or below `OBSERVED_DENSEST_BYTES_PER_FILE` AND whose envelope
 * fits `PAYLOAD_ENVELOPE_BUDGET_BYTES`, a payload AT the file cap is admitted and
 * one file over it is refused with `too_many_files` — a number the operator can
 * act on. `ciCaps.test.ts` proves this by BUILDING both payloads and running the
 * real `readBoundedBody`, not by arithmetic: the arithmetic is what was wrong
 * before, and an invariant asserted over the wrong quantity is how it stayed
 * green.
 *
 * ⚠ TWO CONDITIONS ON THAT SENTENCE, BOTH REAL.
 *
 * 1. **It assumes the body is gzipped.** `readBoundedBody` applies
 *    `MAX_BODY_BYTES` (8 MiB) in `readRawBounded` BEFORE it sniffs the gzip
 *    magic, so an UNCOMPRESSED payload is governed by the raw cap, not this one —
 *    `MAX_FILES_UNCOMPRESSED` below, roughly half. Our own action gzips, which is
 *    why the ceiling is derived from the inflated cap rather than conservatively
 *    from the raw one; a hand-rolled client that posts plain JSON gets
 *    `body_too_large` sooner, and `ciCeilingNote()` names both figures so that
 *    refusal points at the same ceiling as the other two.
 * 2. **A payload denser than anything measured still trips the byte cap.**
 *    Per-file cost is bounded only by `MAX_EDGES_PER_FILE` × `MAX_STRING_BYTES`
 *    (~20 KB), so no file cap can be made to bind first in every case.
 *
 * Both residues are stated rather than hidden, because the defect being fixed
 * here was a limit that named the wrong bound — restating it with a different
 * wrong bound would be the same bug wearing a new number.
 */
export const MAX_FILES = Math.floor(
  (MAX_INFLATED_BYTES - PAYLOAD_ENVELOPE_BUDGET_BYTES) / OBSERVED_DENSEST_BYTES_PER_FILE,
);

/**
 * The file ceiling for a payload posted WITHOUT compression, where
 * `MAX_BODY_BYTES` governs instead. Exported so the relationship is asserted by
 * `ciCaps.test.ts` rather than left as a comment someone has to re-derive.
 *
 * ⚠ NOT ENFORCED, AND DELIBERATELY NOT QUOTED TO CUSTOMERS. There is no
 * file-count check on the raw path — `MAX_BODY_BYTES` simply cuts the body off —
 * so the ingress admits somewhat MORE uncompressed files than this, and exactly
 * how many has measured differently on every attempt (13 529 before the envelope
 * reservation existed, 13 460 after) precisely because nothing pins it. It was
 * previously in `ciCeilingNote()` and had to come out: stating a ceiling nothing
 * enforces is precisely the defect this reconciliation removed. Keep it as the
 * documented relationship between the raw cap and file count; do not print it.
 */
export const MAX_FILES_UNCOMPRESSED = Math.floor(
  (MAX_BODY_BYTES - PAYLOAD_ENVELOPE_BUDGET_BYTES) / OBSERVED_DENSEST_BYTES_PER_FILE,
);

/**
 * The clone path's own file cap, kept here ONLY so the two can be compared in
 * one place and so `ciCaps.lockstep.test.ts` can hold this copy to the original.
 * The CI path's ceiling is deliberately LOWER; that is the point of the ceiling
 * reconciliation, not a drift to be repaired.
 */
export const CLONE_PATH_MAX_FILES = 50_000;

/**
 * One sentence explaining the CI path's real ceiling, for a refusal detail.
 * Carries BOTH wire figures so that `body_too_large`, `inflated_too_large` and
 * `too_many_files` all point at the same ceiling — the whole point of the ceiling
 * reconciliation is that a refused payload is told one number, not three.
 */
export function ciCeilingNote(): string {
  // ⚠ EVERY NUMBER HERE IS ONE THE INGRESS ACTUALLY ENFORCES, AND THE RESERVATION
  // IS NAMED SO THE OBVIOUS DIVISION DOES NOT MISLEAD.
  //
  // Two things an independent validator found wrong with the previous wording:
  //
  //  * It quoted `MAX_FILES_UNCOMPRESSED` — a figure NOTHING checks. There is no
  //    file-count analogue on the raw path, so the ingress admitted ~13 500
  //    uncompressed files while this sentence claimed 13 107. A ceiling stated
  //    but not enforced is the defect this whole issue is about, so the figure is
  //    gone rather than made more precise. The constant survives as documentation
  //    of the raw-cap relationship (see `ciCaps.test.ts`), not as a promise.
  //  * It read "16777216 inflated bytes at 620 B/file", which invites the reader
  //    to divide and get 27 060 — the very number the last round proved
  //    unreachable. The envelope reservation is what accounts for the difference,
  //    so it is stated instead of the per-file density.
  // ⚠ "WHOSE ENVELOPE FITS" IS NOT HEDGING — IT IS THE DIFFERENCE BETWEEN A TRUE
  // AND A SELF-CONTRADICTING SENTENCE. A third validator built a plausible
  // monorepo payload (26 637 files plus 300 package.json manifests x 40 deps =
  // 684 KB of envelope, well inside the validator's own 1000 x 10 000 limits) and
  // got `inflated_too_large` carrying "admits at most 26637 files" — the ingress
  // refusing exactly the count it claimed to admit. The reservation is a budget,
  // not a guarantee, so the sentence now says which payloads the count is true of.
  return (
    `the CI path admits at most ${MAX_FILES} files whose payload envelope fits ` +
    `${PAYLOAD_ENVELOPE_BUDGET_BYTES} bytes (${MAX_INFLATED_BYTES} inflated bytes in total, ` +
    `and at most ${MAX_BODY_BYTES} bytes on the wire)`
  );
}

/**
 * Decompression-ratio ceiling, applied only once output passes
 * `RATIO_GUARD_FLOOR_BYTES`. The floor matters: a 200-byte gzip legitimately
 * inflates 30×, and a ratio guard without a floor rejects small honest
 * payloads while catching nothing a size cap wouldn't.
 *
 * WHICH GUARD OWNS WHICH REGIME. With an 8 MiB raw cap and a 16 MiB inflated cap,
 * the ratio can only exceed 500:1 when the raw body is under ~33 KiB. So:
 * `MAX_BODY_BYTES` bounds what we read, `MAX_INFLATED_BYTES` bounds everything
 * above ~33 KiB raw, and the ratio guard owns exactly the small-input regime — the
 * tiny bomb that a size cap alone would let inflate all the way to 16 MiB before
 * refusing. It earns its place by rejecting sooner there, not by rejecting more.
 */
export const MAX_DECOMPRESSION_RATIO = 500;
export const RATIO_GUARD_FLOOR_BYTES = 1024 * 1024;

/** gzip magic. Used to detect an already-decompressed body (see readBoundedBody). */
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** One dependency the runner shipped, as facts only — never a manifest file. */
export interface CiManifestFact {
  path: string;
  deps: Array<{ name: string; version?: string }>;
}

/**
 * A workspace-DEFINING manifest, shipped whole.
 *
 * Deliberately a SEPARATE field from `manifests` rather than a `content` key bolted
 * onto it. The two carry different things under different rules: `manifests` is
 * dependency facts about any manifest, this is the verbatim text of a manifest
 * whose BASENAME the layout detector recognises. Merging them would have meant one
 * bounds story covering two shapes, and the `path` allowlist below — the check that
 * makes the container's scratch write bounded — would have had to be conditional on
 * whether a sibling key happened to be present.
 */
export interface CiWorkspaceManifest {
  path: string;
  content: string;
}

/**
 * The ONLY metadata that crosses the wire — and this is the narrowest
 * point of the whole contract, deliberately.
 *
 * ⚠ AN INDEPENDENT VERIFIER FALSIFIED THE FIRST VERSION'S OWN SECURITY ARGUMENT,
 * AND THIS IS THE CORRECTION. The rationale for running the adapters on the
 * customer's runner is that `wrangler.toml` "carries account identifiers and
 * credential references where a `package.json` carries dependency names". The first
 * cut then shipped `InfraNode.metadata` whole — and the DERIVED graph carried those
 * identifiers anyway. Measured on our own repo:
 *
 *   metadata.image = registry.cloudflare.com/183986778ae…/clew-ingest-worker-sandbox:sha-…
 *
 * — the Cloudflare account id, copied verbatim out of `worker/wrangler.jsonc`. The
 * same field carries a GCP project id (`gcr.io/<project>/…`), an AWS account id via
 * ECR (`<acct>.dkr.ecr.<region>.amazonaws.com/…`), and Railway's adapter puts the
 * literal credential REFERENCE `${{Postgres.DATABASE_URL}}` in `metadata.ref`.
 * `metadata.tables` carried up to 50 table names read out of migration SQL.
 *
 * ⚠ AND EVERY ONE OF THEM WAS DISCARDED SERVER-SIDE. Measured: `metadata.type` is
 * the ONLY key anything downstream reads (`assemble.ts` → `infraSummary`), infra
 * EDGE metadata has no reader at all, and `Module` has no `metadata` field, so none
 * of it ever reached `snapshots.data`. We were receiving a customer's account id in
 * order to throw it away, on the exact boundary this endpoint exists to defend.
 *
 * So the wire carries `{ type }` and nothing else. This is not a redaction bolted
 * onto a wider field — the field IS this shape, the ingress refuses any other key,
 * and `narrowInfraForWire` on the runner is what produces it. A future adapter that
 * invents a new metadata key therefore cannot silently start sending it: the
 * customer's build fails first. Nothing is lost, because nothing read it.
 *
 * `type` itself is an adapter's own short kind tag (`kv`, `r2`, `d1`, `postgres`),
 * appended to the rendered summary as `(KV)`. It names a product, never a resource.
 */
export interface CiInfraMetadata {
  type?: string;
}

/** One node of the derived deployment graph. */
export interface CiInfraNode {
  id: string;
  label: string;
  /** An `INFRA_MODULE_KINDS` member. Validated against the locked enum, never coerced. */
  kind: string;
  /** `declared` | `inferred` | `llm-classified`. Validated, never coerced. */
  provenance: string;
  /** `{ type }` only — see `CiInfraMetadata`. */
  metadata?: CiInfraMetadata;
  /**
   * Repo-relative DIRECTORY prefixes whose code this artefact deploys. These are
   * paths, not identifiers, and `assemble`'s zone attribution genuinely reads them —
   * so they stay where `metadata` did not.
   */
  sourceRoots?: string[];
}

/**
 * One edge of the derived deployment graph.
 *
 * `source`/`target` are NOT necessarily infra node ids: an adapter that greps
 * source (Supabase's `.from(`) emits a repo-relative FILE PATH as an endpoint,
 * which `assemble` binds to the module that file clustered into. So the ingress
 * checks that an endpoint is a SAFE reference, and cannot check that it resolves —
 * resolution is `assemble`'s job and it already drops what it cannot bind.
 */
export interface CiInfraEdge {
  source: string;
  target: string;
  /** An `EDGE_KINDS` member. The 8-verb taxonomy is locked. */
  kind: string;
  // ⚠ NO `metadata`. The adapters emit one (`{binding, config, via, tables}`) and
  // NOTHING downstream reads it — infra edge metadata has no consumer anywhere in
  // the pipeline, and `Edge` has no field to put it in. It carried binding names and
  // config paths for no purpose, so it does not cross and the ingress refuses the key.
}

/** A `(provider, resourceType)` pair the runner could not classify. WE resolve it. */
export interface CiClassificationRef {
  provider: string;
  resourceType: string;
  forNodeId: string;
}

/**
 * The derived deployment graph, as it crosses the wire.
 *
 * ⚠ REQUIRED, AND AN EMPTY ONE IS A STATEMENT. `{nodes: [], edges: []}` means "I
 * ran the adapters and this repo has no infrastructure" — a fact. An ABSENT field
 * would mean "nobody ran them", and the two render identically while meaning
 * opposite things. That is exactly the false architecture the required-field rule
 * exists to close, so absence is refused at the ingress rather than defaulted to
 * empty.
 *
 * ⚠ NO `root`. See `MAX_TOTAL_INFRA_BYTES`.
 */
export interface CiInfraGraph {
  nodes: CiInfraNode[];
  edges: CiInfraEdge[];
  /** Absent ⇒ nothing needed classifying, which is the common case. */
  classificationsNeeded?: CiClassificationRef[];
}

/**
 * One adapter's synthetic edge, in FILE-ID space.
 *
 * `source`/`target` are repo-relative file paths the adapter derived — a screen and
 * the screen it navigates to, a controller and the provider injected into it. They
 * are NOT checked for membership in `state.files`, and that is deliberate: an
 * adapter may legitimately name a file the graph extractor never indexed (a `.graphql`
 * schema, a route manifest), and `applyFrameworkContributions` already DROPS an
 * endpoint it cannot resolve. Refusing here would reject honest payloads to prevent
 * an outcome that is already a no-op.
 *
 * ⚠ NO `metadata`. `FrameworkEdge` carries an open bag and nothing downstream reads
 * it — `assemble` takes `{source, target, kind}`. It does not cross.
 */
export interface CiFrameworkEdge {
  /** The adapter that emitted it, so a rejected edge names its producer. */
  adapter: string;
  source: string;
  target: string;
  /** An `EDGE_KINDS` member. Validated against the locked 8-verb enum, never coerced. */
  kind: string;
}

/**
 * One adapter's role tag for a file id.
 *
 * ⚠ `kind` IS AN `MODULE_KINDS` MEMBER AND IS STILL NOT A MODULE KIND. A role is
 * METADATA — `assemble` reads `{role}` and leaves the module's own `kind` untouched
 * — but the published `RoleTag` types the field, so the wire carries it and the
 * ingress holds it to the locked enum rather than letting an unchecked string
 * through a field named `kind`.
 */
export interface CiFrameworkRole {
  adapter: string;
  /** A repo-relative file id. Same non-membership reasoning as `CiFrameworkEdge`. */
  id: string;
  role: string;
  kind: string;
  /** Collapse priority when several roles land on one module. Higher wins. */
  priority?: number;
}

/** One adapter's grouping-prior group, in FILE-ID space. */
export interface CiFrameworkGroup {
  adapter: string;
  /** The adapter's own group id; the consumer namespaces it as `<adapter>:<id>`. */
  id: string;
  label: string;
  fileIds: string[];
}

/**
 * Everything the framework adapters derived from the customer's TREE, before any
 * cluster exists.
 *
 * ⚠ REQUIRED, AND AN EMPTY ONE IS A STATEMENT — the third field on this payload to
 * take that rule, for the third time for the same reason. `{adapters:0, edges:[],
 * crossLanguageEdges:[], roles:[], groups:[]}` means "I ran detection and this repo
 * trips no adapter", which is true of most repos. An ABSENT field means nobody ran
 * it, and the two render identically while meaning opposite things.
 */
export interface CiFrameworkContributions {
  /** The producer's count of detected matches. Logged, never a gate. */
  adapters: number;
  edges: CiFrameworkEdge[];
  /** The cross-language seam. Folded AFTER `edges` — dedupe is first-wins. */
  crossLanguageEdges: CiFrameworkEdge[];
  roles: CiFrameworkRole[];
  groups: CiFrameworkGroup[];
}

/** The commit this build describes. `sha` is cross-checked against the OIDC claim. */
export interface CiCheckpoint {
  sha: string;
  date: string;
  subject: string;
  trigger: 'merge' | 'push' | 'dispatch' | 'schedule';
}

/**
 * The whole wire payload. Every field is attacker-controlled; nothing here
 * participates in authorisation. `repo` in particular is CHECKED against the
 * OIDC claim, never used as a lookup key — see ciSnapshot.ts.
 */
export interface CiSnapshotPayload {
  payloadVersion: number;
  actionVersion: string;
  extractorVersion: string;
  /** FILE_GRAPH_VERSION the runner serialised with. Cache invalidator, never a gate. */
  fileGraphVersion?: number;
  /** EXTRACTOR_VERSION (numeric parse-cache key). Never a gate. */
  extractorCacheVersion?: number;
  repo: { owner: string; name: string; defaultBranch: string };
  checkpoint: CiCheckpoint;
  /** The carried graph. WE derive the NormalizedGraph from it. */
  state: FileGraphState;
  manifests?: CiManifestFact[];
  /**
   * The workspace-defining manifests, verbatim. Absent ⇒ we cluster without a
   * layout, which on a multi-package repo is a DIFFERENT module set (measured:
   * −11 modules on our own repo). The container says so out loud rather than
   * degrading quietly.
   */
  workspaceManifests?: CiWorkspaceManifest[];
  /**
   * The derived deployment graph, extracted by the adapters ON THE RUNNER.
   * REQUIRED, including when it is empty: see `CiInfraGraph`.
   */
  infra: CiInfraGraph;
  /**
   * The raw framework contributions the runner's adapters produced, in FILE-ID
   * space. REQUIRED, including when empty: a repo that trips no adapter says so
   * with `{adapters:0, edges:[], …}`, and an absent field says nobody ran them.
   * Structurally `RawFrameworkContributions` from `@backthread/extractor`,
   * restated here because the ingress must not depend on a shape it cannot check.
   */
  framework: CiFrameworkContributions;
  /**
   * The env-derived service names, scanned by the runner. REQUIRED, including
   * when empty: see `MAX_ENV_SERVICES`. Names only, never the env var keys they
   * came from and never a value.
   */
  envServices: string[];
  /** The producer's own claim about its counts — cross-checked, never trusted. */
  counts?: { files?: number; edges?: number; externals?: number };
}

export type BodyReadFailure =
  | 'body_too_large'
  | 'inflated_too_large'
  | 'decompression_ratio'
  | 'malformed_gzip'
  | 'malformed_json'
  /**
   * The TRANSPORT failed — a client abort mid-upload, a reset connection, a
   * truncated request. Deliberately NOT `malformed_json`: nothing has reached
   * `JSON.parse` at that point, and calling it a parse error would tell a
   * workflow author to debug the one thing that was never wrong, with a 4xx
   * their runner will not retry.
   */
  | 'body_read_failed'
  | 'empty_body';

export type BodyReadResult =
  | { ok: true; value: unknown; rawBytes: number; inflatedBytes: number; gzipped: boolean }
  | { ok: false; reason: BodyReadFailure; detail?: string };

/**
 * Read the request body under hard bounds and parse it as JSON.
 *
 * WHY WE SNIFF THE MAGIC BYTES INSTEAD OF TRUSTING `Content-Encoding`. Whether
 * an edge decompresses a `Content-Encoding: gzip` request body before the
 * Worker sees it is a property of the platform, not of our code, and it can
 * change under us. Sniffing means the same handler is correct whether the bytes
 * arrive compressed or already inflated — and it removes a header from the set
 * of things an attacker can lie about to steer us down a different path.
 */
export async function readBoundedBody(
  req: Request,
  limits: {
    maxBodyBytes?: number;
    maxInflatedBytes?: number;
    maxRatio?: number;
  } = {},
): Promise<BodyReadResult> {
  const maxBody = limits.maxBodyBytes ?? MAX_BODY_BYTES;
  const maxInflated = limits.maxInflatedBytes ?? MAX_INFLATED_BYTES;
  const maxRatio = limits.maxRatio ?? MAX_DECOMPRESSION_RATIO;

  // Cheap pre-check: an honest client sends Content-Length, and refusing here
  // saves opening the stream at all. It is ONLY an optimisation and is trusted for
  // nothing — the header is attacker-controlled, may be absent, and may be a lie.
  // `readRawBounded` below is what actually enforces the bound.
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBody) {
    return {
      ok: false,
      reason: 'body_too_large',
      // The third refusal that used to name its own bound and nothing else.
      detail: `content-length ${declared} > ${maxBody} — ${ciCeilingNote()}`,
    };
  }

  // ⚠ NOT `req.arrayBuffer()`. That materialises the WHOLE body before any check
  // can run, so a chunked request with no `content-length` would exhaust the
  // 128 MB isolate before the size comparison executed — a guard placed after the
  // damage, which is a guard that cannot fire. Read it the way `inflateBounded`
  // reads the inflated side: chunk by chunk, with a running total, cancelling the
  // stream the moment the total passes the cap.
  const rawRead = await readRawBounded(req, maxBody);
  if (!rawRead.ok) return rawRead;
  const raw = rawRead.bytes;
  if (raw.byteLength === 0) return { ok: false, reason: 'empty_body' };

  const gzipped = raw.byteLength >= 2 && raw[0] === GZIP_MAGIC_0 && raw[1] === GZIP_MAGIC_1;

  let text: string;
  let inflatedBytes: number;
  if (!gzipped) {
    if (raw.byteLength > maxInflated) {
      // Name the ceiling the reader can act on. A byte count alone
      // tells a workflow author their payload is too big and nothing about what
      // to change; the file ceiling is the same bound in the unit they think in.
      return {
        ok: false,
        reason: 'inflated_too_large',
        detail: `${raw.byteLength} > ${maxInflated} — ${ciCeilingNote()}`,
      };
    }
    inflatedBytes = raw.byteLength;
    text = new TextDecoder().decode(raw);
  } else {
    const inflated = await inflateBounded(raw, maxInflated, maxRatio);
    if (!inflated.ok) return inflated;
    inflatedBytes = inflated.bytes;
    text = inflated.text;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: 'malformed_json', detail: errorMessage(e).slice(0, 120) };
  }
  return { ok: true, value, rawBytes: raw.byteLength, inflatedBytes, gzipped };
}

/**
 * Read the raw request body under a hard byte cap, cancelling mid-stream.
 *
 * The cap is checked BEFORE each chunk is retained, so the peak memory a
 * rejected request costs is `maxBody` plus one chunk — not the body's real size,
 * which the sender chooses and we cannot see in advance.
 */
async function readRawBounded(
  req: Request,
  maxBody: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: BodyReadFailure; detail?: string }> {
  const body = req.body;
  if (!body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBody) {
        await reader.cancel().catch(() => {});
        return {
          ok: false,
          reason: 'body_too_large',
          detail: `> ${maxBody} — ${ciCeilingNote()}`,
        };
      }
      chunks.push(value);
    }
  } catch (e) {
    return { ok: false, reason: 'body_read_failed', detail: errorMessage(e).slice(0, 120) };
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, bytes: out };
}

/**
 * Streaming gunzip with a running byte counter. The counter is checked on EVERY
 * chunk and the stream is cancelled the moment either bound trips, so a bomb
 * costs us one chunk of memory rather than its full expansion.
 */
async function inflateBounded(
  raw: Uint8Array,
  maxInflated: number,
  maxRatio: number,
): Promise<
  | { ok: true; text: string; bytes: number }
  | { ok: false; reason: BodyReadFailure; detail?: string }
> {
  let stream: ReadableStream<Uint8Array>;
  try {
    const src = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(raw);
        controller.close();
      },
    });
    stream = src.pipeThrough(new DecompressionStream('gzip')) as unknown as ReadableStream<Uint8Array>;
  } catch (e) {
    return { ok: false, reason: 'malformed_gzip', detail: errorMessage(e).slice(0, 120) };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxInflated) {
        await reader.cancel().catch(() => {});
        return {
          ok: false,
          reason: 'inflated_too_large',
          // Same reason as the non-gzip branch above.
          detail: `${bytes} > ${maxInflated} — ${ciCeilingNote()}`,
        };
      }
      if (bytes > RATIO_GUARD_FLOOR_BYTES && bytes / raw.byteLength > maxRatio) {
        await reader.cancel().catch(() => {});
        return {
          ok: false,
          reason: 'decompression_ratio',
          // Carries the ceiling like every other size refusal. A bare
          // "24:1 > 500:1" tells a workflow author nothing they can change.
          detail: `${Math.round(bytes / raw.byteLength)}:1 > ${maxRatio}:1 — ${ciCeilingNote()}`,
        };
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } catch (e) {
    return { ok: false, reason: 'malformed_gzip', detail: errorMessage(e).slice(0, 120) };
  }
  return { ok: true, text: out, bytes };
}

/**
 * The R2 object key for a staged payload.
 *
 * Shaped so that (a) an operator can list one repo's staged payloads, (b) the
 * commit is legible without opening the object, and (c) the random suffix means
 * a key is unguessable — the container fetches by key, so the key is part of the
 * capability. Payloads are deleted on completion; this is a staging area, not
 * storage, in keeping with the same never-store posture as the clone.
 */
export function ciPayloadKey(repoId: string, sha: string, jobId: string): string {
  return `ci/${repoId}/${sha}/${jobId}.json`;
}
