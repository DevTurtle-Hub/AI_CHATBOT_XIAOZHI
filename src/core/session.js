'use strict';

const { EventEmitter } = require('events');
const { StateMachine, STATES } = require('./state-machine');

let sessionSeq = 0;

class Session extends EventEmitter {
    constructor({ ws, id, role = 'device', protocol = 1, remote = '' }) {
        super();
        this.ws = ws;
        this.id = id || `session-${++sessionSeq}`;
        this.role = role;
        this.protocol = protocol;
        this.remote = remote;
        this.createdAt = Date.now();
        this.capabilities = new Set();

        this.sm = new StateMachine(STATES.IDLE);
        this.sm.on('transition', (event) => this.emit('state', event));

        this.tts = {
            active: false,
            aborted: false,
            abort: null,
            startedAt: 0,
            firstChunkAt: 0,
            reason: null
        };
        this.turnSeq = 0;
        this.busyTurn = false;
        this.micLockedUntil = 0;
        this.activeListeningUntil = 0;
        this.recording = null;
        this.config = {
            vadThreshold: 0.5,
            silenceWindows: 5,
            maxSeconds: 10
        };
        this.metrics = {
            last: null,
            pending: null
        };
        this.convo = { mood: 'neutral', history: [] };
        this.lastMusicSearch = { line: null, vIdx: 0 };

        this.enqueueFace = null;
        this.onDebug = null;
        this.onStop = null;
        this.onBargeIn = null;
    }

    get state() {
        return this.sm.state;
    }

    get currentState() {
        return this.sm.state;
    }

    setState(to, meta = {}) {
        return this.sm.transition(to, meta);
    }

    isCurrentTurn(turn) {
        return turn === this.turnSeq;
    }

    nextTurn() {
        this.busyTurn = true;
        return ++this.turnSeq;
    }

    endTurn() {
        this.busyTurn = false;
    }

    beginTts(controller) {
        this.tts = {
            active: true,
            aborted: false,
            abort: controller || null,
            startedAt: Date.now(),
            firstChunkAt: 0,
            reason: null
        };
    }

    markFirstChunk() {
        if (!this.tts.firstChunkAt) this.tts.firstChunkAt = Date.now();
        return this.tts.firstChunkAt;
    }

    cancelTts(reason = 'cancelled') {
        if (!this.tts || !this.tts.active) return false;
        this.tts.aborted = true;
        this.tts.reason = reason;
        try { this.tts.abort?.abort(); } catch { }
        return true;
    }

    endTts() {
        const wasActive = !!(this.tts && this.tts.active);
        if (this.tts) this.tts.active = false;
        return wasActive;
    }

    toJSON() {
        return {
            id: this.id,
            role: this.role,
            protocol: this.protocol,
            state: this.sm.state,
            connectedAt: this.createdAt,
            remote: this.remote,
            capabilities: [...this.capabilities],
            busy: this.busyTurn,
            tts: { active: this.tts.active, aborted: this.tts.aborted },
            config: this.config,
            metrics: this.metrics.last
        };
    }
}

module.exports = { Session };
