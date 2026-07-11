// a dependency-free HCL-subset parser.
//
// DECISION (v0): rather than take an npm HCL dependency (the ticket floats
// `hcl2-parser` "if mature"), we parse the HCL SUBSET Terraform configs use
// with the standard library only. Rationale: (1) it preserves the phase's
// vitest pure-import invariant — a parser that drags no transitive deps stays
// unit-testable in isolation; (2) it avoids a supply-chain dependency on an
// HCL parser of uncertain maintenance for a v0; (3) the dogfood repo (backthread) has
// no `.tf` at all, so Terraform support is validated by fixtures, not the
// dogfood. The subset covers what the topology needs: top-level blocks
// (provider / resource / data / module / variable / output …), their labels,
// and the raw body text (for cross-resource reference scanning). It does NOT
// evaluate expressions, resolve variables, or recurse into module sources —
// those are tracked refinements, not v0 requirements.

export interface HclBlock {
  type: string; // 'resource' | 'data' | 'provider' | 'module' | …
  labels: string[]; // e.g. ['aws_lambda_function', 'api']
  body: string; // raw body text between the braces (for reference scanning)
  /**
   * repo-relative dir of the `.tf`/`.tofu` file this block came from
   * ('' = repo root). parseHcl doesn't set it (it parses one text blob); the
   * adapter's extract() stamps it per file so source-dir attributes (and
   * `${path.module}` refs) resolve against the right module dir.
   */
  dir?: string;
}

// Strip `#` and `//` line comments and C-style block comments (string-aware).
function stripComments(text: string): string {
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
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
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
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

// Index of the `}` matching the `{` at openIndex (string-aware brace balance).
function matchBrace(src: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length - 1; // unbalanced — treat rest of file as the body
}

function parseLabels(raw: string): string[] {
  const labels: string[] = [];
  const re = /"([^"]*)"|([A-Za-z0-9_.-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) labels.push(m[1] ?? m[2]);
  return labels;
}

const HEADER = /^([A-Za-z_]\w*)((?:\s+(?:"[^"]*"|[A-Za-z0-9_.-]+))*)\s*\{/;

/** Parse top-level HCL blocks. Nested blocks stay inside their parent's body. */
export function parseHcl(text: string): HclBlock[] {
  const src = stripComments(text);
  const blocks: HclBlock[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    // Only attempt a header at a token boundary (start, after whitespace or a
    // closing brace) — keeps the scan O(n) in practice on real configs.
    const boundary = i === 0 || /[\s}]/.test(src[i - 1]);
    if (boundary && /[A-Za-z_]/.test(c)) {
      const m = HEADER.exec(src.slice(i));
      if (m) {
        const bodyOpen = i + m[0].length - 1; // index of the `{`
        const bodyClose = matchBrace(src, bodyOpen);
        blocks.push({
          type: m[1],
          labels: parseLabels(m[2]),
          body: src.slice(bodyOpen + 1, bodyClose),
        });
        i = bodyClose + 1;
        continue;
      }
    }
    i++;
  }
  return blocks;
}

/**
 * The "reference surface" of an HCL body: the text where a resource reference
 * could legitimately live — bare HCL traversals (outside any string) plus the
 * contents of `${…}` interpolations (which may sit inside strings). PR #9
 * review: a plain substring scan matched addresses inside prose
 * (`description = "see aws_lambda_function.api docs"`) and invented phantom
 * edges. Stripping string prose (but keeping interpolations) + dropping heredoc
 * bodies removes that false-positive class. Bias is toward MISSING a reference
 * over INVENTING one — an absent edge is recoverable, a phantom edge lies.
 */
export function referenceSurface(body: string): string {
  // Drop heredoc bodies wholesale (policy docs / prose; rarely carry real
  // traversals, and keeping them risks phantom edges).
  const s = body.replace(/<<-?\s*(["']?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2\b/g, ' ');
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = false;
        out += ' ';
        continue;
      }
      if (c === '$' && s[i + 1] === '{') {
        // Keep brace-balanced interpolation contents — a real reference.
        let depth = 0;
        let j = i;
        for (; j < s.length; j++) {
          if (s[j] === '{') depth++;
          else if (s[j] === '}') {
            depth--;
            if (depth === 0) {
              j++;
              break;
            }
          }
        }
        out += ` ${s.slice(i, j)} `;
        i = j - 1;
        continue;
      }
      continue; // ordinary in-string prose — drop
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Whether `text` references the Terraform address `addr` (e.g. `aws_x.api` or
 * `data.aws_y.foo`). Matches the address not preceded by a word char/dot and
 * not followed by a word char — so attribute access (`addr.arn`) counts but a
 * longer sibling name (`addr2`) does not. Callers pass `referenceSurface(body)`
 * so prose inside string literals can't produce phantom matches.
 */
export function bodyReferences(text: string, addr: string): boolean {
  // Terraform addresses are `[A-Za-z0-9_.]` only, so the sole regex-special
  // char to escape is `.` — keeps the pattern construction simple and avoids a
  // brittle full-escape regex literal.
  const escaped = addr.replace(/\./g, '\\.');
  const re = new RegExp('(?<![\\w.])' + escaped + '(?![\\w])');
  return re.test(text);
}
