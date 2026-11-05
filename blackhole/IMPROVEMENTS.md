# BlackHole Technical Improvements: Historical Summary

Current source: stabilized31. This older architecture narrative remains historical;
the latest behavioral-verification and workspace-cache work is in
[WORK_LOG.md](docs/WORK_LOG.md). Current source-install results are recorded
separately from immutable-binary tests in the repository-root PUBLIC_VALIDATION.json.

This document summarizes an earlier architecture, debugging and packaging stage.
Its original test count and size figures are historical, not current release
measurements. Some filenames below refer to the pre-TypeScript implementation;
the current frontend uses `.ts`/`.tsx`. See [the public handoff](docs/WALKTHROUGH.md)
and the root PUBLIC_VALIDATION.json for the later baseline and limitations.

## 1. Structure and API Integration

The former roughly 2,900-line `frontend/src/App.jsx` was split into dedicated
hooks and UI components. The hooks separated layout/resizing/attachments,
workspace and file-tree state, saved conversations, runtime/configuration,
IDE integration, collaboration simulation, and chat/SSE/approval state.
The integrating hook is now [useAppState.ts](frontend/src/hooks/useAppState.ts).
Chat, file explorer, code view, terminal, settings and approval UI are separate
components under `frontend/src/components`.

The API client was corrected to include the `/api` prefix, avoiding HTML 404
responses where JSON was expected. The unused legacy Ollama executable and GPU
libraries were removed from the earlier package, and the local-model UI was
aligned with llama.cpp/GGUF. The historical removal was roughly 3.02 GB and the
then-remaining distribution was roughly 104 MB; neither is a current size claim.

## 2. Runtime and Agent Work

### llama.cpp Preflight and Process Handling

The runtime added preflight handling for a missing model selection, missing
GGUF file, missing server executable, an occupied TCP port and an existing
healthy llama.cpp server. Failures were propagated to the UI through structured
responses. GPU allocation failures could trigger a CPU-only fallback. Process
cleanup used the configured port/PID to avoid leaving the managed server behind.
See [llamaCppRuntime.js](src/runtime/llamaCppRuntime.js) for current behavior;
this historical description is not a change to performance or approval settings.

### Tool Calls and Orchestration

[toolParser.js](src/agent/toolParser.js) added ordered extraction of multiple
tool calls from one response. [orchestrator.js](src/agent/orchestrator.js)
executed the resulting queue and fed tool results back into the loop.
These were workflow changes, not new model training.

### Retrieval Scoring

The retrieval worker recorded file modification times. The earlier search
scoring included filename exact/prefix matches, recent-file bonuses and symbol
declaration matches. Reported historical bonuses were +100 for an exact filename,
+40 for a prefix, and +50/+20 for changes within one hour/24 hours.
Inspect the current [indexer](src/rag/indexer.js) before relying on those values.

## 3. UI and Packaging Fixes

- Session saving passed the messages array explicitly rather than passing the
  click event as conversation data.
- Memory entry handlers received the input value and setter explicitly.
- Chat submission forwarded attachments and their cleanup callback.
- Hook reference ordering used a ref/effect delegate to avoid a lint failure.
- An accidental empty root file named `{}` was removed.
- Local development config was removed from the packaged file list.

## 4. Historical Verification

That stage recorded 21 passing tests across tool parsing, orchestration,
configuration, file operations and terminal timeout/buffer behavior. The
recorded result was 21 tests, 3 suites and no failures; it is not the current
404-test baseline or a new run performed during documentation translation.

The release checker was introduced to combine syntax, unit tests, frontend
lint/build, resource presence and packaging consistency checks. The then-current
Vite build and NSIS packaging completed, and local Authenticode checks reported
Valid for the main/Setup executable on the build PC.

Local self-signed validation does not guarantee trust on other PCs. Read
[ROOT_CA_OPERATIONS.md](docs/ROOT_CA_OPERATIONS.md) for current signing caveats.
This translated historical summary does not establish production readiness,
resolve current dependency audit findings or certify cross-platform releases.
