// Ruby standard-library require names — the analogue of python-stdlib.ts. A
// `require 'json'` / `require 'net/http'` names substrate the module graph never
// needs as a dependency node, so (matching the ts-morph Node-builtin drop and the
// Python stdlib drop) the FIRST path segment of a require is checked against this
// set and dropped when it hits. Everything else that doesn't resolve to a
// first-party file becomes an external `ext:<name>` gem node.
//
// This is the top-level require name (the first `/`-segment): `net/http` -> `net`,
// `digest/sha1` -> `digest`. Default gems that are meaningful dependencies
// (rake, minitest, rspec, bundler) are deliberately NOT here — they read as gems.

export const RUBY_STDLIB = new Set<string>([
  'abbrev', 'base64', 'benchmark', 'bigdecimal', 'cgi', 'coverage', 'csv', 'date',
  'datetime', 'delegate', 'digest', 'drb', 'english', 'erb', 'etc', 'fcntl',
  'fiddle', 'fileutils', 'find', 'forwardable', 'getoptlong', 'io', 'ipaddr',
  'irb', 'json', 'logger', 'marshal', 'matrix', 'monitor', 'mutex_m', 'net',
  'nkf', 'objspace', 'observer', 'open3', 'openssl', 'optparse', 'ostruct',
  'pathname', 'pp', 'prettyprint', 'prime', 'pstore', 'psych', 'pty', 'rbconfig',
  'readline', 'resolv', 'rexml', 'rinda', 'ripper', 'rss', 'securerandom', 'set',
  'shellwords', 'singleton', 'socket', 'stringio', 'strscan', 'syslog', 'tempfile',
  'time', 'timeout', 'tmpdir', 'tsort', 'uri', 'weakref', 'yaml', 'zlib',
  // open-uri exposes `open-uri` / `open_uri`
  'open-uri',
]);
