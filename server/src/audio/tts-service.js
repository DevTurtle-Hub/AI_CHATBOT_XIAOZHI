'use strict';

const { MPEGDecoder } = require('mpg123-decoder');
const { getAudioBase64 } = require('google-tts-api');
const { splitSentences } = require('../core/sentence-splitter');
const { sleep, audioStats, newAudioTraceId, logAudioTrace } = require('./audio-utils');

const TTS_CHUNK = 5120;
const TTS_BYTES_PER_SEC = 32000;

class TtsService {
    constructor(options = {}) {
        this.axios = options.axios;
        this.rate = options.rate || '+18%';
        this.sentenceStreaming = options.sentenceStreaming !== false;
        this.chunkBytes = Math.max(2, Number(options.chunkBytes) || TTS_CHUNK);
        this.bytesPerSec = Math.max(1000, Number(options.bytesPerSec) || TTS_BYTES_PER_SEC);
        this.leadMs = Math.max(0, Number(options.leadMs) || 1400);
        this.drainMs = Math.max(0, Number(options.drainMs) || 900);
        this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || 20000);
        this._log = typeof options.logger === 'function'
            ? options.logger
            : ((options.logger && options.logger.log) ? options.logger.log.bind(options.logger) : console.log.bind(console));
        // 'auto' = đua edge-tts vs gTTS ở câu đầu, giọng thắng cuộc giữ cả phiên
        // 'edge' = luôn edge-tts (giọng HoaiMy đẹp nhưng hay chậm 1.2-3s)
        // 'gtts' = luôn Google Translate TTS (nhanh ~0.6s, chất lượng nhỉnh hơn chút xíu kém)
        this.provider = ['edge', 'gtts'].includes(options.provider) ? options.provider : 'auto';
        this._decoder = null;
        this._decodeLock = Promise.resolve();
    }

    async _decoderInstance() {
        if (!this._decoder) {
            this._decoder = new MPEGDecoder();
            await this._decoder.ready;
        }
        return this._decoder;
    }

    async _decodeMp3(bytes) {
        const previous = this._decodeLock;
        let release;
        this._decodeLock = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            let decoder = await this._decoderInstance();
            try {
                await decoder.reset();
            } catch {
                try { decoder.free(); } catch { }
                this._decoder = null;
                decoder = await this._decoderInstance();
            }
            return decoder.decode(bytes);
        } finally {
            release();
        }
    }

    // Decoder RIÊNG cho đường đua: lock chung sẽ làm chậm nhánh nhanh hơn
    // (nhánh sau phải chờ nhánh trước decode xong -> mất ý nghĩa đua).
    async _decodeMp3Fresh(bytes) {
        const decoder = new MPEGDecoder();
        await decoder.ready;
        try {
            return decoder.decode(bytes);
        } finally {
            try { decoder.free(); } catch { }
        }
    }

    _resample16k(f32, inRate) {
        const outRate = 16000;
        const count = Math.floor(f32.length * outRate / inRate);
        const pcm = Buffer.allocUnsafe(count * 2);
        for (let i = 0; i < count; i++) {
            const pos = i * inRate / outRate;
            const i0 = Math.floor(pos);
            const i1 = Math.min(f32.length - 1, i0 + 1);
            const frac = pos - i0;
            const value = f32[i0] * (1 - frac) + f32[i1] * frac;
            const sample = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
            pcm.writeInt16LE(sample, i * 2);
        }
        return pcm;
    }

    async synthesize(text) {
        const res = await this.axios.post(
            `/tts?rate=${encodeURIComponent(this.rate)}`,
            Buffer.from(text, 'utf8'),
            {
                headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                responseType: 'arraybuffer',
                timeout: this.timeoutMs
            }
        );
        if (!res.data || !res.data.byteLength) throw new Error('TTS trả về rỗng');
        const decoded = await this._decodeMp3(new Uint8Array(res.data));
        const f32 = decoded.channelData && decoded.channelData[0];
        if (!f32 || !f32.length) throw new Error('TTS decode rỗng');
        const pcm = this._resample16k(f32, decoded.sampleRate || 24000);
        this._log(`[TTS DATA][edge] ${(res.data.byteLength / 1024).toFixed(0)}KB mp3 -> PCM: ${audioStats(pcm)}`);
        return pcm;
    }

    async synthesizeGtts(text) {
        // Google Translate TTS: nhanh hơn edge-tts 2-5 lần cho câu đầu (≈600ms vs 1.2-3.6s)
        let mp3Buf = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const b64 = await getAudioBase64(text, 'vi');
                mp3Buf = Buffer.from(b64, 'base64');
                if (mp3Buf.length) break;
            } catch (e) {
                if (attempt >= 2) throw e;
                await sleep(400);
            }
        }
        if (!mp3Buf || !mp3Buf.length) throw new Error('gTTS trả về rỗng');
        const decoded = await this._decodeMp3Fresh(new Uint8Array(mp3Buf));
        const f32 = decoded.channelData && decoded.channelData[0];
        if (!f32 || !f32.length) throw new Error('gTTS decode rỗng');
        const pcm = this._resample16k(f32, decoded.sampleRate || 24000);
        this._log(`[TTS DATA][gtts] ${(mp3Buf.length / 1024).toFixed(0)}KB mp3 -> PCM: ${audioStats(pcm)}`);
        return pcm;
    }

    async _synthesizeWith(provider, text) {
        if (provider === 'gtts') return await this.synthesizeGtts(text);
        return await this.synthesize(text);
    }

    // Chọn nguồn tổng hợp cho 1 câu: sticky provider (nếu có) hoặc ĐUA song song.
    // Kết quả kèm provider thắng -> ghi nhớ vào session để cả phiên dùng 1 giọng.
    async synthesizeSmart(text, session) {
        const sticky = session?.ttsProvider || null;
        if (sticky && sticky !== 'auto') {
            try {
                return { provider: sticky, pcm: await this._synthesizeWith(sticky, text) };
            } catch (e) {
                this._log(`[🗣️ TTS] ${sticky} lỗi -> thử nhánh còn lại: ${e.message}`);
                const other = sticky === 'gtts' ? 'edge' : 'gtts';
                const pcm = await this._synthesizeWith(other, text);
                if (session) session.ttsProvider = other;
                return { provider: other, pcm };
            }
        }

        if (this.provider !== 'auto') {
            const pcm = await this._synthesizeWith(this.provider, text);
            if (session) session.ttsProvider = this.provider;
            return { provider: this.provider, pcm };
        }

        // ĐUA: edge-tts và gTTS chạy song song, ai xong trước lấy câu đó
        const race = await Promise.any([
            this.synthesize(text).then(pcm => ({ provider: 'edge', pcm })),
            this.synthesizeGtts(text).then(pcm => ({ provider: 'gtts', pcm }))
        ]);
        if (session) session.ttsProvider = race.provider;
        this._log(`[🗣️ TTS] phiên này dùng giọng: ${race.provider} (đua thắng)`);
        return race;
    }

    async synthesizeWithRetry(text, attempts = 3, session = null) {
        let lastError = null;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                return await this.synthesizeSmart(text, session);
            } catch (error) {
                lastError = error;
                if (attempt < attempts) {
                    this._log(`[🗣️ TTS] engine lỗi (lần ${attempt}): ${error.message} -> thử lại sau...`);
                    await sleep(700 * attempt);
                }
            }
        }
        throw lastError || new Error('TTS failed');
    }

    async _sendPcm(ws, pcm, pacing, controller) {
        let sent = 0;
        let chunks = 0;
        for (let offset = 0; offset < pcm.length; offset += this.chunkBytes) {
            if (controller.signal.aborted || ws.readyState !== ws.OPEN) {
                return { sent, chunks, aborted: true };
            }
            const piece = pcm.subarray(offset, Math.min(offset + this.chunkBytes, pcm.length));
            const now = Date.now();
            if (pacing.previousSendAt) {
                const gap = now - pacing.previousSendAt;
                pacing.maxChunkGapMs = Math.max(pacing.maxChunkGapMs, gap);
                if (gap > 220) pacing.delayedChunkGaps++;
            }
            pacing.previousSendAt = now;
            ws.send(piece);
            sent += piece.length;
            chunks++;
            pacing.sent += piece.length;
            pacing.maxWsBufferedBytes = Math.max(pacing.maxWsBufferedBytes, ws.bufferedAmount || 0);

            const targetElapsedMs = pacing.sent / this.bytesPerSec * 1000 - this.leadMs;
            const lag = Date.now() - pacing.t0 - targetElapsedMs;
            pacing.maxPacingLagMs = Math.max(pacing.maxPacingLagMs, lag);
            const wait = targetElapsedMs - (Date.now() - pacing.t0);
            if (wait > 0) {
                const ok = await sleep(wait, controller.signal);
                if (!ok) return { sent, chunks, aborted: true };
            }
        }
        return { sent, chunks, aborted: false };
    }

    async speak(ws, text, options = {}) {
        const session = options.session || null;
        const traceId = options.traceId || newAudioTraceId();
        if (!ws || ws.readyState !== ws.OPEN || !text) {
            logAudioTrace(traceId, 'tts_skipped', { reason: 'websocket_closed_or_empty_text' });
            return { ok: false, reason: 'invalid_input' };
        }
        if (session && session.tts && session.tts.active) {
            logAudioTrace(traceId, 'tts_skipped', { reason: 'another_tts_active' });
            return { ok: false, reason: 'busy' };
        }

        const controller = new AbortController();
        if (session?.beginTts) session.beginTts(controller);

        const startedAt = Date.now();
        let started = false;
        let totalSent = 0;
        let totalChunks = 0;
        let firstChunkAt = 0;
        const pacing = {
            t0: 0,
            sent: 0,
            previousSendAt: 0,
            maxChunkGapMs: 0,
            delayedChunkGaps: 0,
            maxWsBufferedBytes: 0,
            maxPacingLagMs: 0
        };
        const sentences = this.sentenceStreaming ? splitSentences(text) : [String(text)];

        try {
            let nextPromise = this.synthesizeWithRetry(sentences[0], 3, session);
            nextPromise.catch(() => { });
            for (let i = 0; i < sentences.length; i++) {
                let res;
                try {
                    res = await nextPromise;
                } catch (error) {
                    if (i === 0) throw error;
                    this._log(`[🗣️ TTS] bỏ câu ${i + 1}/${sentences.length}: ${error.message}`);
                    break;
                }
                const pcm = res.pcm;
                if (controller.signal.aborted || ws.readyState !== ws.OPEN) break;

                if (i + 1 < sentences.length) {
                    nextPromise = this.synthesizeWithRetry(sentences[i + 1], 3, session);
                    nextPromise.catch(() => { });
                }

                if (!started) {
                    ws.send('__SPEAK_START__');
                    started = true;
                    pacing.t0 = Date.now();
                    firstChunkAt = Date.now();
                    if (session?.markFirstChunk) session.markFirstChunk();
                    if (options.onFirstChunk) options.onFirstChunk({ at: firstChunkAt, traceId });
                    logAudioTrace(traceId, 'tts_ready', {
                        provider: res.provider,
                        firstSentenceChars: sentences[0].length,
                        firstAudioMs: firstChunkAt - startedAt,
                        totalSentences: sentences.length
                    });
                }

                this._log(`[PHAT LOA] Dang phat am thanh (${(pcm.length / this.bytesPerSec).toFixed(1)} giay, câu ${i + 1}/${sentences.length})...`);
                const result = await this._sendPcm(ws, pcm, pacing, controller);
                totalSent += result.sent;
                totalChunks += result.chunks;
                if (result.aborted) break;
            }

            const aborted = controller.signal.aborted || ws.readyState !== ws.OPEN;
            if (!aborted) {
                const audioMs = pacing.sent / this.bytesPerSec * 1000;
                const elapsed = Date.now() - pacing.t0;
                const drain = Math.max(0, audioMs - elapsed) + this.drainMs;
                await sleep(drain, controller.signal);
            }

            if (!controller.signal.aborted && ws.readyState === ws.OPEN) {
                ws.send('__SPEAK_END__');
                if (session) {
                    session.micLockedUntil = Math.max(session.micLockedUntil, Date.now() + 300);
                }
            }

            const result = {
                ok: !controller.signal.aborted && totalSent > 0,
                aborted: controller.signal.aborted,
                bytes: totalSent,
                chunks: totalChunks,
                audioSec: Number((totalSent / this.bytesPerSec).toFixed(3)),
                firstAudioMs: firstChunkAt ? firstChunkAt - startedAt : null,
                totalMs: Date.now() - startedAt,
                traceId
            };
            logAudioTrace(traceId, controller.signal.aborted ? 'tx_interrupted' : 'tx_complete', {
                bytes: totalSent,
                chunks: totalChunks,
                audioSec: result.audioSec,
                firstAudioMs: result.firstAudioMs,
                totalWithDrainMs: result.totalMs,
                maxChunkGapMs: pacing.maxChunkGapMs,
                delayedChunkGaps: pacing.delayedChunkGaps,
                maxPacingLagMs: Math.max(0, Math.round(pacing.maxPacingLagMs)),
                maxWsBufferedBytes: pacing.maxWsBufferedBytes
            });
            if (!controller.signal.aborted) {
                this._log('[PHAT LOA] Hoan tat phat am thanh - San sang nghe lai');
            }
            return result;
        } catch (error) {
            logAudioTrace(traceId, 'tx_error', { error: error.message });
            this._log('[PHAT LOA] Loi phat am thanh:', error.message);
            if (ws.readyState === ws.OPEN) {
                try { ws.send('__SPEAK_END__'); } catch { }
            }
            return {
                ok: false,
                error: error.message,
                aborted: controller.signal.aborted,
                bytes: totalSent,
                firstAudioMs: firstChunkAt ? firstChunkAt - startedAt : null,
                totalMs: Date.now() - startedAt,
                traceId
            };
        } finally {
            if (session?.endTts) session.endTts();
        }
    }
}

module.exports = { TtsService, TTS_CHUNK, TTS_BYTES_PER_SEC };
