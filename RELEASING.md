# Releasing `backthread`

Releases are automated by [`.github/workflows/release.yml`](.github/workflows/release.yml):
pushing a `v*` tag runs the tests, publishes `backthread` to npm via **OIDC trusted
publishing** (no token), and cuts a GitHub Release with auto-generated notes.
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the same checks on every PR.

## One-time setup (founder) — done

npm **Trusted Publisher** (OIDC), configured at npmjs.com → `backthread` → Settings →
Trusted Publisher. Nothing to rotate, no token, no 2FA OTP:

- Publisher: **GitHub Actions** · Org/user **backthread** · Repo **backthread**
- Workflow filename: **`release.yml`** · Environment name: **`release`**
- Allowed actions: **Allow `npm publish`**

The release job runs in the `release` GitHub environment (matching the publisher) and
exchanges its OIDC `id-token` for a short-lived npm credential at publish time. Add
protection rules to the `release` environment (Settings → Environments) if you want a
manual approval gate before a publish.

## Cutting a release

1. **Bump the version** with the helper — it does the two things that otherwise red CI
   (version lockstep + bundle sync):
   ```sh
   npm run bump -- <version>           # e.g. 0.3.2
   npm run bump -- patch|minor|major
   ```
   It updates the four version files the CI lockstep-checks (`cli/package.json`,
   `cli/.claude-plugin/plugin.json`, `extensions/gemini/gemini-extension.json`,
   `extensions/codex/plugins/backthread/plugin.json`) and rebuilds the committed
   `cli/dist-bundle/backthread.js` (the CC marketplace plugin ships this file with no
   build step on install, so CI fails if it's stale).
2. Commit, open a PR, let CI go green, merge.
3. **Tag + push:** `git tag v<version> && git push origin v<version>` — the tag MUST
   equal the version (the release job asserts it). The MCP server reports this version
   in its `serverInfo` (read from `package.json`).

The release job then: `npm test` → bundle-sync check → tag/version match →
`npm publish --provenance` (OIDC) → `gh release create --generate-notes`. Each release
carries an npm **publish attestation + SLSA provenance**.

> The CC plugin marketplace + the Gemini/Codex bundles install from this repo (git), so
> they pick up a release as soon as the tagged commit is on `main` — no separate
> marketplace submission step.
>
> **Manual fallback** (rarely needed — e.g. CI down): `cd cli && npm publish --otp=<code>`
> from an up-to-date `main` checkout (prompts for your 2FA OTP).

---

# Releasing `@backthread/extractor`

The deterministic structural extractor (`packages/extractor`) has its **own** release
path — [`.github/workflows/release-extractor.yml`](.github/workflows/release-extractor.yml).
It's consumed in three places (the hosted ingest container, the OSS CLI's optional
structure tier, and directly), so it ships as its own npm package on its own tag
namespace rather than riding the CLI release. Same OIDC trusted-publishing mechanism as
the CLI: pushing an `extractor-v*` tag runs the extractor's tests, asserts the tag
matches the version, and publishes `@backthread/extractor` with **provenance** — no
token, no OTP.

## One-time setup (founder) — TODO

Add a **second** npm Trusted Publisher, for the `@backthread/extractor` package (the CLI's
`release` publisher does not cover it). On npmjs.com → the `@backthread/extractor` package
→ Settings → Trusted Publisher (or the `backthread` org → Trusted Publishers), add a
GitHub Actions publisher:

- Publisher: **GitHub Actions** · Org/user **backthread** · Repo **backthread**
- Workflow filename: **`release-extractor.yml`** · Environment name: **`release-extractor`**
- Allowed actions: **Allow `npm publish`**

Until this is registered the workflow will run but the `npm publish` step fails auth — the
first real automated publish lands once the publisher exists and the first `extractor-v*`
tag is pushed. (`0.1.0` is already on npm from a manual publish; automation only matters
for the next version.)

## Cutting an extractor release

1. **Bump** `packages/extractor/package.json`'s `version` (a **single file** — the
   extractor is NOT part of the CLI's four-file version lockstep). Commit, open a PR, let
   CI go green, merge.
2. **Tag + push:** `git tag extractor-v<version> && git push origin extractor-v<version>`
   — the tag MUST equal the version (the release job asserts
   `extractor-v<version> == packages/extractor/package.json`).

The release job then: extractor typecheck + test → tag/version match →
`npm publish -w @backthread/extractor --provenance` (OIDC) →
`gh release create --generate-notes`.

> **⚠️ Cross-repo pin.** The OSS CLI depends on the extractor as an
> `optionalDependency` pinned to a caret range in `cli/package.json` (e.g. `^0.1.0`,
> which on npm's 0.x semantics floats only within `0.1.x`). After publishing an extractor
> **minor or major** (`0.2.0`, `1.0.0`, …), bump that pin in `cli/package.json` and cut a
> CLI release, or freshly-installed CLIs keep pulling the older extractor (the structure
> tier stays on the stale version rather than failing). Extractor **patches** within the
> current range are picked up automatically.
