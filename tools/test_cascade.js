// =========================================================================
// TEST AI CASCADE XIAOXI (server.js v2.1)
// Tier 0 (local 0-token servo + ghi nhớ) -> Tier 1 Gemini -> Tier 2 Groq
// Kích hoạt bằng tiếng nói thật (edge-tts) như ESP32 đang phát audio
// =========================================================================
const { spawn } = require('child_process');
const WebSocket = require('ws');
const axios = require('axios');
const { MPEGDecoder } = require('mpg123-decoder');
const { Pool } = require('pg');

const ROOT = require('path').resolve(__dirname, '..');

try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile(ROOT + '/.env'); } catch (e) {}

const ENGINE_PORT = 5015;
const SERVER_PORT = 8876;
const VOICE_URL   = `http://127.0.0.1:${ENGINE_PORT}`;
const WS_URL      = `ws://127.0.0.1:${SERVER_PORT}`;
const DB_URL      = process.env.NEON_DB_URL || '';

const results = [];
function bump(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' : ' + detail : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------
// 1. Tiếng nói: edge-tts -> MP3 -> decode -> PCM16 16k mono
// ---------------------------------------------------------------
let mp3Decoder = null;
async function synthesizePCM(text) {
    const res = await axios.post(`${VOICE_URL}/tts`, Buffer.from(text, 'utf-8'), {
        headers: { 'Content-Type': 'text/plain' },
        responseType: 'arraybuffer',
        timeout: 30000
    });
    if (!mp3Decoder) { mp3Decoder = new MPEGDecoder(); await mp3Decoder.ready; }
    const ret = mp3Decoder.decode(new Uint8Array(res.data));
    const f32 = ret.channelData[0];
    const inRate = ret.sampleRate, outRate = 16000;
    const n = Math.floor(f32.length * outRate / inRate);
    const pcm = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
        const pos = i * inRate / outRate;
        const i0 = Math.floor(pos), i1 = Math.min(f32.length - 1, i0 + 1);
        const frac = pos - i0;
        const v = f32[i0] * (1 - frac) + f32[i1] * frac;
        pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
    }
    return pcm;
}

// ---------------------------------------------------------------
// 2. Khởi động engine + server con (mỗi kịch bản một server riêng)
// ---------------------------------------------------------------
let engineProc = null;
let engineOut = [];
let srvA = null, srvB = null, srvC = null;
function startEngine() {
    engineProc = spawn('py', ['-3.11', '-m', 'uvicorn', 'voice_engine:app',
        '--app-dir', ROOT + '/engine',
        '--port', String(ENGINE_PORT), '--log-level', 'warning'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    engineProc.stdout.on('data', d => engineOut.push(d.toString()));
    engineProc.stderr.on('data', d => engineOut.push(d.toString()));
}
async function waitEngineReady() {
    for (let i = 0; i < 60; i++) {
        try {
            const h = await axios.get(`${VOICE_URL}/health`, { timeout: 700 });
            if (h.status === 200) return true;
        } catch (e) {}
        await sleep(500);
    }
    return false;
}

function startServer(envOverrides = {}) {
    const env = {
        ...process.env,
        PORT: String(SERVER_PORT),
        VOICE_ENGINE_URL: VOICE_URL,
        XIAOXI_GREETING: '0',
        ...envOverrides
    };
    const child = spawn('node', [ROOT + '/server/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const shards = [];
    child.stdout.on('data', d => shards.push(d.toString()));
    child.stderr.on('data', d => shards.push(d.toString()));
    const outText = () => shards.join('');
    return {
        child, outText,
        stop: () => new Promise((resolve) => {
            let done = false;
            child.on('exit', () => { if (!done) { done = true; resolve(); } });
            if (process.platform === 'win32' && child.pid) {
                try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
            } else {
                try { child.kill('SIGTERM'); } catch (e) {}
            }
            setTimeout(() => { if (!done) { done = true; resolve(); } }, 1500);
        })
    };
}

async function connectWS(maxTries = 15) {
    for (let i = 0; i < maxTries; i++) {
        try {
            return await new Promise((resolve, reject) => {
                const ws = new WebSocket(WS_URL);
                const msgs = [];
                ws.on('message', (data, isBin) => { if (!isBin) msgs.push(data.toString()); });
                ws.on('open', () => resolve({ ws, msgs }));
                ws.on('error', reject);
            });
        } catch (e) {
            if (i === maxTries - 1) throw e;
            await sleep(500);
        }
    }
}

async function speakOnce({ ws, msgs, pcm, waitMs = 16000 }) {
    await sleep(400);
    const before = msgs.length;
    ws.send(pcm);
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
        await sleep(200);
        const newMsgs = msgs.slice(before);
        if (newMsgs.includes('__SPEAK_END__')) {
            await sleep(400); // Chờ lắng nghe chuyển trạng thái hoàn tất
            break;
        }
    }
    return msgs.slice(before);
}

function hasSub(commands, sub) { return commands.some(c => c.includes(sub)); }
// Reply AI có 2 đại diện: "TEXT:<nội dung>" ( Nếu hệ thống cũ) và "AI:<nội dung>" (protocol mới)
function replyText(c) {
    if (c.startsWith('TEXT:')) return c.slice(5);
    if (c.startsWith('AI:')) return c.slice(3);
    return null;
}
function replies(cmds) { return cmds.filter(c => replyText(c) !== null); }

// ---------------------------------------------------------------
// 3. Kịch bản
// ---------------------------------------------------------------
async function main() {
    console.log('\n===== BO TIEN TRI AI XIAOXI (cascade) =====');
    console.log(`VOICE=${VOICE_URL} | SERVER=${WS_URL}\n`);

    startEngine();
    const engineReady = await waitEngineReady();
    bump('0. Engine FastAPI khoi dong', engineReady, engineReady ? 'health 200' : 'health KHONG chay');
    if (!engineReady) throw new Error('Engine không chạy được');

    // Pre-synthesize audio
    const pcmServo = await synthesizePCM('em ơi gập đầu lên cho anh');
    const pcmMem   = await synthesizePCM('em ơi ghi nhớ giúp anh lịch nhà máy là chiều thứ sáu');
    const pcmAsk   = await synthesizePCM('em ơi tình hình thế giới hôm nay thế nào?');
    const pcmGuest = await synthesizePCM('em ơi gập đầu lên cho anh');
    bump('0.1 Bien tieng noi thanh PCM', pcmServo.length > 20000, `${pcmServo.length} bytes`);

    // ---------- KỊCH BẢN A: thường (Gemini ưu tiên + local 0-token) ----------
    console.log('\n[A] Server binh thuong (Gemini uu tien, override chu nhan)');
    srvA = startServer({ XIAOXI_IGNORE_OWNER_CHECK: '1', GEMINI_TIMEOUT_MS: '20000' });
    await sleep(2500);
    const connA = await connectWS();
    await sleep(1200);

    let cmds = await speakOnce({ ws: connA.ws, msgs: connA.msgs, pcm: pcmServo });
    const a1Pass = hasSub(cmds, '__SERVO_HEAD_UP__') && srvA.outText().includes('[⚡ LOCAL (0 token)]');
    if (!a1Pass) {
        console.log('[DEBUG A1 cmds]:', cmds);
        console.log('[DEBUG A1 outText]:', srvA.outText().slice(-600));
    }
    bump('A1. LENH SERVO LOCAL (0 token)',
         a1Pass,
         cmds.filter(c => c.startsWith('TEXT')).join(' | ').slice(0, 80));

    cmds = await speakOnce({ ws: connA.ws, msgs: connA.msgs, pcm: pcmMem, waitMs: 14000 });
    const a2Pass = replies(cmds).some(c => replyText(c).toLowerCase().includes('ghi nho')) &&
                   srvA.outText().includes('[⚡ LOCAL (0 token)]');
    if (!a2Pass) {
        console.log('[DEBUG A2 cmds]:', cmds);
        console.log('[DEBUG A2 outText]:', srvA.outText().slice(-600));
    }
    bump('A2. GHI NHO LOCAL (0 token)',
         a2Pass,
         replies(cmds).map(replyText).join(' | ').slice(0, 90));

    cmds = await speakOnce({ ws: connA.ws, msgs: connA.msgs, pcm: pcmAsk, waitMs: 24000 });
    // Chuyện thật 2026: Gemini FREE-TIER có khi cạn quota (HTTP 429) - khi đó robot
    // phải tự dự phòng sang Groq và VẪN trả lời được. PASS nếu AI trả lời dù tầng nào.
    const tierGemini = srvA.outText().includes('[🧠 GEMINI OK]');
    const tierGroq   = srvA.outText().includes('[🧠 GROQ OK]');
    const hasAnswer  = replies(cmds).length > 0;
    const tierNote = tierGemini ? 'GEMINI uu tien OK' : (tierGroq ? 'GEMINI 429/quota -> GROQ dang phu tro' : '(khong ro tier)');
    bump('A3. CAU HOI -> AI tra loi (Gemini uu tien, Groq du phong)',
         hasAnswer && (tierGemini || tierGroq),
         `tang: ${tierNote} | "${replies(cmds).map(replyText).join(' ').slice(0, 60)}"`);

    await connA.ws.close();
    if (DB_URL) {
        const pool = new Pool({ connectionString: DB_URL, max: 2 });
        const { rows } = await pool.query(
            `SELECT key_name, content FROM user_memories
             WHERE key_name ILIKE '%nhà máy%' AND content ILIKE '%chiều thứ%'
             ORDER BY created_at DESC LIMIT 1`
        );
        bump('A4. LUU VAO DB (user_memories)', rows.length > 0, rows[0] ? `[${rows[0].key_name}] ${rows[0].content}` : '');
        if (rows.length > 0) {
            await pool.query(`DELETE FROM user_memories WHERE key_name ILIKE '%nhà máy%' AND content ILIKE '%chiều thứ%'`);
        }
        await pool.end();
    }
    await srvA.stop();

    // ---------- KỊCH BẢN B: GEMINI TẮT KEY -> FALLBACK GROQ ----------
    console.log('\n[B] GEMINI_API_KEY trong -> phai fallback Groq');
    srvB = startServer({ XIAOXI_IGNORE_OWNER_CHECK: '1', GEMINI_API_KEY: '' });
    await sleep(2500);
    const connB = await connectWS();
    await sleep(1200);

    cmds = await speakOnce({ ws: connB.ws, msgs: connB.msgs, pcm: pcmAsk });
    bump('B1. FALLBACK GROQ khi Gemini khong co key',
         srvB.outText().includes('[🧠 GROQ OK]') && replies(cmds).length > 0,
         replies(cmds).map(replyText).join(' | ').slice(0, 90));

    await connB.ws.close();
    await srvB.stop();

    // ---------- KỊCH BẢN C: KHÁCH LẠ LỆNH SERVO -> BỊ CHẶN ----------
    console.log('\n[C] Khach la (KHONG co ignore_owner_check) lenh servo');
    srvC = startServer({});
    await sleep(2500);
    const connC = await connectWS();
    await sleep(1200);

    const servoMsgs = await speakOnce({ ws: connC.ws, msgs: connC.msgs, pcm: pcmGuest });
    const denyText = replies(servoMsgs).map(replyText).join(' ');
    const blocked = !hasSub(servoMsgs, '__SERVO_') &&
                    denyText.includes('anh Quy') &&
                    srvC.outText().includes('[🔒 BẢO MẬT]');
    bump('C1. Khach la bi chan dieu khien (0 token)',
         blocked, denyText.slice(0, 90));

    await connC.ws.close();
    await srvC.stop();

    // Kill engine sau cùng
    if (process.platform === 'win32' && engineProc?.pid) {
        try { spawn('taskkill', ['/PID', String(engineProc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
    } else {
        try { engineProc.kill('SIGTERM'); } catch (e) {}
    }

    // ---------- TỔNG ----------
    const passed = results.filter(r => r.ok).length;
    console.log('\n=========================================');
    console.log(`TONG: ${passed}/${results.length} PASSED`);
    console.log('=========================================');
    process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
    console.error('\n[TEST LOI]', e);
    if (typeof srvA !== 'undefined' && srvA?.outText) {
        console.error('\n[SERVER OUTPUT]:\n', srvA.outText());
    }
    if (typeof engineOut !== 'undefined') {
        console.error('\n[ENGINE OUTPUT]:\n', engineOut.join(''));
    }
    process.exit(1);
});
