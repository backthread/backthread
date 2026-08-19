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
      - run: npm install -g @backthread/ci
      - run: backthread-ci
```

That is the whole setup.

<details>
<summary>Why <code>npm install -g</code> rather than <code>npx</code></summary>

`npx @backthread/ci` looks like the obvious line and **does not work reliably**. Measured on npm 10.9.8, which is what `actions/setup-node` installs alongside Node 22:

| working directory | `npx --yes @backthread/ci` |
|---|---|
| has a `package.json` | works |
| has none — a Python, Ruby, Go or Rust repo | `sh: backthread-ci: command not found` |

npx derives the command name from the package spec, and with no local manifest to anchor its temp install it resolves the name without ever fetching the package. `--package=` and `-p … -c …` fail the same way. Since this client is explicitly for repositories that need not be Node projects at all, the form that only works for half of them is the wrong one to document.

`npm install -g` puts the binary on `PATH` and behaves identically everywhere. On a throwaway CI runner a global install costs nothing.
</details>

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

The tracked branch comes from your connected repository's settings; the ingress refuses any ref that is not it. Two environment variables are read beyond GitHub's own:

- **`BACKTHREAD_CLAIM`** — the one-time code that connects a repository that has never been added to the Backthread GitHub App. See below.
- **`BACKTHREAD_ENDPOINT`** — for testing against a non-production ingress.

## `BACKTHREAD_CLAIM` — connecting without the GitHub App

CI mode exists so nobody has to grant `contents: read`. Connecting through the GitHub App would grant it, so a repository can instead be connected by a code you paste into this workflow:

```yaml
      - run: backthread-ci
        env:
          BACKTHREAD_CLAIM: bt_4e6c971191c6393e96d98a53
```

**The code is not a credential, and treating it as one teaches the wrong thing.** Holding it lets you do nothing: using it also requires an OpenID Connect token minted inside the repository it names, which only that repository's own Actions can produce. It belongs in the workflow file, world-readable in a public repository by design — it does **not** belong in a repository secret.

It is consumed by the first successful run. Leave it in place afterwards if you like: once spent it names nothing, and a spent code is ignored rather than an error, so it will never fail a build.

Through `env:`, never interpolated into `run:`. A `${{ }}` expression is substituted as text before the shell parses the line, in a job that holds `id-token: write`.

**A repository connected this way has no GitHub App installation, so it gets no pull-request narration** — that needs `pull_requests: read`. The architecture and its history are complete; the recorded *why* behind each change is not. A thinner artefact, not a false one.

## Requirements

- **Node 22.18+** (GitHub's `ubuntu-latest` runner satisfies this).
- The repository must be **connected to Backthread and set to CI mode** — either through the GitHub App, or with a `BACKTHREAD_CLAIM` code as above. A payload from a repository that is neither is refused.
- **No special checkout depth.** The default shallow checkout is enough: the client reads only `HEAD`'s sha, date and subject, and the tracked-file list. It never walks history, and the extractor never shells out to git at all.

## Library use

The wire contract, its bounds and its validators are importable:

```ts
import { CI_PAYLOAD_VERSION, validateCiPayload, type CiSnapshotPayload } from '@backthread/ci';
```

Three further entry points exist because they carry Node or boundary concerns the main one deliberately does not: `@backthread/ci/env` (example-env-file scanning — touches `node:fs`), `@backthread/ci/untrusted` and `@backthread/ci/sanitize` (the untrusted-input boundary applied to anything repo-controlled before it reaches a model).

## License

MIT. See [LICENSE](./LICENSE).
