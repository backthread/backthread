// wrangler config parser (JSONC + a TOML subset).
//
// The Cloudflare adapter targets BOTH `wrangler.jsonc` (the newer default, and
// what the example-ingest-worker dogfood uses) and `wrangler.toml` (the historical
// default, still the majority of repos in the wild). Both describe the same
// binding model, so we normalize each into the same plain JS object shape that
// `cloudflare.ts` reads — a JSON-faithful tree of tables / arrays / scalars.
//
// DEPENDENCY-FREE on purpose (only the standard library): same invariant as
// classify/env-vars.ts — a pure parser stays unit-testable without dragging the
// Supabase/Anthropic import chain in (vitest doesn't rewrite the `.js` suffixes
// those modules carry). The TOML support is a deliberate SUBSET: tables,
// array-of-tables, inline tables/arrays, and scalar strings/ints/floats/bools —
// everything wrangler.toml actually uses. Heredocs, dotted-key assignment, and
// datetime literals are not supported (wrangler configs don't use them); a line
// the subset can't parse is skipped rather than throwing, so a slightly-exotic
// config degrades to a partial graph instead of failing the whole ingest.

/** JSON-faithful parse tree — what both parsers return and cloudflare.ts reads. */
export type WranglerTree = Record<string, unknown>;

// ---------------------------------------------------------------------------
// JSONC — JSON with `//` line comments and `/* */` block comments + trailing
// commas. Strip comments (string-aware) and trailing commas, then JSON.parse.

export function parseJsonc(text: string): WranglerTree {
  const parsed = JSON.parse(stripJsoncComments(text));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('wrangler jsonc: top-level value must be an object');
  }
  return parsed as WranglerTree;
}

// Strip `//` + `/* */` comments AND trailing commas, all inside ONE string-aware
// pass. PR #9 review: the old post-hoc global `replace(/,(\s*[}\]])/g, …)` ran
// over the whole document including string VALUES, so a literal like `"x,}"`
// silently lost its comma. Trailing-comma removal must be string-aware too —
// here we only drop a `,` when not inside a string and the next non-whitespace
// char is `}`/`]`.
function stripJsoncComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; // land on the '/', loop's i++ steps past it
      continue;
    }
    if (c === ',') {
      // Trailing comma? Peek past whitespace/comments-free run for `}`/`]`.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue; // drop the comma
    }
    out += c;
  }
  return out;
}

// ---------------------------------------------------------------------------
// TOML subset. Walks lines, tracking the current table context. `[a.b]`
// descends into nested tables; `[[a.b]]` pushes a new element onto an
// array-of-tables. Scalars and inline arrays/tables parse via a small
// recursive value reader.

export function parseTomlSubset(text: string): WranglerTree {
  const root: WranglerTree = {};
  let current: WranglerTree = root;

  for (const rawLine of text.split('\n')) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const arrayTable = line.match(/^\[\[\s*([^\]]+?)\s*\]\]$/);
    if (arrayTable) {
      current = descendArrayTable(root, arrayTable[1].trim());
      continue;
    }
    const table = line.match(/^\[\s*([^\]]+?)\s*\]$/);
    if (table) {
      current = descendTable(root, table[1].trim());
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue; // unparseable line — skip rather than throw
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, '');
    const value = parseTomlValue(line.slice(eq + 1).trim());
    if (key) current[key] = value;
  }
  return root;
}

function stripTomlComment(line: string): string {
  let inString = false;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === quote && line[i - 1] !== '\\') inString = false;
    } else if (c === '"' || c === "'") {
      inString = true;
      quote = c;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

// Walk/create a dotted-path table, returning the leaf table object.
function descendTable(root: WranglerTree, path: string): WranglerTree {
  const segments = splitDottedPath(path);
  let node = root;
  for (const seg of segments) {
    const existing = node[seg];
    if (Array.isArray(existing)) {
      // dotted key into an array-of-tables addresses its last element
      node = existing[existing.length - 1] as WranglerTree;
    } else if (existing && typeof existing === 'object') {
      node = existing as WranglerTree;
    } else {
      const created: WranglerTree = {};
      node[seg] = created;
      node = created;
    }
  }
  return node;
}

// Walk to the parent of the array, append a fresh element, return it.
function descendArrayTable(root: WranglerTree, path: string): WranglerTree {
  const segments = splitDottedPath(path);
  const last = segments.pop()!;
  let node = root;
  for (const seg of segments) {
    const existing = node[seg];
    if (Array.isArray(existing)) node = existing[existing.length - 1] as WranglerTree;
    else if (existing && typeof existing === 'object') node = existing as WranglerTree;
    else {
      const created: WranglerTree = {};
      node[seg] = created;
      node = created;
    }
  }
  if (!Array.isArray(node[last])) node[last] = [];
  const arr = node[last] as WranglerTree[];
  const element: WranglerTree = {};
  arr.push(element);
  return element;
}

// Split `a.b."c.d"` on unquoted dots.
function splitDottedPath(path: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inString = false;
  let quote = '';
  for (const c of path) {
    if (inString) {
      if (c === quote) inString = false;
      else buf += c;
    } else if (c === '"' || c === "'") {
      inString = true;
      quote = c;
    } else if (c === '.') {
      out.push(buf.trim());
      buf = '';
    } else buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function parseTomlValue(raw: string): unknown {
  const v = raw.trim();
  if (v.startsWith('[')) return parseInlineArray(v);
  if (v.startsWith('{')) return parseInlineTable(v);
  if (v.startsWith('"') || v.startsWith("'")) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  return v; // bare string fallback (e.g. unquoted enum)
}

// Split top-level comma items respecting nested brackets/braces and strings.
function splitTopLevel(inner: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let buf = '';
  let inString = false;
  let quote = '';
  for (const c of inner) {
    if (inString) {
      buf += c;
      if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      buf += c;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      if (buf.trim()) items.push(buf.trim());
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.trim()) items.push(buf.trim());
  return items;
}

function parseInlineArray(v: string): unknown[] {
  return splitTopLevel(v.slice(1, -1)).map(parseTomlValue);
}

function parseInlineTable(v: string): WranglerTree {
  const obj: WranglerTree = {};
  for (const item of splitTopLevel(v.slice(1, -1))) {
    const eq = item.indexOf('=');
    if (eq === -1) continue;
    const key = item.slice(0, eq).trim().replace(/^["']|["']$/g, '');
    obj[key] = parseTomlValue(item.slice(eq + 1).trim());
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Dispatch by extension.

export function parseWranglerConfig(text: string, filename: string): WranglerTree {
  return /\.toml$/i.test(filename) ? parseTomlSubset(text) : parseJsonc(text);
}
