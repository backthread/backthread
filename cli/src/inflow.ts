// inflow.ts — the thin client for ONE question that arrives in the flow.
//
// The server owns everything that matters: which question, whether there is one at
// all, the grading, and the sentences we print about what is recorded. This module
// posts `{repo, trigger}` to `/inflow/ask`, posts `{token, answer}` to
// `/inflow/answer`, and renders what comes back. Same posture as query.ts and
// lesson.ts — every tuning change lands server-side with no publish here.
//
// ═══ WHAT THIS FILE IS NOT ALLOWED TO GROW ═══
//
// Four outside reads rejected the ask-the-engineer model unprompted — "sounds like a
// daily exam", "without a mandate I doubt participation would hold", "Slack is
// faster". What makes an exam an exam is not the question, it is the gradebook. The
// server holds that line by having nowhere to write one: `/inflow/ask` performs no
// writes at all, and the question it serves exists only inside a signed, thirty-
// minute token that THIS PROCESS holds and then forgets.
//
// A client can hand the gradebook straight back by being helpful:
//
//   * NO LOCAL SPOOL. The token is opaque and is never written to disk, never
//     cached, never collected. It lives in the terminal scrollback and nowhere
//     else. A directory of unanswered asks is the queue this whole design exists
//     to prevent, and it would be trivially re-readable as "you owe us four".
//   * NO COUNTS. Nothing here counts asks shown, asks answered, asks ignored or
//     asks expired — not on screen, not on disk, not in a request body. Not per
//     person and not in aggregate.
//   * NO RE-ASK. An ignored ask is gone. Nothing on this path can reconstruct one,
//     because nothing on this path remembers one.
//   * NO PRE-EDIT TRIGGER. Founder-directed: we do not stop somebody before they
//     touch anything. `INFLOW_TRIGGERS` is the whole list of moments this client
//     may claim, and it is asserted in the tests rather than merely written down.
//
// `inflowGuards.test.ts` holds each of those against the code that actually runs —
// the request bodies on the wire, the bytes left in the config dir, the rendered
// output — so adding the forbidden thing turns the suite red instead of merely
// contradicting this comment.
//
// READ-ONLY ON THE MACHINE: no source is read. The repo slug, the opaque token and
// the person's own typed answer are the only things that leave it.

import { readConfig, type BackthreadConfig } from './config.js';
import { type RemoteReader, type RepoHandle } from './repo.js';
import { resolveQueryRepo } from './query.js';
import { buildInflowAskUrl, buildInflowAnswerUrl } from './urls.js';
import { versionHeaders } from './version.js';
import { normalizeAnswer, formatAnswerResult, type LessonRung } from './lesson.js';

/**
 * The two moments this client is allowed to claim, and the complete list.
 *
 * ⚠️ THERE IS NO `pre-edit` VALUE AND THERE MUST NEVER BE ONE. Founder-directed:
 * we do not block an engineer before they want to touch anything. The server refuses
 * a trigger it does not recognise rather than defaulting one, so a third value here
 * would be rejected on the wire too — but the point of listing them is that a guard
 * fails the moment somebody adds one, before it ever reaches a request.
 */
export const INFLOW_TRIGGERS = ['dead-time', 'on-demand'] as const;

export type InflowTrigger = (typeof INFLOW_TRIGGERS)[number];

/** Why there is no question. ALWAYS a fact about the record, never about the person. */
export type InflowReason = 'served' | 'nothing-banked' | 'nothing-new';

/**
 * The question on the wire.
 *
 * NOTE WHAT IS ABSENT: no id and no ordinal. Both are properties of a persisted row,
 * and nothing was persisted. `token` is OPAQUE — never parsed, never stored, never
 * accumulated.
 */
export interface InflowAsk {
  token: string;
  expiresAt: string;
  rung: LessonRung;
  shape: string | null;
  subsystem: string | null;
  body: string;
  isOpen: boolean;
  materialKey: string;
}

/**
 * What we promise about an in-flow ask, in the words an engineer reads.
 *
 * SERVER-PROVIDED, DELIBERATELY. These sentences are the reason somebody might
 * tolerate an unrequested question at all, and each one is a behaviour the server
 * enforces. A copy hardcoded here would be a copy that could drift from what is
 * actually true — so this client renders what it was sent and holds no sentences of
 * its own. A guard proves it by changing the payload and watching the output change.
 */
export interface InflowPromise {
  short: string;
  title: string;
  points: string[];
}

export type InflowStatus =
  | 'ok' // a well-formed reply — with or without a question in it
  | 'no-auth'
  | 'no-repo'
  | 'failed'
  | 'error';

export interface InflowAskOutcome {
  status: InflowStatus;
  detail: string;
  repo?: RepoHandle;
  /** Null is the COMMON case and a complete answer, never a degraded one. */
  ask?: InflowAsk | null;
  reason?: InflowReason;
  promise?: InflowPromise;
  upgrade?: string;
}

export interface InflowAnswerOutcome {
  status: InflowStatus;
  detail: string;
  result?: ReturnType<typeof normalizeAnswer>;
  upgrade?: string;
}

export interface InflowDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readConfigImpl?: (env: NodeJS.ProcessEnv) => Promise<BackthreadConfig>;
  readRemoteImpl?: RemoteReader;
}

/**
 * The ask budget when a hook fires it. The endpoint is bank-only — one indexed read
 * on the common path, no inference, no build — so this sits well above a warm call
 * and well below anything a person notices while their agent works. A cold worker
 * simply produces no question that once, which is already the safe outcome.
 */
export const INFLOW_DEAD_TIME_TIMEOUT_MS = 2_000;

/** The same call, asked for on purpose. A person who typed a command can wait. */
export const INFLOW_ON_DEMAND_TIMEOUT_MS = 20_000;

/** Grading is one model call, and is never retried — a resubmit would re-grade. */
export const INFLOW_ANSWER_TIMEOUT_MS = 60_000;

export interface InflowAskInput {
  trigger: InflowTrigger;
  repo?: string | { owner: string; name: string };
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Ask the server for one question. NEVER throws — every failure resolves to an
 * outcome the caller renders (or, for the dead-time hook, silently drops).
 *
 * Nothing is written anywhere as a result of calling this, on the server or here.
 */
export async function requestAsk(
  input: InflowAskInput,
  deps: InflowDeps = {},
): Promise<InflowAskOutcome> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const doReadConfig = deps.readConfigImpl ?? readConfig;

  try {
    if (!INFLOW_TRIGGERS.includes(input.trigger)) {
      return { status: 'failed', detail: `unknown trigger "${String(input.trigger)}".` };
    }

    const config = await Promise.resolve()
      .then(() => doReadConfig(env))
      .catch(() => ({}) as BackthreadConfig);
    if (!config.device_token) {
      return {
        status: 'no-auth',
        detail: 'not authenticated — run `backthread login` first (no device token in config).',
      };
    }

    const repo = resolveQueryRepo(input, config, deps.readRemoteImpl);
    if (!repo) {
      return {
        status: 'no-repo',
        detail:
          'could not determine a repo — run from the repo directory, pass repo "owner/name", or connect it first.',
      };
    }

    const res = await postJson(
      doFetch,
      buildInflowAskUrl(env),
      config.device_token,
      // The COMPLETE request body. Two fields, both of them about the repo and the
      // moment — nothing about the person, and nothing that could be tallied.
      { repo: `${repo.owner}/${repo.name}`, trigger: input.trigger },
      input.timeoutMs ?? INFLOW_ON_DEMAND_TIMEOUT_MS,
    );
    if (!res.ok) return { status: 'failed', detail: res.detail, repo };

    const upgrade = readUpgrade(res.payload);
    if (res.status < 200 || res.status >= 300) {
      return {
        status: 'failed',
        detail: `ask rejected (${res.status})${serverMessage(res.payload) ? `: ${serverMessage(res.payload)}` : ''}`,
        repo,
        ...(upgrade ? { upgrade } : {}),
      };
    }

    const promise = normalizePromise(res.payload.promise);
    const reason = normalizeReason(res.payload.reason);
    const ask = normalizeAsk(res.payload.ask);
    // A `served` reason with no parseable question is a shape we do not recognise,
    // not a question. Report it as a failure rather than rendering half of one.
    if (reason === 'served' && !ask) {
      return { status: 'failed', detail: 'the ask came back in a shape this client does not recognise.', repo };
    }
    return {
      status: 'ok',
      detail: reason,
      repo,
      ask,
      reason,
      ...(promise ? { promise } : {}),
      ...(upgrade ? { upgrade } : {}),
    };
  } catch (e) {
    return { status: 'error', detail: `ask failed (swallowed): ${(e as Error).message}` };
  }
}

export interface InflowAnswerInput {
  /** The opaque token from the ask. Never parsed, never stored. */
  token: string;
  answer?: string;
  /** The person's own call — never graded, never a wrong answer. */
  outcome?: 'disagree' | 'bad-question' | null;
}

/**
 * Submit one answer. NEVER throws. The server grades; nothing here can grant or
 * withhold a verdict, and nothing here records that an answer happened.
 */
export async function answerAsk(
  input: InflowAnswerInput,
  deps: InflowDeps = {},
): Promise<InflowAnswerOutcome> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const doReadConfig = deps.readConfigImpl ?? readConfig;

  try {
    const token = (input.token ?? '').trim();
    if (!token) {
      return { status: 'failed', detail: 'an ask token is required — it was printed with the question.' };
    }
    const declared =
      input.outcome === 'disagree' || input.outcome === 'bad-question' ? input.outcome : null;
    const answer = typeof input.answer === 'string' ? input.answer : '';
    if (!declared && answer.trim().length === 0) {
      return {
        status: 'failed',
        detail:
          'an answer is required — type what you think, or send "I disagree" / "Bad question" instead.',
      };
    }

    const config = await Promise.resolve()
      .then(() => doReadConfig(env))
      .catch(() => ({}) as BackthreadConfig);
    if (!config.device_token) {
      return {
        status: 'no-auth',
        detail: 'not authenticated — run `backthread login` first (no device token in config).',
      };
    }

    const res = await postJson(
      doFetch,
      buildInflowAnswerUrl(env),
      config.device_token,
      { token, ...(declared ? { outcome: declared } : { answer }) },
      INFLOW_ANSWER_TIMEOUT_MS,
    );
    if (!res.ok) return { status: 'failed', detail: res.detail };

    const upgrade = readUpgrade(res.payload);
    if (res.status < 200 || res.status >= 300) {
      return {
        status: 'failed',
        detail: expiryAwareDetail(res.status, res.payload),
        ...(upgrade ? { upgrade } : {}),
      };
    }

    const result = normalizeAnswer(res.payload, '');
    return {
      status: 'ok',
      detail: `recorded (${result.outcome ?? 'unrecognized outcome'})`,
      result,
      ...(upgrade ? { upgrade } : {}),
    };
  } catch (e) {
    return { status: 'error', detail: `answer failed (swallowed): ${(e as Error).message}` };
  }
}

/**
 * An expired ask is the DESIGN WORKING, not a failure the person caused, and it is
 * said that way. The rest are reported plainly with the server's own slug.
 */
function expiryAwareDetail(status: number, payload: Record<string, unknown>): string {
  const slug = serverMessage(payload) ?? '';
  if (status === 410 || slug === 'ask_expired') {
    return 'that ask has expired — it was never written down anywhere, so nothing is owed and nothing is missing. Ask for another whenever you like.';
  }
  if (slug === 'ask_material_moved') {
    return 'the recorded material behind that question changed since it was asked, so it is not answerable any more. Nothing was recorded against you.';
  }
  return `answer rejected (${status})${slug ? `: ${slug}` : ''}`;
}

// --- transport -------------------------------------------------------------------

interface PostResult {
  ok: boolean;
  status: number;
  payload: Record<string, unknown>;
  detail: string;
}

async function postJson(
  doFetch: typeof fetch,
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number,
): Promise<PostResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        // Device token — never logged, never printed.
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...versionHeaders(),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    return {
      ok: true,
      status: res.status,
      payload: (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>,
      detail: '',
    };
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    return {
      ok: false,
      status: 0,
      payload: {},
      detail: aborted ? 'timed out — try again.' : `request failed: ${(e as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function serverMessage(rec: Record<string, unknown>): string | null {
  if (typeof rec.message === 'string' && rec.message.length > 0) return rec.message;
  if (typeof rec.error === 'string' && rec.error.length > 0) return rec.error;
  return null;
}

function readUpgrade(rec: Record<string, unknown>): string | undefined {
  return typeof rec.upgrade === 'string' && rec.upgrade.length > 0 ? rec.upgrade : undefined;
}

// --- defensive normalizers --------------------------------------------------------

const RUNGS: LessonRung[] = ['teach', 'recognise', 'produce'];
const REASONS: InflowReason[] = ['served', 'nothing-banked', 'nothing-new'];

function normalizeReason(raw: unknown): InflowReason {
  // An unrecognised reason reads as "nothing to ask", which is the SILENT, honest
  // side. Guessing `served` from a shape we failed to parse would print a question
  // that may not be there.
  return REASONS.includes(raw as InflowReason) ? (raw as InflowReason) : 'nothing-new';
}

export function normalizeAsk(raw: unknown): InflowAsk | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const token = typeof r.token === 'string' ? r.token.trim() : '';
  const body = typeof r.body === 'string' ? r.body.trim() : '';
  // No token means nothing could be answered; no body means nothing could be asked.
  // Either way there is no question here, and saying so beats printing a stub.
  if (!token || !body) return null;
  return {
    token,
    expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : '',
    rung: RUNGS.includes(r.rung as LessonRung) ? (r.rung as LessonRung) : 'recognise',
    shape: typeof r.shape === 'string' && r.shape ? r.shape : null,
    subsystem: typeof r.subsystem === 'string' && r.subsystem ? r.subsystem : null,
    body,
    isOpen: r.isOpen === true,
    materialKey: typeof r.materialKey === 'string' ? r.materialKey : '',
  };
}

export function normalizePromise(raw: unknown): InflowPromise | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const short = typeof r.short === 'string' ? r.short.trim() : '';
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  const points = Array.isArray(r.points)
    ? r.points.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
  if (!short && !title && points.length === 0) return null;
  return { short, title, points };
}

// --- invocation -------------------------------------------------------------------

/**
 * The absolute command an answer is submitted with, derived from how THIS process
 * was started rather than hardcoded — correct for a plugin copy, a global install
 * and an npx run alike. It has to be absolute because the answer is submitted from a
 * plain shell later in the conversation, where `${CLAUDE_PLUGIN_ROOT}` is not set.
 */
export function askInvocation(argv: string[] = process.argv): string {
  const self = argv[1];
  if (!self) return 'backthread ask-me';
  return `node "${self}" ask-me`;
}

// --- rendering ---------------------------------------------------------------------
//
// Everything below is plain text for a terminal and a host agent to read. Nothing
// here counts, ranks, or reports how many were missed — there is no such number,
// which is the point.

/**
 * The question block, shared by the on-demand command and the dead-time hook so the
 * two surfaces cannot drift into asking differently.
 *
 * The permission to ignore leads, ahead of the question, because the permission is
 * the part that is not obvious. `promise.short` is the SERVER'S sentence, rendered
 * verbatim — we hold no copy of it.
 */
export function formatAskBlock(ask: InflowAsk, promise: InflowPromise | null, submit: string): string {
  const out: string[] = [];
  if (promise?.short) out.push(promise.short, '');

  const label = ask.isOpen
    ? 'OPEN — nothing on record answers this; a reply becomes the record'
    : ask.rung === 'produce'
      ? 'QUESTION (in their own words)'
      : 'QUESTION';
  out.push(`${label}${ask.subsystem ? ` · ${ask.subsystem}` : ''}`);
  out.push(ask.body);
  out.push('');
  out.push('To submit a reply, pipe their exact words in on stdin:');
  out.push('');
  out.push(`  ${submit} --answer '${ask.token}' <<'ANSWER'`);
  out.push('  ...their reply, verbatim...');
  out.push('  ANSWER');
  out.push('');
  out.push('The same command with --disagree or --bad-question instead of the heredoc says');
  out.push('"the record looks wrong to me" / "this question is no good". Neither is graded,');
  out.push('neither is a wrong answer, and neither costs them anything.');
  if (ask.expiresAt) {
    out.push('');
    out.push(`This ask expires on its own at ${ask.expiresAt}, and then it is simply gone.`);
  }
  return out.join('\n');
}

/**
 * The on-demand render. An empty reply is a COMPLETE answer here — no error, no
 * warning, no percentage, no "you're caught up", and nothing about how many
 * anything. It is a fact about the record.
 */
export function formatAsk(outcome: InflowAskOutcome, submit: string): string {
  if (outcome.status !== 'ok') {
    const lines = [`backthread ask-me: ${outcome.detail}`];
    if (outcome.status === 'no-auth') lines.push('Run `backthread login`, then try again.');
    if (outcome.upgrade) lines.push(outcome.upgrade);
    return lines.join('\n');
  }

  const out: string[] = [];
  if (outcome.ask) {
    out.push(formatAskBlock(outcome.ask, outcome.promise ?? null, submit));
    out.push('');
    out.push(`Why this is safe to ignore: ${submit} --promise`);
  } else if (outcome.reason === 'nothing-banked') {
    out.push('Nothing on record here to ask about yet.');
    out.push('');
    out.push('Backthread only asks about what was actually written down in this repo — the');
    out.push('decisions, why they were made, the options that were rejected. Nothing has been');
    out.push('recorded here yet, so there is nothing to ask. That is a fact about the record.');
  } else {
    out.push('Nothing on record here worth asking about right now.');
    out.push('');
    out.push('That is the whole answer, and it is a complete one — a quiet repo means nothing');
    out.push('new was written down, which is a fact about the record and not about anyone.');
  }
  if (outcome.upgrade) out.push('', outcome.upgrade);
  return out.join('\n');
}

/** Render one submitted answer — the same verdict + recorded rationale the browser shows. */
export function formatAskAnswer(outcome: InflowAnswerOutcome): string {
  if (outcome.status !== 'ok' || !outcome.result) {
    const lines = [`backthread ask-me: ${outcome.detail}`];
    if (outcome.status === 'no-auth') lines.push('Run `backthread login`, then try again.');
    if (outcome.upgrade) lines.push(outcome.upgrade);
    return lines.join('\n');
  }
  // No completion line. A lesson can end; an in-flow ask is one question and there
  // is no sitting to be "done" with — and "done for today" would imply a daily
  // quota, which is the shape this feature must never take.
  const text = formatAnswerResult(outcome.result, null);
  return outcome.upgrade ? `${text}\n\n${outcome.upgrade}` : text;
}

/**
 * The full in-product statement, behind an explicit command.
 *
 * ⚠️ EVERY SENTENCE HERE COMES FROM THE SERVER. This client deliberately holds no
 * copy of the promise: a copy is a thing that drifts, and a promise that drifts from
 * what the code does is worse than no promise at all. If the server sent none, say
 * so plainly rather than inventing a reassuring one.
 */
export function formatPromise(outcome: InflowAskOutcome): string {
  if (outcome.status !== 'ok') {
    const lines = [`backthread ask-me: ${outcome.detail}`];
    if (outcome.status === 'no-auth') lines.push('Run `backthread login`, then try again.');
    return lines.join('\n');
  }
  const promise = outcome.promise;
  if (!promise || (!promise.title && promise.points.length === 0)) {
    return 'backthread ask-me: the server sent no statement this time — nothing is being claimed here that cannot be shown.';
  }
  const out: string[] = [];
  if (promise.title) out.push(promise.title, '');
  for (const point of promise.points) out.push(`  - ${point}`);
  out.push('');
  out.push('These are properties of the code, not a policy — the client that asks you is in');
  out.push('this open-source repo and the endpoint it calls writes nothing when it asks.');
  return out.join('\n');
}
