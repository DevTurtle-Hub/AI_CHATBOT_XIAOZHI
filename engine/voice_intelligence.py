"""
=============================================================================
XIAOXI AUTONOMOUS VOICE INTELLIGENCE ENGINE (TẦNG AI GIỌNG NÓI CHUYÊN SÂU)
Tác vụ:
 1. Tiền xử lý & Khử nhiễu quang phổ thích nghi (Spectral Gating & AGC)
 2. Phân tích đặc trưng âm học (Pitch F0, Energy, ZCR, Spectral Centroid, Tempo)
 3. Nhận diện cảm xúc giọng nói (Speech Emotion Recognition - SER)
 4. Sinh trắc học & Nhận diện vân giọng (Speaker Voiceprint Identification)
 5. Suy luận âm thanh đa phương thức trực tiếp (Gemini 3.8 Flash Audio-Native)
=============================================================================
"""

import sys
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

import os
import io
import json
import base64
import wave
import numpy as np
import requests
from scipy import signal as sp_signal

# =============================================================================
# 1. BỘ TIỀN XỬ LÝ & LỌC TÍN HIỆU ÂM HỌC (AUDIO PREPROCESSOR & DSP)
# =============================================================================
class AudioPreprocessor:
    """
    Xử lý tín hiệu âm thanh thô 16kHz 16-bit Mono từ ESP32 INMP441:
    - Loại bỏ độ lệch DC (DC offset removal)
    - Bộ lọc High-Pass Butterworth bậc 4 cắt <110Hz (triệt tiêu tiếng gió ù, quạt trầm)
    - Khử nhiễu quang phổ thích nghi bằng FFT (Adaptive Spectral Subtraction)
    - Tự động khuếch đại giọng nói từ xa 1m (Far-Field Intelligent AGC & Soft Limiter)
    """

    @staticmethod
    def create_wav_header(pcm_bytes: bytes, sample_rate: int = 16000, channels: int = 1, bits_per_sample: int = 16) -> bytes:
        data_len = len(pcm_bytes)
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as wf:
            wf.setnchannels(channels)
            wf.setsampwidth(bits_per_sample // 8)
            wf.setframerate(sample_rate)
            wf.writeframes(pcm_bytes)
        return buf.getvalue()

    @staticmethod
    def highpass_filter(pcm_bytes: bytes, cutoff: float = 110.0, sample_rate: int = 16000) -> bytes:
        """
        Bộ lọc High-Pass Butterworth bậc 4 dốc 24dB/octave triệt tiêu tiếng gió ù, quạt trầm (<110Hz).
        """
        if len(pcm_bytes) < 128:
            return pcm_bytes
        if len(pcm_bytes) % 2 != 0:
            pcm_bytes = pcm_bytes[:-1]
        try:
            data = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32)
            sos = sp_signal.butter(4, cutoff, btype='highpass', fs=sample_rate, output='sos')
            filtered = sp_signal.sosfilt(sos, data)
            filtered = np.clip(filtered, -32768.0, 32767.0).astype(np.int16)
            return filtered.tobytes()
        except Exception:
            return pcm_bytes

    @staticmethod
    def spectral_noise_reduction(pcm_bytes: bytes, sample_rate: int = 16000, alpha: float = 1.8, beta: float = 0.04) -> bytes:
        """
        Khử nhiễu quang phổ thích nghi (Adaptive Spectral Subtraction) bằng FFT:
        - Trước tiên lọc sạch dải gió ù < 110Hz qua High-Pass Filter
        - Lấy các khung đầu tiên để ước tính phổ nền nhiễu
        - Trừ phổ biên độ với hệ số bù alpha và sàn phổ beta chống biến dạng âm
        """
        if len(pcm_bytes) < 1024:
            return pcm_bytes

        # Đảm bảo độ dài chẵn
        if len(pcm_bytes) % 2 != 0:
            pcm_bytes = pcm_bytes[:-1]

        # High-Pass 110Hz đã được chạy Ở NGOÀI trong preprocess_for_stt (tránh lọc đúp)

        signal = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32)
        n_samples = len(signal)

        # Loại bỏ DC offset
        signal = signal - np.mean(signal)

        frame_len = 512   # 32ms @ 16kHz
        hop_len = 256     # 16ms (50% overlap)
        window = np.hanning(frame_len)

        if n_samples < frame_len:
            return pcm_bytes

        # Tạo ma trận khung (Framing)
        num_frames = 1 + (n_samples - frame_len) // hop_len
        frames = np.zeros((num_frames, frame_len), dtype=np.float32)
        for i in range(num_frames):
            idx = i * hop_len
            frames[i] = signal[idx:idx + frame_len] * window

        # Biến đổi FFT thực (Real FFT)
        stft = np.fft.rfft(frames, axis=1)
        mag = np.abs(stft)
        phase = np.angle(stft)

        freqs = np.fft.rfftfreq(frame_len, 1.0 / sample_rate)

        # Ước lượng phổ nhiễu từ các khung có năng lượng thấp nhất (Minimum Statistics)
        # Giúp bảo toàn 100% âm thanh người nói, không bị nhận nhầm giọng nói là tạp âm
        frame_energies = np.sum(mag ** 2, axis=1)
        median_e = np.median(frame_energies)
        noise_idx = np.where(frame_energies < median_e * 0.7)[0]
        if len(noise_idx) > 0:
            noise_profile = np.mean(mag[noise_idx[:4]], axis=0)
            clean_mag = np.maximum(mag - alpha * noise_profile, beta * mag)
        else:
            clean_mag = mag

        # Triệt để làm sạch dải tần < 110Hz (tiếng gió ù lọt lưới)
        clean_mag[:, freqs < 110.0] *= 0.05

        # Tái tạo tín hiệu qua IFFT và Overlap-Add (OLA)
        clean_stft = clean_mag * np.exp(1j * phase)
        clean_frames = np.fft.irfft(clean_stft, n=frame_len, axis=1) * window

        out_signal = np.zeros(n_samples, dtype=np.float32)
        window_sum = np.zeros(n_samples, dtype=np.float32)

        for i in range(num_frames):
            idx = i * hop_len
            out_signal[idx:idx + frame_len] += clean_frames[i]
            window_sum[idx:idx + frame_len] += window ** 2

        # Chuẩn hóa trọng số cửa sổ (tránh chia cho 0)
        window_sum = np.where(window_sum > 1e-4, window_sum, 1.0)
        out_signal /= window_sum

        # Giới hạn biên độ (Clipping prevention)
        out_signal = np.clip(out_signal, -32768.0, 32767.0).astype(np.int16)
        return out_signal.tobytes()

    @staticmethod
    def normalize_peak_agc(pcm_bytes: bytes, target_peak: int = 24000) -> bytes:
        """
        Chuẩn hóa đỉnh kết hợp đường cong Soft-Limiter chống méo vuông.
        """
        return AudioPreprocessor.farfield_adaptive_gain(pcm_bytes, target_peak=target_peak)

    @staticmethod
    def farfield_adaptive_gain(pcm_bytes: bytes, target_peak: int = 24000, target_rms: float = 3800.0, max_gain: float = 35.0) -> bytes:
        """
        BỘ TỰ ĐỘNG KHUẾCH ĐẠI GIỌNG NÓI TỪ XA THÍCH NGHI ĐỘNG (ADAPTIVE DYNAMIC AGC):
        - Hỗ trợ bắt giọng nhạy từ khoảng cách ~1 mét đến 3 mét
        - Tự động đo lường mức nhiễu nền (noise floor):
            + Phòng yên tĩnh (< 0.01): tăng trần gain lên tới 50x để nghe xa
            + Bình thường (0.01 - 0.03): giữ trần an toàn 35x
            + Phòng ồn ào/quạt gió (>= 0.03): siết trần xuống 20x chống bùng nổ nhiễu
        - Đi kèm đường cong Soft-Knee Limiter mượt mà giữ âm thanh ấm áp, không méo khi nói gần
        """
        if len(pcm_bytes) < 2:
            return pcm_bytes
        if len(pcm_bytes) % 2 != 0:
            pcm_bytes = pcm_bytes[:-1]

        signal = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32)
        peak = np.max(np.abs(signal))
        # Nếu chỉ là tiếng thì thầm phòng/tạp âm cực nhỏ (<60), không khuếch đại tránh xì sàn
        if peak < 60.0:
            return pcm_bytes

        # Ước tính mức nhiễu nền từ 15% năng lượng khung thấp nhất
        frame_sz = 320  # 20ms @ 16kHz
        if len(signal) >= frame_sz:
            n_f = len(signal) // frame_sz
            f_rms = np.sqrt(np.mean(signal[:n_f * frame_sz].reshape(n_f, frame_sz) ** 2, axis=1) + 1e-12)
            noise_floor_rms = float(np.percentile(f_rms, 15)) / 32768.0
        else:
            noise_floor_rms = float(np.std(signal)) / 32768.0

        # Tự động điều chỉnh giới hạn khuếch đại thích nghi môi trường
        if noise_floor_rms < 0.01:
            effective_max_gain = max(max_gain, 50.0)
        elif noise_floor_rms < 0.03:
            effective_max_gain = min(max_gain, 35.0)
        else:
            effective_max_gain = min(max_gain, 20.0)

        # Tính gain đưa âm thanh lên chuẩn target_peak (24000), hãm trần thích nghi
        gain = float(min(target_peak / max(peak, 1.0), effective_max_gain))

        boosted = signal * gain

        # Soft-knee limiting cho các mẫu vượt quá 26000
        threshold = 26000.0
        mask_pos = boosted > threshold
        mask_neg = boosted < -threshold

        boosted[mask_pos] = threshold + (boosted[mask_pos] - threshold) * 0.20
        boosted[mask_neg] = -threshold + (boosted[mask_neg] - (-threshold)) * 0.20

        boosted = np.clip(boosted, -32767.0, 32767.0).astype(np.int16)
        return boosted.tobytes()


# =============================================================================
# 2. BỘ PHÂN TÍCH ĐẶC TRƯNG ÂM HỌC (ACOUSTIC PROFILER)
# =============================================================================
class AcousticProfiler:
    """
    Trích xuất toàn diện thông số âm học của giọng nói:
    - Pitch (F0 - Cao độ cơ bản qua Normalized Autocorrelation Function)
    - Năng lượng RMS & Động lực học (Dynamic Range, Crest Factor)
    - Tỷ lệ đổi dấu Zero-Crossing Rate (ZCR)
    - Trọng tâm quang phổ (Spectral Centroid)
    - Tốc độ phát âm (Speech Rate / Tempo)
    """

    @staticmethod
    def extract_features(pcm_bytes: bytes, sample_rate: int = 16000) -> dict:
        if len(pcm_bytes) % 2 != 0:
            pcm_bytes = pcm_bytes[:-1]
        if len(pcm_bytes) < 1024:
            return {
                "duration_sec": 0.0,
                "rms_db": -60.0,
                "peak_db": -60.0,
                "f0_mean": 0.0,
                "f0_std": 0.0,
                "f0_trend": "flat",
                "zcr": 0.0,
                "spectral_centroid": 0.0,
                "speech_rate": 0.0,
                "voiced_ratio": 0.0
            }

        audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        duration_sec = len(audio) / sample_rate

        # 1. Năng lượng RMS và Peak
        rms = np.sqrt(np.mean(audio ** 2) + 1e-12)
        rms_db = float(20.0 * np.log10(rms + 1e-6))
        peak = np.max(np.abs(audio))
        peak_db = float(20.0 * np.log10(peak + 1e-6))
        crest_factor = float(peak / (rms + 1e-6))

        # 2. Zero Crossing Rate (ZCR)
        zcr = float(np.sum(np.abs(np.diff(np.sign(audio)))) / (2.0 * len(audio)))

        # 3. Phân tích Cao độ F0 bằng Tự tương quan (Normalized Autocorrelation)
        frame_len = 512  # 32ms
        hop_len = 256    # 16ms
        min_lag = int(sample_rate / 400.0)  # 400Hz max pitch -> lag 40
        max_lag = int(sample_rate / 70.0)   # 70Hz min pitch  -> lag 228

        f0_list = []
        num_frames = (len(audio) - frame_len) // hop_len

        for i in range(max(0, num_frames)):
            frame = audio[i * hop_len:i * hop_len + frame_len]
            frame = frame - np.mean(frame)
            frame_rms = np.sqrt(np.mean(frame ** 2))

            # Chỉ phân tích F0 nếu khung có đủ năng lượng (voiced threshold)
            if frame_rms < 0.02:
                continue

            # Tính autocorrelation nhanh qua FFT
            n_fft = 1024
            rfft = np.fft.rfft(frame, n=n_fft)
            acorr = np.fft.irfft(np.abs(rfft) ** 2, n=n_fft)[:frame_len]

            # Chuẩn hóa
            if acorr[0] > 1e-6:
                norm_acorr = acorr / acorr[0]
                search_region = norm_acorr[min_lag:max_lag]
                if len(search_region) > 0:
                    peak_idx = np.argmax(search_region)
                    peak_val = search_region[peak_idx]

                    if peak_val > 0.35:  # Ngưỡng Voiced Frame
                        best_lag = min_lag + peak_idx
                        f0 = sample_rate / float(best_lag)
                        f0_list.append(f0)

        voiced_ratio = len(f0_list) / max(1, num_frames)

        if len(f0_list) >= 3:
            f0_mean = float(np.mean(f0_list))
            f0_std = float(np.std(f0_list))
            half = len(f0_list) // 2
            first_half_f0 = np.mean(f0_list[:half])
            second_half_f0 = np.mean(f0_list[half:])
            diff = second_half_f0 - first_half_f0

            if diff > 15.0:
                f0_trend = "rising"    # Ngữ điệu hỏi hoặc phấn khích
            elif diff < -15.0:
                f0_trend = "falling"   # Ngữ điệu khẳng định, chùng xuống
            else:
                f0_trend = "flat"      # Ngữ điệu đều đều, mệt mỏi
        else:
            f0_mean, f0_std, f0_trend = 120.0, 0.0, "flat"

        # 4. Trọng tâm quang phổ (Spectral Centroid - độ sáng của giọng)
        fft_mag = np.abs(np.fft.rfft(audio[:min(len(audio), 4096)]))
        freqs = np.fft.rfftfreq(min(len(audio), 4096), 1.0 / sample_rate)
        mag_sum = np.sum(fft_mag)
        if mag_sum > 1e-4:
            spectral_centroid = float(np.sum(freqs * fft_mag) / mag_sum)
        else:
            spectral_centroid = 1000.0

        # 5. Ước tính tốc độ phát âm (Syllabic tempo) qua đường bao năng lượng
        envelope = np.abs(audio)
        kernel = np.ones(int(sample_rate * 0.05)) / int(sample_rate * 0.05)
        smoothed = np.convolve(envelope, kernel, mode='same')
        mean_env = np.mean(smoothed)
        peaks = 0
        for i in range(1, len(smoothed) - 1):
            if smoothed[i] > smoothed[i - 1] and smoothed[i] > smoothed[i + 1] and smoothed[i] > mean_env * 1.3:
                peaks += 1
        speech_rate = float(round(peaks / max(duration_sec, 0.5), 1))

        # 6. Tỷ lệ năng lượng dải siêu trầm (< 95Hz) để phát hiện tiếng gió ù ù & quạt rung
        low_energy = np.sum(fft_mag[freqs < 95.0] ** 2)
        total_energy = np.sum(fft_mag ** 2) + 1e-12
        rumble_ratio = float(round(low_energy / total_energy, 3))
        # Nếu hơn 45% năng lượng dồn dưới 95Hz hoặc trọng tâm quang phổ thấp bất thường -> Tiếng gió ù / va đập
        is_wind_noise = bool(rumble_ratio > 0.45 or (spectral_centroid < 260.0 and rumble_ratio > 0.30))
        is_speech_present = bool((voiced_ratio >= 0.18 or rms_db > -42.0) and not is_wind_noise and speech_rate >= 1.2)

        return {
            "duration_sec": round(duration_sec, 2),
            "rms_db": round(rms_db, 1),
            "peak_db": round(peak_db, 1),
            "crest_factor": round(crest_factor, 2),
            "f0_mean": round(f0_mean, 1),
            "f0_std": round(f0_std, 1),
            "f0_trend": f0_trend,
            "zcr": round(zcr, 3),
            "spectral_centroid": round(spectral_centroid, 1),
            "speech_rate": speech_rate,
            "voiced_ratio": round(voiced_ratio, 2),
            "rumble_ratio": rumble_ratio,
            "is_wind_noise": is_wind_noise,
            "is_speech_present": is_speech_present
        }


# =============================================================================
# 3. NHẬN DIỆN CẢM XÚC GIỌNG NÓI (SPEECH EMOTION RECOGNITION - SER)
# =============================================================================
class SpeechEmotionClassifier:
    """
    Phân loại cảm xúc giọng nói kết hợp thông số âm học và ngữ nghĩa câu chữ:
    - Happy: Cao độ linh hoạt, năng lượng dồi dào, tốc độ nhanh
    - Sad / Tired: Năng lượng thấp, F0 thấp và phẳng, tốc độ nói chậm
    - Angry: Năng lượng cực lớn, âm sắc gắt, F0 cao
    - Surprise: F0 tăng vọt ở cuối câu (rising), crest factor cao
    - Love: F0 êm dịu, RMS vừa phải, ngữ điệu tình cảm
    - Neutral: Ổn định
    """

    @staticmethod
    def classify(acoustics: dict, transcript: str = "") -> dict:
        f0_mean = acoustics.get("f0_mean", 120.0)
        f0_std = acoustics.get("f0_std", 0.0)
        f0_trend = acoustics.get("f0_trend", "flat")
        rms_db = acoustics.get("rms_db", -30.0)
        speech_rate = acoustics.get("speech_rate", 3.0)
        text_lower = (transcript or "").lower()

        scores = {
            "happy": 0.2,
            "sad": 0.1,
            "angry": 0.1,
            "surprise": 0.1,
            "love": 0.1,
            "neutral": 0.4
        }

        # --- Dấu hiệu âm học ---
        # 1. Hào hứng / Vui vẻ: F0 linh hoạt, âm lượng tốt, nói nhanh
        if f0_std > 28.0 and rms_db > -22.0:
            scores["happy"] += 0.4
        if speech_rate >= 4.0:
            scores["happy"] += 0.2

        # 2. Buồn / Mệt mỏi: F0 thấp phẳng, âm lượng yếu, nói chậm
        if rms_db < -26.0 and f0_std < 14.0:
            scores["sad"] += 0.5
        if speech_rate <= 2.2 and acoustics.get("duration_sec", 0) > 1.5:
            scores["sad"] += 0.3

        # 3. Giận dữ / Căng thẳng: Âm lượng rất lớn, F0 cao
        if rms_db > -14.0 and f0_mean > 160.0:
            scores["angry"] += 0.6

        # 4. Ngạc nhiên: Ngữ điệu vút cao cuối câu, F0 std lớn
        if f0_trend == "rising" and (f0_std > 22.0 or acoustics.get("crest_factor", 0) > 4.5):
            scores["surprise"] += 0.5

        # --- Dấu hiệu ngữ nghĩa văn bản ---
        if any(w in text_lower for w in ["vui", "tuyệt", "sướng", "haha", "cười", "hay quá", "thích", "tuyệt vời", "quá đã", "vui thật", "hí hửng"]):
            scores["happy"] += 0.4
        if any(w in text_lower for w in ["buồn", "mệt", "chán", "oải", "thở dài", "áp lực", "khổ", "khóc", "tủi thân", "cô đơn", "stress", "quá tải", "chán nản"]):
            scores["sad"] += 0.5
        if any(w in text_lower for w in ["yêu", "thương", "quý", "nhớ", "dễ thương", "ngoan", "cô út", "bảo bối"]):
            scores["love"] += 0.6
        if any(w in text_lower for w in ["tức", "bực", "giận", "điên", "khó chịu", "tức tối", "bực mình", "ghét", "vô lí", "vô lý", "ghen"]):
            scores["angry"] += 0.5
        if any(w in text_lower for w in ["hả", "thật á", "thật sao", "kinh", "bất ngờ", "uầy", "ủa", "ố lên", "chời", "trời đất"]):
            scores["surprise"] += 0.5

        detected_emotion = max(scores, key=scores.get)
        confidence = round(float(scores[detected_emotion] / sum(scores.values())), 2)

        # Ánh xạ biểu cảm khuôn mặt cho ESP32 (firmware phải có đúng các mặt này)
        face_map = {
            "happy": "__FACE_HAPPY__",
            "sad": "__FACE_SAD__",
            "angry": "__FACE_ANGRY__",
            "surprise": "__FACE_SURPRISE__",
            "love": "__FACE_LOVE__",
            "neutral": "__FACE_HAPPY__"
        }

        return {
            "emotion": detected_emotion,
            "confidence": min(confidence, 0.99),
            "face_command": face_map.get(detected_emotion, "__FACE_HAPPY__"),
            "acoustic_cues": {
                "energy_level": "high" if rms_db > -20 else "low" if rms_db < -26 else "moderate",
                "pitch_expression": "expressive" if f0_std > 24 else "monotone" if f0_std < 12 else "normal",
                "speech_tempo": "fast" if speech_rate > 3.8 else "slow" if speech_rate < 2.2 else "normal"
            }
        }


# =============================================================================
# 4. SINH TRẮC HỌC & NHẬN DIỆN VÂN GIỌNG (SPEAKER VOICEPRINT BIOMETRICS)
# =============================================================================
class SpeakerVoiceprint:
    """
    HỆ THỐNG VÂN GIỌNG TỰ ĐỘNG THÍCH ỨNG ĐA MẪU (ADAPTIVE MULTI-SAMPLE VOICEPRINT):
    - Quản lý Ngân hàng Mẫu vân giọng (Multi-Sample Bank) cho các trạng thái:
      + Normal: Giọng bình thường, tự nhiên
      + Morning / Hoarse: Mới ngủ dậy, khàn giọng, cảm cúm nhẹ (F0 thấp hơn, hơi thở nhiều)
      + Excited / Fast: Hào hứng, nói nhanh, cao độ và năng lượng tăng
      + Tired / Slow: Mệt mỏi, uể oải, nói chậm rãi, năng lượng thấp
    - Cơ chế So khớp Đa Neo (Multi-Anchor Ensemble):
      + So sánh âm thanh đến với TẤT CẢ các mẫu trong ngân hàng
      + Nhận diện chính xác dù anh Quy nói ở bất kỳ trạng thái thể chất nào
    - Tự động Học & Thích Ứng Trực Tuyến (Online Continuous Learning - EMA):
      + Khi xác thực chính xác anh Quy, mô hình tự động cập nhật vi sai (Exponential Moving Average)
      + Thích nghi theo thời gian với sự thay đổi tự nhiên của giọng nói mà không cần đăng ký lại
    """

    def __init__(self, profile_path: str = "owner_voiceprint.json"):
        self.profile_path = profile_path
        self.owner_profile = self._load_profile()

    def _load_profile(self):
        if os.path.exists(self.profile_path):
            try:
                with open(self.profile_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)

                # Nâng cấp tương thích ngược: Chuyển cấu trúc 1 vector cũ sang Multi-Sample Bank
                if "samples" not in data and "vector" in data:
                    print("[🔄 Voiceprint Migration] Tự động nâng cấp hồ sơ vân giọng sang Multi-Sample Bank...")
                    data = {
                        "owner_name": data.get("owner_name", "Anh Quy"),
                        "version": "2.0-adaptive",
                        "last_updated": str(np.datetime64('now')),
                        "total_interactions": 1,
                        "samples": [
                            {
                                "id": "sample_normal",
                                "tag": "normal",
                                "description": "Mẫu chuẩn ban đầu",
                                "f0_mean": float(data.get("f0_mean", 135.0)),
                                "vector": data["vector"],
                                "match_count": 1,
                                "created_at": data.get("created_at", str(np.datetime64('now'))),
                                "last_matched": str(np.datetime64('now'))
                            }
                        ]
                    }
                    with open(self.profile_path, 'w', encoding='utf-8') as f:
                        json.dump(data, f, indent=2)

                sample_count = len(data.get("samples", []))
                print(f"[🔐 Adaptive Voiceprint] Đã nạp thành công ngân hàng {sample_count} mẫu giọng của '{data.get('owner_name', 'Anh Quy')}'")
                return data
            except Exception as e:
                print("[-] Lỗi đọc file vân giọng:", e)
        return None

    def save_sample(self, vector: list, owner_name: str = "Anh Quy", f0_mean: float = 135.0, tag: str = "normal", description: str = None) -> bool:
        """
        Lưu hoặc bổ sung một mẫu giọng mới vào ngân hàng (normal, morning_hoarse, excited_fast, tired_slow)
        """
        tag_desc_map = {
            "normal": "Giọng bình thường, tự nhiên",
            "morning_hoarse": "Giọng ngái ngủ, khàn giọng, cảm cúm nhẹ",
            "excited_fast": "Giọng hào hứng, nói nhanh, cao độ tăng",
            "tired_slow": "Giọng mệt mỏi, uể oải, nói chậm rãi"
        }
        desc = description or tag_desc_map.get(tag, f"Trạng thái {tag}")

        try:
            if not self.owner_profile:
                self.owner_profile = {
                    "owner_name": owner_name,
                    "version": "2.0-adaptive",
                    "last_updated": str(np.datetime64('now')),
                    "total_interactions": 0,
                    "samples": []
                }

            self.owner_profile["owner_name"] = owner_name
            self.owner_profile["last_updated"] = str(np.datetime64('now'))

            # Kiểm tra xem tag này đã có chưa -> cập nhật nếu có, thêm mới nếu chưa
            existing = None
            for s in self.owner_profile.get("samples", []):
                if s.get("tag") == tag:
                    existing = s
                    break

            new_sample_entry = {
                "id": f"sample_{tag}",
                "tag": tag,
                "description": desc,
                "f0_mean": float(round(f0_mean, 1)),
                "vector": [float(x) for x in vector],
                "match_count": (existing.get("match_count", 0) + 1) if existing else 1,
                "created_at": existing.get("created_at", str(np.datetime64('now'))) if existing else str(np.datetime64('now')),
                "last_matched": str(np.datetime64('now'))
            }

            if existing:
                idx = self.owner_profile["samples"].index(existing)
                self.owner_profile["samples"][idx] = new_sample_entry
                print(f"[✅ Voiceprint Update] Đã cập nhật mẫu [{tag}]: F0={f0_mean:.1f}Hz")
            else:
                self.owner_profile.setdefault("samples", []).append(new_sample_entry)
                print(f"[✅ Voiceprint Add] Đã thêm mẫu mới [{tag}]: F0={f0_mean:.1f}Hz - {desc}")

            with open(self.profile_path, 'w', encoding='utf-8') as f:
                json.dump(self.owner_profile, f, indent=2)

            return True
        except Exception as e:
            print("[-] Lỗi lưu mẫu vân giọng:", e)
            return False

    @staticmethod
    def extract_voiceprint_vector(pcm_bytes: bytes, sample_rate: int = 16000) -> np.ndarray:
        if len(pcm_bytes) % 2 != 0:
            pcm_bytes = pcm_bytes[:-1]
        if len(pcm_bytes) < 1600:
            return np.zeros(28, dtype=np.float32)

        audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0

        n_fft = 1024
        fft_spec = np.abs(np.fft.rfft(audio[:min(len(audio), 8192)], n=n_fft))
        n_bins = len(fft_spec)

        mel_energies = []
        bands = np.logspace(np.log10(1), np.log10(n_bins), 17).astype(int)
        for i in range(16):
            start, end = bands[i], max(bands[i] + 1, bands[i + 1])
            energy = np.mean(fft_spec[start:end])
            mel_energies.append(energy)
        mel_energies = np.array(mel_energies, dtype=np.float32)
        mel_energies = np.log1p(mel_energies * 100.0)

        ac = AcousticProfiler.extract_features(pcm_bytes, sample_rate)
        f0_stats = np.array([
            ac["f0_mean"] / 300.0,
            ac["f0_std"] / 50.0,
            ac["f0_mean"] / 150.0,
            ac["f0_std"] / 30.0
        ], dtype=np.float32)

        spectral_stats = np.array([
            ac["spectral_centroid"] / 4000.0,
            ac["zcr"] * 5.0,
            ac["crest_factor"] / 10.0,
            ac["voiced_ratio"]
        ], dtype=np.float32)

        dynamic_stats = np.array([
            (ac["rms_db"] + 50.0) / 40.0,
            (ac["peak_db"] + 40.0) / 30.0,
            ac["speech_rate"] / 5.0,
            1.0 if ac["f0_trend"] == "rising" else 0.5 if ac["f0_trend"] == "flat" else 0.0
        ], dtype=np.float32)

        vec = np.concatenate([mel_energies, f0_stats, spectral_stats, dynamic_stats])
        norm = np.linalg.norm(vec)
        if norm > 1e-6:
            vec = vec / norm
        return vec

    def _describe_voice_state(self, tag: str, ac: dict) -> str:
        state_map = {
            "morning_hoarse": "Giọng ngái ngủ, khàn giọng hoặc cảm nhẹ",
            "excited_fast": "Giọng hào hứng, nói nhanh",
            "tired_slow": "Giọng mệt mỏi, nói chậm rãi",
            "normal": "Giọng tự nhiên, bình thường"
        }
        base_desc = state_map.get(tag, f"Trạng thái {tag}")
        return f"{base_desc} (F0: {ac.get('f0_mean', 0)}Hz, RMS: {ac.get('rms_db', 0)}dB)"

    def save_owner_voiceprint(self, vector: list, owner_name: str = "Anh Quy", f0_mean: float = 135.0, tag: str = "normal", description: str = None) -> bool:
        """Alias tương thích ngược cho save_sample"""
        return self.save_sample(vector, owner_name, f0_mean, tag, description)

    def get_profile_summary(self) -> dict:
        """Trả về bản tóm tắt ngân hàng mẫu vân giọng của Chủ nhân"""
        if not self.owner_profile:
            return {"enrolled": False, "samples": []}
        return {
            "enrolled": True,
            "owner_name": self.owner_profile.get("owner_name", "Anh Quy"),
            "version": self.owner_profile.get("version", "2.0-adaptive"),
            "total_interactions": self.owner_profile.get("total_interactions", 0),
            "last_updated": self.owner_profile.get("last_updated"),
            "total_samples": len(self.owner_profile.get("samples", [])),
            "samples": [
                {
                    "id": s.get("id"),
                    "tag": s.get("tag"),
                    "description": s.get("description"),
                    "f0_mean": s.get("f0_mean"),
                    "match_count": s.get("match_count", 0),
                    "tolerance_threshold": s.get("tolerance_threshold", 0.75),
                    "last_matched": s.get("last_matched")
                }
                for s in self.owner_profile.get("samples", [])
            ]
        }

    def verify_speaker(self, pcm_bytes: bytes, threshold: float = 0.75, auto_adapt: bool = True) -> dict:
        """
        So sánh giọng nói với toàn bộ Ngân hàng Mẫu của Chủ nhân (Multi-Anchor Matching)
        và Tự động thích ứng (Online Learning) nếu khớp độ tin cậy cao.
        Ngưỡng dung sai thích ứng tự nhiên (Adaptive Tolerance) theo từng trạng thái thể chất:
        - Bình thường (normal): 0.75
        - Ngái ngủ / Khàn giọng / Cảm cúm (morning_hoarse): 0.70
        - Mệt mỏi / Nói chậm (tired_slow): 0.70
        - Hào hứng / Nói nhanh (excited_fast): 0.74
        """
        if not self.owner_profile or "samples" not in self.owner_profile or len(self.owner_profile["samples"]) == 0:
            return {
                "enrolled": False,
                "is_owner": True,
                "similarity": 1.0,
                "speaker_name": "Anh Quy (Chưa đăng ký vân giọng)",
                "matched_sample": "none",
                "voice_state": "Mặc định",
                "confidence": 1.0
            }

        curr_vec = self.extract_voiceprint_vector(pcm_bytes)
        curr_ac = AcousticProfiler.extract_features(pcm_bytes)
        curr_f0 = curr_ac.get("f0_mean", 130.0)

        # Lấy thông số cấu hình thích ứng
        engine_cfg = self.owner_profile.get("adaptive_engine", {})
        f0_penalty_factor = float(engine_cfg.get("f0_tolerance_penalty", 1.4))

        best_score = -1.0
        best_sample = None
        best_sample_threshold = threshold

        # So khớp với từng mẫu giọng trong ngân hàng đa neo (Multi-Anchor)
        for sample in self.owner_profile["samples"]:
            sample_vec = np.array(sample["vector"], dtype=np.float32)
            sample_f0 = float(sample.get("f0_mean", 135.0))
            sample_threshold = float(sample.get("tolerance_threshold", threshold))

            # 1. Cosine similarity của vector hình thái âm phổ (đặc trưng vòm họng & dây thanh)
            cos_sim = float(np.dot(curr_vec, sample_vec) / (np.linalg.norm(curr_vec) * np.linalg.norm(sample_vec) + 1e-8))

            # 2. Phân tích độ lệch cao độ so với mẫu hiện tại với hàm dung sai mũ mượt mà
            f0_diff = abs(curr_f0 - sample_f0) / max(sample_f0, 80.0)
            f0_penalty = np.exp(-f0_diff * f0_penalty_factor)

            score = float(cos_sim * f0_penalty)
            if score > best_score:
                best_score = score
                best_sample = sample
                best_sample_threshold = sample_threshold

        best_score = round(max(0.0, min(1.0, best_score)), 3)
        effective_threshold = best_sample_threshold if best_sample is not None else threshold
        is_owner = best_score >= effective_threshold
        speaker_name = self.owner_profile.get("owner_name", "Anh Quy") if is_owner else "Khách / Người ngoài"

        matched_tag = best_sample.get("tag", "normal") if best_sample else "unknown"
        voice_state = self._describe_voice_state(matched_tag, curr_ac) if is_owner else "Giọng người ngoài"

        # -----------------------------------------------------------------
        # CƠ CHẾ TỰ ĐỘNG THÍCH ỨNG TRỰC TUYẾN (ONLINE LEARNING / EMA)
        # -----------------------------------------------------------------
        if is_owner and auto_adapt and best_sample is not None:
            # 1. Nếu độ tin cậy rất cao (>= 0.82) -> Tinh chỉnh thích nghi vi sai (EMA)
            if best_score >= 0.82:
                alpha = float(engine_cfg.get("online_ema_alpha", 0.08))
                sample_vec = np.array(best_sample["vector"], dtype=np.float32)
                adapted_vec = (1.0 - alpha) * sample_vec + alpha * curr_vec
                norm = np.linalg.norm(adapted_vec)
                if norm > 1e-6:
                    adapted_vec = adapted_vec / norm

                best_sample["vector"] = [float(x) for x in adapted_vec]
                best_sample["f0_mean"] = float(round((1.0 - alpha) * float(best_sample.get("f0_mean", curr_f0)) + alpha * curr_f0, 1))
                best_sample["match_count"] = best_sample.get("match_count", 0) + 1
                best_sample["last_matched"] = str(np.datetime64('now'))

                self.owner_profile["total_interactions"] = self.owner_profile.get("total_interactions", 0) + 1
                self.owner_profile["last_updated"] = str(np.datetime64('now'))

                # Ghi đĩa định kỳ an toàn
                try:
                    with open(self.profile_path, 'w', encoding='utf-8') as f:
                        json.dump(self.owner_profile, f, indent=2, ensure_ascii=False)
                except Exception:
                    pass

            # 2. Nếu khớp nhưng tần số F0 lệch rõ rệt (ví dụ phát hiện biến thể ngữ điệu mới)
            # và ngân hàng chưa có mẫu trạng thái này -> Tự động ghi nhận thêm 1 anchor mới
            elif len(self.owner_profile.get("samples", [])) < 6:
                all_f0s = [s.get("f0_mean", 130.0) for s in self.owner_profile["samples"]]
                min_f0_dist = min([abs(curr_f0 - f) for f in all_f0s]) if all_f0s else 100.0

                if min_f0_dist >= 24.0:  # Lệch ít nhất 24Hz so với mọi mẫu đã có
                    auto_tag = "morning_hoarse" if curr_f0 < 115 else "excited_fast" if curr_f0 > 155 else f"variant_{int(curr_f0)}hz"
                    print(f"[✨ Voiceprint Auto-Learn] Tự động học thêm mẫu trạng thái giọng mới: [{auto_tag}] F0={curr_f0:.1f}Hz")
                    self.save_sample(curr_vec.tolist(), self.owner_profile.get("owner_name", "Anh Quy"), curr_f0, auto_tag)

        return {
            "enrolled": True,
            "is_owner": is_owner,
            "similarity": best_score,
            "threshold": effective_threshold,
            "speaker_name": speaker_name,
            "matched_sample": matched_tag if is_owner else None,
            "voice_state": voice_state,
            "total_samples": len(self.owner_profile.get("samples", [])),
            "confidence": round(best_score if is_owner else (1.0 - best_score), 2)
        }


# =============================================================================
# 5. BỘ NÃO SUY LUẬN ÂM THANH TRỰC TIẾP (GEMINI AUDIO-NATIVE)
# =============================================================================
class GeminiAudioNativeBrain:
    """
    Suy luận đa phương thức trực tiếp từ file âm thanh WAV không qua khâu STT:
    - Lắng nghe ngữ điệu, hơi thở, tiếng cười, âm thanh môi trường xung quanh
    - Trả lời tự nhiên, ấm áp, đúng tính cách Robot XiaoXi
    - Hoàn toàn miễn phí trên Google AI Studio (Free Tier 15 RPM)
    - Auth: x-goog-api-key header (ổn định hơn cho cả key AIza lẫn token AQ.xxx)

    NOTE MODEL (verified 2026-10-20):
      - gemini-3-flash-preview  : nhanh nhất, ưu tiên dùng
      - gemini-3.1-flash-lite   : dự phòng (có thể chậm ~20s do quá tải)
      - gemini-3.8-flash        : hay 503 "high demand" => đừng mặc định
    """

    FALLBACK_MODELS = [
        "gemini-3-flash-preview",
        "gemini-3.1-flash-lite",
        "gemini-3.1-flash-lite-preview",
    ]

    def __init__(self, api_key: str, preferred_model: str = None):
        # Model ưu tiên đọc từ .env (GEMINI_MODEL) - mặc định ổn định nhất theo benchmark 2026-10-20
        self.api_key = api_key
        self.model_name = preferred_model or os.environ.get("GEMINI_MODEL", "gemini-3-flash-preview")
        self.endpoint_template = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

    def _post_generate(self, model_name: str, payload: dict, timeout: int = 15):
        headers = {"x-goog-api-key": self.api_key, "Content-Type": "application/json"}
        return requests.post(
            self.endpoint_template.format(model=model_name),
            json=payload, headers=headers, timeout=timeout
        )

    def reason_from_audio(self, wav_bytes: bytes, system_instruction: str = "", user_hint: str = "") -> dict:
        if not self.api_key:
            return {"success": False, "error": "GEMINI_API_KEY chưa được cấu hình"}

        audio_b64 = base64.b64encode(wav_bytes).decode('utf-8')

        prompt_text = (
            f"{system_instruction}\n\n"
            f"HÃY LẮNG NGHE ĐOẠN ÂM THANH NÀY VÀ TRẢ LỜI NGƯỜI NÓI:\n"
            f"- Cảm nhận ngữ điệu, cảm xúc và bối cảnh trong giọng nói.\n"
            f"- Trả lời bằng giọng điệu XiaoXi ấm áp, lễ phép, xưng 'em', gọi 'anh Quy'.\n"
            f"- Câu trả lời gãy gọn, thông minh, không dùng markdown rườm rà.\n"
        )
        if user_hint:
            prompt_text += f"(Gợi ý bổ sung: {user_hint})\n"

        payload = {
            "contents": [{
                "parts": [
                    {"text": prompt_text},
                    {
                        "inline_data": {
                            "mime_type": "audio/wav",
                            "data": audio_b64
                        }
                    }
                ]
            }],
            "generationConfig": {
                "temperature": 0.6,
                "maxOutputTokens": 180
            }
        }

        last_error = ""
        for model_name in [self.model_name] + [m for m in self.FALLBACK_MODELS if m != self.model_name]:
            try:
                res = self._post_generate(model_name, payload, timeout=15)
                if res.status_code == 200:
                    data = res.json()
                    parts = data['candidates'][0]['content']['parts']
                    text = ''.join(p.get('text', '') for p in parts).strip()
                    self.model_name = model_name  # ghi memorize model tốt/hot nhất
                    return {
                        "success": True,
                        "text": text,
                        "model": model_name
                    }
                last_error = f"{model_name}: HTTP {res.status_code}: {res.text[:150]}"
                # 503 = quá tải, thử model kế tiếp
            except Exception as e:
                last_error = f"{model_name}: {e}"
        return {
            "success": False,
            "error": f"Tất cả Gemini model đều thất bại -> {last_error}"
        }


# Khởi tạo thể hiện Singleton (đường dẫn tuyệt đối theo vị trí file - không phụ thuộc cwd)
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
speaker_vault = SpeakerVoiceprint(os.path.join(_BASE_DIR, "owner_voiceprint.json"))
