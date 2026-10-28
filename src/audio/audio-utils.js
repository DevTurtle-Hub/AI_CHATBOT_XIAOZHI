'use strict';

function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(false);
            return;
        }
        let timer = null;
        const finish = (ok) => {
            if (timer !== null) clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve(ok);
        };
        const onAbort = () => finish(false);
        timer = setTimeout(() => finish(true), Math.max(0, Number(ms) || 0));
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

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
        sum2 += s * s;
        sum += s;
        if (a > 32500) clip++;
        if (i > 0) {
            const d = s - pcm16.readInt16LE((i - 1) * 2);
            diff2 += d * d;
        }
    }
    const rms = Math.sqrt(sum2 / n) / 32768;
    const peakA = peak / 32768;
    const dc = (sum / n) / 32768;
    const hfShare = sum2 > 0
        ? Math.min(1, Math.sqrt(diff2 / (n - 1)) / 32768 / (Math.sqrt(sum2 / n) / 32768 + 1e-9))
        : 0;
    const secs = (n / 16000).toFixed(1);
    const verdict =
        (clip > n * 0.005) ? 'CÓ CLIP (nhiều mẫu chạm trần!)' :
            (peakA < 0.05) ? 'ÂM QUÁ NHỎ (peak<5%)' :
                (peakA > 0.99 && clip > 0) ? 'SÁT TRẦN' :
                    (rms > 0.35) ? 'TO SÁT' :
                        'DATA SẠCH';
    return `${secs}s rms=${rms.toFixed(3)} peak=${peakA.toFixed(2)} clip=${clip} dc=${dc.toFixed(3)} hf=${(hfShare * 100).toFixed(0)}% [${verdict}]`;
}

let audioTraceSeq = 0;

function newAudioTraceId() {
    return `${Date.now().toString(36)}-${(++audioTraceSeq).toString(36)}`;
}

function logAudioTrace(traceId, stage, details = {}) {
    console.log(`[AUDIO ${traceId}] ${stage} ${JSON.stringify(details)}`);
}

function pcmToWav(pcmBuf, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
    const dataLen = pcmBuf.length;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLen, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
    header.writeUInt16LE(channels * bitsPerSample / 8, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLen, 40);
    return Buffer.concat([header, pcmBuf]);
}

module.exports = {
    sleep,
    audioStats,
    newAudioTraceId,
    logAudioTrace,
    pcmToWav
};
