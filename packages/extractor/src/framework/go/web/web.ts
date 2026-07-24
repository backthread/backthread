// The Go web FrameworkAdapter — net/http + Gin / Echo / Chi / Fiber / Gorilla. Named
// `go-web`. Go's web surface is CALL-based (no annotations): a router registers routes with
// `r.GET("/x", handler)` and a handler is a func over `http.ResponseWriter` / `gin.Context`
// / … — recovered STATICALLY (install-free, never-store-source) from the Go source. On the
// shared DIR-GRANULAR Go framework layer, so a finding in a file is attributed to its
// package-directory node.
//
//   * detect()        — a web-framework go.mod dep (gin/echo/chi/fiber/gorilla/httprouter)
//                       OR a `net/http` SERVER pattern in source (the swift-ui precedent —
//                       net/http is stdlib, so it has no manifest signal). Bounded source
//                       scan. PURE scorer.
//   * roleTags        — a package whose files REGISTER routes (`.GET(`/`.POST(`/`.Handle(`/
//                       `http.HandleFunc(`/…) OR define HTTP handlers (a func over
//                       `http.ResponseWriter` / `gin.Context` / `echo.Context` / `fiber.Ctx`)
//                       → gateway. METADATA onto the LOCKED `gateway` kind; the kind is never
//                       a new one.
//   * syntheticEdges  — a route registration whose handler is a CROSS-PACKAGE reference
//                       (`r.GET("/x", handlers.List)`) → a `calls` edge router-dir →
//                       handler-package-dir, resolved through the file's imports. A
//                       same-package handler is already inside the same node, so no edge.
//
// Deterministic. KNOWN degrades (heuristic — logged): a handler referenced through an
// aliased import whose alias we can't map, or a method value / closure handler, isn't edged;
// a package that merely passes an http.ResponseWriter through (middleware/util) is tagged
// gateway too (web-layer — accuracy over precision here).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../../detect-util.js';
import { readGoDeps } from '../../../graph/go-manifest.js';
import { listSourceFiles } from '../../../graph/language.js';
import { stripComments } from '../../../graph/go-scan.js';
import { parseGoScope, type GoFile } from '../analyze.js';
import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkContext,
  FrameworkDetectContext,
  FrameworkEdge,
  RoleTag,
} from '../../types.js';

// ---------------------------------------------------------------------------
// Detection.

const WEB_MODULE_PREFIXES = [
  'github.com/gin-gonic/gin',
  'github.com/labstack/echo',
  'github.com/go-chi/chi',
  'github.com/gofiber/fiber',
  'github.com/gorilla/mux',
  'github.com/julienschmidt/httprouter',
];
// A net/http SERVER pattern (not a mere `net/http` import, which an HTTP CLIENT also has).
const NET_HTTP_SERVER_RE = /\bhttp\.(?:ListenAndServe|HandleFunc|NewServeMux|ResponseWriter)\b/;
const DETECT_FILE_CAP = 500;

function depsHaveWebFramework(deps: ReadonlySet<string>): boolean {
  for (const m of deps) for (const p of WEB_MODULE_PREFIXES) if (m === p || m.startsWith(p)) return true;
  return false;
}

export function gatherGoWebSignal(repoDir: string): boolean {
  if (depsHaveWebFramework(readGoDeps(repoDir))) return true;
  let scanned = 0;
  for (const fid of listSourceFiles(repoDir, 'go')) {
    if (scanned++ >= DETECT_FILE_CAP) break;
    let text = '';
    try {
      text = readFileSync(join(repoDir, fid), 'utf8');
    } catch {
      continue;
    }
    if (NET_HTTP_SERVER_RE.test(text)) return true;
  }
  return false;
}

export function scoreGoWeb(hasWeb: boolean, rootPath = ''): DetectMatch | null {
  if (!hasWeb) return null;
  return { adapter: 'go-web', confidence: clampConfidence(0.8), rootPath, metadata: { signals: { web: true } } };
}

// ---------------------------------------------------------------------------
// Role + edge detection.

// A route-registration call: `X.GET(` / `X.POST(` / … or `http.HandleFunc(` / `mux.Handle(`.
const ROUTE_REG_RE =
  /\.\s*(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|Handle|HandleFunc|Mount|Route|Group)\s*\(/;
// An HTTP handler signature/usage: a func over http.ResponseWriter, or a framework Context.
const HANDLER_SIG_RE = /\bhttp\.ResponseWriter\b|\bgin\.Context\b|\becho\.Context\b|\bfiber\.Ctx\b/;
// A route registration whose handler is a qualified cross-package reference:
// `.GET("/x", handlers.List)` / `http.HandleFunc("/x", handlers.List)`. Captures pkg + name.
const ROUTE_HANDLER_REF_RE =
  /(?:\.\s*(?:GET|POST|PUT|DELETE|PATCH|Any|Handle|HandleFunc)|http\.HandleFunc)\s*\(\s*[^,()]*,\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;

const ROLE_PRIORITY = 6; // gateway (web entry) — above data/service tags on the same node.

function isWebPackage(files: readonly GoFile[]): boolean {
  for (const f of files) {
    const stripped = stripComments(f.text);
    if (ROUTE_REG_RE.test(stripped) || HANDLER_SIG_RE.test(stripped)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Analysis.

interface WebAnalysis {
  edges: FrameworkEdge[];
  roles: Map<string, RoleTag>;
}
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, WebAnalysis>();

function analyzeWeb(ctx: FrameworkContext): WebAnalysis {
  const scope = parseGoScope(ctx);

  const roles = new Map<string, RoleTag>();
  for (const [dir, files] of scope.filesByDir) {
    if (isWebPackage(files)) {
      roles.set(dir, { role: 'gateway', kind: 'gateway', priority: ROLE_PRIORITY, metadata: { framework: 'go-web' } });
    }
  }

  // Route-registration edges to cross-package handler packages.
  const edges = new Map<string, FrameworkEdge>();
  const addEdge = (from: string, to: string): void => {
    if (from === to) return;
    const key = `${from}→${to}`;
    if (!edges.has(key)) edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'go-web', relation: 'routes-to' } });
  };
  for (const f of scope.files) {
    const stripped = stripComments(f.text);
    for (const m of stripped.matchAll(ROUTE_HANDLER_REF_RE)) {
      const pkgName = m[1];
      const targetDir = scope.resolvePackageRef(pkgName, f);
      if (targetDir) addEdge(f.dir, targetDir);
    }
  }

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );
  if (roles.size > 0 || sortedEdges.length > 0) {
    console.log(`  [go-web] ${roles.size} gateway package(s) · ${sortedEdges.length} route edge(s)`);
  }
  return { edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): WebAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeWeb(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const goWebAdapter: FrameworkAdapter = {
  name: 'go-web',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    return scoreGoWeb(gatherGoWebSignal(base), rootPath);
  },

  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  scansSourcePath(path: string): boolean {
    return path.endsWith('.go');
  },
};
