// Shared Swift detect-time source-scan helpers (readHead / isXcodeContainer /
// scanSwiftSourceHeads) — the dedup'd core the ui/data/vapor adapters share.

import { describe, it, expect, afterEach } from '../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readHead, isXcodeContainer, scanSwiftSourceHeads } from './source-scan.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-swift-scan-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

describe('readHead', () => {
  it('reads only the head bytes of a file', async () => {
    const dir = await repo({ 'a.txt': 'HEAD' + 'x'.repeat(100) });
    expect(readHead(join(dir, 'a.txt'), 4)).toBe('HEAD');
  });
  it('returns the whole file when shorter than maxBytes', async () => {
    const dir = await repo({ 'a.swift': 'import SwiftUI\n' });
    expect(readHead(join(dir, 'a.swift'))).toBe('import SwiftUI\n');
  });
  it('returns "" for a missing file (never throws)', async () => {
    const dir = await repo({});
    expect(readHead(join(dir, 'nope.swift'))).toBe('');
  });
});

describe('isXcodeContainer', () => {
  it('is true for Xcode container-bundle suffixes', () => {
    expect(isXcodeContainer('MyApp.xcodeproj')).toBe(true);
    expect(isXcodeContainer('MyApp.xcworkspace')).toBe(true);
    expect(isXcodeContainer('Assets.xcassets')).toBe(true);
    expect(isXcodeContainer('Scratch.playground')).toBe(true);
  });
  it('is false for ordinary dirs (incl. the CoreData model bundle)', () => {
    expect(isXcodeContainer('Sources')).toBe(false);
    expect(isXcodeContainer('Model.xcdatamodeld')).toBe(false);
  });
});

describe('scanSwiftSourceHeads', () => {
  it('visits every .swift file with its head, skipping Package.swift', async () => {
    const dir = await repo({
      'Package.swift': 'let p = Package(name: "X")\n',
      'Sources/App/A.swift': 'import SwiftUI\n',
      'Sources/App/B.swift': 'import UIKit\n',
      'README.md': '# x\n',
    });
    const files: string[] = [];
    const heads: string[] = [];
    scanSwiftSourceHeads(
      dir,
      (entry, readFileHead) => {
        if (entry.kind === 'file') {
          files.push(entry.name);
          heads.push(readFileHead());
        }
      },
      600,
    );
    expect(files.sort()).toEqual(['A.swift', 'B.swift']); // Package.swift + README skipped
    expect(heads.some((h) => h.includes('SwiftUI'))).toBe(true);
    expect(heads.some((h) => h.includes('UIKit'))).toBe(true);
  });

  it('observes directory entries before they are skipped (e.g. .xcdatamodeld)', async () => {
    const dir = await repo({
      'Model.xcdatamodeld/contents': '<model/>\n',
      'Sources/App/A.swift': 'import Foundation\n',
    });
    const dirsSeen: string[] = [];
    scanSwiftSourceHeads(
      dir,
      (entry) => {
        if (entry.kind === 'dir') dirsSeen.push(entry.name);
      },
      600,
    );
    expect(dirsSeen).toContain('Model.xcdatamodeld');
  });

  it('does not recurse into excluded / dot / Xcode-container dirs', async () => {
    const dir = await repo({
      'Sources/App/A.swift': 'import SwiftUI\n',
      'Pods/Vendored/B.swift': 'import UIKit\n',
      '.build/checkouts/C.swift': 'import UIKit\n',
      'MyApp.xcodeproj/D.swift': 'import UIKit\n',
    });
    const files: string[] = [];
    scanSwiftSourceHeads(
      dir,
      (entry) => {
        if (entry.kind === 'file') files.push(entry.name);
      },
      600,
    );
    expect(files).toEqual(['A.swift']); // vendored/build/xcodeproj .swift never reached
  });

  it('bounds the walk by the file cap (only .swift files count)', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`Sources/App/F${i}.swift`] = 'import Foundation\n';
    const dir = await repo(files);
    let scanned = 0;
    scanSwiftSourceHeads(
      dir,
      (entry) => {
        if (entry.kind === 'file') scanned++;
      },
      3,
    );
    expect(scanned).toBe(3); // stops at the cap
  });

  it('early-exits the whole walk when the callback returns true', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`Sources/App/F${i}.swift`] = 'import Foundation\n';
    const dir = await repo(files);
    let scanned = 0;
    scanSwiftSourceHeads(
      dir,
      (entry) => {
        if (entry.kind !== 'file') return;
        scanned++;
        return true; // stop after the first file
      },
      600,
    );
    expect(scanned).toBe(1);
  });

  it('never throws on an unreadable base', () => {
    expect(() => scanSwiftSourceHeads('/no/such/path/xyz', () => {}, 600)).not.toThrow();
  });
});
