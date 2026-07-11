// shared image→source resolver (Phase 0 of , seam #2).
//
// Tier-1/2 adapters (compose, Vercel, Fly, Render, Railway, Heroku) point at a
// SOURCE dir, so `sourceRoots` falls out cleanly. Tier-3 adapters (k8s,
// Terraform, Pulumi, AWS/GCP/Azure-native) reference a PRE-BUILT image
// (`image: myorg/api:1.2`) — there's no source dir in the config. This resolver
// is the shared bridge: given an image ref + an index of the repo's in-repo
// Dockerfiles (and any explicit image→context pairings the compose adapter
// already knows), it answers "which repo dir builds this image?" → that
// Dockerfile's build context = the source root the Tier-3 adapter emits.
//
// Hard rules:
//   * Deterministic, NO LLM.
//   * Graceful degradation — an image that resolves to no in-repo Dockerfile
//     returns []; the adapter then emits NO `sourceRoots` and that unit's code
//     honestly stays in "Other (not deployed)." NEVER guess.
//   * Never a repo-root catch-all — a context that resolves to '' (the whole
//     repo) is dropped, so it can't swallow sibling deploy units.
//   * Pure core (`resolveImageToSourceRoots`) takes an injected index — no fs —
//     so it's unit-testable, mirroring the netlify/compose builder split. The
//     thin fs wrapper (`buildDockerfileIndex`) walks the repo.
//
// Matching signals, in priority order (best-effort, first hit wins):
//   1. An explicit image→context PAIRING (a compose service that declares BOTH
//      `build:` and `image:` is the authoritative "this image is built here").
//   2. NAME-CONVENTION: the image's base name (`acme/api:1` → `api`) equals a
//      Dockerfile build-context dir's last path segment. Exactly one match wins;
//      ambiguous (≥2) → honest [] (never guess).
//   3. SINGLE-CONTEXT repo: exactly one Dockerfile build context in the whole
//      repo → the obvious context (guarded by the external-image exclusion so a
//      pulled `postgres:15` never grabs your one Dockerfile).
//
// Pulled public images (official-library `postgres:15`, known data/queue/base
// images) are excluded from the heuristic signals (2 + 3) — they run no code of
// yours. An explicit pairing (signal 1) still wins for them, because the repo
// literally said it builds that tag.

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { findFiles } from './walk.js';
import { parseComposeConfig } from './compose/compose-parse.js';

// ---------------------------------------------------------------------------
// The injected index (the pure resolver's only input besides the image ref).

/** An in-repo Dockerfile and its inferred build-context dir (the source root). */
export interface DockerfileEntry {
  /** Repo-relative path to the Dockerfile (provenance). */
  dockerfile: string;
  /** Repo-relative build-context dir = the source root ('' = repo root). */
  context: string;
}

/** An explicit "this image ref is built from this context" pairing. */
export interface ImagePairing {
  /** The image ref this pairing builds (e.g. a compose service's `image:`). */
  image: string;
  /** Repo-relative build-context dir = the source root ('' = repo root). */
  context: string;
}

/** Everything the pure resolver needs: the repo's Dockerfiles + known pairings. */
export interface DockerfileIndex {
  dockerfiles: DockerfileEntry[];
  pairings: ImagePairing[];
}

// ---------------------------------------------------------------------------
// Path helpers (repo-relative, normalized) — same idiom as netlify.ts/compose.ts.

/** Normalize a repo-relative path: backslashes→/, collapse a bare `.`/leading `./`,
 * strip trailing `/`. A lone `.` (the repo root) normalizes to '' so it's dropped. */
function normalizeRoot(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.(?:\/|$)/, '').replace(/\/+$/, '');
}

/** The repo-relative directory of a repo-relative file path ('' = repo root). */
function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '' : relPath.slice(0, i);
}

/** Resolve `rel` (may contain `./`/`../`) against repo-relative `baseDir` → normalized. */
function resolveRel(baseDir: string, rel: string): string {
  const parts = (baseDir ? baseDir.split('/') : []).concat(rel.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

/** The last path segment of a repo-relative dir ('' for the repo root). */
function lastSegment(dir: string): string {
  const norm = normalizeRoot(dir);
  if (!norm) return '';
  const i = norm.lastIndexOf('/');
  return i === -1 ? norm : norm.slice(i + 1);
}

// ---------------------------------------------------------------------------
// Image-ref parsing. An OCI image ref is
//   [registry[:port]/]repository[:tag][@digest]
// e.g. `postgres:15`, `acme/api:1.2`, `ghcr.io/acme/web@sha256:…`,
//      `123.dkr.ecr.us-east-1.amazonaws.com/svc:abc`.

export interface ParsedImageRef {
  /** Registry host (`ghcr.io`, `123.dkr.ecr…`), or undefined for the default registry. */
  registry?: string;
  /** Repository path WITHOUT the registry (`acme/api`, `postgres`). */
  repository: string;
  /** Last path segment of the repository — the "base name" (`api`, `postgres`, `web`). */
  name: string;
  /** True iff the repository has no `/` after the registry — a Docker official-library image. */
  officialLibrary: boolean;
}

/** Parse an image ref into its parts. Tolerant: never throws, best-effort. */
export function parseImageRef(ref: string): ParsedImageRef {
  let s = ref.trim();
  // Strip a digest (`@sha256:…`) then a tag (the last `:` AFTER the last `/`,
  // so a registry `host:port` isn't mistaken for a tag).
  const at = s.indexOf('@');
  if (at !== -1) s = s.slice(0, at);
  const lastSlash = s.lastIndexOf('/');
  const lastColon = s.lastIndexOf(':');
  if (lastColon > lastSlash) s = s.slice(0, lastColon);

  // The first segment is a registry iff it looks like a host (`.`/`:` or localhost).
  const segs = s.split('/').filter((x) => x.length > 0);
  let registry: string | undefined;
  if (segs.length > 1) {
    const first = segs[0];
    if (first.includes('.') || first.includes(':') || first === 'localhost') {
      registry = first;
      segs.shift();
    }
  }
  const repository = segs.join('/');
  const name = segs.length ? segs[segs.length - 1] : repository;
  return { registry, repository, name, officialLibrary: segs.length === 1 };
}

// ---------------------------------------------------------------------------
// Pulled-public-image exclusion. These run no code of yours, so the heuristic
// signals (name-convention + single-context) must never grab a local Dockerfile
// for them. Reuses the compose data/queue token lists + common base images.

const DATASTORE_TOKENS = [
  'postgres', 'postgis', 'mysql', 'mariadb', 'mongo', 'redis', 'valkey', 'keydb',
  'memcached', 'elasticsearch', 'opensearch', 'clickhouse', 'cassandra', 'scylla',
  'cockroach', 'influxdb', 'neo4j', 'couchdb', 'rethinkdb', 'minio', 'timescale',
];
const QUEUE_TOKENS = [
  'rabbitmq', 'kafka', 'redpanda', 'nats', 'zookeeper', 'activemq', 'pulsar',
  'mosquitto', 'emqx',
];
// Common public base / sidecar / tooling images that are pulled, never built here.
const PUBLIC_IMAGE_TOKENS = [
  'nginx', 'httpd', 'caddy', 'traefik', 'envoy', 'haproxy', 'busybox', 'alpine',
  'ubuntu', 'debian', 'node', 'python', 'golang', 'openjdk', 'ruby', 'php',
  'registry', 'grafana', 'prometheus', 'pause', 'consul', 'vault', 'jaeger',
];

/**
 * Is this image ref a PULLED public image (so it must NOT match a local
 * Dockerfile heuristically)? True when it's a Docker official-library image
 * (no org segment, e.g. `postgres:15`, `redis`) OR its base name carries a
 * well-known data-store / message-bus / base-image token.
 */
export function isLikelyExternalImage(ref: string): boolean {
  const { name, officialLibrary } = parseImageRef(ref);
  if (officialLibrary) return true;
  const base = name.toLowerCase();
  return [...DATASTORE_TOKENS, ...QUEUE_TOKENS, ...PUBLIC_IMAGE_TOKENS].some((t) => base.includes(t));
}

/**
 * Do two image refs name the same image? Matches on the repository path
 * (registry + tag ignored — a k8s manifest's `ghcr.io/acme/api:prod` and a
 * compose `acme/api` are the same image), with a base-name fallback for when
 * one side qualifies the org and the other doesn't.
 */
function imageRefsMatch(a: string, b: string): boolean {
  const pa = parseImageRef(a);
  const pb = parseImageRef(b);
  if (pa.repository && pa.repository === pb.repository) return true;
  // Fallback: same base name ONLY when exactly one side is org-qualified and the
  // other isn't — the genuine "registry/org-qualified ref vs an unqualified
  // compose tag" case (e.g. `ghcr.io/acme/api` or ECR `…/api` vs compose `api`).
  // Requiring `officialLibrary` to DIFFER means two distinct org-qualified refs
  // (`acme/api` vs `other/api`) never collide on base name alone, and two bare
  // names (`postgres` vs `postgres`) already matched on repository above.
  return pa.name.length > 0 && pa.name === pb.name && pa.officialLibrary !== pb.officialLibrary;
}

// ---------------------------------------------------------------------------
// The pure resolver.

/**
 * Resolve an image ref to the repo-relative source-root dir(s) that build it,
 * using only the injected index (no fs). Returns [] when unresolvable — the
 * caller then emits NO `sourceRoots` (honest "Other"). Never returns the repo
 * root ('') — that would be a catch-all swallowing sibling units.
 *
 * Deterministic: contexts are de-duped and sorted; ties at a signal degrade to
 * [] rather than an arbitrary pick.
 */
export function resolveImageToSourceRoots(imageRef: string, index: DockerfileIndex): string[] {
  if (!imageRef || !imageRef.trim()) return [];

  // Signal 1 — explicit pairing (authoritative; wins even for external-looking
  // names, because the repo literally declared it builds that tag).
  const paired = uniqSorted(
    index.pairings.filter((p) => imageRefsMatch(imageRef, p.image)).map((p) => normalizeRoot(p.context)),
  );
  if (paired.length) return paired;

  // Heuristic signals (2 + 3) never fire for a pulled public image.
  if (isLikelyExternalImage(imageRef)) return [];

  const contexts = uniqSorted(index.dockerfiles.map((d) => normalizeRoot(d.context)));

  // Signal 2 — name-convention: image base name === a context's last segment.
  const { name } = parseImageRef(imageRef);
  if (name) {
    const byName = contexts.filter((c) => lastSegment(c) === name);
    if (byName.length === 1) return byName;
    if (byName.length > 1) return []; // ambiguous → never guess
  }

  // Signal 3 — single-context repo: the one Dockerfile context is the obvious one.
  if (contexts.length === 1) return contexts;

  return [];
}

/** De-dupe, drop the empty (repo-root) context, and sort for determinism. */
function uniqSorted(roots: string[]): string[] {
  return [...new Set(roots.filter((r) => r.length > 0))].sort();
}

// ---------------------------------------------------------------------------
// fs wrapper — walk the repo into a DockerfileIndex (the thin impure shell).

// `Dockerfile`, `Dockerfile.prod`, `api.Dockerfile`, but NOT `.dockerignore`.
const DOCKERFILE_RE = /^Dockerfile(\.[A-Za-z0-9_.-]+)?$|\.Dockerfile$/;

// Compose-file basename (matches compose.ts) — the authoritative pairing source.
const COMPOSE_RE = /^(docker-compose|compose)(\.[A-Za-z0-9_-]+)?\.ya?ml$/i;

/**
 * Walk `repoDir` into a DockerfileIndex: every in-repo Dockerfile (context =
 * its own dir, the docker-build convention) + every compose service that
 * declares BOTH `build:` and `image:` as an explicit image→context pairing.
 * Bounded + error-tolerant (shared walk.ts). Deterministic (sorted).
 */
export function buildDockerfileIndex(repoDir: string): DockerfileIndex {
  const rel = (abs: string): string => (relative(repoDir, abs) || abs).split('\\').join('/');

  const dockerfiles: DockerfileEntry[] = findFiles(repoDir, (_abs, e) => DOCKERFILE_RE.test(e.name)).map(
    (abs) => {
      const file = rel(abs);
      return { dockerfile: file, context: dirOf(file) };
    },
  );

  const pairings: ImagePairing[] = [];
  for (const abs of findFiles(repoDir, (_a, e) => COMPOSE_RE.test(e.name), { maxDepth: 5 })) {
    let config;
    try {
      config = parseComposeConfig(readFileSync(abs, 'utf8'));
    } catch {
      continue; // a malformed compose file shouldn't sink the index
    }
    const composeDir = dirOf(rel(abs));
    for (const svc of config.services) {
      if (svc.build && svc.image) {
        pairings.push({ image: svc.image, context: resolveRel(composeDir, svc.build.context) });
      }
    }
  }

  return { dockerfiles, pairings };
}
