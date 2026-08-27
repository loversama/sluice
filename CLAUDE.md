# Sluice

A browserless Twitch drop miner. Two distributions from one build: a container, and a
Windows desktop app that wraps the same daemon and dashboard.

## Cutting a release

Releases are built by `.github/workflows/build-desktop.yml`, triggered by pushing a version
tag. The installer and `latest.yml` are published to **`loversama/sluice-releases`** — a
separate public repository, so people can download builds without the private source. The
desktop app updates itself from there.

Four things have to line up, and the release fails if any of them does not:

1. **The tag must be on `master`.** The workflow refuses tags that are not, so a release can
   never be built from unreviewed code.
2. **The version must match the tag.** `package.json`, `packages/desktop/package.json` and
   `packages/core/src/version.ts` all carry it, and the workflow checks. A tag of `v0.4.1`
   needs `0.4.1` in all three.
3. **The tag must be annotated.** Its message becomes the release notes; a lightweight tag
   produces a release with an empty body and a warning in the log.
4. **`RELEASES_TOKEN` must be set** on the `sluice` repo — a fine-grained token scoped to
   `sluice-releases` only, Contents: read and write. It is not the automatic `GITHUB_TOKEN`,
   which cannot reach another repository.

So a release is:

```bash
# 1. Bump all three version files to match the tag you are about to make.
# 2. Commit and push to master.
git tag -a v0.4.1 -m "Sluice 0.4.1

Added
- Game art on the campaign-complete notification.

Fixed
- Tray icon no longer falls back to Electron's default.
"
git push origin v0.4.1
```

Then watch it: `gh run list --repo loversama/sluice --limit 1`.

### Writing the notes

The tag message is the release notes verbatim, so write it for someone deciding whether to
update — not for someone reading the diff. First line is the title. Then group under
`Added`, `Changed`, `Fixed`, `Removed`, omitting any that are empty.

Say what changed for the user and, where it is not obvious, why. "Claims no longer show a
countdown after the drop is claimed" is useful; "refactor NowMining state handling" is not.

### If a release goes wrong

Delete the tag both places and start again, rather than editing a published release:

```bash
git tag -d v0.4.1 && git push --delete origin v0.4.1
gh release delete v0.4.1 --repo loversama/sluice-releases --yes
gh api -X DELETE /repos/loversama/sluice-releases/git/refs/tags/v0.4.1
```

The tag is mirrored into the releases repo by the workflow, because GitHub will not publish
a release whose tag does not exist in the repository holding it.

## Testing that auto-update works

It takes two published releases: one to install from, one to update to. Install the older
installer, leave the app running, publish the newer version, and the banner should appear
within a couple of hours — or immediately via **Settings → Check now**.

`latest.yml` is what the updater reads. If it is missing from a release's assets, updating
silently does nothing, and the release looks fine from the outside.

## Verifying desktop changes

The Electron main process is **not type-checked**: it is not in the root `tsconfig`
references, and `electron-vite` transpiles without checking. `tsc -b` passing says nothing
about it. Until that is closed, main-process changes want running rather than reading:

```bash
timeout 40 xvfb-run -a node_modules/.bin/electron packages/desktop \
  --user-data-dir=/tmp/sluice-check
```

A clean start logs `Dashboard listening on …` and nothing else.
