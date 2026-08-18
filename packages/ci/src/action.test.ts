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

test('the runner NARROWS the infra graph and refuses rather than truncating', () => {
  // ⚠ A SOURCE-STRUCTURE GUARD, AND THE REASON IS STATED RATHER THAN ASSUMED.
  // `extract-and-post.ts` calls `main()` on import, exactly like `container.ts`, so
  // importing it from a test would run a GitHub Actions job. A verifier measured what
  // that costs: deleting the `validateInfraGraph` refusal, AND shipping the raw graph
  // including `root`, both survived the full 4 747-test vitest suite and the 2 488-test
  // worker suite. Nothing anywhere executed this file.
  //
  // The two facts checked here are the two the verifier defeated. The narrowing itself
  // (`narrowInfraForWire`) is pure and tested properly in `ci-graph-boot.test.ts`;
  // what could not be tested is that the runner USES it. `codeOnly` strips comments,
  // so prose cannot satisfy either assertion.
  const src = codeOnly(
    readFileSync(new URL('./action.ts', import.meta.url), 'utf8'),
  );
  const fnAt = src.indexOf('async function collectInfra(');
  assert.ok(fnAt > 0, 'the runner must still collect infra in its own function');
  const body = src.slice(fnAt, src.indexOf('\n}', fnAt));

  assert.match(body, /narrowInfraForWire\(/, 'the graph must be narrowed, not shipped whole');
  assert.doesNotMatch(
    body,
    /nodes:\s*(result\.)?graph\.nodes/,
    'shipping the adapters\' nodes verbatim is what put a Cloudflare account id on the wire',
  );
  assert.match(body, /validateInfraGraph\(/, 'the runner must run the ingress own check first');
  assert.match(
    body,
    /throw new Error\(/,
    'a refused graph must fail the build — shipping a subset renders a false topology',
  );
});

test('the runner scans only TRACKED env files, and refuses rather than truncating', () => {
  // ⚠ THE SAME SOURCE-STRUCTURE GUARD, FOR THE SAME REASON: `extract-and-post.ts`
  // runs `main()` on import, so nothing executes it and a verifier already proved two
  // separate deletions in this file invisible to 4 747 vitest + 2 488 worker tests.
  //
  // ⚠ AND THE TRACKED-FILES PROPERTY IS NOT DECORATION. The clone path scans a git
  // clone, so it can only ever see TRACKED files; a runner's working directory can
  // hold an untracked or gitignored `.env.example` (a repo that gitignores `.env*`
  // with no `!.env.example` negation, or a workflow step that writes one). Reading it
  // would produce env-derived service nodes the clone path can never produce, and
  // those land in `assemble`'s `nodes` — so the two front doors would diverge again,
  // by a file we should not have been reading. Found in review, not by a test.
  const src = codeOnly(
    readFileSync(new URL('./action.ts', import.meta.url), 'utf8'),
  );
  const fnAt = src.indexOf('function collectEnvServices(');
  assert.ok(fnAt > 0, 'the runner must still collect env services in its own function');
  const body = src.slice(fnAt, src.indexOf('\n}', fnAt));

  assert.doesNotMatch(
    body,
    /extractEnvServiceCandidates\(/,
    'that helper stats the working directory — on a runner that is not a git clone',
  );
  assert.match(body, /mergeEnvServiceCandidates\(/, 'it must merge the SHIPPED contents instead');
  assert.match(body, /ENV_FILES/, 'the filenames must come from the scan own list, not a copy');
  assert.match(body, /narrowEnvForWire\(/, 'only the derived NAMES may cross, never `vars`');
  assert.match(body, /validateEnvServices\(/, 'the runner must run the ingress own check first');
  assert.match(
    body,
    /throw new Error\(/,
    'a refused list must fail the build — shipping a subset renders a false service set',
  );

  // ...and the tracked-file list is what reaches it. Checked at the CALL SITE,
  // because a perfect `collectEnvServices` handed `readdirSync()` would satisfy every
  // assertion above.
  assert.match(
    src,
    /const tracked = trackedFiles\(\);/,
    'the runner must take one tracked-file list',
  );
  assert.match(
    src,
    /collectEnvServices\(tracked\)/,
    'and hand it to the env scan, not a directory',
  );
});

test('the runner runs the framework TREE phase and refuses rather than truncating', () => {
  // ⚠ THE SAME SOURCE-STRUCTURE GUARD, THIRD FIELD, SAME REASON: `extract-and-post.ts`
  // runs `main()` on import, so nothing executes it and a verifier already proved two
  // separate deletions in this file invisible to 4 747 vitest + 2 488 worker tests.
  //
  // What matters here is WHICH function it calls. `collectFrameworkContributions` is
  // the TREE half of the published step; `contributeFrameworkGraph` is the whole
  // thing and needs a cluster the runner does not have. Calling the composition would
  // fail at runtime on a customer's build, and calling a hand-rolled loop would be a
  // second definition of what a framework contributes.
  const src = codeOnly(
    readFileSync(new URL('./action.ts', import.meta.url), 'utf8'),
  );
  const fnAt = src.indexOf('async function collectFramework(');
  assert.ok(fnAt > 0, 'the runner must still collect framework contributions in its own function');
  const body = src.slice(fnAt, src.indexOf('\n}', fnAt));

  assert.match(body, /collectFrameworkContributions\(/, 'it must run the published TREE phase');
  assert.doesNotMatch(
    body,
    /applyFrameworkContributions\(/,
    'the cluster phase is ours — the runner has no cluster and must not invent one',
  );
  assert.match(body, /validateFrameworkContributions\(/, 'the runner must run the ingress own check first');
  assert.match(
    body,
    /throw new Error\(/,
    'a refused set must fail the build — shipping a subset renders a false framework topology',
  );
  // ...and it is handed the NOISE-FILTERED graph, the same one the server clusters.
  assert.match(src, /collectFramework\(graph\)/, 'the tree phase takes the seedFull graph');
});
