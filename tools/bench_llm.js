// Benchmark chat model cho XiaoXi: độ thông minh + độ trễ + tỉ lệ trả lời rỗng.
// Chạy: node tools/bench_llm.js ["câu hỏi tùy chỉnh"]
const axios = require('axios');
const path = require('path');
try { process.loadEnvFile(path.resolve(__dirname, '..', '.env')); } catch (e) {}

const KEY = process.env.GROQ_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const SYSTEM = `Bạn là XiaoXi, robot-cậu-bạn thân của anh Quy. Xưng "em", gọi "anh Quy". Trả lời ngắn gọn (dưới 50 từ), tự nhiên như nói chuyện, không markdown.`;

const QUESTIONS = [
    "Tại sao trời lại mưa? Giải thích cho trẻ 5 tuổi hiểu.",
    "Anh có 3 quả táo, anh cho em 1 quả, rồi mua thêm gấp đôi số đang có. Hỏi anh giờ có mấy quả?",
    "Con gì có 5 chân mà đi khắp thiên hạ? Đố vui đó.",
    "Hôm nay anh mệt, kể em nghe một câu an ủi thật ngắn và ấm áp.",
    "So sánh nhanh ESP32 với Raspberry Pi Pico bằng 2 câu.",
];

const MODELS = [
    'qwen/qwen3.8-27b',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
];

async function ask(model, q) {
    const t0 = Date.now();
    try {
        const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model,
            messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: q }],
            temperature: 0.5,
            max_tokens: 200,
        }, { headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 });
        const m = res.data.choices?.[0]?.message;
        const text = (m?.content || '').trim();
        return { ms: Date.now() - t0, ok: !!text, text: text || `(RỖNG! reasoning=${(m?.reasoning_content || '').length} ký tự)`, };
    } catch (e) {
        return { ms: Date.now() - t0, ok: false, text: 'LỖI: ' + (e.response?.data?.error?.message || e.message) };
    }
}

async function askGemini(q) {
    const t0 = Date.now();
    try {
        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent`,
            { system_instruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: 'user', parts: [{ text: q }] }] },
            { headers: { 'x-goog-api-key': GEMINI_KEY, 'Content-Type': 'application/json' }, timeout: 20000 });
        const text = (res.data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
        return { ms: Date.now() - t0, ok: !!text, text: text || '(RỖNG)' };
    } catch (e) {
        return { ms: Date.now() - t0, ok: false, text: 'LỖI: HTTP ' + (e.response?.status || '') + ' ' + (e.response?.data?.error?.message || e.message) };
    }
}

(async () => {
    const custom = process.argv[2];
    const qs = custom ? [custom] : QUESTIONS;
    for (const model of MODELS) {
        let okN = 0, totMs = 0;
        console.log(`\n===== ${model} =====`);
        for (const q of qs) {
            const r = await ask(model, q);
            if (r.ok) okN++;
            totMs += r.ms;
            console.log(`  [${r.ms}ms] Q: ${q}`);
            console.log(`        A: ${r.text.slice(0, 220)}`);
        }
        console.log(`  >> OK ${okN}/${qs.length}, trung bình ${Math.round(totMs / qs.length)}ms`);
    }
    console.log(`\n===== gemini-3-flash-preview (key hiện tại) =====`);
    for (const q of qs.slice(0, 2)) {
        const r = await askGemini(q);
        console.log(`  [${r.ms}ms] ${r.text.slice(0, 200)}`);
    }
})();
