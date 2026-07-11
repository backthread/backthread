// frontend HTTP call-site extraction (the added-scope prerequisite).
//
// Finds the URL string literals a TS/JS frontend uses to call an HTTP API, so the
// cross-language linker (cross-language.ts) can draw the frontend→backend seam of
// a unified full-stack diagram. INSTALL-FREE + never-store-source: a static
// ts-morph parse; only the derived (fileId, url) pairs are kept.
//
// Two collection rules, tuned for the real FastAPI-frontend patterns:
//   1. An `/api…` path or an `http(s)://…/api/…` URL literal ANYWHERE — the
//      dominant shape (a generated OpenAPI SDK — hey-api / openapi-ts — emits
//      `url: '/api/v1/users/'`, and hand-written `fetch('/api/…')` matches too).
//   2. A `/`-rooted path literal that is the URL ARGUMENT of an HTTP call
//      (`fetch(x)`, `axios.get(x)`, `client.post(x)`, `__request(cfg, {url: x})`)
//      — catches conventions that don't prefix `/api` without matching every
//      stray string.
// The generated SDK file itself is dropped by the noise filter, so the linker
// re-attributes these to a surviving sibling module (see cross-language.ts).

import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import { addAllSourceFiles, buildExtractionProject, toId } from './ts-morph-adapter.js';

/** One frontend HTTP call site: the file it's in and the URL path it targets. */
export interface FrontendApiCall {
  fileId: string; // repo-relative posix (may be a noise-dropped generated file)
  url: string; // the literal URL / path
}

// HTTP client callee names (bare identifiers) whose first string arg is a URL.
const HTTP_CALL_IDENTS = new Set(['fetch', '$fetch', 'request', '__request', 'axios', 'ky']);
// Member-call methods (`x.get(url)`) whose first string arg is a URL.
const HTTP_CALL_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'request', 'fetch']);
// Object-literal keys whose string value is a URL (the hey-api `{ url, method }`).
const URL_KEYS = new Set(['url', 'path', 'endpoint']);

/** An `/api…` path or an absolute URL that targets an `/api/…` route. */
function isApiUrl(v: string): boolean {
  if (/^\/api(\/|$|\?)/i.test(v)) return true;
  if (/^https?:\/\/[^/]+\/api(\/|$|\?)/i.test(v)) return true;
  return false;
}

/** A `/`-rooted, non-relative path literal (a candidate API path; not `./x`, `//cdn`). */
function isRootedPath(v: string): boolean {
  return v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/*');
}

function calleeIsHttp(call: Node): boolean {
  const callExpr = call.asKind(SyntaxKind.CallExpression);
  if (!callExpr) return false;
  const callee = callExpr.getExpression();
  if (callee.getKind() === SyntaxKind.Identifier) return HTTP_CALL_IDENTS.has(callee.getText());
  if (callee.getKind() === SyntaxKind.PropertyAccessExpression) {
    const method = (callee.asKind(SyntaxKind.PropertyAccessExpression))!.getName();
    return HTTP_CALL_METHODS.has(method);
  }
  return false;
}

// Is this string literal used AS a URL in an HTTP call? Either the first arg of an
// HTTP-client call, or a `url`/`path`/`endpoint` property in an object literal.
function isUrlArgument(lit: Node): boolean {
  const parent = lit.getParent();
  if (!parent) return false;
  if (parent.getKind() === SyntaxKind.CallExpression && calleeIsHttp(parent)) {
    const args = (parent.asKind(SyntaxKind.CallExpression))!.getArguments();
    return args.length > 0 && args[0] === lit;
  }
  if (parent.getKind() === SyntaxKind.PropertyAssignment) {
    const name = (parent.asKind(SyntaxKind.PropertyAssignment))!.getName().replace(/['"]/g, '');
    return URL_KEYS.has(name);
  }
  return false;
}

function literalUrls(sf: SourceFile): string[] {
  const out: string[] = [];
  const lits: Node[] = [
    ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
  ];
  for (const lit of lits) {
    const v = (lit as unknown as { getLiteralText: () => string }).getLiteralText();
    if (!v) continue;
    if (isApiUrl(v) || (isRootedPath(v) && isUrlArgument(lit))) out.push(v);
  }
  return out;
}

/**
 * Every frontend HTTP call site under `repoDir`. Scans ALL TS/JS source
 * (including generated SDKs — the noise filter drops those from the graph, but
 * they hold the URL literals), so the caller can re-attribute a dropped file to a
 * surviving module. Deterministic (sorted); never throws (a per-file parse error
 * degrades to no calls for that file).
 */
export function collectFrontendApiCalls(repoDir: string): FrontendApiCall[] {
  const project = buildExtractionProject(repoDir);
  addAllSourceFiles(project, repoDir);
  const out: FrontendApiCall[] = [];
  for (const sf of project.getSourceFiles()) {
    const fileId = toId(repoDir, sf.getFilePath());
    let urls: string[] = [];
    try {
      urls = literalUrls(sf);
    } catch {
      urls = [];
    }
    for (const url of urls) out.push({ fileId, url });
  }
  return out.sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}
