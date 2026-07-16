// builtin framework-adapter registration.
//
// Mirrors scripts/ingest/infra/register.ts: registration ORDER is the priority
// the later contribution-merge slices consume, and `registerFrameworkAdapter`
// is idempotent on name (replaces), so calling this more than once per process
// is safe (cli.ts + the hosted container both call it; tests re-register mocks).
//
// Slice 1 registered only the React Native / Expo adapter. Slice 2
// added Next / Nest / Node / ORM.  added the first Python adapter (FastAPI).
// ..1004 add the Python framework FLEET: Django/Flask/Litestar (web) +
// python-orm (data) + Celery/FastStream/orchestrator (async work / messaging /
// orchestration) + gRPC/GraphQL (API protocol). Every Python adapter gates on
// pyproject.toml / requirements*.txt, so none co-fire with the JS adapters on a
// single-language repo; on a polyglot repo a JS and one or more Python
// adapters can co-apply — the point.
//
// Registration order = priority when several adapters claim the same module. The
// Python fleet is ordered web → data → async → protocol, so a web framework's
// request-entry role/grouping takes precedence over an additive data/async/
// protocol adapter that co-fires on the same repo.

import { registerFrameworkAdapter } from './registry.js';
import {
  hasRubyManifest,
  hasMixManifestDeep,
  hasKotlinManifest,
  hasComposerManifest,
  hasDartManifestDeep,
  hasSwiftManifestDeep,
} from '../graph/language.js';
import { reactNativeAdapter } from './react-native/react-native.js';
import { nextAdapter } from './next/next.js';
import { nestAdapter } from './nest/nest.js';
import { nodeAdapter } from './node/node.js';
import { ormAdapter } from './orm/orm.js';
import { fastApiAdapter } from './fastapi/fastapi.js';
import { djangoAdapter } from './django/django.js';
import { flaskAdapter } from './flask/flask.js';
import { litestarAdapter } from './litestar/litestar.js';
import { pythonOrmAdapter } from './python-orm/python-orm.js';
import { celeryAdapter } from './celery/celery.js';
import { fastStreamAdapter } from './faststream/faststream.js';
import { orchestratorAdapter } from './orchestrator/orchestrator.js';
import { grpcAdapter } from './grpc/grpc.js';
import { graphqlAdapter } from './graphql/graphql.js';

export function registerBuiltinFrameworkAdapters(): void {
  // JS/TS adapters (/724/726/728/729).
  registerFrameworkAdapter(reactNativeAdapter);
  registerFrameworkAdapter(nextAdapter);
  registerFrameworkAdapter(nestAdapter);
  registerFrameworkAdapter(nodeAdapter);
  registerFrameworkAdapter(ormAdapter);

  // Python fleet — web frameworks first (request-entry priority).
  registerFrameworkAdapter(fastApiAdapter); // 
  registerFrameworkAdapter(djangoAdapter); // 
  registerFrameworkAdapter(flaskAdapter); // 
  registerFrameworkAdapter(litestarAdapter); // 
  // data.
  registerFrameworkAdapter(pythonOrmAdapter); // 
  // async work / messaging / orchestration.
  registerFrameworkAdapter(celeryAdapter); // 
  registerFrameworkAdapter(fastStreamAdapter); // 
  registerFrameworkAdapter(orchestratorAdapter); // 
  // API protocols.
  registerFrameworkAdapter(grpcAdapter); //
  registerFrameworkAdapter(graphqlAdapter); //
}

// Lazily loaded once per process. The Ruby fleet imports the Prism parser (a WASM
// module) via the shared Ruby AST layer, so — unlike the eager JS/Python builtins
// above — it must NOT module-load for a TS/Python repo. The Elixir fleet is gated
// the same way (its scanner is hand-rolled + dep-free, but the "zero cost when
// absent" promise still means a non-Elixir repo never loads its adapter modules).
// Each is dynamically imported here, and only when the repo declares that language,
// so a TS/Python ingest never pulls in either toolchain.
let rubyRegistered = false;
let elixirRegistered = false;
let kotlinRegistered = false;
let phpRegistered = false;
let dartRegistered = false;
let swiftRegistered = false;

/**
 * Register the framework adapters whose toolchain must NOT load for every repo.
 * Both pipeline steps (detect + contribute) call this before detection; it is
 * idempotent (once per process) and never throws. Gated per-language: Ruby on a
 * Ruby manifest (Gemfile / *.gemspec), Elixir on a mix.exs, PHP on a composer.json.
 * A future language registers behind the same gate.
 */
export async function registerLanguageScopedFrameworkAdapters(repoDir: string): Promise<void> {
  if (!rubyRegistered && hasRubyManifest(repoDir)) {
    rubyRegistered = true;
    const { registerRubyFrameworkAdapters } = await import('./register-ruby.js');
    registerRubyFrameworkAdapters();
  }
  // Nested-aware (hasMixManifestDeep, not root-only): a polyglot monorepo keeping its
  // Phoenix app under a top-level `elixir/` dir (`elixir/mix.exs`, or an umbrella's
  // `elixir/apps/web/mix.exs`) still loads the Elixir fleet. Root-Elixir repos
  // short-circuit on the cheap root check; the bounded walk only runs when the root
  // has no mix.exs. Zero cost when absent still holds — the adapter MODULES are
  // imported only when this predicate is true.
  if (!elixirRegistered && hasMixManifestDeep(repoDir)) {
    elixirRegistered = true;
    const { registerElixirFrameworkAdapters } = await import('./register-elixir.js');
    registerElixirFrameworkAdapters();
  }
  // Kotlin gates on a Gradle manifest (build.gradle(.kts) / settings.gradle(.kts) /
  // libs.versions.toml). The scanner is hand-rolled + dep-free, so this gate is purely
  // about not module-loading the Kotlin adapters for a non-Kotlin repo.
  if (!kotlinRegistered && hasKotlinManifest(repoDir)) {
    kotlinRegistered = true;
    const { registerKotlinFrameworkAdapters } = await import('./register-kotlin.js');
    registerKotlinFrameworkAdapters();
  }
  // PHP fleet — gated on a composer.json / composer.lock. Every PHP adapter's
  // analysis loads `php-parser` via the shared PHP AST layer, so the module is
  // imported ONLY here, only for a PHP repo; a TS/Python/Ruby/Elixir/Dart/Kotlin
  // ingest never module-loads php-parser (the isolation gate).
  if (!phpRegistered && hasComposerManifest(repoDir)) {
    phpRegistered = true;
    const { registerPhpFrameworkAdapters } = await import('./register-php.js');
    registerPhpFrameworkAdapters();
  }
  // Nested-aware (hasDartManifestDeep): a polyglot monorepo keeping its Flutter app
  // under a top-level `mobile/` / `app/` dir still loads the Dart fleet. Root-Dart
  // repos short-circuit on the cheap root check. The Dart toolchain is dep-free (a
  // hand-rolled scanner + the bundled `yaml` parser), so this gate is about not
  // module-loading the Dart adapters for a non-Dart repo, not about a native parser.
  if (!dartRegistered && hasDartManifestDeep(repoDir)) {
    dartRegistered = true;
    const { registerDartFrameworkAdapters } = await import('./register-dart.js');
    registerDartFrameworkAdapters();
  }
  // Nested-aware (hasSwiftManifestDeep): a polyglot monorepo keeping its iOS/Swift app
  // under a top-level `ios/` / `mobile/` / `apple/` dir (a nested Package.swift /
  // Podfile / *.xcodeproj) still loads the Swift fleet. Root-Swift repos short-circuit
  // on the cheap root check. The scanner is hand-rolled + dep-free, so this gate is
  // about not module-loading the Swift adapters for a non-Swift repo, not a native
  // parser. Mirrors the Elixir/Dart split — the graph-language SELECTOR stays root-only
  // (hasSwiftManifest), since a nested-Swift repo already extracts via dominant-count.
  if (!swiftRegistered && hasSwiftManifestDeep(repoDir)) {
    swiftRegistered = true;
    const { registerSwiftFrameworkAdapters } = await import('./register-swift.js');
    registerSwiftFrameworkAdapters();
  }
}
