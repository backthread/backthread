import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  buildMcpServer,
  handleCaptureTool,
  handleQueryTool,
  formatQueryOutcome,
} from './mcp.js';
import type { CaptureOutcome } from './capture.js';
import type { QueryOutcome } from './query.js';

// GUARDRAIL (paramount): every test that touches the capture tool injects a
// MOCKED runCaptureImpl, and every query test a MOCKED queryDecisionsImpl. We NEVER
// call the real runCapture/queryDecisions here — so no ensureAuth, no `backthread login`,
// no browser, no live network. The MCP transport is the SDK's in-memory pair (no
// stdio, no real process), and we never run the real bin.

const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => c.text ?? '').join('\n');

// --- handler unit tests (no transport) ---------------------------------------

test('handleCaptureTool: maps args → HookInput and renders a persisted outcome', async () => {
  let seen: unknown;
  const r = await handleCaptureTool(
    { transcript_path: '/t.jsonl', cwd: '/w', session_id: 's1' },
    {
      runCaptureImpl: async (input) => {
        seen = input;
        return { status: 'persisted', detail: 'captured 2 decision(s).', count: 2 } as CaptureOutcome;
      },
    },
  );
  assert.deepEqual(seen, { transcript_path: '/t.jsonl', cwd: '/w', session_id: 's1' });
  assert.match(textOf(r), /persisted \(2\)/);
  assert.notEqual(r.isError, true);
});

test('handleCaptureTool: no-auth is NOT flagged as an error', async () => {
  const r = await handleCaptureTool(
    { transcript_path: '/t.jsonl' },
    { runCaptureImpl: async () => ({ status: 'no-auth', detail: 'no device token yet.' }) },
  );
  assert.match(textOf(r), /no-auth/);
  assert.notEqual(r.isError, true);
});

test('handleCaptureTool: infer-failed IS flagged as an error', async () => {
  const r = await handleCaptureTool(
    { transcript_path: '/t.jsonl' },
    { runCaptureImpl: async () => ({ status: 'infer-failed', detail: 'model down' }) },
  );
  assert.equal(r.isError, true);
  assert.match(textOf(r), /infer-failed/);
});

test('handleCaptureTool: missing transcript_path short-circuits with an actionable hint, never calls runCapture', async () => {
  let called = false;
  const r = await handleCaptureTool(
    { cwd: '/w' }, // no transcript_path
    {
      runCaptureImpl: async () => {
        called = true;
        return { status: 'persisted', detail: 'x' };
      },
    },
  );
  assert.equal(called, false);
  assert.match(textOf(r), /no transcript_path/);
  assert.match(textOf(r), /Nothing was captured/);
  assert.notEqual(r.isError, true); // not an error — a normal "supply the path" outcome
});

test('handleQueryTool: renders flows/decisions + deep-link', async () => {
  const outcome: QueryOutcome = {
    status: 'ok',
    detail: '',
    repo: { owner: 'acme', name: 'app' },
    flows: [{ id: 'f1', name: 'Checkout', lifecycle: 'active', salience: 9, canonicalFlowId: null }],
    decisions: [
      {
        id: 'd1',
        title: 'Use a queue',
        why: 'decouple ingestion',
        significance: 8,
        domainRisk: 'high',
        decidedAt: null,
        flowIds: ['f1'],
        moduleIds: [],
      },
    ],
    deepLink: 'https://app.backthread.dev/acme/app',
  };
  const r = await handleQueryTool({ question: 'how does checkout work?' }, { queryDecisionsImpl: async () => outcome });
  const text = textOf(r);
  assert.match(text, /how does checkout work\?/);
  assert.match(text, /Checkout \(active\) \[salience 9\]/);
  assert.match(text, /Use a queue \{high-risk\}/);
  assert.match(text, /why: decouple ingestion/);
  assert.match(text, /https:\/\/app\.backthread\.dev\/acme\/app/);
  assert.notEqual(r.isError, true);
});

test('handleQueryTool: non-ok status flagged as error', async () => {
  const r = await handleQueryTool(
    {},
    { queryDecisionsImpl: async () => ({ status: 'no-repo', detail: 'no repo' }) },
  );
  assert.equal(r.isError, true);
  assert.match(textOf(r), /no-repo/);
});

test('handleQueryTool: passes repo + cwd args through to the read', async () => {
  let seen: unknown;
  await handleQueryTool(
    { repo: 'o/n', cwd: '/here', question: 'x' },
    {
      queryDecisionsImpl: async (input) => {
        seen = input;
        return { status: 'ok', detail: '', flows: [], decisions: [], deepLink: 'd' };
      },
    },
  );
  assert.deepEqual(seen, { repo: 'o/n', cwd: '/here' });
});

test('formatQueryOutcome: empty lists read as "none recorded yet"', () => {
  const text = formatQueryOutcome({
    status: 'ok',
    detail: '',
    repo: { owner: 'o', name: 'n' },
    flows: [],
    decisions: [],
    deepLink: 'https://app.backthread.dev/o/n',
  });
  assert.match(text, /Flows: none recorded yet/);
  assert.match(text, /Decisions: none recorded yet/);
});

// --- end-to-end over the SDK's in-memory transport ---------------------------
// Proves the server actually REGISTERS both tools and routes a tools/call to our
// (mocked) handlers — no stdio, no real bin, no network.

test('buildMcpServer: lists exactly capture + query and routes calls to mocked impls', async () => {
  let capturedInput: unknown;
  let queriedInput: unknown;
  const server = buildMcpServer({
    captureDeps: {
      runCaptureImpl: async (input) => {
        capturedInput = input;
        return { status: 'persisted', detail: 'ok', count: 1 } as CaptureOutcome;
      },
    },
    queryDeps: {
      queryDecisionsImpl: async (input) => {
        queriedInput = input;
        return {
          status: 'ok',
          detail: '',
          repo: { owner: 'acme', name: 'app' },
          flows: [],
          decisions: [],
          deepLink: 'https://app.backthread.dev/acme/app',
        };
      },
    },
  });

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['capture', 'query']);

    const capRes = await client.callTool({
      name: 'capture',
      arguments: { transcript_path: '/t.jsonl', cwd: '/w' },
    });
    assert.deepEqual(capturedInput, { transcript_path: '/t.jsonl', cwd: '/w', session_id: undefined });
    assert.match(JSON.stringify(capRes.content), /persisted/);

    const qRes = await client.callTool({
      name: 'query',
      arguments: { repo: 'acme/app', question: 'how does it work?' },
    });
    assert.deepEqual(queriedInput, { repo: 'acme/app', cwd: undefined });
    assert.match(JSON.stringify(qRes.content), /app\.backthread\.dev\/acme\/app/);
  } finally {
    await client.close();
    await server.close();
  }
});
