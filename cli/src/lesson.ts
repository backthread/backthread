// lesson.ts — the thin client behind `/backthread:learn`.
//
// A lesson turns the repo's recorded *why* into a handful of questions about THIS
// codebase, and gives one binary verdict plus the recorded rationale as the
// teaching moment. Both halves live server-side (retrieval, generation, the
// adversarial quality gate, the grader); this module is a RELAY, exactly like
// query.ts: it posts `{repo}` to `/lesson/start`, posts one answer at a time to
// `/lesson/answer`, and renders what comes back. All prompt/model/grading tuning
// therefore stays server-side — no further cli publish is needed to change a
// question or a verdict.
//
// WHY IT IS A SLASH COMMAND AND NOT A TUI. This CLI has no interactive-prompt
// capability at all — no readline, no prompts library; even `backthread login` is
// poll-based rather than prompting. So `learn` prints the lesson as structured
// text and prints the exact command to submit ONE answer, and the slash command's
// "Your task" section tells the host agent to run the conversation: ask, wait for
// the person's reply, submit it, relay the verdict, move on. Drawing an
// interactive UI inside this Node process would be a second, worse chat window
// inside a chat window.
//
// FOUR PRODUCT RULES THAT MUST SURVIVE THE TERMINAL RENDERING:
//   1. The verdict is BINARY — "Got it" / "Not yet" — and is followed by the
//      recorded rationale. No score, no percentage, no history of wrong answers.
//      Nothing here computes or accumulates one.
//   2. "I disagree" and "Bad question" are OFFERED beside the verdict on every
//      answerable question and cost the person nothing. They are printed as
//      first-class options, not buried, because disagreeing has to feel legitimate
//      rather than like filing a complaint — the recorded why can be the thing
//      that is wrong.
//   3. An OPEN question is never graded. It is labelled as a contribution, and its
//      response says the answer was recorded — a person must never think they
//      failed something that had no answer.
//   4. A `teaching-card` or `caught-up` lesson is a REAL, VALID completion. The
//      copy never pads it out and never implies the person fell short because the
//      repo was quiet.
//
// READ-ONLY ON THE MACHINE: no source is read and nothing but the repo slug, a
// question id and the person's own typed answer leaves it.

import { readConfig, type BackthreadConfig } from './config.js';
import { type RemoteReader, type RepoHandle } from './repo.js';
import { resolveQueryRepo } from './query.js';
import { buildLessonStartUrl, buildLessonAnswerUrl } from './urls.js';
import { versionHeaders } from './version.js';

// The server races its own build against a ~55s ceiling (three model phases on a
// thin day). Bound the client a bit above that so a build that legitimately used
// its whole budget still lands, while a black-hole endpoint yields a clean failure
// instead of hanging the slash command.
//
// NO AUTOMATIC RETRY, unlike /grounded-ask: a start is NOT free (it generates and
// judges questions) and the server holds a per-person build lock, so a retry would
// either pay twice or collide with its own first attempt and 409. A timeout is
// reported honestly and the person can re-run the command.
const LESSON_START_TIMEOUT_MS = 90_000;

// Grading is one model call. Also un-retried — a resubmission would re-grade (and
// re-charge) the same answer.
const LESSON_ANSWER_TIMEOUT_MS = 60_000;

// --- the response contract (mirrors the worker; kept structural) ---------------
// Declared here rather than imported so the cli package never reaches into the
// worker bundle. The server owns generation and grading; we only render.

export type LessonRung = 'teach' | 'recognise' | 'produce';

/** `teaching-card` and `caught-up` are first-class COMPLETIONS, not failures. */
export type LessonKind = 'graded' | 'teaching-card' | 'caught-up';

export interface LessonItem {
  /** The question id an answer is submitted against. Null only on an unsaved item. */
  id: string | null;
  ordinal: number;
  rung: LessonRung;
  subsystem: string | null;
  body: string;
  /** An open question has no answer key — it is a contribution, never graded. */
  isOpen: boolean;
}

export interface Lesson {
  id: string;
  kind: LessonKind;
  repo: string;
  createdAt: string;
  /** True when the server handed back an unfinished lesson instead of generating. */
  cached: boolean;
  items: LessonItem[];
}

/** What was recorded. `got-it`/`not-yet` are the only two a MODEL may produce. */
export type AnswerOutcome = 'got-it' | 'not-yet' | 'disagree' | 'bad-question' | 'answered-open';

/** The caller-declared outcomes — never a verdict, never graded, never a cost. */
export type DeclaredOutcome = 'disagree' | 'bad-question';

export function isDeclaredOutcome(v: unknown): v is DeclaredOutcome {
  return v === 'disagree' || v === 'bad-question';
}

/** The teaching moment, shown for BOTH verdicts. */
export interface LessonReveal {
  decided: string | null;
  why: string | null;
  /** The recorded material the question came from — this IS the answer key. */
  rationale: string | null;
  /** Later decisions on the same area, so "this has since changed" isn't a trap. */
  since: Array<{ title?: string | null; why?: string | null; decidedAt?: string | null }>;
}

/** What the outcome did to the RECORD (not to the person — no record is kept of that). */
export interface LessonEffect {
  kind: string;
  [k: string]: unknown;
}

export interface LessonAnswerResult {
  questionId: string;
  /**
   * What was recorded — or `null` when the server sent something this client does
   * not recognize. DELIBERATELY nullable rather than defaulted: the obvious
   * fallback, `not-yet`, is the one label this feature must never show by
   * accident, and inventing a negative verdict out of a shape we failed to parse
   * is exactly the failure the whole grading design is arranged around.
   */
  outcome: AnswerOutcome | null;
  /** 'got-it' | 'not-yet', or null when the answer was RECORDED rather than graded. */
  verdict: 'got-it' | 'not-yet' | null;
  graded: boolean;
  /** One sentence from the grader, addressed to the person. Null when ungraded. */
  note: string | null;
  reveal: LessonReveal;
  effect: LessonEffect;
  lesson: { id: string; completed: boolean };
}

// --- outcomes ------------------------------------------------------------------

export type LessonStatus =
  | 'ok' // a lesson (of any kind, including caught-up) came back
  | 'no-auth' // no device token — the person must `backthread login`
  | 'no-repo' // no repo in config and none resolvable from cwd
  | 'in-progress' // a build for this person + repo is already running
  | 'failed' // the request was rejected / the build failed
  | 'error'; // any unexpected failure (swallowed, never thrown)

export interface LessonStartOutcome {
  status: LessonStatus;
  /** Human-readable detail. Never contains the device token. */
  detail: string;
  repo?: RepoHandle;
  lesson?: Lesson;
  /** The server's non-fatal upgrade nudge, when it sent one. */
  upgrade?: string;
}

export interface LessonAnswerOutcome {
  status: LessonStatus;
  detail: string;
  result?: LessonAnswerResult;
  upgrade?: string;
}

export interface LessonDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readConfigImpl?: (env: NodeJS.ProcessEnv) => Promise<BackthreadConfig>;
  readRemoteImpl?: RemoteReader;
}

export interface LessonStartInput {
  /** Optional repo override as `owner/name` or `{owner,name}`. */
  repo?: string | { owner: string; name: string };
  /** The session's working directory, used as the repo fallback (git remote). */
  cwd?: string;
}

export interface LessonAnswerInput {
  questionId: string;
  /** The person's free text. May be empty when `outcome` is declared. */
  answer?: string;
  /** `disagree` / `bad-question` — the person's own call, never graded. */
  outcome?: DeclaredOutcome | null;
}

// --- start ---------------------------------------------------------------------

/**
 * Start (or resume) today's lesson. NEVER throws — every failure resolves to a
 * `LessonStartOutcome` the bin renders. An unfinished lesson is returned as-is by
 * the server rather than generating a second one, so re-running this command
 * mid-lesson picks up where the person left off instead of costing another build.
 */
export async function startLesson(
  input: LessonStartInput,
  deps: LessonDeps = {},
): Promise<LessonStartOutcome> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const doReadConfig = deps.readConfigImpl ?? readConfig;

  try {
    const config = await Promise.resolve()
      .then(() => doReadConfig(env))
      .catch(() => ({}) as BackthreadConfig);

    if (!config.device_token) {
      return {
        status: 'no-auth',
        detail: 'not authenticated — run `backthread login` first (no device token in config).',
      };
    }

    // Same repo precedence as the grounded ask: explicit → configured → cwd remote.
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
      buildLessonStartUrl(env),
      config.device_token,
      { repo: `${repo.owner}/${repo.name}` },
      LESSON_START_TIMEOUT_MS,
    );
    // A timeout and a transport error read the same to the caller — `res.detail`
    // already names which one it was, and neither is retried (see the header).
    if (!res.ok) return { status: 'failed', detail: res.detail, repo };

    const rec = res.payload;
    const upgrade = readUpgrade(res.upgradeHeader, rec);
    if (res.status === 409) {
      return {
        status: 'in-progress',
        detail:
          serverMessage(rec) ??
          'a lesson is already being prepared for this repo — try again in a moment.',
        repo,
        ...(upgrade ? { upgrade } : {}),
      };
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        status: 'failed',
        detail: `lesson start rejected (${res.status})${serverMessage(rec) ? `: ${serverMessage(rec)}` : ''}`,
        repo,
        ...(upgrade ? { upgrade } : {}),
      };
    }

    const lesson = normalizeLesson(rec, `${repo.owner}/${repo.name}`);
    if (!lesson) {
      return { status: 'failed', detail: 'lesson start returned no lesson.', repo };
    }
    return {
      status: 'ok',
      detail: `${lesson.kind} lesson · ${lesson.items.length} item(s)`,
      repo,
      lesson,
      ...(upgrade ? { upgrade } : {}),
    };
  } catch (e) {
    return { status: 'error', detail: `lesson failed (swallowed): ${(e as Error).message}` };
  }
}

// --- answer --------------------------------------------------------------------

/**
 * Submit ONE answer (or one declared outcome). NEVER throws. The server decides
 * the verdict — nothing here grades, and nothing here can grant a `got-it`.
 */
export async function answerLesson(
  input: LessonAnswerInput,
  deps: LessonDeps = {},
): Promise<LessonAnswerOutcome> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const doReadConfig = deps.readConfigImpl ?? readConfig;

  try {
    const questionId = (input.questionId ?? '').trim();
    if (!questionId) {
      return { status: 'failed', detail: 'a question id is required — see the ids printed by `backthread learn`.' };
    }
    const declared = isDeclaredOutcome(input.outcome) ? input.outcome : null;
    const answer = typeof input.answer === 'string' ? input.answer : '';
    if (!declared && answer.trim().length === 0) {
      return {
        status: 'failed',
        detail: 'an answer is required — type what you think, or send "I disagree" / "Bad question" instead.',
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
      buildLessonAnswerUrl(env),
      config.device_token,
      { questionId, answer, ...(declared ? { outcome: declared } : {}) },
      LESSON_ANSWER_TIMEOUT_MS,
    );
    if (!res.ok) return { status: 'failed', detail: res.detail };

    const rec = res.payload;
    const upgrade = readUpgrade(res.upgradeHeader, rec);
    if (res.status < 200 || res.status >= 300) {
      return {
        status: 'failed',
        detail: `answer rejected (${res.status})${serverMessage(rec) ? `: ${serverMessage(rec)}` : ''}`,
        ...(upgrade ? { upgrade } : {}),
      };
    }

    const result = normalizeAnswer(rec, questionId);
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

// --- transport -----------------------------------------------------------------

interface PostResult {
  ok: boolean;
  /** Only meaningful when ok. */
  status: number;
  payload: Record<string, unknown>;
  detail: string;
  timedOut: boolean;
  upgradeHeader: string | null;
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
        // Bearer device token — never logged, never printed.
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
      timedOut: false,
      upgradeHeader: res.headers?.get?.('x-backthread-upgrade') ?? null,
    };
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    return {
      ok: false,
      status: 0,
      payload: {},
      detail: aborted
        ? `timed out after ${Math.round(timeoutMs / 1000)}s — try again.`
        : `request failed: ${(e as Error).message}`,
      timedOut: aborted,
      upgradeHeader: null,
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

function readUpgrade(header: string | null, rec: Record<string, unknown>): string | undefined {
  if (header && header.length > 0) return header;
  return typeof rec.upgrade === 'string' && rec.upgrade.length > 0 ? rec.upgrade : undefined;
}

// --- defensive normalizers ------------------------------------------------------
// The endpoints own the shapes; we never trust a network payload blindly.

const RUNGS: LessonRung[] = ['teach', 'recognise', 'produce'];
const KINDS: LessonKind[] = ['graded', 'teaching-card', 'caught-up'];

export function normalizeLesson(raw: unknown, fallbackRepo: string): Lesson | null {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const l = (rec.lesson && typeof rec.lesson === 'object' ? rec.lesson : null) as Record<
    string,
    unknown
  > | null;
  if (!l) return null;
  const kind = KINDS.includes(l.kind as LessonKind) ? (l.kind as LessonKind) : 'graded';
  const items = Array.isArray(l.items) ? l.items.map(normalizeItem) : [];
  return {
    id: String(l.id ?? ''),
    kind,
    repo: typeof l.repo === 'string' && l.repo ? l.repo : fallbackRepo,
    createdAt: typeof l.createdAt === 'string' ? l.createdAt : '',
    cached: l.cached === true,
    items,
  };
}

function normalizeItem(raw: unknown, index: number): LessonItem {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : null,
    ordinal: typeof r.ordinal === 'number' ? r.ordinal : index + 1,
    rung: RUNGS.includes(r.rung as LessonRung) ? (r.rung as LessonRung) : 'recognise',
    subsystem: typeof r.subsystem === 'string' && r.subsystem ? r.subsystem : null,
    body: String(r.body ?? ''),
    isOpen: r.isOpen === true,
  };
}

const OUTCOMES: AnswerOutcome[] = ['got-it', 'not-yet', 'disagree', 'bad-question', 'answered-open'];

export function normalizeAnswer(raw: unknown, fallbackQuestionId: string): LessonAnswerResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rev = (r.reveal && typeof r.reveal === 'object' ? r.reveal : {}) as Record<string, unknown>;
  const eff = (r.effect && typeof r.effect === 'object' ? r.effect : {}) as Record<string, unknown>;
  const les = (r.lesson && typeof r.lesson === 'object' ? r.lesson : {}) as Record<string, unknown>;
  return {
    questionId: typeof r.questionId === 'string' && r.questionId ? r.questionId : fallbackQuestionId,
    // Unrecognized → null, never `not-yet`. See LessonAnswerResult.outcome.
    outcome: OUTCOMES.includes(r.outcome as AnswerOutcome) ? (r.outcome as AnswerOutcome) : null,
    verdict: r.verdict === 'got-it' || r.verdict === 'not-yet' ? r.verdict : null,
    graded: r.graded === true,
    note: typeof r.note === 'string' && r.note ? r.note : null,
    reveal: {
      decided: typeof rev.decided === 'string' && rev.decided ? rev.decided : null,
      why: typeof rev.why === 'string' && rev.why ? rev.why : null,
      rationale: typeof rev.rationale === 'string' && rev.rationale ? rev.rationale : null,
      since: Array.isArray(rev.since)
        ? rev.since.map((s) => {
            const n = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
            return {
              title: typeof n.title === 'string' ? n.title : null,
              why: typeof n.why === 'string' ? n.why : null,
              decidedAt: typeof n.decidedAt === 'string' ? n.decidedAt : null,
            };
          })
        : [],
    },
    effect: { kind: typeof eff.kind === 'string' ? eff.kind : 'none', ...eff },
    lesson: {
      id: typeof les.id === 'string' ? les.id : '',
      completed: les.completed === true,
    },
  };
}

// --- invocation + stdin ----------------------------------------------------------

/**
 * The absolute command a follow-up answer is submitted with, derived from how THIS
 * process was started rather than hardcoded — so it is correct for a plugin copy
 * (`node <plugin>/dist-bundle/backthread.js`), a global install, and an npx run
 * alike. It has to be absolute because the host agent submits the answer from a
 * plain shell later in the conversation, where `${CLAUDE_PLUGIN_ROOT}` is not set.
 */
export function learnInvocation(argv: string[] = process.argv): string {
  const self = argv[1];
  if (!self) return 'backthread learn';
  return `node "${self}" learn`;
}

/**
 * Read an answer off stdin. A TTY (nothing piped) resolves to '' rather than
 * hanging, so a person typing `backthread learn --answer <id>` by hand gets the
 * "an answer is required" message instead of a stuck terminal.
 */
export function readStdinText(stdin: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stdin.isTTY) return Promise.resolve('');
  return new Promise((resolveText) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => (data += chunk));
    stdin.on('end', () => resolveText(data));
    stdin.on('error', () => resolveText(''));
  });
}

// --- rendering ------------------------------------------------------------------
//
// Plain text for a terminal + a host agent to read. Deliberately verdict-only:
// nothing below counts anything, ranks anything, or reports how many were missed.

/** The label a rung wears in the printed lesson. */
function rungLabel(item: LessonItem): string {
  if (item.rung === 'teach') return 'TEACH — nothing to answer, this one just tells you';
  if (item.isOpen) return 'OPEN — no recorded answer; your reply becomes the record';
  return item.rung === 'produce' ? 'QUESTION (in your own words)' : 'QUESTION';
}

/**
 * Render a started lesson. `submitCommand` is the absolute invocation the host
 * agent uses to submit one answer — resolved at runtime rather than hardcoded, so
 * it is correct for a plugin copy, a global install, or an npx run alike.
 */
export function formatLesson(outcome: LessonStartOutcome, submitCommand: string): string {
  if (outcome.status !== 'ok' || !outcome.lesson) {
    const lines = [`backthread learn: ${outcome.detail}`];
    if (outcome.status === 'no-auth') lines.push('Run `backthread login`, then try again.');
    if (outcome.upgrade) lines.push(outcome.upgrade);
    return lines.join('\n');
  }

  const lesson = outcome.lesson;
  const out: string[] = [];
  out.push(`Backthread lesson — ${lesson.repo}`);
  out.push(`lesson-id: ${lesson.id}${lesson.cached ? ' (resuming the one you left unfinished)' : ''}`);
  out.push('');

  // A quiet repo is a COMPLETE lesson. Say so plainly and stop — never pad, and
  // never imply the person fell short because nothing was recorded this week.
  if (lesson.kind === 'caught-up' || lesson.items.length === 0) {
    out.push("You're caught up. Nothing new worth asking about has landed here since last time.");
    out.push('That is the whole lesson — a quiet repo is a finished lesson, not a short one.');
    if (outcome.upgrade) out.push('', outcome.upgrade);
    return out.join('\n');
  }

  if (lesson.kind === 'teaching-card') {
    out.push('A quiet day — there was not enough new material to build questions from,');
    out.push('so this lesson just tells you what changed. Reading it is the whole lesson.');
    out.push('');
  }

  for (const item of lesson.items) {
    const where = item.subsystem ? ` · ${item.subsystem}` : '';
    out.push(`[${item.ordinal}] ${rungLabel(item)}${where}`);
    if (item.id && item.rung !== 'teach') out.push(`question-id: ${item.id}`);
    out.push(item.body);
    out.push('');
  }

  // Only when something is actually answerable. A teaching-card day has nothing to
  // submit, and printing the submit instructions anyway would invite the host agent
  // to answer a teach card — which the server correctly refuses.
  if (!lesson.items.some((i) => i.rung !== 'teach' && i.id)) {
    out.push('Nothing to answer here — reading it is the whole lesson.');
    if (outcome.upgrade) out.push('', outcome.upgrade);
    return out.join('\n');
  }

  out.push('--- how to submit an answer ---');
  out.push('One question at a time. Pipe the person\'s own words in on stdin:');
  out.push('');
  out.push(`  ${submitCommand} --answer <question-id> <<'ANSWER'`);
  out.push('  ...their answer, verbatim...');
  out.push('  ANSWER');
  out.push('');
  out.push('Two more replies are always available, and neither costs anything:');
  out.push(`  ${submitCommand} --answer <question-id> --disagree       (the record looks wrong to me)`);
  out.push(`  ${submitCommand} --answer <question-id> --bad-question   (this question is no good)`);
  if (outcome.upgrade) out.push('', outcome.upgrade);
  return out.join('\n');
}

/** Render one submitted answer: the binary verdict, then the recorded rationale. */
export function formatLessonAnswer(outcome: LessonAnswerOutcome): string {
  if (outcome.status !== 'ok' || !outcome.result) {
    const lines = [`backthread learn: ${outcome.detail}`];
    if (outcome.status === 'no-auth') lines.push('Run `backthread login`, then try again.');
    if (outcome.upgrade) lines.push(outcome.upgrade);
    return lines.join('\n');
  }
  const text = formatAnswerResult(
    outcome.result,
    "That was the last question — you're done for today.",
  );
  return outcome.upgrade ? `${text}\n\n${outcome.upgrade}` : text;
}

/**
 * The verdict + recorded rationale, shared by the lesson and the in-flow ask so the
 * two surfaces cannot start rendering the same graded answer differently. The server
 * grades both through the SAME handler; rendering them through two copies of this
 * function is how they would quietly diverge.
 *
 * `completionLine` is what to say when the server reports the lesson finished — a
 * sitting can end, and a single in-flow ask has no sitting to be done with, so that
 * surface passes null. It is the ONLY difference between the two.
 */
export function formatAnswerResult(
  r: LessonAnswerResult,
  completionLine: string | null,
): string {
  const out: string[] = [];

  // The verdict line. BINARY, and only ever these two words — everything else is
  // a recorded outcome, not a judgement of the person.
  if (r.verdict === 'got-it') out.push('Got it.');
  else if (r.verdict === 'not-yet') out.push('Not yet.');
  else if (r.outcome === 'answered-open') {
    out.push('Recorded — thank you. Open questions are not graded: nobody had written this down,');
    out.push('so your answer is now the record for it.');
  } else if (r.outcome === 'disagree') {
    out.push('Noted — flagged against that decision as possibly out of date with the system.');
    out.push('This is not a wrong answer and it cost you nothing.');
  } else if (r.outcome === 'bad-question') {
    out.push("Noted — that one won't be asked again on this repo.");
    out.push('This is not a wrong answer and it cost you nothing.');
  } else {
    // No verdict and no outcome we recognize. Say the neutral, true thing — never
    // fill the gap with "Not yet.", which would be a verdict we were never given.
    out.push('Recorded.');
  }

  if (r.note) out.push(r.note);

  // The teaching moment. Shown for BOTH verdicts — the point of the exercise is
  // the rationale, not the mark.
  const rev = r.reveal;
  if (rev.decided || rev.why || rev.rationale) {
    out.push('');
    out.push('--- what the record says ---');
    if (rev.decided) out.push(`Decided: ${rev.decided}`);
    if (rev.why) out.push(`Why: ${rev.why}`);
    if (rev.rationale) out.push(`On record: ${rev.rationale}`);
  }
  if (rev.since.length > 0) {
    out.push('');
    out.push('Since then:');
    for (const s of rev.since) {
      const when = s.decidedAt ? ` (${s.decidedAt.slice(0, 10)})` : '';
      out.push(`  - ${s.title ?? 'a later decision'}${when}${s.why ? ` — ${s.why}` : ''}`);
    }
  }

  if (r.lesson.completed && completionLine) {
    out.push('');
    out.push(completionLine);
  }
  return out.join('\n');
}
