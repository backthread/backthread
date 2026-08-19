// `action.ts` — the SOURCE-STRUCTURE guards on the CI client.
//
// ⚠ WHY THESE READ THE FILE INSTEAD OF IMPORTING IT. `action.ts` calls `main()` on
// import, because it is a CLI entry point. Importing it from a test would run a
// GitHub Actions job. That is not a hypothetical gap: a verifier measured what it
// costs, and deleting the `validateInfraGraph` refusal — AND shipping the raw graph
// including `root` — both survived every other suite in this repository. Nothing
// anywhere executed this file.
//
// So the checks below are over the SOURCE TEXT, with comments stripped first, and
// they check the things that measurement showed were otherwise unguarded: not that
// the narrowing works (it is pure and tested in `narrow`), but that the client USES
// it, and refuses rather than truncating when the shared gate says no.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Source with every comment removed.
 *
 * ⚠ EVERY SOURCE GUARD IN THIS EPIC HAS BEEN DEFEATED BY PROSE AT LEAST ONCE, IN
 * BOTH DIRECTIONS. A comment naming a condition satisfied a positive assertion; a
 * comment naming a credential broke a negative one against correct code. Both are
 * the same bug — matching text that never executes. A source guard that does not
 * strip comments first is measuring documentation.
 */
function codeOnly(src: string): string {
  return (
    src
      // ⚠ LINE COMMENTS FIRST, AND THE ORDER IS THE FOURTH DEFEAT OF THIS FUNCTION.
      // It used to strip BLOCK comments first, and a `/**` written inside an ordinary
      // line comment — `// (supabase/**, package.json, next.config.*, …)` in
      // `container.ts:1403` — opened a block the non-greedy match then closed at the
      // next `*/`, **29 767 characters later**. The source handed to the guards was
      // 111 023 bytes; after stripping it was 29 320, and one of the two clone-path
      // call sites this file asserts about had simply been deleted. That turns a
      // `doesNotMatch` into a vacuous pass and a `match` into a false failure, on the
      // one function three separate security guards depend on.
      //
      // The previous three defeats were adversarial. This one was an accident, in a
      // comment nobody wrote with the stripper in mind, which is worse: it means the
      // failure needs no attacker. Stripping line comments first makes a `/*` inside
      // one unreachable by construction.
      //
      // ⚠ TRAILING COMMENTS TOO, AND THAT WAS THE THIRD DEFEAT. This used to strip only
      // LINE-INITIAL `//`, so a verifier restored an entire shipped defect —
      // `const infra = { nodes: [], edges: [] }; // infraFromPayload(` — and every gate
      // stayed green, because the positive assertions matched the parenthesis inside the
      // trailing comment. The same trick put the raw graph (and the Cloudflare account
      // id) back on the runner's wire.
      //
      // `[^:]` in front is what keeps `https://` and `git://` out of it — the one place
      // `//` legitimately appears mid-line in these files. The captured character is put
      // back so the URL survives intact.
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/\/\*[\s\S]*?\*\//g, '')
  );
}

test('codeOnly strips TRAILING comments too — the negative control for every source guard', () => {
  // ⚠ THIS TEST EXISTS BECAUSE THE STRIPPER WAS WRONG AND THE GUARDS THAT DEPEND ON IT
  // ALL PASSED ANYWAY. A verifier restored an entire shipped defect by hiding the
  // required call in a TRAILING comment; the guard's own prose claimed "comments cannot
  // satisfy this". A source guard is only as strong as its stripper, so the stripper gets
  // its own assertions rather than being trusted by three tests at once.
  assert.equal(codeOnly('const a = 1; // infraFromPayload(').trim(), 'const a = 1;');
  assert.equal(codeOnly('  // leading').trim(), '');
  assert.equal(codeOnly('a; /* block */ b;').replace(/\s+/g, ' ').trim(), 'a; b;');
  // ...and a URL is NOT a comment. Stripping it would break the negative assertions,
  // which is the other direction of the same failure.
  assert.match(codeOnly("const u = 'https://api.backthread.dev/x';"), /https:\/\/api\.backthread\.dev\/x/);
  assert.match(codeOnly("fetch('git://host//path'); // trailing"), /git:\/\/host/);
  // ⚠ AND A `/**` INSIDE A LINE COMMENT MUST NOT OPEN A BLOCK. This is the fourth
  // defeat and the only accidental one: `container.ts` carries
  // `// (supabase/**, package.json, …)`, which under block-first stripping opened a
  // comment that closed 29 767 characters later — deleting one of the two clone-path
  // call sites the guards below assert about. Measured: the stripped source went from
  // 111 023 bytes to 29 320.
  assert.match(
    codeOnly('// note: matches app/**, pages/**\nconst keep = envServicesFromPayload(x);\n/** doc */\n'),
    /const keep = envServicesFromPayload\(x\);/,
  );
  // ...and a real block comment is still stripped, or the fix traded one hole for another.
  assert.doesNotMatch(codeOnly('/** infraFromPayload( */ const a = 1;'), /infraFromPayload/);
  assert.doesNotMatch(codeOnly('/* multi\n line envServicesFromPayload( */'), /envServicesFromPayload/);
});

// ---------------------------------------------------------------------------
// WHAT A SOURCE GUARD IS FOR, AND WHAT IT IS NOT
// ---------------------------------------------------------------------------
//
// ⚠ THESE USED TO CHECK THE REFUSALS THEMSELVES, AND A VERIFIER PROVED THEY COULD NOT.
// Each of the four preflight checks sat inline in `action.ts`, and because `main()` runs
// on import, the only thing standing over them was a search of this file's source for
// the shape they were expected to have. Measured: rewriting the payload gate to
// `if (rejection && rejection.error === '__never_matches__')` — compute the refusal,
// then upload anyway — passed `tsc` and passed every test. So did `if (false &&
// rejection)`. The text said the throw was there. It was there. It never ran.
//
// The deciding now lives in `preflight.ts`, where `preflight.test.ts` CALLS it. What is
// left here is the one question text can actually answer: does `action.ts` still route
// through those functions, in the right order, on the way to the upload? A call site is
// a fact about this file's text; a refusal is a fact about behaviour, and the two need
// different instruments.
//
// `codeOnly` strips comments first, so this prose cannot satisfy anything below.

test('every collector routes through the shared preflight rather than deciding for itself', () => {
  const src = codeOnly(readFileSync(new URL('./action.ts', import.meta.url), 'utf8'));
  for (const [fn, call, why] of [
    ['async function collectInfra(', 'preparedInfra(', 'the derived infra graph'],
    ['function collectEnvServices(', 'preparedEnvServices(', 'the env-derived service list'],
    ['async function collectFramework(', 'preparedFramework(', 'the framework contributions'],
  ] as const) {
    const at = src.indexOf(fn);
    assert.ok(at > 0, `the runner must still collect ${why} in its own function`);
    const body = src.slice(at, src.indexOf('\n}', at));
    assert.match(body, new RegExp(call.replace('(', '\\(')), `${why} must go through the shared preflight`);
    // ...and it must NOT have grown a second, local opinion about the same question.
    assert.doesNotMatch(body, /throw new Error\(/, `${why} decides in preflight.ts, not here`);
  }
});

test('the env scan reads the TRACKED file list, never the working directory', () => {
  // ⚠ A REVIEWER HAD TO FIND THIS. The clone path scans a git clone, so it can only ever
  // see TRACKED files; a runner's working directory can hold an untracked or ignored
  // `.env.example` — a repo that ignores `.env*` with no negation, or a workflow step
  // that writes one. Reading it would produce service nodes the clone path can never
  // produce: the two paths diverging again, through a file we should not have been
  // reading at all. This is a source guard because the alternative is executing `main()`.
  const src = codeOnly(readFileSync(new URL('./action.ts', import.meta.url), 'utf8'));
  const at = src.indexOf('function collectEnvServices(');
  const body = src.slice(at, src.indexOf('\n}', at));
  assert.doesNotMatch(body, /readdirSync|extractEnvServiceCandidates\(/, 'it must not read a directory');
  assert.match(body, /mergeEnvServiceCandidates\(/, 'it must merge the SHIPPED contents instead');
  assert.match(body, /ENV_FILES/, "the filenames must come from the scan's own list, not a copy");
  // ...and the caller must hand it the tracked list rather than letting it find files.
  assert.match(src, /collectEnvServices\(tracked\)/, 'the tracked list is read once and passed in');
});

test('the framework phase is handed the NOISE-FILTERED graph, the same one the server clusters', () => {
  // Passing the unfiltered graph would give the adapters a different file set to resolve
  // against than the server clusters, and the divergence would read as an adapter bug.
  const src = codeOnly(readFileSync(new URL('./action.ts', import.meta.url), 'utf8'));
  assert.match(src, /collectFrameworkContributions\(\{ repoDir: process\.cwd\(\), graph \}\)/);
  assert.match(src, /collectFramework\(graph\)/, 'the tree phase takes the seedFull graph');
});

test('the whole-payload gate runs BEFORE the upload is built', () => {
  // Ordering is the half that text can prove and `preflight.test.ts` cannot: the gate
  // being correct is worth nothing if it runs after the bytes are already assembled,
  // and the entire reason it exists is to fail before the extract is paid for.
  const src = codeOnly(readFileSync(new URL('./action.ts', import.meta.url), 'utf8'));
  const gate = src.indexOf('assertPayloadIsAcceptable(');
  const gzip = src.indexOf('gzipSync(');
  const post = src.indexOf('fetch(`${endpoint}/ci/snapshot`');
  assert.ok(gate > 0, 'the client must run the full gate, not only the three narrow checks');
  assert.ok(gzip > 0, 'NEGATIVE CONTROL: the body must still be built here, or the order is vacuous');
  assert.ok(post > 0, 'NEGATIVE CONTROL: the upload must still happen here');
  assert.ok(gate < gzip, 'the gate must precede the body — after it, the extract is already paid for');
  assert.ok(gzip < post, 'and the body must precede the upload, or this file has been reordered');
});

test('the client reports a thrown value without assuming it is an Error', () => {
  // This package ships `errorMessage` precisely because `(e as Error).message` is a lie
  // the compiler accepts, and the top-level catch is the worst place to make it: a
  // producer throwing a non-Error turns the LAST line of a failed build into a TypeError
  // about `undefined`, and the workflow author never sees the refusal that happened.
  const src = codeOnly(readFileSync(new URL('./action.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(src, /\(e as Error\)\.message/);
  assert.match(src, /main\(\)\.catch\([\s\S]{0,200}errorMessage\(/);
});

test('the assembled payload routes BOTH connect inputs through the tested module', () => {
  // ⚠ THIS IS A TEXT GUARD, AND IT IS DELIBERATELY THE WEAKER HALF. The deciding —
  // which values are carried, which are dropped, what a malformed one does — lives in
  // `connect.ts` and is measured behaviourally in `connect.test.ts`, because a guard
  // over source text proves a call is PRESENT and cannot prove its answer is ACTED ON.
  // What text CAN prove is that `main()` did not quietly grow a second, untested copy
  // of either decision, which is exactly how the previous three defects got in.
  const src = codeOnly(readFileSync(new URL('./action.ts', import.meta.url), 'utf8'));
  assert.match(src, /claimFromEnv\(process\.env\)/);
  assert.match(src, /defaultBranchFrom\(\{/);
  assert.match(src, /\.\.\.\(claim \? \{ claim \} : \{\}\)/, 'absent must stay absent, not become undefined');
  // NEGATIVE CONTROL: the payload literal must still be in this file, or the three
  // assertions above are matching text in a function that no longer builds anything.
  assert.match(src, /const payload: CiSnapshotPayload = \{/);
  // And neither decision may be re-derived here.
  assert.doesNotMatch(src, /process\.env\.BACKTHREAD_CLAIM/, 'the env var is read in connect.ts only');
  assert.doesNotMatch(
    src,
    /defaultBranch = \(process\.env\.GITHUB_REF_NAME/,
    'the running ref is no longer the default branch',
  );
});

test('the claim is sent in BOTH the header and the payload, from ONE value', () => {
  // The ingress refuses a disagreement, so a second `claimFromEnv(...)` call here —
  // or a hand-typed header name — would be a way for one client to contradict itself.
  const src = codeOnly(readFileSync(new URL('./action.ts', import.meta.url), 'utf8'));
  assert.match(src, /\[CLAIM_HEADER\]: claim/, 'the header carries it');
  assert.match(src, /\.\.\.\(claim \? \{ claim \} : \{\}\)/, 'and so does the payload');
  // NEGATIVE CONTROL: exactly ONE read of the environment, so both come from it.
  const reads = src.match(/claimFromEnv\(/g) ?? [];
  assert.equal(reads.length, 1, `expected one claimFromEnv call, saw ${reads.length}`);
  assert.doesNotMatch(src, /'x-backthread-claim'/, 'the header name comes from the constant');
});
