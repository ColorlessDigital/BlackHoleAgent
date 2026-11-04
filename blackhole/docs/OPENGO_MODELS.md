# Externally Supplied Models via OpenGo

"OpenGo" is the legacy internal name of the generic OpenAI-compatible
gateway, not OpenCode Go. Its settings tab is now **OpenAI 호환 API**.
For the separate Go key/provider, see [OPENCODE_GO.md](OPENCODE_GO.md).

BlackHole runs these model families side by side:

| Prefix | Provider | Transport |
|---|---|---|
| `llamacpp:*` | Local GGUF through the bundled llama-server | managed process |
| `opengo:*` (`openai-compat:` alias) | Externally supplied models through an OpenAI-compatible gateway ("OpenGo") | HTTPS, unmanaged |
| `opencode-go:*` | OpenCode Go with a separate API key | model-specific Chat / Messages / Responses |

Any gateway that speaks `POST {baseUrl}/v1/chat/completions` works
(OpenAI, Ollama, vLLM, llama-server, corporate proxies).

## 1. Setup

1. Settings → **OpenAI 호환 API** tab.
2. Enable the provider, enter `baseUrl` (e.g. `http://127.0.0.1:8080`),
   optional Bearer `API key`, optional default model id.
3. **연결 테스트** — saves settings, probes `GET /v1/models`, and refreshes
   the catalog. The key is stored AES-256-GCM encrypted (`secrets.enc.json`),
   never in `config.json`.
4. Register models (id + display name + context/max tokens) or rely on
   gateway discovery. Save settings.

`activeModel` accepts `opengo:<model-id>` directly. Role profiles
(planner/coder/verifier/…) accept the same prefix per phase; empty still
inherits the active model, and the route reason records `inherit:` vs
`override:`.

## 2. Model picker

The chat header shows a model dropdown backed by `GET /models` (unified
catalog: local slot + discovered + registered). Switching saves
immediately. Next to it, a context meter shows the rough token estimate
(≈, client heuristic) against `contextLimit`, plus a **압축** button.

## 3. Usage accounting

Every `callLocalModel` funnel call (agent, collab, autocomplete,
inline-edit, compaction) records `{ model, tag, promptTokens,
completionTokens }` into `data/model-usage.json`:

- Server-reported `usage` is used when the gateway streams it
  (`stream_options.include_usage` is requested); otherwise the backend
  CJK/latin estimator fills in and marks the entry `estimated: true`.
- `GET /reports/usage` powers the reports-tab usage panel (per-model
  requests/tokens/call-site tags, totals). `DELETE /reports/usage` resets.

## 4. Context compaction

Two layers, both preserve the first message (user goal) verbatim:

1. **Sliding guard** (existing): trims tool results / middle turns past
   85% of the limit — lossy but instant, no model call.
2. **Summarization compaction** (new): when the conversation passes
   `contextCompactionThreshold` (default 0.9, tunable 0.5–0.98), the middle
   turns are replaced by one LLM-written brief (summarizer profile,
   usage tag `compaction`). Runs automatically once per PLAN cycle at most
   — after compaction the token count drops below threshold — and never
   fires on short sessions (< 8 turns).
3. **Manual**: the chat header **압축** button calls `POST /chat/compress`
   (stateless) and swaps the session history, keeping the welcome anchor.

Disable automatic compaction with `contextCompactionEnabled: false`
(Brain settings tab).

## 5. Troubleshooting

- `OpenGo 공급자가 설정되지 않았습니다` → baseUrl missing; fill it in.
- `HTTP 401` → wrong/expired API key.
- `HTTP 404 model_not_found` → model id mismatch; use discovered names.
- Picker empty → enable provider + run connection test; check gateway logs.
- Usage shows `estimated: true` only → gateway doesn't stream `usage`;
  still directionally correct for capacity planning.
