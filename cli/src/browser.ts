// browser.ts — open a URL in the user's default browser, dependency-free.
//
// We avoid the `open` npm package so `npx backthread` stays tiny and audit-light. The
// per-platform launcher: `open` on macOS, `rundll32 url.dll,FileProtocolHandler` on
// Windows, `xdg-open` on Linux. Every launcher is a DIRECT executable and the URL is
// passed as a plain argv element (never through a shell), so URL metacharacters are
// literal. Returns false (rather than throwing) when no launcher is available — the caller
// then prints the URL for manual copy.
//
// WHY NOT `cmd /c start` on Windows (ARP-796): routing the URL through cmd.exe puts a SHELL
// in the open path. cmd re-parses `&` (our poll-auth query-param separators) as command
// chains and treats `%`-encoded sequences (`%2…`) as batch-arg expansions — truncating or
// corrupting the URL, and giving a local, hostname-derived label a path into the shell.
// rundll32 is a plain executable: no cmd, no re-parse, no shell.
import { spawn } from 'node:child_process';

// Resolve the platform launcher. Exposed for unit testing the platform→command
// mapping without spawning anything.
export function browserCommand(platform: NodeJS.Platform): { cmd: string; prefixArgs: string[] } | null {
  switch (platform) {
    case 'darwin':
      return { cmd: 'open', prefixArgs: [] };
    case 'win32':
      // Open via the default protocol handler WITHOUT cmd.exe. `url.dll,FileProtocolHandler`
      // is a single argument; the URL follows as its own argv element, so `&` and `%…` stay
      // literal (a `cmd /c start` would re-parse them — see the header note).
      return { cmd: 'rundll32', prefixArgs: ['url.dll,FileProtocolHandler'] };
    default:
      // Linux / BSD — xdg-open is the freedesktop standard.
      return { cmd: 'xdg-open', prefixArgs: [] };
  }
}

// Best-effort open. Resolves true if the launcher was spawned without an immediate
// error, false if we couldn't launch (no command, spawn error). Never rejects —
// failing to open a browser is a soft failure (we print the URL instead).
export function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  return new Promise((resolve) => {
    const launcher = browserCommand(platform);
    if (!launcher) {
      resolve(false);
      return;
    }
    try {
      const child = spawn(launcher.cmd, [...launcher.prefixArgs, url], {
        stdio: 'ignore',
        detached: true,
      });
      child.on('error', () => resolve(false));
      // Don't keep the event loop alive on the child; we only needed to launch it.
      child.unref();
      // Give the spawn a tick to surface an immediate error before declaring success.
      setTimeout(() => resolve(true), 0);
    } catch {
      resolve(false);
    }
  });
}
