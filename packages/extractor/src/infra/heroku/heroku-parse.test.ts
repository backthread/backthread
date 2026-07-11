// Heroku parser unit tests (Procfile + app.json).

import { describe, it, expect } from '../../testkit.js';
import { parseProcfile } from './heroku-parse.js';
import { parseAppJson } from './heroku-parse.js';

// ---------------------------------------------------------------------------
// parseProcfile

describe('parseProcfile', () => {
  it('parses standard web + worker entries', () => {
    const result = parseProcfile('web: node server.js\nworker: node jobs.js\n');
    expect(result).toEqual([
      { processType: 'web', command: 'node server.js' },
      { processType: 'worker', command: 'node jobs.js' },
    ]);
  });

  it('parses release and clock process types', () => {
    const result = parseProcfile('release: node migrate.js\nclock: node scheduler.js');
    expect(result).toEqual([
      { processType: 'release', command: 'node migrate.js' },
      { processType: 'clock', command: 'node scheduler.js' },
    ]);
  });

  it('handles commands that contain colons (e.g. env vars)', () => {
    const result = parseProcfile('web: bundle exec rails server -p $PORT');
    expect(result).toHaveLength(1);
    expect(result[0].processType).toBe('web');
    expect(result[0].command).toBe('bundle exec rails server -p $PORT');
  });

  it('skips blank lines', () => {
    const result = parseProcfile('\nweb: node app.js\n\n');
    expect(result).toHaveLength(1);
  });

  it('skips comment lines', () => {
    const result = parseProcfile('# this is a comment\nweb: node app.js');
    expect(result).toHaveLength(1);
    expect(result[0].processType).toBe('web');
  });

  it('skips malformed lines without throwing', () => {
    const result = parseProcfile('this line has no colon\nweb: node app.js');
    expect(result).toHaveLength(1);
    expect(result[0].processType).toBe('web');
  });

  it('returns empty array for empty input', () => {
    expect(parseProcfile('')).toEqual([]);
  });

  it('handles custom process types', () => {
    const result = parseProcfile('scheduler: node cron.js');
    expect(result[0].processType).toBe('scheduler');
  });
});

// ---------------------------------------------------------------------------
// parseAppJson

describe('parseAppJson', () => {
  it('parses string addon array', () => {
    const result = parseAppJson(
      JSON.stringify({ addons: ['heroku-postgresql', 'heroku-redis'] }),
    );
    expect(result.addons).toEqual([{ slug: 'heroku-postgresql' }, { slug: 'heroku-redis' }]);
  });

  it('parses object addon array (id + plan form)', () => {
    const result = parseAppJson(
      JSON.stringify({ addons: [{ id: 'heroku-postgresql', plan: 'mini' }] }),
    );
    expect(result.addons).toEqual([{ slug: 'heroku-postgresql', plan: 'mini' }]);
  });

  it('normalizes slug-keyed object form', () => {
    const result = parseAppJson(JSON.stringify({ addons: [{ slug: 'sendgrid', plan: 'starter' }] }));
    expect(result.addons[0].slug).toBe('sendgrid');
    expect(result.addons[0].plan).toBe('starter');
  });

  it('tolerates missing addons key', () => {
    const result = parseAppJson(JSON.stringify({ name: 'myapp' }));
    expect(result.addons).toEqual([]);
  });

  it('tolerates missing env + formation keys', () => {
    const result = parseAppJson(JSON.stringify({ addons: [] }));
    expect(result.env).toEqual({});
    expect(result.formation).toEqual({});
  });

  it('parses name field', () => {
    const result = parseAppJson(JSON.stringify({ name: 'my-heroku-app', addons: [] }));
    expect(result.name).toBe('my-heroku-app');
  });

  it('drops addon entries with neither id nor slug key without throwing', () => {
    const result = parseAppJson(JSON.stringify({ addons: [{ plan: 'mini' }, 'heroku-redis'] }));
    // The object without id/slug is dropped; the string is kept
    expect(result.addons).toEqual([{ slug: 'heroku-redis' }]);
  });

  it('throws on completely unparseable JSON', () => {
    expect(() => parseAppJson('{ not valid json')).toThrow();
  });

  it('parses mixed string + object addon array', () => {
    const result = parseAppJson(
      JSON.stringify({
        addons: [
          'heroku-postgresql',
          { id: 'heroku-redis', plan: 'hobby' },
          'sendgrid',
        ],
      }),
    );
    expect(result.addons).toHaveLength(3);
    expect(result.addons[0]).toEqual({ slug: 'heroku-postgresql' });
    expect(result.addons[1]).toEqual({ slug: 'heroku-redis', plan: 'hobby' });
    expect(result.addons[2]).toEqual({ slug: 'sendgrid' });
  });
});
