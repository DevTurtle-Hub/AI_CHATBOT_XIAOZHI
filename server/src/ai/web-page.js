'use strict';
// Đọc toàn văn 1 trang web cho tool `read_page` (não AI cần chi tiết sâu hơn snippet).
// Có chốt SSRF: không cho model kéo trang trong mạng nội bộ/localhost của anh Quy.

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|::1|\[::1\]|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;

function isPrivateHost(hostname) {
    if (!hostname) return true;
    return PRIVATE_HOST.test(hostname);
}

// Bảng named entity tiếng Việt + ký tự thông dụng (sinh bằng dấu kết hợp + NFC)
const NAMED_ENT = (() => {
    const tone = { acute: '́', grave: '̀', hookabove: '̉', tilde: '̃', dotbelow: '̣' };
    const m = {
        amp: '&', quot: '"', apos: "'", nbsp: ' ', lt: '<', gt: '>',
        ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’',
        ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™',
        deg: '°', euro: '€', middot: '·', laquo: '«', raquo: '»',
        dstroke: 'đ', Dstroke: 'Đ'
    };
    for (const base of ['a', 'e', 'i', 'o', 'u', 'y']) {
        for (const [tn, tc] of Object.entries(tone)) {
            const lower = (base + tc).normalize('NFC');
            m[base + tn] = lower;
            m[base.toUpperCase() + tn] = lower.toUpperCase();
            if (base === 'a' || base === 'e' || base === 'o') {
                const cb = (base + '̂').normalize('NFC');
                m[base + 'circ'] = cb;
                m[base.toUpperCase() + 'circ'] = cb.toUpperCase();
                if (base === 'a') for (const [tn2, tc2] of Object.entries(tone)) {
                    const combo = (base + '̂' + tc2).normalize('NFC');
                    m[base + 'circ' + tn2] = combo;
                    m[base.toUpperCase() + 'circ' + tn2] = combo.toUpperCase();
                }
            }
            if (base === 'o' || base === 'u') {
                const hb = (base + '̛').normalize('NFC');
                m[base + 'horn'] = hb;
                m[base.toUpperCase() + 'horn'] = hb.toUpperCase();
                for (const [tn2, tc2] of Object.entries(tone)) {
                    const combo = (base + '̛' + tc2).normalize('NFC');
                    m[base + 'horn' + tn2] = combo;
                    m[base.toUpperCase() + 'horn' + tn2] = combo.toUpperCase();
                }
            }
            if (base === 'a') {
                const bb = (base + '̆').normalize('NFC');
                m.abreve = bb; m.Abreve = bb.toUpperCase();
                for (const [tn2, tc2] of Object.entries(tone)) {
                    const combo = (base + '̆' + tc2).normalize('NFC');
                    m['abreve' + tn2] = combo;
                    m['Abreve' + tn2] = combo.toUpperCase();
                }
            }
        }
    }
    return m;
})();

function decodeEntities(s) {
    return String(s)
        .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch (e) { return ' '; } })
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return ' '; } })
        .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (whole, name) => (NAMED_ENT[name] !== undefined ? NAMED_ENT[name] : whole));
}

// HTML -> text sạch: bỏ script/style/svg/comment, gán khoảng trắng cho tag khối
function htmlToText(html, maxChars = 4000) {
    let s = String(html || '');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style|noscript|svg|template|iframe|form)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<\/(p|div|li|br|h[1-6]|tr|section|article)>/gi, '\n')
        .replace(/<(br)\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
    s = decodeEntities(s)
        .replace(/[ \t\u00a0]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{2,}/g, '\n')
        .trim();
    // Mở đầu trang toàn menu/râu thừa -> nhảy tới nội dung có độ dài hợp lý
    const paras = s.split('\n').filter(p => p.trim().length >= 25);
    const body = paras.join('\n');
    return (body || s).slice(0, maxChars);
}

async function fetchPageText(url, maxChars = 4000) {
    let u;
    try { u = new URL(String(url)); } catch (e) { return { error: 'url không hợp lệ' }; }
    if (!/^https?:$/.test(u.protocol)) return { error: 'chỉ hỗ trợ http/https' };
    if (isPrivateHost(u.hostname)) return { error: 'bị chặn: url thuộc mạng nội bộ' };
    try {
        const res = await fetch(String(url), {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            redirect: 'follow',
            signal: AbortSignal.timeout(9000)
        });
        if (res.url && isPrivateHost(new URL(res.url).hostname)) return { error: 'bị chặn: redirect vào mạng nội bộ' };
        if (!res.ok) return { error: 'HTTP ' + res.status };
        const ct = res.headers.get('content-type') || '';
        if (!/text\/html|application\/xhtml|text\/plain/i.test(ct)) return { error: 'trang không phải nội dung text (' + ct.split(';')[0] + ')' };
        const html = await res.text();
        const title = decodeEntities((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]).trim().slice(0, 160);
        const text = htmlToText(html, maxChars);
        if (text.length < 40) return { error: 'trang gần như trống (nội dung render bằng JS)' };
        return { title, content: text, url: res.url };
    } catch (e) {
        return { error: 'không đọc được trang: ' + e.message };
    }
}

module.exports = { isPrivateHost, htmlToText, fetchPageText };
