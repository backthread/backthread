// fly-parse unit tests.
//
// Exercises parseFlyConfig + parseFlyToml against representative fly.toml
// shapes including a malformed input that must NOT throw (degrade gracefully).

import { describe, it, expect } from '../../testkit.js';
import { parseFlyConfig, parseFlyToml } from './fly-parse.js';

// ---------------------------------------------------------------------------
// Fixture: single-process app with one service and one mount
const SIMPLE_TOML = `
app = "myapp"
primary_region = "ams"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  PORT = "8080"

[[services]]
  internal_port = 3000
  protocol = "tcp"

  [services.concurrency]
    type = "connections"
    hard_limit = 25
    soft_limit = 20

[[mounts]]
  source = "myapp_data"
  destination = "/data"

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
  cpu_kind = "shared"
`;

// ---------------------------------------------------------------------------
// Fixture: multi-process app (web + worker processes)
const MULTI_PROCESS_TOML = `
app = "multiapp"
primary_region = "ord"

[build]
  image = "registry.fly.io/multiapp:latest"

[processes]
  web = "node server.js"
  worker = "node worker.js"

[[services]]
  internal_port = 8080
  protocol = "tcp"
  processes = ["web"]

[[mounts]]
  source = "worker_uploads"
  destination = "/uploads"
  processes = ["worker"]

[[vm]]
  size = "shared-cpu-2x"
  memory = "512mb"
  processes = ["web"]

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
  processes = ["worker"]
`;

// ---------------------------------------------------------------------------
// Fixture: minimal — just app name, no optional sections
const MINIMAL_TOML = `app = "bare"`;

// ---------------------------------------------------------------------------
// Fixture: malformed TOML — must NOT throw; must degrade gracefully
const MALFORMED_TOML = `
app = "broken"
[[services
  internal_port = 3000
this is not valid toml at all !!!
= = = =
`;

describe('parseFlyToml (raw TOML → tree)', () => {
  it('parses a valid fly.toml to a plain object', () => {
    const tree = parseFlyToml(SIMPLE_TOML);
    expect(typeof tree).toBe('object');
    expect(tree.app).toBe('myapp');
  });

  it('does not throw on malformed input', () => {
    expect(() => parseFlyToml(MALFORMED_TOML)).not.toThrow();
  });

  it('returns a partial tree from malformed input (app field still present)', () => {
    const tree = parseFlyToml(MALFORMED_TOML);
    // `app = "broken"` is valid and appears before the bad lines
    expect(tree.app).toBe('broken');
  });
});

describe('parseFlyConfig — simple single-process app', () => {
  const cfg = parseFlyConfig(SIMPLE_TOML);

  it('extracts app name and region', () => {
    expect(cfg.app).toBe('myapp');
    expect(cfg.primary_region).toBe('ams');
  });

  it('extracts build dockerfile', () => {
    expect(cfg.build?.dockerfile).toBe('Dockerfile');
    expect(cfg.build?.image).toBeUndefined();
  });

  it('extracts env block as a string map', () => {
    expect(cfg.env?.NODE_ENV).toBe('production');
    expect(cfg.env?.PORT).toBe('8080');
  });

  it('extracts services with internal_port and concurrency', () => {
    expect(cfg.services).toHaveLength(1);
    const svc = cfg.services[0];
    expect(svc.internal_port).toBe(3000);
    expect(svc.protocol).toBe('tcp');
    expect(svc.concurrency?.hard_limit).toBe(25);
    expect(svc.concurrency?.soft_limit).toBe(20);
  });

  it('extracts mounts with source and destination', () => {
    expect(cfg.mounts).toHaveLength(1);
    expect(cfg.mounts[0].source).toBe('myapp_data');
    expect(cfg.mounts[0].destination).toBe('/data');
  });

  it('extracts vm sizing', () => {
    expect(cfg.vms).toHaveLength(1);
    expect(cfg.vms[0].size).toBe('shared-cpu-1x');
    expect(cfg.vms[0].memory).toBe('256mb');
    expect(cfg.vms[0].cpu_kind).toBe('shared');
  });

  it('has no processes block (single-process app)', () => {
    expect(Object.keys(cfg.processes)).toHaveLength(0);
  });
});

describe('parseFlyConfig — multi-process app', () => {
  const cfg = parseFlyConfig(MULTI_PROCESS_TOML);

  it('extracts all named processes', () => {
    expect(cfg.processes).toEqual({ web: 'node server.js', worker: 'node worker.js' });
  });

  it('extracts services with process affinity', () => {
    expect(cfg.services[0].processes).toEqual(['web']);
  });

  it('extracts mounts with process affinity', () => {
    expect(cfg.mounts[0].source).toBe('worker_uploads');
    expect(cfg.mounts[0].processes).toEqual(['worker']);
  });

  it('extracts build image reference', () => {
    expect(cfg.build?.image).toBe('registry.fly.io/multiapp:latest');
    expect(cfg.build?.dockerfile).toBeUndefined();
  });

  it('extracts multiple vm blocks', () => {
    expect(cfg.vms).toHaveLength(2);
  });
});

describe('parseFlyConfig — minimal app (just name)', () => {
  const cfg = parseFlyConfig(MINIMAL_TOML);

  it('falls back to app name from field', () => {
    expect(cfg.app).toBe('bare');
  });

  it('has empty collections when sections are absent', () => {
    expect(cfg.services).toHaveLength(0);
    expect(cfg.mounts).toHaveLength(0);
    expect(cfg.vms).toHaveLength(0);
    expect(Object.keys(cfg.processes)).toHaveLength(0);
  });
});

describe('parseFlyConfig — malformed input does NOT throw', () => {
  it('returns a valid FlyConfig (degraded) from malformed TOML', () => {
    let cfg: ReturnType<typeof parseFlyConfig> | undefined;
    expect(() => {
      cfg = parseFlyConfig(MALFORMED_TOML);
    }).not.toThrow();
    // The app name from the first valid line is preserved
    expect(cfg?.app).toBe('broken');
    // Collections degrade to empty — the bad [[services line can't be parsed
    expect(cfg?.services).toHaveLength(0);
    expect(cfg?.mounts).toHaveLength(0);
  });
});
