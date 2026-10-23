// Load the prepared private runtime entry through tsx from THIS package's node_modules.
import { createWatchdogRuntime } from "private-inquiry-subagents-runtime/watchdog-runtime";

const runtime = createWatchdogRuntime();
runtime.dispose();
console.log("private runtime entry loads:", typeof createWatchdogRuntime);
