/**
 * Loopback TCP transport for process-domain, implemented against the Node socket
 * surface (`node:net`) that Node.js, Bun, and Deno all support with matching
 * semantics. Framing is a 4-byte big-endian length prefix followed by a JSON
 * payload bounded by MAX_MESSAGE_BYTES.
 */
import net from "node:net";
/** A framed bidirectional message link over one loopback TCP connection. */
export interface FrameLink {
    /** Delivers one reassembled inbound frame. */
    onFrame: ((frame: Buffer) => void) | null;
    /** Socket-level errors; the link closes after an error. */
    onError: ((error: Error) => void) | null;
    /** Fired exactly once when the link is closed by either side. */
    onClose: (() => void) | null;
    /** True once close() was requested or the socket reached its terminal state. */
    readonly closed: boolean;
    /**
     * Serializes one frame and resolves after it was handed to the kernel.
     * Rejects when the link is closing/closed or the frame exceeds the size bound.
     */
    send(frame: Buffer): Promise<void>;
    /**
     * Stops accepting new sends and destroys the socket once in-flight writes
     * have been handed to the kernel. A bounded drain timer forces teardown if a
     * runtime never invokes a stalled write callback.
     */
    close(): void;
}
export interface FrameServer {
    readonly endpoint: string;
    onConnection: ((link: FrameLink) => void) | null;
    close(): Promise<void>;
}
/**
 * Wraps a connected loopback socket as a framed message link. Inbound frames are
 * reassembled across TCP chunks; an invalid length prefix fails closed.
 */
export declare function wrapSocket(socket: net.Socket): FrameLink;
/** Connects to a tcp://127.0.0.1:PORT endpoint and returns the framed link. */
export declare function connectLoopback(endpoint: string, timeoutMs: number, timeoutMessage: string): Promise<FrameLink>;
/** Binds an ephemeral loopback listener; endpoint is tcp://127.0.0.1:<port>. */
export declare function listenLoopback(): Promise<FrameServer>;
/** Parses tcp://127.0.0.1:PORT and rejects every other endpoint shape. */
export declare function parseLoopbackEndpoint(endpoint: string): number;
