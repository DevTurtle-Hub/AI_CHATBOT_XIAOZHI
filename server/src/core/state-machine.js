'use strict';

const { EventEmitter } = require('events');

const STATES = Object.freeze({
    IDLE: 'IDLE',
    LISTEN: 'LISTEN',
    THINK: 'THINK',
    SPEAK: 'SPEAK',
    ERROR: 'ERROR'
});

const TRANSITIONS = Object.freeze({
    IDLE: [STATES.LISTEN, STATES.THINK, STATES.SPEAK, STATES.ERROR],
    LISTEN: [STATES.THINK, STATES.SPEAK, STATES.IDLE, STATES.ERROR],
    THINK: [STATES.SPEAK, STATES.LISTEN, STATES.IDLE, STATES.ERROR],
    SPEAK: [STATES.LISTEN, STATES.IDLE, STATES.ERROR],
    ERROR: [STATES.IDLE, STATES.LISTEN]
});

class StateMachine extends EventEmitter {
    constructor(initial = STATES.IDLE) {
        super();
        this.state = STATES[initial] ? initial : STATES.IDLE;
        this.changedAt = Date.now();
    }

    can(to) {
        if (!STATES[to]) return false;
        if (to === this.state) return false;
        return (TRANSITIONS[this.state] || []).includes(to);
    }

    transition(to, meta = {}) {
        if (!STATES[to]) throw new Error(`Unknown state: ${to}`);
        if (!this.can(to)) return false;
        const from = this.state;
        this.state = to;
        this.changedAt = Date.now();
        this.emit('transition', { from, to, at: this.changedAt, meta });
        return true;
    }
}

module.exports = { STATES, TRANSITIONS, StateMachine };
