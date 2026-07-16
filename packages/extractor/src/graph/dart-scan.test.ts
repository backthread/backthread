// The hand-rolled Dart directive scanner: import/export/part/part-of/library
// directives, conditional-import default-URI selection, and comment/multiline-string
// awareness (a commented-out or doc-embedded `import` never registers).

import { describe, it, expect } from '../testkit.js';
import { scanDartDirectives, sourceLines } from './dart-scan.js';

describe('scanDartDirectives', () => {
  it('reads import / export / part / library directives', () => {
    const d = scanDartDirectives(
      [
        "library my_app.widgets;",
        "import 'package:flutter/material.dart';",
        "import 'dart:async';",
        "import '../models/user.dart';",
        "import './helpers.dart' as h;",
        "export 'src/api.dart' show Api;",
        "part 'widget.g.dart';",
      ].join('\n'),
    );
    expect(d.library).toBe('my_app.widgets');
    expect(d.imports).toEqual([
      'package:flutter/material.dart',
      'dart:async',
      '../models/user.dart',
      './helpers.dart',
    ]);
    expect(d.exports).toEqual(['src/api.dart']);
    expect(d.parts).toEqual(['widget.g.dart']);
    expect(d.partOf).toBeUndefined();
  });

  it('takes only the DEFAULT uri of a conditional import', () => {
    const d = scanDartDirectives(
      "import 'stub.dart' if (dart.library.io) 'io.dart' if (dart.library.html) 'web.dart';",
    );
    expect(d.imports).toEqual(['stub.dart']);
  });

  it('reads a `part of` in both the URI form and the library-name form', () => {
    expect(scanDartDirectives("part of 'parent.dart';").partOf).toEqual({ uri: 'parent.dart' });
    expect(scanDartDirectives('part of my.lib.name;').partOf).toEqual({ name: 'my.lib.name' });
  });

  it('ignores directives inside line / block comments and doc strings', () => {
    const d = scanDartDirectives(
      [
        "// import 'commented_out.dart';",
        "/// import 'doc_comment.dart';",
        '/*',
        "import 'block_commented.dart';",
        '*/',
        "const banner = '''",
        "import 'inside_multiline_string.dart';",
        "''';",
        "import 'real.dart';",
      ].join('\n'),
    );
    expect(d.imports).toEqual(['real.dart']);
  });

  it('is not fooled by a directive keyword mid-expression', () => {
    const d = scanDartDirectives("final importantValue = computeImport('x');");
    expect(d.imports).toEqual([]);
  });

  it('preserves line indices through comment/string blanking', () => {
    const lines = sourceLines("a\n/* b\nc */\nd");
    expect(lines.length).toBe(4);
    expect(lines[3]).toBe('d');
  });
});
