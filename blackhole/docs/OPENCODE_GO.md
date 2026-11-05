# OpenCode Go

OpenCode Go is separate from the generic `opengo:*` compatible gateway.
Select the OpenCode Go Settings tab, enter a Go-specific key locally, sync
the model list, and use the authentication test before activating a model.
Tests make real short requests and may consume provider usage. A successful
public model-list fetch is not proof of key validity or model entitlement.

## Configuration

- Model IDs use `opencode-go:<model-id>`; local GGUF remains selectable.
- `opencodeGoApiKey` is kept in the existing encrypted secret store, not the
  public config. API/UI responses mask credentials. No key is included here.
- `opencodeGoModelMaxTokens` supports separate positive integer output limits
  per model. Absent overrides inherit existing common/phase limits; upstream
  model/provider limits and billing still apply.
- Output-limit failures expose the affected model and effective budget.
  Explicitly saving a new model limit and resuming uses that checkpoint;
  it does not change unrelated models or replay partial output automatically.
- Reasoning records are separate from visible assistant messages and are not
  inserted back into model history as display text.

## Protocols and State

See `src/runtime/openCodeGoRuntime.js`, `goModelCatalog.js`,
`nativeGoTools.js`, `googleToolAdapter.js` and their tests.

The runtime handles Chat Completions, Responses, Anthropic Messages and Google
GenerateContent. Catalog metadata and observed request results determine
protocol and availability state. Credentials are sent only to the configured
supported provider endpoints, not arbitrary URLs from model metadata.
Catalog membership, authentication failures, explicit model rejection and
temporary request failures are distinct states. Catalog refresh alone does
not replace the selected model or stored credentials.

When Retry-After cannot fit the remaining request deadline, the runtime returns
the original quota/rate error without waiting beyond that budget. Same-model
compaction quota failures do not trigger a duplicate planner request. These
changes do not bypass provider limits, switch models or enable paid overage.

Cancellation, request deadlines, truncated responses, partial output and
upstream HTTP/SSE failures are preserved. Timeout diagnostics identify request
phase, budget, partial output and retry information. Native tool arguments
are assembled before execution and still pass through the existing registry,
validation and approval mechanism. No prompt censorship or approval policy
change is introduced by this public source export.

## Verification Scope

Unit tests cover protocol, catalog, streaming, token-budget and cancellation
behavior. Live checks need your own Go account and consume provider usage;
model access and availability can change. Historical local stability results
are summarized in [WORK_LOG.md](WORK_LOG.md). Private raw account diagnostics
and conversations are excluded; they are not independent public benchmarks.

Provider reference: [OpenCode Go](https://opencode.ai/docs/go/).

## Stabilized-31 Coding Validation

Eight real GLM 5.3 Flash tasks used the product's default behavioral verifier,
unchanged existing assertions and diagnostic context/output 8192. They are small
seeded tasks, not all-model certification. Missing tests leave supported source
changes incomplete/unverified rather than passing on syntax alone.
See [versioned evidence](../../docs/validation/stabilized-31.json).
