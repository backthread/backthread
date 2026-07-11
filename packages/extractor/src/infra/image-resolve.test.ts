// image→source resolver tests.
//
// The pure resolver (resolveImageToSourceRoots) is tested with an injected
// index; the fs wrapper (buildDockerfileIndex) runs against a real tmp dir.

import { describe, it, expect, beforeAll, afterAll } from '../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveImageToSourceRoots,
  parseImageRef,
  isLikelyExternalImage,
  buildDockerfileIndex,
  type DockerfileIndex,
} from './image-resolve.js';

const index = (over: Partial<DockerfileIndex> = {}): DockerfileIndex => ({
  dockerfiles: [],
  pairings: [],
  ...over,
});

describe('parseImageRef', () => {
  it('parses an official-library image (no org)', () => {
    const p = parseImageRef('postgres:15');
    expect(p.repository).toBe('postgres');
    expect(p.name).toBe('postgres');
    expect(p.registry).toBeUndefined();
    expect(p.officialLibrary).toBe(true);
  });

  it('parses an org-qualified image', () => {
    const p = parseImageRef('acme/api:1.2');
    expect(p.repository).toBe('acme/api');
    expect(p.name).toBe('api');
    expect(p.officialLibrary).toBe(false);
  });

  it('strips a registry host with a port and a digest', () => {
    const p = parseImageRef('localhost:5000/acme/web@sha256:abc123');
    expect(p.registry).toBe('localhost:5000');
    expect(p.repository).toBe('acme/web');
    expect(p.name).toBe('web');
  });

  it('treats a dotted first segment as a registry, not part of the repo', () => {
    const p = parseImageRef('123.dkr.ecr.us-east-1.amazonaws.com/svc:abc');
    expect(p.registry).toBe('123.dkr.ecr.us-east-1.amazonaws.com');
    expect(p.repository).toBe('svc');
    expect(p.name).toBe('svc');
    // single repo segment after the registry → official-library shape (still pulled-looking)
    expect(p.officialLibrary).toBe(true);
  });
});

describe('isLikelyExternalImage', () => {
  it('flags official-library images (no org segment)', () => {
    expect(isLikelyExternalImage('postgres:15')).toBe(true);
    expect(isLikelyExternalImage('redis')).toBe(true);
    expect(isLikelyExternalImage('node:20-alpine')).toBe(true);
  });

  it('flags known data/queue/base images even when org-qualified', () => {
    expect(isLikelyExternalImage('bitnami/postgresql:15')).toBe(true);
    expect(isLikelyExternalImage('bitnami/kafka')).toBe(true);
    expect(isLikelyExternalImage('library/nginx')).toBe(true);
  });

  it('does NOT flag a first-party org-qualified app image', () => {
    expect(isLikelyExternalImage('acme/api:1.2')).toBe(false);
    expect(isLikelyExternalImage('ghcr.io/acme/web:prod')).toBe(false);
  });
});

describe('resolveImageToSourceRoots — pairing (signal 1)', () => {
  it('resolves via an explicit image→context pairing (multi-service compose)', () => {
    const idx = index({
      pairings: [
        { image: 'acme/api:1.2', context: 'services/api' },
        { image: 'acme/worker:1.2', context: 'services/worker' },
      ],
    });
    expect(resolveImageToSourceRoots('acme/api:1.2', idx)).toEqual(['services/api']);
    expect(resolveImageToSourceRoots('acme/worker:1.2', idx)).toEqual(['services/worker']);
  });

  it('matches a pairing across registry + tag differences (repository match)', () => {
    const idx = index({ pairings: [{ image: 'acme/api', context: 'api' }] });
    expect(resolveImageToSourceRoots('ghcr.io/acme/api:prod', idx)).toEqual(['api']);
  });

  it('a pairing wins even for an external-looking name (repo declared it builds)', () => {
    const idx = index({ pairings: [{ image: 'acme/postgres-shim:1', context: 'shim' }] });
    expect(resolveImageToSourceRoots('acme/postgres-shim:1', idx)).toEqual(['shim']);
  });

  it('matches an unqualified compose tag against an org/registry-qualified ref', () => {
    // compose `image: api` (unqualified) ↔ k8s `ghcr.io/acme/api:prod` (qualified)
    const idx = index({ pairings: [{ image: 'api', context: 'services/api' }] });
    expect(resolveImageToSourceRoots('ghcr.io/acme/api:prod', idx)).toEqual(['services/api']);
  });

  it('does NOT collide two DIFFERENT org-qualified refs that share a base name', () => {
    // a pairing for acme/api must not claim a requested other/api (wrong unit).
    const idx = index({ pairings: [{ image: 'acme/api:1', context: 'services/api' }] });
    expect(resolveImageToSourceRoots('other/api:1', idx)).toEqual([]);
  });
});

describe('resolveImageToSourceRoots — name convention (signal 2)', () => {
  it('matches the image base name to a context dir last segment (monorepo)', () => {
    const idx = index({
      dockerfiles: [
        { dockerfile: 'services/api/Dockerfile', context: 'services/api' },
        { dockerfile: 'services/web/Dockerfile', context: 'services/web' },
      ],
    });
    expect(resolveImageToSourceRoots('acme/api:1', idx)).toEqual(['services/api']);
    expect(resolveImageToSourceRoots('acme/web:1', idx)).toEqual(['services/web']);
  });

  it('returns [] when the name matches no context (unresolvable)', () => {
    const idx = index({
      dockerfiles: [
        { dockerfile: 'services/api/Dockerfile', context: 'services/api' },
        { dockerfile: 'services/web/Dockerfile', context: 'services/web' },
      ],
    });
    expect(resolveImageToSourceRoots('acme/billing:1', idx)).toEqual([]);
  });
});

describe('resolveImageToSourceRoots — single-context fallback (signal 3)', () => {
  it('resolves a first-party image to the one Dockerfile context', () => {
    const idx = index({ dockerfiles: [{ dockerfile: 'Dockerfile', context: '' }, ] });
    // context '' (repo root) is a catch-all → dropped → unresolvable
    expect(resolveImageToSourceRoots('acme/app:1', idx)).toEqual([]);
  });

  it('resolves to the single non-root context', () => {
    const idx = index({ dockerfiles: [{ dockerfile: 'app/Dockerfile', context: 'app' }] });
    expect(resolveImageToSourceRoots('acme/whatever:1', idx)).toEqual(['app']);
  });

  it('two Dockerfiles in the same dir count as ONE context → still resolves', () => {
    const idx = index({
      dockerfiles: [
        { dockerfile: 'app/Dockerfile', context: 'app' },
        { dockerfile: 'app/Dockerfile.dev', context: 'app' },
      ],
    });
    expect(resolveImageToSourceRoots('acme/whatever:1', idx)).toEqual(['app']);
  });

  it('does NOT fall back for a pulled public image even with one Dockerfile', () => {
    const idx = index({ dockerfiles: [{ dockerfile: 'app/Dockerfile', context: 'app' }] });
    expect(resolveImageToSourceRoots('postgres:15', idx)).toEqual([]);
    expect(resolveImageToSourceRoots('bitnami/redis', idx)).toEqual([]);
  });

  it('does NOT fall back when ≥2 distinct contexts exist and name matches none', () => {
    const idx = index({
      dockerfiles: [
        { dockerfile: 'services/api/Dockerfile', context: 'services/api' },
        { dockerfile: 'services/web/Dockerfile', context: 'services/web' },
      ],
    });
    expect(resolveImageToSourceRoots('acme/unrelated:1', idx)).toEqual([]);
  });
});

describe('resolveImageToSourceRoots — degradation invariants', () => {
  it('empty index → []', () => {
    expect(resolveImageToSourceRoots('acme/api:1', index())).toEqual([]);
  });

  it('blank image ref → []', () => {
    expect(resolveImageToSourceRoots('', index({ dockerfiles: [{ dockerfile: 'a/Dockerfile', context: 'a' }] }))).toEqual([]);
  });

  it('never returns the repo root context (no catch-all)', () => {
    const idx = index({ pairings: [{ image: 'acme/api', context: '.' }] });
    expect(resolveImageToSourceRoots('acme/api', idx)).toEqual([]);
  });
});

describe('buildDockerfileIndex (fs)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-imgresolve-'));
    // A monorepo: two service Dockerfiles + a compose file pairing build↔image.
    mkdirSync(join(dir, 'services', 'api'), { recursive: true });
    mkdirSync(join(dir, 'services', 'worker'), { recursive: true });
    writeFileSync(join(dir, 'services', 'api', 'Dockerfile'), 'FROM node:20\n');
    writeFileSync(join(dir, 'services', 'worker', 'Dockerfile.prod'), 'FROM node:20\n');
    writeFileSync(
      join(dir, 'docker-compose.yml'),
      [
        'services:',
        '  api:',
        '    build: ./services/api',
        '    image: acme/api:1.2',
        '  cache:',
        '    image: redis:7',
      ].join('\n'),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('collects in-repo Dockerfiles with their context dirs', () => {
    const idx = buildDockerfileIndex(dir);
    const ctxs = idx.dockerfiles.map((d) => d.context).sort();
    expect(ctxs).toEqual(['services/api', 'services/worker']);
  });

  it('collects compose build↔image pairings (only services with BOTH)', () => {
    const idx = buildDockerfileIndex(dir);
    expect(idx.pairings).toEqual([{ image: 'acme/api:1.2', context: 'services/api' }]);
  });

  it('end-to-end: a k8s-style image ref resolves via the built index', () => {
    const idx = buildDockerfileIndex(dir);
    // pairing wins for api
    expect(resolveImageToSourceRoots('ghcr.io/acme/api:deadbeef', idx)).toEqual(['services/api']);
    // worker resolves by name convention (no pairing, base name === context segment)
    expect(resolveImageToSourceRoots('acme/worker:1', idx)).toEqual(['services/worker']);
    // a pulled external image stays unresolvable
    expect(resolveImageToSourceRoots('redis:7', idx)).toEqual([]);
  });
});
