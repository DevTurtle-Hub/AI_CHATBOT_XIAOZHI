// =========================================================================
// TEST TÂM TRẠNG & BIỂU CẢM XIAOXI (server.js v2.2)
// Gửi "DEBUG:<câu>" qua WS -> robot phải bốc đúng mood -> đúng mặt __FACE_*
// và trả lời theo phong cách "bạn thân". Không cần mic/STT/servo.
// =========================================================================
const { spawn } = require('child_process');
const WebSocket = require('ws');
const axios = require('axios');
const pg = require('pg');

const ENGINE_PORT = 5035;
const SERVER_PORT = 8877;
const ROOT = require('path').resolve(__dirname, '..');

const VOICE_URL   = `http://127.0.0.1:${ENGINE_PORT}`;
const WS_URL      = `ws://127.0.0.1:${SERVER_PORT}`;

const results = [];
function bump(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' : ' + detail : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let engineProc = null, serverProc = null;
const engineOut = [], serverOut = [];

async function up() {
    // Dọn nhật ký hội thoại cũ (robot không "manh nha" chuyện của những lần test trước)
    if (process.env.NEON_DB_URL) {
        try {
            const pool = new pg.Pool({ connectionString: process.env.NEON_DB_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
            await pool.query('DELETE FROM chat_log');
            await pool.end();
        } catch (e) { console.log('   (khong dung duoc DB de don chat_log:', e.message + ')'); }
    }
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
    const env = { ...process.env, PORT: String(SERVER_PORT), VOICE_ENGINE_URL: VOICE_URL, XIAOXI_GREETING: '0', GEMINI_API_KEY: '' };
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
        try { p.kill('SIGTERM'); } catch (e) {}
    }
    await sleep(400);
}

// Fake ESP32: nhận lệnh mặt/AI + chunk loa
function connectFakeESP32() {
    const cmds = [];
    let resolveOpen;
    const opened = new Promise(r => { resolveOpen = r; });
    const ws = new WebSocket(WS_URL);
    ws.on('error', (e) => console.log('   [ws err]', e.message));
    ws.on('open', resolveOpen);
    ws.on('message', (m, isBin) => { if (!isBin) cmds.push(m.toString()); });
    return { ws, cmds, opened };
}

// Chờ robot nói xong lượt trước (dồn __SPEAK_END__) trước khi gửi lượt mới -
// match đúng hành vi busyTurn guard của server (chặn lượt chồng nhau)
async function waitSpeakDone(fake, timeoutMs = 30000) {
    const idx = (c) => fake.cmds.map(x => x).lastIndexOf(c);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const start = idx('__SPEAK_START__'), end = idx('__SPEAK_END__');
        if (end > start) return true;
        await sleep(300);
    }
    return false;
}

// Gửi 1 câu DEBUG -> đợi mặt + AI: reply về (tối đa 25s)
async function talkAndWait(fake, text, expectedFace, timeoutMs = 25000) {
    const t0 = Date.now();
    fake.ws.send(`DEBUG:${text}`);
    let okFace = false, reply = null;
    while (Date.now() - t0 < timeoutMs) {
        if (fake.cmds.some(c => c.startsWith('__FACE_'))) okFace = fake.cmds.includes(expectedFace);
        const ai = fake.cmds.filter(c => c.startsWith('AI:'));
        if (okFace && ai.length) { reply = ai[ai.length - 1].slice(3); break; }
        await sleep(300);
    }
    return { okFace, reply, elapsed: Date.now() - t0 };
}

(async () => {
    let fake = null;
    console.log('=== TEST TÂM TRẠNG THÀNH BIỂU CẢM (mood -> face) ===');
    try {
        await up();
        console.log('\n[*] Khởi động');
        bump('0.1 engine khoi dong', engineProc && !engineProc.killed);
        bump('0.2 gateway khoi dong', true);

        fake = connectFakeESP32();
        await fake.opened;
        bump('0.3 gia ESP32 ket noi', fake.ws.readyState === fake.ws.OPEN);
        await sleep(1200);

        console.log('\n[*] Kịch bản mood (DEBUG chữ)');

        const sad = await talkAndWait(fake, 'hôm nay anh mệt quá, không muốn nói chuyện với ai', '__FACE_SAD__', 40000);
        bump('A. BUON/MET -> mat Sad + AI tra loi', sad.okFace && !!sad.reply, `mat dap ung | "${(sad.reply || '').slice(0, 40)}" (${(sad.elapsed / 1000).toFixed(1)}s)`);
        await waitSpeakDone(fake);

        const happy = await talkAndWait(fake, 'haha vui quá trời, hôm nay trúng tuyển cấp 3!', '__FACE_HAPPY__', 40000);
        bump('B. VUI -> mat Happy + AI tra loi', happy.okFace && !!happy.reply, `mat dap ung | "${(happy.reply || '').slice(0, 40)}" (${(happy.elapsed / 1000).toFixed(1)}s)`);
        await waitSpeakDone(fake);

        const angry = await talkAndWait(fake, 'bực mình ghê, anh giận lắm rồi đó', '__FACE_ANGRY__', 40000);
        bump('C. GIẬN -> mat Angry + AI tra loi', angry.okFace && !!angry.reply, `mat dap ung | "${(angry.reply || '').slice(0, 40)}" (${(angry.elapsed / 1000).toFixed(1)}s)`);
        await waitSpeakDone(fake);

        const love = await talkAndWait(fake, 'anh yêu em nhiều lắm, em là bảo bối của anh nha', '__FACE_LOVE__', 40000);
        bump('D. YÊU THƯƠNG -> mat Love + AI tra loi', love.okFace && !!love.reply, `mat dap ung | "${(love.reply || '').slice(0, 40)}" (${(love.elapsed / 1000).toFixed(1)}s)`);

        const gotFaces = fake.cmds.filter(c => c.startsWith('__FACE_'));
        bump('E. Co n > 0 mat duoc ve', gotFaces.length >= 4, `count=${gotFaces.length}`);
        bump('F. Loa phat am tap nhan (SPEAK)', fake.cmds.some(c => c === '__SPEAK_START__'), fake.cmds.filter(c => c === '__SPEAK_START__').length + ' lần');

        const joined = serverOut.join('');
        bump('G. Log TAM TRANG chi tiet (mood explain)', /TAM TRANG/.test(joined));
    } catch (e) {
        console.log('   BANG RENG: trung loi ngoai le:', e.message);
    } finally {
        await down();
        const ok = results.filter(r => r.ok).length;
        console.log(`\n=== KET QUA: ${ok} PASS / ${results.length - ok} FAIL ===`);
        if (ok < results.length) {
            console.log('--- server log 3000 ki tu cuoi ---');
            console.log(serverOut.join('').slice(-3000));
            console.log('--- cmds fake ESP32 nhan duoc ---');
            console.log(fake.cmds.join(' | ').slice(0, 2000));
        }
        process.exit(ok === results.length ? 0 : 1);
    }
})();
