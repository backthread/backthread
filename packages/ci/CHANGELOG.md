# Changelog — `@backthread/ci`

## 0.2.0

**The wire contract gains an optional `claim`** — a one-time code that binds a repository to a Backthread account on the run that first connects it. It is *not* a credential: holding it lets you do nothing, because using it also requires an OIDC token minted inside the repository it names. It is meant to sit in a workflow file, world-readable in a public repository by design.

It carries the one fact the OIDC token cannot. The token proves **which repository** is calling; it says nothing about **which account** should own and be billed for it.

Nothing changes for existing users: the field is optional, and a payload without it validates exactly as before. Absent on every run after the first, and absent forever for a repository connected through the GitHub App.

⚠ **Order matters if you self-host an ingress.** The client and the validator ship in this same package, so a client sending `claim` to an ingress that has not been updated is refused with `unknown_field`. Deploy the ingress first.


## 0.1.2

**Fixes a defect that refused every real payload.** `counts.externals` was computed from the noise-filtered graph while the ingress recomputes it from the serialised state on the wire, so a genuine extract was refused with `count_mismatch (externals 14 != 15)` before it could upload.

If you are on **0.1.0 or 0.1.1, upgrade** — neither could complete an ingest of a repository whose extraction drops anything as noise, which in practice is all of them.

## 0.1.1

**Fixes the documented command.** The README said `npx --yes @backthread/ci`, which fails with `sh: backthread-ci: command not found` in any working directory without a `package.json` — that is, in exactly the Python, Ruby, Go and Rust repositories this client exists to serve. npx derives the command name from the package spec and needs a local manifest to anchor its temporary install; without one it resolves the name and never fetches the package.

The documented invocation is now:

```yaml
- run: npm install -g @backthread/ci
- run: backthread-ci
```

## 0.1.0

First release. The CI-extraction client, the wire contract it produces, and the acceptance gate the ingress applies — one definition of each, shared by the runner and the server so the two cannot drift.

Extract your repository's structure on your own runner and post it, with **no API key and no secret** — only the short-lived OIDC token GitHub mints for the job. Source never leaves the runner; see the README for the exact table of what does and does not cross the wire.

`src/` ships alongside `dist/` so the claim can be read rather than taken.
