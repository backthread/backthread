// Go framework-analysis primitives — alias-aware import scanning + struct type/field scans.

import { describe, it, expect } from '../../testkit.js';
import { scanGoImportRefs, scanStructTypeNames, scanStructFieldTypes } from './analyze.js';
import { stripComments } from '../../graph/go-scan.js';

describe('scanGoImportRefs', () => {
  it('keeps the local qualifier name (alias or last segment); drops _ and .', () => {
    const src = [
      'package main',
      'import (',
      '\t"net/http"',
      '\th "github.com/acme/app/handlers"', // alias h
      '\t_ "github.com/lib/pq"', // blank → no name
      '\t"github.com/acme/app/models"', // last segment → models
      ')',
      'func main() {}',
    ].join('\n');
    const refs = scanGoImportRefs(src);
    const byName = new Map(refs.filter((r) => r.name).map((r) => [r.name!, r.path]));
    expect(byName.get('http')).toBe('net/http');
    expect(byName.get('h')).toBe('github.com/acme/app/handlers');
    expect(byName.get('models')).toBe('github.com/acme/app/models');
    // the blank import has no usable name.
    expect(refs.some((r) => r.path === 'github.com/lib/pq' && r.name === undefined)).toBe(true);
  });
});

describe('scanStructTypeNames', () => {
  it('captures exported struct type names', () => {
    const src = 'package m\ntype User struct {\n  ID uint\n}\ntype order struct {}\ntype Alias = int\n';
    expect(scanStructTypeNames(src)).toEqual(['User']); // exported struct only; `order` unexported, `Alias` not a struct
  });
});

describe('scanStructFieldTypes', () => {
  it('captures model-ish field types (slice element, pointer, qualified); skips primitives + embeds', () => {
    const src = [
      'package m',
      'type User struct {',
      '\tgorm.Model', // embed — not a field association
      '\tName    string', // primitive — not captured
      '\tOrders  []Order', // has-many → Order',
      '\tProfile *Profile', // has-one → Profile',
      '\tAddr    models.Address', // qualified → models.Address',
      '}',
    ].join('\n');
    const types = new Set(scanStructFieldTypes(stripComments(src)));
    expect(types.has('Order')).toBe(true);
    expect(types.has('Profile')).toBe(true);
    expect(types.has('models.Address')).toBe(true);
    expect(types.has('Name')).toBe(false);
  });
  it('handles a nested anonymous struct without leaking its fields', () => {
    const src = 'package m\ntype User struct {\n\tAddr struct {\n\t\tCity string\n\t}\n\tPets []Pet\n}';
    const types = new Set(scanStructFieldTypes(stripComments(src)));
    expect(types.has('Pet')).toBe(true);
    expect(types.has('City')).toBe(false);
  });
});
