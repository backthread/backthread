// The Drift foreign-key reference scanner.

import { describe, it, expect } from '../../../testkit.js';
import { scanDriftReferences } from './data-scan.js';

describe('scanDriftReferences', () => {
  it('captures the referenced table classes', () => {
    const src = `
      IntColumn get author => integer().references(Users, #id)();
      IntColumn get category => integer().nullable().references(Categories, #id)();`;
    expect(scanDriftReferences(src)).toEqual(['Users', 'Categories']);
  });
  it('ignores a commented-out reference', () => {
    expect(scanDriftReferences('// .references(Ghost, #id)')).toEqual([]);
  });
});
