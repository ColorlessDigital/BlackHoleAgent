# BlackHole Public Developer Handoff

Source baseline: stabilized 31. This is a public technical summary, not the
maintainer's private work log. Start with the [repository README](../../README.md).

## Current Identity

- Windows executable release: `v1.0.0-stabilized.31`.
- Maintainer source fingerprint: `e7b03047c1af65e2ecbb467c03a8533b001721a7df577fa0ccc31c251550dd37`.
- Packaged app.asar: `921ef4910399705bfba5018bae66b6a0759fa0010f6c10c35a2673c7ca9345af`.
- Public-source fingerprint and intentional diagnostic-default differences:
  [PUBLIC_SOURCE_PROVENANCE.json](../../PUBLIC_SOURCE_PROVENANCE.json).
- Node 24.22.2, Electron 44.10.2, electron-builder 26.15.3.
- Public-source checks are rerun separately in [PUBLIC_VALIDATION.json](../../PUBLIC_VALIDATION.json).

Models, installed dependencies, user settings, keys, private conversations,
raw diagnostics, developer signing keys and original private Git history are
not part of this export. The release ZIP is not an OS credential backup.

## Architecture and Entry Points

| Area | Files under blackhole |
|---|---|
| Desktop/backend | src/main, src/server, frontend/src |
| Agent and task state | src/agent/orchestrator.js, src/agent/core/stateMachine.js |
| Verification | src/agent/core/verificationEngine.js and verificationEngine.test.js |
| Context and memory | contextEngine.js, contextCompactor.js, contextGuard.js |
| Recovery | checkpointStore.js, checkpointResume.js, actionJournal.js, diffTracker.js |
| File/terminal execution | src/workspace/fileBroker.js, terminalBroker.js |
| Models | src/runtime/llamaCppRuntime.js, openCodeGoRuntime.js, runtimeRouter.js |
| External tools | src/mcp and src/web |
| Companion extension | repository-level vscode-blackhole |

Local GGUF inference uses llama.cpp. OpenAI-compatible gateways and OpenCode Go
are optional, separate providers. Web/MCP/provider use can involve networking.

## Behavioral Completion Contract

For the supported source-file types, a missing behavioral test is not a passing
test. Existing project test commands retain their runner, loader and owner scope.
Without a declared command, bounded discovery can use existing standalone Node
test/assert files. It does not descend into unrelated child packages or symlinks.

Missing checks, recognized zero/all-skipped summaries and obvious nonbehavioral
version/echo/syntax-only commands result in
`incomplete / behavioral_verification_unavailable`. Source edits and checkpoints
are preserved. This does not spend source-repair cycles or force creation of
unrequested test files. Provide an appropriate check before resuming.

Actual failing assertions use the existing bounded repair path; unavailable
executables remain environment failures. Resume rechecks preserved changes.
Verification subprocesses remove inherited `NODE_TEST_CONTEXT` without changing
the parent environment, preventing nested Node test-runner false success.

Unknown successful project-declared test commands retain that evidence source.
The mechanism cannot prove arbitrary assertions, test quality, complete natural-
language requirements, or every language/artifact. Do not call it a formal
semantic correctness proof.

## Context and Resource Contract

The strong workspace-context cache retains four recently used engines. Weak
lookup preserves sharing while a caller or scan still owns an evicted engine.
Unused engines and their indexes can be collected; active indexes are not cleared.

This is not a byte quota, a limit on concurrent users, or a promise that RSS
returns to startup. Compiler temporaries, live tasks and allocator high-water
remain relevant. Broad-root scan budgets affect background indexing, not explicit
file-access permission. Current-request evidence is preserved during compaction.

## Verification Evidence

[Build 31](../../docs/validation/stabilized-31.json): backend 507 passed + 1 skip
three times; frontend 10/10; completion fixtures 9/9; real Go tasks 8/8 and 4B
implementation tasks 3/3 with the product default verifier and immutable tests.

The fixture count includes correctly stopped unverified work. Go used an in-memory
GLM 5.3 Flash diagnostic context/output of 8192; local coding output cap was 4096.
These do not certify saved global budgets or every model.

[Build 30](../../docs/validation/stabilized-30.json): historical natural-GC hour,
553/553 including an intentional cancellation. No new build-31 hour is claimed.
Earlier failures are retained in [history](../../docs/HISTORY.md).

## Setup and Checks

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/bootstrap-windows.ps1
$env:Path = (Join-Path $PWD 'node-v24.22.2-win-x64') + ';' + $env:Path
Set-Location blackhole
npm test
npm --prefix frontend test
npm run check:backend
npm run check:workspace-rules
npm run build:frontend
npm run release:check -- --skip-extension-e2e
```

Model-free packaged regressions: `scripts/stability-behavior.cjs`.
Workspace retention control: `scripts/stability-workspace-memory.cjs`.
Both require a complete release folder via `--release` and a fresh label.
Use the development Electron runtime as their host, not a portable application
launcher. See the [demo guide](../../docs/DEMO.md).

Live-provider/GGUF checks require explicit opt-in, local credentials/models, and
can consume time or usage. The public export does not include private diagnostic
profiles or automatically run live providers.

## Packaging and Trust

`npm run build:windows` prepares runtimes, builds the extension/UI and signs a
Windows release. Review [ROOT_CA_OPERATIONS.md](ROOT_CA_OPERATIONS.md) first:
development signing provisions a local CA on the build machine. Installer31 does
not automatically mutate trust stores; legacy 13/14 installers did.

Do not overwrite a verified release while testing. Record source/package/asset
hashes and distinguish fresh source checks from old executable measurements.
Linux builds must be validated on Linux; Windows tests do not certify them.

## Boundaries and Remaining Work

Do not alter prompt censorship, approval policies, source-controlled prompts or
rules as a publication side effect. The exported agent files match build31.
Keep credentials on the destination PC; OS-encrypted secrets are not portable.

Clean-Windows installation/upgrade, other-PC setup, visible VS Code host E2E,
public-CA trust, broader independent task coverage and development advisories
remain separate work. Never relabel missing checks or failed first attempts as
success, and never combine evidence from different package hashes.
