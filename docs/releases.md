# Local builds & future releases

The client repository is [8tp/bunnyhop-client](https://github.com/8tp/bunnyhop-client). GitHub Actions is disabled and no workflow files are installed. There are no published releases or configured signing credentials. All current checks and builds run on your machine.

## Build locally

Use Node.js 22 or newer on the target operating system:

```sh
npm ci
npm run verify
npm run electron:smoke
npm run electron:pack
npm run electron:packaged-smoke
npm run electron:dist -- --publish never
```

Electron smoke tests require a graphical desktop. Linux needs Electron's runtime libraries and a display, or Xvfb. Build output goes to `dist/electron`, which is excluded from Git. Never commit installers, certificates, user profiles, or game source.

For an unsigned macOS ARM64 developer package:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:dist -- --mac --arm64 -c.mac.identity=null -c.mac.notarize=false --publish never
```

macOS ARM64 was built and smoke-tested during implementation. Windows and Linux require native build and interactive testing. Developer packages are unsigned or ad hoc signed, are not notarized releases, and never check for updates. macOS may request Keychain access again when an ad hoc signature changes. Automated smoke launchers use disposable profiles and a mock keychain.

## When releases are ready

Automation can be added later. Re-enabling Actions and adding a workflow should be an explicit maintainer decision. The scripts in `.github/scripts/` are inert helpers retained for that future work; they do not schedule jobs, publish artifacts, or access GitHub on their own.

Before preparing a release:

1. Review the source revision and set the package version. The release tag must match `vMAJOR.MINOR.PATCH` exactly.
2. Configure signing outside Git: Developer ID and Apple notarization credentials for macOS, a supported code-signing certificate and exact publisher identity for Windows, and an owner-held GPG signing key for Linux artifacts.
3. Review `.github/scripts/release-config.mjs` and `verify-release.mjs`. The configuration helper requires the owner repository, matching tag, platform, and signing environment values. It adds an explicit GitHub publisher configuration and the `bunnyhopReleaseBuild` stamp. Default development configuration has no stamp and uses `publish: []`.
4. Package with publication disabled. Verify platform signatures, notarization where applicable, and checksums on the actual target machines. Keep private keys and credential values out of logs and reports.
5. Test the live game, sign-in, Discord presence and reconnect, input, fullscreen, replay import/export, deep links, settings relaunch, and correct PB screenshot correlation. Confirm the matching website hooks are deployed.

Do not label developer packages as signed releases. Release-preparation helpers have not been validated with production signing credentials.

## Manual publication

Once the repository is public and the builds are reviewed, create a release for the reviewed tag and upload the installers, exact generated updater metadata (`latest*.yml`), referenced `.blockmap` files, checksums, and applicable detached signatures. Keep generated filenames intact and identify supported platforms. Publish the Linux public key and fingerprint through a trusted channel.

A private repository is not a public updater feed. Do not embed a GitHub token in the client to work around private release access.

Only stamped signed Windows/macOS builds with publisher configuration check for updates. Linux updates are manual. Validate an update between two genuinely signed versions before calling the update path production-ready. Nothing in this repository currently publishes releases automatically.
