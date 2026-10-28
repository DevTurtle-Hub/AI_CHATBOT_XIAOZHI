'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { StateMachine, STATES } = require('../server/src/core/state-machine');
const { splitSentences } = require('../server/src/core/sentence-splitter');
const protocol = require('../server/src/core/protocol');
const { Session } = require('../server/src/core/session');

test('state machine cho phép luồng IDLE -> LISTEN -> THINK -> SPEAK -> IDLE', () => {
    const sm = new StateMachine();
    const seen = [];
    sm.on('transition', (e) => seen.push(`${e.from}->${e.to}`));
    assert.equal(sm.transition(STATES.LISTEN), true);
    assert.equal(sm.transition(STATES.THINK), true);
    assert.equal(sm.transition(STATES.SPEAK), true);
    assert.equal(sm.transition(STATES.IDLE), true);
    assert.deepEqual(seen, ['IDLE->LISTEN', 'LISTEN->THINK', 'THINK->SPEAK', 'SPEAK->IDLE']);
});

test('state machine chặn chuyển trạng thái sai và tự chuyển', () => {
    const sm = new StateMachine();
    assert.equal(sm.transition(STATES.SPEAK), true);
    assert.equal(sm.transition(STATES.LISTEN), true);
    assert.equal(sm.transition(STATES.THINK), true);
    assert.equal(sm.transition(STATES.THINK), false);
    assert.equal(sm.state, STATES.THINK);
});

test('state machine cho phép barge-in từ SPEAK về LISTEN', () => {
    const sm = new StateMachine(STATES.SPEAK);
    assert.equal(sm.transition(STATES.LISTEN, { reason: 'barge_in' }), true);
    assert.equal(sm.state, STATES.LISTEN);
});

test('splitSentences tách câu tiếng Việt và gộp mảnh ngắn', () => {
    const parts = splitSentences('Dạ em chào anh. Anh khỏe không? Em vui lắm!');
    assert.equal(parts.length, 2);
    assert.equal(parts[0], 'Dạ em chào anh.');
    assert.equal(parts[1], 'Anh khỏe không? Em vui lắm!');
});

test('splitSentences tách câu dài theo giới hạn ký tự', () => {
    const text = 'Đây là một câu rất dài được dùng để kiểm tra bộ tách câu tự động, ' +
        'nó cần được chia nhỏ để TTS có thể phát từng phần mà không phải chờ toàn bộ câu trả lời.';
    const parts = splitSentences(text, { maxChars: 60 });
    assert.ok(parts.length > 1);
    for (const part of parts) assert.ok(part.length <= 60, part);
});

test('protocol v2 encode/parse và từ chối frame legacy', () => {
    const raw = protocol.make('state', { state: 'LISTEN' });
    const parsed = protocol.parse(raw);
    assert.equal(parsed.v, 2);
    assert.equal(parsed.type, 'state');
    assert.equal(parsed.state, 'LISTEN');
    assert.equal(protocol.parse('__PING__'), null);
    assert.equal(protocol.parse('{"type":"state","v":1}'), null);
});

test('session tách turn và huỷ TTS độc lập', () => {
    const session = new Session({ ws: null, id: 'test', role: 'device' });
    const first = session.nextTurn();
    assert.equal(session.busyTurn, true);
    assert.equal(session.isCurrentTurn(first), true);
    const second = session.nextTurn();
    assert.equal(session.isCurrentTurn(first), false);
    assert.equal(session.isCurrentTurn(second), true);
    const controller = new AbortController();
    session.beginTts(controller);
    assert.equal(session.tts.active, true);
    assert.equal(session.cancelTts('barge_in'), true);
    assert.equal(controller.signal.aborted, true);
    assert.equal(session.tts.aborted, true);
    session.endTurn();
    session.endTts();
    assert.equal(session.busyTurn, false);
    assert.equal(session.tts.active, false);
});

test('session state phản ánh state machine', () => {
    const session = new Session({ ws: null, id: 'test', role: 'device' });
    assert.equal(session.state, STATES.IDLE);
    session.setState(STATES.LISTEN);
    assert.equal(session.state, STATES.LISTEN);
    assert.equal(session.toJSON().state, STATES.LISTEN);
});
