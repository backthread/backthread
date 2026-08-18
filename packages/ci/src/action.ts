#!/usr/bin/env node
/**
 * `backthread-ci` — the CI-extraction client. Run this in your own GitHub Actions
 * workflow to send Backthread the STRUCTURE of your repository without ever giving it
 * clone access and without your source ever leaving the runner.
 *
 * ⚠ IT NEEDS NO SECRET OF YOURS, AND THAT IS THE POINT. There is no API key to
 * provision, no token to rotate, nothing to put in your repository secrets. The only
 * credential it touches is the short-lived OIDC ID token GitHub mints for the job,
 * which is an assertion about WHICH REPOSITORY IS CALLING and carries no access to
 * anything. Give the job `permissions: { id-token: write }` and that is the whole
 * setup.
 *
 * WHAT IT DOES, IN THE ORDER THAT MATTERS FOR WHAT LEAVES YOUR RUNNER:
 *
 *   1. Extracts the graph FROM THE RUNNER'S OWN CHECKOUT, using
 *      `@backthread/extractor` — the same MIT package the hosted clone path runs, which
 *      is why the two converge on one `topology_hash` rather than merely on two
 *      plausible ones.
 *   2. Serialises the `FileGraphState`. Per-file line counts, a language name,
 *      resolved edge targets, package specifiers, a git blob sha. **No file
 *      contents, no symbol names, no identifiers, no snippets.** A security
 *      reviewer can confirm that in a text editor in thirty seconds, which is the
 *      entire point of the endpoint.
 *   3. Collects the WORKSPACE MANIFESTS, whole. This is the one widening of the
 *      contract, and it is deliberate: `clusterGraph` needs a `WorkspaceLayout`
 *      built by an fs-reading function that returns methods, so it cannot cross the
 *      wire — the manifests can, and the server calls the same detector on them. A
 *      `package.json` carries no code. The set is chosen by the extractor's OWN
 *      `isWorkspaceManifestPath`, so it can never be wider than the thing that
 *      consumes it.
 *   4. Runs the INFRA adapters against the same checkout and ships the DERIVED
 *      deployment graph — nodes, edges, kinds. Not `wrangler.toml`, not HCL, not a
 *      migration: those carry account identifiers and credential references, and
 *      shipping them would be strictly worse than shipping a `package.json`. The
 *      adapters are regex/TOML/JSON scanners that never execute repo code, so they
 *      run correctly here, and only their output crosses. An earlier revision did not
 *      run them at all on this path, and the snapshot persisted with its deployment
 *      layer missing — a false architecture rather than a thinner one.
 *   5. Mints a GitHub Actions OIDC token for the ingress's audience and POSTs the
 *      result, gzipped.
 *
 * ⚠ THE `GITHUB_TOKEN` NEVER LEAVES THE RUNNER. It is GitHub's own per-job token,
 * repo-scoped and expiring with the job; `actions/checkout` uses it and we never
 * read it. What we send is the OIDC ID token, which is an assertion about WHO is
 * calling and carries no repository access at all.
 *
 * ⚠ NO CONFIG SURFACE, ON PURPOSE — AND IT IS NOT AN OVERSIGHT TO FILE A REQUEST
 * AGAINST. There is no branch input, no path filter, no include/exclude. Every knob
 * here is a knob that has to be supported, versioned and reasoned about on someone
 * else's infrastructure, and the absence of one is the mechanical guard against this
 * becoming an on-prem product. The tracked branch comes from your connected repo's
 * settings, and the ingress refuses any ref that is not it.
 *
 * ⚠ WITH ONE EXCEPTION, NAMED HERE RATHER THAN LEFT FOR SOMEONE TO FIND.
 * `BACKTHREAD_ENDPOINT` redirects where this posts, and it exists so the client can be
 * run against a non-production ingress. It is a knob, and the paragraph above would be
 * an overclaim if it went unmentioned. What it cannot do is turn the OIDC token into a
 * credential somewhere else: the token is minted for a fixed AUDIENCE, so a copy sent
 * to another host is an assertion nothing else will accept. Anyone able to set this
 * variable can already run arbitrary steps in the same job.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { errorMessage } from './errors.js';
import { gzipSync } from 'node:zlib';
import {
  EXTRACTOR_PACKAGE_VERSION,
  IncrementalExtractor,
  collectFrameworkContributions,
  extractInfra,
  isWorkspaceManifestPath,
  type NormalizedGraph,
  type RawFrameworkContributions,
} from '@backthread/extractor';

/**
 * Sent as `actionVersion`; the ingress records it and never gates on it.
 *
 * ⚠ READ FROM `package.json` RATHER THAN TRANSCRIBED. A hand-bumped constant beside a
 * published version is a lockstep with no enforcement: the two agree until the release
 * anyone forgets, and from then on every payload misreports which client produced it —
 * silently, because nothing downstream refuses a wrong version. `createRequire`
 * resolves it at runtime from the installed package rather than through the type
 * system, so it works identically from `dist/` and from a source checkout.
 */
const ACTION_VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;

/** Must match the ingress's `CI_OIDC_AUDIENCE`. */
const AUDIENCE = 'https://api.backthread.dev';

/**
 * The same ceilings the ingress enforces, so the runner fails FIRST. A payload
 * refused for size after a full extract has already cost the customer their CI
 * minutes and tells them nothing they could have known earlier.
 *
 * ⚠ IMPORTED, NOT TRANSCRIBED — AND THE FIRST CUT'S JUSTIFICATION FOR TRANSCRIBING
 * WAS CIRCULAR. It said "the numbers agreeing is asserted by the ingress refusing,
 * not by this file being right". But the ingress cannot run (GitHub Actions is
 * billing-locked), and even when it can, a runner cap set HIGHER than the ingress's
 * produces exactly the late refusal these constants exist to prevent — the ingress
 * refusing is the failure, not the assertion. A drift here is silent in the only
 * direction that matters.
 *
 * This file runs under `tsx` on a GitHub runner, not in the Workers isolate, so the
 * `__filename` lowering that forced `ciValidate.ts` to keep local copies does not
 * apply. There is no reason for a copy.
 */
// The SAME scan the clone path runs, imported rather than reimplemented.
// A second heuristic here would be a second definition of "which service does this
// repo talk to", and the two paths' node sets would drift for a reason no hash
// diff could explain.
import { ENV_FILES, mergeEnvServiceCandidates } from './envVars.js';
import {
  CI_PAYLOAD_VERSION,
  MAX_MANIFEST_CONTENT_BYTES,
  MAX_TOTAL_MANIFEST_BYTES,
  type CiInfraGraph,
  type CiSnapshotPayload,
} from './payload.js';
// The ingress's OWN infra check, run here so the runner fails FIRST.
// Not a second opinion about the gate: the same function, so a drift is impossible
// rather than merely unlikely. A runner cap looser than the ingress's produces the
// late refusal these imports exist to prevent; a tighter one refuses payloads we
// would have accepted. Both drifts are silent, and both are one function away.
// The ingress's OWN checks, run here so the runner fails FIRST — and living in their
// own module because `main()` runs on import, so nothing in THIS file can be executed
// by a test. A verifier proved what that costs: a payload gate rewritten to compute its
// refusal and upload anyway passed every test, because the only guard on it was a
// search of this file's source text.
import {
  assertPayloadIsAcceptable,
  preparedEnvServices,
  preparedFramework,
  preparedInfra,
} from './preflight.js';

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

/** The files git knows about, so nothing untracked or ignored can be shipped. */
function trackedFiles(): string[] {
  return git('ls-files', '-z').split('\0').filter(Boolean);
}

interface WorkspaceManifest {
  path: string;
  content: string;
}

/**
 * The workspace-defining manifests, verbatim.
 *
 * ⚠ THE PREDICATE IS THE EXTRACTOR'S OWN. Hand-listing basenames here would be a
 * second list to keep in sync with `detectWorkspaceLayout`, and the failure mode is
 * silent: a manifest type the detector reads but we do not ship yields a layout
 * that differs from the clone path's, which is exactly the divergence the whole
 * acceptance criterion is about.
 */
function collectManifests(files: string[]): WorkspaceManifest[] {
  const out: WorkspaceManifest[] = [];
  let total = 0;
  for (const path of files) {
    if (!isWorkspaceManifestPath(path)) continue;
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      // A manifest we cannot read is a manifest we do not ship. Degrading to a
      // coarser layout is recoverable; failing the customer's build over an
      // unreadable file is not.
      console.warn(`[backthread] skipping unreadable manifest ${path}`);
      continue;
    }
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_MANIFEST_CONTENT_BYTES) {
      console.warn(`[backthread] skipping ${path}: ${bytes} bytes exceeds the per-manifest cap`);
      continue;
    }
    if (total + bytes > MAX_TOTAL_MANIFEST_BYTES) {
      // ⚠ STOP, AND SAY SO LOUDLY. Silently truncating the manifest set produces a
      // layout that is wrong in a way nothing downstream can detect — the snapshot
      // renders a plausible architecture with the wrong module boundaries. "Reject,
      // don't truncate" is the ingress's rule and it has to be the runner's too.
      throw new Error(
        `[backthread] workspace manifests exceed ${MAX_TOTAL_MANIFEST_BYTES} bytes ` +
          `(at ${out.length} of them). Shipping a partial set would render a false layout.`,
      );
    }
    total += bytes;
    out.push({ path, content });
  }
  return out;
}

/**
 * The DERIVED deployment graph — nodes, edges, kinds. Never the config.
 *
 * ⚠ NO CLASSIFIER IS INJECTED, AND THAT IS DELIBERATE RATHER THAN A LIMITATION.
 * `extractInfra` takes an optional `classifyResourceTypes` closure for open-ended
 * IaC resource types; it needs network and a model, and the customer's CI has
 * neither our key nor any business holding it. So an unresolved type ships as a
 * `classificationsNeeded` entry and the SERVER resolves it against the same global
 * classify-once cache the clone path uses. The runner does the parsing; the money
 * and the credential stay on our side.
 *
 * ⚠ `root` IS STRIPPED. `MergedInfraGraph.root` is an absolute path inside this
 * runner (`/home/runner/work/…`). It is provenance for a local extract, it tells our
 * ingress nothing, and the ingress REFUSES it as an unknown key — so sending it
 * would fail the build for a field we should not be sending anyway.
 *
 * ⚠ AND THE INGRESS'S OWN CHECK RUNS HERE, BEFORE THE POST. Not belt-and-braces:
 * a payload refused for shape after a full extract has already cost the customer
 * their CI minutes and told them nothing they could have known earlier. It is the
 * SAME function, so it cannot disagree.
 */
async function collectInfra(): Promise<CiInfraGraph> {
  const result = await extractInfra({ repoDir: process.cwd() });
  // ⚠ NARROWED AND CHECKED IN ONE CALL, IN A MODULE A TEST CAN IMPORT. The first cut
  // sent `MergedInfraGraph`'s nodes and edges verbatim, so the DERIVED graph carried the
  // very things the boundary argument says must not cross: `metadata.image` on our own
  // repo was the Cloudflare ACCOUNT ID lifted straight out of the deployment config. All
  // of it was discarded server-side. The reduction and the refusal live together in
  // `preparedInfra` so that no future caller can do one without the other, and so that
  // both are reachable from a test — this function is not, because `main()` runs on
  // import.
  return preparedInfra(result.graph);
}

/**
 * The env-derived service names — never the env var keys, never a value.
 *
 * ⚠ THE SCAN RUNS HERE FOR THE SAME REASON THE INFRA ADAPTERS DO. `.env.example`
 * and its three siblings are TEMPLATES of a credential file. They must not cross the
 * wire, and the container's scratch tree has no way to produce them — which is why
 * the CI path used to render no env-derived service nodes at all, and why its
 * `topologyHash` differed from the clone path's rather than merely being thinner.
 *
 * ⚠ AND THE OUTPUT IS NARROWED BEFORE IT IS VALIDATED. `EnvServiceCandidate.vars`
 * carries the KEYS the candidate came from (`STRIPE_SECRET_KEY`) — provenance for a
 * local extract, read by nothing downstream, and the names a customer's credentials
 * are filed under. `narrowEnvForWire` is shared with `ci-replay --compare` and the
 * convergence test, so what those measure is what this sends.
 *
 * ⚠ AND THE INGRESS'S OWN CHECK RUNS HERE, BEFORE THE POST — not belt-and-braces:
 * it is the SAME function, so the two cannot disagree, and a payload refused for
 * shape after a full extract has already cost the customer their CI minutes.
 */
function collectEnvServices(files: string[]): string[] {
  // ⚠ TRACKED FILES ONLY, exactly as `collectManifests` is, and a reviewer had to
  // find it. The clone path scans a git clone, so it can only ever see TRACKED files;
  // a runner's working directory can hold an untracked or gitignored `.env.example`
  // (a repo that gitignores `.env*` with no `!.env.example` negation, or a workflow
  // step that writes one). Reading it would produce service nodes the clone path can
  // never produce — the two paths diverging again, by a file we should not have been
  // reading at all. The FILENAMES come from the scan's own exported list rather than
  // a second copy, because a basename that list gains and this one does not is that
  // same divergence arriving through a transcribed constant.
  const wanted = new Set<string>(ENV_FILES);
  const contents: string[] = [];
  for (const path of files) {
    // Root-level only, matching `extractEnvServiceCandidates`'s own `resolve(dir, f)`.
    if (!wanted.has(path)) continue;
    try {
      contents.push(readFileSync(path, 'utf8'));
    } catch {
      // Unreadable is not shippable, and it is not fatal either — one fewer service is
      // recoverable; failing the customer's build over an unreadable file is not.
      console.warn(`[backthread] skipping unreadable env file ${path}`);
    }
  }
  return preparedEnvServices(mergeEnvServiceCandidates(contents));
}

/**
 * The framework adapters' raw contributions — file ids, verbs, role names
 * and group labels. Never the source they were read from.
 *
 * ⚠ THIS IS THE ONE ADAPTER FAMILY WHOSE INPUT IS APPLICATION CODE, AND THAT IS
 * EXACTLY WHY THE STEP MOVES HERE RATHER THAN THE FILES MOVING TO US. Nest reads
 * decorators and constructors, Next reads a route tree, the ORM adapters read entity
 * classes. There is no version of "ship the inputs" that is not shipping source. So
 * the hooks run on the customer's own checkout and only the DERIVED relation crosses
 * — and every path in it is already on the wire inside `state.files`, so this adds a
 * new relation over facts we already carry rather than a new class of fact.
 *
 * ⚠ THE SPLIT IS IN THE PUBLISHED PACKAGE. `collectFrameworkContributions` is the
 * tree half of `contributeFrameworkGraph`; the server runs
 * `applyFrameworkContributions`, the cluster half, and the old entry point is their
 * composition. A reimplementation on either side would be a second definition of
 * what a framework contributes, and the two paths' edge sets would drift for a
 * reason no hash diff could explain.
 *
 * ⚠ `metadata` NEVER CROSSES, on either an edge or a role tag: the raw types simply
 * do not have the field, because nothing downstream reads it. Same narrowing
 * `InfraNode.metadata` got, applied at the producer this time rather than after a
 * verifier found an account id in it.
 */
async function collectFramework(graph: NormalizedGraph): Promise<RawFrameworkContributions> {
  return preparedFramework(await collectFrameworkContributions({ repoDir: process.cwd(), graph }));
}

/** Mint a GitHub Actions OIDC ID token for our audience. */
async function mintOidcToken(): Promise<string> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const reqToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !reqToken) {
    throw new Error(
      'no OIDC request context — the workflow job needs `permissions: { id-token: write }`',
    );
  }
  const res = await fetch(`${url}&audience=${encodeURIComponent(AUDIENCE)}`, {
    headers: { Authorization: `Bearer ${reqToken}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`OIDC mint failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { value?: string };
  if (!body.value) throw new Error('OIDC mint returned no token');
  return body.value;
}

/**
 * Edges as the PAYLOAD carries them: every import, call and external ref in the
 * serialised state. Deliberately not `graph.edges.length` — see the note at the
 * call site. This is the exact quantity `ciValidate.ts` recomputes.
 */
function countStateEdges(state: { files: Record<string, unknown> }): number {
  let n = 0;
  for (const id of Object.keys(state.files)) {
    const r = state.files[id] as { imports: unknown[]; calls: unknown[]; externals: unknown[] };
    n += r.imports.length + r.calls.length + r.externals.length;
  }
  return n;
}

function triggerOf(eventName: string | undefined): 'merge' | 'push' | 'dispatch' | 'schedule' {
  switch (eventName) {
    case 'schedule':
      return 'schedule';
    case 'workflow_dispatch':
      return 'dispatch';
    case 'pull_request':
      // A merged PR arrives as a `push` to the tracked branch in practice; this
      // exists so the enum is total rather than because the ingress accepts the ref.
      return 'merge';
    default:
      return 'push';
  }
}

async function main(): Promise<void> {
  const endpoint = process.env.BACKTHREAD_ENDPOINT ?? 'https://clew-ingest-worker.arpy-183.workers.dev';
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('GITHUB_REPOSITORY is unset — this must run in GitHub Actions');
  const [owner, name] = repository.split('/');

  const sha = git('rev-parse', 'HEAD');
  const date = git('show', '-s', '--format=%cI', sha);
  const subject = git('show', '-s', '--format=%s', sha);
  // ⚠ THIS IS THE REF THIS RUN IS ON, WHICH IS NOT THE SAME THING AS THE REPO'S DEFAULT
  // BRANCH, AND THE WIRE FIELD IS NAMED FOR THE LATTER. Saying so rather than renaming
  // it: the field crosses a version-gated contract, and the ingress does not trust it
  // either way — it compares this against the tracked branch on the repo row and
  // refuses a mismatch with `ref_not_tracked_branch`. So the misnomer costs a reader a
  // moment and cannot cost a snapshot anything, and the authority stays on our side
  // where a customer's runner cannot move it.
  const defaultBranch = (process.env.GITHUB_REF_NAME ?? 'main').trim();

  console.log(`[backthread] extracting ${repository} @ ${sha.slice(0, 7)} …`);
  const engine = new IncrementalExtractor();
  // ⚠ `seedFull` — the SAME entry point `container.ts` calls on a clone. Anything
  // else here would make the convergence a coincidence rather than a property.
  const { graph } = engine.seedFull(process.cwd(), sha);
  const state = engine.stateSnapshot();

  // ONE tracked-file list, read once and handed to both collectors. Two calls would
  // be two chances for the two of them to disagree about what "tracked" means.
  const tracked = trackedFiles();
  const workspaceManifests = collectManifests(tracked);
  const infra = await collectInfra();
  const envServices = collectEnvServices(tracked);
  // ⚠ THE NOISE-FILTERED GRAPH, which is what `seedFull` returns and what the clone
  // path hands `collectFrameworkContributions`. Passing the unfiltered one would give
  // the adapters a different file set to resolve against than the server clusters,
  // and the divergence would look like an adapter bug.
  const framework = await collectFramework(graph);

  // ⚠ TYPED AS `CiSnapshotPayload`, WHICH IS THE GUARD RATHER THAN A TIDY-UP. This
  // object literal was untyped, so when a REQUIRED `envServices` was added to
  // the wire contract, nothing here failed to compile — the runner would simply have
  // stopped sending a required field and learned about it from a 400 on a customer's
  // build. A wire contract that the producer does not compile against is a contract
  // only one side is holding.
  const payload: CiSnapshotPayload = {
    // ⚠ IMPORTED, NOT THE LITERAL `2`. The wire version was bumped because v2
    // carries a REQUIRED `infra`, and the ingress refuses any other value. A hand-
    // typed number here is a version skew that shows up as a 400 nobody can read.
    payloadVersion: CI_PAYLOAD_VERSION,
    actionVersion: ACTION_VERSION,
    extractorVersion: EXTRACTOR_PACKAGE_VERSION,
    repo: { owner, name, defaultBranch },
    checkpoint: { sha, date, subject, trigger: triggerOf(process.env.GITHUB_EVENT_NAME) },
    state,
    workspaceManifests,
    infra,
    // REQUIRED on v4. An empty set is the legal "I ran detection and this
    // repo trips no adapter", which is true of most repos; an absent field would
    // render a snapshot whose framework edges are silently missing.
    framework,
    // REQUIRED on v3. `[]` is the legal "this repo has no example env
    // file"; an absent field would render a snapshot silently missing every
    // env-derived service node, which is a different artefact, not a thinner one.
    envServices,
    // The producer's own claim about its counts. The ingress cross-checks it
    // against the payload's actual contents and refuses a disagreement — so
    // sending it is how a corrupted serialisation is caught rather than rendered.
    // The producer's own claim about its own contents. Cross-checked by the ingress
    // and never trusted — sending it is how a corrupted serialisation is caught
    // rather than rendered.
    //
    // ⚠ `edges` COUNTS THE STATE, NOT THE GRAPH, AND THE DIFFERENCE IS 47%. The
    // obvious `graph.edges.length` is the wrong number: `seedFull` returns the
    // NOISE-FILTERED graph, while `counts` describes the `state` on the wire.
    // Measured on this repo: graph 1 658, state 2 435. Sending the filtered figure
    // would have been a self-report disagreeing with the payload it describes —
    // dormant today, and an instant refusal of every real payload the moment anyone
    // added the cross-check. Found by measuring rather than by reasoning about it.
    counts: {
      files: Object.keys(state.files).length,
      edges: countStateEdges(state),
      externals: new Set(graph.externals.map((x) => x.id)).size,
    },
  };

  // ⚠ THE WHOLE GATE, NOT THREE OF ITS SUB-CHECKS — the correction a reviewer forced.
  // `collectInfra`, `collectEnvServices` and `collectFramework` each ran their own
  // ingress check and each said, correctly, that it is the SAME function so the two
  // cannot disagree. What none of them said is that those three are a fraction of what
  // the ingress applies: the file ceiling, the edge caps, every string bound, path
  // safety, the unknown-field rule and the manifest count all lived server-side only.
  // So a payload one file over the ceiling was refused AFTER a full extract, which is
  // exactly the late refusal this whole pattern exists to prevent, for the majority of
  // the reasons a payload gets refused.
  //
  // ⚠ `prior: null` IS NOT A WEAKENING. The one tier this cannot reproduce is the
  // collapse check against the repo's own recorded history, which is database-resident
  // — the runner has no history and inventing one would be worse than omitting it.
  // Everything else is the identical function over the identical object, so this is a
  // strict SUBSET of the ingress's answer and can never admit something it refuses.
  assertPayloadIsAcceptable(payload, { owner, name, sha }, Date.now());

  const body = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  console.log(
    // ⚠ THE LOCAL VALUE, NOT `payload.counts?.files`. Typing the literal as
    // `CiSnapshotPayload` makes `counts` optional, and the optional chain would print
    // a silent `undefined` on the one line a workflow author reads to check the
    // extract worked.
    `[backthread] ${Object.keys(state.files).length} file(s) · ${graph.edges.length} edge(s) · ` +
      `${workspaceManifests.length} manifest(s) · ` +
      `${infra.nodes.length} infra node(s) / ${infra.edges.length} infra edge(s) · ` +
      `${envServices.length} env service(s) · ` +
      `${framework.adapters} adapter(s) / ` +
      `${framework.edges.length + framework.crossLanguageEdges.length} framework edge(s) / ` +
      `${framework.roles.length} role(s) · ` +
      `${body.byteLength} gzipped bytes`,
  );

  const token = await mintOidcToken();
  const res = await fetch(`${endpoint}/ci/snapshot`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      'x-backthread-version': ACTION_VERSION,
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    // The refusal detail is the product here: a size refusal names a ceiling the
    // workflow author can act on, and printing the status alone would throw that
    // away at the one moment it is needed.
    throw new Error(`[backthread] /ci/snapshot ${res.status}: ${text}`);
  }
  console.log(`[backthread] accepted: ${text}`);
}

main().catch((e: unknown) => {
  // ⚠ `errorMessage`, NOT `(e as Error).message`. This is the last line that runs on
  // every failed build, so it is the worst possible place for a read that assumes what
  // was thrown: a producer that throws a non-Error makes this line throw a TypeError of
  // its own, and the workflow author gets a stack trace about `undefined` instead of the
  // refusal that actually happened. Shipping the fix for that in this package and not
  // using it here would be the joke telling itself.
  console.error(errorMessage(e));
  process.exit(1);
});
