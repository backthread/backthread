// PHP "standard library" drop list — the analogue of python-stdlib.ts /
// ruby-stdlib.ts. Two kinds of name never earn a dependency node:
//
//   * Composer PLATFORM packages — `php` itself, the `ext-*` PHP extensions
//     (ext-json, ext-mbstring, …), and the `lib-*` bundled-library constraints.
//     A `composer.json` `require` lists these to pin a runtime, not a package;
//     they are dropped from the dep set the framework adapters test membership on.
//   * SINGLE-SEGMENT global classes/interfaces — `Exception`, `DateTime`,
//     `Throwable`, `PDO`, … live in PHP's global namespace, so a `use Exception;`
//     (or an unqualified reference) points at the language runtime, not a
//     first-party or vendor package. The extractor computes an external node id
//     from the TOP namespace segment (`phpExternalIdFor`); a single-segment FQN
//     whose one segment is a known global would otherwise mint a noise
//     `ext:Exception` box, so it's dropped. Namespaced vendors (`Symfony\…`,
//     `Doctrine\…`) always have a multi-segment FQN and are never touched here.
//
// Membership is checked case-INSENSITIVELY (PHP class names are case-insensitive)
// against the lowercased name.

/** Lowercased single-segment global class/interface/enum names to drop. */
export const PHP_GLOBALS = new Set<string>([
  // Core exceptions / errors (SPL + engine).
  'exception', 'errorexception', 'error', 'typeerror', 'valueerror', 'argumentcounterror',
  'arithmeticerror', 'divisionbyzeroerror', 'throwable', 'unhandledmatcherror', 'assertionerror',
  'logicexception', 'runtimeexception', 'invalidargumentexception', 'outofrangeexception',
  'outofboundsexception', 'lengthexception', 'domainexception', 'rangeexception',
  'overflowexception', 'underflowexception', 'unexpectedvalueexception', 'badfunctioncallexception',
  'badmethodcallexception', 'jsonexception',
  // Date / time.
  'datetime', 'datetimeimmutable', 'datetimeinterface', 'dateinterval', 'datetimezone',
  'dateperiod', 'dateerror', 'dateexception',
  // Core interfaces.
  'traversable', 'iterator', 'iteratoraggregate', 'arrayaccess', 'countable', 'stringable',
  'jsonserializable', 'serializable', 'unitenum', 'backedenum',
  // SPL data structures + iterators.
  'arrayobject', 'arrayiterator', 'splstack', 'splqueue', 'spldoublylinkedlist',
  'splpriorityqueue', 'splheap', 'splminheap', 'splmaxheap', 'splfixedarray',
  'splobjectstorage', 'splfileinfo', 'splfileobject', 'spltempfileobject',
  'appenditerator', 'arrayiterator', 'cachingiterator', 'callbackfilteriterator',
  'filteriterator', 'infiniteiterator', 'iteratoriterator', 'limititerator',
  'norewinditerator', 'recursivearrayiterator', 'recursivecachingiterator',
  'recursivedirectoryiterator', 'recursiveiteratoriterator', 'directoryiterator',
  'globiterator', 'multipleiterator',
  // Misc engine / runtime globals.
  'stdclass', 'closure', 'generator', 'weakmap', 'weakreference', 'fiber',
  'reflectionclass', 'reflectionmethod', 'reflectionfunction', 'reflectionproperty',
  'reflectionparameter', 'reflectionnamedtype', 'reflectionobject', 'reflectionenum',
  'reflectionattribute', 'reflectionexception', 'reflector', 'attribute',
  'pdo', 'pdostatement', 'pdoexception', 'mysqli', 'sqlite3',
  'curlhandle', 'curlmultihandle', 'gdimage',
]);

/**
 * A composer PLATFORM package — the PHP runtime itself, a PHP extension
 * (`ext-json`), or a bundled library (`lib-icu`). These pin a runtime, not a
 * dependency package, so they're dropped from the manifest dep set.
 */
export function isPlatformPackage(name: string): boolean {
  const n = name.toLowerCase();
  return n === 'php' || n.startsWith('ext-') || n.startsWith('lib-');
}
