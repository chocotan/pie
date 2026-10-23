/**
 * The process domain always runs on loopback TCP via node:net so the same code
 * path works on Node.js, Deno, and Bun without native addons or per-runtime
 * adapters. The "ipc" transport name remains in the public types for wire
 * compatibility with older declarations but is no longer selected.
 */
export function preferredTransport() {
    return "tcp-loopback";
}
export function wildcardEndpoint(transport = preferredTransport()) {
    return transport === "ipc" ? "ipc://*" : "tcp://127.0.0.1:*";
}
