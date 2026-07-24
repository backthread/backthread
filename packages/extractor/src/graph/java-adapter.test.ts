// The Java import-graph extractor, over a small on-disk Maven multi-module fixture.
// Asserts the FQN-registry-driven internal edges (plain / nested-type / static / wildcard
// imports), external dependency bucketing (pom.xml groupId), JDK stdlib drop, that an
// internal package never leaks as external, module-info/package-info exclusion, and
// determinism across runs.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { JavaExtractor, extractFileCalls } from './java-adapter.js';
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

// ---------------------------------------------------------------------------
// Call edges (v2) — constructor + static-call heads resolved through the FQN registry.

function callEdges(g: NormalizedGraph): Set<string> {
  return new Set(
    g.edges.filter((e) => e.kind === 'call' && !e.external).map((e) => `${e.from} -> ${e.to}`),
  );
}

const CORE_USER = 'src/main/java/com/acme/core/User.java';
const CORE_FACTORY = 'src/main/java/com/acme/core/Factory.java';
const CORE_UTIL = 'src/main/java/com/acme/core/Util.java';
const CORE_WIDGET = 'src/main/java/com/acme/core/Widget.java';
const UI_WIDGET = 'src/main/java/com/acme/ui/Widget.java';
const CORE_SCREEN = 'src/main/java/com/acme/core/Screen.java';
const MODEL_ORDER = 'src/main/java/com/acme/model/Order.java';
const APP = 'src/main/java/com/acme/app/App.java';

// A repo exercising: a same-package constructor (net-new edge vs imports), imported
// static calls, an external static call, a self static call, instance dispatch, and a
// simple name genuinely ambiguous between a same-package type and a wildcard import.
const CALL_REPO: Record<string, string> = {
  'pom.xml': POM,
  [CORE_USER]: 'package com.acme.core;\n\npublic class User {\n  void greet() {}\n}\n',
  [CORE_UTIL]: 'package com.acme.core;\n\npublic final class Util {\n  static int count() { return 1; }\n}\n',
  [CORE_FACTORY]: [
    'package com.acme.core;',
    '',
    'public class Factory {',
    '  static User make() { return new User(); }', // same-package constructor → Factory -> User
    '  static User makeTwo() { return Factory.make(); }', // self static call → NO self-edge
    '}',
  ].join('\n'),
  [CORE_WIDGET]: 'package com.acme.core;\n\npublic class Widget {}\n',
  [UI_WIDGET]: 'package com.acme.ui;\n\npublic class Widget {}\n',
  [MODEL_ORDER]: 'package com.acme.model;\n\npublic class Order {}\n',
  [CORE_SCREEN]: [
    'package com.acme.core;',
    '',
    'import com.acme.ui.*;', // wildcard brings com.acme.ui.Widget
    '',
    'public class Screen {',
    '  void build() { Object w = new Widget(); }', // AMBIGUOUS: core.Widget vs ui.Widget → dropped
    '}',
  ].join('\n'),
  [APP]: [
    'package com.acme.app;',
    '',
    'import com.acme.core.Factory;',
    'import com.acme.core.Util;',
    'import com.acme.model.*;', // wildcard: brings com.acme.model.Order (uniquely named)
    '',
    'public class App {',
    '  void run() {',
    '    var u = Factory.make();', // imported static call → App -> Factory
    '    int n = Util.count();', // imported static call → App -> Util
    '    var o = new Order();', // wildcard-resolved constructor → App -> Order (unique → edge)
    '    String s = String.valueOf(n);', // external (java.lang.String) → dropped
    '    this.helper();', // instance/this dispatch → dropped
    '  }',
    '  void helper() {}',
    '}',
  ].join('\n'),
};

describe('JavaExtractor call edges (v2)', () => {
  it('resolves a same-package constructor into a net-new call edge (no import exists)', async () => {
    const dir = await repo(CALL_REPO);
    const g = await new JavaExtractor().extract(dir);
    const calls = callEdges(g);
    expect(calls.has(`${CORE_FACTORY} -> ${CORE_USER}`)).toBe(true);
    // The import backbone can't see this edge: Factory has NO import of User.
    const imports = new Set(
      g.edges.filter((e) => e.kind === 'import' && !e.external).map((e) => `${e.from} -> ${e.to}`),
    );
    expect(imports.has(`${CORE_FACTORY} -> ${CORE_USER}`)).toBe(false);
  });

  it('resolves imported static calls (Factory.make / Util.count) into call edges', async () => {
    const dir = await repo(CALL_REPO);
    const g = await new JavaExtractor().extract(dir);
    const calls = callEdges(g);
    expect(calls.has(`${APP} -> ${CORE_FACTORY}`)).toBe(true);
    expect(calls.has(`${APP} -> ${CORE_UTIL}`)).toBe(true);
  });

  it('resolves a wildcard-imported, uniquely-named constructor head into a call edge', async () => {
    const dir = await repo(CALL_REPO);
    const g = await new JavaExtractor().extract(dir);
    // `new Order()` in App: same-package `com.acme.app.Order` misses, and the ONLY
    // candidate is `com.acme.model.Order` via `import com.acme.model.*` → 1 distinct → edge.
    expect(callEdges(g).has(`${APP} -> ${MODEL_ORDER}`)).toBe(true);
  });

  it('drops external, self, instance-dispatch, and ambiguous heads (0 self-edges)', async () => {
    const dir = await repo(CALL_REPO);
    const g = await new JavaExtractor().extract(dir);
    const calls = callEdges(g);
    // external `String.valueOf` → no in-repo target
    expect([...calls].some((e) => e.includes('String'))).toBe(false);
    // self `Factory.make()` inside Factory → no self-edge
    expect(calls.has(`${CORE_FACTORY} -> ${CORE_FACTORY}`)).toBe(false);
    // ambiguous `new Widget()` (same-package core.Widget vs wildcard ui.Widget) → dropped
    expect(calls.has(`${CORE_SCREEN} -> ${CORE_WIDGET}`)).toBe(false);
    expect(calls.has(`${CORE_SCREEN} -> ${UI_WIDGET}`)).toBe(false);
    // no call edge is a self-edge anywhere in the graph
    for (const e of calls) {
      const [from, to] = e.split(' -> ');
      expect(from).not.toBe(to);
    }
  });

  it('is deterministic across runs (call edges included)', async () => {
    const dir = await repo(CALL_REPO);
    const a = await new JavaExtractor().extract(dir);
    const b = await new JavaExtractor().extract(dir);
    expect(callEdges(a)).toEqual(callEdges(b));
  });

  it('degrades a file over the call-site cap to import-only (no call edges)', () => {
    const declToFile = new Map<string, string>([['com.acme.core.User', CORE_USER]]);
    const heads = Array.from({ length: 2501 }, () => 'User');
    const edges = extractFileCalls(CORE_FACTORY, heads, 'com.acme.core', [], declToFile);
    expect(edges).toEqual([]);
    // Under the cap, the same head resolves to a weighted edge.
    const under = extractFileCalls(CORE_FACTORY, ['User', 'User'], 'com.acme.core', [], declToFile);
    expect(under).toEqual([{ to: CORE_USER, weight: 2 }]);
  });
});
