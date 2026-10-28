// =========================================================================
// TEST API KEYS (Groq LLM/STT + Gemini Audio-Native + Neon DB)
// Chạy: node test_ai_keys.js
// =========================================================================
const axios = require('axios');

try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile(); } catch (e) {}

const GROQ_API_KEY  = process.env.GROQ_API_KEY  || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const NEON_DB_URL   = process.env.NEON_DB_URL || "";

const MASK = (k) => !k ? "(chưa đặt)" : k.slice(0, 8) + "..." + k.slice(-4) + ` (${k.length} ký tự)`;

let pass = 0, fail = 0;
const log = (ok, name, msg) => {
    console.log(`  ${ok ? "✅" : "❌"} ${name}${msg ? " — " + msg : ""}`);
    ok ? pass++ : fail++;
};

async function testGroq() {
    console.log("\n========== 1. GROQ_API_KEY ==========");
    console.log(`Key: ${MASK(GROQ_API_KEY)}`);
    if (!GROQ_API_KEY) return log(false, "Groq", "Key rỗng trong .env");

    const headers = { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" };

    // 1a. Quyền truy cập (GET /models)
    let models = [];
    try {
        const t0 = Date.now();
        const r = await axios.get("https://api.groq.com/openai/v1/models", { headers, timeout: 15000 });
        models = (r.data.data || []).map(m => m.id);
        console.log(`  Danh sách model khả dụng (${models.length}):`);
        models.filter(m => !/guard|sd3/.test(m)).forEach(m => console.log(`    · ${m}`));
        log(true, "Groq auth", `GET /models 200 OK trong ${Date.now() - t0}ms`);
    } catch (e) {
        const code = e.response?.status;
        const body = e.response?.data?.error?.message || e.message;
        return log(false, "Groq auth", `HTTP ${code}: ${body}`);
    }

    // 1b. Chat completion + tool-calling (model)["qwen/qwen3.8-27b"]
    const candidates = ["qwen/qwen3.8-27b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"];
    let workingModel = null;
    for (const model of candidates) {
        if (!models.includes(model)) continue;
        try {
            const t0 = Date.now();
            const r = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                model, temperature: 0.6, max_tokens: 60,
                messages: [
                    { role: "system", content: "Bạn là XiaoXi, robot của anh Quy. Trả lời ngắn 1 câu, xưng 'em'." },
                    { role: "user", content: "Xin chào XiaoXi, bạn là ai?" }
                ],
                tools: [{
                    type: "function",
                    function: {
                        name: "control_robot", description: "Điều khiển servo đầu/chân",
                        parameters: { type: "object", properties: { part: { type: "string" }, direction: { type: "string" } }, required: ["part", "direction"] }
                    }
                }]
            }, { headers, timeout: 20000 });
            const c = r.data.choices[0].message;
            const ms = Date.now() - t0;
            console.log(`     · Model "${model}": reply="${(c.content || "").trim().slice(0, 60)}" | tool_calls=${!!c.tool_calls} | ${ms}ms`);
            if (!workingModel) workingModel = model;
            log(true, `Groq chat [${model}]`, "OK");
        } catch (e) {
            const body = e.response?.data?.error?.message || e.message;
            log(false, `Groq chat [${model}]`, `HTTP ${e.response?.status}: ${String(body).slice(0, 120)}`);
        }
    }

    // 1c. Whisper STT (tạo WAV 1s im lặng + 1kHz beep để test quyền STT)
    try {
        const sr = 16000, n = sr; // 1 giây
        const pcm = Buffer.alloc(n * 2);
        for (let i = 0; i < n; i++) {
            const env = i < n * 0.1 ? i / (n * 0.1) : (i > n * 0.9 ? (n - i) / (n * 0.1) : 1);
            pcm.writeInt16LE(Math.round(9000 * env * Math.sin(2 * Math.PI * 440 * i / sr)), i * 2);
        }
        const h = Buffer.alloc(44);
        h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
        h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
        h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28);
        h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
        const wav = Buffer.concat([h, pcm]);

        const FormData = require('form-data');
        const form = new FormData();
        form.append("file", wav, { filename: "t1.wav", contentType: "audio/wav" });
        form.append("model", "whisper-large-v3-turbo");
        form.append("language", "vi");
        const t0 = Date.now();
        const r = await axios.post("https://api.groq.com/openai/v1/audio/transcriptions", form, {
            headers: { ...form.getHeaders(), Authorization: `Bearer ${GROQ_API_KEY}` }, timeout: 20000
        });
        log(true, "Groq Whisper STT", `transcribe OK "(text='${(r.data.text || "").trim().slice(0, 50)}' hoạc beep không chữ)" trong ${Date.now() - t0}ms`);
    } catch (e) {
        const body = e.response?.data?.error?.message || e.message;
        log(false, "Groq Whisper STT", `HTTP ${e.response?.status}: ${String(body).slice(0, 120)}`);
    }

    console.log(workingModel ? `  👉 Model ổn định sẽ dùng trong server.js: "${workingModel}"` : "  👉 Không có model chat nào hoạt động!");
}

async function testGemini() {
    console.log("\n========== 2. GEMINI_API_KEY ==========");
    console.log(`Key: ${MASK(GEMINI_API_KEY)}`);
    if (!GEMINI_API_KEY) return log(false, "Gemini", "Key rỗng trong .env");

    const isOAuthStyle = GEMINI_API_KEY.startsWith("AQ.");
    console.log(`  Định dạng key: ${isOAuthStyle ? "OAuth/token-style (bắt đầu 'AQ.') - auth bằng header x-goog-api-key" : "API key thường (AIza...)"}`);
    console.log("  (Đã xác minh: GET kèm body null sẽ bị Google từ chối 400 - là lỗi cách gửi, không phải key)");

    const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
    let anyOK = false, bestModel = "";

    // 2a. GET /models (axios.get - KHÔNG kèm data)
    try {
        const t0 = Date.now();
        const r = await axios.get(`${GEMINI_BASE}/models`, {
            headers: { "x-goog-api-key": GEMINI_API_KEY }, timeout: 20000
        });
        const all = (r.data.models || []).map(m => String(m.name).replace("models/", ""));
        console.log(`     · Danh sách ${all.length} models, flash: ${all.filter(m => /flash/.test(m)).slice(0, 6).join(", ")}...`);
        log(true, "Gemini auth", `GET /models 200 OK (${Date.now() - t0}ms)`);
        anyOK = true;
    } catch (e) {
        const body = e.response?.data?.error?.message || e.message;
        log(false, "Gemini auth", `HTTP ${e.response?.status}: ${String(body).slice(0, 140)}`);
    }

    // 2b. POST generateContent - thử các model ổn định đã benchmark
    const envModel = process.env.GEMINI_MODEL;
    const candidates = [envModel, "gemini-3-flash-preview", "gemini-3.1-flash-lite"].filter(Boolean);
    for (const model of candidates) {
        try {
            const t0 = Date.now();
            const r = await axios.post(`${GEMINI_BASE}/models/${model}:generateContent`, {
                contents: [{ parts: [{ text: "Trả lời đúng 2 chữ: Xin chào" }] }],
                generationConfig: { maxOutputTokens: 60 }
            }, {
                headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
                timeout: 25000
            });
            const parts = r.data?.candidates?.[0]?.content?.parts || [];
            const txt = parts.map(p => p.text || "").join("").trim();
            const ms = Date.now() - t0;
            console.log(`     · "${model}": reply="${txt.slice(0, 50)}" (${ms}ms)`);
            log(true, `Gemini chat [${model}]`, "OK");
            if (!bestModel) bestModel = model;
            anyOK = true;
        } catch (e) {
            const body = e.response?.data?.error?.message || e.message;
            log(false, `Gemini chat [${model}]`, `HTTP ${e.response?.status}: ${String(body).slice(0, 120)}`);
        }
    }

    if (!anyOK) {
        console.log("  👉 KHUYẾN NGHỊ: Vào https://aistudio.google.com/apikey tạo API key dạng 'AIza...'");
        console.log("     rồi cập nhật GEMINI_API_KEY trong .env");
    } else {
        console.log(`  👉 Gemini hoạt động tốt. Model ổn định nhất hiện tại: "${bestModel}"`);
    }
}

async function testNeon() {
    console.log("\n========== 3. NEON_DB_URL ==========");
    console.log(`URL: ${NEON_DB_URL ? NEON_DB_URL.replace(/:[^:@]+@/, ":****@").slice(0, 70) + "..." : "(chưa đặt)"}`);
    if (!NEON_DB_URL) return log(false, "Neon DB", "URL rỗng trong .env");
    try {
        const { Pool } = require("pg");
        const pool = new Pool({ connectionString: NEON_DB_URL, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: false } });
        const t0 = Date.now();
        const res = await pool.query("SELECT count(*) c FROM user_memories");
        await pool.end();
        log(true, "Neon DB", `Kết nối + bảng hợp lệ (${res.rows[0].c} trí nhớ) trong ${Date.now() - t0}ms`);
    } catch (e) {
        log(false, "Neon DB", e.message.slice(0, 140));
    }
}

(async () => {
    console.log("=====================================================");
    console.log("🔑 KIỂM THỬ TẤT CẢ API KEYS TRONG .env");
    console.log("=====================================================");
    await testGroq();
    await testGemini();
    await testNeon();
    console.log("\n=====================================================");
    console.log(`TỔNG: ${pass} PASSED / ${fail} FAILED`);
    console.log("=====================================================");
})();
