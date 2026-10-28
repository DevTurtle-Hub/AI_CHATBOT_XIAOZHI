'use strict';
// Đọc toàn văn 1 trang web cho tool `read_page` (não AI cần chi tiết sâu hơn snippet).
// Có chốt SSRF: không cho model kéo trang trong mạng nội bộ/localhost của anh Quy.

const net = require('net');
const { promises: dnsPromises } = require('dns');

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|::1|\[::1\])/i;

// Kiểm tra IP-level (DNS có thể trỏ tên miền "công khai" về 127.0.0.1 -> phải soi từng địa chỉ)
function isPrivateIp(ip) {
    if (!ip) return true;
    const v6 = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
    if (net.isIPv4(v6)) {
        const o = v6.split('.').map(Number);
        if (o[0] === 0) return true;                            // 0/8 "this network"
        if (o[0] === 10) return true;
        if (o[0] === 127) return true;
        if (o[0] === 169 && o[1] === 254) return true;          // link-local/metadatas
        if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
        if (o[0] === 192 && o[1] === 168) return true;
        if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;  // CGNAT 100.64/10
        if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return true; // benchmarking
        if (o[0] >= 224) return true;                           // multicast/reserved
        return false;
    }
    if (v6 === '::' || v6 === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true;             // fc00::/7 ULA
    if (/^fe[89ab][0-9a-f]:/.test(v6)) return true;             // fe80::/10 link-local
    const mapped = v6.match(/^::ffff:(.+)$/);
    if (mapped) return isPrivateIp(mapped[1]);                  // IPv4-mapped
    return false;
}

function isPrivateHost(hostname) {
    if (!hostname) return true;
    if (PRIVATE_HOST.test(hostname)) return true;
    if (net.isIP(hostname)) return isPrivateIp(hostname);
    return false;
}

// Phân giải DNS THẬT trước khi fetch: chặn rebinding-style (public name -> private IP)
async function assertPublicDns(hostname) {
    if (net.isIP(hostname)) return isPrivateIp(hostname) ? 'url nội bộ' : null;
    let addrs;
    try { addrs = await dnsPromises.lookup(hostname, { all: true, verbatim: true }); }
    catch (e) { return 'không phân giải được tên miền'; }
    if (!addrs.length) return 'DNS rỗng';
    if (addrs.some(a => isPrivateIp(a.address))) return 'tên miền trỏ vào mạng nội bộ';
    return null;
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

const MAX_PAGE_BYTES = 1.5 * 1024 * 1024;   // chặn trang khổng lồ làm phình RAM

// Đọc response có giới hạn kích thước (content-length HOẶC đếm stream)
async function readCapped(res, maxBytes = MAX_PAGE_BYTES) {
    const len = Number(res.headers.get('content-length')) || 0;
    if (len > maxBytes) throw new Error('trang quá lớn (' + Math.round(len / 1024) + ' KB)');
    if (!res.body) return (await res.text()).slice(0, maxBytes);
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
            try { await reader.cancel(); } catch (e) { }
            throw new Error('trang vượt quá ' + Math.round(maxBytes / 1024) + ' KB');
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
}

// Manual redirect loop: validate TỪNG hop (host + DNS thật) - redirect: 'follow'
// sẽ tự nhảy vào nội bộ trước khi ta kịp soi res.url
async function fetchFollowing(url, maxHops = 3) {
    let current = String(url);
    for (let hop = 0; hop <= maxHops; hop++) {
        let u;
        try { u = new URL(current); } catch (e) { return { error: 'url không hợp lệ' }; }
        if (!/^https?:$/.test(u.protocol)) return { error: 'chỉ hỗ trợ http/https' };
        if (isPrivateHost(u.hostname)) return { error: 'bị chặn: url thuộc mạng nội bộ' };
        const dnsBad = await assertPublicDns(u.hostname);
        if (dnsBad) return { error: 'bị chặn: ' + dnsBad };
        const res = await fetch(current, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            redirect: 'manual',
            signal: AbortSignal.timeout(9000)
        });
        if ([301, 302, 303, 307, 308].includes(res.status)) {
            const loc = res.headers.get('location');
            if (!loc) return { error: 'redirect không có Location' };
            current = new URL(loc, u).toString();
            continue;
        }
        return { res, finalUrl: current };
    }
    return { error: 'redirect quá nhiều lần' };
}

async function fetchPageText(url, maxChars = 4000) {
    try {
        const followed = await fetchFollowing(url);
        if (followed.error) return { error: followed.error };
        const { res } = followed;
        if (!res.ok) return { error: 'HTTP ' + res.status };
        const ct = res.headers.get('content-type') || '';
        if (!/text\/html|application\/xhtml|text\/plain/i.test(ct)) return { error: 'trang không phải nội dung text (' + ct.split(';')[0] + ')' };
        const html = await readCapped(res);
        const title = decodeEntities((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]).trim().slice(0, 160);
        const text = htmlToText(html, maxChars);
        if (text.length < 40) return { error: 'trang gần như trống (nội dung render bằng JS)' };
        return { title, content: text, url: followed.finalUrl };
    } catch (e) {
        return { error: 'không đọc được trang: ' + e.message };
    }
}

module.exports = { isPrivateHost, isPrivateIp, assertPublicDns, htmlToText, fetchPageText };
