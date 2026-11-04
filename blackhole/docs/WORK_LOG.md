# BlackHole Public Change Summary

Source snapshot: 2026-11-04. This is a public summary, not the internal raw work
log. Private conversations, credentials, machine-specific paths and diagnostic
profiles are deliberately not distributed. Original records remain private.

## Implemented Areas

- llama.cpp local GGUF lifecycle, configurable runtime parameters,
  startup/request timeouts and progress reporting.
- Optional OpenAI-compatible gateways and OpenCode Go; protocol/model catalog
  handling, per-model output budgets, structured streaming error information.
- Separate reasoning records and visible assistant responses.
- File/terminal/web/MCP tools, planning, validation, execution journal,
  checkpoints and explicit recovery state.
- Bounded automatic background indexing for broad workspaces, cancellation
  yielding, concurrent scan ownership and individual file-error isolation.
- Context budgets against the selected route and bounded summarization.
- Scoped validation of created directories and edited project files.
- React desktop UI, operational status/log views and VS Code integration.
- Windows source fingerprints, packaging and signing scripts.

## Recorded Stability Baseline

The maintainer's local release `go-stabilized-13` recorded 404 backend tests,
10 frontend tests, repeated focused tests and release checks with extension
host E2E excluded. A fixed packaged Gemini test matrix completed 19 runs twice;
a separate timed-out checkpoint was resumed on that package. These are
historical local results, not independent public benchmark scores or a claim
of reliability on arbitrary large repositories or long unattended sessions.
Raw provider conversations and machine-bound evidence are not in this ZIP.

## Public Export

Apache-2.0 was selected by the owner. The export retains production code,
tests, fixtures, build scripts, lockfiles and workspace standards. Models,
dependencies, runtime binaries, old builds, certificates, user state and Git
history are excluded. Personal fallback paths in the diagnostic proof helper
are replaced with repository-relative defaults in this public copy. See
`PUBLIC_SOURCE_PROVENANCE.json` at the repository root.

Prompt content, approval policy and executable agent behavior were not changed
for the export. See [WALKTHROUGH.md](WALKTHROUGH.md) for continued development.
