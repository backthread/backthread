# @backthread/extractor

Deterministic, install-free **structural extraction** for TypeScript and Python
codebases. Point it at a working tree and it returns a structural graph of the
system — modules, edges, communities, god-nodes, framework roles, and
infrastructure — with **zero LLM, database, or network**.

It's the open, auditable structural core behind [Backthread](https://backthread.dev).
The extraction is exact and offline, so the same tree always yields the same
graph; it never executes the analyzed repo's code.

## What it does

- **AST, install-free.** TypeScript via [ts-morph](https://ts-morph.com); Python
  via Pyright's static analyzer under a no-filesystem-access host (never runs a
  subprocess, never touches a virtualenv, never executes repo code). Import edges
  are the backbone; call edges resolve through inferred types.
- **Polyglot.** A TS-frontend + Python-backend repo extracts as one merged graph,
  with a coarse cross-language frontend→backend HTTP-API seam.
- **Communities + god-nodes.** Louvain community detection groups files into
  modules; a statistical-outlier rule flags over-connected "god" modules.
- **Framework-aware.** A fleet of adapters (Next, Nest, React Native, an ORM
  layer, and a Python fleet: FastAPI, Django, Flask, Litestar, Celery, SQLAlchemy,
  gRPC, GraphQL, and more) contributes synthetic edges, role tags, and grouping
  priors — deterministically, from parser output only.
- **Infra-aware.** Static readers for Cloudflare, Supabase, Terraform, and other
  config surface deployment topology (workers, queues, datastores, …) without a
  single API call.
- **Incremental.** A SHA-keyed file graph re-parses only changed files on
  re-extraction.

## Install

```sh
npm install @backthread/extractor
```

## Usage

```ts
import { extract } from '@backthread/extractor';

const result = await extract('/path/to/repo');

console.log(result.cluster.modules); // modules with kinds, god-node flags, subsystems
console.log(result.cluster.moduleEdges); // structural edges between modules
console.log(result.infra); // deployment topology from config
console.log(result.frameworks); // detected framework stacks
```

`extract()` is the one-shot convenience surface. Every stage is exported too, so
you can compose your own pipeline — run the incremental extractor, warm-start
clustering with a prior partition, or inject a resource-type classifier for
open-ended IaC:

```ts
import {
  extractGraph,
  clusterGraph,
  detectWorkspaceLayout,
  contributeFrameworkGraph,
  extractInfra,
} from '@backthread/extractor';

const graph = await extractGraph(repoDir);
const layout = detectWorkspaceLayout(repoDir);
const cluster = clusterGraph(graph, {}, { layout });
await contributeFrameworkGraph({ repoDir, graph, cluster });
const { graph: infra } = await extractInfra({ repoDir });
```

## Guarantees

- **No code execution.** Pure static analysis.
- **No network, no database, no LLM.** Extraction is fully offline and
  deterministic. (You may optionally inject a `classifyResourceTypes` callback to
  resolve unrecognized IaC resource types; without it, those keep a placeholder
  kind.)
- **Stable output.** Same tree + same options → same graph.

## License

MIT
