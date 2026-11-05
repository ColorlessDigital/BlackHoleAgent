# Windows Development Prerelease: Stabilized 31

Tag: `v1.0.0-stabilized.31`. [Download assets](https://github.com/ColorlessDigital/BlackHoleAgent/releases/tag/v1.0.0-stabilized.31).

This publishes the **already tested, unchanged build-31 binaries**, not a new
unverified rebuild. Public-only diagnostic default paths and documentation may
differ from the maintainer's source snapshot; both source fingerprints are
recorded in the provenance and release metadata.

## Downloads

- `blackhole.exe`: portable Windows x64 executable.
- `BlackHole-Setup.exe`: installer.
- `blackhole.zip`: the same portable executable in a ZIP.
- `BlackHoleAgent-source-v1.0.0-stabilized.31.zip`: audited English public source.
- `BlackHole-third-party-notices-v1.0.0-stabilized.31.zip`: accompanying notices.
- `RELEASE_INFO.json`, `PUBLIC_VALIDATION.json`, `SHA256SUMS.txt`: identity, scope and hashes.

No model, API key, user settings, conversation, private log, private signing key
or original private Git history is included.

## Changes Since the Previously Published Build 13

- Stronger file-save/rollback and interrupted-action recovery evidence.
- Better scoped reads/patching, current-turn context retention and observation completion checks.
- Request-budget-aware provider backoff and quota error handling.
- Four-entry strong workspace-context LRU cache with weak active-caller sharing.
- Behavioral verification distinct from syntax/lint success; correct unverified
  stops, existing runner/loader preservation and bounded test discovery.
- Verification subprocess isolation from inherited Node test-runner context.
- Dependency/runtime updates and installer trust-store changes described below.

Prompt censorship, approval policies and existing instruction files are not
modified for publication.

## Build-31 Evidence

Backend 507 passed + 1 native-symlink privilege skip, three consecutive runs;
frontend 10/10; metadata 5/5; release checks with extension-host E2E excluded.

Completion regression 9/9 includes expected incomplete/unverified outcomes.
Actual Go tasks 8/8 and local 4B code fixes 3/3 used the default product verifier
and immutable existing assertions. Public-source installation/checks are a
**separate** recorded run in root PUBLIC_VALIDATION.json.

A 60-minute natural-GC run belongs to **build 30**, not build 31. Do not combine
its 553/553 with the newer task counts. See [history](HISTORY.md) and
[public validation](validation/stabilized-31.json) for model/budget limits.

## Trust and Remaining Limits

The executables use a self-signed development publisher, not public-CA signing
or SmartScreen reputation. Setup31 does not automatically import or remove
trust-store certificates. Builds 13/14 did; review their unchanged release
warnings before handling legacy installations.

The build signing script still provisions/trusts a local CA on the build PC.
Do not run it merely to suppress an end-user trust warning. Inspect
[certificate operations](../blackhole/docs/ROOT_CA_OPERATIONS.md).

Development dependency advisories remain. Test results are not security or legal
certification, complete requirement coverage, clean-PC installation proof,
Linux/macOS compatibility, or arbitrary-task success guarantees.
