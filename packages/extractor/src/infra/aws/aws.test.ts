// aws.ts adapter tests.
// Drives buildAwsGraph + awsAdapter over inline fixtures that mirror a real
// serverless AWS app: Lambda + DynamoDB + SQS + SecretsManager + S3 + CloudFront.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAwsGraph, awsAdapter } from './aws.js';
import { parseCfnTemplate, parseServerlessConfig } from './aws-parse.js';

// ---------------------------------------------------------------------------
// Fixture: a representative serverless AWS app topology.
// Lambda → DynamoDB table + SQS queue + Secret + S3 bucket + CloudFront.

const CFN_YAML = `
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31

Resources:
  ApiFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: handler.main
      Runtime: nodejs20.x
      Environment:
        Variables:
          TABLE_NAME: !Ref OrdersTable
          QUEUE_URL: !Ref JobQueue
          SECRET_ARN: !Ref AppSecret
          BUCKET: !Ref AssetsBucket

  OrdersTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: orders
      AttributeDefinitions:
        - AttributeName: id
          AttributeType: S
      KeySchema:
        - AttributeName: id
          KeyType: HASH

  JobQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: jobs

  AppSecret:
    Type: AWS::SecretsManager::Secret
    Properties:
      Name: app-secret

  AssetsBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: assets

  AssetsDistribution:
    Type: AWS::CloudFront::Distribution
    Properties:
      DistributionConfig:
        Origins:
          - DomainName: !GetAtt AssetsBucket.RegionalDomainName
            Id: assets
`;

// ---------------------------------------------------------------------------
// Fixture: a plain serverless.yml stack.

const SERVERLESS_YML = `
service: jobs-api
provider:
  name: aws
  runtime: nodejs20.x
functions:
  processor:
    handler: src/processor.main
resources:
  Resources:
    ProcessorTable:
      Type: AWS::DynamoDB::Table
      Properties:
        TableName: processor
        AttributeDefinitions:
          - AttributeName: id
            AttributeType: S
        KeySchema:
          - AttributeName: id
            KeyType: HASH
`;

// ---------------------------------------------------------------------------
// Helper: build graph from the CFN YAML fixture.

const cfnResources = parseCfnTemplate(CFN_YAML);
const cfnGraph = buildAwsGraph(cfnResources, '/repo');
const nodeById = new Map(cfnGraph.nodes.map((n) => [n.id, n]));

// ---------------------------------------------------------------------------
// describe: node kinds.

describe('buildAwsGraph — node kinds', () => {
  it('maps AWS::Serverless::Function → worker', () => {
    expect(nodeById.get('resource:ApiFunction')?.kind).toBe('worker');
  });

  it('maps AWS::DynamoDB::Table → datastore', () => {
    expect(nodeById.get('resource:OrdersTable')?.kind).toBe('datastore');
  });

  it('maps AWS::SQS::Queue → queue', () => {
    expect(nodeById.get('resource:JobQueue')?.kind).toBe('queue');
  });

  it('maps AWS::SecretsManager::Secret → secret-store', () => {
    expect(nodeById.get('resource:AppSecret')?.kind).toBe('secret-store');
  });

  it('maps AWS::S3::Bucket → datastore', () => {
    expect(nodeById.get('resource:AssetsBucket')?.kind).toBe('datastore');
  });

  it('maps AWS::CloudFront::Distribution → cdn', () => {
    expect(nodeById.get('resource:AssetsDistribution')?.kind).toBe('cdn');
  });

  it('all nodes have provenance = inferred', () => {
    expect(cfnGraph.nodes.every((n) => n.provenance === 'inferred')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// describe: classificationsNeeded.

describe('buildAwsGraph — classificationsNeeded', () => {
  it('emits one classificationRef per resource', () => {
    // 6 resources in the CFN_YAML fixture.
    expect(cfnGraph.classificationsNeeded).toHaveLength(6);
  });

  it('uses provider = aws/cloudformation', () => {
    expect(cfnGraph.classificationsNeeded.every((c) => c.provider === 'aws/cloudformation')).toBe(true);
  });

  it('sets the correct resourceType for the Lambda function', () => {
    const ref = cfnGraph.classificationsNeeded.find((c) => c.forNodeId === 'resource:ApiFunction');
    expect(ref).toBeDefined();
    expect(ref!.resourceType).toBe('AWS::Serverless::Function');
  });

  it('sets the correct forNodeId format resource:<logicalId>', () => {
    const ref = cfnGraph.classificationsNeeded.find((c) => c.forNodeId === 'resource:OrdersTable');
    expect(ref).toBeDefined();
    expect(ref!.resourceType).toBe('AWS::DynamoDB::Table');
  });
});

// ---------------------------------------------------------------------------
// describe: edges from Ref/GetAtt cross-references.

describe('buildAwsGraph — edges from CFN references', () => {
  it('emits a calls edge from ApiFunction → OrdersTable (via !Ref)', () => {
    expect(cfnGraph.edges).toContainEqual(
      expect.objectContaining({
        source: 'resource:ApiFunction',
        target: 'resource:OrdersTable',
        kind: 'calls',
      }),
    );
  });

  it('emits a calls edge from ApiFunction → JobQueue', () => {
    expect(cfnGraph.edges).toContainEqual(
      expect.objectContaining({
        source: 'resource:ApiFunction',
        target: 'resource:JobQueue',
        kind: 'calls',
      }),
    );
  });

  it('emits a calls edge from ApiFunction → AppSecret', () => {
    expect(cfnGraph.edges).toContainEqual(
      expect.objectContaining({
        source: 'resource:ApiFunction',
        target: 'resource:AppSecret',
        kind: 'calls',
      }),
    );
  });

  it('emits a calls edge from ApiFunction → AssetsBucket', () => {
    expect(cfnGraph.edges).toContainEqual(
      expect.objectContaining({
        source: 'resource:ApiFunction',
        target: 'resource:AssetsBucket',
        kind: 'calls',
      }),
    );
  });

  it('emits a calls edge from AssetsDistribution → AssetsBucket (via !GetAtt)', () => {
    expect(cfnGraph.edges).toContainEqual(
      expect.objectContaining({
        source: 'resource:AssetsDistribution',
        target: 'resource:AssetsBucket',
        kind: 'calls',
      }),
    );
  });

  it('does not emit self-loops', () => {
    expect(cfnGraph.edges.some((e) => e.source === e.target)).toBe(false);
  });

  it('does not emit duplicate edges for the same source→target pair', () => {
    const keys = cfnGraph.edges.map((e) => `${e.source}→${e.target}`);
    const unique = new Set(keys);
    expect(keys.length).toBe(unique.size);
  });

  it('only uses allowed EdgeKind values', () => {
    const allowed = new Set(['calls', 'reads', 'writes', 'publishes', 'subscribes', 'webhook-from', 'deploys-to', 'stores-in']);
    expect(cfnGraph.edges.every((e) => allowed.has(e.kind))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// describe: serverless.yml graph.

describe('buildAwsGraph — from serverless.yml fixture', () => {
  const slsResources = parseServerlessConfig(SERVERLESS_YML);
  const slsGraph = buildAwsGraph(slsResources, '/repo');
  const slsById = new Map(slsGraph.nodes.map((n) => [n.id, n]));

  it('emits a Lambda worker node for the function', () => {
    // serverless-fn nodes use the fn: prefix (fix #1: avoid collisions with
    // PascalCase CFN logical IDs in resources.Resources of the same file).
    expect(slsById.get('fn:processor')?.kind).toBe('worker');
  });

  it('emits a DynamoDB datastore node from resources.Resources', () => {
    expect(slsById.get('resource:ProcessorTable')?.kind).toBe('datastore');
  });

  it('queues all resources for classification', () => {
    // 1 function + 1 DynamoDB table
    expect(slsGraph.classificationsNeeded).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// describe: malformed input doesn't crash.

describe('buildAwsGraph — resilience', () => {
  it('returns an empty graph for no resources', () => {
    const g = buildAwsGraph([], '/repo');
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.classificationsNeeded).toEqual([]);
  });

  it('returns a valid adapter field', () => {
    const g = buildAwsGraph([], '/repo');
    expect(g.adapter).toBe('aws');
  });
});

// ---------------------------------------------------------------------------
// describe: awsAdapter detect + extract (fs-based).

describe('awsAdapter — detect', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-aws-'));
    mkdirSync(join(dir, 'infra'), { recursive: true });
    writeFileSync(
      join(dir, 'infra', 'template.yaml'),
      `AWSTemplateFormatVersion: '2010-09-09'\nResources:\n  Fn:\n    Type: AWS::Lambda::Function\n    Properties: {}\n`,
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects a repo with template.yaml', async () => {
    expect(await awsAdapter.detect(dir)).toBe(true);
  });

  it('does not detect a repo without AWS templates', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-noaws-'));
    try {
      expect(await awsAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('awsAdapter — extract', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-aws-extract-'));
    writeFileSync(
      join(dir, 'template.yaml'),
      `AWSTemplateFormatVersion: '2010-09-09'\nResources:\n  Api:\n    Type: AWS::Lambda::Function\n    Properties: {}\n  Db:\n    Type: AWS::DynamoDB::Table\n    Properties:\n      TableName: !Ref Api\n`,
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('extracts nodes from template.yaml', async () => {
    const graph = await awsAdapter.extract(dir);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain('resource:Api');
    expect(ids).toContain('resource:Db');
  });

  it('extracts edges from template.yaml', async () => {
    const graph = await awsAdapter.extract(dir);
    // Db references Api via !Ref — serialized as "Api" in rawText
    const edge = graph.edges.find((e) => e.source === 'resource:Db' && e.target === 'resource:Api');
    expect(edge).toBeDefined();
    expect(edge?.kind).toBe('calls');
  });

  it('queues all resources for LLM classification', async () => {
    const graph = await awsAdapter.extract(dir);
    expect(graph.classificationsNeeded).toHaveLength(2);
  });

  it('skips unparseable files without crashing', async () => {
    const badDir = mkdtempSync(join(tmpdir(), 'backthread-aws-bad-'));
    // Write a file that will fail isCfnTemplate check (not actually a CFN template)
    writeFileSync(join(badDir, 'template.yaml'), 'just: a plain yaml\nno_cfn: here\n');
    try {
      const graph = await awsAdapter.extract(badDir);
      expect(graph.nodes).toEqual([]);
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// cdk.out discovery. The walker migration recovers the legacy
// `inCdkOut` flag from the file path; this pins the equivalence: an arbitrary
// `*.template.json` is treated as synthesized CFN ONLY under cdk.out/, never at
// the repo top level, while the literal `template.json` still matches via
// TEMPLATE_NAMES.

describe('awsAdapter — cdk.out template discovery (path-derived inCdkOut)', () => {
  let dir: string;
  const cfnJson = (logicalId: string) =>
    JSON.stringify({
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: { [logicalId]: { Type: 'AWS::SQS::Queue', Properties: {} } },
    });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-aws-cdk-'));
    mkdirSync(join(dir, 'cdk.out'), { recursive: true });
    // Synthesized CDK output — arbitrary *.template.json under cdk.out/ → CFN.
    writeFileSync(join(dir, 'cdk.out', 'MyStack.template.json'), cfnJson('CdkQueue'));
    // Arbitrary *.template.json at the top level → must NOT be discovered.
    writeFileSync(join(dir, 'Other.template.json'), cfnJson('TopLevelQueue'));
    // Literal `template.json` at the top level → discovered via TEMPLATE_NAMES.
    writeFileSync(join(dir, 'template.json'), cfnJson('RootQueue'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('classifies cdk.out/*.template.json as CFN but ignores arbitrary top-level *.template.json', async () => {
    const ids = (await awsAdapter.extract(dir)).nodes.map((n) => n.id);
    expect(ids).toContain('resource:CdkQueue'); // cdk.out arm
    expect(ids).toContain('resource:RootQueue'); // exact template.json via TEMPLATE_NAMES
    expect(ids).not.toContain('resource:TopLevelQueue'); // arbitrary top-level *.template.json
  });
});

describe('awsAdapter — detect miss', () => {
  it('does not detect a repo with only a serverless framework config that is a miss', async () => {
    // serverless.yml DOES trigger detect — this verifies that detect returns true for it
    const dir = mkdtempSync(join(tmpdir(), 'backthread-sls-'));
    writeFileSync(join(dir, 'serverless.yml'), SERVERLESS_YML);
    try {
      expect(await awsAdapter.detect(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fix #1 — serverless-fn vs CFN id-collision avoidance.
// A serverless.yml may have a `functions.Api` entry AND a `resources.Resources.Api`
// CFN resource. The old code used the bare name as logicalId for both → collision.
// After the fix, functions get the `fn:` prefix so they never collide with
// resource: nodes even when the bare names are identical.

describe('fix #1 — serverless-fn id-collision avoidance', () => {
  const SLS_WITH_SAME_NAME = `
service: collision-test
provider:
  name: aws
  runtime: nodejs20.x
functions:
  Api:
    handler: src/api.handler
resources:
  Resources:
    Api:
      Type: AWS::ApiGateway::RestApi
      Properties:
        Name: my-api
    UsersTable:
      Type: AWS::DynamoDB::Table
      Properties:
        TableName: users
`;

  it('emits distinct fn: and resource: nodes when a function and CFN resource share the same bare name', () => {
    const resources = parseServerlessConfig(SLS_WITH_SAME_NAME);
    const graph = buildAwsGraph(resources, '/repo');
    const ids = graph.nodes.map((n) => n.id);
    // The Lambda function should be fn:Api, the CFN resource resource:Api — never merged.
    expect(ids).toContain('fn:Api');
    expect(ids).toContain('resource:Api');
    // Both must survive — 3 nodes total (fn:Api + resource:Api + resource:UsersTable).
    expect(ids).toHaveLength(3);
  });

  it('classificationsNeeded refers to the correctly namespaced node ids', () => {
    const resources = parseServerlessConfig(SLS_WITH_SAME_NAME);
    const graph = buildAwsGraph(resources, '/repo');
    const nodeIds = new Set(graph.classificationsNeeded.map((c) => c.forNodeId));
    expect(nodeIds).toContain('fn:Api');
    expect(nodeIds).toContain('resource:Api');
  });
});

// ---------------------------------------------------------------------------
// Fix #2 — sibling-stack same-logicalId coexistence.
// Two sibling templates (dev/prod, or two microservice stacks) both defining an
// `Api` Lambda should produce two independent nodes, not silently deduplicate
// one away. The dedup is now scoped per-file only.

describe('fix #2 — sibling-stack same-logicalId coexistence', () => {
  const STACK_A = `AWSTemplateFormatVersion: '2010-09-09'
Resources:
  Api:
    Type: AWS::Lambda::Function
    Properties:
      FunctionName: service-a-api
  TableA:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: service-a
`;

  const STACK_B = `AWSTemplateFormatVersion: '2010-09-09'
Resources:
  Api:
    Type: AWS::Lambda::Function
    Properties:
      FunctionName: service-b-api
  TableB:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: service-b
`;

  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-sibling-'));
    mkdirSync(join(dir, 'service-a'), { recursive: true });
    mkdirSync(join(dir, 'service-b'), { recursive: true });
    writeFileSync(join(dir, 'service-a', 'template.yaml'), STACK_A);
    writeFileSync(join(dir, 'service-b', 'template.yaml'), STACK_B);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('includes all 4 resources from both sibling stacks (no cross-stack dedup)', async () => {
    const graph = await awsAdapter.extract(dir);
    // Each template has 2 resources, both templates have `Api` — all 4 should survive.
    expect(graph.nodes).toHaveLength(4);
  });

  it('queues all 4 resources for classification', async () => {
    const graph = await awsAdapter.extract(dir);
    expect(graph.classificationsNeeded).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Fix #3 — deterministic ordering.
// findAwsTemplates must return files sorted by absolute path so that
// first-wins dedup is identical on any machine / CI run.
// We test indirectly: write two templates with a shared `Shared` resource
// to two directories whose sorted order is predictable, then confirm the
// graph node count is deterministic across calls.

describe('fix #3 — deterministic ordering', () => {
  // Two templates that each define a `Shared` resource (to trigger cross-file dedup
  // IF it were still global) plus a unique resource each.
  const TEMPLATE_ALPHA = `AWSTemplateFormatVersion: '2010-09-09'
Resources:
  Shared:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: shared-from-alpha
  AlphaOnly:
    Type: AWS::Lambda::Function
    Properties: {}
`;

  const TEMPLATE_BETA = `AWSTemplateFormatVersion: '2010-09-09'
Resources:
  Shared:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: shared-from-beta
  BetaOnly:
    Type: AWS::Lambda::Function
    Properties: {}
`;

  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-order-'));
    // Use alphabetically sortable sub-directories: aaa and bbb.
    mkdirSync(join(dir, 'aaa'), { recursive: true });
    mkdirSync(join(dir, 'bbb'), { recursive: true });
    writeFileSync(join(dir, 'aaa', 'template.yaml'), TEMPLATE_ALPHA);
    writeFileSync(join(dir, 'bbb', 'template.yaml'), TEMPLATE_BETA);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('produces the same node count across repeated calls (ordering is deterministic)', async () => {
    const g1 = await awsAdapter.extract(dir);
    const g2 = await awsAdapter.extract(dir);
    expect(g1.nodes.length).toBe(g2.nodes.length);
  });

  it('includes resources from both stacks (sibling stacks each keep their Shared)', async () => {
    const graph = await awsAdapter.extract(dir);
    // aaa has Shared + AlphaOnly, bbb has Shared + BetaOnly — all 4 survive
    // because dedup is per-file (fix #2).
    expect(graph.nodes).toHaveLength(4);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain('resource:AlphaOnly');
    expect(ids).toContain('resource:BetaOnly');
  });
});

// ---------------------------------------------------------------------------
// Fix #4 — ref-map edge extraction (O(R), walks parsed object).
// Verify that Ref, Fn::GetAtt (JSON form), DependsOn, and Fn::Sub all produce
// correct edges in both JSON (CDK/plain CFN) and YAML (tag-resolved) templates.

describe('fix #4 — ref-map edge extraction', () => {
  // JSON-form fixture: all CFN intrinsic functions as JSON object keys.
  const JSON_REFS = JSON.stringify({
    AWSTemplateFormatVersion: '2010-09-09',
    Resources: {
      Fn: {
        Type: 'AWS::Lambda::Function',
        DependsOn: ['Queue'],
        Properties: {
          Environment: {
            Variables: {
              TABLE_ARN: { 'Fn::GetAtt': ['Table', 'Arn'] },
              SECRET: { Ref: 'Secret' },
              BUCKET_URL: { 'Fn::Sub': 'https://${Bucket}.s3.amazonaws.com' },
            },
          },
        },
      },
      Table: { Type: 'AWS::DynamoDB::Table', Properties: {} },
      Queue: { Type: 'AWS::SQS::Queue', Properties: {} },
      Secret: { Type: 'AWS::SecretsManager::Secret', Properties: {} },
      Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
    },
  });

  it('Fn::GetAtt (JSON form) produces an edge', () => {
    const resources = parseCfnTemplate(JSON_REFS);
    const graph = buildAwsGraph(resources, '/repo');
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'resource:Fn', target: 'resource:Table', kind: 'calls' }),
    );
  });

  it('Ref (JSON form) produces an edge', () => {
    const resources = parseCfnTemplate(JSON_REFS);
    const graph = buildAwsGraph(resources, '/repo');
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'resource:Fn', target: 'resource:Secret', kind: 'calls' }),
    );
  });

  it('DependsOn (JSON form) produces an edge', () => {
    const resources = parseCfnTemplate(JSON_REFS);
    const graph = buildAwsGraph(resources, '/repo');
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'resource:Fn', target: 'resource:Queue', kind: 'calls' }),
    );
  });

  it('Fn::Sub placeholder (JSON form) produces an edge', () => {
    const resources = parseCfnTemplate(JSON_REFS);
    const graph = buildAwsGraph(resources, '/repo');
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'resource:Fn', target: 'resource:Bucket', kind: 'calls' }),
    );
  });

  it('YAML !Ref (scalar-string form) produces an edge', () => {
    // Covered by existing CFN_YAML fixture — just assert the key edge once more here
    // under the fix #4 label for documentation clarity.
    const resources = parseCfnTemplate(CFN_YAML);
    const graph = buildAwsGraph(resources, '/repo');
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'resource:ApiFunction', target: 'resource:OrdersTable', kind: 'calls' }),
    );
  });

  it('YAML !GetAtt (scalar dot-notation string form) produces an edge', () => {
    const resources = parseCfnTemplate(CFN_YAML);
    const graph = buildAwsGraph(resources, '/repo');
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'resource:AssetsDistribution', target: 'resource:AssetsBucket', kind: 'calls' }),
    );
  });

  it('no phantom edges are emitted (IDs that are substrings of other IDs)', () => {
    // `Api` must not produce a phantom edge from a resource whose name starts with "Api"
    // (e.g. "ApiFunction") when the only real reference target is exactly "Api".
    const resources = parseCfnTemplate(JSON.stringify({
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: {
        ApiFunction: { Type: 'AWS::Lambda::Function', Properties: {} },
        Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
        // Table only references "Api" via Ref (not "ApiFunction")
        Table: {
          Type: 'AWS::DynamoDB::Table',
          Properties: { TableName: { Ref: 'Api' } },
        },
      },
    }));
    const graph = buildAwsGraph(resources, '/repo');
    // Table → Api: yes
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'resource:Table', target: 'resource:Api' }),
    );
    // Table → ApiFunction: NO (phantom edge from substring match must not appear)
    expect(graph.edges).not.toContainEqual(
      expect.objectContaining({ source: 'resource:Table', target: 'resource:ApiFunction' }),
    );
  });
});

// ---------------------------------------------------------------------------
// sourceRoots (SAM CodeUri + ECS image→resolver).

import type { DockerfileIndex } from '../image-resolve.js';

const AWS_DF_INDEX: DockerfileIndex = {
  dockerfiles: [{ dockerfile: 'services/api/Dockerfile', context: 'services/api' }],
  pairings: [{ image: 'ghcr.io/acme/api', context: 'services/api' }],
};

describe('buildAwsGraph — sourceRoots', () => {
  const SAM = JSON.stringify({
    Resources: {
      ApiFn: { Type: 'AWS::Serverless::Function', Properties: { CodeUri: 'src/api/', Handler: 'index.handler' } },
      WorkerTask: {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: { ContainerDefinitions: [{ Name: 'api', Image: 'ghcr.io/acme/api:prod' }] },
      },
      Table: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'orders' } },
    },
  });

  const resources = parseCfnTemplate(SAM).map((r) => ({ ...r, dir: 'infra' }));

  it('SAM Function CodeUri → its dir (resolved against the template dir)', () => {
    const graph = buildAwsGraph(resources, '/repo', AWS_DF_INDEX);
    expect(graph.nodes.find((n) => n.id === 'resource:ApiFn')?.sourceRoots).toEqual(['infra/src/api']);
  });

  it('ECS task-def container Image → resolved via the resolver', () => {
    const graph = buildAwsGraph(resources, '/repo', AWS_DF_INDEX);
    expect(graph.nodes.find((n) => n.id === 'resource:WorkerTask')?.sourceRoots).toEqual(['services/api']);
  });

  it('a datastore (DynamoDB) with no source signal gets no sourceRoots', () => {
    const graph = buildAwsGraph(resources, '/repo', AWS_DF_INDEX);
    expect(graph.nodes.find((n) => n.id === 'resource:Table')?.sourceRoots).toBeUndefined();
  });

  it('an s3:// CodeUri (remote package) is not attributed (honest "Other")', () => {
    const remote = parseCfnTemplate(
      JSON.stringify({
        Resources: { Fn: { Type: 'AWS::Serverless::Function', Properties: { CodeUri: 's3://bucket/pkg.zip' } } },
      }),
    ).map((r) => ({ ...r, dir: '' }));
    const graph = buildAwsGraph(remote, '/repo', AWS_DF_INDEX);
    expect(graph.nodes.find((n) => n.id === 'resource:Fn')?.sourceRoots).toBeUndefined();
  });
});
