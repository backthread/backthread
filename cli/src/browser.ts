// browser.ts — open a URL in the user's default browser, dependency-free.
//
// We avoid the `open` npm package so `npx backthread` stays tiny and audit-light. The
// per-platform launcher is the same trick `open` uses: `open` on macOS, `start`
// via cmd on Windows, `xdg-open` on Linux. Returns false (rather than throwing)
// when no launcher is available — the caller then prints the URL for manual copy.
import { spawn } from 'node:child_process';

// Resolve the platform launcher. Exposed for unit testing the platform→command
// mapping without spawning anything.
export function browserCommand(platform: NodeJS.Platform): { cmd: string; prefixArgs: string[] } | null {
  switch (platform) {
    case 'darwin':
      return { cmd: 'open', prefixArgs: [] };
    case 'win32':
      // `start` is a cmd builtin; the empty "" is the (required) window-title arg
      // so a URL with spaces/quotes doesn't get mis-parsed as the title.
      return { cmd: 'cmd', prefixArgs: ['/c', 'start', ''] };
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
