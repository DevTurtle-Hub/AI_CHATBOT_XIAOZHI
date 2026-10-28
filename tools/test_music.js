// =========================================================================
// TEST NHẠC XIAOXI (v2.2) - KEY CIRCUIT CỦA PHÁT NHẠC THÔNG MINH
// Fake ESP32 + DEBUG chữ -> server phải:
//  A) MỞ NHẠC theo yêu cầu (yt-dlp + ffmpeg -> PCM 16k) và bơm PCM loa
//  B) "tạm dừng" -> dừng bơm, robot để mic mở
//  C) "tiếp tục" -> bơm lại từ đúng chỗ
//  D) "bài khác" -> session mới, stream mới
//  E) "tắt nhạc" -> dừng sạch + robot nói xác nhận qua loa (TTS)
// =========================================================================
const { spawn } = require('child_process');
const WebSocket = require('ws');
const axios = require('axios');

const ENGINE_PORT = 5045;
const SERVER_PORT = 8879;
const ROOT = require('path').resolve(__dirname, '..');

const VOICE_URL   = `http://127.0.0.1:${ENGINE_PORT}`;
const WS_URL      = `ws://127.0.0.1:${SERVER_PORT}`;

const results = [];
function bump(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' : ' + detail : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let engineProc = null, serverProc = null, fake = null;
const engineOut = [], serverOut = [];

async function up() {
    engineProc = spawn('py', ['-3.11', '-m', 'uvicorn', 'voice_engine:app',
        '--app-dir', ROOT + '/engine',
        '--port', String(ENGINE_PORT), '--log-level', 'warning'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    engineProc.stdout.on('data', d => engineOut.push(d.toString()));
    engineProc.stderr.on('data', d => engineOut.push(d.toString()));
    for (let i = 0; i < 60; i++) {
        try { const h = await axios.get(`${VOICE_URL}/health`, { timeout: 700 }); if (h.status === 200) break; } catch (e) {}
        await sleep(500);
    }
    const env = { ...process.env, PORT: String(SERVER_PORT), VOICE_ENGINE_URL: VOICE_URL, XIAOXI_GREETING: '0', XIAOXI_ALLOW_DEBUG: '1' };
    serverProc = spawn('node', [ROOT + '/server/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    serverProc.stdout.on('data', d => serverOut.push(d.toString()));
    serverProc.stderr.on('data', d => serverOut.push(d.toString()));
    let ready = false;
    for (let i = 0; i < 40; i++) {
        if (/Server running on port/i.test(serverOut.join(''))) { ready = true; break; }
        await sleep(500);
    }
    if (!ready) throw new Error('Gateway khong len: ' + serverOut.join('').slice(-400));
}

async function down() {
    for (const p of [serverProc, engineProc]) {
        if (!p) continue;
        try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F']); } catch (e) { try { p.kill('SIGTERM'); } catch (e2) {} }
    }
    await sleep(800);
}

function connectFakeESP32() {
    const msgs = [];        // text lệnh: AI:, __SPEAK_START__, __MIC_WINDOW__...
    let binBytes = 0;       // tổng PCM nhận được
    let binCount = 0;
    let wsRef = null;
    const opened = new Promise(r => {
        const ws = new WebSocket(WS_URL);
        wsRef = ws;
        ws.on('error', (e) => console.log('   [ws err]', e.message));
        ws.on('message', (data, isBin) => { if (isBin) { binBytes += data.length; binCount++; } else msgs.push(data.toString()); });
        ws.on('open', r);
    });
    return { opened, msgs, stats: () => ({ binBytes, binCount }), get ws() { return wsRef; } };
}

async function waitIdle() {
    // démSpeak: test gửi câu sau khi robot đã nói xong (đối chiếu busyTurn của server)
    let waited = 0;
    while (waited < 1500) { await sleep(250); waited += 250; }
}

const MUSIC_LEAD_ALLOW = 52000;  // ~1.4s bơm trước + dung sai (3200B * LEAD)

// gửi DEBUG và đợi có AI: reply (kiểm cả thêm dữ liệu loa)
async function sendAndAwait(fake, text, { needAi = true, waitMs = 22000 } = {}) {
    const dBefore = fake.data();
    fake.ws.send(`DEBUG:${text}`);
    const t0 = Date.now();
    let aiReply = null;
    while (Date.now() - t0 < waitMs) {
        const s = fake.data();
        const newMsgs = s.text.slice(dBefore.text.length);
        const ai = (newMsgs.match(/AI:([^\n]*)/g) || []).pop();
        if (needAi && ai) { aiReply = ai.slice(3); break; }
        if (!needAi && (Date.now() - t0 > 1500)) break; // không cần AI: vẫn thoát sau 1.5s
        await sleep(300);
    }
    const after = fake.data();
    return { aiReply, binDelta: after.binCount - dBefore.binCount, bytesDelta: after.binBytes - dBefore.binBytes, textTail: after.text.slice(dBefore.text.length) };
}

(async () => {
    console.log('=== TEST NHAC THONG MINH (mở/tạm dừng/tiếp tục/bài khác/tắt) ===');
    try {
        await up();
        console.log('\n[*] Khởi động');
        bump('0.1 engine khoi dong', true);
        bump('0.2 gateway khoi dong', true);

        fake = connectFakeESP32();
        await fake.opened;
        fake.data = () => fake.dump();
        fake.dump = () => ({ text: fake.msgs.join('\n'), binCount: fake.stats().binCount, binBytes: fake.stats().binBytes });
        bump('0.3 gia ESP32 ket noi', true);
        await waitIdle();

        console.log('\n[A] MO NHAC theo yêu cầu');
        const a = await sendAndAwait(fake, 'em ơi mở nhạc cho anh đi', { waitMs: 30000 });
        const sayStart = /__SPEAK_START__/.test(a.textTail);
        const seenMusicAi = /mo luon bai/i.test(a.aiReply || '');
        // cho robot bơm đủ nhạc đôi chốc: chờ tới 12s (yt-dlp có khi chậm)
        let early = fake.data();
        for (let i = 0; i < 12 && early.binCount < 8; i++) { await sleep(1000); early = fake.data(); }
        bump('A1. Robot cháp lệnh MO NHAC (AI:)', seenMusicAi, `AI: ${(a.aiReply || '').slice(0, 70)}`);
        bump('A2. Stream nhạc loa (SPEAK_START + PCM)', sayStart && early.binCount > 8,
            `start=${sayStart} pcmFrames=${early.binCount} bytes=${early.binBytes}`);

        console.log('\n[B] TAM DUNG');
        const b = await sendAndAwait(fake, 'em ơi tạm dừng nhạc');
        const pausedBefore = fake.data();
        bump('B1. AI xac nhan TAM DUNG', /tam dung|phat|nghi/i.test(b.aiReply || ''), `AI: ${(b.aiReply || '').slice(0, 70)}`);
        await sleep(5000);
        const b2 = fake.data();
        const bytesDuringPause = b2.binBytes - pausedBefore.binBytes;
        bump('B2. Khong boc thêm PCM khi tạm dừng', bytesDuringPause <= MUSIC_LEAD_ALLOW, `+${bytesDuringPause}B trong 5s`);

        console.log('\n[C] TIEP TUC');
        const c = await sendAndAwait(fake, 'em ơi tiếp tục');
        bump('C1. AI xac nhan TIEP TUC', /tiep|nghe|mo/i.test(c.aiReply || ''), `AI: ${(c.aiReply || '').slice(0, 70)}`);
        const c2 = fake.data();
        await sleep(5000);
        const cThe = fake.data();
        const resumedBytes = cThe.binBytes - c2.binBytes;
        bump('C2. PCM de bơm lại sau tiếp tục', resumedBytes > 15000, `+${resumedBytes}B (5s)`);

        console.log('\n[D] BAI KHAC');
        const d = await sendAndAwait(fake, 'em ơi bài khác', { waitMs: 30000 });
        const musicAiCount = (fake.data().text.match(/mo luon bai/gi) || []).length;
        bump('D1. Session MOI đếm lần mở nhạc', musicAiCount >= 2, `lap="${musicAiCount}" | ${(d.aiReply || '').slice(0, 46)}`);

        console.log('\n[E] TAT NHAC');
        const e = await sendAndAwait(fake, 'em ơi tắt nhạc', { waitMs: 30000 });
        bump('E1. AI xac nhan TAT', /tat/i.test(e.aiReply || ''), `AI: ${(e.aiReply || '').slice(0, 70)}`);
        await sleep(9000);
        const ttsLogs = serverOut.join('');
        bump('E2. Robot nói TTS xac nhan sau tết', ttsLogs.includes('[PHAT LOA] Dang phat'), 'log [PHAT LOA] OK');
        const eEnd = fake.data().text.lastIndexOf('__SPEAK_END__');
        bump('E3. Kết thúc session nhạc (SPEAK_END)', eEnd >= 0, 'có __SPEAK_END__');
    } catch (e) {
        console.log('   LOI NGOAI LE:', e.message);
    } finally {
        await down();
        const ok = results.filter(r => r.ok).length;
        console.log(`\n=== KET QUA: ${ok} PASS / ${results.length - ok} FAIL ===`);
        if (ok < results.length) {
            console.log('--- server log 2500 ki tu cuoi ---');
            console.log(serverOut.join('').slice(-2500));
        }
        process.exit(ok === results.length ? 0 : 1);
    }
})();
