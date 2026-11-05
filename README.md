# BlackHole

**A local-first desktop coding agent with file tools, behavioral verification, and recoverable task state.**

BlackHole connects llama.cpp GGUF inference to a desktop development workflow:
inspect files, implement changes, run existing checks, and report the evidence.
OpenAI-compatible gateways and OpenCode Go are optional providers. BlackHole is
an execution system around a selected model, not a model trained by this project.

**[Download stabilized.31](https://github.com/ColorlessDigital/BlackHoleAgent/releases/tag/v1.0.0-stabilized.31)** |
[Project page](https://colorlessdigital.github.io/BlackHoleAgent/) |
[Demo guide](docs/DEMO.md) | [Developer handoff](blackhole/docs/WALKTHROUGH.md)

Windows x64 development prerelease. Model weights and API keys are not included.
Use `blackhole.exe` for portable execution or `BlackHole-Setup.exe` for installation.

![BlackHole desktop with public scripted example data](docs/images/overview.png)

> **Real build-31 frontend, scripted public data.** Screenshots and the GIF
> illustrate the interface; they are not live-model recordings or timing
> benchmarks. No personal conversation, credential, or user desktop is shown.

## What Changed in Build 31?

A successful syntax check is not a behavioral test. For supported source changes:

- Existing project test commands keep their runner, loader, and project scope.
- Without a declared command, bounded discovery can find existing standalone Node tests.
- Missing checks, zero executed tests, all-skipped suites, and recognized static-only
  commands do not qualify as behavioral success.
- Unavailable evidence stops as `incomplete / behavioral_verification_unavailable`.
  Edits and the checkpoint remain saved; missing tests do not trigger source-repair loops.
- Actual failing assertions continue through bounded repair and re-verification.
- Verification children do not inherit Node's internal test-runner context.

This does not prove arbitrary requirements or the quality of a project's tests.
Unknown successful project-declared test commands retain that evidence source.
The application does not automatically invent tests or create extra files merely
because a behavioral check is missing.

![Scripted illustration of saved changes with behavioral verification unavailable](docs/images/unverified.png)

## Capabilities

| Area | Current scope |
|---|---|
| Local inference | llama.cpp GGUF lifecycle, configurable GPU/context/output settings |
| Code work | File inspection and editing, terminal tools, scoped existing checks |
| Recovery | Progress heartbeats, execution journal, checkpoints, explicit resume |
| Long conversations | Routed context budgets, compaction, current-request evidence preservation |
| Workspace memory | Four recently used context engines under strong LRU cache ownership; weak sharing for active callers |
| Reasoning records | Model-supplied reasoning separate from visible answers |
| Integrations | Web tools, MCP, companion VS Code extension, optional cloud providers |

Four cached engines is not a RAM quota or a cap on active callers. Compiler
temporaries and allocator RSS can still rise. Local inference runs on the PC;
web tools, MCP services and cloud providers may communicate externally.

## Recorded Evidence, Not a General Benchmark

| Evidence | Result and scope |
|---|---|
| Maintainer's immutable build 31 | Backend 507 passed + 1 privilege-related skip, three consecutive runs; frontend 10/10 |
| Completion regression fixtures | 9/9, including correct **unverified** stops; the same build-30 baseline passed 2/9 |
| Real OpenCode Go tasks | 8/8: addition, empty-list mean, clamp, and a three-file task, each repeated twice |
| Real local GGUF coding | Qwen3 4B, 3/3 implementation fixes with existing immutable tests |
| Workspace retention control | 80 generated workspaces; bounded cache retention confirmed |
| Historical build 30 only | Natural-GC 60-minute run: 553/553, including one intentional cancellation |

The real build-31 tasks used the product's default verification engine, not a
diagnostic replacement. The Go comparison used GLM 5.3 Flash with diagnostic
context/output 8192. The GGUF coding cap was 4096. Saved settings were not changed.
These are small seeded tasks, not arbitrary-repository success rates.

[Build-31 evidence](docs/validation/stabilized-31.json) |
[Historical build-30 evidence](docs/validation/stabilized-30.json) |
[Fresh public-source checks](PUBLIC_VALIDATION.json) |
[Release history](docs/HISTORY.md)

The public-source checks are separately rerun after export; they are not the
maintainer's live-model tests. Build 31 has no new 60-minute soak or 35B coding
claim. Earlier failures remain historical failures.

## Try a Multi-File Task

```text
Fix src/math.cjs, src/cart.cjs and src/label.cjs.
Keep check.test.cjs and package.json unchanged.
Run the existing tests and report the actual verification results.
```

[Before/after examples](examples/multi-file) contain identical tests. Their
hand-authored before version fails three tests and the after version passes
three. They are reproducible fixtures, not evidence of live-model performance.
See the [demo guide](docs/DEMO.md) for verification, recovery and unverified cases.

<details>
<summary>Scripted workflow GIF</summary>

![Scripted planning, editing and verification in the build-31 frontend](docs/images/workflow-demo.gif)

</details>

## Architecture

![Models, tool execution, behavioral evidence and checkpoint recovery](docs/images/architecture.svg)

`blackhole/src` contains the Electron/backend agent and runtimes;
`blackhole/frontend` is the React/TypeScript UI. `vscode-blackhole` is the
companion extension. [Architecture and commands](blackhole/docs/WALKTHROUGH.md).

## Start from Source on Windows

From the complete repository root in PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/bootstrap-windows.ps1
$env:Path = (Join-Path $PWD 'node-v24.22.2-win-x64') + ';' + $env:Path
Set-Location blackhole
npm run build:frontend
npm start
```

Bootstrap downloads checksum-verified official Node 24.22.2 and llama.cpp b9553
Vulkan x64 archives and installs the three lockfile-defined dependency trees.
Internet is required for setup. Download GGUF weights separately and select an
existing model path in Settings. Model size, quantization, RAM/VRAM and settings
determine fit and speed. Enter provider keys locally, never in issues or source.
OS-encrypted credentials are not portable by simply copying them to another PC.

```powershell
npm test
npm --prefix frontend test
npm run release:check -- --skip-extension-e2e
npm run build:windows
```

Review [development and packaging](blackhole/docs/WALKTHROUGH.md) before building.
The signing script provisions a development CA on the **build PC**. It is not a
publicly trusted publisher identity. Build-31 Setup does **not** automatically
import/remove trust-store certificates. Legacy builds 13/14 did; their warnings
remain in [history](docs/HISTORY.md). [Certificate operations](blackhole/docs/ROOT_CA_OPERATIONS.md).

## Limits and Public Scope

This remains a development prerelease. Clean-Windows installation/upgrade,
cross-PC credential setup, visible VS Code extension-host E2E, and Linux/macOS
release validation are not certified. Development dependency advisories remain;
consult the current [audits](PUBLIC_VALIDATION.json), not the archived build-13 totals.

Public source includes tests, lockfiles, reproducible fixtures and build tools.
It excludes installed dependencies, models, runtime data, keys, conversations,
private raw diagnostics, developer signing keys and original private Git history.
Public validation is a sanitized summary, not a dump of internal logs.

## License

Copyright 2026 KGE7

Apache-2.0: [LICENSE](LICENSE), [NOTICE](NOTICE). Third-party licenses and marks
remain separate: [THIRD_PARTY.md](THIRD_PARTY.md). No provider affiliation or
endorsement is implied. Publication introduces no prompt censorship or approval
policy changes.
