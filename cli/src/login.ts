// login.ts — the `backthread login` command.
//
// The browser OAuth-loopback flow, end to end:
//   1. start a localhost server on http://127.0.0.1:<random-port>/callback
//   2. open the browser to app.backthread.dev/cli-auth?port=<port>&state=<nonce>
//   3. the user clicks "Authorize" (already signed into the web app) → the page
//      mints a backthread_pat_ token via mint-device-token and redirects back to the
//      loopback with ?token=…&state=…
//   4. validate the state nonce, write the token to ~/.backthread/config.json at 0600
//
// One browser click, zero copy-paste. The TOKEN IS NEVER PRINTED OR LOGGED — it
// goes straight from the loopback query string into the 0600 config file.
import { hostname } from 'node:os';
import { startLoopbackServer } from './loopback.js';
import { buildCliAuthUrl } from './urls.js';
import { openBrowser } from './browser.js';
import { updateConfig, readConfig, type BackthreadConfig } from './config.js';
import { exchangeClaim } from './claim.js';

export interface LoginOptions {
  /** Headless/SSH fallback (device-code flow). Stubbed in — see deviceLogin(). */
  device?: boolean;
  /**
   * A single-use claim code minted by the web app. When set,
   * login skips the browser loopback entirely and exchanges the code for a device
   * token — the frictionless `npx backthread install --claim …` onboarding path,
   * which also covers headless/SSH boxes (no browser needed).
   */
  claim?: string;
  /** Test seam: skip actually opening a browser (the loopback is driven directly). */
  noBrowser?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Where human-readable progress goes. Defaults to console.error (stderr) so the
   *  token-bearing stdout contract of other commands stays clean. */
  log?: (msg: string) => void;
}

export interface LoginResult {
  ok: boolean;
  /** What changed in the config — NEVER includes the token value. */
  message: string;
}

// Run the loopback login. Returns a result; the token is written to disk as a
// side effect and deliberately not returned (so a caller can't accidentally log
// it). The label sent to the mint endpoint is the device hostname, so the user
// recognizes it in the "Connected devices" list.
export async function login(opts: LoginOptions = {}): Promise<LoginResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.error(m));

  // Claim-code path: exchange the web-app-minted code for a device token —
  // no browser, no loopback. The token is written to disk by exchangeClaim and
  // never surfaces here (the result message is token-free by contract).
  if (opts.claim) {
    const result = await exchangeClaim(opts.claim, { env, label: deviceLabel() });
    log(result.message);
    return { ok: result.ok, message: result.message };
  }

  if (opts.device) {
    return deviceLogin(log);
  }

  const handle = await startLoopbackServer();
  const authUrl = buildCliAuthUrl(handle.port, handle.state, env);

  log('Opening your browser to authorize this device…');
  log(`If it doesn't open, visit:\n\n  ${authUrl}\n`);

  if (!opts.noBrowser) {
    const opened = await openBrowser(authUrl);
    if (!opened) {
      log('(Could not open a browser automatically — use the URL above.)');
    }
  }

  let token: string;
  try {
    token = await handle.waitForToken();
  } catch (err) {
    handle.close();
    return { ok: false, message: `Login failed: ${(err as Error).message}` };
  }

  // Persist the token at 0600. The hostname is stored as the (server-side) device
  // label via the page's mint call, not here — here we only stash the token (and
  // leave any existing account/repo slug untouched via read-modify-write).
  await updateConfig({ device_token: token }, env);

  log(`Authorized. Token stored in ${configLocationHint(env)} (chmod 0600).`);
  return { ok: true, message: 'Device authorized and token stored.' };
}

// A label suggestion for the device, derived from the machine hostname. The
// /cli-auth page can read this if we later pass it through the URL; for the
// page sends a generic label and the user can rename later.
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

// `backthread login --device` — device-code fallback for SSH/headless boxes with no
// browser or no loopback (a `gh`-style "go to <url>, enter code <ABCD-1234>").
//
// STUBBED: the full flow needs a server-side device-authorization
// endpoint (a `/device/code` + `/device/token` pair on the Edge Function tier) that
// does not exist yet — the primitive only ships the session-path
// mint. Tracked as a follow-up; flagged in the report. For now we fail
// clearly rather than pretend.
export function deviceLogin(log: (msg: string) => void): LoginResult {
  log(
    [
      'Headless (--device) login is not available yet.',
      '',
      'The device-code fallback needs a server-side device-authorization endpoint',
      'that ships in a later task. For now, run `backthread login` on a machine with a',
      'browser, or mint a token from the web app (Account → Connected devices) and',
      'place it in ~/.backthread/config.json under "device_token".',
    ].join('\n'),
  );
  return { ok: false, message: '--device fallback not implemented yet.' };
}

// ensureAuth — the auto-trigger seam (read by the capture hook). Returns the
// existing config if a device token is already present; otherwise runs `backthread login`
// once so "first capture with no token" kicks off the browser flow transparently.
export async function ensureAuth(opts: LoginOptions = {}): Promise<BackthreadConfig> {
  const env = opts.env ?? process.env;
  const existing = await readConfig(env);
  // An explicit claim code always exchanges (the user is deliberately re-binding
  // this device); otherwise an existing token short-circuits as before.
  if (existing.device_token && !opts.claim) return existing;
  const result = await login(opts);
  if (!result.ok) throw new Error(result.message);
  return readConfig(env);
}
