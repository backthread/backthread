// Commanded adapter tests — an Elixir CQRS / event-sourcing framework adapter,
// mirroring oban.test.ts / phoenix.test.ts's three tiers:
//   (1) scoreCommanded is PURE (dep present/absent, commanded_* extension confidence,
//       rootPath).
//   (2) detect() runs against real tmp mix.exs dirs (+ a non-Commanded Elixir no-match,
//       a TS no-match, a nested app).
//   (3) the analysis hooks run over a REAL ElixirExtractor graph of a small on-disk
//       Commanded fixture and assert the file-id-space contributions (aggregate /
//       router / handler / projector roleTags, the `dispatch …, to:` dispatch spine
//       resolving fully-qualified AND aliased aggregates, and the accuracy degrades:
//       an unknown target + an ambiguous bare target emit NO edge). The contribute-step
//       resolves file ids to modules downstream (covered by contribute-step.test.ts).

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commandedAdapter,
  scoreCommanded,
  gatherCommandedSignals,
  type CommandedSignals,
} from './commanded.js';
import { ElixirExtractor } from '../../graph/elixir-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_SIGNALS: CommandedSignals = { hasCommanded: false, hasCommandedExtension: false };

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content);
}

// A mix.exs whose deps/0 declares the given dep atoms.
function mixExs(deps: string[]): string {
  const tuples = deps.map((d) => `      {:${d}, "~> 1.0"},`).join('\n');
  return `defmodule App.MixProject do\n  use Mix.Project\n  defp deps do\n    [\n${tuples}\n    ]\n  end\nend\n`;
}

// ---------------------------------------------------------------------------
// scoreCommanded (pure)

describe('scoreCommanded (pure)', () => {
  it('returns null with no commanded dep (generic-Elixir fallthrough)', () => {
    expect(scoreCommanded(NO_SIGNALS)).toBeNull();
    // a commanded_* extension alone is not a claim (guard the invariant).
    expect(scoreCommanded({ hasCommanded: false, hasCommandedExtension: true })).toBeNull();
  });

  it('detects Commanded on the commanded dep', () => {
    const m = scoreCommanded({ ...NO_SIGNALS, hasCommanded: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('commanded');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('raises confidence with a commanded_* extension', () => {
    const m = scoreCommanded({ hasCommanded: true, hasCommandedExtension: true });
    expect(m!.confidence).toBeGreaterThan(0.8);
    expect((m!.metadata?.signals as Record<string, boolean>).commandedExtension).toBe(true);
  });

  it('passes rootPath through', () => {
    const m = scoreCommanded({ ...NO_SIGNALS, hasCommanded: true }, 'backend');
    expect(m!.rootPath).toBe('backend');
  });
});

// ---------------------------------------------------------------------------
// detect() over real manifests

describe('commandedAdapter.detect (fs fixtures)', () => {
  let commandedRepo: string;
  let plainElixir: string;
  let tsRepo: string;

  beforeAll(() => {
    commandedRepo = mkdtempSync(join(tmpdir(), 'bt-commanded-ok-'));
    writeFileSync(
      join(commandedRepo, 'mix.exs'),
      mixExs(['commanded', 'commanded_ecto_projections', 'ecto_sql']),
    );

    plainElixir = mkdtempSync(join(tmpdir(), 'bt-commanded-plain-'));
    writeFileSync(join(plainElixir, 'mix.exs'), mixExs(['jason', 'ecto', 'phoenix']));

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-commanded-ts-'));
    writeFileSync(
      join(tsRepo, 'package.json'),
      JSON.stringify({ name: 'web', dependencies: { react: '18' } }),
    );
  });

  afterAll(() => {
    for (const d of [commandedRepo, plainElixir, tsRepo]) rmSync(d, { recursive: true, force: true });
  });

  it('detects Commanded from mix.exs deps (with commanded_* confidence)', async () => {
    const m = await commandedAdapter.detect({ repoDir: commandedRepo });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('commanded');
    expect(m!.confidence).toBeGreaterThan(0.8);
  });

  it('does NOT detect a non-Commanded Elixir repo', async () => {
    expect(await commandedAdapter.detect({ repoDir: plainElixir })).toBeNull();
  });

  it('does NOT detect a TS repo (no mix manifest)', async () => {
    expect(await commandedAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED Commanded app and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-commanded-nested-'));
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'backend'), { recursive: true });
    writeFileSync(join(nested, 'backend', 'mix.exs'), mixExs(['commanded']));
    try {
      const m = await commandedAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('backend');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('gatherCommandedSignals reads deps from mix.exs', () => {
    const s = gatherCommandedSignals(commandedRepo);
    expect(s.hasCommanded).toBe(true);
    expect(s.hasCommandedExtension).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real Commanded fixture

describe('commandedAdapter analysis (syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let ctx: FrameworkContext;
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-commanded-app-'));

    // ── Aggregate via the `use` behaviour ──
    write(
      dir,
      'lib/bank/accounts/aggregates/account.ex',
      [
        'defmodule Bank.Accounts.Aggregates.Account do',
        '  use Commanded.Aggregates.Aggregate',
        '',
        '  defstruct [:uuid, :balance]',
        '',
        '  def execute(%__MODULE__{}, %OpenAccount{} = cmd), do: %AccountOpened{uuid: cmd.uuid}',
        '  def apply(state, %AccountOpened{uuid: uuid}), do: %{state | uuid: uuid}',
        'end',
        '',
      ].join('\n'),
    );
    // ── Aggregate via the execute+apply HEURISTIC (no `use`) ──
    write(
      dir,
      'lib/bank/accounts/aggregates/user.ex',
      [
        'defmodule Bank.Accounts.Aggregates.User do',
        '  defstruct [:uuid, :email]',
        '',
        '  def execute(%__MODULE__{}, %RegisterUser{} = cmd), do: %UserRegistered{uuid: cmd.uuid}',
        '  def apply(state, %UserRegistered{uuid: uuid}), do: %{state | uuid: uuid}',
        'end',
        '',
      ].join('\n'),
    );
    // ── Aggregate in a DIFFERENT context, referenced fully-qualified from the router ──
    write(
      dir,
      'lib/bank/payments/aggregates/transfer.ex',
      [
        'defmodule Bank.Payments.Aggregates.Transfer do',
        '  use Commanded.Aggregates.Aggregate',
        '',
        '  def execute(%__MODULE__{}, %RequestTransfer{} = cmd), do: %TransferRequested{uuid: cmd.uuid}',
        '  def apply(state, %TransferRequested{}), do: state',
        'end',
        '',
      ].join('\n'),
    );

    // ── A uniquely-named aggregate referenced BARE (no router alias) → last-seg safety net ──
    write(
      dir,
      'lib/bank/accounts/aggregates/wallet.ex',
      'defmodule Bank.Accounts.Aggregates.Wallet do\n  def execute(_, _), do: []\n  def apply(s, _), do: s\nend\n',
    );

    // ── Two modules that SHARE a last segment (`Ledger`) → an ambiguous bare `to:` ──
    write(
      dir,
      'lib/bank/accounts/aggregates/ledger.ex',
      'defmodule Bank.Accounts.Aggregates.Ledger do\n  def execute(_, _), do: []\n  def apply(s, _), do: s\nend\n',
    );
    write(
      dir,
      'lib/bank/payments/aggregates/ledger.ex',
      'defmodule Bank.Payments.Aggregates.Ledger do\n  def execute(_, _), do: []\n  def apply(s, _), do: s\nend\n',
    );

    // ── Command router: aliased + fully-qualified + multi-line + unknown + ambiguous ──
    write(
      dir,
      'lib/bank/router.ex',
      [
        'defmodule Bank.Router do',
        '  use Commanded.Commands.Router',
        '',
        '  alias Bank.Accounts.Aggregates.Account',
        '  alias Bank.Accounts.Aggregates.User',
        '',
        '  # aliased single command → aliased aggregate (unique last segment)',
        '  dispatch OpenAccount, to: Account, identity: :uuid',
        '',
        '  # aliased command list, multi-line (the identity wraps onto its own line)',
        '  dispatch [RegisterUser, UpdateProfile],',
        '    to: User,',
        '    identity: :uuid',
        '',
        '  # fully-qualified aggregate reference',
        '  dispatch RequestTransfer, to: Bank.Payments.Aggregates.Transfer, identity: :uuid',
        '',
        '  # bare target with NO alias but a unique last segment → safety-net resolves it',
        '  dispatch CreditWallet, to: Wallet, identity: :uuid',
        '',
        '  # unknown/external aggregate → unresolved degrade, no edge',
        '  dispatch ArchiveThing, to: ExternalThing, identity: :uuid',
        '',
        '  # ambiguous bare target (two Ledger modules) → not guessed, no edge',
        '  dispatch PostEntry, to: Ledger, identity: :uuid',
        'end',
        '',
      ].join('\n'),
    );

    // ── Event handler (job role, no edge) ──
    write(
      dir,
      'lib/bank/accounts/handlers/welcome_handler.ex',
      [
        'defmodule Bank.Accounts.Handlers.WelcomeHandler do',
        '  use Commanded.Event.Handler, application: Bank.App, name: "WelcomeHandler"',
        '',
        '  def handle(%UserRegistered{}, _metadata), do: :ok',
        'end',
        '',
      ].join('\n'),
    );
    // ── Projector (job role, no edge) ──
    write(
      dir,
      'lib/bank/accounts/projectors/account_projector.ex',
      [
        'defmodule Bank.Accounts.Projectors.AccountProjector do',
        '  use Commanded.Projections.Ecto, application: Bank.App, name: "AccountProjector"',
        '',
        '  project(%AccountOpened{uuid: uuid}, fn multi -> multi end)',
        'end',
        '',
      ].join('\n'),
    );
    // ── A plain module — no roles, no edges ──
    write(
      dir,
      'lib/bank/plain.ex',
      'defmodule Bank.Plain do\n  def hello, do: :world\nend\n',
    );

    graph = await new ElixirExtractor().extract(dir);
    ctx = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'commanded', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    edges = await commandedAdapter.syntheticEdges!(ctx);
    roles = await commandedAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags aggregates (use OR execute+apply) as role aggregate on the locked service kind', () => {
    expect(roles.get('lib/bank/accounts/aggregates/account.ex')).toMatchObject({
      role: 'aggregate',
      kind: 'service',
    });
    // The execute+apply HEURISTIC aggregate (no `use`).
    expect(roles.get('lib/bank/accounts/aggregates/user.ex')).toMatchObject({
      role: 'aggregate',
      kind: 'service',
    });
    expect(roles.get('lib/bank/payments/aggregates/transfer.ex')).toMatchObject({
      role: 'aggregate',
      kind: 'service',
    });
  });

  it('tags the command router as role command-router on the locked gateway kind', () => {
    expect(roles.get('lib/bank/router.ex')).toMatchObject({
      role: 'command-router',
      kind: 'gateway',
    });
  });

  it('tags event handlers + projectors as job kind', () => {
    expect(roles.get('lib/bank/accounts/handlers/welcome_handler.ex')).toMatchObject({
      role: 'event-handler',
      kind: 'job',
    });
    expect(roles.get('lib/bank/accounts/projectors/account_projector.ex')).toMatchObject({
      role: 'projector',
      kind: 'job',
    });
  });

  it('does NOT tag a plain module', () => {
    expect(roles.get('lib/bank/plain.ex')).toBeUndefined();
  });

  it('only ever tags locked MODULE_KINDS values', () => {
    for (const tag of roles.values()) {
      expect(['gateway', 'frontend', 'service', 'job']).toContain(tag.kind);
    }
  });

  it('emits the dispatch spine (kind calls) resolving aliased AND fully-qualified aggregates', () => {
    const keys = new Set(edges.map(edgeKey));
    // Aliased single-command dispatch (`to: Account` via unique last-segment).
    expect(keys).toContain('lib/bank/router.ex→lib/bank/accounts/aggregates/account.ex:calls');
    // Aliased MULTI-LINE dispatch (`to: User` on its own wrapped line).
    expect(keys).toContain('lib/bank/router.ex→lib/bank/accounts/aggregates/user.ex:calls');
    // Fully-qualified dispatch (`to: Bank.Payments.Aggregates.Transfer`).
    expect(keys).toContain('lib/bank/router.ex→lib/bank/payments/aggregates/transfer.ex:calls');
    // Bare `to: Wallet` with NO router alias → resolved by the unique last-seg safety net.
    expect(keys).toContain('lib/bank/router.ex→lib/bank/accounts/aggregates/wallet.ex:calls');
    // Every dispatch edge is the locked `calls` verb from the commanded framework.
    expect(edges.every((e) => e.kind === 'calls')).toBe(true);
    expect(edges.every((e) => e.metadata?.framework === 'commanded')).toBe(true);
    expect(edges.every((e) => e.metadata?.relation === 'dispatch')).toBe(true);
  });

  it('does NOT emit an edge for an unknown target or an ambiguous bare target (accuracy over recall)', () => {
    // Unknown/external aggregate → no edge to anything named ExternalThing.
    expect(edges.some((e) => e.target.includes('external'))).toBe(false);
    // Ambiguous `to: Ledger` (two Ledger modules) → not guessed → no ledger edge at all.
    expect(edges.some((e) => e.target.endsWith('ledger.ex'))).toBe(false);
    // Only the four resolvable aggregates (Account, User, Transfer, Wallet) are targets.
    expect(edges.length).toBe(4);
  });

  it('does NOT emit edges from handlers / projectors (roles-only, best-effort degrade)', () => {
    expect(edges.some((e) => e.source.includes('handlers'))).toBe(false);
    expect(edges.some((e) => e.source.includes('projectors'))).toBe(false);
  });

  it('is deterministic across a genuinely fresh re-parse (stable ordering + values)', async () => {
    // A NEW context object → the WeakMap analysis cache MISSES → analyzeCommanded
    // re-reads + re-parses the fixture from disk.
    const ctx2: FrameworkContext = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'commanded', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    const e2 = await commandedAdapter.syntheticEdges!(ctx2);
    const r2 = await commandedAdapter.roleTags!(ctx2);
    expect(e2).toEqual(edges);
    const entries = (m: Map<string, RoleTag>) =>
      [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect(entries(r2)).toEqual(entries(roles));
  });
});
