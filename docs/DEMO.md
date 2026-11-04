# BlackHole Demo Guide

Prompts, responses, logs and screenshots in this guide are public illustrations,
not copied personal conversations. The images and GIF use the real frontend with
**scripted API/SSE fixtures**. They do not establish live model performance.

## 1. Multi-File Editing

### Fixture and Expected Behavior

`examples/multi-file/before` and `after` use identical tests and package.json files.

| File | Deliberate bug | Expected behavior |
|---|---|---|
| `src/math.cjs` | Subtracts the inputs | Adds the inputs |
| `src/cart.cjs` | Ignores item quantities | Sums price multiplied by quantity |
| `src/label.cjs` | Produces lowercase | Produces uppercase |

Reproduce the fixture without a model, from the repository root:

```powershell
node --test examples/multi-file/before/check.test.cjs
# Intentional result: 3 failures, exit code 1
node --test examples/multi-file/after/check.test.cjs
# Expected result: 3 passes, exit code 0
```

### Try It with an Actual Agent

1. Copy the entire `before` directory to a separate temporary workspace. Preserve
   the original before/after examples for comparison.
2. Select that workspace and an available local GGUF or provider model in the app.
3. Send the request below. If an existing approval prompt appears, inspect the
   tool and target and make your own decision.
4. Independently check that the tests/package.json are unchanged and run the
   original tests to verify the implementation.

```text
Fix src/math.cjs, src/cart.cjs and src/label.cjs.
Do not change check.test.cjs or package.json.
Run the existing tests and report the edits and actual verification results.
```

Inspect the changed files, tool outcomes, real test exit code and evidence in the
answer. A claim that tests passed is not itself a test result. Outcomes depend
on the selected model and execution environment.

![Actual BlackHole UI with a scripted public multi-file task](images/overview.png)

## 2. Progress and Failure Recovery

The timeout in this screenshot is an injected documentation event, not a real
provider outage. You do not need to expose a credential or disrupt a real
network connection to reproduce the UI illustration.

![Scripted timeout reason and recovery checkpoint](images/recovery.png)

For an actual interrupted task:

1. Inspect progress, heartbeats and the last event. Distinguish slow inference
   from an explicit failure.
2. Check the provider, model, cause, partial-output state and checkpoint availability.
3. Address the actual cause: authentication, availability, limits or local setup.
4. Confirm the checkpoint, resume, and inspect the resulting files and tests again.

This does not guarantee automatic recovery from every error, disk corruption or
exactly-once external execution. Increasing an output limit can increase usage;
provider limits still apply.

## 3. Long Conversations and Larger Workspaces

```text
Inspect only the specified package and its existing tests first.
Keep the goal and edit scope intact; do not validate unrelated projects.
If interrupted, report the current state and the checkpoint to resume from.
```

Observe context use, compaction, status events and actual changes. Background
indexing has file/depth/time budgets; it does not index an entire drive without
limits. This is separate from explicitly requested file access.

To measure durability, fix the build, model, configuration and repository, and
retain original failures as well as successful retries. This guide is not a new
long-running or large-repository benchmark report.

## Reproduce the Images

Build the frontend and prepare Playwright Chromium, then run from the source root:

```powershell
Set-Location blackhole
npm run build:frontend
node node_modules/playwright/cli.js install chromium --only-shell
Set-Location ..
node tools/capture-docs.mjs
```

The script creates English PNGs and CAPTURE_REPORT.json under `docs/images`.
It uses a headless browser with fake API/SSE data, blocks external frontend
requests, and does not read real credentials, user data or model providers.
It does not capture or manipulate the user's desktop.

The GIF encodes the planning, editing and verification PNGs in sequence. It is
not a real inference recording or timing measurement. Regenerate it from the
same frames when updating the screenshots.
