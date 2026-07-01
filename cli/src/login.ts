// login.ts — the `backthread login` command.
//
// The poll-based browser flow (ARP-768/773), end to end — NO loopback, NO localhost:
//   1. generate a high-entropy session id + an ephemeral P-256 keypair (node:crypto).
//   2. open the browser to app.backthread.dev/cli-auth?session=<id>&k=<pubkey> AND print
//      the URL (so it works on a remote/SSH box — open it on any device).
//   3. the user clicks "Authorize" (already signed into the web app) → the page mints a
//      backthread_pat_ token, ENCRYPTS it in the browser to our public key, and stashes
//      only the ciphertext.
//   4. we POLL the server for the ciphertext, decrypt it locally with our private key, and
//      write the token to ~/.backthread/config.json at 0600.
//
// The browser never touches 127.0.0.1, and the plaintext token is never sent to the
// server — only the ECDH ciphertext is, and only WE can decrypt it. The TOKEN IS NEVER
// PRINTED OR LOGGED — it goes straight from the decrypt into the 0600 config file.
import { hostname } from 'node:os';
import { buildCliAuthUrl } from './urls.js';
import { openBrowser } from './browser.js';
import { updateConfig, readConfig, type BackthreadConfig } from './config.js';
import { exchangeClaim } from './claim.js';
import { generateSessionId, generateEphemeralKeypair, type EphemeralKeypair } from './cliAuthCrypto.js';
import { pollForToken, type PollOptions, type PollResult } from './cliAuthPoll.js';

export interface LoginOptions {
  /** Headless/SSH fallback (device-code flow). Stubbed in — see deviceLogin(). */
  device?: boolean;
  /**
   * A single-use claim code minted by the web app. When set, login skips the browser
   * entirely and exchanges the code for a device token — the frictionless
   * `npx backthread install --claim …` onboarding path, which also covers headless/SSH
   * boxes (no browser needed).
   */
  claim?: string;
  /** Test seam: skip actually opening a browser (the poll loop is driven directly). */
  noBrowser?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Where human-readable progress goes. Defaults to console.error (stderr) so the
   *  token-bearing stdout contract of other commands stays clean. */
  log?: (msg: string) => void;
  /** Test seam: the poll-for-token step. Defaults to pollForToken (real network). */
  pollImpl?: (sessionId: string, keypair: EphemeralKeypair, opts: PollOptions) => Promise<PollResult>;
}

export interface LoginResult {
  ok: boolean;
  /** What changed in the config — NEVER includes the token value. */
  message: string;
}

// Run the poll-based login. Returns a result; the token is written to disk as a side
// effect and deliberately not returned (so a caller can't accidentally log it). The label
// sent to the page is the device hostname, so the user recognizes it in the "Connected
// devices" list and re-login rotates that machine's token in place.
export async function login(opts: LoginOptions = {}): Promise<LoginResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.error(m));

  // Claim-code path: exchange the web-app-minted code for a device token — no browser,
  // no poll. The token is written to disk by exchangeClaim and never surfaces here.
  if (opts.claim) {
    const result = await exchangeClaim(opts.claim, { env, label: deviceLabel() });
    log(result.message);
    return { ok: result.ok, message: result.message };
  }

  if (opts.device) {
    return deviceLogin(log);
  }

  // Poll flow: a fresh session id + ephemeral keypair. The private key stays in memory;
  // only the public key rides in the URL.
  const sessionId = generateSessionId();
  const keypair = generateEphemeralKeypair();
  const authUrl = buildCliAuthUrl(sessionId, keypair.publicKeyB64url, env, deviceLabel());

  log('Opening your browser to authorize this device…');
  log(`If it doesn't open — or you're on a remote/SSH box — open this on any device:\n\n  ${authUrl}\n`);

  if (!opts.noBrowser) {
    const opened = await openBrowser(authUrl);
    if (!opened) {
      log('(Could not open a browser automatically — use the URL above.)');
    }
  }

  const poll = opts.pollImpl ?? pollForToken;
  const result = await poll(sessionId, keypair, { env });
  if (!result.ok) {
    return { ok: false, message: pollFailureMessage(result) };
  }

  // Persist the token at 0600 (read-modify-write leaves any existing account/repo slug
  // untouched). The hostname label is stored server-side via the page's mint call.
  await updateConfig({ device_token: result.token }, env);

  log(`Authorized. Token stored in ${configLocationHint(env)} (chmod 0600).`);
  return { ok: true, message: 'Device authorized and token stored.' };
}

// Turn a non-ok poll result into an actionable message (never leaks token material).
// On timeout/expired we do NOT re-offer the original URL: its session's poller has
// stopped, so re-opening it would stash a token nothing is fetching — re-running
// `backthread login` (a fresh session + a fresh poll) is the only real recovery.
function pollFailureMessage(result: Extract<PollResult, { ok: false }>): string {
  if (result.reason === 'expired' || result.reason === 'timeout') {
    return `Login ${result.reason === 'expired' ? 'expired' : 'timed out'}: ${result.message}. Re-run \`backthread login\` to try again.`;
  }
  return `Login failed: ${result.message}`;
}

// A label suggestion for the device, derived from the machine hostname — forwarded to the
// /cli-auth page as `?label=` so the minted token is named for THIS machine and re-login
// rotates it in place (register_device_token) instead of piling up orphans.
export function deviceLabel(): string {
  try {
    const h = hostname();
    return h && h.length > 0 ? h : 'backthread login';
  } catch {
    return 'backthread login';
  }
}

// Human-readable config path for log messages, without leaking the token.
function configLocationHint(env: NodeJS.ProcessEnv): string {
  return env.BACKTHREAD_CONFIG_DIR ? `${env.BACKTHREAD_CONFIG_DIR}/config.json` : '~/.backthread/config.json';
}

// `backthread login --device` — device-code fallback for SSH/headless boxes. STUBBED: the
// full flow needs a server-side device-authorization endpoint that does not exist yet.
// NOTE: the poll flow already covers most "no local browser" cases (open the printed URL
// on any device — delivery is via polling, so the browser need not be on this machine),
// so --device is now only for boxes with NO browser reachable at all.
export function deviceLogin(log: (msg: string) => void): LoginResult {
  log(
    [
      'Headless (--device) login is not available yet.',
      '',
      'You usually don’t need it: `backthread login` prints a URL you can open on ANY',
      'device (phone, laptop) — the token is delivered by polling, so the browser doesn’t',
      'have to be on this machine. For a fully browserless box, mint a token from the web',
      'app (Account → Connected devices) and place it in ~/.backthread/config.json under',
      '"device_token", or use `--claim <code>` from the web app.',
    ].join('\n'),
  );
  return { ok: false, message: '--device fallback not implemented yet.' };
}

// ensureAuth — the auto-trigger seam (read by the capture hook). Returns the existing
// config if a device token is already present; otherwise runs `backthread login` once so
// "first capture with no token" kicks off the browser flow transparently.
export async function ensureAuth(opts: LoginOptions = {}): Promise<BackthreadConfig> {
  const env = opts.env ?? process.env;
  const existing = await readConfig(env);
  // An explicit claim code always exchanges (the user is deliberately re-binding this
  // device); otherwise an existing token short-circuits as before.
  if (existing.device_token && !opts.claim) return existing;
  const result = await login(opts);
  if (!result.ok) throw new Error(result.message);
  return readConfig(env);
}
