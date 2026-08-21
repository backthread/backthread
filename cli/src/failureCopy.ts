// failureCopy.ts — the ONE place a server failure becomes a sentence a person reads.
//
// "One place" is a claim the registry at the bottom of this file is answerable for, and
// `failureCopy.test.ts` drives every endpoint it classifies as rendered through a real
// rejection. Two entries were classified `never-shown` in the first draft on the strength
// of a plausible-sounding reason, and both were wrong — see the notes on them.
//
// THE CONTRACT THIS EXISTS TO CONSUME. The worker's relayed-failure body carries
// machine codes and nothing else:
//
//     { error: '<machine_slug>', reason: 'overloaded' | 'unavailable', code?: '<SQLSTATE>' }
//
// There is deliberately NO `message` key on such a body — the server strips it — because
// the client is the only layer that knows what the person was doing when it failed, so the
// client owns every user-facing sentence. `reason` is the whole point: `overloaded` means
// the database was busy and the same request will probably work in a moment; `unavailable`
// means we do not know that, so promising a retry would be a lie.
//
// ⚠ WHAT WENT WRONG, AND WHY THIS IS A MODULE RATHER THAN A HABIT. The server half of that
// contract shipped across seven routes, five of which this package calls. The client half did not, so the wire got strictly
// more actionable while the terminal still printed `grounded-ask rejected (502):
// retrieval_failed` — a raw internal slug, from which a person can conclude nothing at all.
// The reason it stayed broken is that SEVEN modules each had their own copy of the same
// `message ?? String(error)` logic — two as a named `serverMessage()` helper, five inlined
// as a nested ternary at the call site. Fixing
// the one that was reported would have fixed one route and left four, which is exactly how
// a defect recurs one endpoint at a time. There is now one renderer and one registry, and
// failureCopy.test.ts fails when a new endpoint appears without a disposition — because an
// endpoint can only be born in `urls.ts`, which is forbidden to fetch, and every export
// there that is not an origin helper must be in this table.
//
// WHAT IS AND IS NOT PRODUCT COPY. `error` and `code` are OPERATOR fields. A SQLSTATE is
// obviously one; a slug like `lesson_persist_failed` is no less one — it names an internal
// call site, tells a user nothing they can act on, and is the literal defect in this
// module's history. Both are therefore hidden by default and printed only when someone
// asks for them with `--verbose` / `BACKTHREAD_VERBOSE=1`, which is the difference between
// a user and an operator: the operator asked.

/**
 * The two verdicts the server is willing to give. Mirrors the worker's `FailureReason`
 * structurally (the cli never imports from the worker bundle) — two values, because two
 * values is what changes the sentence: one of them can honestly promise that a retry helps.
 */
export type FailureReason = 'overloaded' | 'unavailable';

const REASONS: readonly FailureReason[] = ['overloaded', 'unavailable'];

/**
 * The retry verdict, in plain words. This is the half of the sentence that actually
 * changes what somebody does next, which is why it lives in exactly one place: two copies
 * would be free to disagree about whether trying again is worth it.
 */
const REASON_CLAUSE: Readonly<Record<FailureReason, string>> = Object.freeze({
  overloaded: 'The database was busy — try again in a moment.',
  unavailable: 'It failed on our side, so retrying will not help.',
});

const ISSUES_URL = 'https://github.com/backthread/backthread/issues';

/**
 * ⚠ "RETRYING WILL NOT HELP" IS ONLY HALF A SENTENCE WITHOUT THIS. Telling somebody their
 * one available action is useless and then stopping leaves them with nothing to do, which
 * is the state the ticket asks us not to leave a reader in. The step differs by reader,
 * which is exactly what the verbose switch already knows: a reader is told how to GET the
 * detail, an operator already has it and is told where to send it.
 *
 * ⚠ AND IT IS FOR BUGS ONLY — see `looksLikeABug`. The first draft appended it to the
 * step-4 fallback unconditionally, which sent every unmapped 4xx to the issue tracker: a
 * lesson rate limit, an authorization refusal, a repo somebody cannot write to. Telling a
 * person to file a bug about a working permission check is worse than telling them
 * nothing, because it is confidently wrong.
 *
 * ("the detail above" was also a lie — the operator suffix is appended to the END of this
 * same line, not above it.)
 */
function nextStep(verbose: boolean): string {
  return verbose
    ? ` If it keeps happening, report the detail at the end of this line at ${ISSUES_URL}`
    : ` If it keeps happening, set BACKTHREAD_VERBOSE=1 (or pass --verbose) and report what that prints at ${ISSUES_URL}`;
}

/**
 * Is this plausibly OUR fault rather than an answer to the request?
 *
 * A 4xx is the server answering: not connected, not a member, too soon, not yours. Those
 * are the system working. A 5xx — and `reason: 'unavailable'`, which only ever rides one —
 * is the system not working, and that is the only case worth a stranger's time to report.
 */
function looksLikeABug(status: number): boolean {
  return status >= 500;
}

export interface FailureCopyInput {
  /**
   * What did not happen, from the reader's point of view — "the answer didn't come back",
   * "your answer wasn't recorded". The caller writes it because only the caller knows what
   * the person was doing; this module supplies the verdict that follows it, as a SECOND
   * SENTENCE. Two sentences rather than one dashed clause because the presenter above this
   * already prefixes `query: read-failed — `, and a line carrying three em-dashes stops
   * being a sentence and starts being a log entry.
   */
  lead: string;
  /** The HTTP status. Shown only under verbose (a number is an operator field too). */
  status: number;
  /** The parsed response body. Any shape — this module never trusts it. */
  payload: Record<string, unknown>;
  /** Where `BACKTHREAD_VERBOSE` is read from. Defaults to the real environment. */
  env?: NodeJS.ProcessEnv;
  /**
   * ROUTE-SPECIFIC sentences, layered over the global {@link SLUG_COPY}.
   *
   * The global table is where a slug that means the same thing everywhere belongs, and it
   * is applied by default precisely so no call site has to remember it. This argument is
   * for the remainder: a slug whose meaning is genuinely local to one route. `ask_expired`
   * is the case — on `/inflow/answer` it means the design working, and there is no sentence
   * about it that would be true anywhere else.
   */
  overrides?: Readonly<Record<string, string>>;
}

/** Read the `reason` field, or null when the body does not carry the failure contract. */
export function readFailureReason(payload: Record<string, unknown>): FailureReason | null {
  const raw = payload.reason;
  return typeof raw === 'string' && REASONS.includes(raw as FailureReason)
    ? (raw as FailureReason)
    : null;
}

/**
 * A machine code: lowercase, digits and underscores. `retrieval_failed`, `not_a_member`.
 *
 * ⚠ THE PREDICATE THIS MODULE WAS MISSING, AND ITS ABSENCE WAS A REGRESSION. The first
 * draft assumed `error` is ALWAYS a slug and hid it unconditionally. It is not: the same
 * field carries worker-AUTHORED English about the caller's own request —
 * `repo not found or not connected to Backthread`, `not authorized to read this repo`,
 * `no repo given and none connected — pass repo:"owner/name"`. Hiding those made the three
 * most common non-transient failures of `how` / `learn` / `ask-me` read WORSE than before
 * the fix: a reader who used to be told their repo was not connected got `the server
 * rejected it (HTTP 404)`.
 *
 * The rule is the server's own, mirrored: what EXCLUDES prose is the first space, colon,
 * brace or capital. A value that passes is an operator field and stays behind `--verbose`;
 * a value that fails it is a sentence somebody wrote for a reader, and is rendered.
 */
const MACHINE_CODE = /^[a-z][a-z0-9_]*$/;

export function isMachineCode(raw: string): boolean {
  return MACHINE_CODE.test(raw);
}

/** Read `error` whatever its kind, or null. */
function readErrorField(payload: Record<string, unknown>): string | null {
  const raw = payload.error;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Read the machine slug (`error`), or null. An OPERATOR field — never rendered by default. */
export function readFailureSlug(payload: Record<string, unknown>): string | null {
  const raw = readErrorField(payload);
  return raw !== null && isMachineCode(raw) ? raw : null;
}

/**
 * Read `error` when it is a sentence the server wrote FOR THIS READER, rather than a slug.
 *
 * ⚠ GATED ON THE STATUS, AND THAT GATE IS THE WHOLE POINT. "Not a machine code" is not the
 * same as "written for a person". A 4xx `error` string is the server answering the caller's
 * own request — `repo not found or not connected to Backthread`, `no repo given and none
 * connected — pass repo:"owner/name"` — and rendering those verbatim is right; hiding them
 * was a measured regression. But several Edge Functions this package calls do
 * `json({ error: message }, 500)` with the caught upstream string, so on a 5xx the same
 * field carries `could not serialize access due to concurrent update` and
 * `permission denied for schema private`. Both fail the machine-code test, and an earlier
 * draft therefore printed them as product copy.
 *
 * Nobody writes reader-facing copy for a 500. A 5xx `error` string is a relayed diagnostic,
 * so it is treated as one: operator field, `--verbose` only, and the reader gets the honest
 * "it failed on our side" with a next step instead.
 */
export function readAuthoredError(
  payload: Record<string, unknown>,
  status: number,
): string | null {
  if (status >= 500) return null;
  const raw = readErrorField(payload);
  // A SPACE, because a sentence has one. Without it any camelCase or hyphenated token that
  // fails the machine-code test — `hasOwnProperty`, `not-a-thing` — was printed to a reader
  // as though somebody had written it for them.
  return raw !== null && !isMachineCode(raw) && raw.includes(' ') ? raw : null;
}

/** Read the SQLSTATE (`code`), or null. An OPERATOR field — never rendered by default. */
export function readFailureCode(payload: Record<string, unknown>): string | null {
  const raw = payload.code;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Read a SERVER-AUTHORED sentence (`message`), or null.
 *
 * On a body built by the worker's `failureBody` there is no `message` at all — its output
 * allow-list drops the key precisely so a Postgres string cannot be refilled into one — and
 * what arrives instead is worker-AUTHORED copy about the caller's own request: the 426
 * "please update backthread…" soft-block, the 409 "a lesson is already being prepared".
 * Those are complete, correct sentences and are rendered verbatim.
 *
 * ⚠ THAT ALLOW-LIST IS NOT UNIVERSAL, AND AN EARLIER DRAFT OF THIS COMMENT CLAIMED IT WAS.
 * Routes this module renders that do not go through `failureBody` at all DO pair a slug
 * with a raw upstream string — `persist_failed` (both ingest-decisions and /infer-decisions)
 * and `inference_failed`, each carrying `(e as Error).message`. Measured, that reached a
 * person as `the decisions weren't saved — duplicate key value violates unique constraint
 * "decisions_pkey"`. The fix is not a cleverer reader: both slugs are on {@link SLUG_COPY},
 * which is consulted FIRST, so neither body ever reaches this branch. A slug that pairs
 * itself with a raw diagnostic must be mapped, not sniffed.
 *
 * It exists as its own reader so a caller that wants ONLY that can ask for only that. The
 * helper it replaced was `message ?? String(error)`, which quietly degraded to printing the
 * machine slug the moment `message` was absent — and absent is the normal case.
 */
export function readServerMessage(payload: Record<string, unknown>): string | null {
  const raw = payload.message;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Is the operator detail turned on?
 *
 * An ENV VAR is the seam rather than a parsed argv flag because the surface that hit this
 * defect first — the MCP `query` tool — has no argv at all: it is called by the host agent,
 * not typed. `bin/backthread.ts` translates a `--verbose` anywhere in the command line into
 * this variable, so the flag and the variable are the same switch and cannot drift.
 */
export function verboseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.BACKTHREAD_VERBOSE ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * The operator suffix: `[status=502 error=retrieval_failed reason=overloaded code=57014]`.
 * Only fields actually present are named, so an absent SQLSTATE reads as absent rather than
 * as `code=null`.
 */
function operatorSuffix(status: number, payload: Record<string, unknown>): string {
  const parts = [`status=${status}`];
  // Only a MACHINE code goes here. Prose in `error` has already been rendered as the
  // sentence it is; repeating it as `error=repo not found or not connected to Backthread`
  // dresses a readable sentence up as a diagnostic, which is the inverse of the job.
  // A machine code always; a 5xx prose string too, because that is the one case where the
  // reader is deliberately NOT shown it and the operator is the only one who can use it.
  const slug = readFailureSlug(payload) ?? (status >= 500 ? readErrorField(payload) : null);
  if (slug) parts.push(`error=${slug}`);
  const reason = readFailureReason(payload);
  if (reason) parts.push(`reason=${reason}`);
  const code = readFailureCode(payload);
  if (code) parts.push(`code=${code}`);
  // A 5xx `message` too. It is deliberately withheld from the reader — it is upstream text
  // like `duplicate key value violates unique constraint "decisions_pkey"` — but withholding
  // it from the OPERATOR as well would just lose it, and they are the one who can act on it.
  const msg = status >= 500 ? readServerMessage(payload) : null;
  if (msg) parts.push(`message=${msg}`);
  return ` [${parts.join(' ')}]`;
}

/**
 * Turn a rejected response into the sentence a person reads.
 *
 * Order of preference, and each step is load-bearing:
 *   1. a per-slug override — the advice genuinely differs from the retry verdict;
 *   2. `reason` — the contract; this is the case the whole ticket is about;
 *   3. a server-authored `message` — NOT a relayed diagnostic. A relayed failure body has
 *      no `message` at all (the worker's deny-list drops it), so the only bodies that
 *      reach here with one are worker-AUTHORED copy about the caller's own request, and the
 *      clearest example is the 426 "please update backthread…" soft-block. Rendering that
 *      verbatim is correct; replacing it with a generic sentence would lose the upgrade
 *      instruction;
 *   4. nothing recognisable — say the server rejected it and stop. No slug, no guessing.
 *
 * NEVER THROWS and never returns an empty string: this runs on the failure path, where a
 * second failure has nowhere to go.
 */
/**
 * A complete sentence, plus the operator suffix if one was asked for.
 *
 * Two paths answer with copy of their own before `describeFailure` is reached — the 409
 * "a lesson is already being prepared" and the bare-410 expired-ask reassurance — and both
 * are RIGHT to: the server wrote the first, and the second is the design working rather
 * than a failure. But `--verbose` stopped meaning anything on them, which makes the switch
 * a lie on exactly the two paths a person is most likely to re-run.
 */
export function withOperatorDetail(
  sentence: string,
  ctx: { status: number; payload: Record<string, unknown>; env?: NodeJS.ProcessEnv },
): string {
  if (!verboseEnabled(ctx.env ?? process.env)) return sentence;
  return `${sentence}${operatorSuffix(ctx.status, ctx.payload)}`;
}

/**
 * The slug tables, consulted safely. `overrides` wins over the global table — a slug whose
 * meaning is local to one route is more specific than one that means the same everywhere —
 * and only OWN properties count, on both.
 */
function lookupIn(table: Readonly<Record<string, string>>, raw: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(table, raw)) return null;
  const v = table[raw];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function describeFailure(input: FailureCopyInput): string {
  const { lead, status, payload, overrides } = input;
  const verbose = verboseEnabled(input.env ?? process.env);
  const suffix = verbose ? operatorSuffix(status, payload) : '';

  // 1. A known code, mapped to the action it implies. Looked up on the RAW field, not on
  //    the slug-filtered one: half this table's keys ('token expired') are two words and
  //    would fail the machine-code test they are not being asked to pass.
  const wireVerdict = readFailureReason(payload);
  const raw = payload.error;
  if (typeof raw === 'string' && raw.length > 0) {
    // A ROUTE-LOCAL override wins outright — it exists because that one route knows
    // something the wire does not, which is the whole reason the argument exists.
    const local = overrides ? lookupIn(overrides, raw) : null;
    if (local !== null) return `${local}${suffix}`;
  }
  // The GLOBAL table yields to `unavailable`, and only to that. A mapped sentence is more
  // specific than a retry verdict and wins in general — but two of these end "try again",
  // and saying that over a server which has just said retrying will not help is the CLI
  // overruling the wire about the one thing the wire knows better.
  if (wireVerdict !== 'unavailable' && typeof raw === 'string' && raw.length > 0) {
    // ⚠ `hasOwn`, NOT A BARE INDEX. The lookup used to be `{ ...SLUG_COPY, ...overrides }[raw]`
    // on an object literal, which carries `Object.prototype` — so a server sending
    // `error: "toString"` made the ENTIRE user-facing line
    // `function toString() { [native code] }`, losing the lead, the verdict and the next
    // step. Eight `error` values did that. This module's own doc promises it never trusts
    // the payload's shape; an inherited property is exactly the shape it forgot.
    const mapped = lookupIn(SLUG_COPY, raw);
    if (mapped !== null) return `${mapped}${suffix}`;
  }

  // 2. The contract. The only branch that can honestly promise a retry.
  const reason = wireVerdict;
  if (reason) {
    // Both conditions, so "a 5xx sends you to the tracker, a 4xx never does" is simply
    // true rather than true-because-no-server-does-that-yet. `unavailable` only rides a
    // 5xx today; if one ever rides a 4xx, suppressing the bug report is still right.
    const tail = reason === 'unavailable' && looksLikeABug(status) ? nextStep(verbose) : '';
    return `${lead}. ${REASON_CLAUSE[reason]}${tail}${suffix}`;
  }

  // 3. A sentence somebody wrote for this reader, in either field it can arrive in. Joined
  //    with a dash rather than a full stop because it is an appositive and is not
  //    guaranteed to start with a capital.
  // ⚠ THE STATUS GATE APPLIES TO BOTH FIELDS, NOT JUST TO `error`. `readAuthoredError` was
  // gated and `message` was not, so the invariant "no raw database text" rested entirely on
  // SLUG_COPY staying exhaustive over every 5xx slug that pairs itself with an upstream
  // string — which is the convention this ticket forbids, one new server slug from failing.
  // Measured through `login --claim`: `permission denied for schema private`.
  //
  // Nobody writes reader-facing copy for a 500, in either field. Below it, both are the
  // server answering the caller's own request and both render.
  const authored =
    status >= 500 ? null : (readServerMessage(payload) ?? readAuthoredError(payload, status));
  if (authored) return `${lead} — ${authored}${suffix}`;

  // 4. Nothing recognisable. Say the status and refuse to guess — plus a next step, but
  //    only when the status says the fault is plausibly ours.
  const tail = looksLikeABug(status) ? nextStep(verbose) : '';
  return `${lead}. The server rejected it (HTTP ${status}).${tail}${suffix}`;
}

/**
 * Slugs whose right sentence is an ACTION, not a retry verdict — mapped once, for every
 * endpoint.
 *
 * ⚠ APPLIED BY DEFAULT INSIDE `describeFailure`, NOT PASSED IN BY CALL SITES, AND THAT IS
 * THE WHOLE DESIGN. The first draft made it an `overrides` argument and handed it to the
 * two Supabase-Functions call sites only. But `deviceAuth.ts` on the WORKER emits the
 * identical auth vocabulary, so one expired token produced two different answers depending
 * on which command you happened to run: `sync` said "run `backthread login` again" and
 * `how` said "the server rejected it (HTTP 401)". That is this ticket's own stated failure
 * mode — "or this recurs one endpoint at a time" — reproduced inside the fix, by the same
 * mechanism as the original: something correct that each call site had to remember. A
 * default cannot be forgotten.
 *
 * It is deliberately a small CLOSED table rather than a pattern: a slug that is not on it
 * degrades to the honest "the server rejected it", never to itself.
 *
 * `client_too_old` is absent ON PURPOSE — it ships a server-authored `message` carrying the
 * exact upgrade instruction, and the message branch renders that verbatim.
 */
const RE_AUTH = 'this device is no longer authorized — run `backthread login` again.';

const RE_INVITE =
  "you're not a member of the account that owns that repo — ask one of its owners to invite you.";
const RE_REPORT = 'nothing is wrong with what you did — it failed on our side.';

export const SLUG_COPY: Readonly<Record<string, string>> = Object.freeze({
  // --- the repo gate: worker's resolveRepoGate + read/ingest-decisions authz ---------
  repo_not_found: "that repo isn't connected to Backthread yet — run `backthread` to connect it.",
  not_a_member: RE_INVITE,
  // ⚠ THESE TWO ARE NOT "ASK AN OWNER" — THEY ARE "THERE IS NO OWNER". Both fire on
  // `!repo.account_id` — the read side reaching it only for a private repo, since a public
  // one short-circuits first. Never on a permission a reader could be granted, and the first
  // draft told the reader to ask one of its owners for an invite — advice about people who
  // do not exist. Read the producer before writing the sentence.
  // Fires on the IDENTICAL condition as `repo_not_writable` (`!repo.account_id`), so it
  // gets the identical remedy. An earlier draft named the fix on one and left the other
  // with nothing to do.
  not_readable:
    "that repo has no owning Backthread account, so there is nothing to read — run `backthread` to connect it.",
  repo_not_writable:
    "that repo has no owning Backthread account, so nothing can be saved against it — run `backthread` to connect it.",

  // --- deliberate refusals, not outages ---------------------------------------------
  // `decideSessionAdmission` on `sessionAllowance` — a CAPTURE-SESSION allowance, not a
  // decision count. "Decision limit" also echoed a pricing model that was retired.
  plan_limit:
    'this account has used its capture allowance for now — open Billing in the web app to raise it.',
  // NOT "one was built recently" — the opposite. It fires when the last few paid builds
  // left NO lesson behind and there is no cached one to serve, so the server refuses to
  // spend again for a while. Read the producer before writing the sentence.
  lesson_retry_too_soon:
    'the last few attempts for this repo found nothing worth asking about, so no more are being built for now — try again later.',
  lesson_in_progress: 'a lesson is already being prepared for this repo — try again in a moment.',
  ask_not_yours: 'that question belongs to somebody else, so it cannot be answered here.',
  // The token verifier has THREE verdicts and emits `ask_${reason}` for each. `expired` is
  // the 410 the inflow path catches by status; the other two land here, and mapping only
  // one of them left its identical sibling reading "the server rejected it (HTTP 400)".
  ask_malformed: 'that answer token is not one this client recognises — ask for a fresh question.',
  ask_material_moved:
    'the recorded material behind that question changed since it was asked, so it is not answerable any more. Nothing was recorded against you.',
  // NOT "issued to another device" — that verifies fine and comes back as `ask_not_yours`.
  // This is "we cannot establish this token is ours": forged, corrupted, or signed with a
  // key that has since rotated. The two sentences described each other's conditions.
  ask_bad_signature:
    'that answer token could not be verified, so nothing was recorded — ask for a fresh question.',

  // --- bad request: OUR bug, not the reader's -----------------------------------------
  // Named rather than left to the fallback because the fallback would say "the server
  // rejected it", which invites the reader to look for something they did wrong.
  // Only the ones a route THIS PACKAGE CALLS can emit. `ci_mode_not_enabled`,
  // `invalid_state` and `invalid_checkpoint` were on the table and belong to /ci/snapshot
  // and the git-decisions routes, which this package never calls — dead entries that no
  // test could reach and that make "the table is exhaustive" quietly meaningless.
  invalid_body: RE_REPORT,
  invalid_payload: RE_REPORT,
  invalid_field: RE_REPORT,
  'method not allowed': RE_REPORT,

  // ⚠ THESE TWO PAIR A SLUG WITH A RAW UPSTREAM STRING and are the reason the table is
  // consulted BEFORE the `message` branch. Unmapped, a reader got `the decisions weren't
  // saved — duplicate key value violates unique constraint "decisions_pkey"`. Measured.
  persist_failed: "the write didn't complete on our side. Nothing was saved; try again.",
  inference_failed: "the write-up didn't complete on our side. Nothing was saved; try again.",

  // ⚠ `forbidden`, `repo_not_connected` and `unauthorized` were here and NO reachable route
  // sends any of them — they are emitted only by routes this package never calls:
  // /ci/snapshot, the git-decisions and the billing routes. Dead entries make "the table is exhaustive" quietly meaningless, and `forbidden`'s sentence
  // had re-committed the "ask an owner who does not exist" defect in a sibling of the entry
  // written to fix it.
  //
  // --- the auth vocabulary — emitted by BOTH the worker's deviceAuth and every Function
  'invalid token': RE_AUTH,
  'token expired': RE_AUTH,
  'invalid session': RE_AUTH,
  'insufficient scope': RE_AUTH,
  'missing authorization': RE_AUTH,
});

// --- the endpoint registry -------------------------------------------------------------
//
// Every endpoint this package sends a request to, and what happens to a failure from it.
//
// THIS IS THE THING THAT STOPS THE DEFECT RECURRING, and it is a registry rather than a
// note in a review checklist because a convention is only as durable as the next author's
// memory. failureCopy.test.ts enumerates every export of `urls.ts` — the ONE module allowed
// to turn an origin into an endpoint, and the one module forbidden to fetch — and fails
// when any of them is missing from this table. So adding an endpoint is red until somebody
// says, in writing, what a person sees when it fails.
//
// ⚠ IT ASKS NOTHING ABOUT HOW THE BUILDER IS SPELLED, AND THAT IS THE POINT. Earlier
// versions tested the declaration's name, then its return type, then whether an origin
// appeared in its body — and each version was walked past by an ordinary spelling: an
// `export const`, an `export let`, a name not ending in `Url`, a return type of `URL`, an
// origin routed through a one-line private helper, `replaceAll` where `replace` was banned,
// one `const` hop before the edit, `new URL(path, base)`, an address parked in another file
// and imported. Chasing shapes was the mistake, four rounds running. Every export here is a
// builder because there is nothing else this module is for.
//
// The same test then DRIVES every `failure-body` entry through a stubbed rejection —
// checking the injected fetch was really called, so a driver cannot merely claim to have
// driven a route — and asserts the sentence is a sentence: it carries the retry verdict and
// carries neither the slug nor the SQLSTATE, unless verbose is on.
//
// Keyed by builder name rather than by URL path because the builder is what exists in this
// repository; the path is the server's to name, and this package cannot see the server.

export type EndpointDisposition =
  /** Failures are rendered through `describeFailure`. `entryPoint` names the function the
   *  conformance battery drives; there must be a driver for it in failureCopy.test.ts. */
  | { readonly renders: 'failure-body'; readonly entryPoint: string }
  /** The endpoint predates this contract and maps its own slugs to richer, more actionable
   *  sentences than a retry verdict would be. `why` says why replacing it would be a loss. */
  | { readonly renders: 'own-slug-map'; readonly why: string }
  /** A failure here is never shown to anybody — it is swallowed, fail-open, or logged. */
  | { readonly renders: 'never-shown'; readonly why: string }
  /** Not a fetch target at all: a link handed to a browser or printed for the reader. */
  | { readonly renders: 'not-a-fetch-target'; readonly why: string };

export const CLI_ENDPOINTS: Readonly<Record<string, EndpointDisposition>> = Object.freeze({
  // --- worker origin, relayed-failure contract ---------------------------------------
  buildGroundedAskUrl: { renders: 'failure-body', entryPoint: 'queryDecisions' },
  buildLessonStartUrl: { renders: 'failure-body', entryPoint: 'startLesson' },
  buildLessonAnswerUrl: { renders: 'failure-body', entryPoint: 'answerLesson' },
  buildInflowAskUrl: { renders: 'failure-body', entryPoint: 'requestAsk' },
  buildInflowAnswerUrl: { renders: 'failure-body', entryPoint: 'answerAsk' },
  // Not a `failureBody` route on the server TODAY — but it is a worker route whose failure
  // is read by a human in the capture summary, and it carried its own inlined copy of the
  // `message ?? String(error)` logic. Wiring it now costs nothing and means the route can
  // start returning the contract without a second round of this ticket.
  buildInferDecisionsUrl: { renders: 'failure-body', entryPoint: 'serverInfer' },

  // --- worker origin, nothing shown ---------------------------------------------------
  // The ONLY `never-shown` endpoint left, and the test below holds it to the strong reading
  // of that word: its module must not read `error` / `message` off the response at all, so
  // there is no sentence to leak rather than merely nobody printing one today.
  buildCaptureScopeUrl: {
    renders: 'never-shown',
    why: 'the pre-send scope preflight is FAIL-OPEN and silent by design: a failure means the hook proceeds, and printing anything would turn a non-event into noise during somebody else\'s session. It reads a verdict, never a diagnostic.',
  },

  // --- Supabase Functions origin -------------------------------------------------------
  // Same correction: `capture --manual` prints this detail under the summary, so
  // `ingest rejected (502): persist_failed` was reaching a person. The detached
  // SessionEnd hook does discard it — but "one of its two callers is silent" is not
  // "never shown", and the loud one is the one somebody is watching.
  buildIngestDecisionsUrl: { renders: 'failure-body', entryPoint: 'runCapture (persist leg)' },
  // ⚠ CLASSIFIED `never-shown` IN THE FIRST DRAFT OF THIS REGISTRY, AND THAT WAS FALSE.
  // `backthread sync` prints this outcome's detail, so a reader was getting
  // `read-decisions rejected (403): not_a_member` — the very defect, on a route the
  // registry claimed nobody ever saw. A registry whose justifications are unverified is
  // the failure mode it was built to end, so the fix is the wiring, not the prose.
  buildReadDecisionsUrl: { renders: 'failure-body', entryPoint: 'syncDecisions' },
  // Its one caller discards the detail today — but that is a fact about the CALLER, and a
  // second one would inherit a ready-made slug. Rendered, so the category below can mean
  // "the string is never even built" rather than "nobody happens to print it".
  buildOnboardingStateUrl: { renders: 'failure-body', entryPoint: 'fetchOnboardingState' },
  buildCliAuthPollUrl: {
    renders: 'own-slug-map',
    why: 'the login poll owns a state machine (pending / expired / claimed), not a failure taxonomy — each state is its own instruction to the person waiting at the terminal.',
  },
  buildExchangeClaimUrl: {
    renders: 'own-slug-map',
    why: 'the claim exchange already maps invalid_code / code_expired / code_used to specific recovery instructions naming where to get a fresh code. A generic retry verdict would be strictly less actionable, and this endpoint carries no `reason` field to key one off.',
  },

  // --- links, not requests --------------------------------------------------------------
  buildCliAuthUrl: { renders: 'not-a-fetch-target', why: 'opened in the browser during login.' },
  buildBillingUrl: { renders: 'not-a-fetch-target', why: 'printed in the upgrade nudge.' },
  buildRepoDeepLink: { renders: 'not-a-fetch-target', why: 'printed alongside an answer.' },
});
