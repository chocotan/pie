# pi-retry attribution

Vendored from **@monotykamary/pi-retry 0.11.2**, by **Tom X Nguyen**,
https://github.com/monotykamary/pi-retry, revision
`6483ab0f204076aa3ec385746ec1d58f0625cc76`.

The upstream repository declares `"license": "MIT"` and `"author": "Tom X
Nguyen"` in its `package.json` but ships no `LICENSE` file. [LICENSE](LICENSE)
reproduces the MIT text under that declared license and author. The upstream
`README.md`, `retry.ts`, and `src/{config,error-patterns,retry-logic}.ts` were
read as the source of the behavior below. No upstream code was copied verbatim;
the port is a rewrite against Pie's public extension API.

## What the port preserves

- Catch-all retry: every failed assistant turn is retried, except context
  overflow, which compaction owns.
- Capped exponential backoff with `baseDelayMs`, `maxDelayMs`, `multiplier`,
  and `maxRetriesAtMaxDelay`.
- Retrying a 400/413, credit, connection, stream-exhaustion, or unclassified
  error without compacting, and deferring real context overflow to compaction.
- Auto-continuation when a response stops at the output token limit, and one
  bounded nudge when a turn ends with no usable output.
- `/retry`, `/retry status`, and `/retry reset`.
- One hidden `Retry the previous request.` message for an automatic error retry,
  which is upstream's default retry mode (`messageFreeRetries: false`).
- `subagents.match.systemPromptRegex`, which selects a separate retry policy for
  sessions whose effective system prompt matches one of the rules.
- Category-aware diagnostics and the distinction between per-minute rate
  limits, pay-as-you-go balance errors, and hard quota or budget exhaustion.
- Single retry ownership: the plugin disables Pie's built-in agent-turn
  scheduler while it is loaded, so only one backoff schedule runs.

## Deliberate differences from upstream

- **No SDK prototype patching.** Upstream wraps `AgentSession.prototype.bindExtensions`
  and `_prepareRetry`. Pie instead exposes `pi.setNativeRetryEnabled(false)`, a
  supported extension action, and runs the backoff on the public
  `agent_before_settle` boundary. Ownership, single-schedule behavior, and the
  preserved compaction handling are the same; no private method is monkey
  patched.
- **Permanent failures and quota exhaustion are retried.** Upstream detects
  invalid keys, unknown models, and quota/session-limit/budget exhaustion and
  stops with a notification. Pie retries them like any other error, as
  requested for this fork, and the first notice says the retry cannot succeed
  until the underlying problem is fixed. `maxRetriesAtMaxDelay` keeps it
  bounded, and `retry.enabled: false` stops automatic retry entirely.
- **`retry.enabled` is the master switch.** Upstream ignores Pi's `retry`
  object. Because Pie suppresses the built-in scheduler, that setting (and the
  RPC `set_auto_retry` command that writes it) is the documented way to turn
  automatic retry off. Provider request retries and compaction retries keep
  using `retry.provider.*`.
- **Retry mode is selectable.** The default queues one hidden
  `Retry the previous request.` message at the settle boundary, as upstream does.
  `messageFreeRetries: true` instead omits the failed response from the model
  projection with a durable `context_edit`, so the same request is re-sent. The
  failed attempt stays in the raw session history in both modes. Manual `/retry`
  always uses one hidden message because it starts from idle.
- **Settings live in `pieRetry`, not `piRetry`**, and are read from Pie's merged
  global and project settings (`~/.pie/settings.json`, `.pie/settings.json`).
- **`maxContinuations` (default 10) caps output-limit continuations.** Upstream
  continues without a limit; a cap avoids an unbounded paid loop.
- **Subagent matcher scope.** `pieRetry.subagents.match.systemPromptRegex`
  compiles to rules that are tested against the session's effective system
  prompt. A match switches that session to the subagent policy, which may set
  its own limits and may opt out of the takeover entirely with
  `subagents.enabled: false`. Pie's own built-in subagents run children without
  built-in extensions, so the matcher selects ordinary sessions or children
  created by extensions that do load this plugin. An invalid rule is ignored
  with a warning rather than matching every session.
- **Lifecycle events use Pie names.** Upstream emits `pi-retry:started`,
  `pi-retry:completed`, and `pi-retry:cancelled`; this port emits
  `pie.retry-started`, `pie.retry-completed`, and `pie.retry-cancelled` with the
  same `{ retryId }` payload.
- **Backoff slices.** A backoff is awaited in 250ms slices so new input or a
  session shutdown cancels it promptly. Escape (abort) is honored when the
  boundary returns, so an abort during a backoff takes effect after at most the
  configured `maxDelayMs`.

## Known limits

- Retrying 400/413 without reducing context can keep failing while the payload
  is genuinely too large.
- A persistent failure is retried until the `maxRetriesAtMaxDelay` budget is
  exhausted; use `/retry reset` or Escape to stop earlier.
- The plugin is a retry scheduler, not a provider-level fix: it cannot succeed
  against an invalid key, a missing model, or an exhausted plan.
