// HCL-subset parser tests (pure → no Supabase import chain).

import { describe, it, expect } from '../../testkit.js';
import { parseHcl, bodyReferences, referenceSurface } from './hcl-parse.js';

describe('parseHcl', () => {
  it('parses provider / resource / data blocks with labels', () => {
    const blocks = parseHcl(`
      provider "aws" {
        region = "us-east-1"
      }
      resource "aws_lambda_function" "api" {
        handler = "index.handler"
        environment { variables = { X = "1" } }   # nested block stays in body
      }
      data "aws_iam_role" "exec" {
        name = "exec-role"
      }
    `);
    expect(blocks.map((b) => [b.type, b.labels])).toEqual([
      ['provider', ['aws']],
      ['resource', ['aws_lambda_function', 'api']],
      ['data', ['aws_iam_role', 'exec']],
    ]);
    // The nested `environment {}` block did not become a top-level block.
    expect(blocks.filter((b) => b.type === 'environment')).toHaveLength(0);
  });

  it('ignores braces inside comments and strings', () => {
    const blocks = parseHcl(`
      # a comment with { brace
      resource "x" "y" {
        note = "a string with } brace"
        // another } comment
      }
    `);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].labels).toEqual(['x', 'y']);
  });

  it('handles an unbalanced trailing brace gracefully', () => {
    const blocks = parseHcl(`resource "a" "b" { x = 1`);
    expect(blocks[0].type).toBe('resource');
  });
});

describe('bodyReferences', () => {
  it('matches an address used as an attribute access', () => {
    expect(bodyReferences('arn = aws_lambda_function.api.arn', 'aws_lambda_function.api')).toBe(true);
    expect(bodyReferences('x = "${aws_lambda_function.api.arn}"', 'aws_lambda_function.api')).toBe(true);
  });
  it('does not match a longer sibling name', () => {
    expect(bodyReferences('id = aws_lambda_function.api2.id', 'aws_lambda_function.api')).toBe(false);
  });
  it('matches a data address', () => {
    expect(bodyReferences('role = data.aws_iam_role.exec.arn', 'data.aws_iam_role.exec')).toBe(true);
  });
});

describe('referenceSurface', () => {
  it('drops resource names that appear only in prose strings', () => {
    const body = 'description = "see aws_lambda_function.api docs"';
    expect(bodyReferences(referenceSurface(body), 'aws_lambda_function.api')).toBe(false);
  });
  it('keeps references inside ${...} interpolations', () => {
    const body = 'arn = "${aws_lambda_function.api.arn}"';
    expect(bodyReferences(referenceSurface(body), 'aws_lambda_function.api')).toBe(true);
  });
  it('keeps bare traversals outside strings', () => {
    const body = 'depends_on = [aws_lambda_function.api]';
    expect(bodyReferences(referenceSurface(body), 'aws_lambda_function.api')).toBe(true);
  });
  it('drops heredoc bodies', () => {
    const body = 'policy = <<EOF\nallow aws_dynamodb_table.orders for reads\nEOF\n';
    expect(bodyReferences(referenceSurface(body), 'aws_dynamodb_table.orders')).toBe(false);
  });
});
