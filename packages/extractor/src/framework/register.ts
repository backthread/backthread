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
