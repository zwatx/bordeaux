# Desktop packaging

Bordeaux uses electron-builder. Packaging includes the compiled Electron main/preload code and the Vite-built `dist-renderer` application.

## Icons

- `build/Bordeaux.icon` is the editable Icon Composer source used for the macOS app bundle.
- `build/icon.svg` is the platform-neutral composition rendered to `build/icon.png` for Windows.
- `build/icon.icns` is the flattened DMG and CI fallback.
- `build/icon-assets/wine-glass.svg` is the shared vector mark.
- `build/icon-assets/wine-glass-foreground.svg` frames that mark on the square Icon Composer canvas.

The mark uses a red-wine gradient and warm glass outline against Bordeaux's graphite tile. Keep the foreground and platform icons in sync when revising it. Validate the Icon Composer source with:

```sh
/Applications/Icon\ Composer.app/Contents/Executables/ictool build/Bordeaux.icon \
  --export-preview macOS Light 1024 1024 1 build/icon-composer-preview.png
```

## Local builds

```sh
npm ci
npm run package:mac
```

This produces arm64 and x64 DMG/ZIP artifacts in `release/`. The local macOS packages are intentionally unsigned until a `Developer ID Application` identity and notarization credentials are configured.

`package:mac` requires Icon Composer (included with current Xcode releases) to compile `build/Bordeaux.icon`. CI uses `package:mac:ci` and the checked-in ICNS fallback when Icon Composer is unavailable.

Run `npm run package:win` on Windows to produce both an installable NSIS setup executable and a portable executable. Cross-building those targets from macOS requires Wine, so the repository's release workflows build Windows artifacts on a Windows runner instead.

The packaged updater loads `js-yaml` through its CommonJS entry. Keep `index.js` and `lib/`, and omit the unused browser/ESM bundles in `dist/`; package verification checks this layout and retains the 8 MiB archive limit. Set `BORDEAUX_SMOKE_EXECUTABLE` to the packaged executable when checking the actual packaged runtime with `npm run test:smoke:built`.

Do not advertise project file associations until main-process startup handles OS open-file events and command-line paths.

## Automatic update channels

Installed GitHub builds use the official public GitHub Releases API for `zwatx/bordeaux`, including asset downloads. The website Atom feed is not required. Release tags and manifest versions must agree, and only installer files listed with SHA-512 checksums in the matching platform manifest are downloaded. macOS uses ZIPs, Windows uses setup executables, and Linux uses AppImages. Full downloads are used because API asset URLs do not expose sibling differential blockmaps. The installed version fixes the update channel so testing builds cannot leak into production:

- `1.2.3-beta.4` follows `beta` manifests and accepts prereleases.
- `1.2.3` follows `latest` manifests, shown in the app as the production channel, and never accepts prereleases.

Version 0.2.0-beta.16 accepts only the former `Zw96042/bordeaux` asset URL namespace. After the GitHub owner rename to `zwatx`, those builds reject the canonical `beta-mac.yml` (or other platform manifest) URL as untrusted. Install the next fixed beta manually once from the official Releases page; an older installed updater cannot receive this fix through the rejected feed. The fixed provider accepts only the current official repository, retaining its manifest checksum and native-signature checks.

Beta clients may graduate to a newer stable release. Downgrades are never automatic. Bordeaux checks quietly shortly after launch and every six hours. A found update never opens a dialog over the editor: a toolbar chip shows **Update available**, download progress, **Restart to update**, or **Update failed**. The chip, **Settings → Software updates**, and **Check for updates…** open the shared update panel with release notes, download progress, cancellation, and retry; **Restart to update** installs directly. Closing the panel during a download leaves it running; canceling stops the transfer before another download can begin. After downloading and verifying an update, Bordeaux installs only when the user chooses **Restart and install**. Unsaved edits do not block installation, and closing the app no longer opens a save/discard prompt; save the project explicitly when those edits need to be kept. The install panel remains open while the native updater verifies and starts installation. If restart has not completed after one minute, the panel offers Close and manual installation from All releases; saving remains available, and another native install request is not started while the first is pending. Windows automatic updates use silent installation to retain the existing installation without reopening the setup wizard. The NSIS include also recognizes the updater’s `--updated` handoff from older clients, while manual first-time installs keep the setup wizard. Failed installation restores error recovery without shutting down background services, and reopens the editor window if the macOS handoff had already closed it. Services stop through the normal quit cleanup only after installation actually begins quitting the app. That cleanup is limited to eight seconds, so an aborted robot transfer or agent connection that never settles cannot keep Bordeaux running. After cleanup, quit resumes on the next event-loop turn so Electron has finished canceling the initial quit event. Native installers wait for the running app to exit (ShipIt on macOS, the NSIS setup on Windows); once the handoff starts, Bordeaux also exits on its own after fifteen seconds if anything else holds the quit. On Windows the setup launch can fail after quitting has begun; Bordeaux then abandons that quit, restarts the services cleanup stopped, reopens the editor, and allows **Retry install**. The NSIS setup may also close a still-running app on its own schedule, so the cleanup limit is an upper bound, not guaranteed time. `node scripts/verify-update-quit.mjs` exercises production window closure and cleanup using a controlled installer handoff; it does not verify native installer execution.

An installed macOS 0.2.0-beta.12 was observed unable to complete its own restart: ShipIt logged `Detected this as an install request` for each attempt and then waited indefinitely for the app to exit. Older clients run their own quit code, so install the next release manually once (DMG on macOS). Windows builds from the same period share that quit path and may need the same one-time setup install; this has not been verified on Windows. The new release cannot repair the older process before installation.

To verify a macOS update end to end without publishing, package two Developer ID–signed arm64 ZIPs with consecutive prerelease versions from a scratch copy whose feed points at a local generic server, install the older one outside `/Applications`, and confirm `~/Library/Caches/org.frc2468.bordeaux.ShipIt/ShipIt_stderr.log` shows `Beginning installation`, `Installation completed successfully`, and the relaunch. Launch with `ELECTRON_RUN_AS_NODE` unset; `open` passes the caller's environment to the app.

electron-builder writes a small platform manifest containing the version, installer URL, size, and SHA-512 digest. The release workflow recalculates that digest before publishing; electron-updater verifies it again while downloading and when reusing its cache. The update payload is the signed ZIP on macOS, the NSIS setup executable on Windows, and the matching-architecture AppImage on Linux.

Automatic updates are available from macOS installs, Windows NSIS setup installs, and writable Linux AppImages. Microsoft Store builds update through the Store. Windows portable executables require a manual replacement because running the NSIS updater would change them into an installed app.

## Beta prereleases

To publish a beta, first update and commit the exact prerelease version in `package.json` and `package-lock.json`, then push it to `main`:

```sh
npm version 0.2.0-beta.2 --no-git-tag-version
npm run verify:prerelease
git push origin main
gh workflow run prerelease.yml -f version=0.2.0-beta.2 -f notes="Beta notes"
```

The workflow runs only from `main` and fixes every checkout and the final tag to the dispatched commit. It reuses the newest `CI` push run on `main` for that exact SHA, waiting up to about 20 minutes for an active run. PR runs, other workflows, forks and different commits cannot satisfy this gate. A failed, canceled or timed-out main CI run blocks publication; rerun that CI successfully before retrying the beta. If no eligible main push run exists, the full reusable CI workflow runs instead.

Packaging runs alongside CI after branch, version and unused-tag validation. Publication requires successful static checks, all four unit shards, all three desktop UI groups and every platform package verification. It validates the public beta manifests and atomically creates the matching tag at the dispatched commit. Publication starts with a private draft and uploads assets one at a time. Every remote asset must match the local size and SHA-256 digest, including after an ambiguous upload failure; retries never overwrite an asset. The draft becomes a public prerelease only after the complete asset set passes verification. A failed publication leaves its draft available for diagnosis. Each version can be published once; increment the beta number for every attempt that creates its Git tag.

Dependency installation is shared through `.github/actions/install`: every job still runs `npm ci` from the lockfile. npm tarballs use setup-node's npm cache. Electron download archives use an exact OS/runner-architecture/locked-Electron-version key, with separate desktop and multi-architecture package caches; bumping only the Bordeaux beta version keeps these archives warm. Cold or evicted caches download normally; warm caches avoid repeat downloads but still install dependencies and check upstream Electron checksums. No `node_modules`, compiled application, signing credentials, notarization result or signed installer is reused across release runs. Already compressed installers upload without redundant Actions ZIP compression. Field certification uses the build already made in the same job; local build/package commands are unchanged.

## Production releases

Set and commit a stable version with no prerelease suffix, then create its matching tag:

```sh
npm version 0.2.0 --no-git-tag-version
npm run verify:release-tag
git push origin main
git tag v0.2.0
git push origin v0.2.0
```

The `Publish production release` workflow tests and packages every platform, emits and validates `latest` manifests, then creates the normal GitHub Release only after all platform jobs succeed. A production tag must exactly match the checked-in package version. The same immutable-version rule applies: do not replace artifacts under a published tag.

Configure these GitHub Actions repository secrets before the first run:

- macOS: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, and `WIN_SIGNER_SHA1` (the approved certificate's 40-digit SHA-1 thumbprint)

The macOS workflows sign DMGs explicitly, then submit and staple each image with `scripts/notarize-release-dmgs.mjs`. Stapling changes the image bytes, so the script regenerates DMG blockmaps and manifest hashes before verification. ZIPs retain the already notarized app and their original hashes.

The temporary macOS release runners block outbound UDP port 443 before packaging, following [GitHub's ticket-delivery workaround](https://github.com/actions/runner-images/issues/14924). This makes Apple's stapler fall back from HTTP/3 to HTTPS over TCP after repeated CloudKit connection-loss failures (error 68). It changes only the disposable runner's network rules; signing, notarization, stapling and Gatekeeper verification remain required. Remove the workaround when the upstream runner issue is resolved.

By default, both GitHub release workflows fail before packaging when either platform's signing configuration is absent. The beta workflow has an explicit `unsigned_windows` dispatch option for temporary unsigned Windows installers. This option bypasses only Windows signing and Authenticode checks, retains package and update-manifest verification, and labels the release notes. Production signing requirements are unchanged. After packaging, macOS jobs verify the Developer ID team, Gatekeeper assessment, and stapled notarization ticket on every DMG and the app inside every ZIP. Windows jobs verify that every setup and portable executable has a valid, timestamped Authenticode signature from `WIN_SIGNER_SHA1`. The workflows publish those checks, artifact SHA-256 hashes, and the verified updater manifest in `signature-evidence-*.json`; signed beta runs and production releases require signed Windows artifacts. Never publish replacement artifacts under an existing release version.

## Microsoft Store Windows builds

Windows has independent distribution formats:

- GitHub Releases provides the NSIS installer and portable executable. NSIS installs follow the beta or production GitHub channel selected by their version; portable builds update manually.
- Microsoft Store provides an AppX package that Microsoft signs after certification and updates through the Store. Store-installed builds do not contact GitHub for application updates.

After reserving Bordeaux in Partner Center, copy **Package/Identity/Name**, **Package/Identity/Publisher**, and **Publisher display name** from its Product identity page. Add them as GitHub Actions repository variables named `WINDOWS_STORE_IDENTITY_NAME`, `WINDOWS_STORE_PUBLISHER`, and `WINDOWS_STORE_PUBLISHER_DISPLAY_NAME`, then dispatch **Package Microsoft Store app** from `main`. The workflow uploads the unsigned AppX as a temporary Actions artifact for submission to Partner Center; do not offer that unsigned AppX as a direct download.

Store versions use `major.minor.patch.beta` for prereleases and `major.minor.patch.65535` for the stable release. Increase the beta number for every Store submission under the same semantic version.

## Local artifact hygiene

Installers are large and reproducible, but deleting the only local copy is rarely useful. Archive a completed `release/` directory to a uniquely named sibling outside the worktree:

```sh
archive="../bordeaux-release-$(date +%Y%m%d-%H%M%S)"
test -d ./release && test ! -e "$archive" && mv ./release "$archive"
```

The command stops if `release/` is missing or the destination already exists. Restore a specific archive only into an empty destination:

```sh
archive="../bordeaux-release-YYYYMMDD-HHMMSS"
test -d "$archive" && test ! -e ./release && mv "$archive" ./release
```

`dist/`, `dist-electron/`, and `node_modules/` are reproducible from the checked-in sources with `npm ci` and the build commands above. Keep them ignored; remove them only when rebuilding is acceptable.

Preview stale remote-tracking branches before pruning local references:

```sh
git remote prune origin --dry-run
git remote prune origin
```

This does not delete branches on the remote. Delete merged remote branches only through the repository's normal review workflow.

Do not remove `refs/t3/checkpoints/*` or `refs/codex/*` with raw Git commands. Those refs are recovery checkpoints owned by T3 Code and Codex; use the owning product's supported cleanup when one is available. `git gc` cannot reclaim objects retained by live checkpoint refs.
