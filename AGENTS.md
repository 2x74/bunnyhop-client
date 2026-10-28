# Agent guide

This repository is public. Players read the code, so it has to read like it was written by a careful
human. Correct but unreadable code gets rewritten.

Build, test and release commands are in [CONTRIBUTING.md](CONTRIBUTING.md) and
[native/apps/native/README.md](native/apps/native/README.md). Run the checks that cover your change before
you commit.

## Layout

- `native/apps/native/src`: the C++20 / SDL3 / OpenGL client. Tests are `*_tests.cpp`, registered in
  `native/apps/native/CMakeLists.txt`.
- `native/apps/native/ui`: native menu adapters (TypeScript) built into one menu document by `build-menu.ts`.
- `native/apps/web`, `native/crates`: **vendored copies** of the main game. Don't hand-edit them. Change them
  upstream and re-sync. Native-only deltas live as patches applied by the sync tool.
- `native/apps/native/vendor`: third-party code (nlohmann, stb, dr_libs, unicode data). Never reformat it.
- `electron/`: the legacy Electron shell. Leave it alone unless the task is about it.

## C++ style

- One statement per line. No `if(x){a;b;}else{c;}` chains on a single line.
- Keep lines under 120 columns.
- Keep functions short and named for what they do. If a function needs a comment to explain its sections,
  split it.
- Don't add more capturing lambdas to `run()` in `client.cpp`. Put new behaviour in its own header/source
  with a struct or class that owns its state, and call it from the loop. When you change an existing block
  in `run()`, move it out if you can.
- Name things fully: `mouse_queue`, not `mq`; `tick_interval_ns`, not `t`. Short names are fine for loop
  indices and obvious math.
- Name constants. No bare `0.022`, `450.0f` or `1./62` in logic; give them a `constexpr` with a unit in the
  name (`kYawPerCount`, `kMenuFrameSeconds`).
- Prefer value types, `std::optional`, `std::span`, RAII guards. No raw `new`/`delete`.
- Errors: throw for broken invariants at startup or load; return a result for expected failures (network,
  files, user input). Never let an exception escape a thread or a callback from C.
- Hot paths (per tick, per frame, per input event) don't allocate, parse JSON, search
  `nlohmann::json` or build strings. Read settings into typed structs when they change, not every frame.
- No blocking I/O (disk, network, process waits) on the frame loop. Use a worker and hand back results.
- Match the formatting of `.clang-format` when it exists. Don't reformat lines you aren't otherwise changing.
  Reformatting goes in its own commit, listed in `.git-blame-ignore-revs`.

## TypeScript style

- Same rules: one statement per line, named helpers, no clever one-liners, no `any`.
- Menu code must not import the web game entry point, Three or the live simulation (`build-menu.ts`
  enforces this).
- Match the existing UI. Avoid gradients, glows, emoji decoration, new card styles or anything that looks
  generated. Copy should be short and plain.

## Comments and docs

- Comments say *why*, not *what*. Delete a comment that restates the code.
- Write plainly. No hedging chains ("this does not establish…", "remains unverified…", "not claimed as…").
  If something is untested, say it once, in one sentence, where it matters.
- Don't mention agents, prompts, sessions or "this pass" in code, comments or docs. (Co-author trailers on
  commits are fine.)
- Docs are for players and contributors. README and release notes say what changed for the player in a few
  bullets. Put long investigation notes in the PR description, not the repo.
- Don't commit evidence dumps, screenshots or generated reports unless a doc links them for a reason.

## Gameplay and ranked rules

- Physics, collision, timer rules and replay format come from the shared Rust core. Don't reimplement or
  patch them in C++.
- Changes to input scheduling, replay recording or anything a server verifier reads need tests that pin the
  exact per-tick output. Input changes also need a real-mouse check on the target OS, noted in the PR.
- Never submit fabricated or scripted runs to production, including from tests.

## Commits and PRs

- One logical change per commit, imperative subject under ~72 characters, body explains why.
- Keep the PR description short: what changed, how it was checked (OS, hardware), and what's left.
