# Contributing

Use Node.js 22 or newer. Install with `npm ci`, then run `npm run verify` and `npm run electron:smoke` on a graphical desktop. For packaging changes, build with `npm run electron:pack` and run `npm run electron:packaged-smoke`. Use the unsigned overrides documented in [README.md](README.md) and CI when building macOS development installers.

Keep changes focused. Explain the behavior before and after, the checks run, and which operating systems were actually tested. Tests should cover meaningful failure paths. Performance claims need a reproducible measurement and the hardware/software conditions.

`electron/policy.mjs` owns origins, navigation policy, and Chromium flags. Keep remote game data bounded, validate IPC senders, and preserve renderer sandboxing. Discord stays optional and presence-only. Native integration must not alter input, physics, replay semantics, or server verification.

The matching game hooks are maintained in the separate Bunnyhop web project. Coordinate bridge-contract changes across both projects and preserve behavior when the native bridge is absent.

Do not commit certificates, tokens, player data, or generated binaries. Signing credentials belong in reviewed release environments. See [release setup](docs/releases.md) for the build gates. The intended GitHub repository is not yet available; until it exists, review changes in this checkout rather than following nonexistent issue or pull-request links.

Contributions use the existing [MIT license](LICENSE) and [code of conduct](CODE_OF_CONDUCT.md).
