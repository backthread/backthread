// The shared Dart AST accessors: class-header decomposition (extends / with /
// implements / on / mixin-application), annotation names, top-level functions, and
// the type-expression helpers the FL2/FL3/FL4 adapters build on.

import { describe, it, expect } from '../../testkit.js';
import {
  classDeclarations,
  annotationNames,
  topLevelFunctionNames,
  baseTypeName,
  typeArgsOf,
} from './dart-ast.js';

describe('classDeclarations', () => {
  it('decomposes extends with generic type args', () => {
    const [c] = classDeclarations('class CounterCubit extends Cubit<int> {}');
    expect(c.name).toBe('CounterCubit');
    expect(c.superclass).toBe('Cubit');
    expect(c.superTypeArgs).toEqual(['int']);
  });

  it('decomposes extends + with + implements together', () => {
    const [c] = classDeclarations(
      'class Home extends StatefulWidget with WidgetsBindingObserver implements Foo, Bar {}',
    );
    expect(c.superclass).toBe('StatefulWidget');
    expect(c.mixins).toEqual(['WidgetsBindingObserver']);
    expect(c.interfaces).toEqual(['Foo', 'Bar']);
  });

  it('handles the State<T> pattern and multi-arg generics', () => {
    const [c] = classDeclarations('class _HomeState extends State<HomePage> {}');
    expect(c.superclass).toBe('State');
    expect(c.superTypeArgs).toEqual(['HomePage']);
    const [b] = classDeclarations('class WeatherBloc extends Bloc<WeatherEvent, WeatherState> {}');
    expect(b.superTypeArgs).toEqual(['WeatherEvent', 'WeatherState']);
  });

  it('handles the mixin-application form `class X = A with B`', () => {
    const [c] = classDeclarations('class AppState = _AppState with _$AppState;');
    expect(c.name).toBe('AppState');
    expect(c.superclass).toBe('_AppState');
    expect(c.mixins).toEqual(['_$AppState']);
  });

  it('handles abstract / modifier chains and multi-line headers', () => {
    const [c] = classDeclarations('abstract class Repo\n    extends BaseRepo\n    implements Closeable {}');
    expect(c.name).toBe('Repo');
    expect(c.superclass).toBe('BaseRepo');
    expect(c.interfaces).toEqual(['Closeable']);
  });

  it('captures mixin / enum / extension declarations', () => {
    expect(classDeclarations('mixin Logger on Service {}')[0]).toMatchObject({
      kind: 'mixin',
      name: 'Logger',
      on: ['Service'],
    });
    expect(classDeclarations('enum Status { active, done }')[0]).toMatchObject({
      kind: 'enum',
      name: 'Status',
    });
    expect(classDeclarations('extension StringX on String {}')[0]).toMatchObject({
      kind: 'extension',
      name: 'StringX',
    });
  });
});

describe('annotationNames / topLevelFunctionNames', () => {
  it('reads bare + dotted + parameterized annotation names', () => {
    const src = '@riverpod\n@Collection()\n@DriftDatabase(tables: [Todos])\n@foo.Bar\nclass X {}';
    expect(annotationNames(src)).toEqual(['riverpod', 'Collection', 'DriftDatabase', 'Bar']);
  });
  it('finds a top-level main()', () => {
    expect(topLevelFunctionNames('void main() {\n  runApp(MyApp());\n}')).toContain('main');
  });
  it('ignores indented (method) declarations', () => {
    expect(topLevelFunctionNames('class X {\n  void build() {}\n}')).not.toContain('build');
  });
});

describe('type-expression helpers', () => {
  it('extracts base names and top-level args', () => {
    expect(baseTypeName('Bloc<A, B>')).toBe('Bloc');
    expect(baseTypeName('prefix.Widget')).toBe('Widget');
    expect(typeArgsOf('Map<String, List<int>>')).toEqual(['String', 'List<int>']);
    expect(typeArgsOf('NoGenerics')).toEqual([]);
  });
});
