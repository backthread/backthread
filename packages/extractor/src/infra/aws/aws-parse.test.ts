// aws-parse unit tests.
// Exercises parseCfnTemplate (YAML + JSON) and parseServerlessConfig.
// All tests are pure (no fs access) — input is inline fixture strings.

import { describe, it, expect } from '../../testkit.js';
import { parseCfnTemplate, parseServerlessConfig, isCfnTemplate } from './aws-parse.js';

// ---------------------------------------------------------------------------
// CFN YAML fixture with intrinsic tags — the primary correctness concern.
// A real SAM template using !Ref, !GetAtt, !Sub.

const CFN_YAML_WITH_TAGS = `
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: Example SAM template

Resources:
  OrdersTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: !Sub "\${AWS::StackName}-orders"
      AttributeDefinitions:
        - AttributeName: id
          AttributeType: S
      KeySchema:
        - AttributeName: id
          KeyType: HASH

  ProcessorFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: handler.main
      Runtime: nodejs20.x
      Environment:
        Variables:
          TABLE_NAME: !Ref OrdersTable
          TABLE_ARN: !GetAtt OrdersTable.Arn
      Events:
        JobQueue:
          Type: SQS
          Properties:
            Queue: !GetAtt JobQueue.Arn

  JobQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub "\${AWS::StackName}-jobs"
`;

// ---------------------------------------------------------------------------
// SAM JSON fixture (CDK synthesized format).

const SAM_JSON = JSON.stringify({
  AWSTemplateFormatVersion: '2010-09-09',
  Transform: 'AWS::Serverless-2016-10-31',
  Resources: {
    ApiFunction: {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: 'api',
        Code: { ZipFile: 'exports.handler = async () => ({})' },
        Role: { 'Fn::GetAtt': ['LambdaRole', 'Arn'] },
      },
    },
    LambdaRole: {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: 'lambda-role',
      },
    },
    SecretValue: {
      Type: 'AWS::SecretsManager::Secret',
      Properties: {
        Name: 'my-secret',
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Serverless Framework fixture.

const SERVERLESS_YML = `
service: my-api
provider:
  name: aws
  runtime: nodejs20.x
  region: us-east-1
functions:
  api:
    handler: src/handler.main
    events:
      - http:
          path: /
          method: get
  worker:
    handler: src/worker.main
resources:
  Resources:
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
    StorageBucket:
      Type: AWS::S3::Bucket
      Properties:
        BucketName: my-bucket
`;

// ---------------------------------------------------------------------------
// Describe blocks.

describe('parseCfnTemplate — YAML with intrinsic tags', () => {
  it('parses without throwing', () => {
    expect(() => parseCfnTemplate(CFN_YAML_WITH_TAGS)).not.toThrow();
  });

  it('extracts the correct resource count', () => {
    const resources = parseCfnTemplate(CFN_YAML_WITH_TAGS);
    expect(resources).toHaveLength(3);
  });

  it('extracts the DynamoDB table with the correct type', () => {
    const resources = parseCfnTemplate(CFN_YAML_WITH_TAGS);
    const table = resources.find((r) => r.logicalId === 'OrdersTable');
    expect(table).toBeDefined();
    expect(table!.type).toBe('AWS::DynamoDB::Table');
  });

  it('extracts the SAM function with the correct type', () => {
    const resources = parseCfnTemplate(CFN_YAML_WITH_TAGS);
    const fn = resources.find((r) => r.logicalId === 'ProcessorFunction');
    expect(fn).toBeDefined();
    expect(fn!.type).toBe('AWS::Serverless::Function');
  });

  it('extracts the SQS queue with the correct type', () => {
    const resources = parseCfnTemplate(CFN_YAML_WITH_TAGS);
    const queue = resources.find((r) => r.logicalId === 'JobQueue');
    expect(queue).toBeDefined();
    expect(queue!.type).toBe('AWS::SQS::Queue');
  });

  it('produces rawText that contains the logicalId for reference scanning', () => {
    const resources = parseCfnTemplate(CFN_YAML_WITH_TAGS);
    const fn = resources.find((r) => r.logicalId === 'ProcessorFunction');
    expect(fn!.rawText).toContain('OrdersTable');
  });
});

describe('parseCfnTemplate — JSON (CDK synthesized / plain CFN)', () => {
  it('parses without throwing', () => {
    expect(() => parseCfnTemplate(SAM_JSON)).not.toThrow();
  });

  it('extracts all three resources', () => {
    const resources = parseCfnTemplate(SAM_JSON);
    expect(resources).toHaveLength(3);
  });

  it('extracts Lambda function', () => {
    const resources = parseCfnTemplate(SAM_JSON);
    const fn = resources.find((r) => r.logicalId === 'ApiFunction');
    expect(fn?.type).toBe('AWS::Lambda::Function');
  });

  it('extracts SecretsManager secret', () => {
    const resources = parseCfnTemplate(SAM_JSON);
    const secret = resources.find((r) => r.logicalId === 'SecretValue');
    expect(secret?.type).toBe('AWS::SecretsManager::Secret');
  });

  it('rawText contains the IAM Role logicalId (used for reference edge detection)', () => {
    const resources = parseCfnTemplate(SAM_JSON);
    const fn = resources.find((r) => r.logicalId === 'ApiFunction');
    expect(fn!.rawText).toContain('LambdaRole');
  });
});

describe('parseCfnTemplate — malformed input never throws', () => {
  it('returns [] for empty string', () => {
    expect(() => parseCfnTemplate('')).not.toThrow();
    expect(parseCfnTemplate('')).toEqual([]);
  });

  it('returns [] for a JSON object with no Resources key', () => {
    expect(parseCfnTemplate(JSON.stringify({ foo: 'bar' }))).toEqual([]);
  });

  it('returns [] for garbage text', () => {
    expect(() => parseCfnTemplate('%%%not yaml or json%%%')).not.toThrow();
    expect(parseCfnTemplate('%%%not yaml or json%%%')).toEqual([]);
  });

  it('returns [] for deeply nested YAML without Resources', () => {
    const yaml = 'foo:\n  bar:\n    baz: 1\n';
    expect(parseCfnTemplate(yaml)).toEqual([]);
  });
});

describe('parseServerlessConfig', () => {
  it('parses without throwing', () => {
    expect(() => parseServerlessConfig(SERVERLESS_YML)).not.toThrow();
  });

  it('emits one Lambda node per function entry', () => {
    const resources = parseServerlessConfig(SERVERLESS_YML);
    const lambdas = resources.filter((r) => r.type === 'AWS::Lambda::Function');
    expect(lambdas).toHaveLength(2);
    const ids = lambdas.map((r) => r.logicalId);
    expect(ids).toContain('api');
    expect(ids).toContain('worker');
  });

  it('includes CFN resources from resources.Resources', () => {
    const resources = parseServerlessConfig(SERVERLESS_YML);
    const table = resources.find((r) => r.logicalId === 'OrdersTable');
    expect(table?.type).toBe('AWS::DynamoDB::Table');
    const bucket = resources.find((r) => r.logicalId === 'StorageBucket');
    expect(bucket?.type).toBe('AWS::S3::Bucket');
  });

  it('returns [] for malformed YAML', () => {
    expect(() => parseServerlessConfig('%%%')).not.toThrow();
  });

  it('returns [] for empty string', () => {
    expect(parseServerlessConfig('')).toEqual([]);
  });
});

describe('isCfnTemplate', () => {
  it('returns true for AWSTemplateFormatVersion (YAML)', () => {
    expect(isCfnTemplate("AWSTemplateFormatVersion: '2010-09-09'")).toBe(true);
  });

  it('returns true for SAM Transform line (YAML)', () => {
    expect(isCfnTemplate('Transform: AWS::Serverless')).toBe(true);
  });

  it('returns true for JSON SAM (fix #7 — "Transform": "AWS::Serverless-2016-10-31")', () => {
    // JSON SAM templates produced by CDK or plain JSON authoring use quoted keys
    // and do NOT have the YAML `Transform: AWS::Serverless` spacing pattern.
    expect(isCfnTemplate(JSON.stringify({
      AWSTemplateFormatVersion: '2010-09-09',
      Transform: 'AWS::Serverless-2016-10-31',
      Resources: {},
    }))).toBe(true);
  });

  it('returns true for plain CFN JSON with only AWSTemplateFormatVersion', () => {
    expect(isCfnTemplate(JSON.stringify({
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: {},
    }))).toBe(true);
  });

  it('returns false for a plain YAML config', () => {
    expect(isCfnTemplate('name: my-app\nversion: 1.0.0')).toBe(false);
  });
});
