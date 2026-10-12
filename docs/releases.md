# Release setup

No repository, signing credentials, published release, or updater feed has been established for this project. The intended remote is `8tp/bunnyhop-client`. These instructions describe the preparation needed before a release can exist.

## Developer CI

`.github/workflows/ci.yml` runs npm install, syntax checks, tests, source smoke, native packaging, and packaged smoke on macOS ARM64, Windows x64, and Linux x64. Packages are explicitly unsigned. macOS notarization is disabled; Windows executable resource editing remains enabled while signing is disabled. Artifact names start with `UNSIGNED-DEV-` and expire after 14 days.

The runner labels follow the [GitHub-hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners): `macos-15` is ARM64, `windows-2025` is x64, and `ubuntu-24.04` is x64. Linux smoke tests run under Xvfb. Fixture smoke checks startup, sandboxed preloads, and the bundled settings window; it does not prove live OAuth, game-hook deployment, Discord desktop compatibility, or performance.

## Owner setup

1. Create the intended repository and push the reviewed source. Preserve the existing MIT license attribution.
2. Create the `signed-release` Actions environment. Configure required reviewers and restrict deployment to reviewed release tags. Limit who can create or move release tags. The workflow never runs on pull requests and refuses a different repository.
3. Supply the relevant environment secrets below. A platform with missing secrets fails instead of falling back to unsigned release packaging. A manual run can select one platform; a tag push attempts all three.
4. Confirm the package version, then create an exact `vMAJOR.MINOR.PATCH` tag. The workflow checks the tag against `package.json` and checks out that tag, including on manual dispatch. Review the source at that tag before allowing signing.

| Platform | Environment secrets | Meaning |
| --- | --- | --- |
| Windows x64 | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, `WINDOWS_PUBLISHER_NAME` | Supported Electron Builder PFX signing material and password; publisher common name must exactly match the certificate. |
| macOS ARM64 | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | Developer ID Application certificate/private key export accepted by Electron Builder, and its password. |
| macOS notarization | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Apple account, app-specific password, and team with notarization access. This workflow uses this authentication method, not an invented API key. |
| Linux x64 | `LINUX_GPG_PRIVATE_KEY`, `LINUX_GPG_PASSPHRASE`, `LINUX_GPG_FINGERPRINT` | Armored owner-held signing key, passphrase, and full 40-character fingerprint. Publish the public key and fingerprint through an independently trusted channel. |

`*_CSC_LINK` can contain a base64-encoded certificate export supported by the installed builder. These credentials must actually permit signing. A certificate requiring a hardware token or cloud signing service needs a separately reviewed signing integration; this workflow does not pretend to support one.

## Signed build gates

`.github/workflows/release.yml` produces review artifacts only. It has read-only repository permissions and every builder invocation uses `--publish never`. Running it does not create a GitHub Release or upload updater files.

The generated `release-builder.json` extends the normal builder configuration. It adds the `bunnyhopReleaseBuild` package stamp and the explicit GitHub publisher metadata for the intended repository. Windows uses `win.signtoolOptions.publisherName`, executable signing, and update signature verification; macOS requires signing and notarization. This matches the pinned Electron Builder 26.15.3 API. The normal developer configuration has `publish: []` and no release stamp.

After packaging, the workflow verifies Windows Authenticode signatures and publisher identity, or verifies the macOS app signature, stapled notarization, and Gatekeeper assessment. Linux packages, metadata, and checksums receive detached GPG signatures that are verified locally. All platforms produce `SHA256SUMS`. Checksums detect corruption; authenticate them through a trusted signature or authenticated release channel.

A missing certificate, missing notarization credentials, failed signature verification, or failed smoke test prevents the artifact-upload step. The workflows and signing gates have not yet been exercised in GitHub Actions or with owner signing credentials.

## Review and publication

Before publishing anything, download the `SIGNED-REVIEW-*` artifacts, verify signatures on native machines, and test the actual live game, Discord reconnect, OAuth, `.bhr` import/export, deep links, and settings relaunch behavior. Check that the matching web hooks are deployed. Confirm that PB captures attach only to the correct result.

Publication is a separate owner action after review. Upload installers/archives together with the exact generated updater metadata (`latest*.yml`) and referenced `.blockmap` files to a release for the same tag in the intended repository. Keep the generated filenames unchanged. Upload checksums and Linux detached signatures, and state which platforms are included. Do not publish unsigned CI packages or relabel them as signed artifacts.

Only stamped signed Windows/macOS builds use the configured updater feed. The shell also checks that publisher configuration is present; development packages never check. Linux automatic updating is disabled and requires manually downloaded, verified packages. Test the update path between two genuinely signed versions before describing automatic updates as validated.
