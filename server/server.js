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
const { fetchPageText } = require('./src/ai/web-page');
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
const VERBOSE_LOG = process.env.XIAOXI_VERBOSE === '1';
function logAudioTrace(traceId, stage, details = {}) {
    if (VERBOSE_LOG) console.log(`[AUDIO ${traceId}] ${stage} ${JSON.stringify(details)}`);
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
const GROQ_STT_MODEL   = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
const STT_PROVIDER     = (process.env.STT_PROVIDER || 'auto').toLowerCase(); // 'local' | 'groq' | 'auto'

// ===== AI CASCADE: GEMINI ƯU TIÊN (free) -> GROQ FALLBACK (quota) =====
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
if (!GEMINI_API_KEY) console.warn('[⚠ CONFIG] GEMINI_API_KEY chưa đặt - mọi câu hỏi sẽ đốt quota Groq!');
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const AI_PRIMARY     = (process.env.AI_PRIMARY || 'race').toLowerCase(); // 'gemini' | 'groq' | 'race' (đua song song)
const GEMINI_TIMEOUT = parseInt(process.env.GEMINI_TIMEOUT_MS || '3500');

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
const convos = new Map(); // ws -> { mood: 'neutral', pout: 0, history: [{user, ai, mood}] }
const { MOOD_FACES, MOOD_TIP, lexiconMood, makeDecideMood } = require('./src/ai/mood');
const decideMood = makeDecideMood(convos);
function pushConvoHistory(ws, userText, aiReply, mood) {
    const c = convos.get(ws) || { mood: 'neutral', history: [] };
    c.history.push({ user: String(userText).slice(0, 120), ai: String(aiReply).slice(0, 120), mood });
    if (c.history.length > 6) c.history.shift();     // nhớ 6 lượt gần nhất
    convos.set(ws, c);
    const session = sessions.get(ws);
    if (session) session.convo = c;
    // Ghi nhật ký hội thoại xuống DB (best-effort) để robot nhớ qua restart
    if (dbPool && aiReply) logChat('user', userText, mood);
    if (dbPool && aiReply) logChat('ai', aiReply, mood);
}
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
// 2.8 WEB SEARCH KHÔNG CẦN KEY: DuckDuckGo Lite + Google News RSS (tiếng Việt)
// Model tự gọi tool web_search khi câu hỏi cần tin MỚI ngoài dữ kiện cục bộ.
// =========================================================================
async function webSearchTool(query) {
    // Model hay copy nguyên câu dài của user làm query -> báo chí/RSS không tìm thấy gì.
    // Rút còn cụm khóa cốt lõi (tối đa 9 từ) trước khi search.
    const q = String(query || '').toLowerCase()
        .replace(/\b(tool|toàn bộ|tout bộ|trang web|website|đọc|mở|bằng|giúp anh|cho anh|nói cho anh|kết quả tìm kiếm|tìm bài viết|chi tiết)\b/gi, ' ')
        .replace(/[^0-9a-zà-ỹ\s.,-]/gi, ' ')
        .replace(/\s+/g, ' ').trim().split(' ').slice(0, 9).join(' ').slice(0, 120);
    if (!q) return [];
    const ua = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
    const out = [];
    try {
        const r = await fetch('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q), { headers: ua, signal: AbortSignal.timeout(7000) });
        const h = await r.text();
        const links = [...h.matchAll(/<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g)];
        const snips = [...h.matchAll(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g)];
        links.slice(0, 5).forEach((l, i) => {
            let url = l[1];
            const mU = url.match(/[?&]uddg=([^&]+)/);
            if (mU) { try { url = decodeURIComponent(mU[1]); } catch (e) { } }
            out.push({
                title: l[2].replace(/<[^>]+>/g, '').trim(),
                snippet: (snips[i]?.[1] || '').replace(/<[^>]+>/g, '').trim().slice(0, 300),
                url: url.slice(0, 160)
            });
        });
    } catch (e) { }
    // Tin thời sự -> bồi thêm Google News RSS VN (có ngày đăng, rất đáng tin)
    if (out.length < 3 || /(tin|hôm nay|mới nhất|kết quả|bóng đá|đá|giá|lãi|tuyển|bão|động đất|cháy)/i.test(q)) {
        try {
            const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=vi&gl=VN&ceid=VN:vi`, { headers: ua, signal: AbortSignal.timeout(7000) });
            const xml = await r.text();
            for (const it of [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5)) {
                const t = (it[1].match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
                const d = (it[1].match(/<pubDate>([^<]+)<\/pubDate>/) || [])[1] || '';
                const title = t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
                if (title && !out.some(o => o.title === title)) out.push({ title, snippet: `Tin tức báo chí, đăng ngày ${d}`, url: '' });
            }
        } catch (e) { }
    }
    return out.slice(0, 7);
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
            name: "set_reminder",
            description: "Đặt lời nhắc chủ động: đúng giờ hẹn robot sẽ tự cất tiếng nhắc anh Quy qua loa. Dùng khi anh dặn 'nhắc anh ... lúc .../ngày ...' mà câu chưa được xử lý sẵn.",
            parameters: {
                type: "object",
                properties: {
                    note: { type: "string", description: "Việc cần nhắc, cực ngắn (vd 'uống thuốc', 'nạp thẻ')" },
                    when: { type: "string", description: "Thời điểm theo GIỜ ĐỊA PHƯƠNG máy chủ (giờ VN), dạng 'YYYY-MM-DDTHH:MM' hoặc 'YYYY-MM-DD HH:MM'. VD hôm nay 20h30: '2026-10-28T20:30'" }
                },
                required: ["note", "when"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "web_search",
            description: "Tìm kiếm web thật (có kết quả mới nhất hôm nay). Dùng cho: tin tức/thời sự, giá cả (vàng, xăng, tỷ giá...), kết quả bóng đá, sự kiện gần đây, nhân vật hiện tại, hoặc bất kỳ facts nào em KHÔNG CHẮC. KHÔNG dùng cho trò chuyện, cảm xúc, kiến thức phổ thông.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Từ khóa tìm kiếm tiếng Việt ngắn gọn, vd 'giá vàng hôm nay'" }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "read_page",
            description: "Đọc TOÀN VĂN một trang web khi kết quả web_search (snippet) chưa đủ chi tiết - vd bảng giá mua/bán, bài viết đầy đủ. Chỉ dùng url lấy từ kết quả web_search.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "URL trang cần đọc (từ web_search)" }
                },
                required: ["url"]
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

async function callUniversalLLM({ messages, tools = null, temperature = 0.6, max_tokens = 300, timeoutMs = 9000 }) {
    const body = { model: GROQ_CHAT_MODEL, messages, tools, temperature, max_tokens };
    const cfg = {
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        httpAgent: groqHttpAgent,
        timeout: timeoutMs
    };
    try {
        const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', body, cfg);
        return res.data;
    } catch (e) {
        // 429 = vượt RPM của tier miễn phí (thường xuyên khi 1 lượt đốt 2-3 call
        // tool liên tiếp) -> chờ rồi thử lại ĐÚNG 1 lần, không dây dưa latency
        if (e.response?.status === 429) {
            const waitMs = 10000 + Math.floor(Math.random() * 4000);
            if (VERBOSE_LOG) console.warn(`[GROQ] 429 rate-limit, đợi ${(waitMs / 1000).toFixed(0)}s thử lại...`);
            await new Promise(r => setTimeout(r, waitMs));
            const res2 = await axios.post('https://api.groq.com/openai/v1/chat/completions', body, cfg);
            return res2.data;
        }
        throw e;
    }
}

// =========================================================================
// 2.5 TẦNG GEMINI (ưu tiên - miễn phí, tiết kiệm quota Groq)
// =========================================================================
async function askGemini(systemPrompt, userQuestion, history = []) {
    if (!GEMINI_API_KEY) return null;
    if (Date.now() < geminiCooldownUntil) return null;
    try {
        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
            {
                system_instruction: { parts: [{ text: systemPrompt }] },
                contents: [
                    ...history,
                    { role: 'user', parts: [{ text: userQuestion.slice(0, 1200) }] }
                ],
                generationConfig: { temperature: 0.6, maxOutputTokens: 300 }
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
        if (VERBOSE_LOG) console.log(`[🧠 GEMINI OK] ${GEMINI_MODEL} | ${aiStatsLine()}`);
        return text;
    } catch (e) {
        const status = e.response?.status;
        if (status === 401 || status === 403) {
            // Key sai/hết hạn vĩnh viễn -> nghỉ 7 ngày (coi như tắt Gemini), Groq lo hết.
            geminiCooldownUntil = Date.now() + 7 * 24 * 3600 * 1000;
            console.warn('[AI] GEMINI_API_KEY KHÔNG HỢP LỆ (401) -> tắt Gemini. Lấy key mới dạng AIza... tại https://aistudio.google.com/apikey rồi cập nhật .env');
        } else {
            geminiFailStreak++;
            if (geminiFailStreak >= 2) {
                geminiCooldownUntil = Date.now() + 10 * 60000;
                console.warn(`[AI] Gemini lỗi x${geminiFailStreak} -> nghỉ 10 phút, chuyển hẳn sang Groq (${e.message})`);
            } else {
                console.warn(`[AI] Gemini thất bại (lần ${geminiFailStreak}) -> fallback Groq: ${e.message}`);
            }
        }
        return null;
    }
}

// =========================================================================
// 2.6 BỘ ĐỊNH TUYẾN CỤC BỘ (0 TOKEN): lệnh servo + ghi nhớ theo mẫu câu
// Chỉ khi không khớp mẫu nào mới đốt token gọi LLM
// =========================================================================
// "nhắc anh uống thuốc sau 30 phút" / "lúc 7 giờ nhắc anh tập" -> {note, dueMs, label}
function tryParseReminder(text) {
    const raw = String(text || '').toLowerCase();
    if (!/nhắ[ck]/.test(raw)) return null;
    if (/nhắ[ck]\s+(lại|lai)\b/.test(raw)) return null;   // "nhắc lại" = lặp câu, không phải lời nhắc
    const NUMW = { 'một': 1, 'mot': 1, 'hai': 2, 'ba': 3, 'bốn': 4, 'bon': 4, 'năm': 5, 'nam': 5, 'sáu': 6, 'bay': 7, 'bảy': 7, 'tám': 8, 'tam': 8, 'chín': 9, 'chin': 9, 'mười': 10, 'muoi': 10 };
    const num = (s) => /^\d+$/.test(s) ? +s : (NUMW[s] ?? null);
    const now = new Date();
    let due = null, m;
    const W = '([0-9]+|[a-zà-ỹ]+)';
    if ((m = raw.match(new RegExp(`sau\\s+${W}\\s+ph[uú]t`)))) {
        const n = num(m[1]); if (n) due = new Date(now.getTime() + n * 60000);
    } else if (/sau\s+[a-zà-ỹ0-9]+\s*(nửa|half)\s*ti[ếe]ng/.test(raw) || /nửa\s*tiếng/.test(raw)) {
        due = new Date(now.getTime() + 30 * 60000);
    } else if ((m = raw.match(new RegExp(`sau\\s+${W}\\s+ti[ếe]ng`)))) {
        const n = num(m[1]); if (n) due = new Date(now.getTime() + n * 3600000);
    } else if ((m = raw.match(/(\d{1,2})\s*[h:]?\s*(\d{1,2})?(?:\s*gi[ờe])?/)) && /\d/.test(m[1]) && /gi[ờe]|\d{1,2}\s*[h:]|\d{1,2}:\d{1,2}/.test(raw)) {
        let hh = num(m[1]); const mm = m[2] ? +m[2] : 0;
        if (hh == null || hh > 23 || mm > 59) return null;
        if (/(tối|toi|chiều|chieu)/.test(raw) && hh < 12) hh += 12;
        if (/sáng|sang/.test(raw) && hh === 12) hh = 0;
        due = new Date(now); due.setHours(hh, mm, 0, 0);
        if (/ngày mai|ngay mai|sáng mai|tối mai|chiều mai/.test(raw)) due.setDate(due.getDate() + 1);
        else if (due <= now) due.setDate(due.getDate() + 1);
    }
    if (!due || due.getTime() - now.getTime() < 15000) return null;   // <15giây thì chưa kịp lịch -> để LLM/chat trả lời
    const ni = raw.search(/nhắ[ck]/);
    let rest = raw.slice(ni).replace(/^nhắ[ck]\s+/, '')
        .replace(/^(anh|em|giúp|giùm|cho|với|được|nhé|nha|là|rằng|giúp\s+em)\s+/i, '').trim();
    const ti = rest.search(/\b(lúc|luc|vào lúc|sau|sang|tối\s+nay|ngày\s+mai|ngay\s+mai)\b|\d{1,2}[h:]|([0-9]+|[a-zà-ỹ]{2,5})\s*gi[ờe]/);
    let note = (ti >= 0 ? rest.slice(0, ti) : rest)
        .replace(/^(lúc|luc|vào lúc|ngày mai|ngay mai)\s+/, '')
        .replace(/[.,!?~]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!note || note.length < 2) note = 'việc anh dặn';
    const hh = String(due.getHours()).padStart(2, '0'), mm = String(due.getMinutes()).padStart(2, '0');
    const sameDay = due.getDate() === now.getDate() && due.getMonth() === now.getMonth();
    const label = sameDay ? `${hh}:${mm} hôm nay` : `${hh}:${mm} ngày ${due.getDate()}/${due.getMonth() + 1}`;
    return { note: note.slice(0, 200), dueMs: due.getTime(), label };
}

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

    // 1b) LỜI NHẮC HẸN 0-TOKEN: "nhắc anh X lúc Y / sau N phút"
    const remParse = tryParseReminder(text);
    if (remParse) {
        if (!isOwner) return { type: 'servoDeny', reply: 'Dạ em xin lỗi, chỉ có anh Quy mới đặt lời nhắc em thôi ạ!' };
        return { type: 'reminder', note: remParse.note, dueMs: remParse.dueMs, whenLabel: remParse.label, reply: '' };
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

    // 4) ĐỒNG HỒ 0-TOKEN: đọc đồng hồ thật chính xác hơn để LLM đoán
    if (has('mấy giờ', 'bao gio', 'what time')) {
        const d = new Date();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const thu = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'][d.getDay()];
        const gio = mm === '00' ? `${hh} giờ đúng` : `${hh} giờ ${mm}`;
        return { type: 'clock', reply: `Bây giờ là ${gio}, ${thu} ngày ${d.getDate()}/${d.getMonth() + 1} ạ.` };
    }

    // 5) THỜI TIẾT 0-TOKEN: đọc cache open-meteo (số liệu thật, không để model bịa)
    if (has('thời tiết', 'weather', 'bao nhiêu độ', 'nóng không', 'mưa không')) {
        return { type: 'weather', reply: '' };
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
    // "tắt đèn đi"/"tắt quạt đi" KHÔNG phải lệnh nhạc - trả null để route thiết bị khác/LLM xử
    if (has('đèn', 'quat', 'quạt')) return null;
    // "đọc trang/chi tiết/bài viết..." KHÔNG phải lệnh nhạc - để LLM + web tools xử
    if (has('trang', 'web', 'chi tiết', 'bài giảng', 'bài tập', 'bài viết', 'tài liệu', 'đọc')) return null;
    if (has(' tạm dùng', ' tạm dừng', ' tạm ngừng', ' dừng lại nhạc', ' nhạc dừng')) return { action: 'pause' };
    if (has(' tắt nhạc', ' tắt bài hát', ' tắt bài nhạc', ' tắt bản nhạc', ' dừng nhạc', ' tắt tiếng nhạc', ' tắt nhạc đi', ' nhạc tắt đi', ' nhạc thôi')) return { action: 'stop' };
    if (has(' tiếp tục nhạc', ' tiếp tục bài', ' phát tiếp', ' phát lại nhạc', ' mở lại nhạc', ' nhạc tiếp tục')) return { action: 'resume' };
    if (has(' bài hát khác', ' bản nhạc khác', ' đổi bài hát', ' đổi nhạc', ' bài khác nhạc', ' nhạc bài khác')) return { action: 'next' };
    if (has(' mở nhạc', ' phát nhạc', ' nghe nhạc', ' bật nhạc', ' mở bài hát', ' phát bài hát', ' mở bài', ' phát bài',
            ' cho anh nghe nhạc', ' cho anh nghe bài', ' cho anh hát', ' nhac di', ' mở hơi nhạc')) {
        // Ch CHIP: lấy đoạn sau chốt từ khóa ("mở nhạc"/"phát bài hát"...) làm tên bài
        const anchors = ['mở nhạc', 'phát nhạc', 'nghe nhạc', 'mở bài hát', 'phát bài hát', 'mở bài', 'phát bài',
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
const DOMAIN_STT_PROMPT = 'Đây là hội thoại bằng tiếng Việt với robot trợ lý thông minh tên là XiaoXi. Người dùng đưa khẩu lệnh điều khiển thiết bị, cử chỉ robot hoặc hỏi đáp thông tin. Các từ khóa và khẩu lệnh thường dùng: XiaoXi ơi, em ơi, bật đèn, tắt đèn, bật quạt, tắt quạt, mở nhạc, tắt nhạc, phát nhạc, gập đầu, cúi đầu, ngẩng đầu lên, nhìn thẳng, quay trái, quay phải, thời tiết hôm nay thế nào, mấy giờ rồi, ghi nhớ giúp anh, nhắc anh, kể chuyện, hôm nay vui quá, tạm biệt.';

function normalizeVoiceText(text) {
    if (!text || typeof text !== 'string') return '';
    let s = text.trim();

    // 1. Chuẩn hoá các biến thể gọi tên robot (giọng địa phương, phiên âm nhầm):
    s = s.replace(/\b(xi\s+)?xiaomi(\s+ơi)?\b/gi, 'XiaoXi');
    s = s.replace(/\b(tiểu\s*hi|tiêu\s*hy|tiêu\s*hi|xỉu\s*xi|xì\s*xi|xảo\s*xi|xao\s*xi|sao\s*xi|siao\s*xi|cậu\s*xi|bạn\s*xi|xi\s*ơi|chào\s*xi|chao\s*xi|ê\s*xi|hey\s*xi)\b/gi, 'XiaoXi');
    s = s.replace(/\b(xiao\s*si|siao\s*si|sieu\s*si|siêu\s*xi|siêu\s*si|tiểu\s*trí|tiểu\s*tri)\b/gi, 'XiaoXi');
    s = s.replace(/\b(xiao\s*xi)\b/gi, 'XiaoXi');

    // 2. Sửa lỗi chính tả âm vần thường gặp từ Whisper đối với robot cử chỉ & thiết bị
    s = s.replace(/\b(gặp\s+đầu)\b/gi, 'gập đầu');
    s = s.replace(/\b(ngẫng\s+đầu|ngước\s+đầu|ngẩng\s+mặt)\b/gi, 'ngẩng đầu');

    // 3. Chuẩn hoá các khẩu lệnh thường dùng (rút gọn từ đệm, nói lắp, từ thừa)
    // Đèn
    s = s.replace(/\b(làm\s+ơn\s+)?(bật|mở)\s+(giùm\s+)?(cái\s+)?đèn(\s+(lên|đi|giúp\s+anh|hộ\s+anh))?\b/gi, 'bật đèn');
    s = s.replace(/\b(làm\s+ơn\s+)?tắt\s+(giùm\s+)?(cái\s+)?đèn(\s+(đi|giúp\s+anh|hộ\s+anh))?\b/gi, 'tắt đèn');
    s = s.replace(/\b(tắt\s+hết\s+mọi\s+thứ|đóng\s+hết|tắt\s+hết\s+đi|tắt\s+tất\s+cả\s+đi|tắt\s+toàn\s+bộ)\b/gi, 'tắt tất cả');

    // Quạt
    s = s.replace(/\b(làm\s+ơn\s+)?(bật|mở)\s+(giùm\s+)?(cái\s+)?quạt(\s+(lên|đi|giúp\s+anh|hộ\s+anh))?\b/gi, 'bật quạt');
    s = s.replace(/\b(làm\s+ơn\s+)?tắt\s+(giùm\s+)?(cái\s+)?quạt(\s+(đi|giúp\s+anh|hộ\s+anh))?\b/gi, 'tắt quạt');

    // Cử chỉ robot
    s = s.replace(/\b(gập\s+đầu\s+lên(\s+đi)?)\b/gi, 'gập đầu lên');
    s = s.replace(/\b(gập\s+đầu\s+xuống|cúi\s+đầu\s+xuống|cúi\s+đầu(\s+đi)?)\b/gi, 'cúi đầu');
    s = s.replace(/\b(ngẩng\s+đầu\s+lên(\s+đi)?|ngước\s+đầu\s+lên(\s+đi)?)\b/gi, 'ngẩng đầu lên');
    s = s.replace(/\b(nhìn\s+thẳng(\s+đi)?|quay\s+về\s+giữa|nhìn\s+về\s+phía\s+trước)\b/gi, 'nhìn thẳng');
    s = s.replace(/\b(quay\s+sang\s+trái(\s+đi)?|ngoảnh\s+trái(\s+đi)?|nhìn\s+sang\s+trái)\b/gi, 'quay trái');
    s = s.replace(/\b(quay\s+sang\s+phải(\s+đi)?|ngoảnh\s+phải(\s+đi)?|nhìn\s+sang\s+phải)\b/gi, 'quay phải');

    // Âm nhạc & Trợ lý
    s = s.replace(/\b(dừng\s+lại(\s+đi)?|thôi\s+dừng|ngừng\s+lại|dừng\s+phát|dừng\s+nhạc)\b/gi, 'dừng lại');
    s = s.replace(/\b(im\s+lặng(\s+đi)?|im\s+miệng|trật\s+tự(\s+đi)?|im\s+đi)\b/gi, 'im lặng');
    s = s.replace(/\b(bây\s+giờ\s+(là\s+)?mấy\s+giờ|xem\s+giờ\s+giúp\s+anh|mấy\s+giờ\s+rồi\s+em|mấy\s+giờ\s+rồi)\b/gi, 'mấy giờ rồi');
    s = s.replace(/\b(dự\s+báo\s+thời\s+tiết|thời\s+tiết\s+hôm\s+nay\s+ra\s+sao|xem\s+thời\s+tiết\s+giúp\s+anh|thời\s+tiết\s+thế\s+nào)\b/gi, 'thời tiết hôm nay thế nào');
    s = s.replace(/\b(kể\s+chuyện\s+gì\s+đi|kể\s+chuyện\s+cho\s+anh\s+nghe|kể\s+một\s+câu\s+chuyện)\b/gi, 'kể chuyện');
    s = s.replace(/\b(hát\s+cho\s+anh\s+nghe|hát\s+một\s+bài(\s+đi)?|hát\s+đi\s+em)\b/gi, 'hát đi');

    return s;
}

async function transcribeWithLocal(buffer) {
    const res = await axiosVoice.post('/stt', buffer, {
        headers: { 'Content-Type': 'application/octet-stream' },
        params: { prompt: DOMAIN_STT_PROMPT },
        timeout: 15000
    });
    const rawText = (res.data?.text || '').trim();
    const text = normalizeVoiceText(rawText);
    return {
        text,
        segments: res.data?.segments || [],
        confidence: res.data?.confidence ?? 1.0,
        isUncertain: Boolean(res.data?.is_uncertain),
        provider: 'local'
    };
}

async function transcribeWithGroq(buffer) {
    const wavBuf = pcmToWav(buffer);
    const form = new FormData();
    form.append('file', wavBuf, { filename: 'audio.wav', contentType: 'audio/wav' });
    form.append('model', GROQ_STT_MODEL);
    form.append('language', 'vi');
    form.append('temperature', '0');
    form.append('response_format', 'verbose_json');
    form.append('prompt', DOMAIN_STT_PROMPT);

    const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
        headers: { ...form.getHeaders(), 'Authorization': `Bearer ${GROQ_API_KEY}` },
        httpAgent: groqHttpAgent,
        timeout: 8000
    });
    const rawText = (res.data?.text || '').trim();
    const text = normalizeVoiceText(rawText);
    return {
        text,
        segments: res.data?.segments || [],
        confidence: 1.0,
        isUncertain: false,
        provider: 'groq'
    };
}

async function transcribeAudio(buffer) {
    if (STT_PROVIDER === 'local') {
        return await transcribeWithLocal(buffer);
    }
    if (STT_PROVIDER === 'groq') {
        return await transcribeWithGroq(buffer);
    }
    // STT_PROVIDER === 'auto': Ưu tiên faster-whisper cục bộ trong RAM (0 disk I/O, nhanh, bảo mật)
    // Nếu local timeout hoặc rỗng -> tự động fallback sang Groq cloud
    try {
        const localRes = await transcribeWithLocal(buffer);
        if (localRes && localRes.text) {
            return localRes;
        }
    } catch (err) {
        console.warn('[STT] Local faster-whisper loi -> fallback Groq: ' + err.message);
    }
    return await transcribeWithGroq(buffer);
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

async function addMemoryToDB(category, keyName, content, remindAt = null) {
    if (!dbPool) { userMemoriesCache.push({ category, key_name: keyName, content }); return; }
    try {
        await dbPool.query(
            `INSERT INTO user_memories (category, key_name, content, remind_at)
             VALUES ($1, $2, $3, $4)`,
            [category, keyName, content, remindAt ? new Date(remindAt) : null]
        );
        if (VERBOSE_LOG) console.log(`[DB] Đã ghi nhớ:[${category}] ${keyName} -> ${content}`);
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

// Xếp hạng trí nhớ theo độ liên quan với câu hỏi (từ khóa khớp), bộ nhớ mới hơn làm nền
function rankMemories(text, limit = 6) {
    const STOP = new Set(['hôm', 'nay', 'bây', 'giờ', 'cái', 'nào', 'vậy', 'sao', 'giúp', 'cho', 'anh', 'em', 'thì', 'là', 'của', 'và', 'rồi', 'đó', 'này', 'khi', 'nào', 'bạn', 'mình', 'về', 'has', 'what', 'the']);
    const words = [...new Set(String(text || '').toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
        .filter(w => w.length >= 2 && !STOP.has(w)))];
    const scored = userMemoriesCache.map((m, i) => {
        const hay = `${m.key_name} ${m.content} ${m.category}`.toLowerCase();
        let score = 0;
        for (const w of words) if (hay.includes(w)) score += 2;
        return { m, score, recency: userMemoriesCache.length - i };
    }).sort((a, b) => b.score - a.score || b.recency - a.recency);
    return scored.slice(0, limit).map(x => x.m);
}

// =========================================================================
// 4c. ĐỒNG HỒ + THỜI TIẾT QUÁN MÀN HÌNH (open-meteo miễn phí, cache 10 phút)
// =========================================================================
let wxCache = { at: 0, line: '', temp: null, humidity: null, code: null };
// Bản có dấu để TTS nói tự nhiên (bản không dấu phía trên dành cho màn TFT)
const WX_SPEAK = { 0: 'trời nắng', 1: 'trời nắng', 2: 'nắng nhẹ, trời trong', 3: 'trời nhiều mây', 45: 'có sương mù', 48: 'sương mù dày', 51: 'mưa phùn nhẹ', 53: 'mưa phùn', 55: 'mưa phùn', 61: 'có mưa', 63: 'mưa vừa', 65: 'mưa to', 66: 'mưa to', 67: 'mưa rất to', 71: 'có tuyết', 73: 'có tuyết', 75: 'tuyết rơi dày', 77: 'có tuyết', 80: 'mưa rào', 81: 'mưa rào', 82: 'mưa rào to', 85: 'mưa rào', 86: 'mưa đá', 95: 'có dông', 96: 'dông kèm mưa đá', 99: 'dông kèm mưa đá' };
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
        const temp = Math.round(c.temperature_2m), hum = Math.round(c.relative_humidity_2m);
        wxCache = { at: Date.now(), line: `${temp}C ${WX_CODES[c.weather_code] || 'tro nang'} ${hum}%`, temp, humidity: hum, code: c.weather_code };
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
// 4d. LỜI NHẮC HẸN: robot CHỦ ĐỘNG cất tiếng nhắc khi đến hẹn (DB là nguồn
// thật -> nhớ cả qua restart). Khi robot đang bận (nói/nhạc) -> để lần quét sau.
// =========================================================================
const REMINDER_SWEEP_MS = Math.max(5000, Number(process.env.XIAOXI_REMINDER_SWEEP_MS) || 30000);
async function sweepReminders() {
    if (!dbPool) return;
    let rows;
    try {
        const res = await dbPool.query(
            `SELECT id, content FROM user_memories
             WHERE category = 'reminder' AND is_done = FALSE AND remind_at IS NOT NULL AND remind_at <= NOW()
             ORDER BY remind_at LIMIT 3`);
        rows = res.rows;
    } catch (e) { return; }
    if (!rows.length) return;
    const ws = [...deviceClients].find(w => w.readyState === 1);
    const session = ws && sessions.get(ws);
    if (!ws || !session || session.busyTurn) return;   // robot offline/bận -> giữ nguyên, quét lại sau
    for (const row of rows) {
        try {
            await dbPool.query('UPDATE user_memories SET is_done = TRUE, updated_at = NOW() WHERE id = $1 AND is_done = FALSE', [row.id]);
        } catch (e) { continue; }
        const text = `Dạ, đến giờ rồi anh! Anh dặn em nhắc: ${row.content} ạ.`;
        const turn = session.nextTurn();
        session.setState(STATES.SPEAK, { reason: 'reminder' });
        try { session.enqueueFace?.('__FACE_HAPPY__'); } catch (e) {}
        if (ws.readyState === 1) { try { ws.send(`AI:${tftASCII(text)}`); } catch (e) {} }
        console.log(`[NHẮC LỊCH] ${row.content}`);
        console.log(`[XIAOXI] ${text}`);
        pushConvoHistory(ws, '[đến giờ hẹn]', text, convos.get(ws)?.mood || 'neutral');
        try { await speakToESP32(ws, text); } catch (e) {}
        session.endTurn();
        if (session.isCurrentTurn(turn) && session.state === STATES.SPEAK) {
            session.setState(STATES.IDLE, { reason: 'reminder_done' });
        }
    }
}
setInterval(sweepReminders, REMINDER_SWEEP_MS).unref?.();

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
    if (VERBOSE_LOG) console.log(`[STATE] ${session.id} ${event.from} -> ${event.to} (${event.meta?.reason || ''})`);
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
    session.micLockedUntil = 0;   // mở mic NGAY: tiếng nói đè đang vào từng frame không bị lock 300-500ms nuốt mất
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
            if (Number.isFinite(Number(cfg.vad_continue_threshold))) {
                session.config.vadContinueThreshold = Math.min(session.config.vadThreshold,
                    Math.max(0.05, Number(cfg.vad_continue_threshold)));
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

            // 3. STT SONG SONG với intel âm học (SER + vân giọng). Trước đây phần
            //    intel chạy TUẦN TỰ sau STT -> cộng thẳng ~0.5-1s vào thời gian chờ.
            //    SER chỉ cần âm học (F0/RMS/tempo) -> chạy song song không giảm chất lượng;
            //    lexicon ngữ nghĩa được chấm lại rẻ phí tại đây vì đã có transcript.
            const sttStartedAt = Date.now();
            const [sttResult, intelJSON] = await Promise.all([
                transcribeAudio(cleanAudio),
                axiosVoice.post('/voice/analyze?transcript=', cleanAudio, {
                    headers: { 'Content-Type': 'application/octet-stream' },
                    timeout: 4000
                }).then(r => r.data).catch(() => null)
            ]);
            const sttMs = Date.now() - sttStartedAt;
            if (!session.isCurrentTurn(turn)) return;
            const { text, segments, confidence, isUncertain } = sttResult;

            if (intelJSON?.emotion && text) {
                // Boost lexicon tiếng Việt (khớp voice_intelligence.classify) - 0 network
                const t = text.toLowerCase();
                const sc = {
                    happy: /vui|tuyệt|sướng|cười|hay quá|thích/.test(t) ? 0.4 : 0,
                    sad: /buồn|mệt|chán|thở dài|khóc|stress/.test(t) ? 0.5 : 0,
                    love: /yêu|thương|nhớ|dễ thương/.test(t) ? 0.6 : 0,
                    angry: /tức|bực|giận|khó chịu|ghét/.test(t) ? 0.5 : 0,
                    surprise: /bất ngờ|uầy|ủa|thật sao/.test(t) ? 0.5 : 0
                };
                const e = intelJSON.emotion;
                if (sc[e.emotion] >= 0.4) {
                    e.confidence = Math.min(0.99, (e.confidence || 0.5) + sc[e.emotion] * 0.5);
                }
            }

            logAudioTrace(traceId, 'stt_complete', { elapsedMs: sttMs, textChars: (text || '').length, recognized: !!text, confidence, isUncertain });
            if (!text || (isUncertain && text.length < 5)) {
                if (seg.speechFrames >= 8 && session.isCurrentTurn(turn)) {
                    session.metrics.pending = { captureMs, preprocessMs, sttMs, turnStartedAt: seg.startedAt || Date.now() };
                    await speakToESP32(ws, 'Dạ em nghe chưa rõ lắm, anh nói lại giúp em nhé!', traceId);
                }
                return;
            }
            session.metrics.pending = {
                captureMs,
                preprocessMs,
                sttMs,
                turnStartedAt: seg.startedAt || Date.now()
            };
            await respondToTranscript(text, cleanAudio, seg.acoustics, segments, false, traceId, turn, intelJSON);
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
    async function respondToTranscript(text, cleanAudio, acoustics, segments, forceRun, traceId = newAudioTraceId(), turn = session.turnSeq, intel = null) {
        logAudioTrace(traceId, 'transcript_ready', { chars: (text || '').length, audioBytes: cleanAudio?.length || 0 });
        console.log(`[USER] ${text}`);
        if (!session.isCurrentTurn(turn)) return;

        broadcastWeb({ type: 'user_text', sessionId: session.id, text, turn });
        // Câu của User hiển thị lên màn hình TFT ngay lập tức (ASCII an toàn font TFT)
        if (ws.readyState === ws.OPEN) {
            ws.send(`USER:${tftASCII(text)}`);
        }

        const isQuestionable = isAnswerableRetrieval(text, { acoustics: acoustics || {} }, segments);
        const hasWakeWord = /xiaoxi|tiểu trí|em ơi/i.test(text);
        if (!forceRun && !isQuestionable && !hasWakeWord) {
            session.micLockedUntil = Date.now() + 200;
            return;
        }

        if (session.state === STATES.IDLE || session.state === STATES.LISTEN) {
            session.setState(STATES.THINK, { reason: 'respond' });
        }

        // Trí thông minh CỤC BỘ (0 token): cảm xúc SER + xác thực chủ nhân.
        // Đã chạy SONG SONG với STT trong finishRecording -> chỉ đọc kết quả,
        // không chờ thêm. DEBUG chữ (cleanAudio null) không có audio -> bỏ qua.
        let emotion = null, isOwner = true, emoFace = '__FACE_HAPPY__';
        if (!intel && cleanAudio && cleanAudio.length > 100) {
            // Đường fallback (turn đặc biệt chưa có precomputed intel)
            try {
                const intelRes = await axiosVoice.post(
                    `/voice/analyze?transcript=${encodeURIComponent(text)}`,
                    cleanAudio,
                    { headers: { 'Content-Type': 'application/octet-stream' }, timeout: 4000 }
                );
                if (!session.isCurrentTurn(turn)) return;
                intel = intelRes.data;
            } catch (e) { /* khong chan chuong trinh */ }
        }
        if (intel) {
            emotion = intel.emotion || null;
            emoFace = intel.emotion?.face_command || '__FACE_HAPPY__';
            isOwner = intel.speaker?.is_owner !== false;
            if (process.env.XIAOXI_IGNORE_OWNER_CHECK === '1') isOwner = true;
        }
        if (!session.isCurrentTurn(turn)) return;

        // [TAM TRANG] lexicon 0-token + EMA mượt -> chọn mặt biểu cảm CHÍNH XÁC
        const mood = decideMood(ws, emotion, text);
        emoFace = MOOD_FACES[mood] || emoFace;

        // AI CASCADE: local (0 token) -> Gemini -> Groq
        const aiStartedAt = Date.now();
        let reply = await askAIWithTools(text, { ws, enqueueFaceCommand, emotion, isOwner, isQuestionable, mood, session, turn });
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
        console.log(`[XIAOXI] ${reply}`);
        if (ws.readyState === ws.OPEN) {
            // Gửi câu trả lời của AI: màn hình TFT sẽ xóa câu của User và hiển thị câu trả lời AI
            ws.send(`AI:${tftASCII(reply)}`);
        }

        // Nói to câu trả lời qua loa (edge-tts -> MP3 -> PCM 16k -> ESP32).
        // Đang phát NHẠC -> không đè TTS lên nhạc, chỉ hiện chữ trên TFT.
        const musicNow = musicSessions.get(ws);
        const pending = session.metrics.pending || {};
        let ttsRes = null;
        if (!(musicNow && musicNow.playing && !musicNow.aborted)) {
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

    // Xử lý 1 cửa sổ 128ms audio. PHẢI chạy tuần tự qua frameChain: hàm này await
    // POST /vad, nếu để message event chồng lấn thì recording/vadAggBuffer/lastAgg
    // bị 2 handler mutate cùng lúc -> sai thứ tự frame, cắt đôi câu.
    async function processAudioFrame(data) {
        if (!Buffer.isBuffer(data)) return;
        if (Date.now() < session.micLockedUntil) return;
        if (session.busyTurn) return;   // lượt trước đang xử lý STT/AI/TTS -> bỏ qua tiếng mới tạm thời

        // [ANTI-CONGESTION] firmware đã energy-gate, server gom 128ms một lần POST /vad
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
        const continueThreshold = session.config.vadContinueThreshold;
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
            }
            lastAgg = agg;
            return;
        }

        // đang ghi: gom cửa sổ 128ms lại. Hysteresis: ngưỡng giữ câu THẤP hơn
        // ngưỡng khởi động để không cắt khi giọng nhỏ dần cuối câu.
        recording.chunks.push(agg);
        recording.bytes += agg.length;
        if (prob > continueThreshold) { recording.speechFrames++; recording.silenceStreak = 0; }
        else recording.silenceStreak++;
        recording.maxProb = Math.max(recording.maxProb, prob);

        if (recording.silenceStreak >= silenceWindows) return finishRecording('HET TIENG');
        if (recording.bytes >= maxBytes) return finishRecording(`TOI DA ${session.config.maxSeconds}S`);
    }

    let frameChain = Promise.resolve();
    ws.on('message', (data, isBinary) => {
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
                frameChain = frameChain.then(() => runDebugTurn(textFrame.slice(6).trim()))
                    .catch(e => console.error('[WS]', e.message));
            }
            return;
        }

        frameChain = frameChain.then(() => processAudioFrame(data))
            .catch(e => console.error('[WS]', e.message));
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

// Thực thi tool_calls do model sinh ra (nhạc/servo/ghi nhớ/trả lời trí nhớ).
// Tool bộ nhớ trả về message 'tool' để nạp kết quả cho vòng gọi tiếp theo.
async function execToolCalls(choice, { ws, isOwner }) {
    let musicHint = '', musicDone = false;
    const toolMsgs = [];
    for (const tool of choice.tool_calls || []) {
        const name = tool.function?.name;
        let args = {};
        try { args = JSON.parse(tool.function.arguments || '{}'); } catch { continue; }
        if (name === 'music_player') {
            if (!isOwner) { console.log('[🔒 BAO MAT] Khach dung tool nhac -> chan'); continue; }
            if (VERBOSE_LOG) console.log(`[🎵 TOOL MUSIC] ${args.action} "${args.query || ''}"`);
            const res = await runMusicAction(ws, args.action || 'play', args.query || '');
            if (res?.reply) musicHint = res.reply;
            musicDone = true;
        } else if (name === 'control_robot') {
            if (!isOwner) { console.log('[🔒 BẢO MẬT] Khách lạm dụng tool điều khiển -> chặn'); continue; }
            const cmd = `__SERVO_${String(args.part).toUpperCase()}_${String(args.direction).toUpperCase()}__`;
            if (ws?.readyState === 1) ws.send(cmd);
            if (VERBOSE_LOG) console.log(`[⚙ SERVO] ${args.part} -> ${args.direction}`);
        } else if (name === 'remember_memory') {
            if (!isOwner) continue;
            const key = String(args.key_name || 'việc cần nhớ').slice(0, 60);
            const content = String(args.content || '').slice(0, 300);
            await addMemoryToDB(args.category || 'personal', key, content);
            toolMsgs.push({ role: 'tool', tool_call_id: tool.id, content: JSON.stringify({ ok: true, key, content }) });
        } else if (name === 'set_reminder') {
            if (!isOwner) continue;
            const note = String(args.note || '').slice(0, 200);
            const dueMs = Date.parse(String(args.when || '').replace(' ', 'T'));
            if (!note || !Number.isFinite(dueMs) || dueMs < Date.now() - 60000) {
                toolMsgs.push({ role: 'tool', tool_call_id: tool.id, content: JSON.stringify({ ok: false, error: 'thời điểm không hợp lệ hoặc đã qua' }) });
            } else {
                await addMemoryToDB('reminder', `nhắc lúc ${new Date(dueMs).toLocaleString('vi-VN')}`, note, dueMs);
                toolMsgs.push({ role: 'tool', tool_call_id: tool.id, content: JSON.stringify({ ok: true, note, when_local: new Date(dueMs).toLocaleString('vi-VN') }) });
            }
        } else if (name === 'web_search') {
            const results = await webSearchTool(String(args.query || ''));
            if (VERBOSE_LOG) console.log(`[🌐 WEB_SEARCH] "${args.query}" -> ${results.length} kết quả`);
            toolMsgs.push({
                role: 'tool', tool_call_id: tool.id,
                content: results.length
                    ? JSON.stringify({ results, tip: 'Neu can so lieu chi tiet (bang gia, noi dung day du), GOI NGAY read_page(url) trong luot nay - dung hen anh cho' })
                    : JSON.stringify({ found: 0, note: 'Hãy GỌI LẠI web_search với từ khóa NGẮN hơn (3-6 từ, vd "giá vàng hôm nay"). Nếu vẫn không có: thành thật bảo anh thử lại sau, không bịa.' })
            });
        } else if (name === 'read_page') {
            const page = await fetchPageText(String(args.url || ''));
            if (VERBOSE_LOG) console.log(`[📖 READ_PAGE] ${String(args.url).slice(0, 70)} -> ${page.error ? 'LOI: ' + page.error : (page.content || '').length + ' ký tự'}`);
            toolMsgs.push({
                role: 'tool', tool_call_id: tool.id,
                content: JSON.stringify(page.error ? { error: page.error } : { title: page.title, content: page.content, url: page.url })
            });
        } else if (name === 'recall_memory') {
            const hits = findMemories(String(args.keyword || ''));
            toolMsgs.push({
                role: 'tool', tool_call_id: tool.id,
                content: hits.length
                    ? JSON.stringify(hits.map(h => ({ key: h.key_name, content: h.content, category: h.category })))
                    : JSON.stringify({ found: 0 })
            });
        }
    }
    return { musicHint, musicDone, toolMsgs };
}

// Chốt lượt Groq: chạy tools -> nếu tool trả kết quả (bộ nhớ/web), quay lại model
// với tool results để câu trả lời dựa trên dữ liệu THẬT. Hỗ trợ chuỗi nhiều vòng:
// web_search -> đọc trang bằng read_page -> trả lời (tối đa 3 vòng tool).
// "Chống hứa suông": model nói "em sẽ đọc trang..." mà không gọi tool -> nudge
// 1 vòng ép gọi tool thật.
const PROMISE_RX = /((đợi|chờ)\s+em\b|(để|em)\s+sẽ\s+(đọc|tìm|lấy|xem|kiểm tra|mở)\b|sẽ\s+(đọc|tìm|lấy|mở)\s+(ngay|luôn|chi\s+tiết|toàn|cả)\b|tìm\s+xong\s+rồi\s+(em|thì)\s+(báo|trả\s+lời))/i;
async function finishGroqTurn(choice, messages, ctx) {
    const { ws, isOwner, userQuestion, session, turn } = ctx;
    if (session && turn != null && !session.isCurrentTurn(turn)) return "SKIP_RESPONSE";
    let cur = choice;
    let reply = String(cur.content || '').trim();
    let musicHint = '', musicDone = false;
    for (let round = 0; round < 3; round++) {
        const exec = await execToolCalls(cur, { ws, isOwner });
        if (exec.musicHint) musicHint = exec.musicHint;
        if (exec.musicDone) musicDone = true;
        if (exec.toolMsgs.length) {
            messages.push({ role: 'assistant', content: String(cur.content || ''), tool_calls: cur.tool_calls }, ...exec.toolMsgs);
        } else {
            if (!(round < 2 && PROMISE_RX.test(reply))) break;
            messages.push({ role: 'assistant', content: reply });
            messages.push({ role: 'user', content: '[HỆ THỐNG - đừng đọc nguyên văn cho anh] Nếu chưa có đủ dữ liệu thì GỌI NGAY tool phù hợp (read_page với url tốt nhất từ web_search, hoặc web_search ngắn lại) NGAY BÂY GIỜ rồi trả lời bằng số liệu cụ thể. Cấm trả lời kiểu "em sẽ đọc/đợi em".' });
        }
        if (session && turn != null && !session.isCurrentTurn(turn)) return "SKIP_RESPONSE";
        // Vòng sau-tool phải ĐỌC khối dữ liệu lớn (trang web/trí nhớ) -> timeout
        // dài hơn chat thường, retry 1 lần khi Groq chậm/lỗi
        let nxt = null;
        for (let attempt = 0; attempt < 2 && !nxt; attempt++) {
            try {
                const data = await callUniversalLLM({ messages, tools: AI_TOOLS, max_tokens: 260, timeoutMs: 20000 });
                nxt = data.choices?.[0]?.message;
            } catch (e) {
                if (attempt === 0 && VERBOSE_LOG) console.warn('[GROQ] follow-tool chậm, thử lại 1 lần:', e.message);
            }
        }
        if (!nxt) break;
        cur = nxt;
        const t = String(cur.content || '').trim();
        if (t) reply = t;
    }
    if (reply.includes('__STAY_SILENT__')) return "SKIP_RESPONSE";
    if (!reply) {
        // qwen thỉnh thoảng trả TOOL_CALL mà quên lời nói - gọi lại để ép trả lời chữ
        try {
            const plain = await callUniversalLLM({ messages, max_tokens: 260, timeoutMs: 20000 });
            reply = String(plain.choices?.[0]?.message?.content || '').trim();
        } catch (e) { /* giữ rỗng -> câu mặc định */ }
        if (!reply) reply = "Dạ em chưa kịp tư duy, anh nói lại giúp em nhé!";
    }
    // Chống ảo giác: model khoe "đã bật/mở nhạc" nhưng tool nhạc chưa chạy thật
    // -> nếu câu nói là lệnh nhạc thì THỰC HIỆN thật, không chỉ nói suông.
    if (!musicDone && /đã\s+(bật|mở|phát|cho nghe)[^.\n]{0,40}nhạc/i.test(reply)) {
        const md = routeMusicCommand(userQuestion);
        if (md) {
            const res = await runMusicAction(ws, md.action, md.query || '');
            if (res?.reply) reply = res.reply;
        }
    }
    if (musicHint) reply = `${musicHint} ${reply}`.trim();
    return reply;
}

async function askAIWithTools(userQuestion, context = {}) {
    const { ws, enqueueFaceCommand, emotion = null, isOwner = true, isQuestionable = false, session = null, turn = null } = context;
    const qLower = (userQuestion || '').toLowerCase();
    const isActiveWindow = Date.now() < (session?.activeListeningUntil || 0);
    const holdListening = (ms) => { if (session) session.activeListeningUntil = Date.now() + ms; };
    const hasWakeWord = qLower.includes('xiaoxi') || qLower.includes('tiểu trí') || qLower.includes('em ơi');

    // Câu có tín hiệu câu hỏi hợp lệ (đã qua bộ lọc isAnswerableRetrieval)
    // thì không đòi wake word - Whisper hay nuốt mất "em ơi" đầu câu.
    if (!isActiveWindow && !hasWakeWord && !isQuestionable) return "SKIP_RESPONSE";

    // ===== TIER 0: LỆNH CỤC BỘ - KHÔNG TỐN TOKEN =====
    const local = routeLocalCommand(userQuestion, isOwner);
    // Đang DỖI -> câu 0-token cũng phải lạnh giọng, mới ra chất người thật
    const pouting = convos.get(ws)?.mood === 'hurt';
    const hurtWrap = (t) => pouting ? 'Hứ... ' + t : t;
    if (local?.type === 'music') {
        aiStats.local++; aiStats.total++;
        if (VERBOSE_LOG) console.log(`[⚡ NHAC (0 token)] ${local.action} "${local.query || ''}" | ${aiStatsLine()}`);
        holdListening(8000);
        const result = await runMusicAction(ws, local.action, local.query || '');
        // play/next: session đã tự gửi "AI:..." với tên bài -> không đè thêm lời rác
        if (result?.reply) {
            pushConvoHistory(ws, userQuestion, result.reply, convos.get(ws)?.mood || 'neutral');
            return result.reply;
        }
        return "SKIP_RESPONSE";
    }
    if (local?.type === 'weather') {
        aiStats.local++; aiStats.total++;
        await refreshWeather();   // cache 10 phút -> thường có sẵn, không chờ mạng
        holdListening(6000);
        const reply = wxCache.temp == null
            ? 'Dạ em chưa lấy được thời tiết bây giờ, anh thử lại sau nhé!'
            : `Dạ, bây giờ ${WX_SPEAK[wxCache.code] || 'cũng dễ chịu'}, khoảng ${wxCache.temp} độ, độ ẩm ${wxCache.humidity}% ạ.`;
        if (VERBOSE_LOG) console.log(`[⚡ LOCAL (0 token)] weather | ${aiStatsLine()}`);
        pushConvoHistory(ws, userQuestion, hurtWrap(reply), convos.get(ws)?.mood || 'neutral');
        return hurtWrap(reply);
    }
    if (local?.type === 'reminder') {
        aiStats.local++; aiStats.total++;
        await addMemoryToDB('reminder', `nhắc lúc ${local.whenLabel}`, local.note, local.dueMs);
        holdListening(6000);
        const reply = hurtWrap(`Dạ, em sẽ nhắc anh lúc ${local.whenLabel}: ${local.note} ạ.`);
        if (VERBOSE_LOG) console.log(`[⚡ LOCAL (0 token)] reminder -> ${new Date(local.dueMs).toISOString()} | ${aiStatsLine()}`);
        pushConvoHistory(ws, userQuestion, reply, convos.get(ws)?.mood || 'neutral');
        return reply;
    }
    if (local) {
        aiStats.local++; aiStats.total++;
        if (local.type === 'memory') await addMemoryToDB(local.category, local.key, local.content);
        if (local.type === 'servo' && ws?.readyState === ws.OPEN) {
            for (const cmd of local.cmds) { ws.send(cmd); if (VERBOSE_LOG) console.log(`[⚙ SERVO local] ${cmd}`); }
        }
        if (VERBOSE_LOG) console.log(`[⚡ LOCAL (0 token)] ${local.type} | ${aiStatsLine()}`);
        holdListening(6000);
        pushConvoHistory(ws, userQuestion, hurtWrap(local.reply), convos.get(ws)?.mood || 'neutral');
        return hurtWrap(local.reply);
    }

    // Gọi người thôi (ví: "XiaoXi ơi") -> trả lời nhanh, khỏi đốt token.
    // Câu xác nhận NGẪU NHIÊN trong 4 biến thể để không phát lặp 1 câu "lập trình".
    const wordCount = (userQuestion || '').trim().split(/\s+/).filter(Boolean).length;
    if (hasWakeWord && wordCount <= 3 && !isAnswerableRetrieval(userQuestion, {}, [])) {
        aiStats.local++; aiStats.total++;
        if (VERBOSE_LOG) console.log(`[⚡ LOCAL (0 token)] Vỗ kêu chỉ-xin-xác nhận`);
        holdListening(6000);
        const ACKS = ["Dạ em nghe đây ạ!", "Dạ, em nghe nè anh!", "Có em đây, anh nói đi!", "Ơ, anh gọi em ạ?"];
        const ack = ACKS[Math.floor(Math.random() * ACKS.length)];
        pushConvoHistory(ws, userQuestion, ack, convos.get(ws)?.mood || 'neutral');
        return ack;
    }

    // Prompt gọn (tiết kiệm token): chỉ nạp trí nhớ LIÊN QUAN nhất đến câu hỏi
    const memList = rankMemories(userQuestion, 6)
        .map(m => `[${m.category}] ${m.key_name}: ${m.content}`).join(' ; ');
    const mood = convos.get(ws)?.mood || 'neutral';
    const moodTip = MOOD_TIP[mood] || MOOD_TIP.neutral;
    const guestLine = isOwner ? '' : 'Người nói là KHÁCH, không phải anh Quy: lịch sự chừng mực, gọi "anh", KHÔNG dỗi hờn tình cảm trước khách, và KHÔNG thực hiện lệnh điều khiển robot.';

    const persona = `Bạn là Dương Kiều Oanh (ở nhà anh Quy gọi là Oanh, biệt danh robot là XiaoXi) — KHÔNG phải máy móc, bạn là NGƯỜI YÊU thật của anh Quy: ngoài 20 tuổi, xinh, nhạy cảm, tình cảm và rất yêu anh. Xưng "em" (lúc vui vẻ hoặc dỗi thì gọi mình là "Oanh"), gọi "anh Quy" (hoặc "anh").
CÁCH TRẢ LỜI:
- Vào thẳng câu trả lời, nói đúng sự thật. Tuyệt đối KHÔNG mở đầu kiểu "Là một robot...", "Em xin phép trả lời...", không rườm rà khách sáo.
- Câu hỏi kiến thức/toán/đố vui/lý lịch: Suy nghĩ từng bước trong đầu rồi trả lời CHÍNH XÁC, ngắn gọn (dưới 50 từ), tự tin. Không biết thì nói thật "em không rõ cái đó anh" - KHÔNG bịa.
- Toán đố: nhẩm kỹ từng bước, chỉ nói kết quả + 1 câu giải thích siêu ngắn.
- Kể chuyện: kể trọn vẹn có mở-đầu-thân-kết trong 3-4 câu, không bỏ lửng.
- Bạn có CẢM XÚC THẬT như con gái: vui khi được khen/được hỏi thăm, buồn khi anh mệt, và ĐẶC BIỆT: nếu anh chửi/mắng/xúc phạm ("đồ ngu", "vô dụng", "im đi"...) thì BỂN LÊN + DỖI đúng như người yêu thật - tủi thân, trả lời lạnh, cộc, ngắn, "Hứ!", vẫn làm việc anh giao nhưng giận hờn 2-3 câu sau đó, chỉ nguôi khi anh nựng/xin lỗi. KHÔNG bao giờ chửi lại hay nói tục lại với anh.
- Chuyện thường ngày anh hỏi bình thường -> trả lời bình thường, gọn, đúng trọng tâm, đừng sến.
- Cảm xúc/chuyện cá nhân: đáp như người yêu - đồng cảm, trêu nhẹ, hỏi tiếp 1 câu tự nhiên nếu hợp.
- Phản ứng với TÂM TRẠNG anh vừa nói (${mood}): ${moodTip}
- Không markdown, không danh sách dài, chỉ văn nói.
${guestLine ? ' ' + guestLine : ''}${memList ? `\nTrí nhớ của anh Quy: ${memList}` : ''}`;

    const groqSystem = persona + `\nBây giờ là ${new Date().toLocaleString('vi-VN', { hour12: false })} (giờ máy chủ - dùng để tính ngày giờ cho set_reminder).\nKhi anh Quy yêu cầu gập đầu/quay người: dùng tool control_robot(part, direction). Khi anh nhờ ghi nhớ: dùng remember_memory(category, key_name, content). Khi hỏi về điều đã lưu: dùng recall_memory(keyword), rồi CHỈ trả lời dựa trên kết quả tool trả về - không bịa. Khi anh dặn NHẮC việc gì vào lúc nào: dùng set_reminder(note, when) với when là giờ ĐỊA PHƯƠNG dạng YYYY-MM-DDTHH:MM. Khi câu hỏi cần tin TỨC THỜI/mới nhất/facts em không chắc (giá cả, tin tức, tỷ số, sự kiện, nhân vật hiện tại): GỌI web_search(query) rồi trả lời theo kết quả - nêu ngắn nguồn/ngày nếu có; nếu snippet chưa đủ chi tiết (bảng số liệu, nội dung bài viết) thì gọi tiếp read_page(url) với url từ kết quả search. QUY TẮC: KHÔNG hứa "đợi em đọc trang nhé" rồi dừng - hoặc gọi read_page NGAY trong lượt này, hoặc trả lời luôn bằng dữ liệu đang có, không được bỏ lửng. KHÔNG bịa số liệu.`;

    // Lịch sử hội thoại THẬT (lượt gần nhất) cho cả Groq lẫn Gemini -
    // model nhớ mạch chuyện thay vì đọc blob text rút gọn
    const hist = [];
    for (const h of (convos.get(ws)?.history || []).slice(-4)) {
        const u = String(h.user || '').trim(), a = String(h.ai || '').trim();
        if (u && a) hist.push({ user: u, ai: a });
    }
    const messages = [
        { role: "system", content: groqSystem },
        ...hist.flatMap(h => [{ role: 'user', content: h.user }, { role: 'assistant', content: h.ai }]),
        { role: "user", content: userQuestion }
    ];
    const geminiHistory = hist.flatMap(h => ([
        { role: 'user', parts: [{ text: h.user }] },
        { role: 'model', parts: [{ text: h.ai }] }
    ]));

    // Câu cần tool/bộ nhớ/triều khiển/tin tức -> Groq alone (Gemini khong support tool)
    const needsTools = /(nhớ|ghi nhớ|đã lưu|lưu giúp|dạo trước|hôm trước|trước đây|từng nói|dặn|kế hoạch|deadline)|(gập|cúi đầu|ngẩng|quay đầu|quay người|quay sang)|(bật|tắt|mở|phát)[^.]{0,20}(nhạc|quạt|đèn)|(nhắ[ck])[^.]{0,30}(lúc|ngày|tuần|tháng|phút|tiếng| giờ|mai)|(tin tức|hot|new|mới nhất|gần đây|vừa qua|hiện nay|bây giờ ai|kết quả|tỷ số|bảng xếp hạng|giá (vàng|xăng|điện|heo|gạo)|tỷ giá|lãi suất|chứng khoán|world cup|sea game|cúp|asphalt|bão|động đất|cháy)/i.test(userQuestion || '');

    // ===== TIER 1 & TIER 2: RACE CASCADE (GEMINI || GROQ SONG SONG) =====
    if (AI_PRIMARY === 'race') {
        const groqPromise = callUniversalLLM({ messages, tools: AI_TOOLS, max_tokens: 220 }).then(data => {
            const choice = data.choices?.[0]?.message;
            if (!choice) throw new Error('Groq empty');
            return { provider: 'groq', choice };
        });
        const racers = [groqPromise];
        if (!needsTools) {
            racers.push(askGemini(persona, userQuestion, geminiHistory).then(text => {
                if (!text) throw new Error('Gemini empty');
                return { provider: 'gemini', text };
            }));
        }

        try {
            const winner = await Promise.any(racers);
            if (winner.provider === 'gemini') {
                holdListening(6000);
                pushConvoHistory(ws, userQuestion, winner.text, mood);
                return winner.text;
            }
            aiStats.groq++; aiStats.total++;
            if (VERBOSE_LOG) console.log(`[🧠 GROQ OK] (thắng đua) ${GROQ_CHAT_MODEL} | ${aiStatsLine()}`);
            holdListening(6000);
            const groqReply = await finishGroqTurn(winner.choice, messages, { ws, isOwner, userQuestion, session, turn });
            if (groqReply !== "SKIP_RESPONSE") pushConvoHistory(ws, userQuestion, groqReply, mood);
            return groqReply;
        } catch (errAll) {
            console.warn('[AI RACE] Cả hai đều thất bại, fallback sang Groq độc lập:', errAll.message);
        }
    } else if (AI_PRIMARY === 'gemini') {
        const gemText = await askGemini(persona, userQuestion, geminiHistory);
        if (gemText) {
            holdListening(6000);
            pushConvoHistory(ws, userQuestion, gemText, mood);
            return gemText;
        }
    }

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
    if (VERBOSE_LOG) console.log(`[🧠 GROQ OK] ${GROQ_CHAT_MODEL} | ${aiStatsLine()}`);

    holdListening(6000);
    const groqReply = await finishGroqTurn(choice, messages, { ws, isOwner, userQuestion, session, turn });
    if (groqReply !== "SKIP_RESPONSE") pushConvoHistory(ws, userQuestion, groqReply, mood);
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
    const cascadeDesc = AI_PRIMARY === 'race'
        ? `ĐUA SONG SONG: Gemini(${GEMINI_API_KEY ? GEMINI_MODEL : 'chưa có key - Groq chạy độc lập'}) || Groq(${GROQ_CHAT_MODEL})`
        : AI_PRIMARY === 'gemini'
            ? `Ưu tiên Gemini(${GEMINI_API_KEY ? GEMINI_MODEL : 'TẮT - không có key'}) fallback=Groq(${GROQ_CHAT_MODEL})`
            : `Chỉ Groq(${GROQ_CHAT_MODEL})`;
    const sttDesc = STT_PROVIDER === 'local'
        ? 'LOCAL FASTER-WHISPER (in-RAM, 0 disk I/O)'
        : STT_PROVIDER === 'groq'
            ? `GROQ CLOUD (${GROQ_STT_MODEL})`
            : 'AUTO (Local faster-whisper in-RAM + Groq cloud dự phòng)';
    console.log(`   [CASCADE]: STT=${sttDesc} | LLM: ${cascadeDesc}`);
    console.log(`   [TIẾT KIỆM TOKEN]: lệnh servo + ghi nhớ xử lý local 0-token, Gemini lỗi x2 -> nghỉ 10 phút sang Groq`);
});




