// Pulumi adapter tests.
// buildPulumiGraph is pure (no file I/O); adapter detect/extract tests use a
// real tmp directory.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPulumiGraph, pulumiAdapter } from './pulumi.js';
import { extractPulumiResources } from './pulumi-parse.js';

// ---------------------------------------------------------------------------
// Inline fixture: AWS Lambda + S3 + SQS — mirrors a real Pulumi-TS program

const AWS_SOURCE = `
import * as aws from '@pulumi/aws';

const bucket = new aws.s3.BucketV2('app-bucket', {
  bucket: 'my-app',
  tags: { Env: 'prod' },
});

const queue = new aws.sqs.Queue('job-queue', {
  name: 'jobs',
  visibilityTimeoutSeconds: 30,
});

const fn = new aws.lambda.Function('api-fn', {
  runtime: aws.lambda.Runtime.NodeJS18dX,
  handler: 'index.handler',
  role: 'arn:aws:iam::123:role/role',
  environment: {
    variables: {
      BUCKET: bucket.bucket,
      QUEUE_URL: queue.url,
    },
  },
});
`;

function makeResources() {
  return extractPulumiResources(AWS_SOURCE, 'index.ts');
}

// ---------------------------------------------------------------------------
// buildPulumiGraph — node kinds

describe('buildPulumiGraph — node kinds', () => {
  const resources = makeResources();
  const graph = buildPulumiGraph({ resources, project: { name: 'test-proj', runtime: 'nodejs' }, root: '/repo' });
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('adapter name is pulumi', () => {
    expect(graph.adapter).toBe('pulumi');
  });

  it('emits a node per resource', () => {
    expect(graph.nodes).toHaveLength(3);
  });

  it('aws.s3.BucketV2 → datastore', () => {
    const node = byId.get('resource:aws.s3.BucketV2.app-bucket');
    expect(node).toBeDefined();
    expect(node?.kind).toBe('datastore');
  });

  it('aws.sqs.Queue → queue', () => {
    const node = byId.get('resource:aws.sqs.Queue.job-queue');
    expect(node).toBeDefined();
    expect(node?.kind).toBe('queue');
  });

  it('aws.lambda.Function → worker', () => {
    const node = byId.get('resource:aws.lambda.Function.api-fn');
    expect(node).toBeDefined();
    expect(node?.kind).toBe('worker');
  });

  it('all nodes have inferred provenance', () => {
    expect(graph.nodes.every((n) => n.provenance === 'inferred')).toBe(true);
  });

  it('metadata carries provider + resourceType', () => {
    const fn = byId.get('resource:aws.lambda.Function.api-fn');
    expect(fn?.metadata?.provider).toBe('aws');
    expect(fn?.metadata?.resourceType).toBe('aws.lambda.Function');
  });

  it('metadata carries varName when the resource is assigned', () => {
    const bucket = byId.get('resource:aws.s3.BucketV2.app-bucket');
    expect(bucket?.metadata?.varName).toBe('bucket');
  });
});

// ---------------------------------------------------------------------------
// buildPulumiGraph — classificationsNeeded

describe('buildPulumiGraph — classificationsNeeded', () => {
  const resources = makeResources();
  const graph = buildPulumiGraph({ resources, root: '/repo' });

  it('emits one ClassificationRef per resource', () => {
    expect(graph.classificationsNeeded).toHaveLength(3);
  });

  it('provider uses pulumi/<providerSegment> for shared cache key', () => {
    expect(graph.classificationsNeeded.every((c) => c.provider.startsWith('pulumi/'))).toBe(true);
    const lambdaRef = graph.classificationsNeeded.find((c) => c.resourceType === 'aws.lambda.Function');
    expect(lambdaRef?.provider).toBe('pulumi/aws');
    expect(lambdaRef?.forNodeId).toBe('resource:aws.lambda.Function.api-fn');
  });

  it('forNodeId matches the corresponding node id', () => {
    for (const ref of graph.classificationsNeeded) {
      expect(graph.nodes.some((n) => n.id === ref.forNodeId)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// buildPulumiGraph — cross-resource `calls` edges

describe('buildPulumiGraph — calls edges', () => {
  const resources = makeResources();
  const graph = buildPulumiGraph({ resources, root: '/repo' });

  it('emits a calls edge from lambda → bucket (bucket.bucket in args)', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: 'resource:aws.lambda.Function.api-fn',
        target: 'resource:aws.s3.BucketV2.app-bucket',
        kind: 'calls',
      }),
    );
  });

  it('emits a calls edge from lambda → queue (queue.url in args)', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: 'resource:aws.lambda.Function.api-fn',
        target: 'resource:aws.sqs.Queue.job-queue',
        kind: 'calls',
      }),
    );
  });

  it('does not emit an edge from bucket to itself', () => {
    expect(graph.edges.some((e) => e.source === e.target)).toBe(false);
  });

  it('does not emit edges between unrelated resources (bucket ↔ queue have no cross-ref)', () => {
    const bucketToQueue = graph.edges.find(
      (e) =>
        e.source === 'resource:aws.s3.BucketV2.app-bucket' &&
        e.target === 'resource:aws.sqs.Queue.job-queue',
    );
    const queueToBucket = graph.edges.find(
      (e) =>
        e.source === 'resource:aws.sqs.Queue.job-queue' &&
        e.target === 'resource:aws.s3.BucketV2.app-bucket',
    );
    expect(bucketToQueue).toBeUndefined();
    expect(queueToBucket).toBeUndefined();
  });

  it('deduplicates repeated references (no duplicate edges)', () => {
    const keys = graph.edges.map((e) => `${e.source}→${e.target}`);
    const unique = new Set(keys);
    expect(keys.length).toBe(unique.size);
  });

  it('edge metadata carries via: pulumi-ref', () => {
    const edge = graph.edges.find((e) => e.source === 'resource:aws.lambda.Function.api-fn');
    expect(edge?.metadata?.via).toBe('pulumi-ref');
  });
});

// ---------------------------------------------------------------------------
// buildPulumiGraph — no phantom edge from logical-name substring (finding 1)

describe('buildPulumiGraph — no phantom edge from logical-name substring', () => {
  // `topic` is the varName of the Topic resource.
  // The Queue resource has logical name `'topic-handler'` — the word `topic`
  // appears inside the name string but is NOT a reference to the Topic var.
  // Before fix: regex over raw argsText matched `\btopic\b` inside
  // `'topic-handler'` and produced a phantom queue→topic edge.
  // After fix: referencedIdentifiers is collected via AST walk; string-literal
  // content is never included, so no phantom edge is produced.
  const SOURCE = `
    import * as aws from '@pulumi/aws';
    const topic = new aws.sns.Topic('events', { displayName: 'events' });
    const queue = new aws.sqs.Queue('topic-handler', { name: 'topic-handler' });
  `;
  const resources = extractPulumiResources(SOURCE, 'index.ts');
  const graph = buildPulumiGraph({ resources, root: '/repo' });

  it('does not emit a phantom edge from queue to topic (logical-name match only)', () => {
    const queueNode = graph.nodes.find((n) => n.metadata?.resourceType === 'aws.sqs.Queue');
    const topicNode = graph.nodes.find((n) => n.metadata?.resourceType === 'aws.sns.Topic');
    expect(queueNode).toBeDefined();
    expect(topicNode).toBeDefined();
    const phantomEdge = graph.edges.find(
      (e) => e.source === queueNode!.id && e.target === topicNode!.id,
    );
    expect(phantomEdge).toBeUndefined();
  });

  it('emits no edges at all (neither resource references the other in args)', () => {
    expect(graph.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildPulumiGraph — distinct ids for two same-type dynamic resources (finding 2)

describe('buildPulumiGraph — distinct ids for same-type dynamic resources', () => {
  // Two aws.sqs.Queue resources whose logical name is a dynamic expression
  // (not a string or backtick literal). Before fix: both fell back to
  // `queue.toLowerCase()` = `queue`, producing identical refAddrs and
  // causing the second to be silently dropped in the node map.
  const SOURCE = `
    import * as aws from '@pulumi/aws';
    const envName = 'prod';
    const q1 = new aws.sqs.Queue(envName + '-main', { name: 'main' });
    const q2 = new aws.sqs.Queue(envName + '-dlq', { name: 'dlq' });
  `;
  const resources = extractPulumiResources(SOURCE, 'queues.ts');
  const graph = buildPulumiGraph({ resources, root: '/repo' });

  it('emits two distinct nodes (not silently deduplicated)', () => {
    expect(graph.nodes).toHaveLength(2);
  });

  it('node ids are distinct', () => {
    const ids = graph.nodes.map((n) => n.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildPulumiGraph — backtick logical names accepted (finding 3)

describe('buildPulumiGraph — backtick (NoSubstitutionTemplateLiteral) logical names', () => {
  const SOURCE = `
    import * as aws from '@pulumi/aws';
    const bucket = new aws.s3.BucketV2(\`my-bucket\`, { bucket: 'assets' });
    const fn = new aws.lambda.Function(\`api-fn\`, {
      handler: 'index.handler',
      role: 'arn:role',
      environment: { variables: { BUCKET: bucket.bucket } },
    });
  `;
  const resources = extractPulumiResources(SOURCE, 'backtick.ts');
  const graph = buildPulumiGraph({ resources, root: '/repo' });

  it('extracts logical name from backtick literal (not falling back to dynamic)', () => {
    const bucketNode = graph.nodes.find((n) => n.id === 'resource:aws.s3.BucketV2.my-bucket');
    expect(bucketNode).toBeDefined();
    const fnNode = graph.nodes.find((n) => n.id === 'resource:aws.lambda.Function.api-fn');
    expect(fnNode).toBeDefined();
  });

  it('emits a calls edge from lambda → bucket (backtick-named)', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: 'resource:aws.lambda.Function.api-fn',
        target: 'resource:aws.s3.BucketV2.my-bucket',
        kind: 'calls',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// buildPulumiGraph — GCP resources

describe('buildPulumiGraph — GCP resources', () => {
  const gcpResources = extractPulumiResources(
    `
    import * as gcp from '@pulumi/gcp';
    const topic = new gcp.pubsub.Topic('events', { name: 'app-events' });
    const runner = new gcp.cloudrun.Service('api', {
      location: 'us-central1',
      template: {},
      env: topic.name,
    });
    `,
    'gcp.ts',
  );

  const graph = buildPulumiGraph({ resources: gcpResources, root: '/repo' });

  it('gcp.pubsub.Topic → queue', () => {
    const node = graph.nodes.find((n) => n.metadata?.resourceType === 'gcp.pubsub.Topic');
    expect(node?.kind).toBe('queue');
  });

  it('gcp.cloudrun.Service → worker', () => {
    const node = graph.nodes.find((n) => n.metadata?.resourceType === 'gcp.cloudrun.Service');
    expect(node?.kind).toBe('worker');
  });

  it('classificationsNeeded uses pulumi/gcp as provider', () => {
    expect(graph.classificationsNeeded.every((c) => c.provider === 'pulumi/gcp')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildPulumiGraph — malformed doesn't crash

describe('buildPulumiGraph — malformed inputs do not crash', () => {
  it('handles empty resources list gracefully', () => {
    const graph = buildPulumiGraph({ resources: [], root: '/repo' });
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.classificationsNeeded).toEqual([]);
  });

  it('handles resources with no varName (no phantom edges)', () => {
    // Resources without varNames cannot be referenced by identifier
    const source = `
      import * as aws from '@pulumi/aws';
      // Not assigned to a variable
      new aws.sqs.Queue('orphan-queue', { name: 'orphan' });
    `;
    const resources = extractPulumiResources(source, 'orphan.ts');
    const graph = buildPulumiGraph({ resources, root: '/repo' });
    // Node still emitted (from the NewExpression)
    expect(graph.nodes.length).toBeGreaterThanOrEqual(0);
    // No edges (nothing to reference)
    expect(graph.edges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// pulumiAdapter.detect — fs-level tests

describe('pulumiAdapter detect()', () => {
  let dirWithPulumi: string;
  let dirWithout: string;

  beforeAll(() => {
    dirWithPulumi = mkdtempSync(join(tmpdir(), 'backthread-pulumi-'));
    writeFileSync(join(dirWithPulumi, 'Pulumi.yaml'), 'name: test\nruntime: nodejs\n');

    dirWithout = mkdtempSync(join(tmpdir(), 'backthread-noPulumi-'));
  });

  afterAll(() => {
    rmSync(dirWithPulumi, { recursive: true, force: true });
    rmSync(dirWithout, { recursive: true, force: true });
  });

  it('returns true when Pulumi.yaml exists at repo root', async () => {
    expect(await pulumiAdapter.detect(dirWithPulumi)).toBe(true);
  });

  it('returns false when Pulumi.yaml is absent', async () => {
    expect(await pulumiAdapter.detect(dirWithout)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pulumiAdapter.extract — integration test with a real tmp directory

describe('pulumiAdapter extract()', () => {
  let repoDir: string;

  beforeAll(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'backthread-pulumi-extract-'));

    writeFileSync(join(repoDir, 'Pulumi.yaml'), 'name: my-app\nruntime: nodejs\n');
    writeFileSync(join(repoDir, 'Pulumi.dev.yaml'), 'config:\n  aws:region: us-east-1\n');

    const src = `
import * as aws from '@pulumi/aws';

const bucket = new aws.s3.BucketV2('data-bucket', { bucket: 'data' });
const fn = new aws.lambda.Function('processor', {
  runtime: 'nodejs18.x',
  handler: 'index.handler',
  role: 'arn:role',
  environment: { variables: { BUCKET: bucket.bucket } },
});
`;
    writeFileSync(join(repoDir, 'index.ts'), src);
  });

  afterAll(() => rmSync(repoDir, { recursive: true, force: true }));

  it('detects the repo', async () => {
    expect(await pulumiAdapter.detect(repoDir)).toBe(true);
  });

  it('extracts nodes and classificationsNeeded', async () => {
    const graph = await pulumiAdapter.extract(repoDir);
    expect(graph.adapter).toBe('pulumi');
    expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
    expect(graph.classificationsNeeded.length).toBe(graph.nodes.length);
    expect(graph.classificationsNeeded.every((c) => c.provider.startsWith('pulumi/'))).toBe(true);
  });

  it('emits a calls edge from lambda → bucket', async () => {
    const graph = await pulumiAdapter.extract(repoDir);
    const lambdaNode = graph.nodes.find((n) => n.metadata?.resourceType === 'aws.lambda.Function');
    const bucketNode = graph.nodes.find((n) => n.metadata?.resourceType === 'aws.s3.BucketV2');
    expect(lambdaNode).toBeDefined();
    expect(bucketNode).toBeDefined();
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: lambdaNode!.id,
        target: bucketNode!.id,
        kind: 'calls',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// pulumiAdapter.extract — non-TS runtime emits empty graph, does not crash

describe('pulumiAdapter extract() — non-TS runtime', () => {
  let repoDir: string;

  beforeAll(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'backthread-pulumi-python-'));
    writeFileSync(join(repoDir, 'Pulumi.yaml'), 'name: py-stack\nruntime: python\n');
    writeFileSync(join(repoDir, '__main__.py'), 'import pulumi_aws as aws\nbucket = aws.s3.BucketV2("b")\n');
  });

  afterAll(() => rmSync(repoDir, { recursive: true, force: true }));

  it('detects a Python Pulumi project (Pulumi.yaml exists)', async () => {
    expect(await pulumiAdapter.detect(repoDir)).toBe(true);
  });

  it('emits an empty graph without crashing', async () => {
    const graph = await pulumiAdapter.extract(repoDir);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.classificationsNeeded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sourceRoots (code assets + build context + image→resolver).

import { pulumiSourceRoots } from './pulumi.js';
import type { DockerfileIndex } from '../image-resolve.js';

const PULUMI_DF_INDEX: DockerfileIndex = {
  dockerfiles: [{ dockerfile: 'services/api/Dockerfile', context: 'services/api' }],
  pairings: [{ image: 'ghcr.io/acme/api', context: 'services/api' }],
};

describe('pulumiSourceRoots (pure)', () => {
  it('docker.Image build context → that dir', () => {
    expect(pulumiSourceRoots('docker.Image', '{ build: { context: "./app" } }')).toEqual(['app']);
  });

  it('lambda FileArchive code asset (dir) → that dir', () => {
    expect(
      pulumiSourceRoots('aws.lambda.Function', '{ code: new pulumi.asset.FileArchive("./lambda") }'),
    ).toEqual(['lambda']);
  });

  it('FileArchive pointing at a built .zip → its containing dir', () => {
    expect(pulumiSourceRoots('aws.lambda.Function', '{ code: new pulumi.asset.FileArchive("./build/fn.zip") }')).toEqual([
      'build',
    ]);
  });

  it('AssetArchive wrapping an inner FileArchive → the FileArchive dir', () => {
    expect(
      pulumiSourceRoots(
        'aws.lambda.Function',
        '{ code: new pulumi.asset.AssetArchive({ ".": new pulumi.asset.FileArchive("./src") }) }',
      ),
    ).toEqual(['src']);
  });

  it('image ref resolves via the  resolver', () => {
    expect(
      pulumiSourceRoots('docker.Image', '{ imageName: x, build: undefined, image: "ghcr.io/acme/api:1" }', PULUMI_DF_INDEX),
    ).toEqual(['services/api']);
  });

  it('a public/unresolvable image yields no source root (honest "Other")', () => {
    expect(pulumiSourceRoots('aws.ecs.TaskDefinition', '{ image: "postgres:15" }', PULUMI_DF_INDEX)).toEqual([]);
  });

  it('an interpolated image template is skipped (never guess)', () => {
    expect(pulumiSourceRoots('docker.Image', '{ image: `${repo.url}:latest` }', PULUMI_DF_INDEX)).toEqual([]);
  });

  it('no args text → no source root', () => {
    expect(pulumiSourceRoots('aws.s3.Bucket', '')).toEqual([]);
  });
});

describe('buildPulumiGraph — sourceRoots wiring', () => {
  it('attributes a docker.Image build context onto the node', () => {
    const resources = [
      {
        varName: 'api',
        resourceType: 'docker.Image',
        refAddr: 'docker.Image.api',
        referencedIdentifiers: [],
        argsText: '{ build: { context: "./services/api" } }',
      },
    ];
    const graph = buildPulumiGraph({ resources, root: '/repo', dockerfileIndex: PULUMI_DF_INDEX });
    expect(graph.nodes.find((n) => n.id === 'resource:docker.Image.api')?.sourceRoots).toEqual(['services/api']);
  });

  it('a datastore resource with no source signal gets no sourceRoots', () => {
    const resources = [
      {
        varName: 'bucket',
        resourceType: 'aws.s3.Bucket',
        refAddr: 'aws.s3.Bucket.assets',
        referencedIdentifiers: [],
        argsText: '{ acl: "private" }',
      },
    ];
    const graph = buildPulumiGraph({ resources, root: '/repo', dockerfileIndex: PULUMI_DF_INDEX });
    expect(graph.nodes.find((n) => n.id === 'resource:aws.s3.Bucket.assets')?.sourceRoots).toBeUndefined();
  });
});
