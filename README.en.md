# DSH Desktop Launcher

[中文](README.md) | **English**

A tray launcher and process supervisor for the **local `dsh web` server** of
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It exists to remove one thing: remembering and typing `dsh web`. The tray icon
opens DeepSeek Harness in its own window, keeps the server alive, and shows what
is actually going on when it is not.

Scope is deliberately narrow. This is a self-use tool that manages one `dsh web`
instance on this machine. It is **not** a replacement for, a wrapper around, or
a competitor to the official Electron desktop application that ships in
`deepseek-harness/apps/desktop`; the two are unaware of each other.

---

## What it does

| | |
|---|---|
| **Tray** | Left-click opens or focuses the DSH window. Right-click opens the menu. The menu and status copy are Chinese. |
| **Own window** | The DSH UI runs on a private session partition. Your browser is never touched: no tabs, no history, no shared cookies. |
| **Opens on launch** | Double-clicking the launcher opens the window immediately. A launch from the login item only installs the tray and stays hidden, so signing in does not throw a window in your face. |
| **Adopts or starts** | If something already serves the configured port it is reused as-is. Otherwise the launcher starts `dsh web` itself. |
| **Restart on demand** | Only the tray menu's *Restart service* stops anything, and it asks first. |
| **Diagnostics** | An on-demand window with server state, resolved paths, the captured output, and a copy-URL button. |
| **Update check** | Manual only. Reads every published version and offers the highest one. |

Launcher-owned surfaces (loading page, diagnostics, error pages, window
background) use `#1f1d19` on `#f2efe9`, and the native caption is tinted to
match through `titleBarStyle: 'hidden'` plus `titleBarOverlay`. The DSH UI
themes itself and is deliberately left alone — the goal is only that the frame
around it stops looking bolted on.

Two consequences of a hidden title bar, both easy to get wrong:

- **The native drag area goes with it.** The window cannot be moved unless the
  page provides one, so a transparent 32px strip is injected at the top with the
  maximum z-index. It must be injected per document, because a navigation starts
  without it.
- **The overlay is click-through.** A drag region does not swallow mouse events
  in Electron, so the strip does not make the UI beneath it unclickable.

How an autostart launch is recognised: the login item is registered with an
`--autostart` argument and only that flag is consulted. Two other approaches
were tried and are documented in `launchedAtLogin()` — matching the Run value
name fails because Electron writes it as `electron.app.Electron`, and matching
the command line against `process.execPath` fails because the launcher ships in
two folders and the Run entry points at whichever copy was toggled last.
`scripts/verify-launch-modes.ps1` checks both behaviours end to end.

## Requirements

The recipient needs exactly two things, both one-time:

1. **Node.js** — the launcher runs `dsh` under the system Node, so Node must be
   on `PATH` or at its standard install location.
2. **`@deepseek-ai/dsh` installed globally** — `npm install -g @deepseek-ai/dsh`

That is the whole list. Verified against a scratch `DSH_HOME`: a machine with
only the global CLI boots the web profile from scratch, creating
`profiles/web/{package.json,cordis.yml,cordis.patch.yml,pnpm-workspace.yaml}`
and composing its config with no pre-existing `profiles/node_modules`.

**pnpm is not required**, and the ~451MB profile dependency tree is not required
for the base profile, because in-box bundles resolve from the dsh installation
itself: `resolveBundleDir` probes the installation anchor before the profile
directory. pnpm and that tree matter only once you install extra plugins with
`dsh plugin`.

Credentials are never carried by the launcher. Each user brings their own
DEEPSEEK API key; never copy your `~/.dsh/.credentials.yaml` to anyone.

## Run from source

```sh
npm install
npm start
```

The launcher lives in the tray. There is no main window until you open one.

## Sharing with someone else

Double-click **`打包.bat`**, or from a shell:

```powershell
npm run release        # npm run dist then npm run share
```

Either way you get two equivalent things — send whichever you prefer:

| | |
|---|---|
| `DSH-Launcher\` | the folder; right-click → compress it yourself if you like |
| `DSH-Launcher.zip` | ~147MB built from the ~368MB folder |

Both have exactly three entries at their root: `win-unpacked\`, `setup.bat`,
`安装说明.md`. Packaging refuses to ship if the archive gains an extra nesting
level, is missing any of the three, or if `setup.bat` loses its CRLF line
endings or gains a non-ASCII byte.

Two directories, two jobs — deliberately separate:

```
build\           raw electron-builder output; wiped by npm run dist, never shipped
DSH-Launcher\    the deliverable; rebuilt from build\ + share\ on every run
```

`setup.bat` cannot live in `build\`: `npm run dist` empties that directory, so
anything placed there is deleted on the next build.

The recipient extracts, runs `setup.bat` once, double-clicks
`win-unpacked\DSH Launcher.exe`, and left-clicks the tray icon. `setup.bat`
installs Node.js (via winget) and `@deepseek-ai/dsh` when missing, verifies
`dsh --version`, and prints the exact exe path. Re-running it is safe.

Two things to warn them about, both in `安装说明.md`:

- **SmartScreen.** The build is unsigned, so Windows shows "Windows protected
  your PC"; they need *More info* → *Run anyway*.
- **Mark-of-the-Web.** Files delivered over the internet carry a zone marker.
  `Get-ChildItem -Recurse | Unblock-File` in the extracted folder clears it.

Do **not** share `~/.dsh/.credentials.yaml` or `~/.dsh`: those carry the API key
reference and the machine's session signing secret. The build output itself is
clean — it contains no credentials and no machine-specific paths.

For recipients who have never set up dsh, the
[official desktop application](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)
is the better recommendation: it bundles Node, pnpm, and Python, ships a signed
installer, and needs no `npm install -g` at all. This launcher is the lighter
option for people who already run the dsh CLI and just want a tray icon.

### Why setup.bat must keep CRLF line endings

`cmd.exe` mis-parses a `.bat` that uses bare LF: the `REM` header block gets
executed as commands and the console fills with
`'Launcher' is not recognized as an internal or external command`. Any tool or
editor that rewrites `share/setup.bat` with LF reintroduces this. The packaging
script repairs and verifies the line endings on every run, so the shipped copy
is always correct. `.gitattributes` pins the shipped scripts to CRLF in the
repository as well, so a fresh clone arrives with them intact.

## Integrations

```sh
npm run dist        # unpacked directory build in build/ (no installer, unsigned)
```

Three environment traps apply on a mirror-only network:

- **Electron's binary** comes from GitHub releases by default and stalls there.
  `.npmrc` pins the npmmirror mirror so a plain `npm install` works.
- **electron-builder's helper archives** also come from GitHub. Set
  `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
  when building.
- **The `winCodeSign` helper cannot be extracted without symlink privilege.**
  That archive contains macOS `.dylib` symlinks, and extracting it fails with
  "a required privilege is not held by the client" unless the account is an
  administrator or Developer Mode is on. A `--dir` build needs no signing, so
  `win.signAndEditExecutable` is `false`, which avoids the download entirely.
  Turn it back on only when you actually sign.

### The .exe icon is embedded as a separate build step

Disabling `signAndEditExecutable` avoids `winCodeSign`, but it also skips
rcedit — so the packaged `DSH Launcher.exe` would keep **Electron's default
icon** in the taskbar, Alt-Tab, and Explorer. `npm run dist` therefore runs
`scripts/embed-exe-icon.ps1` afterwards, which rewrites the icon resources
through the Win32 API (`BeginUpdateResource`/`UpdateResource`) instead of
rcedit. It touches only `RT_ICON` and `RT_GROUP_ICON`, leaves version info and
the manifest alone, and needs no administrator rights.

Two traps cost real time here, both worth knowing before editing that script:

1. **`UpdateResource` overwrites by id and never prunes.** Writing ids 1..n on a
   file that already carries icons leaves stale `RT_ICON` entries in place, so
   from the second run onward a group declaring "id 2 is 64x64" reads whatever
   the earlier pass left at id 2. On disk the group looks perfect. Windows
   rejects the mismatched set and **falls back to the previously cached icon** —
   which is why the .exe kept showing Electron's icon even though the resource
   directory listed the right sizes.
2. **Deleting and re-adding in one update handle does not work.** Deleting every
   icon resource leaves the group structures pointing at removed members, and
   the follow-up write did not land: the file ended up with groups whose members
   read back as garbage.

The working strategy is to allocate a **fresh id range above the highest
existing one** and overwrite only the two group ids, whose count is fixed.
Nothing stale is reused and no deletion is needed for the bitmaps.

Verification has to compare **payload bytes per member**, not just sizes in the
group directory — the directory is exactly what looks correct in trap 1. The
script now resolves every member id to its `RT_ICON` payload and compares the
length against the declared length.

`scripts/dump-exe-icons.ps1 -Executable <path> [-OutFile icon.png]` is the
independent check: it re-reads every group and member from the finished
executable and can export the largest one as a PNG to confirm the artwork.

### Icons

`dsh-ico.ico` at the project root is the single source of truth. The tray, the
taskbar, the window, and the packaged `.exe` all render that one image.

`npm run make-icons` reads it and writes:

- `assets/icon.ico` — seven sizes (16/24/32/48/64/128/256)
- `assets/icon.png` — 256x256, the tray image on platforms that cannot read .ico

The seven sizes are not cosmetic. Windows picks per context — 16 in the tray and
title bar, 32 in the taskbar, 48/256 in Explorer — and an .ico carrying a single
entry gets downscaled by the shell, which looks soft exactly where it is most
visible.

**Known limitation: the source is 96x96.** Its DIB header declares 96x96 (the
doubled 192 height covers the AND mask), so 128 and 256 are interpolated and
cannot be sharper than the source. Everything at or below 96 — which covers the
tray and the taskbar, the two places it is actually seen — is a clean downscale.
Replacing `dsh-ico.ico` with a >=256px version of the same artwork would make
the large sizes sharp with no other change; `make-icons` prints a note listing
which sizes were upscaled.

`npm run preview-icons` writes `preview-icons.png`: every size side by side at
1:1, for judging legibility rather than trusting the resize.

Note that `scripts/set-exe-icon.ps1` groups the sizes as Windows expects:
16/32/48/256 go into `RT_GROUP_ICON` 2 (the "small icon" resource) and the rest
into group 1. A single group would still render, but Explorer and Alt-Tab would
pick the wrong entry.

## Self-test

Clicking a tray icon cannot be automated, but the parts most likely to break
can be checked headlessly:

```sh
# Windows
set DSH_LAUNCHER_SELF_TEST=1
npm run self-test

# POSIX
DSH_LAUNCHER_SELF_TEST=1 npm run self-test
```

It asserts 25 properties: node and dsh resolution, that a self-test run is not
mistaken for an autostart launch, server adoption **or** a launcher-started
server, that the unauthenticated root request is fenced with 401, that a
browser-session cookie can be minted and lands in the window session, that the
cookie authenticates over HTTP with 200, that the child process and its port are
released, that stop is idempotent, that the tray icon loads, that closing the
window hides rather than destroys it, that the injected drag region is present
and declares a drag region, that the renderer assets exist, and that the
diagnostics page actually renders content. Exit code is non-zero if any step
fails.

Point it at a scratch port with `DSH_LAUNCHER_SELF_TEST_PORT=3081` so a normal
instance is left alone. This also works against the packaged build:

```sh
"build/win-unpacked/DSH Launcher.exe"
```

`scripts/verify-launch-modes.ps1` covers what the self-test cannot: it drives
the real executable twice, enumerating visible top-level windows to confirm that
a manual launch opens a window and an autostart launch (`--autostart`) installs
only the tray.

---

## How authentication works

This is the least obvious part of the design, and the reason the launcher can
adopt a server it did not start.

A local `dsh web` server uses **two independent keys**:

| Key | Lives in | Lifetime | Role |
|---|---|---|---|
| Process launch token | Process memory only | Regenerated on every start | The `?token=` in the URL `dsh web` prints. Verified once, for the first `GET /`. |
| Browser-session secret | `~/.dsh/.credentials.yaml`, record `client-connection/browser-session` | **Persistent** | Signs the `HttpOnly` `dsh-auth-<authority>` cookie that authenticates every later request. |

The first request carrying a valid launch token is answered with a redirect and
a `Set-Cookie` signed by the **persistent** secret. From then on the cookie is
the only credential. Because that secret outlives the process, a launcher that
owns its own Electron session can mint an equivalent cookie directly and load
the bare URL — no stdout scraping, no launch token, and no restart of a server
it does not own.

The cookie payload carries only the authority and issue/expiry timestamps, never
the launch token, so a minted cookie survives a server restart.

Two consequences worth knowing:

- **The format is an internal detail.** It is mirrored from
  `@deepseek-ai/dsh-client-connection`, not a public API. If DSH changes it, the
  launcher fails loudly: the window shows an explicit authentication error and
  the supervisor keeps the URL printed on stdout as a fallback.
- **The secret is a credential.** Reading it is equivalent to holding a login
  for `127.0.0.1:3080` on this machine. It is read in memory only, never logged,
  and never sent over IPC. Captured output is filtered so a `?token=` value can
  never reach the diagnostics window or a log file.

## Hard constraints

These are not preferences; breaking any of them produces a broken launcher.

1. **`dsh` must run under the system Node, never under Electron's bundled Node.**
   `$DSH_HOME/profiles/node_modules` contains native modules (`node-pty`,
   `sharp`, `koffi`) built for the system Node's ABI. Electron is only the shell,
   tray, and window owner. The resolved Node path is cached in the launcher
   config so a later PATH change cannot silently switch runtimes.

2. **The launcher never writes to `~/.dsh` configuration.** DSH hot-reloads
   `settings.yaml` and `profiles/web/cordis.patch.yml` through a watcher; a
   second writer would fight the running server. Launcher settings live in
   Electron's `userData`.

3. **The launcher never touches `profiles/desktop`** and never boots
   `--profile desktop`. That profile belongs to the official desktop
   application, and the CLI refuses it too.

## Update channel

Version selection deliberately ignores npm dist-tags. On this product `latest`
lags the release-candidate line — at the time of writing `latest` is
`0.1.5-rc.3` while the newest published version is `0.1.7-rc.2` — so anything
tag-driven either stalls or silently downgrades a user. The updater reads the
full version list and picks the highest semver, prereleases included, skipping
the four-field test builds that the desktop packaging pipeline emits.

Installing is never automatic. The confirm dialog states the three costs: the
service stops first (interrupting running agent tasks), a global install fails
on Windows while dsh is running, and the profile dependency tree may be
reinstalled on the next start.

## Layout

```
src/
  main.js       tray, single-instance guard, window choreography, IPC, self-test
  dsh.js        node/dsh resolution, port probe, spawn, stdout parsing, tree kill
  auth.js       session-secret read, cookie minting, session injection
  config.js     launcher settings under userData
  updater.js    version discovery, semver selection, global install
  preload.js    narrow renderer bridge
renderer/
  loading.html      shown while the server boots
  diagnostics.html  status, paths, captured output, actions
scripts/
  make-icons.js           regenerates assets/ from dsh-ico.ico
  preview-icons.js        side-by-side size sheet for judging legibility
  set-exe-icon.ps1        writes icon resources into the built .exe
  embed-exe-icon.ps1      build-hook wrapper; fails loudly if the target is absent
  dump-exe-icons.ps1      independent read-back of a built .exe's icons
  verify-launch-modes.ps1 checks manual vs autostart launch behaviour
share/
  setup.bat               one-time recipient setup; ASCII-only, must stay CRLF
  打包分享包.ps1            assembles DSH-Launcher\ and verifies the zip
  安装说明.md              Chinese install guide shipped to the recipient
打包.bat                  double-click: rebuild + package in one step
assets/
  icon.ico          7 sizes, generated — Windows tray, window, and .exe icon
  icon.png          256x256, generated — tray on other platforms, mac/linux build
dsh-ico.ico         tracked 96x96 source artwork, the single icon source
README.md           Chinese readme (the default)
README.en.md        this file
```

Generated, never edited by hand, safe to delete and rebuild: `build\` (from
`npm run dist`), `DSH-Launcher\` and `DSH-Launcher.zip` (from `npm run share`).

## Verified

Both supervisor paths are covered by the self-test, and the results below were
observed on Windows against both the source tree and the packaged build:

- **Adopt** — an existing listener on 3080 is reused, authenticated, and left
  running untouched, including against the packaged `DSH Launcher.exe`.
- **Cold start** — the launcher starts `dsh web` on a free port, authenticates,
  then stops it with the child process gone and the port released.

The packaged build passes all 25 self-test assertions, and
`scripts/verify-launch-modes.ps1` reports one visible window for a manual launch
and none for an autostart launch.

Not automated, so verify by hand after changing window or tray code: the tray
menu actions themselves, launch-at-login toggling, and the update flow.

## Known gaps

- macOS and Linux are best-effort. Windows is the supported target; on Linux
  the tray needs an AppIndicator host (GNOME requires an extension), and on
  macOS launch-at-login uses login items rather than the Windows registry.
- The official desktop application's tray-less window focus cannot be reused;
  this launcher always opens its own window.
- The launcher does not manage the profile dependency tree. After a dsh update
  that changes profile requirements, the next start may be slow or may need
  `dsh plugin` maintenance.
- The login item records whichever copy is running. Enabling autostart while
  launching from `build\` or `DSH-Launcher\` therefore records a path that the
  next build wipes. Use a stable folder for autostart.
