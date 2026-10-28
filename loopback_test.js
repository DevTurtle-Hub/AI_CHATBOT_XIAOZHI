// =============================================================================
// [LOOPBACK TEST] Phan dinh loi am thanh XiaoXi do moi khuc:
//   1) Thu giam PCm tu mic robot qua WS -> do RMS/peak (chat luong thu am)
//   2) Gui doan qua Groq Whisper -> STT doc duoc gi (mic + nguong ok?)
//   3) PHAT NGUYEN AM DO RA LOA (sine-free: PCM raw 16k, KHONG qua mp3/decode)
//      -> anh NGHE:  echo SACH nhu giong anh = chuyen phat loa + ring OK
//                    echo cung RE  = phan cung loa/day/nguon (code cuu duoc)
//
// CACH DUNG:
//   1) Tat run_xiaoxi.bat di (nhuong robot van bat + ket noi WiFi)
//   2) Chay:  loopback_test.bat     (hoac: node loopback_test.js)
//   3) Robot TFT se sang man "SAN SANG" -> noi hi hi 5 giay -> nghi
//   4) Doc ket qua tren may tinh + robot tu phat lai giong minh (echo)
// =============================================================================

try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile(); } catch (_) {}

const { spawn } = require('child_process');
const dgram = require('dgram');
const WebSocket = require('ws');
const fs = require('fs');

const WS_PORT = parseInt(process.env.LOOP_PORT || '8765');
const UDP_PORT = 34567;
const PCM_RATE = 16000;
const BYTES_PER_SEC = PCM_RATE * 2;   // mono 16-bit

let robotWs = null;
let audioBuf = Buffer.alloc(0);
let lastSpeechAt = 0;
let speechDetected = false;
const SPEECH_RMS_THRESHOLD = Number(process.env.LOOP_SPEECH_RMS || '0.008');
let startedAt = 0;
let maxRMS = 0, avgRMSMs = 0, rmsSamples = 0;
let finished = false;

const tmp = (b) => { const n = b.length >> 1; let s = 0; for (let i = 0; i < n; i++) s += b.readInt16LE(i * 2) ** 2; return Math.sqrt(s / Math.max(1, n)) / 32768; };

console.log('=== [LOOPBACK] Kiem tra am thanh robot ===');
console.log(`[LOOPBACK] WS listen :${WS_PORT} + UDP discovery reply :${UDP_PORT}`);

// UDP discovery giong hehe server chinh: robot quet va ket noi nhanh
const udp = dgram.createSocket('udp4');
udp.on('message', (m, r) => {
    console.log(`[UDP] Robot muon tim server tu ${r.address}`);
    udp.send(`XIAOXI_DISCOVERY|${WS_PORT}`, r.port, r.address, () => {});
});
udp.bind(UDP_PORT, () => { try { udp.setBroadcast(true); } catch (e) {} });

const wss = new WebSocket.Server({ port: WS_PORT });
wss.on('connection', (ws) => {
    robotWs = ws;
    console.log(`[WS] ROBOT da ket noi! Bat dau cho anh noi gi do...`);
    ws.on('message', async (data) => {
        if (!Buffer.isBuffer(data) || data.length < 256) return; // qua ngan - lam xong cham
        if (finished) return;
        if (startedAt === 0) startedAt = Date.now();
        audioBuf = Buffer.concat([audioBuf, data]);
        const r = tmp(data);
        if (r >= SPEECH_RMS_THRESHOLD) { speechDetected = true; lastSpeechAt = Date.now(); }
        if (r > 0.004) {
            avgRMSMs += r; rmsSamples++;
            if (r > maxRMS) maxRMS = r;
        }
        const secs = (audioBuf.length / BYTES_PER_SEC).toFixed(1);
        process.stdout.write(`\r[LOOPBACK] Dang thu: ${secs}s  RMS=${r.toFixed(3)}  peak=${maxRMS.toFixed(3)}  `);
        if (speechDetected && Date.now() - lastSpeechAt > 1400 && audioBuf.length > BYTES_PER_SEC * 1.0) finish();
        if (audioBuf.length > BYTES_PER_SEC * 25) finish();  // trần 25s
    });
    ws.on('close', () => { if (!finished) { console.log('\n[WS] Robot ngat ket noi - thoat'); process.exit(0); } });
});

async function transcribeGroq(pcm) {
    // WAV header 16k mono 16-bit cho Groq whisper
    const wav = Buffer.alloc(44 + pcm.length);
    wav.write('RIFF', 0);  wav.writeUInt32LE(36 + pcm.length, 4);  wav.write('WAVE', 8);
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);  wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22); wav.writeUInt32LE(PCM_RATE, 24);
    wav.writeUInt32LE(PCM_RATE * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', wav, { filename: 'a.wav', contentType: 'audio/wav' });
    form.append('model', 'whisper-large-v3-turbo');
    const res = await require('axios').post('https://api.groq.com/openai/v1/audio/transcriptions',
        form, { headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 20000 });
    return res.data.text || '';
}

async function finish() {
    if (finished) return;
    finished = true;
    const secs = audioBuf.length / BYTES_PER_SEC;
    console.log(`\n\n`);
    const avg = rmsSamples ? avgRMSMs / rmsSamples : 0;
    console.log('================ CHAN DOAN THU AM ================');
    console.log(`Do dai:    ${secs.toFixed(2)}s | RMS TB: ${avg.toFixed(3)} | peak: ${maxRMS.toFixed(3)}`);
    if (avg > 0.02)      console.log('=> Mic thu DAT (tieng noi ro, khong bat dang tin cai bon) - OK');
    else if (avg > 0.008) console.log('=> Mic THU DUOC NHUNG YEU/thu tin - dan amp gain mic lon hon hoac anh noi gan hon');
    else                  console.log('=> Mic QUYET IM HOAC SAI DAY - kiem tra day mic INMP441 (WS/SCK/SD/L<-GND)');
    try {
        fs.writeFileSync('loopback_mic.pcm', audioBuf);
        console.log(`[FILE] Da luu loopback_mic.pcm (${(audioBuf.length / 1024).toFixed(0)} KB) de phan tich sau`);
    } catch (e) {}
    try {
        const t = await transcribeGroq(audioBuf);
        console.log(`[STT] Whisper doc duoc: "${t || '(trong - STT long khong nhan ra)'}"`);
        console.log(t ? '=> Mic -> STT CHINH XAC: phan thu am tot, loi khong nam o day' : '=> STTONG TIN NAY hneh ro - tim kiem huong sua tiep: mic yeu, preprocessing dan rong, moi bien');
    } catch (e) {
        console.log(`[STT] Loi Groq: ${e.message}`);
    }
    if (!robotWs || robotWs.readyState !== 1) { console.log('[LOOPBACK] Robot het ket noi - thoat'); process.exit(0); }
    console.log('\n>>> GIO PHAT NGUYEN AM DA THU RA LOA (echo, KHONG QUA mp3) <<<');
    console.log('    NGHE VOI TAY: echo SACH = chuoi thu+phat OK, loi o dau mp3/TTS phuc tap');
    console.log('                 echo cung RE = phan cung (amp/day II2S/nguon)');
    console.log('    Dang phat...\n');

    // == CHUỖI TTS kiểu TTS: __SPEAK_START__ -> chunks paced -> __SPEAK_END__
    robotWs.send('__SPEAK_START__');
    const CHUNK = 5120, LEAD_MS = 900;
    const t0 = Date.now(); let sent = 0;
    for (let off = 0; off < audioBuf.length; off += CHUNK) {
        const piece = audioBuf.subarray(off, Math.min(off + CHUNK, audioBuf.length));
        robotWs.send(piece); sent += CHUNK;
        const wait = (sent / BYTES_PER_SEC * 1000) - LEAD_MS - (Date.now() - t0);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
    const drain = (audioBuf.length / BYTES_PER_SEC * 1000) - (Date.now() - t0) + 800;
    await new Promise(r => setTimeout(r, Math.max(300, drain)));
    robotWs.send('__SPEAK_END__');
    console.log('[LOOPBACK] Echo phat xong. Danh gia cons睫, tiet text, hang bao thoi: +2s thoat.');
    await new Promise(r => setTimeout(r, 2500));
    console.log('==================================================');
    process.exit(0);
}

// Tho Covey t cold: 40s khong co robot ket noi -> exit
setTimeout(() => { if (!robotWs) { console.log('\n[LOOPBACK] 40s chua thay robot ket noi - hop IoXiaoXi dang chay server khac! Tat run_xiaoxi.bat roi thu lai.'); process.exit(1); } }, 40000).unref();


