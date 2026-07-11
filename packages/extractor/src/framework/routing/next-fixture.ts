// a synthetic Next.js app, the HERMETIC gate shared by the Next routing
// convention test (routing/next-router.test.ts) + the Next adapter contribution
// test (next/next.test.ts). No connected Next repo exists yet, so the fixture IS
// the test (mirrors expo-fixture.ts / nest-test-fixture.ts).
//
// It deliberately exercises BOTH routers co-existing (a real migration) + every
// rule the parser/adapter must handle:
//
//   middleware.ts                      [middleware → gateway] edge-runtime gate
//
//   app/layout.tsx                     [layout · server]  root layout (no parent)
//   app/page.tsx                       [page · server]    '/'  → Links /dashboard, /blog/42, /pricing
//   app/actions.ts                     'use server' MODULE [server-action → gateway]
//   app/dashboard/layout.tsx           [layout · server]  '/dashboard'; imports ./StatsCard
//   app/dashboard/page.tsx             [page · CLIENT]    '/dashboard'; imports ../actions (→server-action
//                                        edge) + ./Chart; fetch('/api/stats') (→route-handler edge)
//   app/dashboard/Chart.tsx            'use client' co-located [client-component · client]
//   app/dashboard/StatsCard.tsx        co-located, JSX, no directive [server-component · server]
//   app/blog/[slug]/page.tsx           [page · server]    '/blog/[slug]' (dynamic); a DYNAMIC <Link
//                                        href={`/blog/${slug}`}> (logged+skipped) + an INLINE 'use server'
//                                        (function-level → degrade+log, NOT a module action)
//   app/api/stats/route.ts             [endpoint → route-handler · gateway]  '/api/stats'
//   app/(marketing)/pricing/page.tsx   [page · server]    '/pricing' (route GROUP stripped)
//
//   pages/_app.tsx                     [layout]  '/'  (global wrapper)
//   pages/_document.tsx                (NOT a route — the server doc shell)
//   pages/legacy.tsx                   [page]    '/legacy'  → <Link href="/about">
//   pages/about.tsx                    [page]    '/about'
//   pages/api/ping.ts                  [endpoint → route-handler]  '/api/ping'
//
// Expected resolvable navEdges (route tree; page/route roles only):
//   app/page → app/dashboard/page      (Link '/dashboard')
//   app/page → app/blog/[slug]/page    (Link '/blog/42'  matches the dynamic [slug])
//   app/page → app/(marketing)/pricing/page  (Link '/pricing'  route-group stripped)
//   pages/legacy → pages/about         (Link '/about')
// Expected route-segment groups: api (app+pages MERGED), blog, dashboard, pricing,
//   root('Home'). Expected degrade logs: 1 dynamic nav target + 1 inline server action.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    { name: 'next-fixture', dependencies: { next: '14.2.0', react: '18.2.0', 'react-dom': '18.2.0' } },
    null,
    2,
  ),
  'next.config.mjs': 'export default {};\n',
  'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }, null, 2),

  // --- edge-runtime middleware (repo root; not a route, not in any segment) ---
  'middleware.ts': `
import { NextResponse } from 'next/server';
export function middleware() {
  return NextResponse.next();
}
`,

  // --- App Router -----------------------------------------------------------
  'app/layout.tsx': `
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
  'app/page.tsx': `
import Link from 'next/link';
export default function Home() {
  return (
    <main>
      <Link href="/dashboard">Dashboard</Link>
      <Link href="/blog/42">A post</Link>
      <Link href="/pricing">Pricing</Link>
    </main>
  );
}
`,
  'app/actions.ts': `
'use server';
export async function saveThing(value: string): Promise<string> {
  return value.toUpperCase();
}
`,
  'app/dashboard/layout.tsx': `
import { StatsCard } from './StatsCard';
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <section><StatsCard /></section>;
}
`,
  'app/dashboard/page.tsx': `
'use client';
import { useEffect } from 'react';
import { saveThing } from '../actions';
import { Chart } from './Chart';
export default function Dashboard() {
  useEffect(() => {
    fetch('/api/stats').then(() => undefined);
  }, []);
  return (
    <div onClick={() => saveThing('x')}>
      <Chart />
    </div>
  );
}
`,
  'app/dashboard/Chart.tsx': `
'use client';
import { useState } from 'react';
export function Chart() {
  const [n] = useState(0);
  return <span>{n}</span>;
}
`,
  'app/dashboard/StatsCard.tsx': `
export function StatsCard() {
  return <aside>stats</aside>;
}
`,
  'app/blog/[slug]/page.tsx': `
import Link from 'next/link';
export default function BlogPost({ params }: { params: { slug: string } }) {
  async function save() {
    'use server';
    return params.slug;
  }
  void save;
  return <Link href={\`/blog/\${params.slug}\`}>self</Link>;
}
`,
  'app/api/stats/route.ts': `
export async function GET() {
  return Response.json({ ok: true });
}
`,
  'app/(marketing)/pricing/page.tsx': `
export default function Pricing() {
  return <h1>Pricing</h1>;
}
`,

  // --- Pages Router (co-existing migration) --------------------------------
  'pages/_app.tsx': `
export default function App({ Component, pageProps }: { Component: React.ComponentType; pageProps: object }) {
  return <Component {...pageProps} />;
}
`,
  'pages/_document.tsx': `
export default function Document() {
  return <html><body /></html>;
}
`,
  'pages/legacy.tsx': `
import Link from 'next/link';
export default function Legacy() {
  return <Link href="/about">About</Link>;
}
`,
  'pages/about.tsx': `
export default function About() {
  return <p>about</p>;
}
`,
  'pages/api/ping.ts': `
export default function handler(_req: unknown, res: { json: (b: unknown) => void }) {
  res.json({ pong: true });
}
`,
};

export const NEXT_FIXTURE_FILES = {
  middleware: 'middleware.ts',
  // App Router
  appRootLayout: 'app/layout.tsx',
  appHome: 'app/page.tsx',
  appActions: 'app/actions.ts',
  dashboardLayout: 'app/dashboard/layout.tsx',
  dashboardPage: 'app/dashboard/page.tsx',
  dashboardChart: 'app/dashboard/Chart.tsx',
  dashboardStatsCard: 'app/dashboard/StatsCard.tsx',
  blogPost: 'app/blog/[slug]/page.tsx',
  apiStatsRoute: 'app/api/stats/route.ts',
  pricingPage: 'app/(marketing)/pricing/page.tsx',
  // Pages Router
  pagesApp: 'pages/_app.tsx',
  pagesDocument: 'pages/_document.tsx',
  pagesLegacy: 'pages/legacy.tsx',
  pagesAbout: 'pages/about.tsx',
  pagesApiPing: 'pages/api/ping.ts',
} as const;

/** Write the Next.js fixture tree (App + Pages routers) under `dir`. */
export async function writeNextFixture(dir: string): Promise<void> {
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content.startsWith('\n') ? content.slice(1) : content);
  }
}
