# Pie built-in plugins

Pie ships task tracking, subagents, background shell jobs, structured user questions, Ponytail and a usage dashboard as built-in plugins. The terminal provides a rounded composer and dismissible Todo/Subagents panels stacked at the top right. It is a fork of [Pi](https://github.com/earendil-works/pi), originally created by Mario Zechner; the original MIT license is preserved.

## Configuration directory

Global configuration and runtime data live directly under `~/.pie`, with no `agent` subdirectory:

- `auth.json`, `models.json`, `settings.json`, `keybindings.json`
- `extensions/`, `skills/`, `prompts/`, `themes/`, `agents/`
- `sessions/` and `subagents/`

Project configuration lives in `<cwd>/.pie`. The workspace remains the session's current directory. Previous Pi and pi-ext directories are not automatically copied or loaded.

Override the directory with `PIE_CODING_AGENT_DIR`; override session storage with `PIE_CODING_AGENT_SESSION_DIR`. Old command names, directory names, and directory override variables have no compatibility fallback.

Reference documentation copied from upstream may still use `pi`, `~/.pi/agent`, `.pi`, `PI_CODING_AGENT_DIR`, or `PI_CODING_AGENT_SESSION_DIR`. Use the corresponding Pie command and locations above. SDK imports and internal npm package names remain `@earendil-works/*`; the package author remains Mario Zechner.

Run from a source checkout after installing dependencies with `npm install --ignore-scripts`:

```sh
./pi-test.sh
```

The CLI binary is only `pie`. The source helper keeps its `pi-test.sh` filename. See the [root README](../../../README.md#run-from-source) for source setup and local package installation. Upstream installers and upstream npm releases do not install this fork.

## Provider configuration

Run `/login` to configure a supported subscription or API key, then `/model` to choose a model. Provider API-key environment variables also work. Credentials are stored in `~/.pie/auth.json`; compatible endpoints and custom model definitions belong in `~/.pie/models.json`. Opening `/model` reloads that configuration.

See [Providers](providers.md) for authentication, [Models](models.md) for compatible endpoints and local models, and [Custom Providers](custom-provider.md) for extension-based integrations. Keep credentials private.

## Enable, disable, or replace plugins

Built-ins load by default in the CLI:

- `builtin:tasks`
- `builtin:subagents`
- `builtin:ask-user-question`
- `builtin:ponytail`
- `builtin:usage`
- `builtin:background`
- `builtin:retry`

Disable individual plugins in `~/.pie/settings.json`:

```json
{
  "extensions": ["-builtin:subagents", "-builtin:ask-user-question"]
}
```

`--no-extensions` disables built-in plugins as well. `-e builtin:tasks` explicitly loads a built-in. A file or package plugin registering a conflicting tool or command replaces the corresponding replaceable built-in, using the existing resource loader diagnostics.

The SDK follows the existing built-in extension pattern: add the factories explicitly to a `DefaultResourceLoader`, then bind extensions before running. Exports include `tasksExtension`, `createSubagentsExtension`, and `createAskUserExtension`.

## First-start model import

When interactive startup finds no Pie `models.json` but detects Pi's model configuration, it asks whether to import it. The prompt shows source and destination paths. Confirmation copies only `models.json` with private permissions; existing Pie files are never overwritten. Skip or Escape continues startup. Headless, help, version and model-list commands never prompt. Pi's `~/.pi/agent/models.json`, `~/.pi/models.json`, or an explicit `PI_CODING_AGENT_DIR` may be used as the import source; normal Pie operation still reads only `.pie`.

## Todo

Tools: `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`.

Tasks start as `pending`; use `in_progress` during work and `completed` only once the work is complete. `status: "deleted"` deletes a task. Dependencies must exist and cannot form a cycle. A blocked task cannot enter progress or complete. Metadata merges; a null value deletes that metadata key.

State is stored as session custom entries and reconstructed from the active branch. Tree navigation restores the tasks belonging to that point; compaction does not erase the task state. In-memory sessions remain in memory.

`/tasks` and `/todos` open the floating Todo panel in the TUI and show task details in other modes. The panel appears at the top right when tasks exist without taking keyboard focus. An empty list stays hidden; deleting the last task closes the panel. Lists show at most ten entries, ordered as in progress, pending, then completed. When more than ten records exist, the oldest completed tasks are removed and their dependency links are cleared. Unfinished tasks are never removed automatically; overflow remains accessible with `view all` when more than ten unfinished tasks exist. It shows task subjects; click a task for its saved requirements or `[x]` to close. Task updates do not reopen a dismissed panel; `/tasks` reopens it.

## Subagents

Tools:

- `Agent`: start a bounded delegated run, defaulting to `worker`.
- `list_subagents`: available definitions and session runs.
- `get_subagent_result`: retrieve a run, optionally joining it.
- `steer_subagent`: guide a running agent at a tool boundary.
- `stop_subagent`: stop queued or running work.
- `TaskExecute`, `TaskOutput`, `TaskStop`: connect a task with an `agentType` to a delegated run.

TUI and RPC sessions default to background execution and receive completion notifications. Print and JSON invocations default to foreground execution; they cannot leave a child running after their process exits. Set `run_in_background: false` explicitly to join an Agent run. Four runs execute concurrently; additional runs queue. The default turn limit is 30. Errors, cancellation, or truncated output do not complete linked tasks.

`TaskOutput` defaults to waiting up to 30,000ms. Its `timeout` is in milliseconds, up to 600,000; `block: false` or `timeout: 0` returns current state immediately.

Each subagent uses its own `AgentSession`, inherits the parent's selected model and reasoning level, and can only use parent-provided coding tools. Child tool execution goes through the parent's tool hooks, preserving tool restrictions and sandbox replacements. This is a tool and context boundary, not an operating-system sandbox. Researcher/reviewer instructions prohibit edits, but shell access itself is not an enforced read-only filesystem boundary.

Runs are session-owned. Quit, reload, session replacement, and tree navigation stop active work; unfinished restored runs are marked interrupted. Saved child sessions can be continued with `Agent.resume`; in-memory runs cannot be resumed after disposal. Results stored in parent records are bounded to 32KiB; saved child sessions retain the complete transcript. `inherit_context` passes at most 50KiB of text history and omits image attachments.

Provider-reported child usage is recorded through `pi.appendUsage()` once. Reading the result again does not add usage.

The `Agent` tool row shows its invocation description rather than listing prompt, model, and execution options. Result queries use the saved run's description; expand either row to inspect all parameters. The Subagents panel has a fixed `Subagents` heading; each run row shows its own description. Subagents float at the top right below Todo, with each run on its own row showing a description, status icon, and elapsed time. When Todo is absent or closed, Subagents move up. Empty run lists stay hidden. Each panel has a close button. Tool calls stay on separate rows. Click an entry to open its own conversation, including instructions, Thinking, tool calls, and answers; close or press Escape to return to the parent. Extra runs have an explicit `+N` entrance. The panel and `/agents` show running agents first, then queued agents, failed/stopped/interrupted agents, and completed agents last. At most ten rows are shown; smaller terminals show fewer. Above ten records, the oldest successful completions are removed from the active list. Running, queued and unsuccessful runs are preserved. Cleanup is saved on the session branch; it does not delete child-session files or change recorded usage. `/agents` retains result, stop, and steering actions.

### Agent definitions

Built-in profiles: `worker`, `researcher`, `reviewer`.

User definitions: `~/.pie/agents/*.md`. Trusted project definitions: `.pie/agents/*.md`. Project definitions override user and built-in names only in a trusted project.

```markdown
---
name: docs-reviewer
description: Review documentation for technical errors
tools: [read, bash]
model: openai/gpt-6.1-sol
thinking: high
---
Review the delegated documentation without changing files.
Return actionable findings with file references.
```

`model` and `thinking` are optional. Tools are coding-tool names; the parent loadout remains the upper bound. An empty tools list creates a text-only agent. Orchestration tools are excluded to prevent recursive delegation.

## Ask user

Tool: `ask_user_question`. Use a `questions` array even for one question:

```json
{
  "questions": [
    {
      "header": "Approach",
      "question": "Which implementation should we use?",
      "options": [
        { "label": "Small patch (Recommended)", "description": "Reuse existing components" },
        { "label": "Refactor", "description": "Replace the underlying structure" }
      ]
    }
  ]
}
```

Supports 1–4 questions with 2–4 options each, multi-select, a built-in `Type something.` row, cancellation, and single-select Markdown previews. Do not author `Other`, `Type something.`, or `Next` options. Header limit: 16 characters. Label limit: 60 characters.

Wide TUI questionnaires place options and previews side by side; narrow views stack them. Free-text input uses the native input component and preserves the host's cursor and keybindings. RPC uses select/input dialogs. Non-interactive modes leave the tool inactive; a direct call without UI returns an error stating that the user never saw the questions. Cancellation is not approval.

The schema, validation, normalization, response format, and RPC behavior are adapted from [rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono/tree/2d88b79c08ce19ffeecbe85d5ee1071046b708c0/packages/rpiv-ask-user-question). The view is adapted to this fork's native components and keybindings. The [MIT notice](third-party/rpiv-ask-user-question-LICENSE) is included. No rpiv-config or internationalization dependency is required.

## Retry

The replaceable `retry` plugin owns automatic retry while it is loaded. It retries every failed assistant turn except context overflow, which compaction handles. A response cut off at the output token limit is continued, and a turn that ends with no usable output is nudged once.

`retry.enabled` (default true) is the master switch; it is also what the RPC `set_auto_retry` command toggles. With it off, no automatic retries, continuations, or nudges run. The plugin disables Pie's built-in agent-turn scheduler through `pi.setNativeRetryEnabled(false)`, so exactly one backoff schedule owns a failure. Provider request retries and compaction retries are unaffected, and `retry.provider.*` still applies.

Configure the schedule under `pieRetry` in `~/.pie/settings.json` (project settings override matching global values):

```json
{
  "pieRetry": {
    "baseDelayMs": 2000,
    "maxDelayMs": 60000,
    "multiplier": 2,
    "maxRetriesAtMaxDelay": 3,
    "maxContinuations": 10,
    "retryContinuations": true,
    "retryEmptyStop": true,
    "messageFreeRetries": false,
    "subagents": {
      "enabled": true,
      "maxRetriesAtMaxDelay": 3,
      "match": { "systemPromptRegex": [{ "pattern": "<active_agent name=\"[^\"]+\"/>", "flags": "" }] }
    }
  }
}
```

`baseDelayMs` is the first retry delay, `multiplier` grows it, `maxDelayMs` caps it, and `maxRetriesAtMaxDelay` stops the loop after that many failures at the cap. `maxContinuations` bounds output-limit continuations; `retryContinuations` and `retryEmptyStop` disable those two behaviors. Invalid values are ignored with a warning.

`messageFreeRetries` (default false) keeps upstream's one hidden `Retry the previous request.` message. Set it to true to omit the failed response from the model projection with a durable `context_edit` instead, so the provider receives the same request again. The failed attempt stays in the session transcript in both modes.

`subagents.match.systemPromptRegex` selects a separate retry policy for sessions whose effective system prompt matches any rule. Every schedule field above can be overridden under `subagents`, and `subagents.enabled: false` lets a matched session keep Pie's built-in scheduler instead. Omitted fields inherit the main policy, a project matcher list replaces the global one, and an invalid rule is ignored with a warning rather than matching every session.

Permanent failures (invalid key, unknown model) and quota, session-limit, or budget exhaustion are retried like any other error, but their first notice states that the retry cannot succeed until the underlying problem is fixed. `maxRetriesAtMaxDelay` keeps that bounded.

`/retry` retries the last failure manually, `/retry status` prints per-category counters, the active policy, and the retry mode, and `/retry reset` clears them. While a backoff is pending the footer shows the attempt and remaining delay; new input or a session shutdown cancels it.

Context overflow is never retried in place: compaction reduces the context and retries once. Providers strip a failed assistant turn from the request payload, so in the default mode the retry re-sends the same request with one hidden message; with `messageFreeRetries: true` the failed response is removed from the model projection instead. Either way the failed attempt stays in the session file.

Subagent children do not load built-in extensions, so the matcher normally selects ordinary sessions; a child created by an extension that itself loads this plugin is matched by its own system prompt. The port is adapted from [pi-retry](https://github.com/monotykamary/pi-retry) 0.11.2; its [MIT notice and the list of deliberate differences](third-party/pi-retry/NOTICE.md) are included. Disable it with `-builtin:retry` or replace it with another plugin registering `/retry`.

## Background shell jobs

Tools: `bg_run`, `bg_status`, `bg_logs`, `bg_kill`. `/jobs` lists this session's jobs; `/jobs <id>` opens output. `bg_run` requires `command` and a short `name`, with an optional `description`, `shell` (`bash` or `powershell`), `timeoutSeconds`, `notifyOnCompletion` and `triggerOnCompletion`. Bash uses Pie's existing shell path and command prefix. Jobs require a persistent TUI or RPC session.

Background jobs float below Todo and Subagents without taking keyboard focus. The panel prefers active jobs, shows up to five entries even when all have finished, and retains overflow behind `view all`. Click a row to inspect its command and bounded output. Closing the panel does not stop jobs; `/jobs` reopens it.

Combined stdout/stderr is stored privately under `~/.pie/tasks/<session>/shell-<activation>/`. Each log is capped at 20MiB; exceeding the cap stops the job. `bg_logs` reads at most 50KiB and returns the full path. Completion notifications follow output closure and cleanup; they start a follow-up turn by default. Continue independent work or end the turn instead of polling. Disable notification or automatic follow-up per launch when appropriate.

Shutdown, reload and session replacement stop owned process trees. Saved PID files never grant ownership after a reload. Normal extension permission hooks apply to `bg_run`; a disabled or replaced shell is rejected. The feature uses ordinary user permissions and is not an operating-system sandbox. See the [ISC attribution and integration boundary](third-party/pi-background-tasks/NOTICE.md), including the low-level SDK override limitation. Separate upstream Fusion/delegate/attestation systems are outside this shell port.

## Usage dashboard

`/usage [day|week|month|total|cal]` opens the recorded token and cost dashboard. It groups usage by provider/model, supports period navigation and rescanning, and includes a calendar heatmap. Non-interactive modes write the table or calendar to stderr. It reads Pie's session directory, including directory overrides, and makes no provider or subscription-quota requests. Keyboard shortcuts are configurable under `app.usage.*` in `keybindings.json`.

The implementation is adapted from [pi-usage](https://github.com/chocotan/pi-usage) 0.2.0, with its [MIT license and attribution](third-party/pi-usage/NOTICE.md) preserved. Disable it with `-builtin:usage` or replace it with another plugin registering `/usage`.

## Terminal behavior

- The conversation uses the full terminal width. There is no application sidebar.
- Todo, Subagents and background jobs are non-capturing floating panels at the top right, in that order. They hide when empty. Closing a panel removes its space.
- Rounded input borders show current run status/time on the left.
- Token and context statistics use the original Pi footer, including input/output, cache reads/writes, cache hit rate, cost, and right-aligned model/thinking. Directories outside Git repositories have no branch placeholder.
- Active Thinking content expands while it streams and collapses when the next phase starts. Explicit manual and global visibility choices are respected. Thinking and tool headers remain visible in both states; click again to collapse.
- Built-in coding tools accept an optional `description` containing the purpose of that invocation. Tool titles show this purpose instead of raw command/parameter text; expanded views retain the complete original command and arguments. Calls without a description keep their existing command/path summary.
- Tool titles begin with the status dot and purpose, without an expansion arrow. Click the title or use the tool expansion shortcut to show or hide details; hover remains the clickable affordance.
- Tool and subagent states use a shared animated dot spinner while queued or running, a green `●` on success, a red `●` on failure, and a muted `●` for stopped or interrupted subagents. Durations appear once in the title, use milliseconds below one second, and hide zero. Expanded output follows its title directly. Consecutive visible tool calls have no blank rows between them; the first tool after text keeps one leading blank row. This layout applies to both the parent transcript and subagent details. A single tool expansion shortcut follows the transcript.
- In fullscreen mode, clickable tool/thinking titles, Todo/Subagent entries, overflow links, and close buttons highlight on hover without changing keyboard focus. A system theme with transparent selection backgrounds uses an underline instead. Moving away, scrolling, starting a selection, resizing, or switching overlays clears the highlight.
- User messages keep the theme's default user background.

Plugins can add composer widgets independently:

```ts
pi.on("session_start", (_event, ctx) => {
  ctx.ui.setWidget("my-plugin.jobs", ["Jobs", "No running jobs"], { placement: "aboveEditor" });
});
```

Clear the widget with `ctx.ui.setWidget("my-plugin.jobs", undefined)`. Components can implement mouse handling. Floating widgets use `{ placement: "floating", order: 10 }`; lower order values appear first and updates do not reorder them. These widgets share a non-capturing overlay without tying plugins to each other. Temporary detail views use `ctx.ui.custom()` with overlay options.

## Related migration assessment

The shell portion of [pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks) is included as the replaceable `background` built-in. See `docs/design/pi-background-tasks-assessment.md` for the original scope assessment; Pie's current paths and floating placement above supersede its earlier sidebar/pi-ext references.
