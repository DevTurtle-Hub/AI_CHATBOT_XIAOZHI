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

test('session cấu hình: silenceWindows mặc định 5 + hysteresis vadContinueThreshold, ttsProvider khởi tạo null', () => {
    const session = new Session({ ws: null, id: 'test', role: 'device' });
    assert.equal(session.config.silenceWindows, 5);
    assert.equal(session.config.vadThreshold, 0.5);
    assert.equal(session.config.vadContinueThreshold, 0.3);
    assert.ok(session.config.vadContinueThreshold < session.config.vadThreshold);
    assert.equal(session.ttsProvider, null);
});

test('TtsService synthesizeSmart: tôn trọng sticky ttsProvider và fallback khi lỗi', async () => {
    const { TtsService } = require('../server/src/audio/tts-service');
    const service = new TtsService({ provider: 'auto' });
    const calls = [];
    service._synthesizeWith = async (provider, text) => {
        calls.push({ provider, text });
        if (provider === 'edge-fail') throw new Error('edge network error');
        return Buffer.from([1, 2, 3, 4]);
    };

    const session = new Session({ ws: null, id: 'test', role: 'device' });

    // 1. Session có sticky provider = 'gtts'
    session.ttsProvider = 'gtts';
    const res1 = await service.synthesizeSmart('Chào anh', session);
    assert.equal(res1.provider, 'gtts');
    assert.equal(session.ttsProvider, 'gtts');
    assert.equal(calls[0].provider, 'gtts');

    // 2. Sticky provider bị lỗi -> tự fallback sang 'edge' và ghi nhớ session.ttsProvider = 'edge'
    session.ttsProvider = 'gtts';
    service._synthesizeWith = async (provider, text) => {
        if (provider === 'gtts') throw new Error('gtts timeout');
        return Buffer.from([5, 6]);
    };
    const res2 = await service.synthesizeSmart('Câu tiếp theo', session);
    assert.equal(res2.provider, 'edge');
    assert.equal(session.ttsProvider, 'edge');
});


const { isPrivateHost, isPrivateIp, assertPublicDns, htmlToText } = require('../server/src/ai/web-page');

test('web-page chặn URL mạng nội bộ (chống SSRF)', () => {
    assert.equal(isPrivateHost('localhost'), true);
    assert.equal(isPrivateHost('127.0.0.1'), true);
    assert.equal(isPrivateHost('192.168.1.10'), true);
    assert.equal(isPrivateHost('10.0.0.5'), true);
    assert.equal(isPrivateHost('172.16.0.1'), true);
    assert.equal(isPrivateHost('172.15.0.1'), false);
    assert.equal(isPrivateHost('news.google.com'), false);
    assert.equal(isPrivateHost(''), true);
});

test('web-page isPrivateIp: ma trận IP nội bộ vs công khai', () => {
    assert.equal(isPrivateIp('100.64.0.1'), true);      // CGNAT
    assert.equal(isPrivateIp('100.127.255.255'), true);
    assert.equal(isPrivateIp('100.128.0.1'), false);
    assert.equal(isPrivateIp('169.254.169.254'), true); // cloud metadata
    assert.equal(isPrivateIp('198.18.0.1'), true);      // benchmarking
    assert.equal(isPrivateIp('224.0.0.1'), true);       // multicast
    assert.equal(isPrivateIp('8.8.8.8'), false);
    assert.equal(isPrivateIp('1.1.1.1'), false);
    assert.equal(isPrivateIp('::1'), true);
    assert.equal(isPrivateIp('fd00::1'), true);         // ULA
    assert.equal(isPrivateIp('fe80::1'), true);         // link-local
    assert.equal(isPrivateIp('::ffff:127.0.0.1'), true); // IPv4-mapped
    assert.equal(isPrivateIp('::ffff:8.8.8.8'), false);
    assert.equal(isPrivateHost('::1'), true);
    assert.equal(isPrivateHost('[::1]'), true);
});

test('web-page assertPublicDns: từ chối tên miền trỏ vào nội bộ (rebinding)', async () => {
    assert.equal(await assertPublicDns('127.0.0.1'), 'url nội bộ');
    assert.equal(await assertPublicDns('8.8.8.8'), null);
    assert.ok(typeof (await assertPublicDns('localhost')) === 'string'); // PRIVATE_HOST chưa phải IP -> lookup fail/nội bộ
    assert.equal(await assertPublicDns('definitely-not-a-real-host.invalid'), 'không phân giải được tên miền');
});

test('web-page htmlToText bỏ script/style, giữ nội dung, giải mã entity', () => {
    const html = '<html><head><title>Test &amp; more</title><style>a{color:red}</style><script>var x=1</script></head>'
        + '<body><div class="menu">Trang chủ Giới thiệu</div><p>Giá vàng SJC mua vào <b>142,7 triệu</b> đồng.</p>'
        + '<ul><li>Độ ẩm cao &#39;nắng đẹp&#39; hôm nay.</li></ul></body></html>';
    const text = htmlToText(html, 500);
    assert.ok(!text.includes('color:red'));
    assert.ok(!text.includes('var x=1'));
    assert.ok(text.includes('142,7 triệu'));
    assert.ok(text.includes("nắng đẹp"));
    assert.ok(text.includes("Độ ẩm cao 'nắng đẹp' hôm nay."));
});

test('web-page htmlToText giải mã entity tiếng Việt (acute/horn/circ/breve)', () => {
    const html = '<body><p>Gi&aacute; v&agrave;ng &ocirc;ng H&#7891;ng, th&#7871;, ng&agrave;y 28/10, &ocirc; &#7891;.</p></body>';
    const text = htmlToText(html, 200);
    assert.ok(text.includes('Giá vàng ông Hồng'), text);
    assert.ok(text.includes('thế'), text);
    assert.ok(text.includes('ô ồ'), text);
    assert.ok(!text.includes('&a'), text);
});

// ================= NHÂN CÁCH OANH: máy trạng thái tâm trạng + DỖI =================
const { lexiconMood, isInsult, makeDecideMood, MOOD_TIP } = require('../server/src/ai/mood');

test('isInsult: chửi thẳng vào Oanh -> dỗi; chuyện thường ngày -> BÌNH THƯỜNG', () => {
    assert.equal(isInsult('sao mà ngốc vậy, đồ vô dụng'), true);
    assert.equal(isInsult('im đi, biết gì đâu'), true);           // 'im đi' = lệnh đuổi lịch sự tối thiểu
    assert.equal(isInsult('sao em ngốc vậy'), true);              // tính từ + đại từ "em"
    assert.equal(isInsult('mày câm à'), true);
    // PHẢI KHÔNG dỗi - đây chỉ là tính năng phụ, bình thường là mặc định:
    assert.equal(isInsult('bây giờ mấy giờ rồi'), false);
    assert.equal(isInsult('hôm nay anh bị sếp mắng một trận'), false);   // mắng ANH, không phải Oanh
    assert.equal(isInsult('game này dở tệ luôn'), false);                 // chê game, không chê Oanh
    assert.equal(isInsult('điện thoại của anh bị hư rồi'), false);
    assert.equal(isInsult('kể chuyện con hồ ly tinh cho anh nghe'), false); // 'hồ ly' trong truyện
});

test('lexicon mood các trạng thái thường', () => {
    assert.equal(lexiconMood('hôm nay vui quá'), 'happy');
    assert.equal(lexiconMood('anh mệt lắm'), 'sad');
    assert.equal(lexiconMood('bây giờ mấy giờ rồi'), null);
});

test('dỗi như người thật: chửi -> hurt dai 2 lượt rồi TỰ HẾT, nựng -> tan dỗi (love)', () => {
    const convos = new Map();
    const decideMood = makeDecideMood(convos);
    const ws = {};
    assert.equal(decideMood(ws, null, 'đồ ngu, vô dụng'), 'hurt');   // bị chửi
    assert.equal(decideMood(ws, null, 'bây giờ mấy giờ rồi'), 'hurt'); // dỗi dai lượt 1
    assert.equal(decideMood(ws, null, 'kể anh nghe chuyện vui'), 'hurt'); // dỗi dai lượt 2 (câu cuối)
    assert.equal(decideMood(ws, null, 'thời tiết hôm nay sao'), 'neutral');  // QUAY LẠI BÌNH THƯỜNG
    assert.equal(decideMood(ws, null, 'hôm nay vui quá'), 'happy');           // vui là vui
    // Tâm trạng THƯỜNG (vui/buồn) được giữ mượt qua các câu kế tiếp - chỉ DỖI mới tự hết
    assert.equal(decideMood(ws, null, 'bài toán này khó quá'), 'happy');
    // Tan dỗi phải THỬ LÚC ĐANG DỖI (không phải sau khi đã tự nguôi):
    assert.equal(decideMood(ws, null, 'đồ dở, biết cái gì'), 'hurt');
    assert.equal(decideMood(ws, null, 'thôi anh xin lỗi, nựng em nè'), 'love'); // tan dỗi ngay
    assert.equal(convos.get(ws).pout, 0);
    assert.equal(MOOD_TIP.hurt.includes('DỖI'), true);
});
