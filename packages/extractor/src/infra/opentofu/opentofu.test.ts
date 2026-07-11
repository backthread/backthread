// OpenTofu adapter tests.
//
// Mirrors the structure of terraform.test.ts. The core graph logic is identical
// (reuses buildTerraformGraph), so these tests focus on:
//   (a) detect() correctly identifying OpenTofu-specific signals
//   (b) detect() NOT firing on plain Terraform repos (regression guard)
//   (c) extract() producing the expected graph shape with adapter === 'opentofu'
//   (d) malformed .tofu files being swallowed without crashing
//   (e) .tofu.json files being skipped with a warning (deferred)

import { describe, it, expect, beforeAll, afterAll, vi } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opentofuAdapter } from './opentofu.js';
import { buildTerraformGraph } from '../terraform/terraform.js';
import { parseHcl } from '../terraform/hcl-parse.js';

// ---------------------------------------------------------------------------
// Shared fixture — an AWS Lambda + DynamoDB stack, same as terraform.test.ts,
// but expressed via the OpenTofu dialect (same HCL, different filenames).
// ---------------------------------------------------------------------------

const STACK_HCL = `
  provider "aws" { region = "us-east-1" }

  resource "aws_dynamodb_table" "orders" {
    name     = "orders"
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

// ---------------------------------------------------------------------------
// Pure graph-builder tests (no filesystem, mirrors terraform.test.ts §1)
// ---------------------------------------------------------------------------

describe('buildTerraformGraph via opentofu (pure, no filesystem)', () => {
  // The adapter reuses buildTerraformGraph unchanged. These tests confirm the
  // graph semantics carry over when the HCL originates from .tofu content.
  const graph = buildTerraformGraph(parseHcl(STACK_HCL), '/repo');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('emits a node per resource with a heuristic kind + inferred provenance', () => {
    expect(byId.get('resource:aws_dynamodb_table.orders')?.kind).toBe('datastore');
    expect(byId.get('resource:aws_lambda_function.api')?.kind).toBe('worker');
    expect(byId.get('resource:aws_sqs_queue.jobs')?.kind).toBe('queue');
    expect(graph.nodes.every((n) => n.provenance === 'inferred')).toBe(true);
  });

  it('queues every resource for  classification with terraform/* provider', () => {
    // The provider strings are intentionally 'terraform/aws' (same cache/taxonomy
    // as the Terraform adapter — they share the resource_type_classifications table).
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
        kind: 'calls',
      }),
    );
  });

  it('does not invent edges between unrelated resources', () => {
    expect(graph.edges.some((e) => e.target === 'resource:aws_sqs_queue.jobs')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detect() — filesystem-level signal recognition
// ---------------------------------------------------------------------------

describe('opentofuAdapter detect()', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-ot-detect-'));
    mkdirSync(join(dir, 'infra'), { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns TRUE for a repo containing a .tofu file', async () => {
    writeFileSync(join(dir, 'infra', 'main.tofu'), STACK_HCL);
    expect(await opentofuAdapter.detect(dir)).toBe(true);
  });

  it('returns TRUE for a repo containing a tofu.tfvars file (no .tofu needed)', async () => {
    const varDir = mkdtempSync(join(tmpdir(), 'backthread-ot-vars-'));
    try {
      writeFileSync(join(varDir, 'main.tf'), 'resource "aws_s3_bucket" "b" {}');
      writeFileSync(join(varDir, 'tofu.tfvars'), 'region = "us-east-1"');
      expect(await opentofuAdapter.detect(varDir)).toBe(true);
    } finally {
      rmSync(varDir, { recursive: true, force: true });
    }
  });

  it('returns TRUE for a repo containing a .tofu.json file (even without .tofu)', async () => {
    const jsonDir = mkdtempSync(join(tmpdir(), 'backthread-ot-json-'));
    try {
      writeFileSync(join(jsonDir, 'main.tf'), 'resource "aws_s3_bucket" "b" {}');
      writeFileSync(join(jsonDir, 'override.tofu.json'), '{"resource": {}}');
      expect(await opentofuAdapter.detect(jsonDir)).toBe(true);
    } finally {
      rmSync(jsonDir, { recursive: true, force: true });
    }
  });

  // ---- REGRESSION GUARD — these must stay FALSE so Terraform owns plain repos ----

  it('returns FALSE for a repo with ONLY .tf files (terraform adapter owns those)', async () => {
    const tfOnly = mkdtempSync(join(tmpdir(), 'backthread-ot-tfonly-'));
    try {
      mkdirSync(join(tfOnly, 'infra'), { recursive: true });
      writeFileSync(join(tfOnly, 'infra', 'main.tf'), STACK_HCL);
      expect(await opentofuAdapter.detect(tfOnly)).toBe(false);
    } finally {
      rmSync(tfOnly, { recursive: true, force: true });
    }
  });

  it('returns FALSE for an empty directory', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-ot-empty-'));
    try {
      expect(await opentofuAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('returns FALSE for a directory with only unrelated files', async () => {
    const unrelated = mkdtempSync(join(tmpdir(), 'backthread-ot-unrelated-'));
    try {
      writeFileSync(join(unrelated, 'wrangler.toml'), '[name]\nname = "worker"');
      writeFileSync(join(unrelated, 'package.json'), '{"name":"app"}');
      expect(await opentofuAdapter.detect(unrelated)).toBe(false);
    } finally {
      rmSync(unrelated, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// extract() — full pipeline (detect-positive repo → graph)
// ---------------------------------------------------------------------------

describe('opentofuAdapter extract()', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-ot-extract-'));
    mkdirSync(join(dir, 'infra'), { recursive: true });
    // A mixed repo: resources in main.tofu + provider in providers.tf.
    writeFileSync(join(dir, 'infra', 'providers.tf'), 'provider "aws" { region = "us-east-1" }');
    writeFileSync(join(dir, 'infra', 'main.tofu'), `
      resource "aws_dynamodb_table" "orders" {
        name     = "orders"
        hash_key = "id"
      }

      resource "aws_lambda_function" "api" {
        function_name = "api"
        environment {
          variables = { TABLE = aws_dynamodb_table.orders.name }
        }
      }

      resource "aws_sqs_queue" "jobs" { name = "jobs" }
    `);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns adapter === "opentofu"', async () => {
    const graph = await opentofuAdapter.extract(dir);
    expect(graph.adapter).toBe('opentofu');
  });

  it('emits resource nodes with heuristic kinds', async () => {
    const graph = await opentofuAdapter.extract(dir);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('resource:aws_lambda_function.api')?.kind).toBe('worker');
    expect(byId.get('resource:aws_dynamodb_table.orders')?.kind).toBe('datastore');
    expect(byId.get('resource:aws_sqs_queue.jobs')?.kind).toBe('queue');
  });

  it('populates classificationsNeeded for all resources', async () => {
    const graph = await opentofuAdapter.extract(dir);
    expect(graph.classificationsNeeded).toHaveLength(3);
    expect(graph.classificationsNeeded.every((c) => c.provider.startsWith('terraform/'))).toBe(true);
  });

  it('emits a cross-resource calls edge', async () => {
    const graph = await opentofuAdapter.extract(dir);
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: 'resource:aws_lambda_function.api',
        target: 'resource:aws_dynamodb_table.orders',
        kind: 'calls',
      }),
    );
  });

  it('collects resources from both .tofu and .tf files in the same repo', async () => {
    // The dir has providers.tf (provider block, no resource) + main.tofu (3 resources).
    // The provider block doesn't become a resource node, but all 3 resources are found.
    const graph = await opentofuAdapter.extract(dir);
    expect(graph.nodes).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Resilience — malformed .tofu file must not crash extract()
// ---------------------------------------------------------------------------

describe('opentofuAdapter resilience', () => {
  it('does not crash when a .tofu file contains malformed HCL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backthread-ot-malform-'));
    try {
      // A syntactically broken file (unclosed brace = parseHcl will return
      // blocks up to the error or may throw; either way extract must not throw).
      writeFileSync(join(dir, 'broken.tofu'), 'resource "aws_lambda_function" "bad" { environment {');
      // A valid file alongside the broken one — nodes from valid file are still emitted.
      writeFileSync(join(dir, 'ok.tofu'), 'resource "aws_s3_bucket" "store" { bucket = "my-bucket" }');

      const graph = await opentofuAdapter.extract(dir);
      // We don't assert on graph.nodes count (parseHcl may partially parse the
      // broken file or skip it entirely), but extract() must resolve without throwing.
      expect(graph.adapter).toBe('opentofu');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Mixed .tf + .tofu repos — namespaced ids by design (see opentofu.ts comment)
// ---------------------------------------------------------------------------
//
// A repo with both *.tf and *.tofu files is claimed entirely by this adapter.
// Resources extracted from *.tf files receive `opentofu:resource:*` ids (not
// `terraform:resource:*`), because buildTerraformGraph is called once with ALL
// collected files and the adapter field is set to 'opentofu'.
// This is the intended behaviour; deduplication across adapters is the
// orchestrator's responsibility.

describe('opentofuAdapter mixed .tf + .tofu repo', () => {
  it('claims resources from both .tf and .tofu files under adapter === "opentofu"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backthread-ot-mixed-'));
    try {
      // Provider in a .tf file, resource in a .tofu file.
      writeFileSync(join(dir, 'providers.tf'), 'provider "aws" { region = "us-east-1" }');
      writeFileSync(
        join(dir, 'main.tofu'),
        'resource "aws_s3_bucket" "assets" { bucket = "assets" }',
      );
      // An additional resource living in a plain .tf file alongside the .tofu files.
      writeFileSync(
        join(dir, 'queues.tf'),
        'resource "aws_sqs_queue" "tasks" { name = "tasks" }',
      );

      expect(await opentofuAdapter.detect(dir)).toBe(true);
      const graph = await opentofuAdapter.extract(dir);

      // Both resources are present; adapter stamp is 'opentofu' throughout.
      expect(graph.adapter).toBe('opentofu');
      const ids = graph.nodes.map((n) => n.id);
      expect(ids).toContain('resource:aws_s3_bucket.assets');
      expect(ids).toContain('resource:aws_sqs_queue.tasks');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// .tofu.json — deferred: detect fires, extract skips with a warning
// ---------------------------------------------------------------------------

describe('opentofuAdapter .tofu.json handling', () => {
  it('detects a repo with only .tofu.json (no HCL files) but emits an empty graph', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backthread-ot-tofujson-'));
    try {
      writeFileSync(join(dir, 'main.tofu.json'), JSON.stringify({ resource: { aws_s3_bucket: { store: {} } } }));

      // detect must be true (it's an OpenTofu-specific signal)
      expect(await opentofuAdapter.detect(dir)).toBe(true);

      // extract must not crash; graph will be empty because JSON-HCL is deferred
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const graph = await opentofuAdapter.extract(dir);
        expect(graph.adapter).toBe('opentofu');
        // The .tofu.json skip warning must have been emitted
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('.tofu.json'));
        // No nodes (JSON was skipped)
        expect(graph.nodes).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// sourceRoots inherit the Terraform code path through OpenTofu.

describe('opentofuAdapter.extract — sourceRoots inheritance', () => {
  it('emits sourceRoots for a .tofu archive_file source_dir (shared TF path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backthread-tofu-src-'));
    try {
      writeFileSync(
        join(dir, 'main.tofu'),
        'data "archive_file" "pkg" {\n  type = "zip"\n  source_dir = "${path.module}/lambda/src"\n}\n',
      );
      const graph = await opentofuAdapter.extract(dir);
      expect(graph.adapter).toBe('opentofu');
      expect(graph.nodes.find((n) => n.id === 'data:archive_file.pkg')?.sourceRoots).toEqual(['lambda/src']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
