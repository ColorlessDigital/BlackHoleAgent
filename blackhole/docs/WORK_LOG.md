# BlackHole Public Change Summary

Current source baseline: stabilized 31. Internal conversations, raw diagnostics,
account details, machine-specific user paths and private work logs are excluded.
This document summarizes implemented behavior and scoped public evidence.

## Development Stages

| Stage | Public summary |
|---|---|
| Local agent foundation | llama.cpp GGUF lifecycle, file/terminal/web/MCP tools, separate optional providers |
| Runtime and status | Configurable request/startup limits, heartbeat, structured errors and cancellation |
| Recovery | Journal/checkpoints, named resume, file-effect observations, atomic-save/rollback reporting |
| Long conversations | Routed context budgets, compaction, current-request quotation evidence |
| Multi-workspace resources | Four-entry strong LRU ownership with weak active-caller sharing |
| Behavioral verification | Existing test runner/loader preservation, bounded test discovery, honest unverified stops |
| Publication | English docs and scripted UI illustrations; sanitized source/evidence and checksummed Windows assets |

## Current Build-31 Results

- Backend: 508 total, 507 passed, 1 native-symlink privilege skip, three consecutive runs.
- Frontend: 10/10; release metadata: 5/5; release checks with extension-host E2E excluded.
- Completion regressions: 9/9, including expected incomplete/unverified outcomes.
  The same immutable build-30 baseline passed 2/9.
- Real Go tasks: 8/8, four seeded task types repeated twice, using GLM diagnostic
  context/output 8192 and the product default verification engine.
- Real Qwen3 4B implementation fixes: 3/3; other stream/cancel checks bring the
  local diagnostic total to 10/10.
- An 80-workspace explicit-GC retention control passed on the same package.

Pre-existing tests and package metadata were immutable fixture inputs.
No user credential/model/performance setting was saved by the diagnostics.
See [sanitized evidence](../../docs/validation/stabilized-31.json).

## Root Causes Addressed

The previous verifier could treat skipped tests and syntax-only success as task
completion. Standalone tests for newly created files could be missed, and direct
Node test invocation could discard a project's loader or runner. In a parent
Node test process, inherited NODE_TEST_CONTEXT could even skip child tests with
exit code zero.

Build31 separates actual assertion failure from unavailable behavioral evidence.
The latter stops with saved changes and no speculative source-repair loop.
Actual failing assertions still use bounded repair and re-verification.
The application does not automatically generate tests merely to mark a task done.

## Historical Evidence

Build30's natural-GC hour passed 553/553 including one intentional cancellation.
It belongs to build30, not build31. Its strong cache stayed at four; RSS still
fluctuated. The explicit-GC control demonstrated unused-engine retention; it did
not prove all memory leaks or temporary allocations impossible.

Build29's prior long-conversation/checkpoint results and build27's 4B first failure
remain historical. Build13 was the previous public Windows snapshot with 404
backend checks and older dependency/installer warnings.
[Version history](../../docs/HISTORY.md).

## Export and Limits

Public source is independently reinstalled and checked; its results are
[PUBLIC_VALIDATION.json](../../PUBLIC_VALIDATION.json), not copied live-model logs.
Diagnostic default paths are portable and recorded in
[provenance](../../PUBLIC_SOURCE_PROVENANCE.json). Executable agent behavior,
prompts and approval policy are not changed for publication.

Existing assertions cannot prove arbitrary requirements or their own quality.
Unknown successful project test commands retain their declared-command evidence
source. Other languages/artifacts, clean-PC installation, visible extension-host
E2E, public-CA trust and all-model reliability remain outside these measurements.
