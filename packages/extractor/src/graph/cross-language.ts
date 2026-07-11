// the cross-language API seam of a unified full-stack diagram.
//
// A polyglot repo (a TS frontend + a Python/FastAPI backend) extracts as ONE
// merged graph (extract.ts), but the two languages share no import edge — so
// without this the frontend and backend render as two disconnected islands. This
// draws the COARSE, subsystem-level seam the issue scopes for v1: a frontend
// module that calls an `/api/…` route → the backend gateway/router module it hits.
// (Per-endpoint route-matched edges are a documented refinement, not v1.)
//
// Inputs, both static + install-free: the frontend HTTP call sites
// (http-callsites.ts) and the FastAPI route surface (fastapi.collectFastApiRouteSurface).
// Endpoints are repo-relative FILE ids in the graph's file-id space; the generic
// contribute-step resolves them to MODULE ids, drops self-edges, dedupes, and
// 8-verb-validates — exactly like a framework adapter's syntheticEdges. Returns []
// (no seam) for a single-language repo or a non-FastAPI backend, so single-language
// output is byte-identical.

import { collectFrontendApiCalls } from './http-callsites.js';
import { collectFastApiRouteSurface, type FastApiRouteSurface } from '../framework/fastapi/fastapi.js';
import type { NormalizedGraph } from './types.js';
import type { FrameworkEdge } from '../framework/types.js';

const TS_LANGS = new Set(['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs']);
const PY_LANGS = new Set(['py', 'pyi']);

// Normalize a URL/path for matching: drop scheme+host, query, and a trailing slash.
function urlPath(url: string): string {
  let p = url.replace(/^https?:\/\/[^/]+/i, '');
  const q = p.search(/[?#]/);
  if (q >= 0) p = p.slice(0, q);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

// Does a router `prefix` (e.g. '/users') appear as a whole path segment of `url`?
function prefixMatches(url: string, prefix: string): boolean {
  const pre = prefix.startsWith('/') ? prefix : `/${prefix}`;
  return url === pre || url.startsWith(`${pre}/`) || url.includes(`${pre}/`) || url.endsWith(pre);
}

/**
 * The backend file a frontend URL targets: the router whose prefix matches (most
 * specific — longest prefix — wins, lexical fileId tiebreak), else the FastAPI app
 * gateway (the coarse fallback), else the lexically-smallest router. Undefined
 * only when the surface is empty.
 */
function matchBackend(url: string, surface: FastApiRouteSurface): string | undefined {
  const path = urlPath(url);
  let bestFile: string | undefined;
  let bestLen = -1;
  for (const router of surface.routers) {
    for (const prefix of router.prefixes) {
      if (!prefixMatches(path, prefix) || prefix.length < bestLen) continue;
      if (prefix.length > bestLen || (bestFile !== undefined && router.fileId < bestFile)) {
        bestLen = prefix.length;
        bestFile = router.fileId;
      }
    }
  }
  if (bestFile) return bestFile;
  if (surface.appFiles.length > 0) return surface.appFiles[0];
  return surface.routers.length > 0 ? surface.routers[0].fileId : undefined;
}

// Re-attribute a call's file to a SURVIVING module-source file: the file itself if
// it survived the noise filter, else the lexically-smallest surviving file in the
// nearest ancestor directory (a generated SDK — src/client/sdk.gen.ts — is dropped,
// but its client/ siblings survive and carry the same module). Memoized per file.
function makeSurvivorResolver(surviving: ReadonlySet<string>): (fileId: string) => string | undefined {
  const sortedSurvivors = [...surviving].sort();
  const cache = new Map<string, string | undefined>();
  return (fileId: string): string | undefined => {
    if (surviving.has(fileId)) return fileId;
    if (cache.has(fileId)) return cache.get(fileId);
    let dir = fileId.includes('/') ? fileId.slice(0, fileId.lastIndexOf('/')) : '';
    let result: string | undefined;
    for (;;) {
      const prefix = dir ? `${dir}/` : '';
      const hit = sortedSurvivors.find((f) => f.startsWith(prefix));
      if (hit) {
        result = hit;
        break;
      }
      if (dir === '') break;
      dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    }
    cache.set(fileId, result);
    return result;
  };
}

/**
 * The cross-language frontend→backend edges (file-id space, kind 'calls'). Empty
 * for a single-language repo or a non-FastAPI backend. Deterministic.
 */
export function crossLanguageApiEdges(args: { repoDir: string; graph: NormalizedGraph }): FrameworkEdge[] {
  const { repoDir, graph } = args;
  const tsFiles = graph.files.filter((f) => TS_LANGS.has(f.language)).map((f) => f.id);
  const pyFiles = graph.files.filter((f) => PY_LANGS.has(f.language)).map((f) => f.id);
  if (tsFiles.length === 0 || pyFiles.length === 0) return []; // not polyglot

  const surface = collectFastApiRouteSurface(repoDir, pyFiles);
  if (surface.routers.length === 0 && surface.appFiles.length === 0) return []; // backend isn't FastAPI

  const calls = collectFrontendApiCalls(repoDir);
  if (calls.length === 0) return [];

  const survivorOf = makeSurvivorResolver(new Set(tsFiles));
  const edges = new Map<string, FrameworkEdge>();
  for (const call of calls) {
    const src = survivorOf(call.fileId);
    if (!src) continue;
    const target = matchBackend(call.url, surface);
    if (!target || src === target) continue;
    const key = `${src}→${target}`;
    if (!edges.has(key)) {
      edges.set(key, { source: src, target, kind: 'calls', metadata: { relation: 'http-api', crossLanguage: true } });
    }
  }
  return [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );
}
