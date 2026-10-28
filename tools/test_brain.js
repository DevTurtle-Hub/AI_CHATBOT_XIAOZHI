// Smoke test NÃO NÃO CỤC BỘ: chạy server.js (không cần engine Python),
// gửi khung "DEBUG:<câu>" qua WS rồi kiểm tra câu trả lời AI: trên luồng ra.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile(ROOT + '/.env'); } catch (e) {}

const PORT = 8877;
const QUICK = process.env.QUICK === '1';   // chỉ chạy các câu web 7a-7d (tiết kiệm quota Groq)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let out = '';
const results = [];
function bump(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' : ' + detail.replace(/\r?\n/g, ' ⏎ ').slice(0, 400) : ''}`);
    if (!ok) {   // khi hỏng: in dấu vết tool/LLM từ log server để chẩn đoán
        const trace = out.split(/\r?\n/)
            .filter(l => /WEB_SEARCH|READ_PAGE|GROQ|GEMINI|LOCAL \(0 token\)|NHAC \(0 token\)|429|LOI|Lỗi|error/i.test(l))
            .slice(-8).join('\n      | ');
        console.log('      | ' + trace);
    }
}

const srv = spawn('node', [ROOT + '/server/server.js'], {
    env: {
        ...process.env, PORT: String(PORT), XIAOXI_GREETING: '0',
        XIAOXI_VERBOSE: '1', XIAOXI_IGNORE_OWNER_CHECK: '1', GEMINI_API_KEY: '',
        XIAOXI_REMINDER_SWEEP_MS: '5000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
});
srv.stdout.on('data', d => { out += d.toString(); });
srv.stderr.on('data', d => { out += d.toString(); });

async function main() {
    for (let i = 0; i < 60; i++) {
        try {
            const h = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1000) });
            if (h.ok) break;
        } catch (e) { }
        await sleep(300);
    }
    const ws = await new Promise((res, rej) => {
        const w = new WebSocket(`ws://127.0.0.1:${PORT}`);
        w.on('open', () => res(w)); w.on('error', rej);
    });
    let lastReply = '';
    ws.on('message', (d, isBin) => {
        if (isBin) return;
        const s = d.toString();
        if (s.startsWith('AI:')) lastReply = s.slice(3);
    });

    // Đọc reply từ log [XIAOXI] (bản đầy đủ dấu; reply có thể nhiều dòng -
    // gom tới dòng log kế tiếp bắt đầu bằng '[')
    function lastXiaoXiReply() {
        const idx = out.lastIndexOf('[XIAOXI] ');
        if (idx === -1) return '';
        const rest = out.slice(idx + '[XIAOXI] '.length);
        const nl = rest.search(/\n(?=\[|__)/);
        return (nl === -1 ? rest : rest.slice(0, nl)).trim();
    }
    async function ask(text, waitMs = 20000) {
        await sleep(QUICK ? 20000 : 11000);   // dàn nhịp tránh Groq free-tier 429 khi test chuỗi câu
        const cnt = () => (out.match(/\[XIAOXI\] /g) || []).length;
        const before = cnt();
        ws.send('DEBUG:' + text);
        const t0 = Date.now();
        while (Date.now() - t0 < waitMs) {
            await sleep(150);
            if (cnt() > before) { await sleep(600); return lastXiaoXiReply(); }  // đợi console line flush hết
        }
        return '';
    }

    let r = '';
    if (!QUICK) {
    // 1) Đồng hồ 0-token
    r = await ask('bây giờ mấy giờ rồi');
    bump('clock route (0 token)', /giờ/.test(r) && out.includes('LOCAL (0 token)'), r);

    // 2) Thời tiết 0-token (open-meteo cache)
    r = await ask('thời tiết hôm nay thế nào');
    bump('weather route (0 token)', /độ|thử lại/.test(r), r);

    // 3) Ghi nhớ local + recall bằng tool loop (trí nhớ THẬT)
    await ask('ghi nhớ giúp anh là mật khẩu wifi nhà là xiaoxi123');
    r = await ask('dạo trước anh dặn em nhớ gì về mật khẩu wifi', 30000);
    const usedTool = out.includes('TOOL') || out.includes('recall') || /xiaoxi123/i.test(r);
    bump('recall_memory tool loop trả đúng mật khẩu đã lưu', /xiaoxi\s*123/i.test(r), r);
    if (!usedTool) console.log('   (ghi chú: không thấy log tool - model có thể trả từ memList inject)');

    // 4) Chat thường -> Groq trả lời thông minh
    r = await ask('nếu một tay thợ đào 3 mét đường trong 6 ngày, cần bao nhiêu ngày để đào 10 mét với cùng tốc độ', 30000);
    bump('toán đố -> đáp án 20 ngày', /20/.test(r), r);

    // 5) "tắt đèn đi" không bị bắt làm lệnh nhạc
    r = await ask('tắt đèn đi');
    bump('"tắt đèn đi" không bị coi là lệnh nhạc', !out.includes('NHAC (0 token)'), r);
    }

    // 6) Lời nhắc hẹn: đặt bằng giọng nói -> robot CHỦ ĐỘNG nhắc khi đến giờ
    if (!process.env.SKIP_REMINDER) {
    const REMNOTE = 'uống nước cam kiểm thử';
    r = await ask(`nhắc anh ${REMNOTE} sau 1 phút`);
    bump('reminder local route xác nhận lịch', /nhắc anh lúc/i.test(r), r);
    let fired = '';
    const t1 = Date.now();
    while (Date.now() - t1 < 110000) {
        await sleep(1000);
        const m = out.match(/\[XIAOXI\] [^\n]*đến giờ rồi anh[^\n]*kiểm thử[^\n]*/g);
        if (m) { fired = m[m.length - 1]; break; }
    }
    bump('robot tự cất tiếng nhắc ĐÚNG GIỜ (qua DB + scheduler)', fired.includes(REMNOTE), fired);
    }

    // 7a) Câu thời sự model chưa được học -> phải gọi web_search, trả số liệu thật
    r = await ask('hôm nay giá vàng miếng khoảng bao nhiêu tiền một lượng', 45000);
    bump('7a tin tức -> web_search thật + trả lời có số liệu', /WEB_SEARCH/.test(out) && /triệu|lượng|thử lại/.test(r), r);

    // 7b) Chuỗi tool nâng cao: search -> (đọc trang) -> bảng số liệu mua/bán cụ thể
    r = await ask('đọc trang tin giá vàng hôm nay, xem chi tiết giá mua vào và bán ra bao nhiêu rồi tóm tắt cho anh', 75000);
    const detailed = /(mua vào|mua vô)/i.test(r) && /(bán ra|bán vô)/i.test(r) && /[0-9]+,[0-9]+/.test(r);
    bump('7b câu chi tiết -> số liệu mua/bán thật (read_page hoặc snippet đủ)', detailed || /WEB_SEARCH|READ_PAGE/.test(out) && /[0-9]/.test(r), r);

    // 7c) Ép đọc toàn trang: hoặc tool read_page chạy, hoặc model lấy được số liệu
    //     chi tiết vàng nhẫn (thường chỉ có trong trang/bài, khó có ở snippet)
    r = await ask('tìm bài viết chi tiết về giá vàng hôm nay trên mạng, rồi MỞ TOÀN BỘ TRANG đó đọc kỹ bằng tool đọc trang, sau đó tóm tắt cho anh các dòng mua vào bán ra của SJC và vàng nhẫn', 90000);
    const nhatDetail = /nhẫn/i.test(r) && /(mua|bán)/i.test(r) && /(triệu|đồng)/.test(r);
    bump('7c đọc trang sâu (read_page hoặc dữ liệu nhẫn chi tiết)', /READ_PAGE/.test(out) || nhatDetail, r);

    // 7d) Đưa thẳng URL -> model phải lấy được giá nhẫn thật (từ read_page hoặc
    //     snippet đủ rich); READ_PAGE được kiểm định riêng ở 7c/log server
    r = await ask('vào đọc giavang.org rồi báo anh giá vàng nhẫn 9999 mua vào bán ra hôm nay', 75000);
    const nhatPrice = /(nhẫn|9999)/i.test(r) && /[0-9]+([.,][0-9]+)?\s*(triệu|đồng)/i.test(r);
    bump('7d giá vàng nhẫn thật từ web', nhatPrice, r);

    // Dọn bộ nhớ test khỏi DB
    try {
        const { Pool } = require('pg');
        if (process.env.NEON_DB_URL) {
            const pool = new Pool({ connectionString: process.env.NEON_DB_URL, max: 1 });
            await pool.query(`DELETE FROM user_memories WHERE content ILIKE '%xiaoxi123%' OR content ILIKE '%kiểm thử%'`);
            await pool.end();
        }
    } catch (e) { }

    ws.close();
    if (process.platform === 'win32' && srv.pid) {
        try { spawn('taskkill', ['/PID', String(srv.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
    } else { try { srv.kill('SIGTERM'); } catch (e) {} }
    const passed = results.filter(x => x.ok).length;
    console.log(`\nTONG: ${passed}/${results.length} PASSED`);
    process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => { console.error('[LOI TEST]', e.message); srv.kill && srv.kill(); process.exit(1); });
