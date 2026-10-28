// ================================================================
// TEST E2E: robot NGHE -> AI TRẢ LỜI -> NÓI TO QUA LOA
// Giả ESP32 bằng WS client, kiểm tra trình tự gói tin từ server.
// Chạy: node test_reply_tts.js
// ================================================================
process.loadEnvFile ? 0 : 0; try { process.loadEnvFile(); } catch (e) {}
process.env.XIAOXI_IGNORE_OWNER_CHECK = '1';   // không đòi vân giọng khi test

const WebSocket = require('ws');
const axios = require('axios');
const { spawn } = require('child_process');
const { MPEGDecoder } = require('mpg123-decoder');

const ENGINE_PORT = 5025;
const SERVER_PORT = 8875;
const VOICE_URL = `http://127.0.0.1:${ENGINE_PORT}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function bump(id, ok, msg) {
    if (ok) { pass++; console.log(`  [√] ${id} ${msg}`); }
    else    { fail++; console.log(`  [X] ${id} ${msg}`); }
}

// ---------------------------------------------------------------
// 1. Tiếng nói giả: TTS thật chuẩn giọng -> PCM16 16k (làm tiếng "robot nói")
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
// 2. Boot engine + gateway con
// ---------------------------------------------------------------
let engineProc = null, engineOut = [];
function startEngine() {
    engineProc = spawn('py', ['-3.11', '-m', 'uvicorn', 'voice_engine:app',
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
let serverProc = null, serverOut = [];
function startServer() {
    const env = { ...process.env, PORT: String(SERVER_PORT), VOICE_ENGINE_URL: VOICE_URL, XIAOXI_GREETING: '0' };
    serverProc = spawn('node', ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    serverProc.stdout.on('data', d => serverOut.push(d.toString()));
    serverProc.stderr.on('data', d => serverOut.push(d.toString()));
}
async function waitServerReady() {
    for (let i = 0; i < 40; i++) {
        const joined = serverOut.join('');
        if (/Server running on port/i.test(joined)) return true;
        await sleep(500);
    }
    return false;
}

// ---------------------------------------------------------------
// 3. Scenario A: câu hỏi AI -> phải nhận TEXT reply + getToken STRING
// ---------------------------------------------------------------
async function scenarioFakeESP32(ttsMicPcm) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}`);
        let events = [];          // trình tự: TEXT / SPEAK_START / SPEAK_END / BINS
        let opened = false;
        ws.on('open', () => { opened = true; pushPcm(); });
        let idx = 0;

        // WATCHDOG: 25s không xong -> dump log cả 2 tiến trình để debug
        const watchdog = setTimeout(() => {
            console.log('\n[!] 25s chưa xong - DUMP LOG GATEWAY:');
            console.log(serverOut.join('').split('\n').slice(-25).join('\n'));
            console.log('[!] DUMP LOG ENGINE (cắt):');
            console.log(engineOut.join('').split('\n').slice(-10).join('\n'));
            try { ws.close(); } catch (e) {}
            resolve(events);
        }, 40000);

        async function pushPcm() {
            // giả ESP32 gửi mic: khung 16ms liên tục như firmware thật
            while (ws.readyState === WebSocket.OPEN && idx < ttsMicPcm.length / 512) {
                const frame = ttsMicPcm.subarray(idx * 512, (idx + 1) * 512);
                ws.send(frame);
                idx++;
                await sleep(15); // 16ms mỗi khung
            }
            // đuôi IM LẶNG 24 khung (~400ms) -> server cắt đoạn, gọi whisper
            while (ws.readyState === WebSocket.OPEN && idx < ttsMicPcm.length / 512 + 24) {
                ws.send(Buffer.alloc(512));
                idx++;
                await sleep(15);
            }
        }

        const finish = () => { clearTimeout(watchdog); try { ws.close(); } catch (e) {} resolve(events); };

        ws.on('message', (data, isBinary) => {
            if (isBinary) {
                events.push({ type: 'BIN', len: data.length });
                return;
            }
            const txt = data.toString();
            if (txt === '__SPEAK_START__') events.push({ type: 'SPEAK_START' });
            else if (txt === '__SPEAK_END__') { events.push({ type: 'SPEAK_END' }); setTimeout(finish, 500); }
            else if (txt.startsWith('__PONG__')) return;
            else if (txt.startsWith('TEXT:')) events.push({ type: 'TEXT', reply: txt.slice(5) });
            else if (txt.startsWith('AI:')) events.push({ type: 'TEXT', reply: txt.slice(3) });
            else if (txt.indexOf('__SERVO_') === 0) events.push({ type: 'SERVO', cmd: txt });
        });
        ws.on('error', (e) => { console.log('WS lỗi:', e.message); resolve(events); });
    });
}

// ---------------------------------------------------------------
// 4. main
// ---------------------------------------------------------------
async function main() {
    console.log('=== TEST TRẢ LỜI BẰNG GIỌNG NÓI (TTS e2e) ===');
    startEngine();
    if (!await waitEngineReady()) bump('0.1', false, 'engine không đứng dậy'); else bump('0.1', true, 'engine port 5025');
    startServer();
    if (!await waitServerReady()) bump('0.2', false, 'gateway không đứng dậy'); else bump('0.2', true, 'gateway port 8875');

    // "+ tiếng gọi: em ời nhờ được rănh giác":
    console.log('\n[*] Kịch bản: hỏi AI dời câu chuyện, CHỜ NÓI Loa');
    const t1 = Date.now();
    let pcm;
    try { pcm = await synthesizePCM('em ơi, kể cho anh nghe một câu chuyện vui ngắn thôi'); }
    catch (e) { bump('A.pcm', false, 'tts test không sinh được PCM: ' + e.message); pcm = null; }

    if (pcm) {
        bump('A.pcm', true, `PCM giả mic ${(pcm.length / 32000).toFixed(1)}s`);
const events = await scenarioFakeESP32(pcm);
        const traceLines = serverOut.join('').split(/\r?\n/).filter(line => line.includes('[AUDIO '));
        console.log('\n[AUDIO TRACE]');
        console.log(traceLines.length ? traceLines.join('\n') : '(khong co trace)');
        const texts  = events.filter(e => e.type === 'TEXT');
        const starts = events.filter(e => e.type === 'SPEAK_START');
        const ends   = events.filter(e => e.type === 'SPEAK_END');
        const bins   = events.filter(e => e.type === 'BIN');
        const totalBin = bins.reduce((s, e) => s + e.len, 0);

        bump('A1', starts.length === 1, `__SPEAK_START__ ${starts.length} lần`);
        if (texts.length) console.log(`      robot nói: "${texts[texts.length - 1].reply}"`);
        bump('A2', texts.length >= 1, `TEXT reply có: ${texts.length}`);
        bump('A3', bins.length >= 10, `PCM chunk loa: ${bins.length} (${(totalBin / 32000).toFixed(1)}s audio)`);
        const si = events.findIndex(e => e.type === 'SPEAK_START');
        const bi = events.findIndex(e => e.type === 'BIN');
        bump('A4', si >= 0 && bi > si, 'SPEAK đứng trước PCM (mic pause đúng)');
        bump('A5', ends.length >= 1, `__SPEAK_END__ có: ${ends.length}`);
        const ti = texts.length ? events.findIndex(e => e.type === 'TEXT') : -1;
        bump('A6', si >= 0 && ti >= 0, `thứ tự: SPEAK=${si} TEXT=${ti}`);
        console.log(`      tổng thời gian: ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    }

    console.log(`\n=== KẾT QUẢ: ${pass} PASS / ${fail} FAIL ===`);

    engineProc && engineProc.kill();
    serverProc && serverProc.kill();
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test crash:', e); process.exit(1); });

