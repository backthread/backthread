// Terraform adapter tests. buildTerraformGraph is pure; the
// DoD's "representative repo" is a small AWS Lambda + DynamoDB stack fixture.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTerraformGraph, terraformAdapter } from './terraform.js';
import { parseHcl } from './hcl-parse.js';

const STACK = `
  provider "aws" { region = "us-east-1" }

  resource "aws_dynamodb_table" "orders" {
    name = "orders"
    hash_key = "id"
  }

  resource "aws_lambda_function" "api" {
    function_name = "api"
    environment {
      variables = { TABLE = aws_dynamodb_table.orders.name }
    }
  }

  resource "aws_sqs_queue" "jobs" {
    name = "jobs"
  }
`;

describe('buildTerraformGraph', () => {
  const graph = buildTerraformGraph(parseHcl(STACK), '/repo');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('emits a node per resource with a heuristic kind + inferred provenance', () => {
    expect(byId.get('resource:aws_dynamodb_table.orders')?.kind).toBe('datastore');
    expect(byId.get('resource:aws_lambda_function.api')?.kind).toBe('worker');
    expect(byId.get('resource:aws_sqs_queue.jobs')?.kind).toBe('queue');
    expect(graph.nodes.every((n) => n.provenance === 'inferred')).toBe(true);
  });

  it('queues every resource for  classification with the right provider', () => {
    expect(graph.classificationsNeeded).toContainEqual({
      provider: 'terraform/aws',
      resourceType: 'aws_lambda_function',
      forNodeId: 'resource:aws_lambda_function.api',
    });
    expect(graph.classificationsNeeded).toHaveLength(3);
  });

  it('emits a cross-resource edge (lambda → dynamodb) as a structural `calls`', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: 'resource:aws_lambda_function.api',
        target: 'resource:aws_dynamodb_table.orders',
        kind: 'calls', // HCL ref = structural dependency, not a known read/write
      }),
    );
  });

  it('does not invent edges between unrelated resources', () => {
    expect(graph.edges.some((e) => e.target === 'resource:aws_sqs_queue.jobs')).toBe(false);
  });

  it('does not invent a phantom edge from a resource named in a description string', () => {
    const g = buildTerraformGraph(
      parseHcl(`
        resource "aws_dynamodb_table" "orders" { name = "orders" }
        resource "aws_sns_topic" "alerts" {
          name = "alerts"
          description = "notifications, see aws_dynamodb_table.orders for the schema"
        }
      `),
      '/repo',
    );
    // The prose mention must NOT create an edge.
    expect(g.edges).toEqual([]);
  });

  it('maps non-aws prefixes to the right cloud', () => {
    const g = buildTerraformGraph(parseHcl(`resource "google_cloud_run_service" "s" {}`), '/r');
    expect(g.classificationsNeeded[0].provider).toBe('terraform/google');
    expect(g.nodes[0].kind).toBe('worker');
  });

  it('treats data blocks as nodes addressed with the data. prefix', () => {
    const g = buildTerraformGraph(parseHcl(`data "aws_ami" "ubuntu" { most_recent = true }`), '/r');
    expect(g.nodes[0].id).toBe('data:aws_ami.ubuntu');
    expect(g.nodes[0].metadata?.data).toBe(true);
  });
});

describe('terraformAdapter detect + extract', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-tf-'));
    mkdirSync(join(dir, 'infra'), { recursive: true });
    writeFileSync(join(dir, 'infra', 'main.tf'), STACK);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects a repo containing .tf files', async () => {
    expect(await terraformAdapter.detect(dir)).toBe(true);
  });

  it('extracts the stack topology', async () => {
    const graph = await terraformAdapter.extract(dir);
    expect(graph.nodes.map((n) => n.id)).toContain('resource:aws_lambda_function.api');
    expect(graph.classificationsNeeded).toHaveLength(3);
  });

  it('does not detect a repo without .tf files', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-noTf-'));
    try {
      expect(await terraformAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// sourceRoots (direct dirs + image→resolver).

import { terraformSourceRoots } from './terraform.js';
import type { DockerfileIndex } from '../image-resolve.js';

const DF_INDEX: DockerfileIndex = {
  dockerfiles: [{ dockerfile: 'services/api/Dockerfile', context: 'services/api' }],
  pairings: [{ image: 'ghcr.io/acme/api', context: 'services/api' }],
};

describe('terraformSourceRoots (pure)', () => {
  it('archive_file source_dir with ${path.module} resolves against the module dir', () => {
    expect(terraformSourceRoots('archive_file', 'type = "zip"\n  source_dir = "${path.module}/lambda/src"', 'infra')).toEqual([
      'infra/lambda/src',
    ]);
  });

  it('lambda filename → its containing dir', () => {
    expect(terraformSourceRoots('aws_lambda_function', 'filename = "build/api.zip"', '')).toEqual(['build']);
  });

  it('docker build context (docker resource only)', () => {
    expect(terraformSourceRoots('docker_image', 'build {\n  context = "./app"\n}', '')).toEqual(['app']);
    // a non-docker resource with an unrelated `context` attr is NOT treated as source
    expect(terraformSourceRoots('aws_iam_role', 'context = "./app"', '')).toEqual([]);
  });

  it('image ref resolves via the  resolver', () => {
    expect(
      terraformSourceRoots('aws_ecs_task_definition', '"image": "ghcr.io/acme/api:prod"', '', DF_INDEX),
    ).toEqual(['services/api']);
  });

  it('an unresolvable / public image yields no source root (honest "Other")', () => {
    expect(terraformSourceRoots('aws_ecs_task_definition', 'image = "postgres:15"', '', DF_INDEX)).toEqual([]);
  });

  it('an interpolated source_dir (${var.x}) is skipped (never guess)', () => {
    expect(terraformSourceRoots('archive_file', 'source_dir = "${var.src}"', '')).toEqual([]);
  });

  it('${path.root} resolves against the repo root, not the module dir', () => {
    expect(terraformSourceRoots('archive_file', 'source_dir = "${path.root}/shared"', 'infra/lambdas')).toEqual([
      'shared',
    ]);
  });
});

describe('buildTerraformGraph — sourceRoots wiring', () => {
  it('attributes a lambda archive_file source_dir onto the node', () => {
    const blocks = [
      { type: 'data', labels: ['archive_file', 'pkg'], body: 'source_dir = "${path.module}/src"', dir: '' },
    ];
    const graph = buildTerraformGraph(blocks, '/repo');
    expect(graph.nodes.find((n) => n.id === 'data:archive_file.pkg')?.sourceRoots).toEqual(['src']);
  });

  it('attributes an ECS image ref via the injected Dockerfile index', () => {
    const blocks = [
      { type: 'resource', labels: ['aws_ecs_task_definition', 'api'], body: 'image = "ghcr.io/acme/api:1"', dir: '' },
    ];
    const graph = buildTerraformGraph(blocks, '/repo', DF_INDEX);
    expect(graph.nodes.find((n) => n.id === 'resource:aws_ecs_task_definition.api')?.sourceRoots).toEqual([
      'services/api',
    ]);
  });

  it('a datastore resource with no source signal gets no sourceRoots', () => {
    const blocks = [{ type: 'resource', labels: ['aws_dynamodb_table', 'orders'], body: 'name = "orders"', dir: '' }];
    const graph = buildTerraformGraph(blocks, '/repo', DF_INDEX);
    expect(graph.nodes.find((n) => n.id === 'resource:aws_dynamodb_table.orders')?.sourceRoots).toBeUndefined();
  });
});
