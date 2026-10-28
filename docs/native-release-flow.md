# Native release candidates

The release workflow builds and checks **candidates**. It doesn't publish a release, admit a build for ranked
runs or change any server. A maintainer does those by hand (see [releases](releases.md)).

## What the workflow does

`.github/workflows/native-release.yml` runs on a `vMAJOR.MINOR.PATCH` tag or a manual dispatch with a version and
platform. It runs only in `2x74/bunnyhop-client`, on hosted runners with pinned actions, read-only permissions and
no secrets.

1. The resource job downloads the pinned verifier, checks its SHA-256, typechecks and tests the menu, and builds
   the shared resources.
2. Each platform job builds the client and runs the movement parity gate (`apps/native/tools/parity-gate.ts`):
   generated maps, identical commands through the native core and the pinned WASM, every state compared bit for
   bit at physics 17 and 16. A mutation check confirms the gate catches a version mix-up.
3. Each platform also runs CTest, the bridge and physics tests, the packaging tests and `release-check.ts`. Linux
   and Windows also start the packaged executable.
4. The evidence job writes `candidate-evidence.json`: source SHA, run and attempt, job results, and for each
   platform the artifact ID and digest, the package report and the parity report. It checks every archive against
   its report and `SHA256SUMS`, and that all platforms agree on WASM, physics and timer rules.

Artifacts:

| Name | Contents |
| --- | --- |
| `bunnyhop-{windows-x64,macos-arm64,linux-x64}-RUN-ATTEMPT` | archive, package report, `SHA256SUMS` |
| `native-parity-{windows,macos,linux}-RUN-ATTEMPT` | generated maps, command streams, state traces, parity report |
| `native-candidate-evidence-RUN-ATTEMPT` | `candidate-evidence.json` |

Artifacts are kept for 30 days. Rerun all jobs, not only failed ones, so one attempt's outputs are never mixed with
another's. A single-platform run is for inspection only.

These checks don't cover a real mouse, interactive sign-in or every GPU and window system. Changes that touch
those need a manual check on the target OS before release.

The `Native release contract` workflow runs `evidence.test.mjs` and the parity gate tests on pull requests, with
read permission only.

## Ranked admission

The game server admits native builds from a static allowlist, `ALLOWED_NATIVE_CLIENT_BUILDS`: one entry per
package with its `build`, `wasm`, `physics`, `rules` and an `until` expiry. Take those values from each platform's
package report in the candidate artifacts, never from a local build. The server's WASM, physics and rules must match
the entry exactly, and every submitted replay is still re-simulated.

## Local checks

```sh
node --test .github/scripts/native-release/*.test.mjs
cd native
bun apps/native/ensure-wasm.ts
cmake -S apps/native -B apps/native/build -DBUNNYHOP_BUILD_CLIENT=OFF
cmake --build apps/native/build --target bunnyhop-native-runner
bun apps/native/tools/parity-gate.ts
bun test apps/native/tools/parity-gate.test.ts
```

The parity output folder (`native/target/native-parity` by default) must be empty before a run; `--output DIR`
keeps separate attempts.
