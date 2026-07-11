// externalIdFor — package-node normalization. Pure (graph/types.ts has no
// heavy imports), so it collects clean.
//
// The version-pin cases are the DQ dogfood regression: a Deno edge function
// importing `npm:@supabase/supabase-js@2` was producing the node
// `@supabase/supabase-js@2`, which the classifier's fail-loud sanitizer
// (correctly) rejected. The fix strips the version at the producer.

import { describe, it, expect } from '../testkit.js';
import { externalIdFor, pythonExternalIdFor } from './types.js';

describe('externalIdFor', () => {
  it('collapses sub-paths to the package node', () => {
    expect(externalIdFor('@scope/pkg/sub').id).toBe('ext:@scope/pkg');
    expect(externalIdFor('pkg/sub').id).toBe('ext:pkg');
  });

  it('strips jsr:/npm:/node: registry prefixes', () => {
    expect(externalIdFor('jsr:@supabase/functions-js').specifier).toBe('@supabase/functions-js');
    expect(externalIdFor('npm:lodash').specifier).toBe('lodash');
  });

  it('strips a Deno-style version pin from a scoped package', () => {
    expect(externalIdFor('npm:@supabase/supabase-js@2').specifier).toBe('@supabase/supabase-js');
    expect(externalIdFor('jsr:@supabase/supabase-js@2.45.0/dist').id).toBe('ext:@supabase/supabase-js');
  });

  it('strips a version pin from an unscoped package', () => {
    expect(externalIdFor('npm:lodash@4.17.21').specifier).toBe('lodash');
  });

  it('leaves a plain scoped/unscoped specifier untouched', () => {
    expect(externalIdFor('@supabase/supabase-js').specifier).toBe('@supabase/supabase-js');
    expect(externalIdFor('react').specifier).toBe('react');
  });
});

describe('pythonExternalIdFor', () => {
  it('collapses a dotted module to its top-level package', () => {
    expect(pythonExternalIdFor('sqlalchemy.orm').id).toBe('ext:sqlalchemy');
    expect(pythonExternalIdFor('google.cloud.storage').specifier).toBe('google');
  });

  it('leaves a bare top-level name untouched', () => {
    expect(pythonExternalIdFor('fastapi')).toEqual({ id: 'ext:fastapi', specifier: 'fastapi' });
  });
});
