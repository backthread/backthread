// Pure Zeitwerk constant<->path resolution.

import { describe, it, expect } from '../testkit.js';
import {
  camelize,
  computeAutoloadRoots,
  fileToConstant,
  buildConstantIndex,
  resolveConstant,
  joinRelative,
} from './ruby-zeitwerk.js';

describe('camelize', () => {
  it('camelizes underscore_cased segments', () => {
    expect(camelize('users_controller')).toBe('UsersController');
    expect(camelize('admin')).toBe('Admin');
    expect(camelize('v2')).toBe('V2');
    expect(camelize('')).toBe('');
  });
});

describe('computeAutoloadRoots', () => {
  it('recognizes app/<subdir>, concerns, and lib — longest-first, excludes asset/view dirs', () => {
    const roots = computeAutoloadRoots([
      'app/models/user.rb',
      'app/controllers/admin/users_controller.rb',
      'app/models/concerns/trackable.rb',
      'app/views/users/index.html.erb',
      'app/assets/x.rb',
      'lib/tasks/db.rake',
      'lib/my_gem/version.rb',
    ]);
    expect(roots).toContain('app/models');
    expect(roots).toContain('app/controllers');
    expect(roots).toContain('app/models/concerns');
    expect(roots).toContain('lib');
    expect(roots).not.toContain('app/views');
    expect(roots).not.toContain('app/assets');
    // longest-first, so the concerns root is matched before app/models
    expect(roots.indexOf('app/models/concerns')).toBeLessThan(roots.indexOf('app/models'));
  });
});

describe('fileToConstant', () => {
  const roots = ['app/models/concerns', 'app/controllers', 'app/models', 'lib'];
  it('inverts the Zeitwerk path convention', () => {
    expect(fileToConstant('app/models/user.rb', roots)).toBe('User');
    expect(fileToConstant('app/controllers/admin/users_controller.rb', roots)).toBe('Admin::UsersController');
    expect(fileToConstant('app/models/concerns/trackable.rb', roots)).toBe('Trackable');
    expect(fileToConstant('lib/my_gem/version.rb', roots)).toBe('MyGem::Version');
  });
  it('returns undefined for a file under no autoload root', () => {
    expect(fileToConstant('config/routes.rb', roots)).toBeUndefined();
    expect(fileToConstant('db/migrate/001_x.rb', roots)).toBeUndefined();
  });
});

describe('buildConstantIndex + resolveConstant', () => {
  const files = [
    'app/models/user.rb',
    'app/models/payment/charge.rb',
    'app/models/admin/report.rb',
    'app/controllers/admin/reports_controller.rb',
    'app/controllers/application_controller.rb',
    'app/models/concerns/trackable.rb',
  ];
  const { index } = buildConstantIndex(files);

  it('indexes each file by its Zeitwerk constant', () => {
    expect(index.get('User')).toBe('app/models/user.rb');
    expect(index.get('Payment::Charge')).toBe('app/models/payment/charge.rb');
    expect(index.get('Admin::ReportsController')).toBe('app/controllers/admin/reports_controller.rb');
    expect(index.get('Trackable')).toBe('app/models/concerns/trackable.rb');
  });

  it('resolves a top-level reference', () => {
    expect(resolveConstant('User', [], index)).toBe('app/models/user.rb');
    expect(resolveConstant('ApplicationController', [], index)).toBe(
      'app/controllers/application_controller.rb',
    );
  });

  it('resolves a qualified reference by longest prefix; misses stay undefined', () => {
    expect(resolveConstant('Payment::Charge', [], index)).toBe('app/models/payment/charge.rb');
    expect(resolveConstant('Nonexistent', [], index)).toBeUndefined();
  });

  it('resolves an unqualified reference against lexical nesting', () => {
    // `Report` inside `module Admin` resolves to Admin::Report...
    expect(resolveConstant('Report', ['Admin'], index)).toBe('app/models/admin/report.rb');
    // ...but with no nesting there is no top-level Report, so it misses.
    expect(resolveConstant('Report', [], index)).toBeUndefined();
  });
});

describe('joinRelative', () => {
  it('resolves . and .. against the requiring dir', () => {
    expect(joinRelative('app/services', '../models/user')).toBe('app/models/user');
    expect(joinRelative('lib/foo', './bar')).toBe('lib/foo/bar');
    expect(joinRelative('', 'top')).toBe('top');
  });
});
