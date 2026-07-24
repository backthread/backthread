// The Go GORM FrameworkAdapter — model role tagging (service, never datastore), Data-Model
// grouping, cross-package association edges (intra-package is inside one node = no edge).

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { goGormAdapter, gatherGormSignal, scoreGorm } from './gorm.js';
import type { FrameworkContext } from '../../types.js';
import type { NormalizedGraph } from '../../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-gogorm-'));
  dirs.push(dir);
  for (const [rel, c] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, c);
  }
  return dir;
}
function ctx(repoDir: string, dirNodes: string[]): FrameworkContext {
  const graph: NormalizedGraph = {
    root: repoDir,
    files: dirNodes.map((id) => ({ id, loc: 10, language: 'go' })),
    edges: [],
    externals: [],
  };
  return { repoDir, rootPath: '', match: { adapter: 'go-gorm', confidence: 1, rootPath: '' }, graph, cluster: { fileModuleMap: {}, moduleIds: new Set() } };
}

const GO_MOD = 'module github.com/acme/app\n\nrequire gorm.io/gorm v1.25.0\n';
const REPO: Record<string, string> = {
  'go.mod': GO_MOD,
  'models/user.go': 'package models\nimport "gorm.io/gorm"\ntype User struct {\n\tgorm.Model\n\tName     string\n\tProfiles []Profile\n}\n', // intra-package assoc → Profile
  'models/profile.go': 'package models\nimport "gorm.io/gorm"\ntype Profile struct {\n\tgorm.Model\n\tUserID uint\n\tBio    string `gorm:"type:text"`\n}\n',
  'billing/order.go': 'package billing\nimport (\n\t"gorm.io/gorm"\n\t"github.com/acme/app/models"\n)\ntype Order struct {\n\tgorm.Model\n\tUser   models.User\n\tAmount int\n}\n', // cross-package assoc → models
};

describe('detection', () => {
  it('detects gorm.io/gorm dep + a gorm.Model/gorm: tag in source', async () => {
    const dir = await repo(REPO);
    expect(gatherGormSignal(dir)).toBe(true);
    expect(scoreGorm(true)?.adapter).toBe('go-gorm');
  });
  it('does not detect a gorm dep with no model in source (DB-setup only)', async () => {
    const dir = await repo({ 'go.mod': GO_MOD, 'db/db.go': 'package db\nimport "gorm.io/gorm"\nfunc Open() *gorm.DB { return nil }\n' });
    expect(gatherGormSignal(dir)).toBe(false);
  });
});

describe('roleTags + grouping + association edges (dir-granular)', () => {
  it('tags model packages service (never datastore), groups Data Model, edges cross-package only', async () => {
    const dir = await repo(REPO);
    const c = ctx(dir, ['models', 'billing']);
    const roles = await goGormAdapter.roleTags!(c);
    expect(roles.get('models')?.kind).toBe('service'); // NOT datastore
    expect(roles.get('models')?.role).toBe('model');
    expect(roles.get('billing')?.kind).toBe('service');

    const groups = (await goGormAdapter.groupingPrior!(c)).groups;
    expect(groups.some((g) => g.label === 'Data Model' && g.fileIds.includes('models/user.go'))).toBe(true);

    const edges = await goGormAdapter.syntheticEdges!(c);
    // cross-package: billing → models (Order.User references models.User).
    expect(edges).toContainEqual(expect.objectContaining({ source: 'billing', target: 'models', kind: 'calls' }));
    // intra-package (User.Profiles → Profile, both in models) is inside ONE node → no edge.
    expect(edges.some((e) => e.source === 'models' && e.target === 'models')).toBe(false);
    // no stores-in edge / datastore kind ever.
    expect(edges.every((e) => e.kind !== 'stores-in')).toBe(true);
  });
});
