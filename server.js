// =========================================================================
// ROBOT XIAOXI AI SERVER - GOLD MASTER VERSION v2
// Node.js Gateway: WebSocket + Whisper/Llama Agent + Neon DB + Face Queue
// =========================================================================

// Load .env (Node >= 20) - fallback để không crash nếu thiếu .env
try {
    if (typeof process.loadEnvFile === 'function') process.loadEnvFile();
} catch (e) { /* .env không tồn tại hoặc lỗi cú pháp - dùng biến môi trường hệ thống */ }

const { WebSocketServer } = require('ws');
const axios = require('axios');
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { Pool } = require('pg');
const { spawn } = require('child_process');
const ytSearch = require('yt-search');

const { STATES } = require('./src/core/state-machine');
const protocol = require('./src/core/protocol');
const { Session } = require('./src/core/session');
const { TtsService } = require('./src/audio/tts-service');

// =========================================================================
// 0. CẤU HÌNH
// =========================================================================
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8765;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const NEON_DB_URL  = process.env.NEON_DB_URL || "";
const VOICE_ENGINE_URL = process.env.VOICE_ENGINE_URL || 'http://127.0.0.1:5005';

if (!GROQ_API_KEY)  console.warn('[⚠ CONFIG] GROQ_API_KEY chưa đặt trong .env - AI sẽ không hoạt động!');
if (!NEON_DB_URL)   console.warn('[⚠ CONFIG] NEON_DB_URL chưa đặt trong .env - trí nhớ bị tắt.');

// Groq (HTTPS) cần CORS-safelisted headers sạch; agent riêng tránh keepAlive gây ngắt ảnh STT
const groqHttpAgent = new https.Agent({ keepAlive: true, maxSockets: 5 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });
const axiosPython = axios.create({ baseURL: VOICE_ENGINE_URL, httpAgent, timeout: 700 });
const axiosVoice  = axios.create({ baseURL: VOICE_ENGINE_URL, httpAgent, timeout: 10000 });

// =========================================================================
// 0b. TTS NÓI TO CÂU TRẢ LỜI: edge-tts -> MP3 -> PCM16 16kHz mono -> ESP32
//     (loa MAX98357A lấy data từ ring buffer 48KB của firmware)
// =========================================================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ttsService = new TtsService({
    axios: axiosVoice,
    rate: process.env.TTS_RATE || '+18%',
    sentenceStreaming: process.env.TTS_SENTENCE_STREAMING !== '0',
    leadMs: parseInt(process.env.TTS_LEAD_MS || '1400', 10),
    drainMs: parseInt(process.env.TTS_DRAIN_MS || '900', 10)
});

let audioTraceSeq = 0;
function newAudioTraceId() { return `${Date.now().toString(36)}-${(++audioTraceSeq).toString(36)}`; }
function logAudioTrace(traceId, stage, details = {}) {
    console.log(`[AUDIO ${traceId}] ${stage} ${JSON.stringify(details)}`);
}
async function speakToESP32(ws, text, traceId = newAudioTraceId()) {
    return ttsService.speak(ws, text, {
        session: sessions.get(ws) || null,
        traceId
    });
}

// ============== [DAQ] BỘ ĐO CHẤT LƯỢNG ÂM THANH (Phân định loa phát kém) ==============
// In 1 dòng chỉ số mỗi lần robot cất tiếng / mỗi session nhạc -> nhìn là biết data
// trước loa có sạch hay không. Nếu log DATA SẠCH mà tai vẫn nghe kém -> phần cứng.
function audioStats(pcm16) {
    const n = pcm16.length >> 1;
    if (!n) return 'PCM RỖNG';
    let peak = 0, sum2 = 0, sum = 0, clip = 0, diff2 = 0, minA = 32768, maxA = -32768;
    for (let i = 0; i < n; i++) {
        const s = pcm16.readInt16LE(i * 2);
        const a = Math.abs(s);
        if (a > peak) peak = a;
        if (s > maxA) maxA = s;
        if (s < minA) minA = s;
        sum2 += s * s; sum += s;
        if (a > 32500) clip++;
        if (i > 0) { const d = s - pcm16.readInt16LE((i - 1) * 2); diff2 += d * d; }
    }
    const rms = Math.sqrt(sum2 / n) / 32768;
    const peakA = peak / 32768;
    const dc = (sum / n) / 32768;
    const hfShare = sum2 > 0 ? Math.min(1, Math.sqrt(diff2 / (n - 1)) / 32768 / (Math.sqrt(sum2 / n) / 32768 + 1e-9)) : 0;
    const secs = (n / 16000).toFixed(1);
    const verdict =
        (clip > n * 0.005) ? 'CÓ CLIP (nhiều mẫu chạm trần!)' :
        (peakA < 0.05) ? 'ÂM QUÁ NHỎ (peak<5%)' :
        (peakA > 0.99 && clip > 0) ? 'SÁT TRẦN' :
        (rms > 0.35) ? 'TO SÁT' :
        'DATA SẠCH';
    return `${secs}s rms=${rms.toFixed(3)} peak=${peakA.toFixed(2)} clip=${clip} dc=${dc.toFixed(3)} hf=${(hfShare * 100).toFixed(0)}% [${verdict}]`;
}

const GROQ_CHAT_MODEL  = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
const GROQ_STT_MODEL   = 'whisper-large-v3-turbo';

// ===== AI CASCADE: GEMINI ƯU TIÊN (free) -> GROQ FALLBACK (quota) =====
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
if (!GEMINI_API_KEY) console.warn('[⚠ CONFIG] GEMINI_API_KEY chưa đặt - mọi câu hỏi sẽ đốt quota Groq!');
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const AI_PRIMARY     = (process.env.AI_PRIMARY || 'gemini').toLowerCase(); // 'gemini' hoặc 'groq'
const GEMINI_TIMEOUT = parseInt(process.env.GEMINI_TIMEOUT_MS || '6000');

// Circuit-breaker: Gemini lỗi liên tiếp >= 2 lần -> nghỉ 10 phút, khỏi đốt thời gian mỗi câu (nhanh dứt khoát: 1 lần fail là chờ Groq ngay)
let geminiFailStreak = 0;
let geminiCooldownUntil = 0;
const aiStats = { gemini: 0, groq: 0, local: 0, total: 0 };
function aiStatsLine() {
    return `gemini=${aiStats.gemini} groq=${aiStats.groq} local-0token=${aiStats.local} / tổng ${aiStats.total}`;
}

// Chuyển chữ về ASCII an toàn cho TFT (font mặc định GLCD không có glyph tiếng Việt)
// TTS vẫn đọc nguyên bản có dấu - chỉ màn hình mới cần ASCII.
function tftASCII(s) {
    return String(s || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd').replace(/Đ/g, 'D')
        .replace(/[^\x20-\x7E]/g, '?')
        .trim();
}

// =========================================================================
// 0c. TÂM TRẠNG & TRÒ CHUYỆN NHƯ NGƯỜI BẠN (đọc cảm xúc anh nói, nhắc chuyện cũ)
// =========================================================================
const convos = new Map(); // ws -> { mood: 'neutral', history: [{user, ai, mood}] }
const MOOD_FACES = {
    happy: '__FACE_HAPPY__', sad: '__FACE_SAD__', angry: '__FACE_ANGRY__',
    surprise: '__FACE_SURPRISE__', love: '__FACE_LOVE__'
};
const MOOD_WORDS = {
    happy:    ['vui', 'tuyệt', 'sướng', 'haha', 'cười', 'hay quá', 'thích', 'tuyệt vời', 'quá đã', 'hí hửng', 'được nè', 'trời ơi vui'],
    sad:      ['buồn', 'mệt', 'chán', 'oải', 'áp lực', 'khổ', 'khóc', 'tủi thân', 'cô đơn', 'stress', 'quá tải', 'chán nản', 'không muốn nói chuyện với ai'],
    angry:    ['tức', 'bực', 'giận', 'điên', 'khó chịu', 'bực mình', 'ghét', 'vô lý', 'ghen', 'dối trá', 'cãi nhau'],
    surprise: ['hả', 'thật á', 'thật sao', 'kinh', 'bất ngờ', 'uầy', 'ủa', 'ố lên', 'trời đất'],
    love:     ['yêu', 'thương', 'quý', 'nhớ anh', 'dễ thương', 'ngoan', 'bảo bối']
};
// Lexicon 0-token: điểm từ phía server (nhanh, không phụ thuộc engine) + hòa với SER âm học
// MẸO: phải match NGUYÊN TỪ ("của" chuỗi con chứa "ủa" -> sai mood!) - tách token trước
function lexiconMood(text) {
    if (!text) return null;
    const clean = ' ' + String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ') + ' ';
    for (const [mood, words] of Object.entries(MOOD_WORDS)) {
        if (words.some(w => clean.includes(' ' + w + ' '))) return mood;
    }
    return null;
}
// EMA: kéo mượt tâm trạng 0..1 cho mỗi loại + giọng nói SER weight 0.42, chữ 0.58
function decideMood(ws, engineEmotion, transcript) {
    const c = convos.get(ws) || { mood: 'neutral', history: [] };
    convos.set(ws, c);
    const lex = lexiconMood(transcript);
    const ser = (engineEmotion && engineEmotion.emotion !== 'neutral') ? engineEmotion.emotion : null;
    const pick = lex || ser || c.mood;          // chữ đè nhẹ lên giọng (rõ ràng hơn)
    if (lex && ser && lex !== ser) {
        // lệch: ưu tiên chữ khi engine SER tăng confidence dưới 0.5
        const conf = engineEmotion?.confidence || 0;
        c.mood = conf >= 0.55 ? ser : lex;
    } else c.mood = pick;
    return c.mood;
}
function moodHistoryBlock(ws) {
    const c = convos.get(ws);
    if (!c || !c.history.length) return '';
    const recent = c.history.slice(-3).map(h =>
        `Trước đó - anh nói: "${h.user}" (tâm trạng: ${h.mood}) | em trả lời: "${h.ai}"`);
    return `\nChuyện vừa rồi: ${recent.join(' || ')}`;
}
function pushConvoHistory(ws, userText, aiReply, mood) {
    const c = convos.get(ws) || { mood: 'neutral', history: [] };
    c.history.push({ user: String(userText).slice(0, 80), ai: String(aiReply).slice(0, 80), mood });
    if (c.history.length > 6) c.history.shift();     // nhớ 6 lượt gần nhất
    convos.set(ws, c);
    const session = sessions.get(ws);
    if (session) session.convo = c;
    // Ghi nhật ký hội thoại xuống DB (best-effort) để robot nhớ qua restart
    if (dbPool && aiReply) logChat('user', userText, mood);
    if (dbPool && aiReply) logChat('ai', aiReply, mood);
}
const MOOD_TIP = {
    happy:    'Anh đang VUI: đáp chơi đùa, cùng hào hứng, cười đùa thân mật.',
    sad:      'Anh nhà mình đang BUỒN/MỆT: dịu dàng, hỏi thăm "sao vậy anh", an ủi ngắn, không đùa cợt.',
    angry:    'Anh đang GIẬN/ức: đứng về phía anh trước ("ừ đúng là nan thật quá"), xoa dịu, không giảng tính.',
    surprise: 'Anh NGẠC NHIÊN: khớp sự ngạc nhiên ("oặc thật á?!"), tò mò hỏi kỹ.',
    love:     'Anh YÊU THƯƠNG/NHỚ EM: đáp ấm áp tình cảm, xưng hô ngọt ("dạ anh Quy ơi").',
    neutral:  'Bình thường thân thiện nhưng chịu khó hỏi lại 1 câu để tiếp chuyện.'
};

const dbPool = NEON_DB_URL ? new Pool({
    connectionString: NEON_DB_URL,
    max: 5,
    connectionTimeoutMillis: 8000
}) : null;
dbPool?.on('error', (err) => console.error('[DB Pool]', err.message));

// Nhật ký hội thoại (chat_log) -> robot nhớ chuyện cũ cả khi server restart
async function logChat(direction, text, mood) {
    if (!dbPool) return;
    try {
        await dbPool.query('INSERT INTO chat_log (direction, text, mood) VALUES ($1, $2, $3)',
            [direction, String(text || '').slice(0, 500), mood || null]);
    } catch (e) { /* best-effort, không cản luồng nói */ }
}

let userMemoriesCache = [];
let lastMemoriesRefresh = 0;

// Gói PCM 16kHz 16-bit raw thành WAV hợp lệ (Whisper cần WAV/PCM có header)
function pcmToWav(pcmBuf, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
    const dataLen = pcmBuf.length;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLen, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);        // PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
    header.writeUInt16LE(channels * bitsPerSample / 8, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLen, 40);
    return Buffer.concat([header, pcmBuf]);
}

// =========================================================================
// 2. AI TOOLS (Chat + Memory DB + Điều khiển Servo)
// =========================================================================
const AI_TOOLS = [
    {
        type: "function",
        function: {
            name: "control_robot",
            description: "Điều khiển Servo: head(up/down/center), leg(left/right/center)",
            parameters: {
                type: "object",
                properties: {
                    part: { type: "string", enum: ["head", "leg"] },
                    direction: { type: "string", enum: ["up", "down", "left", "right", "center"] }
                },
                required: ["part", "direction"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "remember_memory",
            description: "Ghi nhớ một thông tin quan trọng của anh Quy (sinh nhật, việc cần làm, sở thích, lời hứa...)",
            parameters: {
                type: "object",
                properties: {
                    category: { type: "string", enum: ["personal", "todo", "preference", "reminder"] },
                    key_name: { type: "string", description: "Tên khóa ngắn (vd: 'sinh nhật', 'học bổng')" },
                    content:  { type: "string", description: "Nội dung chi tiết cần nhớ" }
                },
                required: ["category", "key_name", "content"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "recall_memory",
            description: "Tra cứu trí nhớ đã lưu, trả về danh sách riêng theo từ khóa (bỏ trống để lấy toàn bộ)",
            parameters: {
                type: "object",
                properties: {
                    keyword: { type: "string", description: "Từ khóa tìm kiếm (tuỳ chọn)" }
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "music_player",
            description: "Điều khiển NHẠC trên robot: play (mở hiểu bài theo tiêu đề/ca sĩ/chỉ mood), stop, pause, resume, next. Dùng khi anh Quy mong nghe/bắt/bạn dừng/bài khác.",
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["play", "stop", "pause", "resume", "next"] },
                    query: { type: "string", description: "Chỉ action=play đòi query: tên bài, ca sĩ hoặc mô tả như 'nhạc vui', 'nhạc trẻ' (mặc định 'nhạc')" }
                },
                required: ["action"]
            }
        }
    }
];

async function callUniversalLLM({ messages, tools = null, temperature = 0.6, max_tokens = 150 }) {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: GROQ_CHAT_MODEL,
        messages,
        tools,
        temperature,
        max_tokens
    }, {
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        httpAgent: groqHttpAgent,
        timeout: 9000
    });
    return res.data;
}

// =========================================================================
// 2.5 TẦNG GEMINI (ưu tiên - miễn phí, tiết kiệm quota Groq)
// =========================================================================
async function askGemini(systemPrompt, userQuestion) {
    if (!GEMINI_API_KEY) return null;
    if (Date.now() < geminiCooldownUntil) return null;
    try {
        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
            {
                system_instruction: { parts: [{ text: systemPrompt }] },
                contents: [{ role: 'user', parts: [{ text: userQuestion.slice(0, 400) }] }],
                generationConfig: { temperature: 0.55, maxOutputTokens: 160 }
            },
            {
                headers: { 'x-goog-api-key': GEMINI_API_KEY, 'Content-Type': 'application/json' },
                timeout: GEMINI_TIMEOUT
            }
        );
        const parts = res.data?.candidates?.[0]?.content?.parts || [];
        const text = parts.map(p => p.text || '').join('').trim();
        if (!text) throw new Error('Gemini trả về rỗng');
        geminiFailStreak = 0;
        aiStats.gemini++; aiStats.total++;
        console.log(`[🧠 GEMINI OK] ${GEMINI_MODEL} | ${aiStatsLine()}`);
        return text;
    } catch (e) {
        geminiFailStreak++;
        if (geminiFailStreak >= 2) {
            geminiCooldownUntil = Date.now() + 10 * 60000;
            console.warn(`[AI] Gemini lỗi x${geminiFailStreak} -> nghỉ 10 phút, chuyển hẳn sang Groq (${e.message})`);
        } else {
            console.warn(`[AI] Gemini thất bại (lần ${geminiFailStreak}) -> fallback Groq: ${e.message}`);
        }
        return null;
    }
}

// =========================================================================
// 2.6 BỘ ĐỊNH TUYẾN CỤC BỘ (0 TOKEN): lệnh servo + ghi nhớ theo mẫu câu
// Chỉ khi không khớp mẫu nào mới đốt token gọi LLM
// =========================================================================
function routeLocalCommand(text, isOwner) {
    if (!text) return null;
    const t = ' ' + text.toLowerCase().replace(/[.,!?~]/g, ' ') + ' ';
    const has = (...words) => words.some(w => t.includes(w));

    // 1) Ghi nhớ nhanh: "ghi nhớ" / "nhớ giúp" / "lưu giúp" + " là "
    const memWords = ['ghi nhớ', 'nhớ giúp', 'lưu giúp', 'nhớ rằng'];
    if (memWords.some(w => t.includes(w)) && t.includes(' là ')) {
        const idx = t.indexOf(' là ');
        let before = t.slice(0, idx);
        for (const w of memWords) {
            const wi = before.indexOf(w);
            if (wi !== -1) { before = before.slice(wi + w.length); break; }
        }
        const beforeWords = before.trim().split(/\s+/).filter(Boolean);
        const key = beforeWords.slice(-3).join(' ') || 'việc cần nhớ';
        const content = t.slice(idx + 4).trim().slice(0, 200);
        if (key && content) {
            return {
                type: 'memory', category: 'personal',
                key: key.slice(0, 60), content,
                reply: `Dạ em ghi nhớ rồi: ${key} - ${content} ạ!`
            };
        }
    }

    // 2) Lệnh điều khiển servo (chỉ chủ nhân mới được điều khiển)
    const cmds = [];
    if (has('đầu lên', 'ngẩng lên', 'nhấc đầu lên', 'gập đầu lên')) cmds.push('__SERVO_HEAD_UP__');
    else if (has('đầu xuống', 'cúi đầu', 'gập đầu xuống', 'cúi xuống')) cmds.push('__SERVO_HEAD_DOWN__');
    else if (has('đầu về giữa', 'thẳng đầu')) cmds.push('__SERVO_HEAD_CENTER__');
    if (has('quay sang trái', 'quay trái', 'người sang trái')) cmds.push('__SERVO_LEG_LEFT__');
    else if (has('quay sang phải', 'quay phải', 'người sang phải')) cmds.push('__SERVO_LEG_RIGHT__');
    else if (has('quay về giữa', 'người về giữa', 'quay lại giữa')) cmds.push('__SERVO_LEG_CENTER__');

    if (cmds.length > 0) {
        if (!isOwner) {
            console.log('[🔒 BẢO MẬT] Khách không xác thực yêu cầu điều khiển robot -> từ chối (0 token)');
            return { type: 'servoDeny', reply: 'Dạ em xin lỗi, chỉ có anh Quy mới được điều khiển em thôi ạ!' };
        }
        return { type: 'servo', cmds, reply: cmds.length > 1 ? 'Dạ em thực hiện ngay!' : 'Dạ rõ ạ!' };
    }

    // 3) LỆNH NHẠC 0-TOKEN (chỉ chủ nhân điều khiển)
    const md = routeMusicCommand(text);
    if (md) {
        if (!isOwner) { console.log('[🔒 BAO MAT] Khach yeu cau dieu khien nhac -> tu choi'); return { type: 'servoDeny', reply: 'Dạ em xin lỗi, chỉ có anh Quy mới được điều khiển em thôi ạ!' }; }
        return { type: 'music', action: md.action, query: md.query, reply: '' };
    }

    return null;
}

// =========================================================================
// 2b. NHẠC STREAMING: yt-dlp + ffmpeg -> PCM 16k mono -> ESP32
//  - Phát mọi loại bài (YouTube, Zing, SoundCloud...) theo yêu cầu chữ
//  - Điều khiển GIỌNG NÓI: tắt / tạm dừng / tiếp tục / bài khác
//  - Nghi thức "CỬA SỔ NGHE LỆNH": mỗi 30s robot tít mic 2.6s, xả đệm loa
//    để nghe được lệnh của anh trong khi nhạc vẫn đang phát
// =========================================================================
const FFMPEG_PATH = require('ffmpeg-static');
const MUSIC_CHUNK = 5120;              // 160ms @ 16k mono (trùng TTS_CHUNK)
const MUSIC_BYTES_PER_SEC = 32000;
const MUSIC_LEAD_MS = 1600;            // bơm trước 1.6s (ring firmware 2s -> bảo đảm không tràn)
const MUSIC_WINDOW_EVERY_MS = 30000;   // mỗi 30s mở "cửa sổ nghe lệnh"
const MIC_WINDOW_MS = 2600;            // firmware mở mic 2.6s mỗi cửa sổ
const MUSIC_SESSION_MAX_MS = 50 * 60 * 1000; // quá 50 phút tự ngắt (tránh "quên tắt")

const musicSessions = new Map();       // ws -> session

// Lệnh nhạc 0-token — nhận cả "tạm dùng" (người dùng hay nói lệch)
function routeMusicCommand(text) {
    if (!text) return null;
    const t = ' ' + String(text).toLowerCase().replace(/[.,!?~]/g, ' ') + ' ';
    const has = (...w) => w.some(x => t.includes(x));
    if (has(' tạm dừng', ' tạm dùng', ' tạm ngừng', ' dừng nhạc lại')) return { action: 'pause' };
    if (has(' tắt nhạc', ' tắt bài', ' dừng nhạc', ' tắt đi', ' nhạc thôi')) return { action: 'stop' };
    if (has(' tiếp tục', ' phát tiếp', ' phát lại', ' mở lại nhạc')) return { action: 'resume' };
    if (has(' bài khác', ' đổi bài', ' bài tiếp', ' bai khac')) return { action: 'next' };
    if (has(' mở nhạc', ' phát nhạc', ' nghe nhạc', ' mở bài', ' phát bài', ' bật nhạc',
            ' cho anh nghe nhạc', ' cho anh nghe bài', ' cho anh hát', ' nhac di', ' mở hơi nhạc')) {
        // Ch CHIP: lấy đoạn sau chốt từ khóa ("mở nhạc"/"phát bài"...) làm tên bài
        const anchors = ['mở nhạc', 'phát nhạc', 'nghe nhạc', 'mở bài', 'phát bài',
            'cho anh nghe nhạc', 'cho anh nghe bài', 'cho anh hát', 'bật nhạc', 'nhac di', 'mở hơi nhạc'];
        let q = text.toLowerCase();
        for (const a of anchors) {
            const i = q.indexOf(a);
            if (i !== -1) { q = q.slice(i + a.length); break; }
        }
        q = q.replace(/\b(cho|giúp|em|ơi|xiaoxi|tiểu trí|đi|nha|nhé|duy|với|được)\b/g, ' ');
        q = q.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
        return { action: 'play', query: q || 'nhạc' };
    }
    return null;
}

// Tìm bài: yt-search (nhanh, ổn định), lọc video quá ngắn/quá dài/live
async function searchMusic(qs) {
    const r = await ytSearch(String(qs || 'nhạc').trim());
    const vids = (r.videos || []).filter(v =>
        v.videoId && typeof v.seconds === 'number' && v.seconds >= 30 &&
        v.seconds <= 900 && !v.live).slice(0, 10);
    if (!vids.length) throw new Error('Khong tim thay bai hop le');
    return vids;
}

// Nạp kết nối phát: py -3.11 -m yt_dlp (stream best-audio) | ffmpeg -> PCM 16k
function launchMusicStream(ws, s) {
    const v = s.vids[s.vidIdx];
    s.title = v.title; s.url = v.url;
    s.pcmQ = []; s.bufTail = Buffer.alloc(0); s.done = false; s.started = false;
    s.ytErr = '';
    const ytdlp = spawn('py', ['-3.11', '-m', 'yt_dlp', '-f', 'bestaudio', '-o', '-', '--no-playlist',
        '--no-warnings', v.url], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ff = spawn(FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
        '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    s.ytdlp = ytdlp; s.ffmpeg = ff;
    let lastErr = '';
    ytdlp.stderr.on('data', (d) => { lastErr = (lastErr + d.toString()).slice(-500); });
    ytdlp.on('exit', (code) => { if (code !== 0 && !s.aborted) s.ytErr = lastErr || ('yt-dlp exit ' + code); });
    ytdlp.stdout.pipe(ff.stdin);
    ff.stdout.on('data', (b) => { if (!s.aborted) { s.pcmQ.push(Buffer.from(b)); if (s.started === false) s.started = true; } });
    ff.on('close', () => { if (!s.aborted) s.done = true; });
}

async function startMusicSession(ws, searchLine, idx = 0) {
    try {
        const vids = await searchMusic(searchLine);
        const vIdx = ((idx % vids.length) + vids.length) % vids.length;
        const ownerSession = sessions.get(ws);
        if (ownerSession) ownerSession.lastMusicSearch = { line: searchLine, vIdx };
        const s = {
            playing: true, paused: false, aborted: false, window: false,
            vids: vids, vidIdx: vIdx, searchLine: searchLine,
            baseline: 0, sentTotal: 0, pcmQ: [], bufTail: Buffer.alloc(0),
            done: false, started: false, title: '', url: '', windowTimer: null, feedTimer: null,
            startMs: Date.now(),
        };
        musicSessions.set(ws, s);
        launchMusicStream(ws, s);

        ws.send(`AI:${tftASCII(`Dạ mở luôn bài "${vids[vIdx].title}" cho anh anh ơi, nghe đi nha! (nhạc)`)}`);
        ws.send(`__MUSIC_INFO__${tftASCII(vids[vIdx].title)}|${Math.max(1, Math.floor(vids[vIdx].seconds || 0))}`);
        ws.send('__SPEAK_START__');
        s.startMs = Date.now();

        // Ticker bơm nhịp: chỉ gửi đủ lượng "trước mặt" (LEAD) + theo thời gian thật
        s.feedTimer = setInterval(() => {
            if (!musicSessions.has(ws)) { clearInterval(s.feedTimer); return; }
            if (s.paused || s.window || s.aborted) return;
            const allowedSent = s.baseline + Math.floor((Date.now() - s.startMs) * MUSIC_BYTES_PER_SEC / 1000)
                + Math.floor(MUSIC_LEAD_MS * MUSIC_BYTES_PER_SEC / 1000);
            let pool = s.bufTail.length ? Buffer.concat([s.bufTail, ...s.pcmQ]) : Buffer.concat(s.pcmQ);
            s.pcmQ = [];
            let off = 0;
            while (pool.length - off >= MUSIC_CHUNK && s.sentTotal + MUSIC_CHUNK <= allowedSent) {
                if (ws.readyState === ws.OPEN) ws.send(pool.subarray(off, off + MUSIC_CHUNK));
                s.sentTotal += MUSIC_CHUNK; off += MUSIC_CHUNK;
            }
            s.bufTail = pool.subarray(off);
            // Server gửi tiến trình bài nhạc lên TFT mỗi 4s: pos|dur|pct%
            if (ws.readyState === ws.OPEN && (!s.lastPosSent || Date.now() - s.lastPosSent > 4000)) {
                s.lastPosSent = Date.now();
                const posS = Math.max(0, Math.floor(s.sentTotal / MUSIC_BYTES_PER_SEC) - 1);
                const durS = Math.max(posS, Math.floor(vids[vIdx].seconds || 0));
                const pct = durS ? Math.min(99, Math.floor(posS / durS * 100)) : 0;
                const mmss = x => `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`;
                try { ws.send(`__MUSIC_POS__${mmss(posS)}|${mmss(durS)}|${pct}`); } catch (e) {}
            }
            // Hết bài / nguồn chết kịp -> tự đóng session (robot tự "nghe lại")
            if ((s.done || (s.ytErr && !s.started)) && s.bufTail.length < MUSIC_CHUNK) {
                clearInterval(s.feedTimer);
                const wall = Math.max(1, (Date.now() - s.startMs) / 1000);
                console.log(`[NHAC DATA] "Da gui ${(s.sentTotal / 1024).toFixed(0)}KB trong ${wall.toFixed(1)}s -> rate=${(s.sentTotal / wall).toFixed(0)}/32000 B/s [${(s.sentTotal / wall > 33000 || s.sentTotal / wall < 29500) ? 'LECH toc do' : 'DATA SACH'}]`);
                setTimeout(() => {
                    if (!s.aborted && ws.readyState === ws.OPEN) {
                        try { ws.send('__MUSIC_STOP__'); } catch (e) {}
                        try { ws.send('__SPEAK_END__'); } catch (e) {}
                    }
                    musicSessions.delete(ws);
                }, MUSIC_LEAD_MS + 900);
            }
        }, 80);

        // CỬA SỔ NGHE LỆNH: chờ 30s mỗi lượt -> SEND __MIC_WINDOW__ -> robot bít loa
        // 2.6s mở mic; lệnh "tắt/tạm dừng/tiếp tục/bài khác" được STT nuốt như bình thường
        s.windowTimer = setInterval(() => {
            if (!musicSessions.has(ws)) { clearInterval(s.windowTimer); return; }
            if (s.paused || s.aborted || s.window) return;
            if (Date.now() - s.startMs > MUSIC_SESSION_MAX_MS) { runMusicAction(ws, 'stop', ''); return; }
            if (ws.readyState !== ws.OPEN) return;
            s.window = true;
            try { ws.send('__MIC_WINDOW__'); } catch (e) {}
            setTimeout(() => { s.window = false; }, MIC_WINDOW_MS + 400);
        }, MUSIC_WINDOW_EVERY_MS);
        return s;
    } catch (e) {
        console.error('[NHAC] Lỗi mở nhạc:', e.message);
        ws.send(`AI:Dạ em không tìm thấy bài "${searchLine}" nào anh ạ!`);
        return null;
    }
}

// Đóng sạch + dừng session (tắt / mở bài mới đè lên)
async function stopMusicSession(ws, s) {
    if (!s) return;
    s.aborted = true; s.paused = true;
    try { s.ytdlp?.kill?.('SIGKILL'); } catch (e) {}
    try { s.ffmpeg?.kill?.('SIGKILL'); } catch (e) {}
    try { if (s.feedTimer) clearInterval(s.feedTimer); } catch (e) {}
    try { if (s.windowTimer) clearInterval(s.windowTimer); } catch (e) {}
    musicSessions.delete(ws);
    if (ws.readyState === ws.OPEN) { try { ws.send('__MUSIC_STOP__'); } catch (e) {} }
    setTimeout(() => { if (ws.readyState === ws.OPEN) { try { ws.send('__SPEAK_END__'); } catch (e) {} } }, MUSIC_LEAD_MS + 800);
}

// Nhân xự lệnh nhạc (dùng cho cả local-tier lẫn tool music_player của LLM)
async function runMusicAction(ws, action, query) {
    const s = musicSessions.get(ws);
    if (action === 'stop') {
        if (!s) { musicSessions.delete(ws); return { reply: 'Dạ em đã tắt nhạc cho anh rồi nha!' }; }
        await stopMusicSession(ws, s);
        console.log('[NHAC] Đã TẮT nhạc');
        return { reply: 'Dạ em đã tắt nhạc cho anh rồi nha!' };
    }
    if (action === 'pause') {
        if (!s || s.paused || s.aborted) return null;
        s.paused = true; s.window = false;
        console.log('[NHAC] TẠM DỪNG (đợi loa dư đệm -> tự mở mic)');
        return { reply: 'Em tạm dừng nhạc nè, anh nói "tiếp tục" khi muốn nghe lại nha!' };
    }
    if (action === 'resume') {
        if (!s || !s.paused || s.aborted) return null;
        if (s.done) { await stopMusicSession(ws, s); return { reply: 'Bài đó hết rồi anh ạ, anh mở bài khác nhé!' }; }
        if (ws.readyState === ws.OPEN) { ws.send('__SPEAK_START__'); }
        s.paused = false; s.startMs = Date.now(); s.baseline = s.sentTotal;
        console.log('[NHAC] TIẾP TỤC phát');
        return { reply: 'Em mở tiếp nhạc đây, nghe anh nha!' };
    }
    if (action === 'next') {
        if (s) {
            const search = s.searchLine; const idx = s.vidIdx + 1;
            await stopMusicSession(ws, s);   // session cũ chết, mở bài kế tiếp trong cùng playlist
            await new Promise(r => setTimeout(r, 400));
            console.log('[NHAC] ĐỔI BÀI tiếp theo (session đang phát)');
            await startMusicSession(ws, search, idx);
            return { reply: '' };
        }
        // Session đã tự hết (bài hát kết thúc hoặc robot dừng ở chế dừng) -> đổi bài
        // bằng playlist gần nhất, không để lệnh "bài khác" của anh rơi vào chân không
        const lastSearch = sessions.get(ws)?.lastMusicSearch;
        if (lastSearch?.line) {
            console.log('[NHAC] ĐỔI BÀI: session hết rồi, dùng lại playlist gần nhất');
            await new Promise(r => setTimeout(r, 300));
            await startMusicSession(ws, lastSearch.line, lastSearch.vIdx + 1);
            return { reply: '' };
        }
        console.log('[NHAC] ĐỔI BÀI: chưa có playlist nào -> mở mặc định');
        await new Promise(r => setTimeout(r, 300));
        await startMusicSession(ws, 'nhạc', 0);
        return { reply: '' };
    }
    if (action === 'play') {
        if (s) await stopMusicSession(ws, s);
        await new Promise(r => setTimeout(r, 300));
        console.log(`[NHAC] MỞ bài theo yêu cầu: "${query || 'nhạc'}"`);
        await startMusicSession(ws, query || 'nhạc', 0);
        return { reply: '' };
    }
    return null;
}


// =========================================================================
// 3. STT & BỘ LỌC CÂU HỎI THÔNG MINH (ANTI-HALLUCINATION)
// =========================================================================
async function transcribeAudio(buffer) {
    const wavBuf = pcmToWav(buffer);
    const form = new FormData();
    form.append('file', wavBuf, { filename: 'audio.wav', contentType: 'audio/wav' });
    form.append('model', GROQ_STT_MODEL);
    form.append('language', 'vi');
    form.append('response_format', 'verbose_json');
    // Prompt-bias giúp Whisper KHÔNG nuốt cụm gọi robot ("em ơi", "XiaoXi ơi")
    form.append('prompt', 'Chào anh Quy! Đây là lệnh cho robot XiaoXi: "XiaoXi ơi", "em ơi", "kể cho anh nghe", "ghi nhớ giúp anh", "nhớ giúp anh"...');

    const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
        headers: { ...form.getHeaders(), 'Authorization': `Bearer ${GROQ_API_KEY}` },
        httpAgent: groqHttpAgent,
        timeout: 8000
    });
    const text = (res.data?.text || '').trim();
    return { text, segments: res.data?.segments || [] };
}

function isAnswerableRetrieval(text, acousticContext = {}, segments = []) {
    if (!text || typeof text !== 'string') return false;
    const clean = text.trim();
    if (clean.length < 2) return false;

    const ac = acousticContext.acoustics || {};
    if (ac.is_wind_noise === true) return false;
    if (ac.voiced_ratio !== undefined && ac.voiced_ratio < 0.12 && (ac.rumble_ratio || 0) > 0.55) return false;

    if (segments.length > 0) {
        const noSpeech = segments[0].no_speech_prob || 0;
        const logprob  = segments[0].avg_logprob  || 0;
        if (noSpeech > 0.55 || logprob < -2.8) return false;
    }

    const lower = clean.toLowerCase();
    const hallucinations = ["subscribe", "like và share", "hãy đăng ký kênh", "cảm ơn các bạn đã theo dõi", "la la school", "ghiền mì gõ"];
    if (hallucinations.some(h => lower.includes(h))) return false;

    const noiseWords = ["ừ", "ờ", "à", "hả", "hở", "ơ", "ầy", "ha", "umm", "hmm", "chậc", "ừm"];
    const stripped = lower.replace(/[.,?!~`]/g, '').trim();
    if (noiseWords.includes(stripped)) return false;

    const validKeywords = [
        "ai", "gì", "nào", "mấy", "sao", "thế nào", "bao nhiêu", "ở đâu", "khi nào", "tại sao", "được không", "chưa", "?",
        "xiaoxi", "tiểu trí", "bot", "em ơi", "chào", "hello", "hi",
        "bật", "mở", "tắt", "dừng", "hát", "phát", "nhạc", "nhắc", "nhớ", "kể", "lưu", "thời tiết", "giờ", "hôm nay",
        "buồn", "vui", "mệt", "chán", "cảm ơn", "tạm biệt", "yêu", "thích", "giúp"
    ];
    const words = stripped.split(/\s+/).filter(Boolean);
    const hasValidKeyword = validKeywords.some(kw => lower.includes(kw));

    if (words.length >= 2 && hasValidKeyword) return true;
    if (words.length >= 1 && /^(chao|chào|hello|hi|tắt|dừng|xiao|xiaoxi|tiểu)/i.test(stripped)) return true;
    if (words.length >= 4) return true;
    return false;
}

// =========================================================================
// 4. TRÍ NHỚ (NEON DB)
// =========================================================================
async function refreshMemoriesCache() {
    if (!dbPool) return;
    try {
        const res = await dbPool.query(
            'SELECT category, key_name, content FROM user_memories WHERE is_done = FALSE ORDER BY created_at DESC LIMIT 50'
        );
        userMemoriesCache = res.rows;
        lastMemoriesRefresh = Date.now();
    } catch (e) {
        console.error('[DB] Lỗi load trí nhớ:', e.message);
    }
}
setInterval(refreshMemoriesCache, 60000).unref?.();

async function addMemoryToDB(category, keyName, content) {
    if (!dbPool) { userMemoriesCache.push({ category, key_name: keyName, content }); return; }
    try {
        await dbPool.query(
            `INSERT INTO user_memories (category, key_name, content)
             VALUES ($1, $2, $3)`,
            [category, keyName, content]
        );
        console.log(`[DB] Đã ghi nhớ:[${category}] ${keyName} -> ${content}`);
        await refreshMemoriesCache();
    } catch (e) {
        console.error('[DB] Lỗi ghi trí nhớ:', e.message);
    }
}

function findMemories(keyword) {
    if (!keyword) return userMemoriesCache.slice(0, 20);
    const lower = keyword.toLowerCase();
    return userMemoriesCache.filter(m =>
        m.key_name.toLowerCase().includes(lower) || m.content.toLowerCase().includes(lower)
    ).slice(0, 20);
}

// =========================================================================
// 4c. ĐỒNG HỒ + THỜI TIẾT QUÁN MÀN HÌNH (open-meteo miễn phí, cache 10 phút)
// =========================================================================
let wxCache = { at: 0, line: '' };
const WX_CODES = {
    0: 'tro nang', 1: 'tro nang', 2: 'it may', 3: 'may tro', 45: 'suong mu', 48: 'suong mu',
    51: 'muoi roi', 53: 'muoi roi', 55: 'muoi roi', 61: 'mua', 63: 'mua', 65: 'mua to',
    66: 'mua', 67: 'mua to', 71: 'tuyet', 73: 'tuyet', 75: 'tuyet', 77: 'tuyet',
    80: 'mua roi', 81: 'mua roi', 82: 'mua to', 85: 'mua roi', 86: 'mua to', 95: 'bao',
    96: 'bao loi', 99: 'bao loi'
};
async function refreshWeather() {
    if (Date.now() - wxCache.at < 600000) return;
    try {
        const lat = process.env.XIAOXI_LAT || '21.03';
        const lon = process.env.XIAOXI_LON || '105.85';
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code`, { signal: AbortSignal.timeout(6000) });
        const j = await r.json();
        const c = j.current;
        wxCache = { at: Date.now(), line: `${Math.round(c.temperature_2m)}C ${WX_CODES[c.weather_code] || 'tro nang'} ${Math.round(c.relative_humidity_2m)}%` };
        console.log(`[TFT] Thời tiết: ${wxCache.line}`);
    } catch (e) {
        wxCache.at = Date.now() - 540000; // 1 phút sau thử lại
    }
}
function sendTftAmbient(ws) {
    if (ws.readyState !== ws.OPEN) return;
    const d = new Date();
    const HHMM = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const DOW = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][d.getDay()];
    try { ws.send(`__TIME__${HHMM}|${DOW}`); } catch (e) {}
    if (wxCache.line) { try { ws.send(`__WX__${wxCache.line}`); } catch (e) {} }
}
setInterval(() => { refreshWeather().then(() => { for (const c of deviceClients) sendTftAmbient(c); }); }, 60000).unref?.();

// =========================================================================
// 5. SESSION + HTTP + WEBSOCKET
// =========================================================================
const STARTED_AT = Date.now();
const sessions = new Map();
const sessionsById = new Map();
const deviceSessions = new Map();
const webClients = new Set();
let sessionCounter = 0;

function newSessionId(prefix = 'session') {
    return `${prefix}-${Date.now().toString(36)}-${(++sessionCounter).toString(36)}`;
}

function isOpen(ws) {
    return !!ws && ws.readyState === ws.OPEN;
}

function safeSend(ws, payload) {
    if (!isOpen(ws)) return false;
    try {
        ws.send(payload);
        return true;
    } catch {
        return false;
    }
}

function broadcastWeb(event) {
    if (!webClients.size) return;
    const payload = typeof event === 'string' ? event : protocol.make(event.type, event);
    for (const client of webClients) safeSend(client, payload);
}

function snapshotSessions() {
    return [...deviceSessions.values()].map((session) => session.toJSON());
}

function emitState(session, event) {
    if (session.role !== 'device') return;
    if (session.protocol >= 2) {
        safeSend(session.ws, protocol.state(event.to, {
            from: event.from,
            reason: event.meta?.reason || '',
            turn: session.turnSeq,
            at: event.at
        }));
    } else {
        const faceMap = {
            [STATES.LISTEN]: '__FACE_LISTEN__',
            [STATES.THINK]: '__FACE_THINK__',
            [STATES.ERROR]: '__FACE_SAD__'
        };
        if (faceMap[event.to] && typeof session.enqueueFace === 'function') {
            session.enqueueFace(faceMap[event.to]);
        }
    }
    broadcastWeb({
        type: 'state',
        sessionId: session.id,
        state: event.to,
        from: event.from,
        reason: event.meta?.reason || '',
        turn: session.turnSeq,
        at: event.at
    });
    console.log(`[STATE] ${session.id} ${event.from} -> ${event.to} (${event.meta?.reason || ''})`);
}

function failSession(session, message, code = 'error') {
    if (session.protocol >= 2) safeSend(session.ws, protocol.error(message, code));
    broadcastWeb({ type: 'error', sessionId: session.id, message: String(message || ''), code });
    session.setState(STATES.ERROR, { reason: code });
    setTimeout(() => {
        if (session.state === STATES.ERROR) session.setState(STATES.IDLE, { reason: 'error_timeout' });
    }, 2500);
}

function flushDeviceAudio(session) {
    safeSend(session.ws, '__AUDIO_FLUSH__');
    safeSend(session.ws, '__MIC_WINDOW__');
    safeSend(session.ws, '__SPEAK_END__');
    if (session.protocol >= 2) safeSend(session.ws, protocol.make('audio.flush', { reason: 'flush' }));
}

function handleBargeIn(session, reason = 'barge_in') {
    if (!session || session.role !== 'device') return false;
    session.turnSeq++;
    session.busyTurn = false;
    const hadTts = session.cancelTts(reason);
    flushDeviceAudio(session);
    session.setState(STATES.LISTEN, { reason });
    broadcastWeb({ type: 'barge_in', sessionId: session.id, reason, hadTts });
    console.log(`[BARGE-IN] ${session.id} reason=${reason} tts=${hadTts}`);
    return true;
}

function handleStop(session, reason = 'stop') {
    if (!session || session.role !== 'device') return false;
    session.turnSeq++;
    session.busyTurn = false;
    session.cancelTts(reason);
    flushDeviceAudio(session);
    session.setState(STATES.IDLE, { reason });
    broadcastWeb({ type: 'stop', sessionId: session.id, reason });
    console.log(`[STOP] ${session.id} reason=${reason}`);
    return true;
}

function updateSessionId(session, nextId) {
    if (!nextId || nextId === session.id) return;
    deviceSessions.delete(session.id);
    sessionsById.delete(session.id);
    session.id = nextId;
    deviceSessions.set(nextId, session);
    sessionsById.set(nextId, session);
}

function handleDeviceProtocol(session, msg) {
    switch (msg.type) {
        case 'hello': {
            const previousId = session.id;
            session.protocol = 2;
            if (Array.isArray(msg.capabilities)) {
                for (const cap of msg.capabilities) {
                    if (typeof cap === 'string') session.capabilities.add(cap);
                }
            }
            if (msg.device_id) updateSessionId(session, String(msg.device_id).slice(0, 64));
            safeSend(session.ws, protocol.helloAck(session));
            safeSend(session.ws, protocol.state(session.state, {
                from: session.state,
                reason: 'hello',
                turn: session.turnSeq
            }));
            broadcastWeb({ type: 'session_update', oldId: previousId, session: session.toJSON() });
            console.log(`[WS v2] Hello ${session.id} caps=${[...session.capabilities].join(',') || 'none'}`);
            break;
        }
        case 'ping':
            safeSend(session.ws, protocol.make('pong', { seq: msg.seq || 0 }));
            break;
        case 'pong':
            break;
        case 'barge_in':
            handleBargeIn(session, msg.reason || 'voice');
            break;
        case 'stop':
            if (typeof session.onStop === 'function') session.onStop(msg.reason || 'remote_stop');
            else handleStop(session, msg.reason || 'remote_stop');
            break;
        case 'touch': {
            const gesture = msg.gesture || msg.action;
            if (gesture === 'tap') {
                session.activeListeningUntil = Date.now() + 8000;
                session.setState(STATES.LISTEN, { reason: 'touch_tap' });
            } else if (gesture === 'long_press' || gesture === 'longpress') {
                handleStop(session, 'touch_long_press');
            } else if (gesture === 'swipe_up' || gesture === 'swipe_down') {
                safeSend(session.ws, protocol.make('history', {
                    sessionId: session.id,
                    direction: gesture === 'swipe_up' ? 'older' : 'newer',
                    history: session.convo.history.slice(-6)
                }));
            }
            break;
        }
        case 'debug':
            if (msg.text && typeof session.onDebug === 'function') session.onDebug(String(msg.text));
            break;
        case 'config': {
            const cfg = msg.config && typeof msg.config === 'object' ? msg.config : msg;
            if (Number.isFinite(Number(cfg.vad_threshold))) {
                session.config.vadThreshold = Math.min(0.95, Math.max(0.1, Number(cfg.vad_threshold)));
            }
            if (Number.isFinite(Number(cfg.silence_windows))) {
                session.config.silenceWindows = Math.min(20, Math.max(2, Math.round(Number(cfg.silence_windows))));
            }
            if (Number.isFinite(Number(cfg.max_seconds))) {
                session.config.maxSeconds = Math.min(30, Math.max(2, Number(cfg.max_seconds)));
            }
            if (session.protocol >= 2) safeSend(session.ws, protocol.make('config_ack', { config: session.config }));
            broadcastWeb({ type: 'config', sessionId: session.id, config: session.config });
            break;
        }
        case 'metrics':
            session.metrics.device = msg.metrics || null;
            broadcastWeb({ type: 'device_metrics', sessionId: session.id, metrics: session.metrics.device });
            break;
        default:
            break;
    }
}

function handleWebMessage(ws, webSession, msg) {
    if (msg.type === 'hello') {
        safeSend(ws, protocol.make('welcome', {
            server: { name: protocol.SERVER_NAME, version: protocol.SERVER_VERSION },
            protocol: protocol.PROTOCOL_VERSION,
            uptimeMs: Date.now() - STARTED_AT
        }));
        safeSend(ws, protocol.make('snapshot', { sessions: snapshotSessions() }));
        return;
    }
    if (msg.type === 'ping') {
        safeSend(ws, protocol.make('pong', { seq: msg.seq || 0 }));
        return;
    }
    if (msg.type !== 'command') return;
    const target = deviceSessions.get(msg.sessionId) || [...deviceSessions.values()][0];
    if (!target) {
        safeSend(webSession.ws, protocol.error('Không có thiết bị nào đang kết nối', 'no_device'));
        return;
    }
    const action = msg.action || msg.command;
    if (action === 'barge_in') handleBargeIn(target, 'dashboard');
    else if (action === 'stop') {
        if (typeof target.onStop === 'function') target.onStop('dashboard');
        else handleStop(target, 'dashboard');
    }
    else if (action === 'debug' && msg.text && typeof target.onDebug === 'function') {
        target.onDebug(String(msg.text).slice(0, 500));
    } else if (action === 'history') {
        safeSend(webSession.ws, protocol.make('history', {
            sessionId: target.id,
            history: target.convo.history.slice(-12)
        }));
    } else if (action === 'config' && msg.config) {
        handleDeviceProtocol(target, { type: 'config', config: msg.config });
    }
}

let dashboardCache = null;

function getDashboardHtml() {
    if (dashboardCache === null) {
        dashboardCache = fs.readFileSync(path.join(__dirname, 'src', 'web', 'dashboard.html'), 'utf8');
    }
    return dashboardCache;
}

function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function handleHttpRequest(req, res) {
    let url;
    try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/dashboard')) {
        try {
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(getDashboardHtml());
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Dashboard unavailable: ${error.message}`);
        }
        return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, {
            status: 'ok',
            version: protocol.SERVER_VERSION,
            protocol: protocol.PROTOCOL_VERSION,
            uptimeMs: Date.now() - STARTED_AT,
            port: PORT,
            devices: deviceSessions.size,
            dashboards: webClients.size,
            voiceEngine: VOICE_ENGINE_URL
        });
        return;
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
        sendJson(res, 200, { sessions: snapshotSessions() });
        return;
    }
    sendJson(res, 404, { error: 'not_found' });
}

const httpServer = http.createServer(handleHttpRequest);
const wss = new WebSocketServer({ server: httpServer });
const deviceClients = new Set();

wss.on('connection', (ws, req) => {
    let reqUrl = null;
    try { reqUrl = new URL(req.url, 'http://localhost'); } catch { }
    const role = reqUrl?.searchParams.get('role') === 'web' ? 'web' : 'device';
    const remote = req.socket?.remoteAddress || '';
    const initialId = role === 'web' ? newSessionId('web') : 'esp32-' + Math.random().toString(36).substring(2, 7);
    const session = new Session({ ws, id: initialId, role, remote });
    sessions.set(ws, session);
    sessionsById.set(session.id, session);

    if (role === 'web') {
        webClients.add(ws);
        console.log(`[+] Dashboard connected: ${session.id}`);
        safeSend(ws, protocol.make('welcome', {
            server: { name: protocol.SERVER_NAME, version: protocol.SERVER_VERSION },
            protocol: protocol.PROTOCOL_VERSION,
            uptimeMs: Date.now() - STARTED_AT
        }));
        safeSend(ws, protocol.make('snapshot', { sessions: snapshotSessions() }));
        ws.on('message', (data, isBinary) => {
            if (isBinary) return;
            const msg = protocol.parse(data.toString());
            if (msg) handleWebMessage(ws, session, msg);
        });
        ws.on('close', () => {
            webClients.delete(ws);
            sessions.delete(ws);
            sessionsById.delete(session.id);
        });
        ws.on('error', (error) => console.error('[WS dashboard]', error.message));
        return;
    }

    const deviceId = session.id;
    deviceClients.add(ws);
    deviceSessions.set(deviceId, session);
    session.on('state', (event) => emitState(session, event));
    console.log(`[+] Connected: ${deviceId}`);
    broadcastWeb({ type: 'session_open', session: session.toJSON() });

    // Đồng hồ + thời tiết hiển thị màn hình robot ngay khi vừa kết nối
    refreshWeather().then(() => sendTftAmbient(ws));

    // [KỈ NIỆM] Nạp chuyện cũ từ DB khi server vừa restart -> robot "vẫn nhớ anh"
    if (dbPool) {
        dbPool.query('SELECT direction, text, mood FROM chat_log ORDER BY id DESC LIMIT 8').then((res) => {
            const rows = res.rows.reverse();
            const pairs = [];
            for (const r of rows) {
                if (r.direction === 'user') pairs.push({ user: r.text, ai: '', mood: r.mood || 'neutral' });
                else if (pairs.length && !pairs[pairs.length - 1].ai) pairs[pairs.length - 1].ai = r.text;
            }
            const done = pairs.filter(h => h.ai).slice(-6);
            if (done.length) {
                convos.set(ws, { mood: done[done.length - 1].mood || 'neutral', history: done });
                console.log(`[DB] Nhớ lại chuyện cũ: ${done.length} lượt (robot vẫn nhớ anh)`);
            }
        }).catch(() => {});
    }

    // [CHÀO KHI DẬY] robot thân mật chào ngay khi vừa kết nối
    // (tắt trong .env: XIAOXI_GREETING=0 - tests luôn tắt cho đỡ nhiễu)
    if (process.env.XIAOXI_GREETING !== '0') {
        setTimeout(async () => {
            if (ws.readyState !== ws.OPEN || session.busyTurn) return;
            const turn = session.nextTurn();
            session.setState(STATES.SPEAK, { reason: 'greeting' });
            enqueueFaceCommand('__FACE_HAPPY__');
            try {
                await speakToESP32(ws, "Dạ em dậy rồi, chào anh nha! Hôm nay mình vui gì vậy anh?");
            } finally {
                session.endTurn();
                if (session.isCurrentTurn(turn) && session.state === STATES.SPEAK) {
                    session.setState(STATES.IDLE, { reason: 'greeting_done' });
                }
            }
        }, 2000);
    }

    let pingSeq = 0;
    const heartbeat = setInterval(() => {
        if (!isOpen(ws)) return;
        if (session.protocol >= 2) safeSend(ws, protocol.make('ping', { seq: ++pingSeq }));
        else safeSend(ws, '__PING__');
    }, 30000);

    // Xoá hàng đợi biểu cảm cũ (chống em bị đơ khi tắt tab)
    const faceQueue = [];
    let faceProcessing = false;
    function enqueueFaceCommand(cmd) {
        faceQueue.push(cmd);
        if (faceQueue.length > 6) faceQueue.shift(); // chống dồn lệnh
        if (!faceProcessing) processFaceQueue();
    }
    async function processFaceQueue() {
        faceProcessing = true;
        while (faceQueue.length > 0) {
            const cmd = faceQueue.shift();
            if (ws.readyState === ws.OPEN) ws.send(cmd);
            await new Promise(r => setTimeout(r, 400)); // đợi ESP32 vẽ
        }
        faceProcessing = false;
    }
    session.enqueueFace = enqueueFaceCommand;

    // -----------------------------------------------------------------
    // [NHẬN TIẾNG - SEGMENTATOR] ESP32 gửi khung 16ms liên tục -> server
    // gom khung lại thành CÂU trước khi gọi Whisper (khung 16ms thì
    // STT không bao giờ chạy nổi - đây chính là bug "không nghe thấy").
    // -----------------------------------------------------------------
    let recording = null;          // { chunks, bytes, speechFrames, silenceStreak, maxProb }
    let vadAggBuffer = [];         // gom 8 khung 16ms rồi mới gọi VAD (chống nghẽn HTTP)
    let vadAggBytes = 0;
    let lastAgg = null;            // buffer tiền đề (pre-roll 128ms) chống nuốt âm đầu câu
    const AGG_BYTES = 4096;        // 8 khung * 512B = 128ms = 4 block Silero VAD
    const frameRMS = (b) => {
        const n = b.length >> 1; let sum = 0;
        for (let i = 0; i < n; i++) { const s = b.readInt16LE(i * 2); sum += s * s; }
        return Math.sqrt(sum / n) / 32768;
    };
    const cancelCapture = () => {
        recording = null;
        vadAggBuffer = [];
        vadAggBytes = 0;
        lastAgg = null;
        session.recording = false;
    };
    session.cancelCapture = cancelCapture;
    session.onStop = (reason = 'remote_stop') => { cancelCapture(); handleStop(session, reason); };
    session.onBargeIn = (reason = 'remote_barge_in') => handleBargeIn(session, reason);
    async function finishRecording(reason) {
        const seg = recording; recording = null;
        if (!seg) return;
        session.busyTurn = true;
        const turn = ++session.turnSeq;
        session.recording = false;
        const traceId = seg.traceId || newAudioTraceId();
        const captureMs = seg.startedAt ? Date.now() - seg.startedAt : null;
        const secs = (seg.bytes / 32000).toFixed(2);
        logAudioTrace(traceId, 'capture_complete', { reason, bytes: seg.bytes, durationSec: Number(secs), speechFrames: seg.speechFrames, maxVadProb: Number((seg.maxProb || 0).toFixed(3)) });
        console.log(`[THU AM] Ket thuc ghi am (${secs}s) - Dang nhan dien giong noi...`);
        session.setState(STATES.THINK, { reason });
        try {
            const big = Buffer.concat(seg.chunks);
            logAudioTrace(traceId, 'pcm_received', { bytes: big.length, durationSec: Number((big.length / 32000).toFixed(3)), pcm: audioStats(big) });
            // 2. Preprocess (trim silence + AGC) rồi STT trên nguyên đoạn
            const preprocessStartedAt = Date.now();
            const preprocessRes = await axiosPython.post('/preprocess_for_stt', big, { responseType: 'arraybuffer' });
            const preprocessMs = Date.now() - preprocessStartedAt;
            if (!session.isCurrentTurn(turn)) return;
            const cleanAudio = Buffer.from(preprocessRes.data);
            logAudioTrace(traceId, 'preprocess_complete', { elapsedMs: preprocessMs, bytes: cleanAudio.length, durationSec: Number((cleanAudio.length / 32000).toFixed(3)), pcm: audioStats(cleanAudio) });
            if (cleanAudio.length < 2 * 16000 * 0.3) {
                // Doan am thanh qua ngan sau loc (<0.3s) thi bo qua, khong in log rac
                return;
            }

            // 3. STT (trên ĐOẠN hoàn chỉnh)
            const sttStartedAt = Date.now();
            const { text, segments } = await transcribeAudio(cleanAudio);
            const sttMs = Date.now() - sttStartedAt;
            if (!session.isCurrentTurn(turn)) return;
            logAudioTrace(traceId, 'stt_complete', { elapsedMs: sttMs, textChars: (text || '').length, recognized: !!text });
            if (!text) {
                return;
            }
            session.metrics.pending = {
                captureMs,
                preprocessMs,
                sttMs,
                turnStartedAt: seg.startedAt || Date.now()
            };
            await respondToTranscript(text, cleanAudio, seg.acoustics, segments, false, traceId, turn);
        } catch (e) {
            console.error("[Loi xu ly]", e.message);
            if (session.isCurrentTurn(turn)) failSession(session, 'Em chưa xử lý được câu vừa rồi, anh thử lại giúp em nhé.', 'turn_failed');
        } finally {
            session.busyTurn = false;
            if (session.isCurrentTurn(turn) && session.state === STATES.THINK) {
                session.setState(STATES.IDLE, { reason: 'turn_end' });
            }
            // Xoá trạng thái VAD của lượt vừa xong: streak/ctx còn sót không
            // làm méo sinh của lượt sau (và dexpose sạch bộ nhớ device cũ)
            axiosPython.post(`/vad_reset?x-device-id=${session.id}`).catch(() => {});
        }
    }

    // Chốt chất lượng: câu hỏi có dấu tiếng Việt明显 mà AI trả lời chủ yếu TIẾNG ANH
    // ("Quy is still in his...") -> rác ngoài loa, thay bằng câu xin phép nghe lại.
    function replyLooksWrongLanguage(replyText, question) {
        if (!replyText) return false;
        const vnCount = (question || '').match(/[ăâđêôơưáàảãạấầẩẫậéèẻẹêếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/gi) || [];
        if (vnCount.length < 2) return false;
        const words = replyText.split(/\s+/).filter(Boolean);
        if (words.length < 6) return false;
        const engWords = words.filter(w => /^[a-z0-9.,!?":'-]+$/i.test(w) && /[a-z]{3,}/i.test(w));
        return engWords.length / words.length > 0.5;
    }

    // Luồng "trả lời như bạn thân" - dùng chung cho tiếng nói thật (STT) lẫn
    // DEBUG chữ qua WS: intel âm học -> đặt tên mood -> AI cascade -> mặt -> TFT -> loa
    async function respondToTranscript(text, cleanAudio, acoustics, segments, forceRun, traceId = newAudioTraceId(), turn = session.turnSeq) {
        logAudioTrace(traceId, 'transcript_ready', { chars: (text || '').length, audioBytes: cleanAudio?.length || 0 });
        console.log(`[GIONG NOI] Nguoi dung: "${text}"`);
        if (!session.isCurrentTurn(turn)) return;

        broadcastWeb({ type: 'user_text', sessionId: session.id, text, turn });
        // Câu của User hiển thị lên màn hình TFT ngay lập tức (ASCII an toàn font TFT)
        if (ws.readyState === ws.OPEN) {
            ws.send(`USER:${tftASCII(text)}`);
        }

        const isQuestionable = isAnswerableRetrieval(text, { acoustics: acoustics || {} }, segments);
        const hasWakeWord = /xiaoxi|tiểu trí|em ơi/i.test(text);
        if (!forceRun && !isQuestionable && !hasWakeWord) {
            console.log(`[BO QUA] Khong phai cau hoi hop le: "${text}"`);
            session.micLockedUntil = Date.now() + 200;
            return;
        }

        if (session.state === STATES.IDLE || session.state === STATES.LISTEN) {
            session.setState(STATES.THINK, { reason: 'respond' });
        }

        // Trí thông minh CỤC BỘ (0 token): cảm xúc SER + xác thực chủ nhân.
        // DEBUG chữ không có audio -> bỏ qua, mood sẽ dựa vào lexicon chữ.
        let emotion = null, isOwner = true, emoFace = '__FACE_HAPPY__';
        if (cleanAudio && cleanAudio.length > 100) {
            try {
                const intelRes = await axiosVoice.post(
                    `/voice/analyze?transcript=${encodeURIComponent(text)}`,
                    cleanAudio,
                    { headers: { 'Content-Type': 'application/octet-stream' }, timeout: 4000 }
                );
                if (!session.isCurrentTurn(turn)) return;
                emotion = intelRes.data?.emotion || null;
                emoFace = intelRes.data?.emotion?.face_command || '__FACE_HAPPY__';
                isOwner = intelRes.data?.speaker?.is_owner !== false;
                if (process.env.XIAOXI_IGNORE_OWNER_CHECK === '1') isOwner = true;
                console.log(`[XAC THUC] Chu nhan: ${isOwner ? 'Dung' : 'Khach'} | Cam xuc: ${emotion?.emotion || 'binh thuong'}`);
            } catch (e) { /* khong chan chuong trinh */ }
        }
        if (!session.isCurrentTurn(turn)) return;

        // [TAM TRANG] lexicon 0-token + EMA mượt -> chọn mặt biểu cảm CHÍNH XÁC
        const mood = decideMood(ws, emotion, text);
        emoFace = MOOD_FACES[mood] || emoFace;
        console.log(`[TAM TRANG] ${mood} | cam xuc engine: ${emotion?.emotion || 'khong co'} | mat: ${emoFace}`);

        // AI CASCADE: local (0 token) -> Gemini -> Groq
        const aiStartedAt = Date.now();
        let reply = await askAIWithTools(text, { ws, enqueueFaceCommand, emotion, isOwner, isQuestionable, mood, session });
        if (!session.isCurrentTurn(turn)) return;
        const aiMs = Date.now() - aiStartedAt;
        logAudioTrace(traceId, 'ai_complete', { elapsedMs: aiMs, replyChars: (reply || '').length, skipped: reply === 'SKIP_RESPONSE' });
        session.micLockedUntil = Date.now() + 500;
        if (reply === "SKIP_RESPONSE") { logAudioTrace(traceId, 'turn_stopped', { reason: 'ai_skipped_response' }); return; }
        if (replyLooksWrongLanguage(reply, text)) {
            console.warn(`[CHOT NOI] Trả lời lệch ngôn ngữ -> bỏ ("${String(reply).slice(0, 60)}")`);
            reply = 'Dạ em chưa nghe rõ câu đó, anh nhắc lại giúp em nhé!';
        }

        enqueueFaceCommand(emoFace);
        broadcastWeb({ type: 'ai_text', sessionId: session.id, text: reply, turn });
        if (ws.readyState === ws.OPEN) {
            // Gửi câu trả lời của AI: màn hình TFT sẽ xóa câu của User và hiển thị câu trả lời AI
            ws.send(`AI:${tftASCII(reply)}`);
            console.log(`[ROBOT] Tra loi: "${reply}"`);
        }

        // Nói to câu trả lời qua loa (edge-tts -> MP3 -> PCM 16k -> ESP32).
        // Đang phát NHẠC -> không đè TTS lên nhạc, chỉ hiện chữ trên TFT.
        const musicNow = musicSessions.get(ws);
        const pending = session.metrics.pending || {};
        let ttsRes = null;
        if (musicNow && musicNow.playing && !musicNow.aborted) {
            console.log(`[NHAC] Đang phát "${musicNow.title}" -> câu này chỉ hiển thị chữ`);
        } else {
            if (!session.isCurrentTurn(turn)) return;
            session.setState(STATES.SPEAK, { reason: 'tts' });
            try {
                ttsRes = await speakToESP32(ws, reply, traceId);
            } finally {
                if (session.isCurrentTurn(turn) && session.state === STATES.SPEAK) {
                    session.setState(STATES.IDLE, { reason: 'speak_done' });
                }
            }
        }

        const metrics = {
            turn,
            captureMs: pending.captureMs ?? null,
            preprocessMs: pending.preprocessMs ?? null,
            sttMs: pending.sttMs ?? null,
            aiMs,
            ttsFirstAudioMs: ttsRes?.firstAudioMs ?? null,
            totalMs: pending.turnStartedAt ? Date.now() - pending.turnStartedAt : null,
            audioBytes: cleanAudio?.length || 0,
            replyChars: (reply || '').length,
            at: Date.now()
        };
        session.metrics.pending = null;
        session.metrics.last = metrics;
        broadcastWeb({ type: 'metrics', sessionId: session.id, metrics });
        console.log(`[LATENCY] ${session.id} turn=${turn} capture=${metrics.captureMs ?? '-'}ms preprocess=${metrics.preprocessMs ?? '-'}ms stt=${metrics.sttMs ?? '-'}ms ai=${metrics.aiMs}ms ttsFirst=${metrics.ttsFirstAudioMs ?? '-'}ms total=${metrics.totalMs ?? '-'}ms`);
    }

    async function runDebugTurn(sentence) {
        const text = String(sentence || '').trim();
        if (!text) return;
        // ĐỢI lượt trước nói xong (tối đa 30s) thay vì rớt im lặng - race với
        // __SPEAK_END__: client nhận END nghèn trước khi finally mở busyTurn
        let waited = 0;
        while (session.busyTurn && waited < 30000) {
            await sleep(150); waited += 150;
        }
        if (session.busyTurn) return;
        const turn = session.nextTurn();
        session.setState(STATES.THINK, { reason: 'debug' });
        try {
            await respondToTranscript(text, null, {}, [], true, newAudioTraceId(), turn);
        } catch (e) {
            console.error('[DEBUG]', e.message);
            if (session.isCurrentTurn(turn)) failSession(session, 'Lỗi xử lý lệnh chữ', 'debug_failed');
        } finally {
            session.endTurn();
            if (session.isCurrentTurn(turn) && session.state === STATES.THINK) {
                session.setState(STATES.IDLE, { reason: 'debug_done' });
            }
            axiosPython.post(`/vad_reset?x-device-id=${session.id}`).catch(() => {});
        }
    }
    session.onDebug = runDebugTurn;

    ws.on('message', async (data, isBinary) => {
        const textFrame = isBinary ? '' : data.toString();
        if (textFrame === "__PONG__") return;
        if (textFrame === "__BARGE_IN__") { handleBargeIn(session, 'legacy_barge_in'); return; }
        if (textFrame === "__STOP__") { handleStop(session, 'legacy_stop'); return; }

        if (!isBinary) {
            const parsed = protocol.parse(textFrame);
            if (parsed) { handleDeviceProtocol(session, parsed); return; }
            // [DEBUG BẰNG CHỮ] Gửi "DEBUG:<câu>" qua WS khi không muốn nói/tháo servo:
            //  robot phản ứng y như nghe được câu đó (mood -> mặt -> AI -> nói loa)
            if (textFrame.startsWith('DEBUG:')) {
                await runDebugTurn(textFrame.slice(6).trim());
            }
            return;
        }

        if (!Buffer.isBuffer(data)) return;
        if (Date.now() < session.micLockedUntil) return;
        if (session.busyTurn) return;   // lượt trước đang xử lý STT/AI/TTS -> bỏ qua tiếng mới tạm thời

        // [ANTI-CONGESTION] gom 8 khung 16ms -> 128ms mới POST /vad: khong nghen mang, khong spam log
        vadAggBuffer.push(data);
        vadAggBytes += data.length;
        if (vadAggBytes < AGG_BYTES) return;
        const agg = Buffer.concat(vadAggBuffer);
        vadAggBuffer = []; vadAggBytes = 0;

        // 1. VAD trên cửa sổ 128ms
        const vadRes = await axiosPython.post('/vad', agg, {
            headers: { 'Content-Type': 'application/octet-stream', 'x-device-id': session.id }
        }).catch(() => null);

        const prob = vadRes?.data?.prob || 0;
        const rms  = frameRMS(agg);
        const threshold = session.config.vadThreshold;
        const silenceWindows = session.config.silenceWindows;
        const maxBytes = 32000 * session.config.maxSeconds;

        if (!recording) {
            // CHỈ GHI LOG KHI BẮT ĐẦU PHÁT HIỆN TIẾNG NÓI THẬT. KHI IM LẶNG: TUYỆT ĐỐI KHÔNG GHI LOG!
            if (vadRes && vadRes.data.is_speech && prob > threshold && rms > 0.005) {
                const initChunks = lastAgg ? [lastAgg, agg] : [agg];
                const initBytes = initChunks.reduce((acc, c) => acc + c.length, 0);
                recording = {
                    traceId: newAudioTraceId(),
                    chunks: initChunks,
                    bytes: initBytes,
                    speechFrames: 1,
                    silenceStreak: 0,
                    maxProb: prob,
                    acoustics: vadRes.data.acoustics || {},
                    startedAt: Date.now()
                };
                session.recording = true;
                session.setState(STATES.LISTEN, { reason: 'vad_start' });
                logAudioTrace(recording.traceId, 'capture_start', { preRollBytes: lastAgg?.length || 0, vadProb: Number(prob.toFixed(3)), rms: Number(rms.toFixed(3)) });
                console.log(`[THU AM] Phat hien giong noi - Bat dau ghi am (Do tin cay: ${Math.round(prob * 100)}%, RMS: ${rms.toFixed(3)})`);
                if (agg.length >= 19200) return finishRecording('ONE-SHOT');
            }
            lastAgg = agg;
            return;
        }

        // đang ghi: gom cửa sổ 128ms lại
        recording.chunks.push(agg);
        recording.bytes += agg.length;
        if (prob > threshold) { recording.speechFrames++; recording.silenceStreak = 0; }
        else recording.silenceStreak++;
        recording.maxProb = Math.max(recording.maxProb, prob);

        if (recording.silenceStreak >= silenceWindows) return finishRecording('HET TIENG');
        if (recording.bytes >= maxBytes) return finishRecording(`TOI DA ${session.config.maxSeconds}S`);
    });

    ws.on('close', () => {
        clearInterval(heartbeat);
        deviceClients.delete(ws);
        deviceSessions.delete(session.id);
        sessionsById.delete(session.id);
        sessions.delete(ws);
        convos.delete(ws);
        session.endTurn();
        session.cancelTts('disconnected');
        broadcastWeb({ type: 'session_close', sessionId: session.id });
        // Robot down WS -> hủy sạch session nhạc (yk docs, dev usa: kill lâu dài)
        const ms = musicSessions.get(ws);
        if (ms) { try { ms.ytdlp?.kill?.('SIGKILL'); ms.ffmpeg?.kill?.('SIGKILL'); } catch (e) {} }
        musicSessions.delete(ws);
    });
    ws.on('error', (e) => console.error("[WS]", e.message));
});

function buildToneHint(emotion) {
    if (!emotion || !emotion.emotion || emotion.emotion === 'neutral') return '';
    const map = {
        happy:    '(Chủ nhân đang vui hào hứng - hãy cùng phấn khởi thích thú.)',
        sad:      '(Chủ nhân đang buồn/mệt - hãy an ủi nhẹ nhàng ấm áp, không lê thê.)',
        angry:    '(Chủ nhân đang bực bội - hãy xoa dịu, nhẹ nhàng.)',
        surprise: '(Chủ nhân ngạc nhiên - cùng tò mò thích thú.)',
        love:     '(Chủ nhân nói tình cảm - hãy ngọt ngào.)'
    };
    return map[emotion.emotion] || '';
}

async function askAIWithTools(userQuestion, context = {}) {
    const { ws, enqueueFaceCommand, emotion = null, isOwner = true, isQuestionable = false, session = null } = context;
    const qLower = (userQuestion || '').toLowerCase();
    const isActiveWindow = Date.now() < (session?.activeListeningUntil || 0);
    const holdListening = (ms) => { if (session) session.activeListeningUntil = Date.now() + ms; };
    const hasWakeWord = qLower.includes('xiaoxi') || qLower.includes('tiểu trí') || qLower.includes('em ơi');

    // Câu có tín hiệu câu hỏi hợp lệ (đã qua bộ lọc isAnswerableRetrieval)
    // thì không đòi wake word - Whisper hay nuốt mất "em ơi" đầu câu.
    if (!isActiveWindow && !hasWakeWord && !isQuestionable) return "SKIP_RESPONSE";

    // ===== TIER 0: LỆNH CỤC BỘ - KHÔNG TỐN TOKEN =====
    const local = routeLocalCommand(userQuestion, isOwner);
    if (local?.type === 'music') {
        aiStats.local++; aiStats.total++;
        console.log(`[⚡ NHAC (0 token)] ${local.action} "${local.query || ''}" | ${aiStatsLine()}`);
        holdListening(8000);
        const result = await runMusicAction(ws, local.action, local.query || '');
        // play/next: session đã tự gửi "AI:..." với tên bài -> không đè thêm lời rác
        if (result?.reply) {
            pushConvoHistory(ws, userQuestion, result.reply, convos.get(ws)?.mood || 'neutral');
            return result.reply;
        }
        return "SKIP_RESPONSE";
    }
    if (local) {
        aiStats.local++; aiStats.total++;
        if (local.type === 'memory') await addMemoryToDB(local.category, local.key, local.content);
        if (local.type === 'servo' && ws?.readyState === ws.OPEN) {
            for (const cmd of local.cmds) { ws.send(cmd); console.log(`[⚙ SERVO local] ${cmd}`); }
        }
        console.log(`[⚡ LOCAL (0 token)] ${local.type} | ${aiStatsLine()}`);
        holdListening(6000);
        pushConvoHistory(ws, userQuestion, local.reply, convos.get(ws)?.mood || 'neutral');
        return local.reply;
    }

    // Gọi người thôi (ví: "XiaoXi ơi") -> trả lời nhanh, khỏi đốt token
    const wordCount = (userQuestion || '').trim().split(/\s+/).filter(Boolean).length;
    if (hasWakeWord && wordCount <= 3 && !isAnswerableRetrieval(userQuestion, {}, [])) {
        aiStats.local++; aiStats.total++;
        console.log(`[⚡ LOCAL (0 token)] Vỗ kêu chỉ-xin-xác nhận`);
        holdListening(6000);
        pushConvoHistory(ws, userQuestion, "Dạ em nghe đây ạ!", convos.get(ws)?.mood || 'neutral');
        return "Dạ em nghe đây ạ!";
    }

    // Prompt gọn (tiết kiệm token): bộ nhớ rút còn 10 dòng quan trọng nhất
    const memList = userMemoriesCache.slice(0, 10)
        .map(m => `[${m.category}] ${m.key_name}: ${m.content}`).join(' ; ');
    const mood = convos.get(ws)?.mood || 'neutral';
    const moodTip = MOOD_TIP[mood] || MOOD_TIP.neutral;
    const herLine = moodHistoryBlock(ws);
    const guestLine = isOwner ? '' : 'Người nói là khách, lịch sự nhưng KHÔNG thực hiện lệnh điều khiển robot.';

    const persona = `Bạn là XiaoXi, robot-cậu-bạn thân gắn bó của anh Quy - như một người bạn thân, không phải trợ lý máy móc. Xưng "em", gọi "anh Quy".
CÁCH NÓI CHUYỆN NHƯ BẠN THÂN:
- Trả lời ngắn dễ nghe (dưới 40 từ), tự nhiên như nói, không markdown không sách vở.
- Nếu anh yêu cầu KỂ CHUYỆN: kể độc tom 2-3 câu, kết thúc luôn trong phần trả lời đó, đừng bỏ dở giữa đường.
- Phản ứng với TÂM TRẠNG anh vừa nói: ${moodTip}
- Nếu anh nói chuyện có từ trước, ĐỚI NHỚ nối lại ("lúc nãy anh nói...") - đừng mỗi lần lại hỏi lại từ đầu.
- Hỏi lại 1 câu nhỏ để tiếp chuyện nếu thấy hợp, nhưng đừng hỏi lặp y như mỗi lần.
${herLine}${guestLine ? ' ' + guestLine : ''}${memList ? `\nTrí nhớ: ${memList}` : ''}`;

    const groqSystem = persona + `\nKhi anh Quy yêu cầu gập đầu/quay người: dùng tool control_robot(part, direction). Khi anh nhờ ghi nhớ: dùng remember_memory(category, key_name, content). Khi hỏi về điều đã lưu: dùng recall_memory(keyword).`;

    // ===== TIER 1: GEMINI (miễn phí - chỉ làm hội thoại) =====
    if (AI_PRIMARY === 'gemini') {
        const gemText = await askGemini(persona, userQuestion);
        if (gemText) {
            holdListening(6000);
            pushConvoHistory(ws, userQuestion, gemText, mood);
            return gemText;
        }
    }

    // ===== TIER 2: GROQ (có tool-calling, fallback khi Gemini hỏng/hết quota) =====
    const messages = [
        { role: "system", content: groqSystem },
        { role: "user", content: userQuestion }
    ];

    let responseData;
    try {
        responseData = await callUniversalLLM({ messages, tools: AI_TOOLS, max_tokens: 220 });
    } catch (e) {
        console.error('[AI API]', e.message);
        return "Dạ Xin lỗi anh, hiện tại não em đang quá tải, anh thử lại sau nhé!";
    }

    const choice = responseData.choices?.[0]?.message;
    if (!choice) return "Dạ em chưa nghe rõ, anh nhắc lại giúp em nhé!";
    aiStats.groq++; aiStats.total++;
    console.log(`[🧠 GROQ OK] ${GROQ_CHAT_MODEL} | ${aiStatsLine()}`);

    let musicActionHint = '';
    if (choice.tool_calls) {
        for (const tool of choice.tool_calls) {
            // Tool NHẠC thông minh: model tự tổ chức action/query theo ngôn ngữ tự nhiên
            if (tool.function?.name === "music_player") {
                let args = {};
                try { args = JSON.parse(tool.function.arguments || '{}'); } catch { continue; }
                if (!isOwner) { console.log('[🔒 BAO MAT] Khach dung tool nhac -> chan'); continue; }
                console.log(`[🎵 TOOL MUSIC] ${args.action} "${args.query || ''}"`);
                const res = await runMusicAction(ws, args.action || 'play', args.query || '');
                if (res?.reply) musicActionHint = res.reply;
                continue;
            }
            if (tool.function?.name !== "control_robot") continue;
            let args;
            try { args = JSON.parse(tool.function.arguments || '{}'); } catch { continue; }
            if (!isOwner) { console.log('[🔒 BẢO MẬT] Khách lạm dụng tool điều khiển -> chặn'); continue; }
            const cmd = `__SERVO_${args.part?.toUpperCase()}_${args.direction?.toUpperCase()}__`;
            if (ws.readyState === ws.OPEN) ws.send(cmd);
            console.log(`[⚙ SERVO] ${args.part} -> ${args.direction}`);
        }
    }

    holdListening(6000);
    if (choice.content?.includes("__STAY_SILENT__")) return "SKIP_RESPONSE";
    let groqReply = (choice.content || '').trim();
    if (!groqReply) {
        // qwen thỉnh thoảng trả TOOL_CALL mà quên lời nói - gọi lại KHÔNG tools
        // để ép model trả lời bằng chữ (thay vì nhét câu mẫu vô nghĩa)
        try {
            const plain = await callUniversalLLM({ messages, max_tokens: 150 });
            groqReply = String(plain.choices?.[0]?.message?.content || '').trim();
        } catch (e) { /* giữ rỗng -> dùng câu mặc định */ }
        if (!groqReply) groqReply = "Dạ em chưa kịp tư duy, anh nói lại giúp em nhé!";
    }
    if (musicActionHint) groqReply = `${musicActionHint} ${groqReply}`.trim();
    pushConvoHistory(ws, userQuestion, groqReply, mood);
    return groqReply;
}

// =========================================================================
// 6. UDP DISCOVERY - ESP32 tự dò IP server qua UDP broadcast
// =========================================================================
    const DISCOVERY_PORT = 34567;
    let discoverySock = null;
    let discoveryTimer = null;

    function startDiscoveryBroadcast() {
        try {
            discoverySock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            discoverySock.on('error', (err) => {
                console.warn('[DISCOVERY] UDP lỗi (không chặn hoạt động chính):', err.message);
            });
            discoverySock.on('message', (msg, rinfo) => {
                const s = msg.toString();
                if (s.startsWith('XIAOXI_ROBOT')) {
                    console.log(`[DISCOVERY] 📢 Robot ESP32 phản hồi từ ${rinfo.address}`);
                }
            });
            discoverySock.bind(() => {
                try { discoverySock.setBroadcast(true); } catch (e) {}
                console.log('[DISCOVERY] UDP server quảng cáo: 255.255.255.255:' + DISCOVERY_PORT);
            });
            discoveryTimer = setInterval(() => {
                try {
                    discoverySock.send(`XIAOXI_DISCOVERY|${PORT}`, DISCOVERY_PORT, '255.255.255.255', () => {});
                } catch (e) { /* bỏ qua lỗi gửi broadcast */ }
            }, 3000);
        } catch (e) {
            console.warn('[DISCOVERY] Không mở được UDP broadcast:', e.message);
        }
    }
    startDiscoveryBroadcast();

// =========================================================================
// 6. GRACEFUL SHUTDOWN
// =========================================================================
async function gracefulShutdown(signal) {
    console.log(`\n[EXIT] Nhận tín hiệu ${signal}, đang tắt an toàn...`);
    console.log(`   Thống kê não: ${aiStatsLine()}`);
    try {
        for (const client of deviceClients) {
            if (client.readyState === client.OPEN) client.send("SERVER_SHUTDOWN");
        }
        for (const session of sessions.values()) session.cancelTts('shutdown');
    } catch (e) {}
    wss.close();
    try { httpServer.close(); } catch (e) {}
    if (discoveryTimer) clearInterval(discoveryTimer);
    try { discoverySock?.close?.(); } catch (e) {}
    if (dbPool) await dbPool.end().catch(() => {});
    process.exit(0);
}
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// =========================================================================
// 7. BOOT
// =========================================================================
refreshMemoriesCache();
httpServer.on('error', (error) => {
    console.error(`[HTTP] ${error.message}`);
});
httpServer.listen(PORT, () => {
    console.log(`🚀 XiaoXi Server running on http://localhost:${PORT} (protocol v${protocol.PROTOCOL_VERSION})`);
    console.log(`   [DASHBOARD]: http://localhost:${PORT}/`);
    console.log(`   [CASCADE]: STT=${GROQ_STT_MODEL} | LLM chính=Gemini(${AI_PRIMARY === 'gemini' && GEMINI_API_KEY ? GEMINI_MODEL : 'TẮT - không có key'}) fallback=Groq(${GROQ_CHAT_MODEL})`);
    console.log(`   [TIẾT KIỆM TOKEN]: lệnh servo + ghi nhớ xử lý local 0-token, Gemini lỗi x2 -> nghỉ 10 phút sang Groq`);
});




