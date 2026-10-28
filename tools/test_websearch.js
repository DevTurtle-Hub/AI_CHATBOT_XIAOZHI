// Test nhanh: Groq built-in web_search có hoạt động với key hiện tại không
const path = require('path');
try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile(path.resolve(__dirname, '../.env')); } catch (e) {}
const axios = require('axios');

const KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';

async function tryCall(label, body) {
    try {
        const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
            { model: MODEL, ...body, max_tokens: 300, temperature: 0.4 },
            { headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, timeout: 25000 });
        const m = r.data.choices?.[0]?.message;
        console.log(`\n[${label}] OK ${Date.now()} | usage:`, JSON.stringify(r.data.usage || {}));
        console.log('  content:', String(m?.content || '').slice(0, 400));
        if (m?.tool_calls) console.log('  tool_calls:', JSON.stringify(m.tool_calls).slice(0, 200));
        return r.data;
    } catch (e) {
        console.log(`\n[${label}] FAIL:`, e.response?.status, JSON.stringify(e.response?.data?.error || e.message).slice(0, 300));
        return null;
    }
}

(async () => {
    // Nguồn 1: DuckDuckGo Lite (không cần key)
    try {
        const r = await fetch('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent('giá vàng hôm nay'), {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            signal: AbortSignal.timeout(8000)
        });
        const html = await r.text();
        const links = [...html.matchAll(/class=['"]result-link['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/g)].slice(0, 5);
        const snips = [...html.matchAll(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g)].slice(0, 5);
        console.log(`[DDG lite] status ${r.status}, ${links.length} link, ${snips.length} snippet`);
        links.forEach((l, i) => console.log('  -', l[2].replace(/<[^>]+>/g, '').trim().slice(0, 80), '|', (snips[i]?.[1] || '').replace(/<[^>]+>/g, '').trim().slice(0, 100)));
    } catch (e) { console.log('[DDG lite] FAIL:', e.message); }

    // Nguồn 2: Google News RSS tiếng Việt (không cần key)
    try {
        const r = await fetch('https://news.google.com/rss/search?q=' + encodeURIComponent('Việt Nam bóng đá') + '&hl=vi&gl=VN&ceid=VN:vi', {
            headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000)
        });
        const xml = await r.text();
        const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 4);
        console.log(`\n[Google News] status ${r.status}, ${items.length} item`);
        for (const it of items) {
            const title = (it[1].match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1];
            const date = (it[1].match(/<pubDate>([^<]+)<\/pubDate>/) || [])[1];
            console.log('  -', String(title).replace(/&amp;/g, '&').trim().slice(0, 90), '|', date);
        }
    } catch (e) { console.log('[Google News] FAIL:', e.message); }
})();

