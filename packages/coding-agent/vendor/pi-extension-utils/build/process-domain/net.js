/**
 * Loopback TCP transport for process-domain, implemented against the Node socket
 * surface (`node:net`) that Node.js, Bun, and Deno all support with matching
 * semantics. Framing is a 4-byte big-endian length prefix followed by a JSON
 * payload bounded by MAX_MESSAGE_BYTES.
 */
import net from "node:net";
import { MAX_MESSAGE_BYTES } from "./protocol.js";
const LENGTH_PREFIX_BYTES = 4;
const TCP_ENDPOINT_PREFIX = "tcp://127.0.0.1:";
const CLOSE_DRAIN_TIMEOUT_MS = 100;
/**
 * Wraps a connected loopback socket as a framed message link. Inbound frames are
 * reassembled across TCP chunks; an invalid length prefix fails closed.
 */
export function wrapSocket(socket) {
    socket.setNoDelay(true);
    let inbox = Buffer.alloc(0);
    let destroyed = false;
    let closeRequested = false;
    let closeNotified = false;
    let closeDrainTimer = null;
    const pendingWrites = new Set();
    const maybeDestroy = () => {
        if (!closeRequested || pendingWrites.size !== 0 || socket.destroyed)
            return;
        if (closeDrainTimer !== null) {
            clearTimeout(closeDrainTimer);
            closeDrainTimer = null;
        }
        socket.destroy();
    };
    const settleWrite = (operation, error) => {
        if (operation.settled)
            return;
        operation.settled = true;
        pendingWrites.delete(operation);
        if (error)
            operation.reject(error);
        else
            operation.resolve();
        maybeDestroy();
    };
    const link = {
        onFrame: null,
        onError: null,
        onClose: null,
        get closed() {
            return closeRequested || destroyed;
        },
        send(frame) {
            if (closeRequested || destroyed || socket.destroyed)
                return Promise.reject(new Error("process-domain connection is closed"));
            if (frame.length === 0 || frame.length > MAX_MESSAGE_BYTES) {
                return Promise.reject(new RangeError("process-domain frame size out of range"));
            }
            const packet = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + frame.length);
            packet.writeUInt32BE(frame.length, 0);
            frame.copy(packet, LENGTH_PREFIX_BYTES);
            return new Promise((resolve, reject) => {
                const operation = { resolve, reject, settled: false };
                pendingWrites.add(operation);
                try {
                    socket.write(packet, (error) => settleWrite(operation, error));
                }
                catch (error) {
                    settleWrite(operation, error instanceof Error ? error : new Error(String(error)));
                }
            });
        },
        close() {
            if (closeRequested)
                return;
            closeRequested = true;
            if (pendingWrites.size !== 0 && !socket.destroyed) {
                closeDrainTimer = setTimeout(() => {
                    closeDrainTimer = null;
                    if (!socket.destroyed)
                        socket.destroy();
                }, CLOSE_DRAIN_TIMEOUT_MS);
            }
            maybeDestroy();
        },
    };
    const notifyClose = () => {
        if (closeNotified)
            return;
        closeNotified = true;
        if (closeDrainTimer !== null) {
            clearTimeout(closeDrainTimer);
            closeDrainTimer = null;
        }
        link.onClose?.();
    };
    const fail = (error) => {
        // Protocol violations tear down immediately without draining writes.
        link.onFrame = null;
        link.onError?.(error);
        destroyed = true;
        socket.destroy();
        notifyClose();
    };
    socket.on("data", (chunk) => {
        inbox = inbox.length === 0 ? chunk : Buffer.concat([inbox, chunk]);
        for (;;) {
            if (inbox.length < LENGTH_PREFIX_BYTES)
                return;
            const size = inbox.readUInt32BE(0);
            if (size === 0 || size > MAX_MESSAGE_BYTES) {
                fail(new RangeError("invalid process-domain frame size"));
                return;
            }
            if (inbox.length < LENGTH_PREFIX_BYTES + size)
                return;
            const frame = inbox.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + size);
            inbox = inbox.subarray(LENGTH_PREFIX_BYTES + size);
            link.onFrame?.(frame);
            if (destroyed)
                return;
        }
    });
    socket.on("error", (error) => {
        link.onError?.(error);
    });
    socket.on("close", () => {
        destroyed = true;
        closeRequested = true;
        const closeError = new Error("process-domain connection closed");
        for (const operation of pendingWrites)
            settleWrite(operation, closeError);
        notifyClose();
    });
    return link;
}
/** Connects to a tcp://127.0.0.1:PORT endpoint and returns the framed link. */
export function connectLoopback(endpoint, timeoutMs, timeoutMessage) {
    const port = parseLoopbackEndpoint(endpoint);
    return new Promise((resolve, reject) => {
        let settled = false;
        const socket = new net.Socket();
        const timer = setTimeout(() => {
            fail(new Error(timeoutMessage));
        }, timeoutMs);
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            reject(error);
        };
        socket.once("error", fail);
        socket.connect(port, "127.0.0.1", () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket.removeListener("error", fail);
            resolve(wrapSocket(socket));
        });
    });
}
/** Binds an ephemeral loopback listener; endpoint is tcp://127.0.0.1:<port>. */
export function listenLoopback() {
    return new Promise((resolve, reject) => {
        const tracked = new Set();
        const server = net.createServer((socket) => {
            tracked.add(socket);
            socket.on("close", () => {
                tracked.delete(socket);
            });
            frameServer.onConnection?.(wrapSocket(socket));
        });
        const frameServer = {
            get endpoint() {
                const address = server.address();
                if (address === null || typeof address === "string")
                    throw new Error("process-domain listener is not bound");
                return `${TCP_ENDPOINT_PREFIX}${address.port}`;
            },
            onConnection: null,
            close() {
                return new Promise((resolveClose) => {
                    for (const socket of tracked)
                        socket.destroy();
                    tracked.clear();
                    server.close(() => resolveClose());
                });
            },
        };
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve(frameServer);
        });
    });
}
/** Parses tcp://127.0.0.1:PORT and rejects every other endpoint shape. */
export function parseLoopbackEndpoint(endpoint) {
    if (!endpoint.startsWith(TCP_ENDPOINT_PREFIX))
        throw new TypeError("invalid process-domain endpoint");
    const portText = endpoint.slice(TCP_ENDPOINT_PREFIX.length);
    if (!/^\d+$/.test(portText))
        throw new TypeError("invalid process-domain endpoint");
    const port = Number.parseInt(portText, 10);
    if (port < 1 || port > 65_535)
        throw new TypeError("invalid process-domain endpoint");
    return port;
}
