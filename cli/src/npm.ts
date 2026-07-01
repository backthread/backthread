// npm.ts — the ONE Windows-safe `npm <args>` spawn, shared by every command that shells out
// to npm (`update`, `doctor`). Kept in one place so the cross-platform quirks live once.
//
// On Windows npm is `npm.cmd`, and modern Node (the CVE-2024-27980 mitigation) refuses to
// execFile a `.cmd`/`.bat` without `shell: true` — so run under the shell there. That's
// injection-safe here because every caller passes a FIXED, space/metachar-free argv (e.g.
// `['view','backthread','version']`), never user input. Never throws: any spawn failure —
// npm missing, timeout, network, or a synchronous validation throw — resolves to
// { ok:false, stderr } so callers can branch on a value instead of a try/catch.
import { execFile } from 'node:child_process';

export interface NpmRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function runNpm(args: string[]): Promise<NpmRun> {
  const isWin = process.platform === 'win32';
  const npm = isWin ? 'npm.cmd' : 'npm';
  return new Promise<NpmRun>((resolve) => {
    try {
      execFile(
        npm,
        args,
        { timeout: 120_000, windowsHide: true, shell: isWin, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({
            ok: !err,
            stdout: (stdout ?? '').toString().trim(),
            stderr: (stderr ?? '').toString().trim(),
          });
        },
      );
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: (e as Error).message ?? String(e) });
    }
  });
}
