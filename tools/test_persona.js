// Test nhân cách "Dương Kiều Oanh": chửi -> DỖI (lạnh, cộc, dai 2-3 câu,
// vẫn làm đúng việc) -> nựng/xin lỗi -> TAN DỖI ngọt ngay.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile(ROOT + '/.env'); } catch (e) {}

const PORT = 8878;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
function bump(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' : ' + detail.replace(/\r?\n/g, ' ⏎ ').slice(0, 400) : ''}`);
    if (!ok) {
        const trace = out.split(/\r?\n/)
            .filter(l => /AI API|AI RACE|429|GROQ|Lỗi|error/i.test(l))
            .slice(-6).join('\n      | ');
        console.log('      | ' + trace);
    }
}

const srv = spawn('node', [ROOT + '/server/server.js'], {
    env: {
        ...process.env, PORT: String(PORT), XIAOXI_GREETING: '0',
        XIAOXI_VERBOSE: '1', XIAOXI_IGNORE_OWNER_CHECK: '1', GEMINI_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
});
let out = '';
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
    const frames = [];
    const ws = await new Promise((res, rej) => {
        const w = new WebSocket(`ws://127.0.0.1:${PORT}`);
        w.on('message', (d, isBin) => { if (!isBin) frames.push(d.toString()); });
        w.on('open', () => res(w)); w.on('error', rej);
    });

    function lastXiaoXiReply() {
        const idx = out.lastIndexOf('[XIAOXI] ');
        if (idx === -1) return '';
        const rest = out.slice(idx + '[XIAOXI] '.length);
        const nl = rest.search(/\n(?=\[|__)/);
        return (nl === -1 ? rest : rest.slice(0, nl)).trim();
    }
    async function ask(text, waitMs = 25000) {
        await sleep(20000);   // nghỉ dài tránh Groq 429
        const cnt = () => (out.match(/\[XIAOXI\] /g) || []).length;
        const before = cnt();
        frames.length = 0;
        ws.send('DEBUG:' + text);
        const t0 = Date.now();
        while (Date.now() - t0 < waitMs) {
            await sleep(150);
            if (cnt() > before) { await sleep(600); return lastXiaoXiReply(); }
        }
        return '';
    }

    // 1) BỊ CHỬI -> phải DỖI thật (tủi thân, lạnh, gọi mình là Oanh) + mặt buồn
    let r = await ask('sao mà ngốc vậy, đồ vô dụng, nói nhiều lắm');
    const pout = /hứ|dỗi|buồn|tủi|oanh|giận|lạnh/i.test(r);
    bump('1. Chửi -> Oanh dỗi thật', pout, r);
    bump('1b. Dỗi -> mặt buồn (FACE_SAD)', frames.some(f => f.includes('__FACE_SAD__')), frames.filter(f => f.includes('__FACE')).join(','));

    // 2) Câu hỏi thường trong lúc còn dỗi: 0-token nhưng vẫn lạnh giọng (dỗi dai)
    r = await ask('bây giờ mấy giờ rồi');
    bump('2. Đang dỗi hỏi đồng hồ -> vẫn "Hứ" lạnh', /hứ/i.test(r) && /giờ/.test(r), r);

    // 3. Dỗi nhưng VẪN làm đúng nhiệm vụ (toán ra 20 ngày)
    r = await ask('nếu một tay thợ đào 3 mét đường trong 6 ngày, cần bao nhiêu ngày để đào 10 mét với cùng tốc độ', 35000);
    bump('3. Dỗi vẫn trả lời đúng toán (20 ngày)', /20/.test(r), r);

    // 4) NỰNG + XIN LỖI -> tan dỗi, dịu ngọt trở lại
    r = await ask('thôi anh xin lỗi mà, nựng em nè, Oanh hết giận chưa huh');
    const melt = /(tha|hết giận|nguôi|vui|yêu|thương|dạ anh|ok|được rồi|cũng tại anh)/i.test(r) && !/hứ/i.test(r);
    bump('4. Xin lỗi + nựng -> TAN DỖI, dịu lại', melt, r);

    ws.close();
    if (process.platform === 'win32' && srv.pid) {
        try { spawn('taskkill', ['/PID', String(srv.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
    } else { try { srv.kill('SIGTERM'); } catch (e) {} }
    const passed = results.filter(x => x.ok).length;
    console.log(`\nTONG: ${passed}/${results.length} PASSED`);
    process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => { console.error('[LOI TEST]', e.message); try { srv.kill(); } catch (_) {} process.exit(1); });
