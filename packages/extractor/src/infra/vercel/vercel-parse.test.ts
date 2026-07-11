// Vercel parse utilities tests.
//
// Pure parser → no Supabase/Anthropic import chain, collects clean under
// vitest. Covers vercel.json parsing, package.json framework detection,
// next.config output-mode heuristic, and API route → path derivation.

import { describe, it, expect } from '../../testkit.js';
import {
  parseVercelJson,
  parsePackageJson,
  parseNextConfigOutputMode,
  routeFileToPath,
  routePathToLabel,
} from './vercel-parse.js';

// ---------------------------------------------------------------------------
// parseVercelJson

describe('parseVercelJson', () => {
  it('parses a full vercel.json with crons, functions, regions, rewrites', () => {
    const cfg = parseVercelJson(`{
      "framework": "nextjs",
      "regions": ["iad1", "cdg1"],
      "functions": {
        "app/api/heavy/route.ts": { "memory": 1024, "maxDuration": 30 },
        "pages/api/webhook.ts":   { "runtime": "nodejs20.x", "maxDuration": 10 }
      },
      "crons": [
        { "path": "/api/cron/daily", "schedule": "0 0 * * *" },
        { "path": "/api/cron/hourly", "schedule": "0 * * * *" }
      ],
      "rewrites": [
        { "source": "/old/:path*", "destination": "/new/:path*" }
      ]
    }`);

    expect(cfg.framework).toBe('nextjs');
    expect(cfg.regions).toEqual(['iad1', 'cdg1']);
    expect(Object.keys(cfg.functions ?? {})).toHaveLength(2);
    expect(cfg.functions?.['app/api/heavy/route.ts']).toEqual({ memory: 1024, maxDuration: 30 });
    expect(cfg.crons).toHaveLength(2);
    expect(cfg.crons?.[0]).toEqual({ path: '/api/cron/daily', schedule: '0 0 * * *' });
    expect(cfg.rewrites).toHaveLength(1);
  });

  it('returns an empty object for blank input (no config present)', () => {
    expect(parseVercelJson('')).toEqual({});
  });

  it('returns an empty object for whitespace-only input', () => {
    expect(parseVercelJson('   \n  ')).toEqual({});
  });

  it('throws a descriptive error on invalid JSON', () => {
    expect(() => parseVercelJson('{ not valid json }')).toThrow(/invalid JSON/i);
  });

  it('tolerates missing optional keys (minimal vercel.json)', () => {
    const cfg = parseVercelJson(`{ "framework": "nextjs" }`);
    expect(cfg.framework).toBe('nextjs');
    expect(cfg.crons).toBeUndefined();
    expect(cfg.functions).toBeUndefined();
  });

  it('ignores cron entries missing path or schedule fields', () => {
    const cfg = parseVercelJson(`{
      "crons": [
        { "path": "/api/ok", "schedule": "0 * * * *" },
        { "path": "/api/noschedule" },
        { "schedule": "1 * * * *" },
        null
      ]
    }`);
    expect(cfg.crons).toHaveLength(1);
    expect(cfg.crons?.[0].path).toBe('/api/ok');
  });

  it('accepts JSONC with trailing commas (vercel.json is sometimes JSONC)', () => {
    const cfg = parseVercelJson(`{
      "regions": ["iad1",],
      "crons": [
        { "path": "/api/ping", "schedule": "* * * * *", },
      ],
    }`);
    expect(cfg.regions).toEqual(['iad1']);
    expect(cfg.crons).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parsePackageJson

describe('parsePackageJson', () => {
  it('detects Next.js framework from dependencies', () => {
    const info = parsePackageJson(JSON.stringify({
      name: 'my-app',
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
    }));
    expect(info.name).toBe('my-app');
    expect(info.detectedFramework).toBe('next');
    expect(info.hasVercelDep).toBe(false);
  });

  it('detects SvelteKit from @sveltejs/kit in devDependencies', () => {
    const info = parsePackageJson(JSON.stringify({
      name: 'svelte-app',
      devDependencies: { '@sveltejs/kit': '^2.0.0' },
    }));
    expect(info.detectedFramework).toBe('sveltekit');
  });

  it('detects Astro framework', () => {
    const info = parsePackageJson(JSON.stringify({
      dependencies: { astro: '^4.0.0' },
    }));
    expect(info.detectedFramework).toBe('astro');
  });

  it('detects Remix framework from @remix-run/react', () => {
    const info = parsePackageJson(JSON.stringify({
      dependencies: { '@remix-run/react': '^2.0.0' },
    }));
    expect(info.detectedFramework).toBe('remix');
  });

  it('detects Nuxt from nuxt dep', () => {
    const info = parsePackageJson(JSON.stringify({
      dependencies: { nuxt: '^3.0.0' },
    }));
    expect(info.detectedFramework).toBe('nuxt');
  });

  it('detects vercel dep presence', () => {
    const info = parsePackageJson(JSON.stringify({
      devDependencies: { vercel: '^35.0.0' },
    }));
    expect(info.hasVercelDep).toBe(true);
  });

  it('detects @vercel/* scoped dep', () => {
    const info = parsePackageJson(JSON.stringify({
      devDependencies: { '@vercel/og': '^1.0.0' },
    }));
    expect(info.hasVercelDep).toBe(true);
  });

  it('returns no framework for an unrecognised project', () => {
    const info = parsePackageJson(JSON.stringify({
      name: 'express-app',
      dependencies: { express: '^4.0.0' },
    }));
    expect(info.detectedFramework).toBeUndefined();
    expect(info.hasVercelDep).toBe(false);
  });

  it('returns sensible defaults for empty input', () => {
    const info = parsePackageJson('');
    expect(info.hasVercelDep).toBe(false);
    expect(info.detectedFramework).toBeUndefined();
  });

  it('throws on invalid JSON', () => {
    expect(() => parsePackageJson('not json')).toThrow(/invalid JSON/i);
  });
});

// ---------------------------------------------------------------------------
// parseNextConfigOutputMode

describe('parseNextConfigOutputMode', () => {
  it("extracts 'export' output mode", () => {
    expect(parseNextConfigOutputMode(`
      const nextConfig = { output: 'export' };
      export default nextConfig;
    `)).toBe('export');
  });

  it("extracts 'standalone' output mode (double quotes)", () => {
    expect(parseNextConfigOutputMode(`
      module.exports = { output: "standalone" };
    `)).toBe('standalone');
  });

  it("extracts 'serverless' output mode", () => {
    expect(parseNextConfigOutputMode(`output: 'serverless'`)).toBe('serverless');
  });

  it('returns undefined when output is not set', () => {
    expect(parseNextConfigOutputMode(`
      const nextConfig = { reactStrictMode: true };
    `)).toBeUndefined();
  });

  it('returns undefined for an unrecognised output value', () => {
    expect(parseNextConfigOutputMode(`output: 'something-custom'`)).toBeUndefined();
  });

  it('does NOT match output mode inside a line comment', () => {
    // The real setting is absent — only the commented-out one should be ignored.
    expect(parseNextConfigOutputMode(`
      // output: 'export'
      const nextConfig = { reactStrictMode: true };
    `)).toBeUndefined();
  });

  it('does NOT match output mode inside a block comment', () => {
    expect(parseNextConfigOutputMode(`
      /*
       * output: 'standalone'
       */
      const nextConfig = {};
    `)).toBeUndefined();
  });

  it('returns the active output mode when a commented copy also exists', () => {
    expect(parseNextConfigOutputMode(`
      // output: 'export'   // was static before
      const nextConfig = { output: 'standalone' };
    `)).toBe('standalone');
  });
});

// ---------------------------------------------------------------------------
// routeFileToPath + routePathToLabel

describe('routeFileToPath', () => {
  it('maps pages/api route to /api path', () => {
    expect(routeFileToPath('pages/api/users.ts')).toBe('/api/users');
    expect(routeFileToPath('pages/api/users/[id].ts')).toBe('/api/users/[id]');
  });

  it('maps app router route.ts to its directory path', () => {
    expect(routeFileToPath('app/api/products/route.ts')).toBe('/api/products');
    expect(routeFileToPath('app/api/orders/[id]/route.ts')).toBe('/api/orders/[id]');
  });

  it('handles src/ prefix for both router conventions', () => {
    expect(routeFileToPath('src/pages/api/auth.ts')).toBe('/api/auth');
    expect(routeFileToPath('src/app/api/search/route.ts')).toBe('/api/search');
  });

  it('maps middleware.ts to /', () => {
    expect(routeFileToPath('middleware.ts')).toBe('/');
    expect(routeFileToPath('src/middleware.ts')).toBe('/');
  });

  it('normalises Windows-style backslash paths', () => {
    expect(routeFileToPath('pages\\api\\users.ts')).toBe('/api/users');
  });
});

describe('routePathToLabel', () => {
  it('strips leading slash for regular paths', () => {
    expect(routePathToLabel('/api/users')).toBe('api/users');
    expect(routePathToLabel('/api/orders/[id]')).toBe('api/orders/[id]');
  });

  it("labels '/' as 'middleware'", () => {
    expect(routePathToLabel('/')).toBe('middleware');
  });

  it('treats isMiddleware=true as middleware regardless of path', () => {
    expect(routePathToLabel('/api/something', true)).toBe('middleware');
  });
});
