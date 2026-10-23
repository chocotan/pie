// Built-in port of https://github.com/xz-dev/pi-continue-watchdog (BSD-3-Clause).
// The upstream source lives in this directory unchanged except for the
// session opt-in: the watchdog is inert until `/lock-continue-watchdog` enables
// it for the current session, and `/unlock-continue-watchdog` is a soft unlock
// that never aborts a running continuation.
export { type ContinueWatchdogExtensionOptions, createContinueWatchdogExtension, default } from "./extension.ts";
