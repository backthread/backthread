// The Java import-graph extractor, over a small on-disk Maven multi-module fixture.
// Asserts the FQN-registry-driven internal edges (plain / nested-type / static / wildcard
// imports), external dependency bucketing (pom.xml groupId), JDK stdlib drop, that an
// internal package never leaks as external, module-info/package-info exclusion, and
// determinism across runs.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { JavaExtractor } from './java-adapter.js';
import type { NormalizedGraph } from './types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-java-ext-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

// A Maven multi-module Java repo: a `service` module + a `core` module + a `web` module,
// internal imports (plain, nested-type, static-member, wildcard), an external dep
// (Spring), a JDK stdlib import, and a module descriptor that must be excluded.
const POM = [
  '<project>',
  '  <groupId>com.acme</groupId>',
  '  <artifactId>app</artifactId>',
  '  <dependencies>',
  '    <dependency><groupId>org.springframework</groupId><artifactId>spring-context</artifactId></dependency>',
  '    <dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId></dependency>',
  '  </dependencies>',
  '</project>',
].join('\n');

const REPO: Record<string, string> = {
  'pom.xml': POM,
  'module-info.java': 'module com.acme { requires java.base; }\n', // excluded
  'core/src/main/java/com/acme/core/User.java':
    'package com.acme.core;\n\npublic class User {}\nclass Team {}\n',
  'core/src/main/java/com/acme/core/Nested.java':
    'package com.acme.core;\n\npublic class Nested {\n  public static class Inner {}\n}\n',
  'core/src/main/java/com/acme/core/Constants.java':
    'package com.acme.core;\n\npublic final class Constants {\n  public static final int MAX = 10;\n}\n',
  'service/src/main/java/com/acme/service/UserService.java': [
    'package com.acme.service;',
    '',
    'import com.acme.core.User;', // plain internal → User.java
    'import com.acme.core.Nested.Inner;', // nested type → longest-prefix → Nested.java
    'import static com.acme.core.Constants.MAX;', // static member → Constants.java
    'import org.springframework.stereotype.Service;', // external → ext:org.springframework
    'import java.util.List;', // JDK stdlib → dropped
    '',
    '@Service',
    'public class UserService {',
    '  private final List<User> users = new java.util.ArrayList<>();',
    '  int cap() { return MAX; }',
    '}',
  ].join('\n'),
  'web/src/main/java/com/acme/web/Handler.java':
    'package com.acme.web;\n\nimport com.acme.core.*;\n\npublic class Handler {\n  Team t;\n}\n', // wildcard → all core files
};

function internalEdges(g: NormalizedGraph): Set<string> {
  return new Set(g.edges.filter((e) => !e.external).map((e) => `${e.from} -> ${e.to}`));
}
function externalIds(g: NormalizedGraph): Set<string> {
  return new Set(g.externals.map((x) => x.id));
}

const USER = 'core/src/main/java/com/acme/core/User.java';
const NESTED = 'core/src/main/java/com/acme/core/Nested.java';
const CONSTANTS = 'core/src/main/java/com/acme/core/Constants.java';
const SERVICE = 'service/src/main/java/com/acme/service/UserService.java';
const HANDLER = 'web/src/main/java/com/acme/web/Handler.java';

describe('JavaExtractor', () => {
  it('resolves plain, nested-type, static, and wildcard imports into internal edges', async () => {
    const dir = await repo(REPO);
    const g = await new JavaExtractor().extract(dir);
    const edges = internalEdges(g);
    // plain `import com.acme.core.User` → User.java
    expect(edges.has(`${SERVICE} -> ${USER}`)).toBe(true);
    // nested `import com.acme.core.Nested.Inner` → longest-prefix → Nested.java
    expect(edges.has(`${SERVICE} -> ${NESTED}`)).toBe(true);
    // static `import static com.acme.core.Constants.MAX` → Constants.java
    expect(edges.has(`${SERVICE} -> ${CONSTANTS}`)).toBe(true);
    // wildcard `import com.acme.core.*` → every file in the package
    expect(edges.has(`${HANDLER} -> ${USER}`)).toBe(true);
    expect(edges.has(`${HANDLER} -> ${NESTED}`)).toBe(true);
    expect(edges.has(`${HANDLER} -> ${CONSTANTS}`)).toBe(true);
  });

  it('buckets an external by pom groupId and drops JDK stdlib', async () => {
    const dir = await repo(REPO);
    const g = await new JavaExtractor().extract(dir);
    expect(externalIds(g)).toContain('ext:org.springframework');
    // JDK (java.*) and an internal-but-unresolved ref never become externals.
    for (const x of externalIds(g)) {
      expect(x.startsWith('ext:java')).toBe(false);
      expect(x.startsWith('ext:com.acme')).toBe(false);
    }
  });

  it('excludes module-info.java / package-info.java from graph nodes', async () => {
    const dir = await repo(REPO);
    const g = await new JavaExtractor().extract(dir);
    expect(g.files.every((f) => f.id.endsWith('.java'))).toBe(true);
    expect(g.files.some((f) => f.id.endsWith('module-info.java'))).toBe(false);
    expect(g.files.some((f) => f.id.endsWith('package-info.java'))).toBe(false);
  });

  it('is deterministic across runs', async () => {
    const dir = await repo(REPO);
    const a = await new JavaExtractor().extract(dir);
    const b = await new JavaExtractor().extract(dir);
    expect(internalEdges(a)).toEqual(internalEdges(b));
    expect(externalIds(a)).toEqual(externalIds(b));
    expect(a.files.map((f) => f.id)).toEqual(b.files.map((f) => f.id));
  });

  it('returns an empty graph for a repo with no .java files', async () => {
    const dir = await repo({ 'pom.xml': POM, 'README.md': '# hi' });
    const g = await new JavaExtractor().extract(dir);
    expect(g.files).toEqual([]);
    expect(g.edges).toEqual([]);
  });
});
