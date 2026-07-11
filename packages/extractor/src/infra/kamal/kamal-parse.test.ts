// Kamal parser tests (pure: YAML in, typed config out).

import { describe, it, expect } from '../../testkit.js';
import { parseKamalConfig } from './kamal-parse.js';

const DEPLOY = `
service: myapp
image: myorg/myapp
builder:
  arch: amd64
  context: .
  dockerfile: Dockerfile
servers:
  web:
    - 192.168.0.1
  job:
    hosts:
      - 192.168.0.2
    cmd: bin/jobs
accessories:
  db:
    image: postgres:16
    host: 192.168.0.3
  redis:
    image: redis:7
    roles:
      - web
  search:
    image: myorg/meilisearch
`;

describe('parseKamalConfig', () => {
  const cfg = parseKamalConfig(DEPLOY);

  it('reads service + image', () => {
    expect(cfg.service).toBe('myapp');
    expect(cfg.image).toBe('myorg/myapp');
  });

  it('reads the builder context + dockerfile', () => {
    expect(cfg.builder?.context).toBe('.');
    expect(cfg.builder?.dockerfile).toBe('Dockerfile');
  });

  it('reads accessories in order, each with its image', () => {
    expect(cfg.accessories.map((a) => a.name)).toEqual(['db', 'redis', 'search']);
    expect(cfg.accessories.find((a) => a.name === 'db')?.image).toBe('postgres:16');
    expect(cfg.accessories.find((a) => a.name === 'search')?.image).toBe('myorg/meilisearch');
  });

  it('an empty config parses to no service/image/accessories (graceful)', () => {
    const cfg2 = parseKamalConfig('service: bare');
    expect(cfg2.service).toBe('bare');
    expect(cfg2.image).toBeUndefined();
    expect(cfg2.builder).toBeUndefined();
    expect(cfg2.accessories).toEqual([]);
  });

  it('throws on a non-mapping top-level document', () => {
    expect(() => parseKamalConfig('- a\n- b\n')).toThrow();
  });
});
