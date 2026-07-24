// Java dependency-manifest reading — pom.xml groupId extraction + the multi-module
// deep walk + the Gradle-coordinate reuse.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parsePomGroups, readPomGroupsDeep, readJavaDeps } from './java-manifest.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-java-mf-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

describe('parsePomGroups', () => {
  it('extracts every groupId (project + parent + dependencies)', () => {
    const pom = [
      '<project>',
      '  <parent><groupId>org.springframework.boot</groupId></parent>',
      '  <groupId>com.acme</groupId>',
      '  <dependencies>',
      '    <dependency>',
      '      <groupId>com.google.guava</groupId>',
      '      <artifactId>guava</artifactId>',
      '    </dependency>',
      '  </dependencies>',
      '</project>',
    ].join('\n');
    expect(new Set(parsePomGroups(pom))).toEqual(
      new Set(['org.springframework.boot', 'com.acme', 'com.google.guava']),
    );
  });
  it('skips ${property}-placeholder groupIds', () => {
    const pom = '<dependency><groupId>${project.groupId}</groupId></dependency>';
    expect(parsePomGroups(pom)).toEqual([]);
  });
});

describe('readPomGroupsDeep', () => {
  it('unions groupIds across a multi-module tree and skips build dirs', async () => {
    const dir = await repo({
      'pom.xml': '<project><groupId>com.acme</groupId></project>',
      'service/pom.xml':
        '<project><dependency><groupId>org.postgresql</groupId></dependency></project>',
      'target/pom.xml': '<project><groupId>should.be.skipped</groupId></project>', // build output
    });
    const groups = readPomGroupsDeep(dir);
    expect(groups.has('com.acme')).toBe(true);
    expect(groups.has('org.postgresql')).toBe(true);
    expect(groups.has('should.be.skipped')).toBe(false);
  });
});

describe('readJavaDeps', () => {
  it('unions Maven pom groups and Gradle coordinate groups', async () => {
    const dir = await repo({
      'pom.xml': '<project><dependency><groupId>org.springframework</groupId></dependency></project>',
      'build.gradle': 'dependencies { implementation "io.reactivex.rxjava3:rxjava:3.0.0" }',
    });
    const groups = readJavaDeps(dir);
    expect(groups.has('org.springframework')).toBe(true);
    expect(groups.has('io.reactivex.rxjava3')).toBe(true);
  });
});
