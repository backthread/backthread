// inflowFixtures.test.ts — shared fixtures for the in-flow ask suites.
//
// Named `.test.ts` on purpose: it holds no tests, but the suffix is what keeps it out
// of the shipped build (`tsconfig.json` excludes `src/**/*.test.ts`), so a test helper
// can never end up in the published CLI. `node --test` is happy with a file that
// registers nothing.

import type { InflowAsk, InflowPromise } from './inflow.js';

export const TOKEN = 'eyJhIjoiYiJ9.c2lnbmF0dXJl';

export const ASK: InflowAsk = {
  token: TOKEN,
  expiresAt: '2026-08-16T12:30:00.000Z',
  rung: 'recognise',
  shape: 'why-not',
  subsystem: 'Ingest pipeline',
  body: 'Why does the merge gate hold a decision until its work lands on the tracked branch?',
  isOpen: false,
  materialKey: 'decision:abc',
};

export const PROMISE: InflowPromise = {
  short: 'Ignore this — nothing is recorded unless you answer.',
  title: 'Ignore this and nothing happens.',
  points: [
    'Nothing was written down when this was asked.',
    'Nothing counts how often you are asked or how often you answer.',
    'Your lead sees what the team understands, never who replied.',
  ],
};

/** A fetch stub that records what it was called with and replies once. */
export function stubFetch(
  status: number,
  body: unknown,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return { status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

export const SIGNED_IN = async () => ({ device_token: 'dt_test', repo: 'acme/widgets' }) as never;
