# BlackHole Agent Portfolio Demo

This document is a prompt-ready demo script for showing BlackHole as a local llama.cpp-based autonomous coding agent.

## Positioning

BlackHole is a local desktop agent that combines file tools, terminal execution, code intelligence, patch transactions, targeted verification, project memory, model-route profiles, and web/HTTP inspection tools. The current goal is not to beat Codex or Antigravity as a hosted product, but to demonstrate a credible local agent architecture with observable control loops and portfolio-grade engineering decisions.

## Core Capabilities To Demonstrate

1. Local runtime
   - llama.cpp server path is embedded under `resources/llama.cpp`.
   - GGUF model path is user-selected.
   - Model routing profiles select planner, coder, verifier, and summarizer settings without changing the main agent loop.

2. Agent control loop
   - PLAN, ACT, OBSERVE, VERIFY, REPAIR, SUMMARIZE lifecycle is visible in the timeline.
   - Tool calls support JSON format with legacy XML compatibility.
   - Repeated identical tool calls are blocked by a loop guard and converted into a repair prompt.

3. Code intelligence
   - Workspace scan indexes symbols, imports, references, call graph edges, diagnostics, and impacted tests.
   - `inspect_code_context` exposes summary, outline, references, call graph, diagnostics, and verification target modes.

4. Safer multi-file editing
   - `review_patch_transaction` previews multi-file edits without changing files.
   - `apply_patch_transaction` applies the same operation list with rollback behavior on failure.

5. Verification
   - Syntax checks target changed JavaScript files where possible.
   - Test selection prefers impacted tests instead of always running the entire suite.
   - Missing optional lint/build tooling is reported as skipped rather than crashing the agent.

6. Project memory
   - Durable memory stores prior decisions, run summaries, fixes, and handoff notes.
   - The agent retrieves relevant memory into the system prompt.
   - Memory status is visible in the timeline.

7. Web and monitoring support
   - Search, HTTP fetch, HTML inspection, browser rendering, crawling, and monitoring are exposed as tools.
   - These tools support security-monitoring style analysis without forcing the whole product to become a narrow SOC-only tool.

8. VS Code bridge
   - `<repo>\vscode-blackhole` provides a real VS Code extension with sidebar and editor-native entry points.
   - The extension connects to `/api/bootstrap`, syncs the current VS Code workspace through `/api/workspace`, streams `/api/chat`, attaches editor selections, and resumes the latest checkpoint.
   - Native IDE APIs expose `/api/ide/autocomplete` and `/api/ide/inline-edit` for local-model code completion and selected-code rewrites.
   - VS Code registers inline completion, inline edit, diagnostic quick-fix, diff review, context-menu, and CodeLens entry points.
   - The app's IDE integration route installs the packaged `resources/vscode/vscode-blackhole.vsix` before launching VS Code, with source-copy fallback for development.
   - Agent patch transactions can be reviewed, accepted, rejected, and rolled back from VS Code through the existing `/api/diff/transactions` API.
   - Full agent tasks can be launched from VS Code with or without the selected code attached, then handed off to diff review when new patch transactions are created.

9. MCP compatibility layer
   - BlackHole can connect to external stdio MCP servers from `.blackhole/mcp.json` or `.blackhole/config.yaml`.
   - External MCP tools are registered into the agent tool registry as `mcp__server__tool`.
   - MCP tool permissions can be controlled per tool, per server, or globally with `allow`, `ask`, and `block`.
   - Context7, Playwright MCP, and GitHub MCP templates are provided as disabled defaults.
   - BlackHole can expose its own internal tools as an MCP server through `node src/mcp/blackholeMcpServer.js` or packaged `blackhole.exe --mcp-server`.

10. Productized agent UX
   - The main workspace separates Chat, Edit, Agent, and Autocomplete modes with prompt templates.
   - The right-side operational panel exposes first-run setup, diff review, model benchmark reports, and CI/PR checks.
   - Diff review supports review, accept, reject, and rollback transactions through backend APIs.
   - Model benchmark reports group E2E records by model and solve-rate.
   - The first-run setup panel guides workspace, llama-server.exe, GGUF model, runtime start, and IDE bridge setup.

## Demo Flow

1. Configure a GGUF model path in settings.
2. Start llama.cpp from the app or with `start_llama_cpp`.
3. Ask the agent to inspect a small bug in a sample project.
4. Confirm the timeline shows a model route, project memory lookup, task graph, tool execution, and targeted verification.
5. Ask for a multi-file change and watch the agent use patch transactions.
6. Run the deterministic local benchmark:

```bash
npm run benchmark:agent
```

7. Run the end-to-end coding task corpus:

```bash
npm run eval:agent
```

Validate that the E2E corpus contains the expected 30-50 task range:

```bash
node scripts/check-e2e-corpus.js
```

Run the full 50-case deterministic solve-rate measurement and record it:

```bash
node scripts/agent-e2e-eval.js --keep-going --record --max-cases=50
```

Use the configured local model for the same task set:

```bash
node scripts/agent-e2e-eval.js --real-model --keep-going --record --max-cases=50
```

Run a single real-model smoke case with an explicit GGUF path:

```bash
node scripts/agent-e2e-eval.js --real-model --model="<models>\Qwen_Qwen3-4B-Instruct-2507-Q8_0.gguf" --max-cases=1 --keep-going --record
```

Run the large-repository code-intelligence stress check:

```bash
npm run stress:code-intelligence
```

8. Validate the VS Code extension bridge:

```bash
node scripts/check-vscode-extension.js
```

Install the extension into the local VS Code extensions directory:

```bash
node scripts/install-vscode-extension.js
```

Package the VS Code bridge as a `.vsix`:

```bash
node scripts/package-vscode-extension.js
```

Run the VS Code extension-host E2E bridge test:

```bash
node scripts/test-vscode-extension-e2e.js
```

The extension-host E2E covers command registration, bootstrap/workspace sync, checkpoint resume streaming, selection commands, inline edit replacement, and manual completion insertion against a mock BlackHole API.
It also covers diff transaction review, accept, reject, rollback commands, and direct IDE-launched agent tasks against the same mock API.

Manual extension compile:

```bash
<repo>\node-v24.21.0-win-x64\node.exe <repo>\vscode-blackhole\node_modules\typescript\bin\tsc -p <repo>\vscode-blackhole
```

9. Run the release gate:

```bash
npm run release:check
```

10. Run the browser visual check for the built frontend:

```bash
npm run visual:frontend
```

11. Run the PR/CI gate:

```bash
node scripts/pr-check.js
```

12. Validate the MCP compatibility layer:

```bash
npm run mcp:server
node --test src/mcp/mcpConfig.test.js src/mcp/mcpClient.test.js
```

## Portfolio Talking Points

- The architecture separates durable memory, context indexing, model routing, verification, patch transactions, and UI timeline reporting.
- The agent keeps broad authority while adding operational guardrails that prevent no-progress loops and make execution auditable.
- The benchmark script is deterministic and does not require an LLM call, so evaluators can verify key subsystems quickly.
- The 50-case E2E corpus produces a visible solve-rate record under `data/eval-runs`.
- The VS Code bridge ships as a packaged `.vsix` inside BlackHole resources and as a copied `dist` artifact for manual inspection.
- The MCP layer lets BlackHole consume standard tool servers and expose BlackHole tools to other MCP hosts.
- CI/PR mode gives evaluators a single command for syntax, tests, corpus shape, solve-rate smoke, extension validation, and VSIX package checks.
- Remaining gap versus production-grade hosted agents is model quality, long-horizon planning, tool-use reliability across unknown repos, and large-scale evaluation coverage.

## Next Improvement Targets

1. Add a benchmark corpus with real repositories and expected patches.
2. Add per-tool latency and success metrics to the timeline.
3. Add richer large-repository fixtures for semantic indexing stress tests.
4. Add release artifact smoke checks against the packaged executable.
5. Add a real-model benchmark matrix across multiple GGUF models and quantization levels.
