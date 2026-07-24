// Pure Go syntactic scanner — package/import scanning, comment + raw-string stripping,
// stdlib heuristic, and external-id bucketing.

import { describe, it, expect } from '../testkit.js';
import { stripComments, scanPackage, scanImports, isGoStdlib, goExternalId } from './go-scan.js';

describe('scanPackage', () => {
  it('reads the package clause', () => {
    expect(scanPackage('package main\n\nfunc main() {}\n')).toBe('main');
  });
  it('is empty when there is no package clause', () => {
    expect(scanPackage('// just a comment\n')).toBe('');
  });
  it('ignores a package keyword inside a comment', () => {
    expect(scanPackage('// package fake\npackage real\n')).toBe('real');
  });
});

describe('scanImports', () => {
  it('reads single, block, aliased, blank, and dot imports', () => {
    const src = [
      'package main',
      '',
      'import "fmt"',
      'import (',
      '\t"net/http"',
      '\tm "github.com/foo/bar"',
      '\t_ "github.com/blank/pkg"',
      '\t. "github.com/dot/pkg"',
      ')',
      '',
      'func main() {}',
    ].join('\n');
    expect(scanImports(src)).toEqual([
      'fmt',
      'net/http',
      'github.com/foo/bar',
      'github.com/blank/pkg',
      'github.com/dot/pkg',
    ]);
  });
  it('handles a single-line import block', () => {
    expect(scanImports('package p\nimport ("fmt")\nfunc x(){}\n')).toEqual(['fmt']);
  });
  it('ignores imports inside comments and stops at the first declaration', () => {
    const src = [
      'package main',
      '// import "line/commented"',
      '/* import "block/commented" */',
      'import "real/kept"',
      '',
      'const doc = `',
      'import (',
      '  "raw/string/import"',
      ')',
      '`',
    ].join('\n');
    expect(scanImports(src)).toEqual(['real/kept']);
  });
});

describe('isGoStdlib', () => {
  it('is true for a path with no dot in its first element', () => {
    expect(isGoStdlib('fmt')).toBe(true);
    expect(isGoStdlib('net/http')).toBe(true);
    expect(isGoStdlib('encoding/json')).toBe(true);
  });
  it('is false for a domain-rooted third-party path', () => {
    expect(isGoStdlib('github.com/gin-gonic/gin')).toBe(false);
    expect(isGoStdlib('golang.org/x/sync')).toBe(false);
    expect(isGoStdlib('gopkg.in/yaml.v3')).toBe(false);
  });
});

describe('goExternalId', () => {
  const mods = new Set(['github.com/gin-gonic/gin', 'golang.org/x/sync', 'gopkg.in/yaml.v3']);
  it('buckets by the LONGEST declared module prefix', () => {
    expect(goExternalId('github.com/gin-gonic/gin/render', mods).id).toBe('ext:github.com/gin-gonic/gin');
    expect(goExternalId('golang.org/x/sync/errgroup', mods).id).toBe('ext:golang.org/x/sync');
    expect(goExternalId('gopkg.in/yaml.v3', mods).id).toBe('ext:gopkg.in/yaml.v3');
  });
  it('falls back to host/org/repo (first three segments) when no module matches', () => {
    expect(goExternalId('github.com/spf13/cobra/doc', mods).id).toBe('ext:github.com/spf13/cobra');
    expect(goExternalId('golang.org/x/net/http2', mods).id).toBe('ext:golang.org/x/net');
  });
  it('does not false-match a module that is not a path-aligned prefix', () => {
    expect(goExternalId('golang.org/x/synchronize', mods).id).toBe('ext:golang.org/x/synchronize');
  });
});

describe('stripComments', () => {
  it('blanks comments + raw strings + runes but KEEPS interpreted strings, preserving lines', () => {
    const src = 'x := "keep-me" // drop\nr := `raw\ndrop`\nc := \'z\'\n/* block */\n';
    const out = stripComments(src);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).toContain('keep-me'); // interpreted string content survives
    expect(out).not.toContain('drop'); // line comment + raw string blanked
    expect(out).not.toContain('block'); // block comment blanked
    expect(out).not.toContain('raw');
  });
  it('does not treat // inside an interpreted string as a comment', () => {
    // The URL string is kept intact; nothing after it on the line is a comment start.
    expect(scanImports('package p\nimport "net/url" // c\nvar u = "http://x"\n')).toEqual(['net/url']);
  });
});
