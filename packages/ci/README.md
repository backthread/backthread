# `@backthread/ci`

**Send Backthread your repository's structure from your own CI, without giving it clone access and without your source leaving the runner.**

Backthread's hosted ingest normally clones your repository into an ephemeral container. Some teams will not grant that, and reasonably so. CI mode inverts it: the extraction runs on **your** runner, inside a checkout you already have, and only the derived graph crosses the wire.

This package is both halves of that contract in one place — the client you run, and the **acceptance gate the ingress applies**. They are the same code, so what your runner produces and what the server accepts cannot drift apart.

```yaml
# .github/workflows/backthread.yml
name: Backthread
on:
  push:
    branches: [main]

jobs:
  snapshot:
    runs-on: ubuntu-latest
    permissions:
      contents: read   # actions/checkout
      id-token: write  # the OIDC token that identifies this repository
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # the extractor reads commit metadata
      - run: npx --yes @backthread/ci
```

That is the whole setup.

## There is no key to give it

There is **no API key to provision, no token to rotate, and nothing to put in your repository secrets.** The only credential this client touches is the short-lived OIDC ID token GitHub mints for the job — an assertion about *which repository is calling*, carrying no access to anything. `permissions: { id-token: write }` is what grants it.

`GITHUB_TOKEN` never leaves the runner. `actions/checkout` uses it; this client never reads it.

Unresolved infrastructure resource types ship as `classificationsNeeded` entries and are resolved **server-side** against a shared cache. Your runner does the parsing; the model and the credential stay on our side. That is why there is nothing to pay for and nothing to hold here.

## What crosses the wire, exactly

| Sent | Not sent |
|---|---|
| Per-file line counts, a language name, resolved import/call edge targets, package specifiers, a git blob sha | File contents, symbol names, identifiers, snippets |
| Workspace-defining manifests (`package.json`, `pyproject.toml`, …) **verbatim** | Any other file, at all |
| The **derived** deployment graph — nodes, edges, kinds | `wrangler.toml`, HCL, migrations, `.env*` files, or any config they were derived from |
| Service **names** inferred from an example env file (`stripe`, `redis`) | The env var keys those names came from, and never a value |
| Framework adapters' derived relations — file ids, verbs, role names | The source those relations were read from |
| The commit sha, its date and subject, and the repository name | |

Two of those rows are the reason the extraction has to happen on your side rather than ours: `.env.example` is a template of a credential file, and the framework adapters' only possible input is application code. Neither can cross, so the step that reads them moves to you and only its output travels.

`src/` ships in this package alongside the compiled output, on purpose. The claim above is one you should be able to check rather than take, and reading `src/action.ts` is a faster way to check it than reading this table.

## The acceptance gate is in here too

`src/validate.ts` is the code the ingress runs on every payload — every bound, every refusal, every reason string. It is published for the same reason [`@backthread/redact`](https://www.npmjs.com/package/@backthread/redact) and the [`backthread` CLI](https://www.npmjs.com/package/backthread) are: a claim about what we accept and store is worth less than a claim you can read.

Publishing changes what is *readable*, not what is *enforced* — the gate still runs server-side on every request, and a payload that fails it is refused there regardless of what any client does.

Running it before the POST is not belt-and-braces either. It is the same function, so the two cannot disagree, and a payload refused for shape *after* a full extract has already cost you CI minutes and told you nothing you could have learned earlier. When it refuses, the message names the ceiling you hit.

## There are no options

No branch input, no path filter, no include/exclude, no config file. Every knob here would be a knob to support, version and reason about on infrastructure we cannot see, and the absence of one is a deliberate guard against this turning into something you have to operate.

The tracked branch comes from your connected repository's settings; the ingress refuses any ref that is not it. The only environment variable this reads beyond GitHub's own is `BACKTHREAD_ENDPOINT`, which exists for testing against a non-production ingress.

## Requirements

- **Node 22.18+** (GitHub's `ubuntu-latest` runner satisfies this).
- The repository must already be **connected to Backthread and set to CI mode.** A payload from a repository that is not is refused; connecting is done in the app, not here.
- `fetch-depth: 0` on the checkout. A shallow clone has no commit metadata to read.

## Library use

The wire contract, its bounds and its validators are importable:

```ts
import { CI_PAYLOAD_VERSION, validateCiPayload, type CiSnapshotPayload } from '@backthread/ci';
```

Three further entry points exist because they carry Node or boundary concerns the main one deliberately does not: `@backthread/ci/env` (example-env-file scanning — touches `node:fs`), `@backthread/ci/untrusted` and `@backthread/ci/sanitize` (the untrusted-input boundary applied to anything repo-controlled before it reaches a model).

## License

MIT. See [LICENSE](./LICENSE).
