# Continue watchdog

Keep a session working until the work is actually finished. After a run settles
and everything stays idle for ten seconds, the watchdog asks the model — in a
private forked child session — whether to continue or to stop for a real reason,
and then continues in the main session.

The watchdog is **off by default**. It does nothing until you enable it for the
current session.

## Enable and disable

```bash
/lock-continue-watchdog                     # enable this session, fresh cycle
/unlock-continue-watchdog [reason]          # disable this session
/status-continue-watchdog                   # why it is or is not asking
/continue-timeline                          # key watchdog events on this branch
```

The opt-in is live per-session state and is never written to settings or the
session file. Disabling is a **soft unlock**: it stops further inquiries and
releases the lock, but it never aborts a continuation that is already running,
so the task in progress finishes. An inquiry that is still open is cancelled.

`Alt+U` unlocks too; configure or disable it with `unlockShortcut`.

## What a cycle does

1. **Qualify idle.** Real user work, or `/lock-continue-watchdog`, starts a
   cycle. Every loaded attachment in this process counts as activity. A fixed
   ten-second fence after the last activity must expire before anything is
   asked.
2. **Ask privately.** The model gets the full active conversation in a forked
   child session with the same provider, model, and thinking level. Its only
   allowed effect is one guarded `write` of a `decision.json` file in a private
   `/var/tmp` directory; the file is the only accepted result. Prose, shell
   commands, and other files are rejected, and an invalid result gets at most
   two corrections in the same child.
3. **Validate.** `action` is `continue` or `unlock`. The reason type must match
   the action's configured list. Defaults: `WORK_REMAINS` and `VERIFYING` for
   continue; `JOB_DONE`, `WAIT_USER`, `JOB_BLOCKED`, and `WAIT_CALLBACK` for
   unlock.
4. **Act.** A `continue` publishes a timestamped message into the main session
   and starts ordinary work there. An `unlock` stops the watchdog, except
   `WAIT_CALLBACK`, which keeps the lock and waits for external callback work
   without polling.
5. **Repeat** while budget remains. Each accepted continuation and each
   `WAIT_CALLBACK` suspension spends one unit of `maxContinue` (default 10).
   Corrections, cancellations, and stale results spend none.

An inquiry that fails to execute, or three invalid answers in one inquiry, stops
automatic requests and reports the failure instead of continuing.

The private fork needs a persisted session file, so it asks nothing in a brand
new session before the first turn has been written.

## Unlock review

Review is optional and on by default. If the `pi-llm-as-jev` review service is
loaded, a valid `unlock` candidate is sent to it as a second opinion. A challenge
lets the same child reconsider once. A missing or incompatible service warns and
releases the original candidate unreviewed.

## Configuration

Later layers win field by field: built-ins, then
`$PIE_CODING_AGENT_DIR/pi-continue-watchdog.json` (normally
`~/.pie/agent/pi-continue-watchdog.json`), then trusted project
`.pie/pi-continue-watchdog.json`. Invalid values keep the lower-precedence value.

```json
{
  "maxContinue": 10,
  "reasonTypes": ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED", "WAIT_CALLBACK"],
  "continueReasonTypes": ["WORK_REMAINS", "VERIFYING"],
  "unlockShortcut": "alt+u",
  "unlockReviewEnabled": true
}
```

`decisionPrompt` and `continuePrompt` override the built-in wording (each at
most 16,384 code points).

## Differences from the upstream package

This is [pi-continue-watchdog](https://github.com/xz-dev/pi-continue-watchdog)
(BSD-3-Clause) built into Pie. Its source is vendored under
`packages/coding-agent/vendor/`, so no install step is needed.

Two behaviours are intentional local changes:

- off by default, with a per-session opt-in command instead of automatic locking
- `/unlock-continue-watchdog` never aborts a running continuation (upstream
  cancels its own continuation run)

The project config directory follows Pie's `.pie` directory rather than the
upstream `.pi`.
