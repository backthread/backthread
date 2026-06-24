# Releasing `backthread`

Releases are automated by [`.github/workflows/release.yml`](.github/workflows/release.yml):
pushing a `v*` tag runs the tests, publishes `backthread` to npm, and cuts a GitHub
Release with auto-generated notes. [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
runs the same checks on every PR.

## One-time setup (founder)

Add an npm **automation** access token as the repo secret **`NPM_TOKEN`**
(Settings → Secrets and variables → Actions). An *automation* token bypasses the 2FA
OTP prompt, which is what lets CI publish unattended. Without it, the publish step
fails and you can fall back to a manual `npm publish` from `cli/` (which prompts for
an OTP).

## Cutting a release

1. **Bump the version in lockstep.** The CI tests fail unless these all match
   `cli/package.json`:
   - `cli/package.json`
   - `cli/.claude-plugin/plugin.json` (the CC plugin)
   - `extensions/gemini/gemini-extension.json`
   - `extensions/codex/plugins/backthread/plugin.json`
2. **Rebuild the committed bundle:** `npm run bundle -w backthread` (the CI fails if
   `cli/dist-bundle/backthread.js` isn't in sync — the CC marketplace plugin ships
   this committed file with no build step on install).
3. Commit + merge.
4. **Tag + push:** `git tag v<version> && git push origin v<version>` — the tag MUST
   equal the version (the release job asserts it). The MCP server reports this version
   in its `serverInfo` (read from `package.json`).

The release job then: `npm test` → bundle-sync check → tag/version match → `npm publish
--provenance` → `gh release create --generate-notes`.

> The CC plugin marketplace + the Gemini/Codex bundles install from this repo (git), so
> they pick up a release as soon as the tagged commit is on `main` — no separate
> marketplace submission step.
