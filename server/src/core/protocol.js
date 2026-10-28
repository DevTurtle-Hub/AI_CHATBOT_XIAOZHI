'use strict';

const PROTOCOL_VERSION = 2;
const SERVER_NAME = 'xiaoxi-gateway';
const SERVER_VERSION = '3.0.0';

function make(type, data = {}) {
    return JSON.stringify({
        v: PROTOCOL_VERSION,
        type,
        ts: Date.now(),
        ...data
    });
}

function parse(raw) {
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!text.startsWith('{') || !text.endsWith('}')) return null;
    try {
        const msg = JSON.parse(text);
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
        if (!msg.type || typeof msg.type !== 'string') return null;
        if (msg.v !== undefined && Number(msg.v) !== PROTOCOL_VERSION) return null;
        return msg;
    } catch {
        return null;
    }
}

function state(value, meta = {}) {
    return make('state', {
        state: value,
        from: meta.from || null,
        reason: meta.reason || '',
        turn: meta.turn || 0,
        at: meta.at || Date.now()
    });
}

function helloAck(session, extra = {}) {
    return make('hello_ack', {
        session_id: session.id,
        state: session.state,
        protocol: PROTOCOL_VERSION,
        server: { name: SERVER_NAME, version: SERVER_VERSION },
        ...extra
    });
}

function error(message, code = 'error', extra = {}) {
    return make('error', { message: String(message || ''), code, ...extra });
}

module.exports = {
    PROTOCOL_VERSION,
    SERVER_NAME,
    SERVER_VERSION,
    make,
    parse,
    state,
    helloAck,
    error
};
