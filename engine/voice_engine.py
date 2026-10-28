"""
=============================================================================
XIAOXI AI VOICE ENGINE SERVER (FastAPI - Silero VAD ONNX + edge-tts)
Tác vụ:
  1. /vad              : Phát hiện giọng nói (Silero VAD stateful theo device)
  2. /preprocess_for_stt : High-pass + Spectral denoise + Far-field AGC + Trim
  3. /voice/analyze    : Phân tích âm học + cảm xúc SER + Vân giọng
  4. /voice/verify_speaker : Xác thực chủ nhân qua ngân hàng mẫu vân giọng
  5. /tts              : edge-tts sinh giọng đọc tiếng Việt (MP3 24kHz)
  6. /health           : Kiểm tra trạng thái engine
Input audio: PCM 16-bit 16kHz Mono (raw bytes từ ESP32, không có WAV header)
=============================================================================
"""

import os
import sys
import io
import wave

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, Request, Query, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
import edge_tts
import asyncio
import threading
from contextlib import asynccontextmanager

from voice_intelligence import (
    AudioPreprocessor,
    AcousticProfiler,
    SpeechEmotionClassifier,
    SpeakerVoiceprint,
)

# =============================================================================
# 0. khảo sát config
# =============================================================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VAD_MODEL_PATH = os.path.join(BASE_DIR, "silero_vad.onnx")
VOICEPRINT_PATH = os.path.join(BASE_DIR, "owner_voiceprint.json")
SAMPLE_RATE = 16000
VAD_CHUNKBEST_LEN = 512           # Silero VAD v5 hoạt động tốt nhất ở 512 mẫu (32ms)
VAD_LOOKAHEAD_MS = 100

# =============================================================================
# 1. SILERO VAD ENGINE (stateful streaming theo device)
# =============================================================================
class SileroVAD:
    def __init__(self, model_path: str):
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"Không tìm thấy model: {model_path}")
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(model_path, sess_options=opts,
                                            providers=["CPUExecutionProvider"])
        self.initial_state = np.zeros((2, 1, 128), dtype=np.float32)
        self.sr_tensor = np.array(SAMPLE_RATE, dtype=np.int64)   # scalar 0-d đúng chữ ký []
        self._state = {}
        self._carry = {}
        self._lock = threading.Lock()   # ONNX session không thread-safe
        self.reset()

    def _fresh_state(self):
        return (self.initial_state.copy(), np.zeros(64, dtype=np.float32), np.empty(0, dtype=np.float32))

    def reset(self, device_id: str = "default"):
        self._state[device_id] = self._fresh_state()
        self._carry.pop(device_id, None)

    def run_chunk(self, pcm_bytes: bytes, device_id: str = "default") -> float:
        with self._lock:   # ONNX session + state per-device: phải chạy tuần tự
            return self._run_chunk_locked(pcm_bytes, device_id)

    def _run_chunk_locked(self, pcm_bytes: bytes, device_id: str) -> float:
        """Nhận chunk PCM16LE (n>=512 mẫu), trả về xác suất speech (0..1).
        Chuẩn Silero v5: mỗi bước feed CONTEXT 64 mẫu + 512 = 576 mẫu."""
        #Byte lẻ KHÔNG vứt - giữ lại ghép đầu chunk sau, nếu không mọi mẫu sau
        #bị lệch 1 byte (int16 tráo đôi) cho tới lúc reset -> VAD rác cả câu
        if device_id in self._carry:
            pcm_bytes = self._carry[device_id] + pcm_bytes
            self._carry.pop(device_id)
        if len(pcm_bytes) % 2 != 0:
            self._carry[device_id] = pcm_bytes[-1:]
            pcm_bytes = pcm_bytes[:-1]
        samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        if samples.size < 64:
            return 0.0

        state, ctx, buf = self._state.get(device_id) or self._fresh_state()
        buf = np.concatenate([buf, samples])

        max_prob = 0.0
        while buf.size >= VAD_CHUNKBEST_LEN:
            block, buf = buf[:VAD_CHUNKBEST_LEN], buf[VAD_CHUNKBEST_LEN:]
            x = np.concatenate([ctx, block])                       # [576] = ctx 64 + block 512
            out, state = self.session.run(
                None,
                {"input": x[None, :], "state": state, "sr": self.sr_tensor},
            )
            ctx = block[-64:].copy()
            prob = float(out[0][0])
            if prob > max_prob:
                max_prob = prob

        self._state[device_id] = (state, ctx, buf)
        # Chống leak: server sinh device id random ('esp32-xxxxx') mỗi lần
        # WS reconnect -> map tăng vô hạn. Giữ device đang dùng, vượt 64
        # thì xoá cái CŨ NHẤT (FIFO theo thứ tự chèn).
        if len(self._state) > 64:
            oldest = next(iter(self._state.keys()))
            if oldest != device_id:
                self._state.pop(oldest, None)
        return max_prob


vad_engine = SileroVAD(VAD_MODEL_PATH)

# =============================================================================
# 2. DSP TIỀN XỬ LÝ CHO STT (High-pass + Denoise + AGC + Trim Silence)
# =============================================================================
def trim_silence_by_energy(pcm_bytes: bytes, sample_rate: int = 16000,
                           top_db: float = 35.0, min_gap_ms: int = 150) -> bytes:
    """Cắt khoảng lặng đầu/cuối dựa trên năng lượng RMS per-frame.
    top_db=35.0 + pre-roll 250ms bảo toàn 100% phụ âm gió nhẹ đầu câu (s, x, ph, th)."""
    if len(pcm_bytes) % 2 != 0:
        pcm_bytes = pcm_bytes[:-1]
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32)
    if samples.size < 1024:
        return pcm_bytes

    frame_len = int(0.02 * sample_rate)  # 20ms frame
    hop_len = frame_len // 2
    n_frames = (samples.size - frame_len) // hop_len
    if n_frames <= 0:
        return pcm_bytes

    frames = np.stack([samples[i * hop_len: i * hop_len + frame_len]
                       for i in range(n_frames)])
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    ref_db = float(20 * np.log10(rms.max() + 1e-12))
    thr_db = ref_db - top_db
    frame_db = 20 * np.log10(rms + 1e-12)

    voiced = frame_db > thr_db
    if not voiced.any():
        return np.zeros(max(frame_len, 1), dtype=np.int16).tobytes()

    first = int(np.argmax(voiced))
    last = int(n_frames - 1 - np.argmax(voiced[::-1]))
    # Pre-roll 250ms (thay vì 100ms) để không bao giờ cắt mất âm đầu câu (XiaoXi, Phát nhạc, Bật đèn)
    start = max(0, int(first * hop_len - 0.25 * sample_rate))
    # Post-roll 300ms giữ trọn vẹn âm đuôi và ngữ điệu câu hỏi
    end = min(samples.size, int(last * hop_len + frame_len + 0.30 * sample_rate))
    trimmed = samples[start:end]
    return np.clip(trimmed, -32768, 32767).astype(np.int16).tobytes()


def preprocess_for_stt(pcm_bytes: bytes) -> bytes:
    """Pipeline chuẩn hoá cho Whisper: HP 110Hz -> Trim lặng (giảm input denoise) -> Spectral denoise -> Far-field AGC."""
    out = AudioPreprocessor.highpass_filter(pcm_bytes, cutoff=110.0, sample_rate=SAMPLE_RATE)
    out = trim_silence_by_energy(out, SAMPLE_RATE, top_db=35.0)
    out = AudioPreprocessor.spectral_noise_reduction(out, sample_rate=SAMPLE_RATE)
    out = AudioPreprocessor.farfield_adaptive_gain(out)
    return out

# =============================================================================
# 3. SINGLETON HỒ SƠ VÂN GIỌNG & FASTER-WHISPER STT (IN-MEMORY)
# =============================================================================
speaker_vault = SpeakerVoiceprint(VOICEPRINT_PATH)


DEFAULT_INITIAL_PROMPT = (
    "Đây là hội thoại bằng tiếng Việt với robot trợ lý thông minh tên là XiaoXi. "
    "Người dùng đưa khẩu lệnh điều khiển thiết bị, cử chỉ robot hoặc hỏi đáp thông tin. "
    "Các từ khóa và khẩu lệnh thường dùng: XiaoXi ơi, em ơi, bật đèn, tắt đèn, bật quạt, tắt quạt, "
    "mở nhạc, tắt nhạc, phát nhạc, gập đầu, cúi đầu, ngẩng đầu lên, nhìn thẳng, quay trái, quay phải, "
    "thời tiết hôm nay thế nào, mấy giờ rồi, ghi nhớ giúp anh, nhắc anh, kể chuyện, hôm nay vui quá, tạm biệt."
)


class WhisperSTT:
    def __init__(self, model_size: str = "base", language: str = "vi",
                 device: str = "cpu", compute_type: str = "int8"):
        self.language = language
        self.model_size = model_size
        self.model = None
        try:
            from faster_whisper import WhisperModel
            print(f"[STT] Đang khởi tạo faster-whisper '{model_size}' ({device}, {compute_type})...")
            self.model = WhisperModel(model_size, device=device, compute_type=compute_type, cpu_threads=4)
            print(f"[STT] faster-whisper '{model_size}' sẵn sàng trong RAM (0 disk I/O)!")
        except Exception as e:
            print(f"[STT] Cảnh báo: Không thể nạp faster-whisper: {e}")

    def warmup(self):
        if not self.model:
            return
        try:
            dummy = np.zeros(16000, dtype=np.float32)
            list(self.model.transcribe(dummy, language=self.language, beam_size=1, without_timestamps=True, initial_prompt=DEFAULT_INITIAL_PROMPT)[0])
            print("[STT WARM] faster-whisper đã làm ấm đồ thị tính toán!")
        except Exception as e:
            print(f"[STT WARM] Lỗi warm-up faster-whisper: {e}")

    def transcribe_pcm(self, pcm_bytes: bytes, initial_prompt: str = "") -> dict:
        if not self.model:
            raise RuntimeError("Whisper model chưa được khởi tạo")
        if len(pcm_bytes) % 2 != 0:
            pcm_bytes = pcm_bytes[:-1]
        if len(pcm_bytes) < 3200:
            return {"text": "", "segments": [], "language": self.language, "duration": 0.0, "confidence": 1.0, "is_uncertain": False}

        audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0

        prompt = initial_prompt or DEFAULT_INITIAL_PROMPT

        segments, info = self.model.transcribe(
            audio,
            language=self.language,
            task="transcribe",
            beam_size=1,
            temperature=0.0,
            repetition_penalty=1.2,
            without_timestamps=True,
            vad_filter=False,
            initial_prompt=prompt,
            condition_on_previous_text=False
        )

        seg_list = []
        texts = []
        conf_list = []

        for s in segments:
            t = s.text.strip()
            if t:
                texts.append(t)
            prob = float(np.exp(np.clip(s.avg_logprob, -10.0, 0.0)))
            conf_list.append(prob)
            seg_list.append({
                "id": getattr(s, "id", 0),
                "start": getattr(s, "start", 0.0),
                "end": getattr(s, "end", 0.0),
                "text": t,
                "avg_logprob": float(getattr(s, "avg_logprob", 0.0)),
                "no_speech_prob": float(getattr(s, "no_speech_prob", 0.0)),
                "confidence": round(prob, 3),
            })

        full_text = " ".join(texts).strip()
        avg_confidence = float(np.mean(conf_list)) if conf_list else 1.0

        # Lọc kết quả không chắc chắn / mơ hồ (lúng búng hoặc tạp âm ngẫu nhiên)
        is_uncertain = False
        if full_text:
            first_no_speech = seg_list[0]["no_speech_prob"] if seg_list else 0.0
            first_logprob = seg_list[0]["avg_logprob"] if seg_list else 0.0
            if avg_confidence < 0.40 or first_no_speech > 0.65 or first_logprob < -2.8:
                is_uncertain = True

        return {
            "text": full_text,
            "segments": seg_list,
            "language": info.language if info else self.language,
            "duration": float(info.duration) if info else float(len(audio) / SAMPLE_RATE),
            "confidence": round(avg_confidence, 3),
            "is_uncertain": is_uncertain,
        }


WHISPER_MODEL_NAME = os.getenv("WHISPER_MODEL", "base")
whisper_stt = WhisperSTT(model_size=WHISPER_MODEL_NAME, language="vi")

# =============================================================================
# 4. FASTAPI APP
# =============================================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Làm ấm kênh edge-tts & faster-whisper ngay khi engine vừa lên (DNS/TLS/token/graph) ->
    các tác vụ STT và TTS đầu tiên phản hồi tức thì mà không bị lag kết nối lạnh."""
    # 1. Warm-up faster-whisper trước khi mở nhận request (chống lag ở turn đầu tiên)
    if whisper_stt:
        await asyncio.to_thread(whisper_stt.warmup)

    async def _warm_tts():
        for i in range(3):
            try:
                t0 = asyncio.get_event_loop().time()
                c = edge_tts.Communicate("Dạ", "vi-VN-HoaiMyNeural", rate="+18%")
                async for chunk in c.stream():
                    if chunk["type"] == "audio":
                        break
                ms = (asyncio.get_event_loop().time() - t0) * 1000
                print(f"[TTS WARM] edge-tts sẵn sàng ({ms:.0f}ms) - kênh đã nóng")
                break
            except Exception as e:
                print(f"[TTS WARM] Lần {i + 1} lỗi: {e} -> thử lại")
                await asyncio.sleep(1.5)

    asyncio.create_task(_warm_tts())
    yield


app = FastAPI(title="XiaoXi Voice Engine", version="2.0", lifespan=lifespan)
_STT_SEM = asyncio.Semaphore(2)   # Py3.11: semaphore tự bind vào loop đang chạy


MAX_BODY_BYTES = 32 * 1024 * 1024   # 32MB PCM ~17 phút 16k - trên nữa là từ chối (chặn DoS phình RAM)

async def read_pcm_body(request: Request) -> bytes:
    """Đọc raw body (octet-stream) -> PCM bytes, có giới hạn kích thước."""
    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="Body quá lớn")
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Body PCM rỗng")
    if len(body) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="Body quá lớn")
    return body


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "sample_rate": SAMPLE_RATE,
        "vad_loaded": vad_engine is not None,
        "whisper_loaded": whisper_stt is not None and whisper_stt.model is not None,
        "whisper_model": whisper_stt.model_size if whisper_stt else None,
        "voiceprint_samples": len(speaker_vault.owner_profile.get("samples", [])) if speaker_vault.owner_profile else 0,
        "owner_enrolled": speaker_vault.owner_profile is not None,
    }


@app.post("/vad")
async def VadDetection(request: Request, x_device_id: str = Query(default="default")):
    """VAD streaming stateful. Body: raw PCM 16kHz 16-bit."""
    pcm = await read_pcm_body(request)
    dev_id = request.headers.get("x-device-id") or x_device_id
    if dev_id not in vad_engine._state:
        vad_engine.reset(dev_id)
    # ONNX + DSP loop NẶNG: đẩy ra threadpool để không starving event loop
    # (trước đây /vad đồng bộ làm mọi request khác chờ -> timeout 700ms dây chuyền)
    prob = await run_in_threadpool(vad_engine.run_chunk, pcm, dev_id)

    acoustics = await run_in_threadpool(AcousticProfiler.extract_features, pcm, SAMPLE_RATE)
    # Kết hợp Silero với dấu hiệu gió (>45% năng lượng trầm) để tránh ảo giác
    is_wind = acoustics.get("is_wind_noise", False)
    is_speech = prob > 0.5 and not is_wind

    return {
        "is_speech": bool(is_speech),
        "prob": round(prob, 3),
        "event": "speech" if is_speech else "silence",
        "acoustics": acoustics,
    }


@app.post("/vad_reset")
async def VadReset(x_device_id: str = Query(default="default")):
    """Reset trạng thái VAD streaming của một device (sau khi STT xong)."""
    vad_engine.reset(x_device_id)
    return {"reset": True, "device": x_device_id}


@app.post("/preprocess_for_stt")
async def PreprocessForSTT(request: Request):
    """HP filter + spectral denoise + AGC + trim silence. Body: raw PCM."""
    pcm = await read_pcm_body(request)
    content = await run_in_threadpool(preprocess_for_stt, pcm)
    return Response(content=content, media_type="application/octet-stream")


@app.post("/stt")
@app.post("/transcribe")
async def transcribeAudioEndpoint(request: Request, prompt: str = Query(default=""),
                                  auto_preprocess: bool = Query(default=False)):
    """STT trực tiếp trong RAM với faster-whisper (0 disk I/O). Body: raw PCM 16kHz 16-bit."""
    pcm = await read_pcm_body(request)
    if auto_preprocess:
        pcm = await run_in_threadpool(preprocess_for_stt, pcm)
    if not whisper_stt or not whisper_stt.model:
        raise HTTPException(status_code=503, detail="Whisper STT chưa sẵn sàng")
    # Giới hạn 2 lượt transcribe đồng thời: máy 4 luồng mà cho ~32 request chạy
    # song song (default executor) là p95 sập - thà xếp hàng còn hơn nghẽn hết
    async with _STT_SEM:
        result = await asyncio.to_thread(whisper_stt.transcribe_pcm, pcm, prompt)
    return result


@app.post("/voice/analyze")
async def analyzeVoice(request: Request, transcript: str = Query(default="")):
    """Phân tích âm học + cảm xúc SER + xác thực chủ nhân (1 lần gọi duy nhất). Body: raw PCM."""
    pcm = await read_pcm_body(request)
    acoustics = await run_in_threadpool(AcousticProfiler.extract_features, pcm, SAMPLE_RATE)
    emotion_data = SpeechEmotionClassifier.classify(acoustics, transcript)

    try:
        speaker_data = await run_in_threadpool(speaker_vault.verify_speaker, pcm)
    except Exception as e:
        # fail-open CÓ CHỦ ĐÍCH (tránh khoá nhầm chủ nhà khỏi robot của chính họ),
        # nhưng phải LOE ra để thấy voiceprint đang hỏng thay vì im lặng
        print(f"[WARN] verify_speaker exception -> tạm coi là chủ nhân: {e!r}")
        speaker_data = {"speaker_name": "Chưa rõ", "is_owner": True, "similarity": 0.0}

    return {
        "success": True,
        "speaker": speaker_data,
        "emotion": emotion_data,
        "acoustics": acoustics,
    }


@app.post("/voice/verify_speaker")
async def verifySpeaker(request: Request, threshold: float = Query(default=0.75)):
    """Xác thực chủ nhân qua ngân hàng mẫu đa trạng thái. Body: raw PCM 16kHz 16-bit."""
    pcm = await read_pcm_body(request)
    result = await run_in_threadpool(speaker_vault.verify_speaker, pcm, threshold)
    return result


@app.get("/voice/profile")
async def voiceProfile():
    """Tóm tắt ngân hàng mẫu vân giọng hiện tại."""
    return speaker_vault.get_profile_summary()


# =============================================================================
# 5. TEXT-TO-SPEECH (edge-tts, trả MP3 để Node hoặc client decode tiếp)
# =============================================================================
_TTS_VOICE_CACHE: dict[str, str] = {
    "f1": "vi-VN-HoaiMyNeural",   # Nữ: ấm áp, là robot XiaoXi
    "m1": "vi-VN-NamMinhNeural",  # Nam
}

import re as _re
_RATE_RE = _re.compile(r"^[+-]\d+%$")

def _sanitize_rate(rate: str, default: str = "+0%") -> str:
    """URL decode làm '+' thành ' ' (vd rate=+0% -> ' 0%'). Chuẩn hoá lại."""
    if not rate:
        return default
    rate = rate.strip().replace(" ", "+")
    return rate if _RATE_RE.match(rate) else default


@app.post("/tts")
async def textToSpeech(request: Request, voice: str = Query(default="f1"),
                       rate: str = Query(default="+0%")):
    """
    Sinh giọng đọc tiếng Việt bằng edge-tts.
    Trả về raw MP3 (24kHz mono) - client (Node) tự decode + resample 16kHz
    rồi stream PCM cho ESP32.
    Body: raw text (UTF-8).
    """
    raw = await request.body()
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text rỗng")
    if len(text) > 600:
        text = text[:600]

    voice_name = _TTS_VOICE_CACHE.get(voice, voice)
    safe_rate = _sanitize_rate(rate)

    try:
        # DNS/băng thông thỉnh thoảng make edge-tts lỗi 502 - thử tối đa 3 lần
        mp3_data = b""
        for attempt in range(3):
            try:
                communicate = edge_tts.Communicate(text, voice_name, rate=safe_rate)
                mp3_chunks = []
                # wait_for: socket của edge-tts có thể treo vĩnh viễn (DNS nửa chừng)
                async with asyncio.timeout(20):
                    async for chunk in communicate.stream():
                        if chunk["type"] == "audio":
                            mp3_chunks.append(chunk["data"])
                mp3_data = b"".join(mp3_chunks)
                if mp3_data:
                    break
            except Exception:
                if attempt < 2:
                    await asyncio.sleep(0.6 + attempt * 0.9)
                    continue
                raise
        if not mp3_data:
            # FALLBACK giọng Google (gTTS) khi Microsoft bận - vẫn giọng nữ tiếng Việt
            from gtts import gTTS
            import io as _io
            mp3_data = b""
            for gatt in range(2):
                try:
                    def _gtts_synthesize():   # blocking network I/O -> ra thread, đừng đói event loop
                        buf = _io.BytesIO()
                        gTTS(text, lang="vi").write_to_fp(buf)
                        return buf.getvalue()
                    mp3_data = await asyncio.to_thread(_gtts_synthesize)
                    if mp3_data:
                        break
                except Exception:
                    await asyncio.sleep(0.5)
            if not mp3_data:
                raise RuntimeError("Cả edge-tts lẫn gTTS đều thất bại")
        return Response(content=mp3_data, media_type="audio/mpeg")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"TTS failure: {e}")


@app.post("/tts/pcm")
async def textToSpeechPCM(request: Request, voice: str = Query(default="f1"),
                          rate: str = Query(default="+0%")):
    """Trả về WAV 16kHz 16bit mono - ESP32 phát trực tiếp qua I2S MAX98357A."""
    # Edge-TTS luôn sinh MP3; muốn PCM cần decoder MP3 (chưa có trong engine).
    # Client Node phải tự decode bằng mpg123-decoder rồiՒ ép thành 16kHz.
    raise HTTPException(
        status_code=501,
        detail="Dùng /tts rồi decode MP3 bằng mpg123-decoder phía Node + resample 16kHz."
    )


if __name__ == "__main__":
    import uvicorn
    host_addr = os.environ.get("VOICE_HOST", "0.0.0.0")
    port = int(os.environ.get("VOICE_PORT", "5005"))
    # Tắt hoàn toàn access log (POST /vad spam ~10 lần/giây) - màn hình chỉ hiển thị log khi nhận giọng nói/trả lời
    uvicorn.run(app, host=host_addr, port=port, access_log=False, log_level="warning")
