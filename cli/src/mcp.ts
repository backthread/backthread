// mcp.ts — the MCP server: the in-Claude-Code surface for both
// halves of the product ("CC = capture/queries entry"). Two tools over stdio:
//
//   capture — capture the current/given session's DECISIONS (the "why"). Reuses
//             the `runCapture` pipeline verbatim (local-redact → derive →
//             hosted-POST). We NEVER reimplement the redact fence here.
//
//   query   — "how does X work?": reads the salience-ranked Flows + Decisions for
//             the configured repo via the read endpoint (queryDecisions) and
//             returns them PLUS a deep-link into the web-app diagram so the founder
//             can jump from CC to the visual.
//
// DESIGN: the McpServer wiring is thin. The actual work lives in runCapture /
// queryDecisions (their own modules, their own unit tests). The two tool handlers
// here just (1) adapt MCP args → those calls and (2) format the outcome into MCP
// `content`. So the handlers are exported + unit-testable WITHOUT a live MCP
// transport, a live network, a browser, or real auth — tests inject mocked impls.
//
// GUARDRAIL (load-bearing): the `capture` handler is given a `runCaptureImpl` seam
// and the tests inject a mock; the real path threads `CaptureDeps` through so that
// in production it uses the same best-effort, non-blocking pipeline. Nothing here
// calls ensureAuth/login/the browser directly.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runCapture, type CaptureDeps, type CaptureOutcome, type HookInput } from './capture.js';
import { queryDecisions, type QueryDeps, type QueryInput, type QueryOutcome } from './query.js';
import { cliVersion } from './version.js';

// The MCP content block shape we return (text-only). Structural so we don't depend
// on an SDK type export — the SDK's CallToolResult accepts
// `{ content: [{ type: 'text', text }] }`. The index signature keeps it assignable
// to the SDK's result type (which carries an open `[x: string]: unknown`).
interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [x: string]: unknown;
}

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) };
}

// --- capture tool ------------------------------------------------------------

/** What the MCP `capture` tool accepts. All optional — CC's session context fills
 * the rest (and the real hook feeds transcript_path on the bin's STDIN). */
export interface CaptureToolArgs {
  transcript_path?: string;
  cwd?: string;
  session_id?: string;
}

export interface CaptureToolDeps {
  /** Test seam: the capture pipeline. Defaults to runCapture. */
  runCaptureImpl?: (input: HookInput, deps?: CaptureDeps) => Promise<CaptureOutcome>;
  /** CaptureDeps threaded into the pipeline (env, fetch, readers). */
  captureDeps?: CaptureDeps;
}

/**
 * The `capture` tool handler — adapt args → HookInput, run the pipeline, and
 * render the structured outcome. runCapture never throws, but we still wrap so a
 * tool call can never crash the server.
 */
export async function handleCaptureTool(
  args: CaptureToolArgs = {},
  deps: CaptureToolDeps = {},
): Promise<ToolResult> {
  const run = deps.runCaptureImpl ?? runCapture;
  const input: HookInput = {
    transcript_path: args.transcript_path,
    cwd: args.cwd,
    session_id: args.session_id,
  };
  // Unlike `backthread capture` (the hook, which reads the payload off STDIN), the MCP
  // tool has no STDIN channel — the host MUST pass `transcript_path` in the args.
  // Without it `runCapture` would just return the generic `no-transcript` and
  // silently capture nothing; return an actionable hint instead so the agent knows
  // to supply the path rather than assume the session was captured.
  if (!input.transcript_path || input.transcript_path.trim().length === 0) {
    return textResult(
      'capture: no transcript_path — the MCP host must pass the session transcript path in the tool args (the `backthread capture` SessionEnd hook gets it on STDIN; the tool cannot). Nothing was captured.',
    );
  }
  try {
    const outcome = await run(input, deps.captureDeps);
    const ok = outcome.status === 'persisted' || outcome.status === 'persisted-by-server';
    const count = typeof outcome.count === 'number' ? ` (${outcome.count})` : '';
    return textResult(`capture: ${outcome.status}${count} — ${outcome.detail}`, !ok && isFailure(outcome));
  } catch (e) {
    return textResult(`capture: error — ${(e as Error).message}`, true);
  }
}

// Only the genuine failure statuses are flagged isError; "nothing-to-capture" /
// "no-auth" are NORMAL, non-error outcomes (the session was all code, or login is
// pending) and shouldn't read as a tool failure to the agent.
function isFailure(o: CaptureOutcome): boolean {
  return o.status === 'infer-failed' || o.status === 'persist-failed' || o.status === 'error';
}

// --- query tool --------------------------------------------------------------

export interface QueryToolArgs {
  /** The free-text "how does X work?" question (narrated by the agent against the
   * returned log; not a server-side filter — see query.ts). Optional. */
  question?: string;
  /** Optional repo override `owner/name`; else config.repo, else cwd's remote. */
  repo?: string;
  /** Session cwd (repo fallback). */
  cwd?: string;
}

export interface QueryToolDeps {
  /** Test seam: the read path. Defaults to queryDecisions. */
  queryDecisionsImpl?: (input: QueryInput, deps?: QueryDeps) => Promise<QueryOutcome>;
  /** QueryDeps threaded into the read (env, fetch, readers). */
  queryDeps?: QueryDeps;
}

/**
 * The `query` tool handler — run the read, then format the salience-ranked
 * Flows + Decisions and the diagram deep-link into a compact, agent-readable text
 * block. The agent narrates the answer against the user's "how does X work?".
 */
export async function handleQueryTool(
  args: QueryToolArgs = {},
  deps: QueryToolDeps = {},
): Promise<ToolResult> {
  const run = deps.queryDecisionsImpl ?? queryDecisions;
  try {
    const outcome = await run({ repo: args.repo, cwd: args.cwd }, deps.queryDeps);
    return textResult(formatQueryOutcome(outcome, args.question), outcome.status !== 'ok');
  } catch (e) {
    return textResult(`query: error — ${(e as Error).message}`, true);
  }
}

/** Render a QueryOutcome into a compact text block for the agent. */
export function formatQueryOutcome(outcome: QueryOutcome, question?: string): string {
  if (outcome.status !== 'ok') {
    return `query: ${outcome.status} — ${outcome.detail}`;
  }
  const lines: string[] = [];
  const q = question && question.trim().length > 0 ? ` for "${question.trim()}"` : '';
  const repoSlug = outcome.repo ? `${outcome.repo.owner}/${outcome.repo.name}` : 'this repo';
  lines.push(`How ${repoSlug} works${q} — salience-ranked from the decision log:`);
  lines.push('');

  const flows = outcome.flows ?? [];
  if (flows.length > 0) {
    lines.push('Flows (most salient first):');
    for (const f of flows) {
      const sal = f.salience != null ? ` [salience ${f.salience}]` : '';
      lines.push(`  - ${f.name} (${f.lifecycle})${sal}`);
    }
  } else {
    lines.push('Flows: none recorded yet.');
  }
  lines.push('');

  const decisions = outcome.decisions ?? [];
  if (decisions.length > 0) {
    lines.push('Decisions (the "why", most significant first):');
    for (const d of decisions) {
      const risk = d.domainRisk ? ` {${d.domainRisk}-risk}` : '';
      lines.push(`  - ${d.title}${risk}`);
      if (d.why) lines.push(`      why: ${d.why}`);
    }
  } else {
    lines.push('Decisions: none recorded yet.');
  }
  lines.push('');

  if (outcome.deepLink) {
    lines.push(`Open the "How it works" diagram: ${outcome.deepLink}`);
  }
  return lines.join('\n');
}

// --- server wiring -----------------------------------------------------------

export interface BuildServerDeps {
  captureDeps?: CaptureToolDeps;
  queryDeps?: QueryToolDeps;
  /** Test seam: override server name/version. */
  name?: string;
  version?: string;
}

/**
 * Build the McpServer with both tools registered. Pure construction — no transport
 * connection (that's startMcpServer). The tool callbacks delegate to the exported
 * handlers, so the registration wiring and the handler logic are testable apart.
 */
export function buildMcpServer(deps: BuildServerDeps = {}): McpServer {
  const server = new McpServer({
    name: deps.name ?? 'backthread',
    // Report the package's real version (read from package.json, ARP-478) instead of a
    // pinned 0.0.0, so an MCP host's serverInfo shows the installed Backthread version.
    version: deps.version ?? cliVersion(),
  });

  server.registerTool(
    'capture',
    {
      title: 'Capture this session',
      description:
        "Capture this Claude Code session's DECISIONS (the \"why\" behind the changes) into your Backthread decision log. Runs the same local-redact → derive → persist pipeline as the SessionEnd hook — no source code or tool I/O ever leaves the machine. Best-effort: a hiccup never disrupts your session. REQUIRES `transcript_path` (the absolute path to this session's .jsonl transcript): the MCP tool has no STDIN channel, so the host must supply it — without it nothing is captured.",
      inputSchema: {
        transcript_path: z
          .string()
          .optional()
          .describe('Absolute path to the session .jsonl transcript. Required for the tool to capture anything (the host must supply it).'),
        cwd: z.string().optional().describe("The session's working directory (resolves the repo)."),
        session_id: z.string().optional().describe('The session id (fallback if the transcript omits it).'),
      },
    },
    async (args) => handleCaptureTool(args as CaptureToolArgs, deps.captureDeps),
  );

  server.registerTool(
    'query',
    {
      title: 'How does X work?',
      description:
        'Answer "how does X work?" for the current repo: returns the salience-ranked Flows and Decisions (the "why" layer) from your Backthread decision log, plus a deep-link into the web-app "How it works" diagram. Read-only.',
      inputSchema: {
        question: z
          .string()
          .optional()
          .describe('The "how does X work?" question (the agent narrates the answer against the returned log).'),
        repo: z
          .string()
          .optional()
          .describe('Optional repo override as "owner/name"; otherwise the configured repo or the cwd git remote.'),
        cwd: z.string().optional().describe("The session's working directory (repo fallback)."),
      },
    },
    async (args) => handleQueryTool(args as QueryToolArgs, deps.queryDeps),
  );

  return server;
}

/**
 * Start the MCP server over stdio (the `backthread mcp` subcommand). Connects the built
 * server to a StdioServerTransport and resolves once connected; the process then
 * stays alive serving requests until stdin closes. Returns the server so a caller
 * (or a future test with a fake transport) can inspect/close it.
 */
export async function startMcpServer(deps: BuildServerDeps = {}): Promise<McpServer> {
  const server = buildMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
