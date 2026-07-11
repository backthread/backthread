// pulumi-parse unit tests.
// All tests are pure (no file I/O): source text is inlined.

import { describe, it, expect } from '../../testkit.js';
import { extractPulumiResources, parsePulumiProject, providerOf } from './pulumi-parse.js';

// ---------------------------------------------------------------------------
// providerOf

describe('providerOf', () => {
  it('extracts the first segment of a dotted path', () => {
    expect(providerOf('aws.lambda.Function')).toBe('aws');
    expect(providerOf('gcp.cloudrun.Service')).toBe('gcp');
    expect(providerOf('azure.storage.Account')).toBe('azure');
  });

  it('handles single-segment gracefully (lowercased)', () => {
    expect(providerOf('SomeClass')).toBe('someclass');
  });
});

// ---------------------------------------------------------------------------
// parsePulumiProject

describe('parsePulumiProject', () => {
  it('parses name and runtime from a valid Pulumi.yaml', () => {
    const yaml = `
name: my-stack
runtime: nodejs
description: A Pulumi TypeScript project
`;
    const result = parsePulumiProject(yaml);
    expect(result.name).toBe('my-stack');
    expect(result.runtime).toBe('nodejs');
  });

  it('parses runtime as a dict { name: "nodejs" }', () => {
    const yaml = `
name: my-stack
runtime:
  name: nodejs
  options:
    typescript: true
`;
    const result = parsePulumiProject(yaml);
    expect(result.name).toBe('my-stack');
    expect(result.runtime).toBe('nodejs');
  });

  it('returns empty object for empty YAML', () => {
    expect(parsePulumiProject('')).toEqual({});
  });

  it('returns empty object for malformed YAML (does not throw)', () => {
    expect(() => parsePulumiProject(': : : invalid yaml :::')).not.toThrow();
    const result = parsePulumiProject(': : : invalid yaml :::');
    expect(result).toEqual({});
  });

  it('returns empty object for non-object YAML (string, number)', () => {
    expect(parsePulumiProject('"just a string"')).toEqual({});
    expect(parsePulumiProject('42')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// extractPulumiResources — main extraction

const AWS_PROGRAM = `
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

const bucket = new aws.s3.BucketV2('my-bucket', {
  bucket: 'my-app-assets',
  tags: { Environment: 'prod' },
});

const queue = new aws.sqs.Queue('jobs-queue', {
  name: 'jobs',
  visibilityTimeoutSeconds: 30,
});

// Lambda references both bucket and queue
const fn = new aws.lambda.Function('api-handler', {
  runtime: aws.lambda.Runtime.NodeJS18dX,
  handler: 'index.handler',
  role: 'arn:aws:iam::123:role/lambda',
  environment: {
    variables: {
      BUCKET: bucket.bucket,
      QUEUE_URL: queue.url,
    },
  },
});
`;

describe('extractPulumiResources — AWS program', () => {
  const resources = extractPulumiResources(AWS_PROGRAM, 'index.ts');

  it('finds all three resource declarations', () => {
    expect(resources).toHaveLength(3);
  });

  it('extracts resourceType correctly (dotted path)', () => {
    const types = resources.map((r) => r.resourceType);
    expect(types).toContain('aws.s3.BucketV2');
    expect(types).toContain('aws.sqs.Queue');
    expect(types).toContain('aws.lambda.Function');
  });

  it('extracts the logical name from the first string argument', () => {
    const bucket = resources.find((r) => r.resourceType === 'aws.s3.BucketV2');
    expect(bucket?.refAddr).toBe('aws.s3.BucketV2.my-bucket');
  });

  it('extracts varName for assigned resources', () => {
    const bucket = resources.find((r) => r.resourceType === 'aws.s3.BucketV2');
    expect(bucket?.varName).toBe('bucket');

    const queue = resources.find((r) => r.resourceType === 'aws.sqs.Queue');
    expect(queue?.varName).toBe('queue');

    const fn = resources.find((r) => r.resourceType === 'aws.lambda.Function');
    expect(fn?.varName).toBe('fn');
  });

  it('referencedIdentifiers includes the variable references (bucket, queue)', () => {
    const fn = resources.find((r) => r.resourceType === 'aws.lambda.Function');
    expect(fn?.referencedIdentifiers).toContain('bucket');
    expect(fn?.referencedIdentifiers).toContain('queue');
  });
});

// ---------------------------------------------------------------------------
// GCP program — different provider

const GCP_PROGRAM = `
import * as gcp from '@pulumi/gcp';

const service = new gcp.cloudrun.Service('api', {
  location: 'us-central1',
  template: { spec: { containers: [{ image: 'gcr.io/my/api' }] } },
});

const topic = new gcp.pubsub.Topic('events', { name: 'app-events' });
`;

describe('extractPulumiResources — GCP program', () => {
  const resources = extractPulumiResources(GCP_PROGRAM, 'gcp-index.ts');

  it('finds gcp.cloudrun.Service and gcp.pubsub.Topic', () => {
    const types = resources.map((r) => r.resourceType);
    expect(types).toContain('gcp.cloudrun.Service');
    expect(types).toContain('gcp.pubsub.Topic');
  });

  it('provider of gcp.cloudrun.Service is gcp', () => {
    const svc = resources.find((r) => r.resourceType === 'gcp.cloudrun.Service');
    expect(providerOf(svc!.resourceType)).toBe('gcp');
  });
});

// ---------------------------------------------------------------------------
// Mixed Azure program

const AZURE_PROGRAM = `
import * as azure from '@pulumi/azure-native';

const account = new azure.storage.StorageAccount('storageaccount', {
  resourceGroupName: 'mygroup',
  sku: { name: 'Standard_LRS' },
  kind: 'StorageV2',
});

const vault = new azure.keyvault.Vault('myvault', {
  resourceGroupName: 'mygroup',
  properties: { sku: { name: 'standard', family: 'A' }, tenantId: 'tid' },
});
`;

describe('extractPulumiResources — Azure program', () => {
  const resources = extractPulumiResources(AZURE_PROGRAM, 'azure.ts');

  it('finds both azure resources', () => {
    expect(resources).toHaveLength(2);
    const types = resources.map((r) => r.resourceType);
    expect(types).toContain('azure.storage.StorageAccount');
    expect(types).toContain('azure.keyvault.Vault');
  });
});

// ---------------------------------------------------------------------------
// Edge cases: malformed / empty source

describe('extractPulumiResources — malformed/empty source', () => {
  it('returns empty array for empty string (does not throw)', () => {
    expect(() => extractPulumiResources('', 'empty.ts')).not.toThrow();
    expect(extractPulumiResources('', 'empty.ts')).toEqual([]);
  });

  it('returns empty array for whitespace-only source', () => {
    expect(extractPulumiResources('   \n\t  ', 'blank.ts')).toEqual([]);
  });

  it('does not throw on heavily malformed TypeScript', () => {
    // Deliberately broken — missing closing braces, bad syntax
    const broken = `
      new aws.lambda.Function('foo', {
        this is not valid typescript at all
      `;
    expect(() => extractPulumiResources(broken, 'broken.ts')).not.toThrow();
  });

  it('does not match single-segment constructors (user-defined classes)', () => {
    const source = `
      import * as pulumi from '@pulumi/pulumi';
      const stack = new pulumi.StackReference('my-stack', { name: 'org/stack/dev' });
      const myClass = new MyClass('test');
    `;
    const resources = extractPulumiResources(source, 'test.ts');
    // pulumi.StackReference is 2-segment — may or may not match depending on arg shape
    // MyClass is single-segment and MUST NOT be in results
    const types = resources.map((r) => r.resourceType);
    expect(types).not.toContain('MyClass');
  });

  it('returns empty array when there are no new expressions', () => {
    const source = `
      const x = 1 + 2;
      function hello() { return 'world'; }
    `;
    expect(extractPulumiResources(source, 'no-new.ts')).toEqual([]);
  });
});
