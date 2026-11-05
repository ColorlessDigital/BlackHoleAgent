# Autocomplete, Real Repo Eval, And PR Checks

Current public source baseline: stabilized31. The mechanisms below describe
available evaluation tooling, not a fresh full-corpus or all-model result.
[Public validation](../../PUBLIC_VALIDATION.json) and [versioned evidence](../../docs/validation/stabilized-31.json)
identify what was actually executed. Visible extension-host E2E remains separate.

This document defines the product-grade evaluation layer added on top of the BlackHole agent core.

## Autocomplete Engine

Autocomplete is intentionally separate from the agent loop.

- Backend engine: `src/ide/autocompleteEngine.js`
- API:
  - `POST /api/ide/autocomplete`
  - `POST /api/ide/autocomplete/feedback`
  - `GET /api/ide/autocomplete/metrics`
  - `POST /api/ide/autocomplete/benchmark`
- VS Code bridge:
  - 100-300ms debounce clamp
  - prefix/suffix/FIM payload
  - current file imports and symbols
  - multi-line insertion
  - accepted/rejected feedback tracking

Benchmark command:

```powershell
npm run benchmark:autocomplete
npm run benchmark:autocomplete -- --real-model --model <models>\model.gguf
```

Reports are stored under `data/autocomplete-runs`.

## Real Repository Evaluation

The real repo framework separates fixture preparation from evaluation reporting.

- Fixture manifest: `benchmarks/real-repos/repos.json`
- Task matrix: `benchmarks/real-repos/tasks.json`
- Report script: `scripts/real-repo-eval.js`

Commands:

```powershell
npm run eval:real-repos -- --summary-only
npm run eval:real-repos -- --prepare --max-repos=3
```

The summary reports:

- fixture readiness
- task type distribution
- pass@1 / solve-rate / tool-failure-rate / rollback-rate
- indexing time and memory for prepared worktrees
- Qwen, DeepSeek, CodeLlama, Mistral, deterministic, and other model family comparison
- automatic failure buckets

## PR Check Rules

PR checks are source-controlled in `.blackhole/checks/*.md`.

Supported directives:

- `level: must-pass | warning`
- `changed-only: true | false`
- `applies-to: glob`
- `forbid-text: literal`
- `warn-text: literal`
- `require-file: path`
- `require-script: command`

Command:

```powershell
npm run check:pr-diff -- --format=all --output-dir=data/pr-checks/latest
npm run pr:check -- --skip-vsix
```

Outputs:

- `data/pr-checks/latest/pr-check.json`
- `data/pr-checks/latest/pr-check.md`
- `data/pr-checks/latest/pr-check.sarif`

`must-pass` findings fail the check. `warning` findings are reported but do not block.
