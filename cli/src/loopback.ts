// loopback.ts — the OAuth-loopback callback server for `backthread login`.
//
// Mirrors `gh auth login` / `wrangler login`: start a localhost HTTP server on a
// random port, open the browser to the web app's /cli-auth page, and wait for the
// web app to redirect back to http://127.0.0.1:<port>/callback?token=…&state=…
// with the freshly-minted device token. We validate the `state` nonce (CSRF: a
// stray/malicious request to the loopback can't inject a token) and hand the
// token to the caller, which writes it to ~/.backthread/config.json at 0600.
//
// The pure parts — nonce generation and callback-request validation — live here
// and are unit-tested; the network bits (createServer, browser open) are thin.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';

// CSRF nonce: 32 bytes (256 bits) of CSPRNG entropy, base64url. The web app
// echoes it back in the redirect; we reject any callback whose state doesn't
// match, so a request the user didn't initiate can't plant a token.
export function generateState(): string {
  return base64url(randomBytes(32));
}

// base64url (RFC 4648 §5, no padding) — URL-safe so it rides in a query string
// without escaping.
function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface CallbackResult {
  ok: boolean;
  token?: string;
  /** A short machine-readable reason when ok=false (for tests + logging-safe text). */
  reason?: 'wrong_path' | 'bad_method' | 'state_mismatch' | 'missing_token' | 'error_param';
  /** Optional error string the web app passed in `?error=` (never the token). */
  error?: string;
}

// Validate an inbound loopback request against the expected state. Pure: takes the
// request method + URL (as seen by the server) and the nonce we generated, returns
// whether this is the legitimate callback carrying our token.
//
// Security properties enforced here:
//   - path must be exactly /callback (ignore favicon/probe hits)
//   - method must be GET (the browser redirect is a GET)
//   - state must byte-match the nonce we generated (CSRF)
//   - an ?error= param surfaces a web-side failure without a token
//   - token must be present and look like a backthread_pat_ token
export function validateCallback(
  method: string | undefined,
  rawUrl: string | undefined,
  expectedState: string,
): CallbackResult {
  if ((method ?? '').toUpperCase() !== 'GET') return { ok: false, reason: 'bad_method' };
  // Resolve against a dummy base so the WHATWG URL parser can split path + query;
  // 127.0.0.1 is irrelevant here, only the path/search matter.
  let url: URL;
  try {
    url = new URL(rawUrl ?? '', 'http://127.0.0.1');
  } catch {
    return { ok: false, reason: 'wrong_path' };
  }
  if (url.pathname !== '/callback') return { ok: false, reason: 'wrong_path' };

  const errorParam = url.searchParams.get('error');
  if (errorParam) return { ok: false, reason: 'error_param', error: errorParam };

  const state = url.searchParams.get('state');
  // Plain equality is fine here: the nonce is single-use, the server lives for
  // only seconds, and there's no oracle to time against — so constant-time
  // comparison would buy nothing.
  if (state === null || state !== expectedState) return { ok: false, reason: 'state_mismatch' };

  const token = url.searchParams.get('token');
  // Bound the token to the exact shape the mint endpoint produces:
  // `backthread_pat_` + a base64url body (see mint-device-token/mint.ts). This is a
  // trust boundary — the token is attacker-reachable via this loopback request
  // and later rides in an Authorization header — so reject anything with
  // control characters / unexpected bytes rather than just checking the prefix.
  if (!token || !/^backthread_pat_[A-Za-z0-9_-]+$/.test(token)) {
    return { ok: false, reason: 'missing_token' };
  }

  return { ok: true, token };
}

export interface LoopbackHandle {
  /** The randomly-assigned loopback port the OS gave us. */
  port: number;
  /** The state nonce the web app must echo back. */
  state: string;
  /**
   * Resolves with the device token once the browser redirects back with a valid
   * callback, or rejects on timeout / fatal server error. Always tears the server
   * down before settling.
   */
  waitForToken(timeoutMs?: number): Promise<string>;
  /** Force-close the server (idempotent) — used on Ctrl-C or error paths. */
  close(): void;
}

// HTML shown in the browser tab after the redirect lands. Deliberately tiny and
// self-contained (no token in it — the token is in the query string the server
// already consumed, never rendered).
function resultPage(ok: boolean): string {
  const title = ok ? 'You’re connected' : 'Something went wrong';
  const body = ok
    ? 'Backthread is now authorized on this device. You can close this tab and return to your terminal.'
    : 'Backthread couldn’t finish authorizing this device. Close this tab and run <code>backthread login</code> again.';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.5rem;color:#18181b}
h1{font-size:1.25rem}code{background:#f4f4f5;padding:.1em .3em;border-radius:4px}</style></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`;
}

// Start the loopback server on a random port (port 0 → OS assigns). Returns a
// handle whose waitForToken() resolves once a valid callback arrives.
export function startLoopbackServer(): Promise<LoopbackHandle> {
  return new Promise((resolveStart, rejectStart) => {
    const state = generateState();

    // The callback can arrive before (or after) waitForToken() is called. We hold
    // the outcome in a buffer and have waitForToken() consume it, so there's no
    // ordering race and — critically — no rejection is ever created before a
    // handler is attached (which would surface as an unhandledRejection).
    let outcome: { token: string } | { error: Error } | null = null;
    let onOutcome: (() => void) | null = null;

    const deliver = (o: { token: string } | { error: Error }) => {
      if (outcome) return; // single-shot — first valid callback wins
      outcome = o;
      onOutcome?.();
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const result = validateCallback(req.method, req.url, state);
      // Ignore probe/favicon hits silently (don't end the wait): only a real
      // /callback (success OR an explicit error/state issue carrying our intent)
      // should resolve. A wrong path is a 404 and the wait continues.
      if (!result.ok && result.reason === 'wrong_path') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(resultPage(result.ok));
      if (result.ok && result.token) {
        deliver({ token: result.token });
      } else {
        deliver({
          error: new Error(
            result.reason === 'error_param'
              ? `web app reported: ${result.error}`
              : `invalid callback (${result.reason})`,
          ),
        });
      }
    });

    server.on('error', (err) => {
      // Pre-listen error (e.g. EADDRINUSE on the ephemeral bind) → fail startup.
      // After listen, route through the outcome buffer.
      if (outcome === null && onOutcome === null) rejectStart(err);
      else deliver({ error: err });
    });

    // Bind to loopback only — never 0.0.0.0. The token must only be deliverable
    // from this machine's browser, not the LAN.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;

      const close = () => {
        try {
          server.close();
        } catch {
          /* already closing */
        }
      };

      const waitForToken = (timeoutMs = 5 * 60_000): Promise<string> =>
        new Promise<string>((resolve, reject) => {
          const finish = () => {
            if (!outcome) return;
            close();
            if ('token' in outcome) resolve(outcome.token);
            else reject(outcome.error);
          };
          const timer = setTimeout(() => {
            close();
            reject(new Error('timed out waiting for the browser to authorize this device'));
          }, timeoutMs);
          onOutcome = () => {
            clearTimeout(timer);
            finish();
          };
          // If the callback already arrived before we started waiting, consume it now.
          if (outcome) {
            clearTimeout(timer);
            finish();
          }
        });

      resolveStart({ port, state, waitForToken, close });
    });
  });
}
