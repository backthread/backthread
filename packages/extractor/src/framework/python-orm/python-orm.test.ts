// Python ORM entity adapter tests.
//
// scorePyOrm is pure; detect() runs against real tmp manifests (pyproject +
// requirements, a non-ORM Python no-match, a TS no-match, a nested backend). The
// analysis hooks run over a real PythonExtractor graph of a SQLAlchemy 2.0 +
// SQLModel fixture and assert the file-id-space contributions (roles / data-model
// groups / relationship + FK edges between model modules); a second fixture
// proves the Tortoise / Beanie / Peewee marker-base generalization.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pythonOrmAdapter,
  scorePyOrm,
  gatherPyOrmSignals,
  type PyOrmSignals,
} from './python-orm.js';
import { PythonExtractor } from '../../graph/python-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_SIGNALS: PyOrmSignals = { orms: [] };

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// scorePyOrm (pure)

describe('scorePyOrm (pure)', () => {
  it('returns null with no ORM dep (generic-Python fallthrough)', () => {
    expect(scorePyOrm(NO_SIGNALS)).toBeNull();
  });

  it('detects SQLAlchemy', () => {
    const m = scorePyOrm({ orms: ['sqlalchemy'] });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('python-orm');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(m!.metadata?.orms).toEqual(['sqlalchemy']);
  });

  it('detects SQLModel, and raises confidence when SQLAlchemy is also declared', () => {
    expect(scorePyOrm({ orms: ['sqlmodel'] })!.confidence).toBe(0.8);
    const both = scorePyOrm({ orms: ['sqlalchemy', 'sqlmodel'] });
    expect(both!.confidence).toBeGreaterThan(0.8);
    expect(both!.metadata?.variant).toBe('sqlalchemy+sqlmodel');
  });

  it('widens the marker heuristic to tortoise-orm / beanie / peewee', () => {
    expect(scorePyOrm({ orms: ['tortoise-orm'] })!.metadata?.orms).toEqual(['tortoise-orm']);
    expect(scorePyOrm({ orms: ['beanie'] })).not.toBeNull();
    expect(scorePyOrm({ orms: ['peewee'] })).not.toBeNull();
  });

  it('passes rootPath through', () => {
    expect(scorePyOrm({ orms: ['sqlalchemy'] }, 'backend')!.rootPath).toBe('backend');
  });
});

// ---------------------------------------------------------------------------
// detect() over real manifests

describe('pythonOrmAdapter.detect (fs fixtures)', () => {
  let pyproject: string;
  let requirements: string;
  let plainPy: string;
  let tsRepo: string;

  beforeAll(() => {
    pyproject = mkdtempSync(join(tmpdir(), 'bt-pyorm-toml-'));
    writeFileSync(
      join(pyproject, 'pyproject.toml'),
      [
        '[project]',
        'name = "svc"',
        'dependencies = [',
        '  "fastapi[standard]>=0.138.1",',
        '  "SQLModel>=0.0.39",',
        ']',
      ].join('\n'),
    );

    requirements = mkdtempSync(join(tmpdir(), 'bt-pyorm-req-'));
    writeFileSync(
      join(requirements, 'requirements.txt'),
      ['# app deps', 'SQLAlchemy==2.0.30', 'alembic>=1.13', 'psycopg2-binary'].join('\n'),
    );

    plainPy = mkdtempSync(join(tmpdir(), 'bt-pyorm-plain-'));
    writeFileSync(join(plainPy, 'pyproject.toml'), '[project]\nname = "x"\ndependencies = ["requests>=2", "click"]\n');

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-pyorm-ts-'));
    writeFileSync(join(tsRepo, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '18' } }));
  });

  afterAll(() => {
    for (const d of [pyproject, requirements, plainPy, tsRepo]) rmSync(d, { recursive: true, force: true });
  });

  it('detects SQLModel from pyproject PEP 621 dependencies (case-insensitive)', async () => {
    const m = await pythonOrmAdapter.detect({ repoDir: pyproject });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('python-orm');
    expect(m!.metadata?.orms).toEqual(['sqlmodel']);
  });

  it('detects SQLAlchemy from requirements.txt', async () => {
    const m = await pythonOrmAdapter.detect({ repoDir: requirements });
    expect(m).not.toBeNull();
    expect(m!.metadata?.orms).toEqual(['sqlalchemy']);
  });

  it('does NOT detect a non-ORM Python repo', async () => {
    expect(await pythonOrmAdapter.detect({ repoDir: plainPy })).toBeNull();
  });

  it('does NOT detect a TS repo (no Python manifest)', async () => {
    expect(await pythonOrmAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED backend ORM and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-pyorm-nested-'));
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'backend'), { recursive: true });
    writeFileSync(join(nested, 'backend', 'pyproject.toml'), '[project]\nname="be"\ndependencies=["sqlalchemy>=2"]\n');
    try {
      const m = await pythonOrmAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('backend');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('gatherPyOrmSignals reads deps from disk (canonical order)', () => {
    const s = gatherPyOrmSignals(requirements);
    expect(s.orms).toEqual(['sqlalchemy']);
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real SQLAlchemy 2.0 + SQLModel fixture

describe('pythonOrmAdapter analysis (groupingPrior / syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let ctx: FrameworkContext;
  let groups: Awaited<ReturnType<NonNullable<typeof pythonOrmAdapter.groupingPrior>>>['groups'];
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-pyorm-app-'));

    // SQLAlchemy 2.0 declarative base — NOT itself a table entity.
    write(dir, 'app/models/base.py', [
      'from sqlalchemy.orm import DeclarativeBase',
      'class Base(DeclarativeBase):',
      '    pass',
    ].join('\n'));
    // SQLAlchemy User — Mapped[list["Post"]] = relationship() cross-module ref.
    write(dir, 'app/models/user.py', [
      'from sqlalchemy.orm import Mapped, mapped_column, relationship',
      'from app.models.base import Base',
      'class User(Base):',
      '    __tablename__ = "user"',
      '    id: Mapped[int] = mapped_column(primary_key=True)',
      '    posts: Mapped[list["Post"]] = relationship(back_populates="author")',
    ].join('\n'));
    // SQLAlchemy Post — ForeignKey("user.id") + Mapped["User"] = relationship().
    write(dir, 'app/models/post.py', [
      'from sqlalchemy import ForeignKey',
      'from sqlalchemy.orm import Mapped, mapped_column, relationship',
      'from app.models.base import Base',
      'class Post(Base):',
      '    __tablename__ = "post"',
      '    id: Mapped[int] = mapped_column(primary_key=True)',
      '    author_id: Mapped[int] = mapped_column(ForeignKey("user.id"))',
      '    author: Mapped["User"] = relationship(back_populates="posts")',
    ].join('\n'));

    // SQLModel Team — plain `list["Hero"] = Relationship()` (no Mapped wrapper).
    write(dir, 'app/schemas/team.py', [
      'from sqlmodel import SQLModel, Field, Relationship',
      'class Team(SQLModel, table=True):',
      '    id: int = Field(default=None, primary_key=True)',
      '    name: str',
      '    heroes: list["Hero"] = Relationship(back_populates="team")',
    ].join('\n'));
    // SQLModel Hero — Field(foreign_key="team.id") + "Team" = Relationship().
    write(dir, 'app/schemas/hero.py', [
      'from sqlmodel import SQLModel, Field, Relationship',
      'class Hero(SQLModel, table=True):',
      '    id: int = Field(default=None, primary_key=True)',
      '    team_id: int = Field(foreign_key="team.id")',
      '    team: "Team" = Relationship(back_populates="heroes")',
    ].join('\n'));
    // A SQLModel NON-table schema (a request DTO) — must NOT be tagged a model.
    write(dir, 'app/schemas/dto.py', [
      'from sqlmodel import SQLModel',
      'class HeroCreate(SQLModel):',
      '    name: str',
    ].join('\n'));
    // A plain non-ORM class — must NOT be tagged.
    write(dir, 'app/services/user_service.py', [
      'class UserService:',
      '    def run(self):',
      '        return 1',
    ].join('\n'));

    graph = await new PythonExtractor().extract(dir);
    ctx = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'python-orm', confidence: 1, rootPath: '', metadata: { orms: ['sqlalchemy', 'sqlmodel'] } },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    ({ groups } = await pythonOrmAdapter.groupingPrior!(ctx));
    edges = await pythonOrmAdapter.syntheticEdges!(ctx);
    roles = await pythonOrmAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags entity modules with role model on the locked service kind', () => {
    for (const id of [
      'app/models/user.py',
      'app/models/post.py',
      'app/schemas/team.py',
      'app/schemas/hero.py',
    ]) {
      expect(roles.get(id)).toMatchObject({ role: 'model', kind: 'service' });
    }
    // The declarative base itself, a non-table SQLModel DTO, and a plain class
    // are NOT models.
    expect(roles.get('app/models/base.py')).toBeUndefined();
    expect(roles.get('app/schemas/dto.py')).toBeUndefined();
    expect(roles.get('app/services/user_service.py')).toBeUndefined();
    // Every role kind is a locked value — never a new Module-kind.
    for (const tag of roles.values()) expect(['gateway', 'service', 'job']).toContain(tag.kind);
  });

  it('groups models/-ish directories into Data Model subsystem(s)', () => {
    const byId = new Map(groups.map((g) => [g.id, g]));
    expect(byId.get('data-model')?.label).toBe('Data Model');
    // app/models cluster (user + post) — base.py excluded (not an entity).
    expect(byId.get('data-model')?.fileIds).toEqual(['app/models/user.py', 'app/models/post.py'].sort());
    // app/schemas is a second, id-disambiguated data-model group.
    const schemas = groups.find((g) => g.fileIds.includes('app/schemas/team.py'));
    expect(schemas?.label).toBe('Data Model');
    expect(schemas?.fileIds).toEqual(['app/schemas/hero.py', 'app/schemas/team.py']);
  });

  it('emits SQLAlchemy relationship + FK edges between model modules (kind calls)', () => {
    const keys = new Set(edges.map(edgeKey));
    // User.posts → Post (Mapped[list["Post"]] relationship).
    expect(keys).toContain('app/models/user.py→app/models/post.py:calls');
    // Post → User (both ForeignKey("user.id") and Mapped["User"] relationship,
    // deduped to a single calls edge).
    expect(keys).toContain('app/models/post.py→app/models/user.py:calls');
  });

  it('emits SQLModel Relationship + Field(foreign_key) edges (no Mapped wrapper)', () => {
    const keys = new Set(edges.map(edgeKey));
    // Team.heroes → Hero (plain list["Hero"] = Relationship()).
    expect(keys).toContain('app/schemas/team.py→app/schemas/hero.py:calls');
    // Hero → Team (Field(foreign_key="team.id") + "Team" = Relationship()).
    expect(keys).toContain('app/schemas/hero.py→app/schemas/team.py:calls');
  });

  it('only emits the 8-verb calls kind, file-id endpoints, no self-edges', () => {
    for (const e of edges) {
      expect(e.kind).toBe('calls');
      expect(e.source).not.toBe(e.target);
      expect(e.metadata?.framework).toBe('python-orm');
    }
  });

  it('is deterministic across two runs (stable ids + ordering)', async () => {
    const g2 = (await pythonOrmAdapter.groupingPrior!(ctx)).groups;
    const e2 = await pythonOrmAdapter.syntheticEdges!(ctx);
    const r2 = await pythonOrmAdapter.roleTags!(ctx);
    expect(g2).toEqual(groups);
    expect(e2.map(edgeKey)).toEqual(edges.map(edgeKey));
    expect([...r2.keys()].sort()).toEqual([...roles.keys()].sort());
  });
});

// ---------------------------------------------------------------------------
// Marker-base generalization — Tortoise / Beanie / Peewee entity detection

describe('pythonOrmAdapter marker generalization (Tortoise / Beanie / Peewee)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bt-pyorm-marker-'));
    write(dir, 'db/user.py', ['from tortoise.models import Model', 'class User(Model):', '    pass'].join('\n'));
    write(dir, 'db/note.py', ['from beanie import Document', 'class Note(Document):', '    pass'].join('\n'));
    write(dir, 'db/log.py', ['from peewee import Model', 'class Log(Model):', '    pass'].join('\n'));
    write(dir, 'db/plain.py', ['class Helper:', '    pass'].join('\n'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags Model / Document base classes as model modules', async () => {
    const graph = await new PythonExtractor().extract(dir);
    const ctx: FrameworkContext = {
      repoDir: dir,
      rootPath: '',
      match: {
        adapter: 'python-orm',
        confidence: 1,
        rootPath: '',
        metadata: { orms: ['tortoise-orm', 'beanie', 'peewee'] },
      },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    const roles = await pythonOrmAdapter.roleTags!(ctx);
    expect(roles.get('db/user.py')).toMatchObject({ role: 'model', kind: 'service' });
    expect(roles.get('db/note.py')).toMatchObject({ role: 'model', kind: 'service' });
    expect(roles.get('db/log.py')).toMatchObject({ role: 'model', kind: 'service' });
    expect(roles.get('db/plain.py')).toBeUndefined();
    // A `db/` directory of entities is grouped into a Data Model subsystem.
    const { groups } = await pythonOrmAdapter.groupingPrior!(ctx);
    expect(groups.find((g) => g.label === 'Data Model')?.fileIds).toEqual(
      ['db/log.py', 'db/note.py', 'db/user.py'],
    );
  });
});
