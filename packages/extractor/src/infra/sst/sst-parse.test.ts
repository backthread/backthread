// SST parser tests (pure: ts-morph source in, constructs out).

import { describe, it, expect } from '../../testkit.js';
import { extractSstConstructs } from './sst-parse.js';

const CONFIG = `
/// <reference path="./.sst/platform/config.d.ts" />
export default $config({
  app() { return { name: "myapp", home: "aws" }; },
  async run() {
    const uploads = new sst.aws.Bucket("Uploads");
    const api = new sst.aws.Function("Api", {
      handler: "packages/functions/src/api.handler",
      link: [uploads],
    });
    new sst.aws.Nextjs("Web", { path: "packages/web", link: [api] });
    const helper = new MyHelper("notInfra", { foo: 1 });
  },
});
`;

describe('extractSstConstructs', () => {
  const constructs = extractSstConstructs(CONFIG, 'sst.config.ts');
  const byType = new Map(constructs.map((c) => [c.constructType, c]));

  it('extracts every sst.* construct with its full + short type and logical name', () => {
    expect([...byType.keys()].sort()).toEqual(['Bucket', 'Function', 'Nextjs']);
    expect(byType.get('Function')?.construct).toBe('sst.aws.Function');
    expect(byType.get('Function')?.name).toBe('Api');
    expect(byType.get('Bucket')?.name).toBe('Uploads');
  });

  it('ignores non-sst `new X.Y()` and single-segment `new Class()`', () => {
    expect(constructs.some((c) => c.constructType === 'MyHelper')).toBe(false);
  });

  it('keeps argsText for source-signal extraction', () => {
    expect(byType.get('Function')?.argsText).toContain('handler');
    expect(byType.get('Nextjs')?.argsText).toContain('packages/web');
  });

  it('captures varName + referenced identifiers for link edges', () => {
    expect(byType.get('Function')?.varName).toBe('api');
    expect(byType.get('Function')?.referencedIdentifiers).toContain('uploads'); // link: [uploads]
    expect(byType.get('Nextjs')?.referencedIdentifiers).toContain('api'); // link: [api]
  });

  it('tolerates empty / unparseable source (returns [])', () => {
    expect(extractSstConstructs('', 'sst.config.ts')).toEqual([]);
    expect(extractSstConstructs('export default $config({ run() {', 'sst.config.ts')).toEqual([]);
  });
});
