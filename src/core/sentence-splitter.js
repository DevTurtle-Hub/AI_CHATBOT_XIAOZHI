'use strict';

const DEFAULT_MAX_CHARS = 140;
const DEFAULT_MIN_CHARS = 12;

function normalize(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function hardSplit(text, maxChars) {
    const parts = [];
    let rest = text;
    while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(' ', maxChars);
        if (cut < Math.floor(maxChars * 0.5)) cut = rest.lastIndexOf(',', maxChars);
        if (cut < Math.floor(maxChars * 0.5)) cut = maxChars;
        const head = rest.slice(0, cut).trim();
        if (head) parts.push(head);
        rest = rest.slice(cut).trim();
    }
    if (rest) parts.push(rest);
    return parts;
}

function splitSentences(text, options = {}) {
    const maxChars = Math.max(20, Number(options.maxChars) || DEFAULT_MAX_CHARS);
    const minChars = Math.max(2, Number(options.minChars) || DEFAULT_MIN_CHARS);
    const clean = normalize(text);
    if (!clean) return [];

    const raw = clean.match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g) || [clean];
    const merged = [];
    for (const item of raw) {
        const part = item.trim();
        if (!part) continue;
        if (!merged.length) {
            merged.push(part);
            continue;
        }
        const prev = merged[merged.length - 1];
        if (prev.length < minChars || part.length < minChars) {
            merged[merged.length - 1] = `${prev} ${part}`.trim();
        } else {
            merged.push(part);
        }
    }

    const out = [];
    for (const sentence of merged) {
        if (sentence.length <= maxChars) out.push(sentence);
        else out.push(...hardSplit(sentence, maxChars));
    }
    return out.length ? out : [clean];
}

module.exports = { splitSentences, hardSplit, normalize };
