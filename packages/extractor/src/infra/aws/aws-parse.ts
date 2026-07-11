// AWS-native cluster adapter: CloudFormation/SAM/serverless.yml parser.
//
// Parses CloudFormation (YAML/JSON), SAM templates, synthesized CDK templates
// (cdk.out/*.template.json — which ARE just CFN JSON), and Serverless Framework
// (serverless.yml) into a flat list of { logicalId, type, rawText } records.
//
// CloudFormation YAML CAVEAT: CFN templates use YAML intrinsic short-form tags
// (!Ref, !GetAtt, !Sub, !Join, !Select, !If, !Equals, etc.). The `yaml`
// package v2 handles unknown tags gracefully when `logLevel: 'silent'` is set:
// scalar-tagged nodes resolve to their raw scalar value string, so
// `!Ref OrdersTable` → the string `"OrdersTable"` and
// `!GetAtt AssetsBucket.Arn` → the string `"AssetsBucket.Arn"`.
// This is exactly what we need: the logicalId appears in the JSON-serialized
// rawText as a quoted string value (or as a prefix of "Id.Attr" for GetAtt),
// enabling correct reference detection. Registering custom tags that return
// empty strings would ERASE the reference information we need, so we use
// logLevel:'silent' only.
//
// v0 scope: implemented here — CFN YAML/JSON, SAM, serverless.yml, cdk.out.
// DEFERRED: raw ECS task-def JSON (no declarative resource map), Elastic
// Beanstalk .elasticbeanstalk/config.yml (deployment config, not topology),
// CDK TypeScript source (synthesized cdk.out is handled as CFN JSON).

import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Parsed resource record.

export interface CfnResource {
  /** CloudFormation logical ID (the map key under `Resources:`). */
  logicalId: string;
  /** AWS resource type, e.g. `AWS::Lambda::Function`. */
  type: string;
  /**
   * Raw text representation of this resource's block — used for reference
   * scanning. We JSON-serialize the parsed JS value so tag quirks (which may
   * leave some values as strings like "!Ref Foo") are preserved as-is and
   * still searchable.
   */
  rawText: string;
  /**
   * Source discriminator: 'cfn' for resources from CloudFormation/SAM
   * Resources blocks; 'serverless-fn' for synthetic Lambda nodes synthesized
   * from a Serverless Framework `functions:` block. Used by aws.ts to
   * namespace node IDs and avoid collisions between the two flat namespaces.
   */
  source: 'cfn' | 'serverless-fn';
  /**
   * repo-relative dir of the template/serverless file this resource came
   * from ('' = repo root). parseCfnTemplate/parseServerlessConfig don't set it
   * (they parse one text blob); aws.ts's extract() stamps it per file so a SAM
   * `CodeUri` resolves against the template dir. Optional for back-compat.
   */
  dir?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers.

function tryParseYaml(text: string): unknown {
  // Use logLevel:'silent' — yaml v2 resolves unknown tags (!Ref, !GetAtt, etc.)
  // to their scalar string value instead of throwing. This preserves the
  // logicalId references we need for edge detection in rawText.
  try {
    return parseYaml(text, { logLevel: 'silent' });
  } catch {
    return null;
  }
}

/** Extract CfnResource[] from a parsed CloudFormation/SAM template object. */
function extractFromCfnObject(obj: unknown): CfnResource[] {
  if (!obj || typeof obj !== 'object') return [];
  const top = obj as Record<string, unknown>;
  const resources = top['Resources'];
  if (!resources || typeof resources !== 'object') return [];
  const map = resources as Record<string, unknown>;
  const out: CfnResource[] = [];
  for (const [logicalId, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const type = typeof e['Type'] === 'string' ? e['Type'] : undefined;
    if (!type) continue;
    // Serialize the whole resource block as the raw text for reference scanning.
    let rawText: string;
    try {
      rawText = JSON.stringify(e);
    } catch {
      rawText = String(e);
    }
    out.push({ logicalId, type, rawText, source: 'cfn' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public: parse a CFN/SAM template (YAML or JSON).

/**
 * Parse a CloudFormation or SAM template from text (YAML or JSON).
 * Returns [] (never throws) on any parse failure — callers skip-and-warn.
 */
export function parseCfnTemplate(text: string): CfnResource[] {
  // Attempt JSON first (CDK synthesized output, plain CFN JSON).
  try {
    const obj = JSON.parse(text);
    const result = extractFromCfnObject(obj);
    if (result.length > 0) return result;
  } catch {
    // not JSON
  }
  // Try YAML (CFN YAML, SAM templates).
  const obj = tryParseYaml(text);
  return extractFromCfnObject(obj);
}

// ---------------------------------------------------------------------------
// Public: parse a Serverless Framework serverless.yml.
//
// Serverless Framework format:
//   provider:
//     name: aws
//   functions:
//     myFunction:
//       handler: handler.main
//       ...
//   resources:
//     Resources:
//       MyTable:
//         Type: AWS::DynamoDB::Table
//         ...
//
// We synthesize:
//   - One AWS::Lambda::Function node per `functions:` entry.
//   - All raw CFN resources under `resources.Resources`.

export function parseServerlessConfig(text: string): CfnResource[] {
  const obj = tryParseYaml(text);
  if (!obj || typeof obj !== 'object') return [];
  const top = obj as Record<string, unknown>;

  const out: CfnResource[] = [];

  // Functions → synthetic Lambda nodes.
  const functions = top['functions'];
  if (functions && typeof functions === 'object' && !Array.isArray(functions)) {
    const fns = functions as Record<string, unknown>;
    for (const [fnName, fnDef] of Object.entries(fns)) {
      let rawText: string;
      try {
        rawText = JSON.stringify(fnDef ?? {});
      } catch {
        rawText = '{}';
      }
      out.push({
        logicalId: fnName,
        type: 'AWS::Lambda::Function',
        rawText,
        source: 'serverless-fn',
      });
    }
  }

  // resources.Resources → raw CFN passthrough.
  const resBlock = top['resources'];
  if (resBlock && typeof resBlock === 'object') {
    const synth: Record<string, unknown> = { Resources: (resBlock as Record<string, unknown>)['Resources'] };
    out.push(...extractFromCfnObject(synth));
  }

  return out;
}

// ---------------------------------------------------------------------------
// Detect helpers (used by the bounded walk in aws.ts).

/** Returns true if the text looks like a CloudFormation template.
 * Accepts both YAML (`AWSTemplateFormatVersion: '...'`, `Transform: AWS::Serverless`)
 * and JSON (`"AWSTemplateFormatVersion"`, `"Transform": "AWS::Serverless-2016-10-31"`).
 */
export function isCfnTemplate(text: string): boolean {
  return text.includes('AWSTemplateFormatVersion') || text.includes('AWS::Serverless');
}
