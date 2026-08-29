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

The annotated tag's message becomes the release body verbatim, so it is written for someone
deciding whether to update — not for someone reading the diff.

Format:

```
Sluice 0.4.2

One line of context, only if the release needs it.

### Added
- **The thing**, then what it does for you.

### Changed
- **What changed**, and why it is different now.

### Fixed
- **What was broken**, described as the person experiencing it would.
```

Rules that matter:

- **Bullet points, always.** Prose paragraphs do not get read.
- **Bold the subject** of each bullet so the list can be skimmed.
- Omit any section with nothing in it. A release with only fixes has only `### Fixed`.
- Describe **behaviour, not implementation**. "The stream preview plays signed out, so it no
  longer stalls mining" — not "credentialless iframe".
- Where a change has a cost, **say so in the same breath**. The guest player means ads; the
  daily cap can overrun by half an hour. Users find these out anyway, and finding out from
  the notes is better than finding out from the app.
- **Never mention how the release was produced** — no tooling, no assistants, no session
  references. The notes are about the software.
- Group everything since the previous *published* release, not since the previous tag. A
  release that never shipped has no audience and its changes belong here.

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

**The name in `latest.yml` must match the uploaded asset exactly.** electron-builder writes
the installer to disk with spaces and records the URL-safe hyphenated name in `latest.yml`;
its own publisher uploads under the sanitised name, so the two agree. This repository
publishes with `gh` instead, which uploads the name on disk — and GitHub converts spaces to
dots. The updater then asks for `Sluice-Setup-X.Y.Z.exe`, GitHub has `Sluice.Setup.X.Y.Z.exe`,
and the download 404s. Both 0.4.1 and 0.4.2 shipped that way and could not update themselves.

Two things prevent it now: `artifactName` in `electron-builder.yml` removes the spaces at
source, and the publish step checks the `path:` in `latest.yml` against the release's asset
list, deleting the release if they disagree. Do not "simplify" either one away.

## Verifying desktop changes

`electron-vite` transpiles the main process without checking types, so `tsc -b` passing at
the root still says nothing about it. The package now has its own check, which CI runs:

```bash
npm --prefix packages/desktop run typecheck
```

That catches the class of bug that shipped twice — the updater crash on launch and the null
window listener were both plain type errors. It does not catch everything, so main-process
changes still want running:

```bash
timeout 40 xvfb-run -a node_modules/.bin/electron packages/desktop \
  --user-data-dir=/tmp/sluice-check
```

A clean start logs `Dashboard listening on …` and nothing else. Redirect to a file rather
than piping to `tail`: the run ends on SIGTERM, and a pipe loses the buffered output.

Kill the leftovers afterwards. Under WSL the `timeout` ends the launcher but not the
`electron.exe` children it started on the Windows side, and those keep a handle on
`node_modules/electron` — which makes the *next* `npm install` fail with `EACCES` on a
rename, an error that says nothing about why:

```bash
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { \$_.CommandLine -like '*twitch-drops-bot*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
```

Filter on the path. An installed Sluice runs as `Sluice.exe`, not `electron.exe`, so this
cannot reach a running copy of the app — but a bare `taskkill /im electron.exe` would take
out every other Electron application on the machine.

## Icons

Every icon is generated from `sluice.jpeg` at the repository root:

```bash
python3 scripts/make-icons.py
```

It produces the app icon, both tray marks and the dashboard favicon. Edit the source drawing
and re-run it rather than editing any of the outputs, which are all overwritten.

The tray mark is **white**, and stays white unless Windows positively reports a light
taskbar — read from the taskbar's own registry value, which is a different setting from the
one applications follow. A failed read, or any other platform, keeps it white. The purple
variant exists only so a light taskbar does not show white on white.

It also generates the NSIS wizard artwork. `installerSidebar.bmp` matters: without it the
uninstaller's welcome page falls back to `nsis3-metro.bmp`, a stock NSIS graphic.
