// The Java-manifest-gated Java-fleet registration seam. The isolation guarantee — a
// non-Java repo never module-loads the Java adapters — is enforced structurally by
// `registerLanguageScopedFrameworkAdapters` dynamically importing the fleet only when a Java
// manifest (pom.xml or `.java` source) is present. (node --test isolates each test file in
// its own process, so the module-level once-flag starts fresh here.)

import { describe, it, expect } from '../testkit.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearFrameworkAdapters, listFrameworkAdapters } from './registry.js';
import { registerBuiltinFrameworkAdapters, registerLanguageScopedFrameworkAdapters } from './register.js';
import { registerJavaFrameworkAdapters } from './register-java.js';

// The full Java fleet, in registration = co-fire priority order (web → data).
const JAVA_FLEET = ['java-spring', 'java-jpa'];

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-java-gate-'));
  for (const [rel, content] of Object.entries(files)) await writeFile(join(dir, rel), content);
  return dir;
}

describe('registerLanguageScopedFrameworkAdapters (Java gate)', () => {
  it('does not load the Java fleet for a repo without a Java manifest', async () => {
    clearFrameworkAdapters();
    registerBuiltinFrameworkAdapters();
    const before = listFrameworkAdapters().length;
    const dir = await repo({ 'package.json': '{"name":"x"}' }); // no pom.xml, no .java
    await registerLanguageScopedFrameworkAdapters(dir);
    expect(listFrameworkAdapters().length).toBe(before);
    await rm(dir, { recursive: true, force: true });
  });

  it('registers the Java fleet when a pom.xml is present', async () => {
    clearFrameworkAdapters();
    registerBuiltinFrameworkAdapters();
    const dir = await repo({ 'pom.xml': '<project><groupId>com.x</groupId></project>' });
    await registerLanguageScopedFrameworkAdapters(dir);
    const names = listFrameworkAdapters().map((a) => a.name);
    for (const adapter of JAVA_FLEET) expect(names).toContain(adapter);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('registerJavaFrameworkAdapters (fleet order)', () => {
  it('registers the full Java fleet in priority order (web → data)', () => {
    clearFrameworkAdapters();
    registerJavaFrameworkAdapters();
    expect(listFrameworkAdapters().map((a) => a.name)).toEqual(JAVA_FLEET);
  });
});
