"""
=============================================================================
XIAOXI SILERO VAD WORKER (ONNX Runtime - stateless module)
- Đóng vai trò thư viện dùng chung cho voice_engine.py
- Có thể chạy độc lập để test VAD bằng ONNX (không cần torch)
=============================================================================
"""
import os
import numpy as np
import onnxruntime as ort

_BASE = os.path.dirname(os.path.abspath(__file__))
VAD_MODEL_PATH = os.path.join(_BASE, "silero_vad.onnx")

# Khởi tạo model Silero VAD bằng ONNX Runtime (siêu nhẹ, tối ưu C++)
vad_session = None


def init_vad(model_path: str = VAD_MODEL_PATH):
    global vad_session
    if vad_session is not None:
        return vad_session
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Không tìm thấy silero_vad.onnx tại: {model_path}")
    opts = ort.SessionOptions()
    opts.inter_op_num_threads = 1
    opts.intra_op_num_threads = 1
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    vad_session = ort.InferenceSession(model_path, sess_options=opts)
    print("[AI Voice] Silero VAD ONNX Engine đã sẵn sàng!")
    return vad_session


class SileroVADDetector:
    """
    Detector stateful cho streaming PCM 16kHz.
    Chuẩn Silero v5: mỗi bước feed CONTEXT 64 mẫu + 512 = 576 (như wrapper chính thức).
    """

    CHUNK_LEN = 512
    CONTEXT_LEN = 64

    def __init__(self, threshold: float = 0.5, sample_rate: int = 16000):
        self.threshold = threshold
        self.sample_rate = sample_rate
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.sr_tensor = np.array(sample_rate, dtype=np.int64)   # scalar 0-d đúng chữ ký []
        self.ctx = np.zeros(self.CONTEXT_LEN, dtype=np.float32)
        self.buf = np.empty(0, dtype=np.float32)

    def reset(self):
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.ctx = np.zeros(self.CONTEXT_LEN, dtype=np.float32)
        self.buf = np.empty(0, dtype=np.float32)

    def is_speech(self, pcm16_chunk: bytes) -> float:
        """
        Nhận chunk PCM 16-bit 16000Hz (bất kỳ độ dài nào - sẽ buffer nội bộ).
        Trả về xác suất speech cao nhất của các block 512-mẫu vừa xử lý (0.0 hay 1.0).
        """
        sess = init_vad()

        audio_int16 = np.frombuffer(pcm16_chunk, dtype=np.int16)
        audio_float32 = audio_int16.astype(np.float32) / 32768.0
        if self.buf.size:
            self.buf = np.concatenate([self.buf, audio_float32])
        else:
            self.buf = audio_float32.astype(np.float32)

        max_prob = 0.0
        while self.buf.size >= self.CHUNK_LEN:
            block, self.buf = self.buf[:self.CHUNK_LEN], self.buf[self.CHUNK_LEN:]
            x = np.concatenate([self.ctx, block])                 # [576] = ctx 64 + block 512
            inputs = {
                "input": x[None, :],
                "state": self.state,
                "sr": self.sr_tensor,
            }
            out, self.state = sess.run(None, inputs)
            self.ctx = block[-self.CONTEXT_LEN:].copy()
            prob = float(out[0][0])
            if prob > max_prob:
                max_prob = prob
        return max_prob


async def generate_edge_tts_pcm(text: str, voice: str = "vi-VN-HoaiMyNeural"):
    """
    Sinh giọng đọc tiếng Việt bằng edge-tts, trả về bytes MP3.
    (Liên hệ voice_engine để chuyển MP3 -> PCM cho ESP32)
    """
    import edge_tts
    communicate = edge_tts.Communicate(text, voice)
    mp3_data = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            mp3_data.write(chunk["data"])
    return mp3_data.getvalue()


if __name__ == "__main__":
    init_vad()
    vad = SileroVADDetector()
    test_chunk = np.zeros(512, dtype=np.int16).tobytes()
    prob = vad.is_speech(test_chunk)
    print(f"Kiểm tra VAD im lặng: prob={prob:.4f}")
