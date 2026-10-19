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

- Catch-all error retry: any `stopReason: "error"` is retried except a small
  permanent-failure blacklist and quota, session-limit, or budget exhaustion.
- Capped exponential backoff with `baseDelayMs`, `maxDelayMs`, `multiplier`,
  and `maxRetriesAtMaxDelay`.
- Retrying a 400/413, credit, connection, stream-exhaustion, or unclassified
  error without compacting, and deferring real context overflow to compaction.
- Auto-continuation when a response stops at the output token limit, and one
  bounded nudge when a turn ends with no usable output.
- `/retry`, `/retry status`, and `/retry reset`.
- Category-aware diagnostics and the distinction between per-minute rate
  limits, pay-as-you-go balance errors, and hard quota or budget exhaustion.

## Deliberate differences from upstream

- **No SDK prototype patching.** Upstream wraps `AgentSession.prototype.bindExtensions`
  and `_prepareRetry` to suppress native retry. Pie instead runs this plugin on
  the public `agent_before_settle` boundary, which Pie reaches only after native
  retry and compaction declined to continue. Native retry therefore handles the
  errors it already classifies (with `settings.retry`), and this plugin covers
  everything else. Exactly one component retries a given failure, and no private
  method is monkey patched.
- **No hidden retry message for automatic error retries.** The failed response is
  omitted from the model projection with a durable `context_edit`, so the same
  request is re-sent. The failed attempt stays in the raw session history, as it
  does for native retry. Manual `/retry` still uses one hidden message because it
  starts from idle.
- **Settings live in `pieRetry`, not `piRetry`**, and are read from Pie's merged
  global and project settings (`~/.pie/settings.json`, `.pie/settings.json`).
- **`maxContinuations` (default 10) caps output-limit continuations.** Upstream
  continues without a limit; a cap avoids an unbounded paid loop.
- **No subagent matcher.** Pie's built-in subagents run children without built-in
  extensions, and those children already use Pie's native retry through their
  inherited settings, so a system-prompt matcher would have nothing to select.
- **Lifecycle events are not re-emitted.** Upstream emits `pi-retry:started`,
  `pi-retry:completed`, and `pi-retry:cancelled` for status integrations; nothing
  in Pie consumes them.
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
