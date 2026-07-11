// SST config parser (ts-morph construct extraction).
//
// SST v3 ("Ion") declares infrastructure as code in `sst.config.ts` — inside
// `async run()` you write `new sst.aws.Function("MyApi", { handler: "…" })`,
// `new sst.aws.Bucket("Uploads")`, `new sst.aws.Nextjs("Web", { path: "…" })`,
// etc. That's the SAME `new <A.B.C>(name, args)` call-site shape the Pulumi
// adapter already walks with ts-morph — so this REUSES `extractPulumiResources`
// (a generic property-access-chain `new`-expression extractor) and filters to the
// `sst.*` namespace, rather than re-implementing the AST walk.
//
// v0 scope: the `sst.config.ts` entry file (the v3 Ion convention). SST v2's
// single-segment construct classes imported into a `stacks/**` dir (`new Api(stack,
// …)`, no `sst.` namespace) are NOT matched — deferred, the same coarse v0 bound
// the Pulumi adapter notes. Pure (string in, data out); no fs, no LLM.

import { extractPulumiResources, providerOf } from '../pulumi/pulumi-parse.js';

/** The `sst` provider namespace — `new sst.aws.Function(...)` / `new sst.Foo(...)`. */
const SST_PROVIDER = 'sst';

export interface SstConstruct {
  /** Full dotted construct path as written: `sst.aws.Function`, `sst.aws.Nextjs`. */
  construct: string;
  /** Last segment of the construct path: `Function`, `Nextjs`, `Bucket`. */
  constructType: string;
  /** The construct's logical name — its first string-literal arg (`"MyApi"`). */
  name: string;
  /** Adapter-local node-id source: the Pulumi `refAddr` = `<construct>.<name>`. */
  refAddr: string;
  /** Variable the `new` is assigned to (powers link/ref edges), if any. */
  varName?: string;
  /** Identifiers referenced in the args (`link: [bucket]`, `{ cluster }`) — for edges. */
  referencedIdentifiers: string[];
  /** Raw props-args text after the logical name — for deterministic source-signal
   * extraction (`handler:`, `path:`, `image:`/`context:`), NEVER for edges. */
  argsText: string;
}

/**
 * Every `new sst.*(...)` construct in an SST config source. Reuses the generic
 * ts-morph extractor and keeps only the `sst` namespace (so an app-code
 * `new Foo.Bar()` or a `new other.aws.X()` is ignored). Tolerant: returns [] on
 * unparseable/empty source (the underlying extractor never throws).
 */
export function extractSstConstructs(sourceText: string, file: string): SstConstruct[] {
  return extractPulumiResources(sourceText, file)
    .filter((r) => providerOf(r.resourceType) === SST_PROVIDER)
    .map((r) => {
      const construct = r.resourceType;
      const lastDot = construct.lastIndexOf('.');
      const constructType = lastDot === -1 ? construct : construct.slice(lastDot + 1);
      // refAddr = `${construct}.${logicalName}` → recover the logical name (which
      // may itself contain ':' in the non-literal-name fallback, so slice, not split).
      const name = r.refAddr.slice(construct.length + 1);
      return {
        construct,
        constructType,
        name,
        refAddr: r.refAddr,
        ...(r.varName ? { varName: r.varName } : {}),
        referencedIdentifiers: r.referencedIdentifiers,
        argsText: r.argsText,
      };
    });
}
