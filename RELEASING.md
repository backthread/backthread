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
