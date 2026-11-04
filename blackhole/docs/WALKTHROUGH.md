# BlackHole Public Developer Handoff

Updated 2026-11-04. Start with the repository [README](../../README.md).
The export is a source snapshot; internal conversations and raw diagnostic
data are private. No credential or model is included.

## Architecture

`src/main/electronMain.js` launches Electron and the local backend.
`frontend/src` contains the React interface. Server routes are under
`src/server`, and orchestration is under `src/agent` and `src/agent/core`.

`src/runtime` selects llama.cpp, OpenAI-compatible gateways or OpenCode Go.
Authentication, streaming semantics and model catalogs are separate from
orchestration. `src/config` owns persistence and encrypted secrets; packaged
user data and development data are not interchangeable by path.

The agent registry and executor coordinate tools; file/terminal brokers live
under `src/workspace`, web utilities under `src/web`, MCP under `src/mcp`.
Checkpoint, journal, patch transaction, context engine and verification
modules are under `src/agent/core`.

`vscode-blackhole` is the companion extension, not the Electron application.
Its manifest, lockfile, source, test runner and resources must travel together.

## Development Boundaries

- Local GGUF inference uses llama.cpp, not an Ollama replacement.
- This export introduces no prompt censorship or tool approval policy changes.
  Existing source-controlled prompt/rule files are preserved unchanged.
- Bounded automatic indexing does not restrict explicit file access.
- Keep model performance settings distinct from recovery/status display.
- Preserve user changes and settings; never embed credentials in source.

## Verification

Use Node 24.21.0 and all three committed package-lock files. Run backend and
frontend tests, syntax, workspace rules and frontend build before packaging.
`release:check` has runtime prerequisites; extension host E2E, Playwright
visuals and live-model evaluations are additional checks.

Read test implementations before interpreting scores. Fixtures do not prove
a general coding benchmark, Linux compatibility, cross-PC installation trust
or hours-long unattended reliability. Historical local results are summarized
in [WORK_LOG.md](WORK_LOG.md), not independently reproduced by this export.

## Build and Transfer

Follow [DEVELOPMENT_TRANSFER.md](DEVELOPMENT_TRANSFER.md). Signing has
certificate-store side effects; read [ROOT_CA_OPERATIONS.md](ROOT_CA_OPERATIONS.md)
and the actual scripts. Rebuild on the target OS. Initialize a new repository
if Git-based checks are needed. Do not publish preexisting private Git history
without a separate audit.

Broader real-repository evaluation, long-running soak tests, dependency audits
and cross-PC signing/installation validation remain ongoing work.
