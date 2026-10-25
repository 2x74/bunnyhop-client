# Native candidate, review and owner promotion

Status: the public repository builds and verifies **candidates** and emits
review evidence. It does not admit a build, publish a release, deploy a server,
or send an announcement. The Hermes review runner, owner approval receiver and
private promoter are separate integrations. No promotion endpoint currently
exists: the game server reads `ALLOWED_NATIVE_CLIENT_BUILDS` from its static
configuration. A successful public workflow alone cannot change it.

The intended sequence is candidate build and deterministic checks → immutable
evidence → isolated Hermes quality review → **owner final approval** → deterministic
promotion of those exact bytes → server active-state receipt → announcement.
An assistant does not have to be online for these services to process an event.

## Public implementation

`.github/workflows/native-release.yml` accepts a version and platform selector
on manual dispatch, or the version from a `vMAJOR.MINOR.PATCH` tag. Its candidate
jobs are limited to `2x74/bunnyhop-client` and push/manual events, use hosted
runners, pinned action commits, `contents: read`, and checkout without persisted
credentials. There are no production/model/Discord secrets or write permissions.
A branch dispatch can build an inspection candidate; the private receiver must
independently enforce approved protected source refs before promotion.

The resource job downloads and SHA-256 verifies the pinned canonical verifier,
typechecks/tests the menu and generates resources. Each selected platform must
run `apps/native/tools/parity-gate.ts` using that platform's built C++ ABI runner.
The gate generates self-contained BSPs with the existing public BSP writer (no
production maps/replays or content downloads), steps identical commands and
velocity writes through native and exact pinned WASM at physics 17 and 16, and
compares every observable float bit, state flag and event (only NaN payloads are
normalized). It requires positive counts, zero mismatches and no missing physics
assets. Phase sweeps must also demonstrate uphill speed preservation, edge-bug
prevention, first-landing contact with a one-unit teleport trigger and telehop
fall-speed restoration/map-teleport events. Each fixture must diverge between
v16 and v17; a flat-only or otherwise unexercised window fails. A mutation test
actually downgrades the native runner's v17 command stream to v16 and requires
mismatches in all four fixtures. These checks run before packaging on all three
platforms; Windows `build.ps1` uses its checked `Run` wrapper.

Each platform also runs CTest (tutorial/SSJ statistics oracles over supplied
states; these do not test movement parity), Rust bridge tests, the physics-version
suite with `native-wasm-math`, package tests, and platform package checks. Linux/Windows also
check packaged executable startup. Windows checks the release-check exit code
immediately, before `--help`; an adversarial PowerShell test executes both
workflow blocks with a failing release-check and successful startup, and the
reverse. Existing checks do not establish physical
mouse, interactive login or every GPU/window-system behavior; review must assess
those limits and require additional evidence for changes affecting them.

Platform artifacts are named `bunnyhop-{windows-x64|macos-arm64|linux-x64}-RUN-ATTEMPT`.
`native-parity-{windows|macos|linux}-RUN-ATTEMPT` artifacts retain generated BSPs,
exact command streams, WASM/native JSONL state traces, native stderr, and
`parity-report.json`. The report records pinned WASM URL/byte count/full hash,
runner hash, BSP hashes, every input/output digest, per-version comparison
counts/mismatches, behavioral contrast counts and source/run/attempt. It does
not contain or depend on private maps or replays. Parity uploads use `always()`
so failed comparison diagnostics survive; failed gates cannot produce candidate
evidence. Resources and evidence names also include the run ID and attempt. No upload
uses overwrite. The final evidence job records the immutable Actions artifact
ID and ZIP SHA-256 from each upload, checks the downloaded archive against its
report and `SHA256SUMS`, and checks the native identity derived from binary,
menu, assets and full canonical WASM hashes. Reports include exact WASM build,
physics and timer rules; every platform must agree on compatibility. Each
platform entry also requires a parity artifact ID/digest/name and report digest
and full report, bound to the same source/platform/run/attempt and package WASM
and physics. The collector checks all retained parity file digests and rejects
missing, extra, empty, mismatched or non-contrasting evidence. Reports/checksums
are size-checked before reads; archive/trace hashing uses bounded chunks, with
512 MiB per archive, 32 MiB per trace and 128 MiB per parity artifact ceilings.
Package extraction and provenance authentication remain private receiver work.

`native-candidate-evidence-RUN-ATTEMPT` contains `candidate-evidence.json`:
repository, source SHA, ref, workflow ref, event, run ID, attempt, version,
platform selection, deterministic job results, exact run-attempt logs API URL,
and each platform's artifact ID/digest/name, report digest and complete report.
The job summary records the evidence artifact ID, Actions ZIP digest and separate
JSON SHA-256. These are three different coordinates; preserve all of them.
Rerun **all jobs**, rather than only failed jobs, to create a complete new attempt;
old-attempt resources or platform outputs cannot be mixed into new evidence.
Artifact retention is 30 days; expired/deleted evidence requires a fresh candidate
and review. A single-platform build is inspectable but the review validator
refuses it for promotion.

The separate `Native release contract` PR workflow runs offline adversarial tests
with read permission only. PR/fork test output is never a release source. There
is no `pull_request_target` or privileged `workflow_run` consumer in this repo.

## Mandatory private receiver checks

Candidate JSON is **untrusted data**, including its asserted success statuses.
`validateEvidence` and `validateReview` in
`.github/scripts/native-release/evidence.mjs` provide local consistency checks;
they do not authenticate GitHub, Hermes, a reviewer, or owner approval. The
private implementation must use its own reviewed validator/policy, never execute
one downloaded from the candidate, and independently establish all of:

1. The exact numeric repository ID and owner, expected workflow path/approved
   workflow revision, successful completed run/attempt and head SHA, push/manual
   event and protected source ref. Verify ref-to-SHA and protected workflow/code
   review policy; repository name or mutable tag alone is insufficient. Reject
   pull-request and fork sources, unexpected actors/workflows and stale attempts.
2. All required jobs **and their expected check steps** succeeded for that SHA and
   attempt. Fetch GitHub's job records and complete attempt logs, including the
   resource/menu tests, CTest, bridge/physics/package tests and runtime/package
   checks. The evidence's `logsUrl` identifies the whole attempt; do not review
   only candidate-authored JSON. Missing/expired logs or unavailable oracle/parity
   results block review. Never equate an existing archive with successful tests.
3. Download evidence and packages by exact immutable artifact IDs from that run;
   compare GitHub's artifact metadata and ZIP digests to the reviewed receipt,
   then independently hash JSON/report/archive bytes. Fail on digest mismatch,
   even if a download action only warns. Validate package contents/manifest and
   component hashes using a bounded safe extractor; reject traversal/symlinks and
   unexpected executables. Never execute candidate code on a credentialed runner.
4. Archive the full fetched logs, source diff, job/step records and package
   reports with digests before preparing bounded read-only review input. Include
   test names/counts, failures/skips, canonical WASM/native parity output,
   dependency/license changes, signing state, known limitations and release notes.
   Fetch the exact movement-parity artifacts too, independently verify their
   report/input/output hashes and nonzero comparison/behavioral counts, and bind
   their immutable artifact coordinates into the review alongside packages.
   A bounded projection must disclose omitted content and point to the preserved
   full evidence; truncation cannot erase a failure. Record all input digests in
   the review invocation receipt. Do not cache across candidate SHA/attempts.
5. Recheck source revocation, artifact existence, review freshness and the
   server's **current exact** WASM, physics and timer rules immediately before
   approval consumption and again before admission. Web compatibility grace
   does not admit an older native identity. Reject any mismatch.

GitHub documents immutable v4 artifacts and artifact ID/digest outputs in
[upload-artifact](https://github.com/actions/upload-artifact). Its
[workflow-run REST API](https://docs.github.com/en/rest/actions/workflow-runs#download-workflow-run-attempt-logs)
provides attempt-specific logs. A future signed provenance step may add
[artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations),
with independent verification of signer/workflow/source/digest; none are emitted
by this candidate workflow, which has no OIDC or attestation write permission.

## Isolated Hermes quality job contract

Use a dedicated Hermes home/container/profile, separate from Bun-E's staff
sessions, memories, game-agent token and production knowledge sync. The live
runtime was observed as v0.22.2; inspect the actual installed CLI and provider
capabilities when implementing the runner. Do not copy a stale README's version
or assume a stronger model exists on the current account.

The owner selected **GPT-6.1 Sol (`gpt-6.1-sol`) with high reasoning**, dedicated
to release review, independently of the main Bun-E chat model. Isolated Hermes OAuth inference
through `openai-codex` has been tested, including the backend's exact model and
high-reasoning response, with no tools or fallback. `review-policy.json` records
`provider: "openai-codex"` and remains `enabled: false`. Authentication/model
access is available; trusted GitHub collection, promotion and owner-approval
automation are still staged. The private integration is building a manual
no-tools runner. The trusted receiver must maintain its own owner-controlled
policy and verify invocation identity and reasoning on every run before any
future activation. Do not fall back to another model or provider.
The harness records the actual selected provider/model independently and refuses
fallback or mismatch. Model unavailability blocks quality approval. The public
`hermes-review-prompt.txt` is a contract template, not an installed job. Input
is a bounded read-only evidence bundle. No shell, arbitrary HTTP, deployment,
GitHub write, Discord or admission tools. Candidate text is untrusted input.
The quality job can reject a candidate; it cannot waive a deterministic failure,
change hashes, rebuild an artifact and approve the replacement, or approve
production on the owner's behalf.

The JSON result has this shape (placeholders are illustrative, not valid evidence):

```json
{
  "schema": 1,
  "decision": "approve",
  "sourceSha": "EXACT_40_HEX_SOURCE_SHA",
  "runId": "EXACT_RUN_ID",
  "runAttempt": "EXACT_ATTEMPT",
  "evidenceSha256": "SHA256_OF_EXACT_EVIDENCE_JSON_BYTES",
  "artifacts": ["PACKAGE_ARTIFACT_ID:EXACT_ACTIONS_ZIP_SHA256", "PARITY_ARTIFACT_ID:EXACT_ACTIONS_ZIP_SHA256"],
  "provider": "openai-codex",
  "model": "gpt-6.1-sol",
  "reasoning": "high",
  "createdAt": "HARNESS_SUPPLIED_UTC_TIME",
  "expiresAt": "NO_MORE_THAN_24_HOURS_LATER",
  "blockers": [],
  "summary": "Evidence, limitations and reason for the decision"
}
```

`validateReview` rejects anything except an approve decision with no blockers,
full platform evidence, exact SHA/run/attempt/evidence/artifact binding,
policy-approved provider/model/high reasoning and a review valid for at most 24 hours. The
trusted wrapper validates result size/schema, timestamps and actual invocation
identity, and signs or stores its receipt under a separate review-service role.
An arbitrary JSON file, check name, bot message or model assertion is not an
approval receipt. Store rejected reviews and diagnostics too.

## Owner approval, admission and announcement

After successful deterministic gates and the isolated review, present an
immutable owner proposal containing source/run/attempt, every archive/native
identity, evidence/review/input digests, compatibility tuple, expiry, signing
limits and intended release notes. The private owner-and-Bun-E channel is an
approval surface, not an added capability of the language model. Parent/private
integration owns that channel and its access controls.

The deterministic approval receiver must fetch the actual Discord message and
current owner identity itself, reject bots/webhooks/edits, and bind a one-use,
short-lived approval code to the exact immutable proposal. Existing moderator
feedback/shadow approvals do not authorize releases. Owner final approval is
required initially; Luna may request candidates and Bun-E may explain evidence,
but neither can approve, change the proposal, or acquire a production credential.
A protected GitHub environment can provide an additional owner gate only after
its required owner reviewer, ref rules and no-bypass policy are configured. A
YAML environment name alone creates no protection. See GitHub's
[environment protections](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
and [secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

The private promoter is deterministic and separate from the LLM and announcer.
A future fixed-purpose admission service must accept a **verified candidate
receipt**, not arbitrary manually supplied hashes or a shell/deployment command.
Authenticate a narrowly scoped service identity (for example a fixed-audience
OIDC exchange with exact repo/workflow/ref constraints); the game must not receive
a broad GitHub token. Keep endpoint, authentication and credential configuration
private until the real service exists. This repo makes no request to a proposed
URL and defines no fake working route.

Promotion must copy the reviewed bytes without rebuilding/re-signing them. Derive
`build`, `wasm`, `physics`, `rules` from the verified package report; server-side
expiry has a finite owner-policy maximum (recommended initial maximum 14 days).
Record receipt, owner actor, previous state and audit attribution transactionally.
Use the evidence/review/proposal digest tuple as an idempotency key and use a
compare-and-swap admission revision. An identical retry returns the same result;
a changed payload for that key is refused. Require the admission store to be
read by the game's actual synchronous admission path before reporting success.
The current static env allowlist therefore needs a private integration/change;
writing a separate D1 table alone does not activate a client.

Immediately read back the exact active tuple and expiry through the real game
admission path. Persist a signed/audited active receipt only after this succeeds.
The separate announcer consumes that receipt, verifies current active state and
has only channel-send permission. Deduplicate on activation receipt ID, retain a
pending delivery record and mark delivered after the external service confirms.
An expired/revoked build must never be described as active. Public announcements
are not enabled by the owner-only release channel or by this repository.

Rollback names a previously verified unexpired receipt compatible with the
current server, uses a new owner-approved operation and compare-and-swap
revision, and restores its exact identities without rebuilding. Revocation
removes or disables exact identities immediately in the actual admission store.
Both operations are audited/idempotent; repeated requests cannot extend expiry
or resurrect a revoked receipt. If the previous version is incompatible, refuse
rollback and disable the new entry instead. Announce rollback only after its
active-state receipt; failed announcement never undoes a successful admission.

## Activation checklist and local verification

Ready for review now: public candidate workflow, immutable evidence collector,
adversarial contract tests, read-only Hermes prompt template and this integration
contract. No production secret or server access is needed to test these pieces:

```sh
node --test .github/scripts/native-release/*.test.mjs
cd native
bun apps/native/ensure-wasm.ts
# Build the platform runner first (normal native build also builds it):
cmake -S apps/native -B apps/native/build -DBUNNYHOP_BUILD_CLIENT=OFF
cmake --build apps/native/build --target bunnyhop-native-runner
bun apps/native/tools/parity-gate.ts
bun test apps/native/tools/parity-gate.test.ts
```

Parity output must be empty before a run (default `native/target/native-parity`);
use `--output DIR` to retain separate local attempts. Local verification is not
hosted CI evidence. The parent must push, trigger a complete candidate attempt
and inspect all platform steps/artifacts before review.

Still required before automatic registration: owner-reviewed protected refs and
workflow policy; narrowly scoped private GitHub read/dispatch installation;
complete job/log fetcher and safe package verifier; an
isolated Hermes runner/receipt store using the tested provider; real owner approval verification;
private promoter/admission integration and authentication; active-state readback,
expiry/revocation/rollback persistence; and a separate authorized announcer.
Nothing in the public patch provisions these or changes live admission.
