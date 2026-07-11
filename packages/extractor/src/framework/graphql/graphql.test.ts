// Strawberry + Graphene GraphQL adapter tests.
//
// scoreGraphql is pure; detect() runs against real tmp dirs (pyproject +
// requirements, and a non-GraphQL Python no-match + a TS no-match + a nested
// backend). The analysis hooks run over a real PythonExtractor graph of a small
// Strawberry + Graphene fixture and assert the file-id-space contributions (the
// contribute-step resolves those to modules downstream).

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  graphqlAdapter,
  scoreGraphql,
  gatherGraphqlSignals,
  type GraphqlSignals,
} from './graphql.js';
import { PythonExtractor } from '../../graph/python-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_SIGNALS: GraphqlSignals = { hasStrawberry: false, hasGraphene: false };

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// scoreGraphql (pure)

describe('scoreGraphql (pure)', () => {
  it('returns null with no strawberry/graphene dep (generic-Python fallthrough)', () => {
    expect(scoreGraphql(NO_SIGNALS)).toBeNull();
  });

  it('detects Strawberry and scores it the modern default', () => {
    const m = scoreGraphql({ hasStrawberry: true, hasGraphene: false });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('graphql');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.85);
    expect(m!.metadata?.strawberry).toBe(true);
    expect(m!.metadata?.graphene).toBe(false);
  });

  it('detects Graphene', () => {
    const m = scoreGraphql({ hasStrawberry: false, hasGraphene: true });
    expect(m).not.toBeNull();
    expect(m!.metadata?.graphene).toBe(true);
    expect(m!.metadata?.strawberry).toBe(false);
  });

  it('passes rootPath through', () => {
    const m = scoreGraphql({ hasStrawberry: true, hasGraphene: false }, 'backend');
    expect(m!.rootPath).toBe('backend');
  });
});

// ---------------------------------------------------------------------------
// detect() over real manifests

describe('graphqlAdapter.detect (fs fixtures)', () => {
  let pyproject: string;
  let requirements: string;
  let plainPy: string;
  let tsRepo: string;

  beforeAll(() => {
    pyproject = mkdtempSync(join(tmpdir(), 'bt-graphql-toml-'));
    writeFileSync(
      join(pyproject, 'pyproject.toml'),
      [
        '[project]',
        'name = "svc"',
        'dependencies = [',
        '  "strawberry-graphql[fastapi]>=0.220.0",',
        '  "uvicorn>=0.29",',
        ']',
      ].join('\n'),
    );

    requirements = mkdtempSync(join(tmpdir(), 'bt-graphql-req-'));
    writeFileSync(
      join(requirements, 'requirements.txt'),
      ['# app deps', 'graphene>=3.3', 'graphene-django>=3.2', 'django'].join('\n'),
    );

    plainPy = mkdtempSync(join(tmpdir(), 'bt-graphql-plain-'));
    writeFileSync(join(plainPy, 'pyproject.toml'), '[project]\nname = "x"\ndependencies = ["requests>=2", "click"]\n');

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-graphql-ts-'));
    writeFileSync(join(tsRepo, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '18' } }));
  });

  afterAll(() => {
    for (const d of [pyproject, requirements, plainPy, tsRepo]) rmSync(d, { recursive: true, force: true });
  });

  it('detects Strawberry from pyproject (extras stripped)', async () => {
    const m = await graphqlAdapter.detect({ repoDir: pyproject });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('graphql');
    expect(m!.metadata?.strawberry).toBe(true);
  });

  it('detects Graphene from requirements.txt (incl. graphene-* integration)', async () => {
    const m = await graphqlAdapter.detect({ repoDir: requirements });
    expect(m).not.toBeNull();
    expect(m!.metadata?.graphene).toBe(true);
  });

  it('does NOT detect a non-GraphQL Python repo', async () => {
    expect(await graphqlAdapter.detect({ repoDir: plainPy })).toBeNull();
  });

  it('does NOT detect a TS repo (no Python manifest)', async () => {
    expect(await graphqlAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED GraphQL backend and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-graphql-nested-'));
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'backend'), { recursive: true });
    writeFileSync(
      join(nested, 'backend', 'pyproject.toml'),
      '[project]\nname="be"\ndependencies=["strawberry-graphql>=0.2"]\n',
    );
    try {
      const m = await graphqlAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('backend');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('gatherGraphqlSignals reads deps from disk', () => {
    const s = gatherGraphqlSignals(requirements);
    expect(s.hasGraphene).toBe(true);
    expect(s.hasStrawberry).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real Strawberry + Graphene fixture

describe('graphqlAdapter analysis (groupingPrior / syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let ctx: FrameworkContext;
  let groups: Awaited<ReturnType<NonNullable<typeof graphqlAdapter.groupingPrior>>>['groups'];
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-graphql-app-'));

    // --- Strawberry schema under app/graphql/ ---
    write(dir, 'app/graphql/schema.py', [
      'import strawberry',
      'from app.graphql.query import Query',
      'from app.graphql.mutation import Mutation',
      'schema = strawberry.Schema(query=Query, mutation=Mutation)',
    ].join('\n'));
    write(dir, 'app/graphql/query.py', [
      'import strawberry',
      'from app.graphql.types import User',
      '@strawberry.type',
      'class Query:',
      '    @strawberry.field',
      '    def user(self, id: strawberry.ID) -> User:',
      '        return User(id=id, name="x")',
    ].join('\n'));
    write(dir, 'app/graphql/mutation.py', [
      'import strawberry',
      'from app.graphql.resolvers import create_user',
      'from app.graphql.types import User',
      '@strawberry.type',
      'class Mutation:',
      '    create_user: User = strawberry.field(resolver=create_user)',
    ].join('\n'));
    write(dir, 'app/graphql/types.py', [
      'import strawberry',
      '@strawberry.type',
      'class User:',
      '    id: strawberry.ID',
      '    name: str',
      '@strawberry.input',
      'class UserInput:',
      '    name: str',
    ].join('\n'));
    write(dir, 'app/graphql/resolvers.py', [
      'from app.graphql.types import User',
      'def create_user(name: str) -> User:',
      '    return User(id="1", name=name)',
    ].join('\n'));

    // --- Graphene schema under svc/gql/ ---
    write(dir, 'svc/gql/schema.py', [
      'import graphene',
      'from svc.gql.query import Query',
      'schema = graphene.Schema(query=Query)',
    ].join('\n'));
    write(dir, 'svc/gql/query.py', [
      'import graphene',
      'from svc.gql.types import UserType',
      'class Query(graphene.ObjectType):',
      '    user = graphene.Field(UserType)',
      '    users = graphene.List(UserType)',
      '    def resolve_user(self, info, id) -> UserType:',
      '        return None',
    ].join('\n'));
    write(dir, 'svc/gql/types.py', [
      'import graphene',
      'class UserType(graphene.ObjectType):',
      '    id = graphene.ID()',
      '    name = graphene.String()',
    ].join('\n'));
    write(dir, 'svc/gql/mutations.py', [
      'import graphene',
      'from svc.gql.types import UserType',
      'class CreateUser(graphene.Mutation):',
      '    user = graphene.Field(UserType)',
      '    def mutate(self, info, name) -> UserType:',
      '        return None',
    ].join('\n'));

    graph = await new PythonExtractor().extract(dir);
    ctx = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'graphql', confidence: 1, rootPath: '', metadata: { strawberry: true, graphene: true } },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    ({ groups } = await graphqlAdapter.groupingPrior!(ctx));
    edges = await graphqlAdapter.syntheticEdges!(ctx);
    roles = await graphqlAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags Strawberry roots/resolvers/schema → gateway and plain types → service', () => {
    expect(roles.get('app/graphql/query.py')).toMatchObject({ role: 'graphql-query', kind: 'gateway' });
    expect(roles.get('app/graphql/mutation.py')).toMatchObject({ role: 'graphql-mutation', kind: 'gateway' });
    expect(roles.get('app/graphql/schema.py')).toMatchObject({ role: 'graphql-schema', kind: 'gateway' });
    expect(roles.get('app/graphql/resolvers.py')).toMatchObject({ role: 'graphql-resolver', kind: 'gateway' });
    expect(roles.get('app/graphql/types.py')).toMatchObject({ role: 'graphql-type', kind: 'service' });
  });

  it('tags Graphene ObjectType roots + Mutation subclasses → gateway, data types → service', () => {
    expect(roles.get('svc/gql/query.py')).toMatchObject({ role: 'graphql-query', kind: 'gateway' });
    expect(roles.get('svc/gql/mutations.py')).toMatchObject({ role: 'graphql-mutation', kind: 'gateway' });
    expect(roles.get('svc/gql/schema.py')).toMatchObject({ role: 'graphql-schema', kind: 'gateway' });
    expect(roles.get('svc/gql/types.py')).toMatchObject({ role: 'graphql-type', kind: 'service' });
  });

  it('every role kind is a locked MODULE_KIND', () => {
    for (const tag of roles.values()) {
      expect(['gateway', 'service', 'job']).toContain(tag.kind);
    }
  });

  it('groups each dedicated GraphQL directory into its own subsystem', () => {
    const byId = new Map(groups.map((g) => [g.id, g]));
    expect(byId.get('graphql')?.label).toBe('GraphQL');
    expect(byId.get('graphql')?.fileIds).toEqual([
      'app/graphql/mutation.py',
      'app/graphql/query.py',
      'app/graphql/resolvers.py',
      'app/graphql/schema.py',
      'app/graphql/types.py',
    ]);
    expect(byId.get('gql')?.label).toBe('GraphQL');
    expect(byId.get('gql')?.fileIds).toEqual([
      'svc/gql/mutations.py',
      'svc/gql/query.py',
      'svc/gql/schema.py',
      'svc/gql/types.py',
    ]);
  });

  it('emits Schema(...) → root-type-file edges (kind calls)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('app/graphql/schema.py→app/graphql/query.py:calls');
    expect(keys).toContain('app/graphql/schema.py→app/graphql/mutation.py:calls');
    expect(keys).toContain('svc/gql/schema.py→svc/gql/query.py:calls');
  });

  it('emits resolver → returned-type edges (Strawberry field + Graphene resolve_*)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('app/graphql/query.py→app/graphql/types.py:calls');
    expect(keys).toContain('svc/gql/query.py→svc/gql/types.py:calls');
  });

  it('emits a cross-file resolver= edge and Graphene field-type edges (kind calls)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('app/graphql/mutation.py→app/graphql/resolvers.py:calls');
    expect(keys).toContain('svc/gql/mutations.py→svc/gql/types.py:calls');
  });

  it('only ever emits the 8-verb kind (calls) for GraphQL wiring', () => {
    for (const e of edges) expect(e.kind).toBe('calls');
  });

  it('is deterministic across two runs (stable ids + ordering)', async () => {
    const g2 = (await graphqlAdapter.groupingPrior!(ctx)).groups;
    const e2 = await graphqlAdapter.syntheticEdges!(ctx);
    const r2 = await graphqlAdapter.roleTags!(ctx);
    expect(g2).toEqual(groups);
    expect(e2.map(edgeKey)).toEqual(edges.map(edgeKey));
    expect([...r2.keys()].sort()).toEqual([...roles.keys()].sort());
  });

  it('does not run the Graphene pass when graphene is absent (strawberry-only)', async () => {
    const strawberryOnly: FrameworkContext = {
      ...ctx,
      match: { ...ctx.match, metadata: { strawberry: true, graphene: false } },
    };
    const r = await graphqlAdapter.roleTags!(strawberryOnly);
    // Graphene classes get no role when the graphene pass is off.
    expect(r.get('svc/gql/query.py')).toBeUndefined();
    expect(r.get('svc/gql/mutations.py')).toBeUndefined();
    // Strawberry roles still present.
    expect(r.get('app/graphql/query.py')).toMatchObject({ role: 'graphql-query' });
    const e = await graphqlAdapter.syntheticEdges!(strawberryOnly);
    expect(e.some((x) => x.source.startsWith('svc/gql/'))).toBe(false);
  });
});
