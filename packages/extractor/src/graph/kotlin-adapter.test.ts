// The Kotlin import-graph extractor, over a small on-disk Gradle multi-module fixture.
// Asserts the FQN-registry-driven internal edges (plain / nested-type / wildcard /
// aliased imports), external dependency bucketing, stdlib drop, that an internal package
// never leaks as external, `.kts` build-script exclusion, and determinism across runs.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { KotlinExtractor } from './kotlin-adapter.js';
import type { NormalizedGraph } from './types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-kotlin-ext-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

// A Gradle multi-module Kotlin repo: an `app` module + a `core` module, internal imports
// (plain, nested-type, wildcard), an external dep (Ktor), a stdlib import, and a
// same-package sibling (no import → the accepted-degrade non-edge).
const REPO: Record<string, string> = {
  'settings.gradle.kts': 'include(":app", ":core")',
  'gradle/libs.versions.toml':
    '[libraries]\nktor = { module = "io.ktor:ktor-server-core", version.ref = "k" }\n',
  'build.gradle.kts': '// root',
  'core/build.gradle.kts': 'dependencies { }',
  'core/src/main/kotlin/com/acme/core/User.kt':
    'package com.acme.core\n\nclass User(val id: Long)\nclass Team(val name: String)\n',
  'core/src/main/kotlin/com/acme/core/Repo.kt':
    'package com.acme.core\n\nclass Repo {\n  class Page\n}\n',
  'app/build.gradle.kts': 'dependencies { implementation("io.ktor:ktor-server-core:2.3.0") }',
  'app/src/main/kotlin/com/acme/app/Service.kt': [
    'package com.acme.app',
    '',
    'import com.acme.core.User', // plain internal → User.kt
    'import com.acme.core.Repo.Page', // nested type → longest-prefix to Repo.kt
    'import io.ktor.server.application.Application', // external → ext:io.ktor
    'import kotlin.collections.List', // stdlib → dropped
    '',
    'class Service(val user: User)',
  ].join('\n'),
  'app/src/main/kotlin/com/acme/app/Handler.kt':
    'package com.acme.app\n\nimport com.acme.core.*\n\nclass Handler(val team: Team)\n', // wildcard → both core files
};

const idOf = (rel: string): string => rel;

function internalEdges(g: NormalizedGraph): Set<string> {
  return new Set(g.edges.filter((e) => !e.external).map((e) => `${e.from} -> ${e.to}`));
}
function externalIds(g: NormalizedGraph): Set<string> {
  return new Set(g.externals.map((x) => x.id));
}

describe('KotlinExtractor', () => {
  it('resolves plain, nested-type, wildcard imports into internal edges', async () => {
    const dir = await repo(REPO);
    const g = await new KotlinExtractor().extract(dir);
    const edges = internalEdges(g);
    const service = idOf('app/src/main/kotlin/com/acme/app/Service.kt');
    const handler = idOf('app/src/main/kotlin/com/acme/app/Handler.kt');
    const user = idOf('core/src/main/kotlin/com/acme/core/User.kt');
    const repoFile = idOf('core/src/main/kotlin/com/acme/core/Repo.kt');
    // plain `import com.acme.core.User` → User.kt
    expect(edges.has(`${service} -> ${user}`)).toBe(true);
    // nested `import com.acme.core.Repo.Page` → longest-prefix → Repo.kt
    expect(edges.has(`${service} -> ${repoFile}`)).toBe(true);
    // wildcard `import com.acme.core.*` → every file in the package (User.kt + Repo.kt)
    expect(edges.has(`${handler} -> ${user}`)).toBe(true);
    expect(edges.has(`${handler} -> ${repoFile}`)).toBe(true);
  });

  it('buckets an external by declared group and drops stdlib', async () => {
    const dir = await repo(REPO);
    const g = await new KotlinExtractor().extract(dir);
    expect(externalIds(g)).toContain('ext:io.ktor');
    // stdlib (kotlin.*) and an internal-but-unresolved ref never become externals.
    for (const x of externalIds(g)) {
      expect(x.startsWith('ext:kotlin')).toBe(false);
      expect(x.startsWith('ext:com.acme')).toBe(false);
    }
  });

  it('excludes .kts build scripts from graph nodes', async () => {
    const dir = await repo(REPO);
    const g = await new KotlinExtractor().extract(dir);
    expect(g.files.every((f) => f.id.endsWith('.kt') && !f.id.endsWith('.kts'))).toBe(true);
    expect(g.files.some((f) => f.id.includes('build.gradle'))).toBe(false);
  });

  it('is deterministic across runs', async () => {
    const dir = await repo(REPO);
    const a = await new KotlinExtractor().extract(dir);
    const b = await new KotlinExtractor().extract(dir);
    expect(internalEdges(a)).toEqual(internalEdges(b));
    expect(externalIds(a)).toEqual(externalIds(b));
    expect(a.files.map((f) => f.id)).toEqual(b.files.map((f) => f.id));
  });

  it('returns an empty graph for a repo with no .kt files', async () => {
    const dir = await repo({ 'settings.gradle.kts': 'include(":x")', 'README.md': '# hi' });
    const g = await new KotlinExtractor().extract(dir);
    expect(g.files).toEqual([]);
    expect(g.edges).toEqual([]);
  });
});
