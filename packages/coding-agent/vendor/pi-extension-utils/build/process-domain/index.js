import { authenticationFailedError, connectionUnavailableError, invalidDeclarationError, isProcessDomainOpenError, } from "./errors.js";
import { connectLoopback, listenLoopback } from "./net.js";
import { createProof, decodeDeclaration, decodeEnvelope, encodeDeclaration, encodeEnvelope, isValidChannel, isValidId, randomId, verifyProof, ENV_NAMES, } from "./protocol.js";
import { PROCESS_DOMAIN_PROTOCOL, } from "./types.js";
export * from "./types.js";
export { isProcessDomainOpenError, ProcessDomainOpenError, } from "./errors.js";
export { ENV_NAMES } from "./protocol.js";
export { preferredTransport, wildcardEndpoint } from "./endpoint.js";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 6_000;
const DEFAULT_HEARTBEAT_TTL_MS = 5_000;
const AUTH_CHALLENGE_TTL_MS = 10_000;
const MAX_PENDING_AUTH = 1_024;
const RECONNECT_DELAY_MS = 1_000;
function asError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
function withTimeout(promise, timeoutMs, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
function requireValidOptions(options) {
    const values = {
        connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
        heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
        heartbeatTimeToLiveMs: options.heartbeatTimeToLiveMs ?? DEFAULT_HEARTBEAT_TTL_MS,
    };
    for (const value of Object.values(values)) {
        if (!Number.isSafeInteger(value) || value <= 0)
            throw new RangeError("process-domain timing options must be positive safe integers");
    }
    if (values.heartbeatTimeToLiveMs < 100)
        throw new RangeError("heartbeatTimeToLiveMs must be at least 100ms");
    return values;
}
/**
 * Application-level heartbeat. Both sides ping every
 * heartbeatIntervalMs; any inbound frame refreshes the silence window
 * (heartbeatTimeoutMs) and a pong older than heartbeatTimeToLiveMs marks the
 * peer dead. A frozen (SIGSTOP) peer therefore fails both checks.
 */
function startLiveness(timing, sendPing, onDead) {
    let stopped = false;
    let lastInbound = Date.now();
    let awaitingId = null;
    let awaitingSince = 0;
    const stop = () => {
        if (stopped)
            return;
        stopped = true;
        clearInterval(timer);
    };
    const timer = setInterval(() => {
        if (stopped)
            return;
        const now = Date.now();
        if (now - lastInbound > timing.heartbeatTimeoutMs) {
            stop();
            onDead();
            return;
        }
        if (awaitingId !== null) {
            if (now - awaitingSince > timing.heartbeatTimeToLiveMs) {
                stop();
                onDead();
            }
            return;
        }
        const id = randomId();
        awaitingId = id;
        awaitingSince = now;
        void sendPing(id).catch(() => {
            // Send failures are handled by the link close path.
        });
    }, timing.heartbeatIntervalMs);
    return {
        stop,
        noteInbound() {
            lastInbound = Date.now();
        },
        notePong(id) {
            if (id === awaitingId)
                awaitingId = null;
        },
    };
}
function peerInfo(peer, status) {
    return {
        nodeId: peer.nodeId,
        status,
        metadata: peer.metadata,
        connectedAt: peer.connectedAt,
        ...(peer.disconnectedAt === undefined ? {} : { disconnectedAt: peer.disconnectedAt }),
    };
}
function createDeclaration(endpoint, hostNodeId) {
    const capability = randomId(32);
    return {
        capability,
        declaration: {
            version: PROCESS_DOMAIN_PROTOCOL,
            domainId: randomId(16),
            endpoint,
            capability,
            hostNodeId,
        },
    };
}
class DomainRuntime {
    options;
    metadata;
    peersMap = new Map();
    subscribers = new Map();
    eventListeners = new Set();
    nodeId;
    role;
    declaration;
    transport;
    endpoint;
    closed = false;
    server = null;
    pendingAuth = new Set();
    ownLink = null;
    reconnectTimer = null;
    declarationEnv = null;
    publishedDeclaration = null;
    constructor(role, nodeId, declaration, transport, options, metadata) {
        this.options = options;
        this.metadata = metadata;
        this.role = role;
        this.nodeId = nodeId;
        this.declaration = declaration;
        this.transport = transport;
        this.endpoint = declaration.endpoint;
    }
    get connectTimeoutMs() {
        return this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    }
    get heartbeatTiming() {
        const values = requireValidOptions(this.options);
        return {
            heartbeatIntervalMs: values.heartbeatIntervalMs,
            heartbeatTimeoutMs: values.heartbeatTimeoutMs,
            heartbeatTimeToLiveMs: values.heartbeatTimeToLiveMs,
        };
    }
    static async host(options, metadata) {
        const server = await listenLoopback();
        const nodeId = randomId();
        const { declaration } = createDeclaration(server.endpoint, nodeId);
        const runtime = new DomainRuntime("host", nodeId, declaration, "tcp-loopback", options, metadata);
        runtime.server = server;
        server.onConnection = (link) => runtime.handleConnection(link);
        runtime.emit({ type: "transport", transport: "tcp-loopback", endpoint: server.endpoint });
        return runtime;
    }
    static async client(declaration, options, metadata) {
        const runtime = new DomainRuntime("client", randomId(), declaration, "tcp-loopback", options, metadata);
        const startup = { failure: "connection" };
        let link = null;
        try {
            link = await connectLoopback(declaration.endpoint, runtime.connectTimeoutMs, "process-domain connection timed out");
            const state = runtime.installLinkState(link);
            await runtime.handshakeClient(state, () => {
                startup.failure = "authentication";
            });
            runtime.attachClientLink(state);
            runtime.emit({ type: "transport", transport: runtime.transport, endpoint: declaration.endpoint });
            return runtime;
        }
        catch (error) {
            link?.close();
            if (isProcessDomainOpenError(error))
                throw error;
            throw startup.failure === "authentication"
                ? authenticationFailedError(error)
                : connectionUnavailableError(error);
        }
    }
    installLinkState(link) {
        const state = { link, inbox: [], waiters: [], handler: null, onClose: null };
        link.onFrame = (frame) => {
            let envelope;
            try {
                envelope = decodeEnvelope(frame);
            }
            catch (error) {
                this.options.onError?.(asError(error));
                if (state.handler === null)
                    link.close();
                return;
            }
            if (state.handler !== null) {
                state.handler(envelope);
                return;
            }
            const waiter = state.waiters.shift();
            if (waiter !== undefined)
                waiter.resolve(envelope);
            else
                state.inbox.push(envelope);
        };
        link.onError = (error) => this.options.onError?.(error);
        link.onClose = () => {
            for (const waiter of state.waiters.splice(0))
                waiter.reject(new Error("process-domain connection closed"));
            state.onClose?.();
        };
        return state;
    }
    nextEnvelope(state, timeoutMs) {
        const queued = state.inbox.shift();
        if (queued !== undefined)
            return Promise.resolve(queued);
        return withTimeout(new Promise((resolve, reject) => {
            state.waiters.push({ resolve, reject });
        }), timeoutMs, "process-domain connection timed out");
    }
    /** Swaps a link into post-auth dispatch and replays any frames queued mid-handshake. */
    attachLinkHandler(state, onClose, handler) {
        state.onClose = onClose;
        state.handler = handler;
        const drained = state.inbox.splice(0);
        for (const envelope of drained)
            handler(envelope);
    }
    detachLinkHandler(state) {
        state.onClose = null;
        state.handler = null;
    }
    // ---------------------------------------------------------------- host auth
    handleConnection(link) {
        if (this.closed || this.pendingAuth.size >= MAX_PENDING_AUTH) {
            link.close();
            return;
        }
        const state = this.installLinkState(link);
        const entry = {
            state,
            authTimer: setTimeout(() => {
                link.close();
            }, this.connectTimeoutMs),
        };
        this.pendingAuth.add(entry);
        state.onClose = () => {
            clearTimeout(entry.authTimer);
            if (entry.challenge?.expiryTimer)
                clearTimeout(entry.challenge.expiryTimer);
            this.pendingAuth.delete(entry);
        };
        state.handler = (envelope) => {
            void this.handlePreAuth(entry, envelope).catch((error) => {
                this.options.onError?.(asError(error));
                link.close();
            });
        };
    }
    queueAuthSend(entry, envelope) {
        return entry.state.link.send(encodeEnvelope(envelope));
    }
    async handlePreAuth(entry, envelope) {
        if (envelope.type === "challenge-request" &&
            envelope.phase === "bootstrap" &&
            envelope.domainId === this.declaration.domainId &&
            isValidId(envelope.nodeId) &&
            isValidId(envelope.clientNonce)) {
            const previous = entry.challenge;
            if (previous !== undefined && previous.expiresAt >= Date.now())
                return;
            if (previous?.expiryTimer)
                clearTimeout(previous.expiryTimer);
            const challenge = {
                clientNonce: envelope.clientNonce,
                serverNonce: randomId(),
                expiresAt: Date.now() + AUTH_CHALLENGE_TTL_MS,
            };
            const expiryTimer = setTimeout(() => {
                if (entry.challenge?.serverNonce === challenge.serverNonce)
                    entry.challenge = undefined;
            }, AUTH_CHALLENGE_TTL_MS);
            entry.challenge = { ...challenge, expiryTimer };
            await this.queueAuthSend(entry, {
                version: PROCESS_DOMAIN_PROTOCOL,
                type: "challenge",
                phase: "bootstrap",
                domainId: this.declaration.domainId,
                nodeId: envelope.nodeId,
                clientNonce: challenge.clientNonce,
                serverNonce: challenge.serverNonce,
            });
            return;
        }
        if (envelope.type !== "bootstrap" || envelope.domainId !== this.declaration.domainId || !isValidId(envelope.nodeId)) {
            entry.state.link.close();
            return;
        }
        const challenge = entry.challenge;
        entry.challenge = undefined;
        if (challenge?.expiryTimer)
            clearTimeout(challenge.expiryTimer);
        if (challenge === undefined ||
            challenge.expiresAt < Date.now() ||
            challenge.clientNonce !== envelope.clientNonce ||
            challenge.serverNonce !== envelope.serverNonce ||
            !verifyProof(this.declaration.capability, "bootstrap", [
                envelope.domainId,
                envelope.nodeId,
                envelope.metadata,
                envelope.clientNonce,
                envelope.serverNonce,
            ], envelope.proof)) {
            entry.state.link.close();
            return;
        }
        await this.completeAuth(entry, envelope.nodeId, envelope.metadata, envelope.clientNonce, envelope.serverNonce);
    }
    async completeAuth(entry, nodeId, metadata, clientNonce, serverNonce) {
        clearTimeout(entry.authTimer);
        this.pendingAuth.delete(entry);
        const replaced = this.peersMap.get(nodeId);
        if (replaced !== undefined) {
            // Fencing: a freshly authenticated connection with the same nodeId replaces
            // the stale incarnation; its pending sends are rejected and its handlers are
            // detached before closing so no duplicate offline event is emitted.
            replaced.liveness?.stop();
            replaced.liveness = null;
            this.rejectPending(replaced, new Error("process-domain peer replaced"));
            this.detachLinkHandler(replaced.state);
            replaced.link.close();
            this.peersMap.delete(nodeId);
            if (replaced.status === "online") {
                replaced.status = "offline";
                replaced.disconnectedAt = Date.now();
                this.emitPeer(peerInfo(replaced, "offline"));
            }
        }
        const link = entry.state.link;
        const peer = {
            nodeId,
            status: "offline",
            metadata,
            connectedAt: Date.now(),
            link,
            state: entry.state,
            pending: new Map(),
            everOnline: false,
            liveness: null,
        };
        this.peersMap.set(nodeId, peer);
        try {
            await this.queueRawSend(peer, {
                version: PROCESS_DOMAIN_PROTOCOL,
                type: "ready",
                domainId: this.declaration.domainId,
                nodeId: this.nodeId,
                clientNonce,
                serverNonce,
                proof: createProof(this.declaration.capability, "ready", [
                    this.declaration.domainId,
                    this.nodeId,
                    nodeId,
                    clientNonce,
                    serverNonce,
                ]),
            });
        }
        catch (error) {
            this.detachLinkHandler(entry.state);
            this.peersMap.delete(nodeId);
            this.rejectPending(peer, asError(error));
            link.close();
            throw error;
        }
        // The peer must be online before the post-auth dispatcher is attached so
        // frames drained from the handshake boundary are accepted, not dropped.
        this.markPeerOnline(nodeId);
        this.attachLinkHandler(entry.state, () => this.handlePeerClose(peer), (envelope) => this.dispatchHostEnvelope(peer, envelope));
        peer.liveness = startLiveness(this.heartbeatTiming, (id) => this.queueRawSend(peer, {
            version: PROCESS_DOMAIN_PROTOCOL,
            type: "ping",
            id,
        }), () => link.close());
    }
    // ------------------------------------------------------------ host messaging
    dispatchHostEnvelope(peer, envelope) {
        if (this.peersMap.get(peer.nodeId) !== peer)
            return;
        void this.handleHostEnvelope(peer, envelope).catch((error) => {
            this.options.onError?.(asError(error));
        });
    }
    handlePeerClose(peer) {
        if (this.peersMap.get(peer.nodeId) !== peer)
            return;
        this.markPeerOffline(peer.nodeId);
    }
    async handleHostEnvelope(peer, envelope) {
        peer.liveness?.noteInbound();
        if (envelope.type === "ping") {
            await this.queueRawSend(peer, {
                version: PROCESS_DOMAIN_PROTOCOL,
                type: "pong",
                id: envelope.id,
            });
            return;
        }
        if (envelope.type === "pong") {
            peer.liveness?.notePong(envelope.id);
            return;
        }
        if (peer.status !== "online")
            return;
        if (envelope.type === "data" && envelope.senderId !== peer.nodeId)
            return;
        if (envelope.type === "lifecycle" && envelope.senderId !== peer.nodeId)
            return;
        if (envelope.type === "ack") {
            const pending = peer.pending.get(envelope.id);
            if (pending?.timer)
                clearTimeout(pending.timer);
            pending?.resolve();
            peer.pending.delete(envelope.id);
            return;
        }
        if (envelope.type === "data") {
            if (envelope.targetId === this.nodeId) {
                // Leaf delivery: the receipt ACK is written before local dispatch so a
                // listener that synchronously closes the node cannot strand it.
                const acknowledged = this.queueRawSend(peer, {
                    version: PROCESS_DOMAIN_PROTOCOL,
                    type: "ack",
                    id: envelope.id,
                });
                this.dispatchEnvelope(envelope);
                await acknowledged;
                return;
            }
            if (envelope.targetId === "*") {
                this.dispatchEnvelope(envelope);
                await Promise.all(Array.from(this.peersMap.values())
                    .filter((target) => target.nodeId !== peer.nodeId && target.status === "online")
                    .map((target) => this.sendThroughPeer(target, envelope, this.connectTimeoutMs)));
            }
            else {
                const target = this.peersMap.get(envelope.targetId);
                if (!target || target.status !== "online")
                    throw new Error("target process-domain peer is offline");
                await this.sendThroughPeer(target, envelope, this.connectTimeoutMs);
            }
            // Routed messages acknowledge only after every downstream hop acknowledged.
            await this.queueRawSend(peer, {
                version: PROCESS_DOMAIN_PROTOCOL,
                type: "ack",
                id: envelope.id,
            });
            return;
        }
        if (envelope.type === "lifecycle") {
            const acknowledged = this.queueRawSend(peer, {
                version: PROCESS_DOMAIN_PROTOCOL,
                type: "ack",
                id: envelope.id,
            });
            this.dispatchEnvelope(envelope);
            await acknowledged;
        }
    }
    // ------------------------------------------------------------------ client
    async handshakeClient(state, onBootstrapSent) {
        const timeoutMs = this.connectTimeoutMs;
        const clientNonce = randomId();
        await withTimeout(state.link.send(encodeEnvelope({
            version: PROCESS_DOMAIN_PROTOCOL,
            type: "challenge-request",
            phase: "bootstrap",
            domainId: this.declaration.domainId,
            nodeId: this.nodeId,
            clientNonce,
        })), timeoutMs, "process-domain send timed out");
        const challenge = await this.nextEnvelope(state, timeoutMs);
        if (challenge.type !== "challenge" ||
            challenge.phase !== "bootstrap" ||
            challenge.domainId !== this.declaration.domainId ||
            challenge.nodeId !== this.nodeId ||
            challenge.clientNonce !== clientNonce)
            throw authenticationFailedError(new Error("invalid bootstrap challenge"));
        await withTimeout(state.link.send(encodeEnvelope({
            version: PROCESS_DOMAIN_PROTOCOL,
            type: "bootstrap",
            domainId: this.declaration.domainId,
            nodeId: this.nodeId,
            metadata: this.metadata,
            clientNonce,
            serverNonce: challenge.serverNonce,
            proof: createProof(this.declaration.capability, "bootstrap", [
                this.declaration.domainId,
                this.nodeId,
                this.metadata,
                clientNonce,
                challenge.serverNonce,
            ]),
        })), timeoutMs, "process-domain send timed out");
        onBootstrapSent?.();
        const ready = await this.nextEnvelope(state, timeoutMs);
        if (ready.type !== "ready" ||
            ready.domainId !== this.declaration.domainId ||
            ready.nodeId !== this.declaration.hostNodeId ||
            ready.clientNonce !== clientNonce ||
            ready.serverNonce !== challenge.serverNonce ||
            !verifyProof(this.declaration.capability, "ready", [
                this.declaration.domainId,
                this.declaration.hostNodeId,
                this.nodeId,
                clientNonce,
                challenge.serverNonce,
            ], ready.proof))
            throw authenticationFailedError(new Error("invalid bootstrap response"));
    }
    attachClientLink(state) {
        const link = state.link;
        const hostNodeId = this.declaration.hostNodeId;
        const previous = this.peersMap.get(hostNodeId);
        if (previous !== undefined) {
            previous.liveness?.stop();
            this.rejectPending(previous, new Error("process-domain host disconnected"));
            this.detachLinkHandler(previous.state);
            previous.link.close();
            this.peersMap.delete(hostNodeId);
        }
        const peer = {
            nodeId: hostNodeId,
            status: "offline",
            metadata: {},
            connectedAt: Date.now(),
            link,
            state,
            pending: new Map(),
            everOnline: false,
            liveness: null,
        };
        this.peersMap.set(hostNodeId, peer);
        this.ownLink = link;
        // Online before attaching the dispatcher: frames that were coalesced with
        // the handshake-complete frame are drained through the online peer.
        this.markOnline();
        this.attachLinkHandler(state, () => this.handleClientLinkClose(peer), (envelope) => this.dispatchClientEnvelope(peer, envelope));
        peer.liveness = startLiveness(this.heartbeatTiming, (id) => this.queueRawSend(peer, {
            version: PROCESS_DOMAIN_PROTOCOL,
            type: "ping",
            id,
        }), () => link.close());
    }
    dispatchClientEnvelope(peer, envelope) {
        if (this.peersMap.get(this.declaration.hostNodeId) !== peer)
            return;
        void this.handleClientEnvelope(peer, envelope).catch((error) => {
            this.options.onError?.(asError(error));
        });
    }
    handleClientLinkClose(peer) {
        if (this.peersMap.get(this.declaration.hostNodeId) !== peer)
            return;
        this.markOffline();
        this.scheduleReconnect();
    }
    scheduleReconnect() {
        if (this.closed || this.role !== "client" || this.reconnectTimer !== null)
            return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.reconnectAttempt();
        }, RECONNECT_DELAY_MS);
    }
    async reconnectAttempt() {
        if (this.closed)
            return;
        let link = null;
        try {
            link = await connectLoopback(this.declaration.endpoint, this.connectTimeoutMs, "process-domain connection timed out");
            const state = this.installLinkState(link);
            await this.handshakeClient(state);
            this.attachClientLink(state);
        }
        catch (error) {
            link?.close();
            if (!this.closed)
                this.options.onError?.(asError(error));
            this.scheduleReconnect();
        }
    }
    async handleClientEnvelope(peer, envelope) {
        peer.liveness?.noteInbound();
        if (envelope.type === "ping") {
            await this.queueRawSend(peer, {
                version: PROCESS_DOMAIN_PROTOCOL,
                type: "pong",
                id: envelope.id,
            });
            return;
        }
        if (envelope.type === "pong") {
            peer.liveness?.notePong(envelope.id);
            return;
        }
        if (peer.status !== "online")
            return;
        if (envelope.type === "ack") {
            const pending = peer.pending.get(envelope.id);
            if (pending?.timer)
                clearTimeout(pending.timer);
            pending?.resolve();
            peer.pending.delete(envelope.id);
            return;
        }
        if (envelope.type === "data" || envelope.type === "lifecycle") {
            // The receipt ACK is written before local dispatch so a listener that
            // synchronously closes the node cannot strand it.
            const acknowledged = this.queueRawSend(peer, {
                version: PROCESS_DOMAIN_PROTOCOL,
                type: "ack",
                id: envelope.id,
            });
            this.dispatchEnvelope(envelope);
            await acknowledged;
        }
    }
    // ------------------------------------------------------------------- shared
    markOffline() {
        if (this.role !== "client")
            return;
        const peer = this.peersMap.get(this.declaration.hostNodeId);
        if (!peer)
            return;
        const wasOnline = peer.status === "online";
        peer.status = "offline";
        peer.disconnectedAt = Date.now();
        peer.liveness?.stop();
        peer.liveness = null;
        this.ownLink = null;
        this.rejectPending(peer, new Error("process-domain host disconnected"));
        if (wasOnline)
            this.emitPeer(peerInfo(peer, "offline"));
    }
    markOnline() {
        if (this.role !== "client")
            return;
        const peer = this.peersMap.get(this.declaration.hostNodeId);
        if (!peer || peer.status === "online")
            return;
        peer.status = "online";
        peer.disconnectedAt = undefined;
        this.emitPeer(peerInfo(peer, "online"));
    }
    markPeerOnline(nodeId) {
        const peer = this.peersMap.get(nodeId);
        if (!peer || peer.status === "online")
            return;
        peer.status = "online";
        peer.everOnline = true;
        peer.disconnectedAt = undefined;
        this.emitPeer(peerInfo(peer, "online"));
    }
    markPeerOffline(nodeId) {
        const peer = this.peersMap.get(nodeId);
        if (!peer)
            return;
        const wasOnline = peer.status === "online";
        peer.status = "offline";
        peer.disconnectedAt = Date.now();
        peer.liveness?.stop();
        peer.liveness = null;
        this.rejectPending(peer, new Error("process-domain peer disconnected"));
        if (wasOnline)
            this.emitPeer(peerInfo(peer, "offline"));
    }
    dispatchEnvelope(envelope) {
        if (envelope.type === "lifecycle") {
            this.emit({ type: "lifecycle", senderId: envelope.senderId, event: envelope.event });
            return;
        }
        if (envelope.type !== "data")
            return;
        const message = { id: envelope.id, channel: envelope.channel, value: envelope.value, senderId: envelope.senderId, targetId: envelope.targetId, receivedAt: Date.now() };
        for (const listener of this.subscribers.get(envelope.channel) ?? [])
            listener(message);
    }
    queueRawSend(peer, envelope) {
        // TCP streams serialize writes in call order, so no client-side send queue
        // is required; starting the write synchronously matters for ACKs that race
        // with a listener-initiated close().
        return peer.link.send(encodeEnvelope(envelope));
    }
    sendThroughPeer(peer, envelope, timeoutMs) {
        const id = envelope.type === "data" || envelope.type === "lifecycle" ? envelope.id : "";
        let pending;
        const acknowledgement = new Promise((resolve, reject) => {
            pending = { resolve, reject };
            peer.pending.set(id, pending);
        });
        // If the write below fails, this promise is never adopted by a caller; sink
        // its rejection so a concurrent rejectPending cannot surface as unhandled.
        acknowledgement.catch(() => { });
        const send = this.queueRawSend(peer, envelope);
        return send.then(() => {
            if (peer.pending.get(id) === pending) {
                pending.timer = setTimeout(() => {
                    if (peer.pending.get(id) === pending)
                        peer.pending.delete(id);
                    pending.reject(new Error("process-domain acknowledgement timed out"));
                }, timeoutMs);
            }
            return acknowledgement;
        }, (error) => {
            if (peer.pending.get(id) === pending)
                peer.pending.delete(id);
            throw error;
        });
    }
    emit(event) { for (const listener of this.eventListeners)
        listener(event); }
    emitPeer(peer) { this.emit({ type: "peer", peer }); }
    rejectPending(peer, error) {
        for (const pending of peer.pending.values()) {
            if (pending.timer)
                clearTimeout(pending.timer);
            pending.reject(error);
        }
        peer.pending.clear();
    }
    peers() { return Array.from(this.peersMap.values(), (peer) => peerInfo(peer, peer.status)); }
    async send(targetId, channel, value, options = {}) {
        if (!isValidId(targetId) || !isValidChannel(channel))
            throw new TypeError("invalid process-domain target or channel");
        const peer = this.peersMap.get(targetId);
        const timeoutMs = options.timeoutMs ?? this.connectTimeoutMs;
        const envelope = { version: PROCESS_DOMAIN_PROTOCOL, type: "data", id: randomId(), channel, value, senderId: this.nodeId, targetId };
        if (this.role === "host") {
            if (!peer || peer.status !== "online")
                throw new Error("target process-domain peer is offline");
            await this.sendThroughPeer(peer, envelope, timeoutMs);
        }
        else {
            if (this.ownLink === null || !peer || peer.status !== "online")
                throw new Error("process-domain host is offline");
            await this.sendThroughPeer(peer, envelope, timeoutMs);
        }
    }
    async broadcast(channel, value, options = {}) {
        if (!isValidChannel(channel))
            throw new TypeError("invalid process-domain channel");
        if (this.role === "host") {
            await Promise.all(this.peers().filter((peer) => peer.status === "online").map((peer) => this.send(peer.nodeId, channel, value, options)));
            return;
        }
        const peer = this.peersMap.get(this.declaration.hostNodeId);
        if (!peer || peer.status !== "online")
            throw new Error("process-domain host is offline");
        const envelope = { version: PROCESS_DOMAIN_PROTOCOL, type: "data", id: randomId(), channel, value, senderId: this.nodeId, targetId: "*" };
        await this.sendThroughPeer(peer, envelope, options.timeoutMs ?? this.connectTimeoutMs);
    }
    async reportLifecycle(event, options = {}) {
        const envelope = { version: PROCESS_DOMAIN_PROTOCOL, type: "lifecycle", id: randomId(), senderId: this.nodeId, event };
        const timeoutMs = options.timeoutMs ?? this.connectTimeoutMs;
        if (this.role === "host") {
            this.dispatchEnvelope(envelope);
            return;
        }
        const peer = this.peersMap.get(this.declaration.hostNodeId);
        if (peer === undefined)
            return;
        if (peer.status !== "online")
            throw new Error("process-domain host is offline");
        await this.sendThroughPeer(peer, envelope, timeoutMs);
    }
    subscribe(channel, listener) { if (!isValidChannel(channel))
        throw new TypeError("invalid process-domain channel"); let listeners = this.subscribers.get(channel); if (!listeners) {
        listeners = new Set();
        this.subscribers.set(channel, listeners);
    } listeners.add(listener); return () => listeners?.delete(listener); }
    subscribeEvents(listener) { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }
    attachPiLifecycle(pi, sessionId) {
        const names = ["session_start", "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "session_shutdown"];
        let active = true;
        for (const name of names) {
            pi.on(name, async () => {
                if (!active)
                    return;
                try {
                    await this.reportLifecycle({ name, at: Date.now(), sessionId });
                }
                catch (error) {
                    this.options.onError?.(asError(error));
                }
            });
        }
        return { close: () => { active = false; } };
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        for (const entry of this.pendingAuth) {
            clearTimeout(entry.authTimer);
            if (entry.challenge?.expiryTimer)
                clearTimeout(entry.challenge.expiryTimer);
            this.detachLinkHandler(entry.state);
            entry.state.link.close();
        }
        this.pendingAuth.clear();
        for (const peer of this.peersMap.values()) {
            peer.liveness?.stop();
            peer.liveness = null;
            this.rejectPending(peer, new Error("process-domain closed"));
            this.detachLinkHandler(peer.state);
            peer.link.close();
        }
        this.peersMap.clear();
        this.ownLink = null;
        if (this.server !== null) {
            await this.server.close();
            this.server = null;
        }
        if (this.role === "host" &&
            this.declarationEnv !== null &&
            this.publishedDeclaration !== null &&
            this.declarationEnv[ENV_NAMES.DECLARATION] === this.publishedDeclaration) {
            delete this.declarationEnv[ENV_NAMES.DECLARATION];
        }
        this.declarationEnv = null;
        this.publishedDeclaration = null;
        this.eventListeners.clear();
        this.subscribers.clear();
    }
}
export async function openProcessDomain(options = {}) {
    requireValidOptions(options);
    const env = options.env ?? process.env;
    const metadata = options.metadata ?? {};
    const encoded = env[ENV_NAMES.DECLARATION];
    if (encoded === undefined) {
        let runtime;
        try {
            runtime = await DomainRuntime.host(options, metadata);
        }
        catch (error) {
            throw connectionUnavailableError(error);
        }
        const declaration = encodeDeclaration(runtime.declaration);
        env[ENV_NAMES.DECLARATION] = declaration;
        runtime.declarationEnv = env;
        runtime.publishedDeclaration = declaration;
        return runtime;
    }
    let declaration;
    try {
        declaration = decodeDeclaration(encoded);
    }
    catch (error) {
        throw invalidDeclarationError(error);
    }
    if (declaration === null) {
        throw invalidDeclarationError(new TypeError("missing declaration"));
    }
    try {
        return await DomainRuntime.client(declaration, options, metadata);
    }
    catch (error) {
        if (isProcessDomainOpenError(error))
            throw error;
        throw connectionUnavailableError(error);
    }
}
const SHARED_NODE = Symbol.for("pi-extension-utils:process-domain:shared:v1");
/**
 * Open (or join) the single shared process-domain node for this JS realm.
 *
 * The first call hosts the domain and publishes the declaration to `env`;
 * later calls in the same realm return a new handle over the same node
 * instead of degrading to a client of the first caller. Handles are
 * reference counted: the node closes only when every handle is released.
 *
 * Per-caller options (metadata, onError) apply only when this call is the
 * one that actually opens the node; joining callers share the open caller's
 * wiring, matching how a single shared node must behave.
 */
export async function openSharedProcessDomain(options = {}) {
    const host = globalThis;
    const entry = host[SHARED_NODE];
    if (entry !== undefined) {
        if (entry.closing !== null) {
            // A release is in flight; wait for it so ordering stays deterministic.
            await entry.closing;
            return openSharedProcessDomain(options);
        }
        entry.refCount += 1;
        return wrapSharedHandle(host, entry);
    }
    const node = await openProcessDomain(options);
    const created = { node, refCount: 1, closing: null };
    host[SHARED_NODE] = created;
    return wrapSharedHandle(host, created);
}
function wrapSharedHandle(host, entry) {
    let released = false;
    const assertLive = () => {
        if (released)
            throw new Error("shared process-domain handle already released");
    };
    return {
        get role() {
            assertLive();
            return entry.node.role;
        },
        get nodeId() {
            assertLive();
            return entry.node.nodeId;
        },
        get transport() {
            assertLive();
            return entry.node.transport;
        },
        get endpoint() {
            assertLive();
            return entry.node.endpoint;
        },
        get declaration() {
            assertLive();
            return entry.node.declaration;
        },
        peers() {
            assertLive();
            return entry.node.peers();
        },
        send(targetId, channel, value, sendOptions) {
            assertLive();
            return entry.node.send(targetId, channel, value, sendOptions);
        },
        broadcast(channel, value, sendOptions) {
            assertLive();
            return entry.node.broadcast(channel, value, sendOptions);
        },
        reportLifecycle(event, sendOptions) {
            assertLive();
            return entry.node.reportLifecycle(event, sendOptions);
        },
        subscribe(channel, listener) {
            assertLive();
            return entry.node.subscribe(channel, listener);
        },
        subscribeEvents(listener) {
            assertLive();
            return entry.node.subscribeEvents(listener);
        },
        close() {
            return this.release();
        },
        async release() {
            if (released)
                return;
            released = true;
            entry.refCount -= 1;
            if (entry.refCount > 0)
                return;
            if (host[SHARED_NODE] === entry)
                delete host[SHARED_NODE];
            entry.closing = entry.node.close().then(() => { }, () => { });
            await entry.closing;
            entry.closing = null;
        },
    };
}
export function attachPiLifecycle(node, pi, sessionId) {
    return node.attachPiLifecycle(pi, sessionId);
}
