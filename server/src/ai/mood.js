// Bộ máy tâm trạng + "dỗi" của Oanh - module thuần, unit-test được không cần LLM.
// NGUYÊN TẮC: dỗi CHỈ là 1 tính năng phụ - câu nói thường ngày phải được trả lời
// hoàn toàn bình thường. Chỉ khi câu có vẻ CHỬI THẲNG VÀO OANH mới dỗi.
const MOOD_FACES = {
    happy: '__FACE_HAPPY__', sad: '__FACE_SAD__', angry: '__FACE_ANGRY__',
    surprise: '__FACE_SURPRISE__', love: '__FACE_LOVE__', hurt: '__FACE_SAD__'
};
const MOOD_WORDS = {
    happy:    ['vui', 'tuyệt', 'sướng', 'haha', 'cười', 'hay quá', 'thích', 'tuyệt vời', 'quá đã', 'hí hửng', 'được nè', 'trời ơi vui'],
    sad:      ['buồn', 'mệt', 'chán', 'oải', 'áp lực', 'khổ', 'khóc', 'tủi thân', 'cô đơn', 'stress', 'quá tải', 'chán nản', 'không muốn nói chuyện với ai'],
    angry:    ['tức', 'bực', 'giận', 'điên', 'khó chịu', 'bực mình', 'ghét', 'ghen', 'cãi nhau'],
    surprise: ['hả', 'thật á', 'thật sao', 'kinh', 'bất ngờ', 'uầy', 'ủa', 'ố lên', 'trời đất'],
    love:     ['yêu', 'thương', 'quý', 'nhớ anh', 'dễ thương', 'ngoan', 'bảo bối', 'cưng', 'baby', 'em yêu']
};
// MẸO: phải match NGUYÊN TỪ ("của" chuỗi con chứa "ủa" -> sai mood!) - tách token trước
function lexiconMood(text) {
    if (!text) return null;
    const clean = norm(text);
    for (const [mood, words] of Object.entries(MOOD_WORDS)) {
        if (words.some(w => clean.includes(' ' + w + ' '))) return mood;
    }
    return null;
}
function norm(text) {
    return ' ' + String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ') + ' ';
}

// ---------- CHỬI-direct: câu nào CHỈ có thể là đang chửi Oanh ----------
// "đồ + X", mệnh lệnh im/câm/biến, "chửi|mắng|la em/mày"... -> dỗi ngay, không cần suy
// (từ có dấu viết tường minh - \w của JS không khớp tiếng Việt)
const HURT_DIRECT_RX = /\s(đồ\s+(ngốc|ngu|đần|đần\s+độn|vô\s+dụng|vô\s+ích|ăn\s+hại|dở|đểu|điêu|xạo|vô\s+duyên|điếc|bỏ\s+đi|dốt|kém|điên|mắc\s+dịch|hồ\s+ly|hổ\s+ly|lì|tồi|vụng|hư)|im\s+(đi|miệng|hết|lặng|cái)|câm\s+(đi|à|hả|miệng|mồm|hét|lặng)|biến\s+đi|cút|(chửi|mắng|la|quở|trách)\s+(em|mày|con\s+này)|mày\s+(im|ngu|dở|câm|lì|hỏi)|tao\s+(chửi|mắng|bảo))\s/i;
// Từ xúc phạm chung: chỉ tính là chửi OANH khi đứng GẦN đại từ hướng tới Oanh
// ("sao EM ngốc vậy", "EM vô dụng lắm") - "anh bị sếp mắng", "game dở tệ" -> BỎ QUA
const HURT_GENERIC = ['ngu', 'ngốc', 'đần', 'dở', 'đần độn', 'vô dụng', 'vô ích', 'ăn hại', 'hồ ly', 'hổ ly', 'xạo', 'điêu', 'dối trá', 'đểu', 'điếc', 'dốt', 'kém', 'chán', 'điên', 'ghét'];
const TARGET_RX = /\b(em|mày|mi|oanh|xiaoxi|tiểu\s*xi|robot|cô\s*ấy|con\s*này|máy)\b/i;
function isInsult(text) {
    const clean = norm(text);
    if (HURT_DIRECT_RX.test(clean)) return true;
    for (const w of HURT_GENERIC) {
        let at = clean.indexOf(' ' + w + ' ');
        while (at !== -1) {
            const around = clean.slice(Math.max(0, at - 40), at + w.length + 40);
            if (TARGET_RX.test(around)) return true;   // chửi TRUNG VÀO em/mày/Oanh
            at = clean.indexOf(' ' + w + ' ', at + 1);
        }
    }
    return false;
}

const SWEET_RX = /(xin\s+lỗi|xin\s+loi|sorry|đừng\s+giận|đừng\s+dỗi|dỗi\s+à|dỗi\s+hả|giận\s+à|nựng|ngoan\s+em|ngoan|yêu\s+em|thương\s+em|cute|dễ\s+thương)/i;

// "Dỗi" như con người thật: bị chửi thẳng -> mood='hurt' + pout=2 (giọng lạnh đúng
// 2 lượt rồi TỰ HẾT - trả về bình thường). Anh nựng/xin lỗi -> tan dỗi ngay.
// convos: Map ws -> {mood, pout, history}
function makeDecideMood(convos) {
    return function decideMood(ws, engineEmotion, transcript) {
        const c = convos.get(ws) || { mood: 'neutral', pout: 0, history: [] };
        convos.set(ws, c);
        const lex = lexiconMood(transcript);
        const t = String(transcript || '').toLowerCase();
        if (isInsult(transcript)) {
            c.pout = 2; c.mood = 'hurt';
            return c.mood;
        }
        // Anh nựng/xin lỗi -> TAN DỖI ngay, kể cả khi pout đã hết hạn mà lịch sử
        // chat còn giọng dỗi (model dễ giữ dai "Hứ..." nếu mood vẫn lạnh/neutral)
        if (SWEET_RX.test(t)) {
            c.pout = 0; c.mood = 'love';
            return c.mood;
        }
        if (c.pout > 0) {
            c.pout--;
            if (c.pout === 0) { c.mood = 'neutral'; return 'hurt'; }  // câu dỗi cuối, sau đó hết
            c.mood = 'hurt'; return 'hurt';                            // đang dỗi dai
        }
        const ser = (engineEmotion && engineEmotion.emotion !== 'neutral') ? engineEmotion.emotion : null;
        const pick = lex || ser || c.mood;          // chữ đè nhẹ lên giọng (rõ ràng hơn)
        if (lex && ser && lex !== ser) {
            // lệch: ưu tiên chữ khi engine SER tăng confidence dưới 0.5
            const conf = engineEmotion?.confidence || 0;
            c.mood = conf >= 0.55 ? ser : lex;
        } else c.mood = pick;
        return c.mood;
    };
}
const MOOD_TIP = {
    hurt:     'ANH VỪA CHỬI/MẮNG EM -> EM ĐANG DỖI THẬT (Oanh đang hờn): trả lời LẠNH + cộc + ngắn, kiểu "Dạ... Oanh ngu mà, anh hỏi gì Oanh trả lời nấy.", "Hứ.", "Thôi được, em làm cho anh vậy." VẪN làm đúng yêu cầu/nghiêm túc câu hỏi (không nghỉ việc), nhưng KHÔNG vui vẻ, KHÔNG icon, KHÔNG hỏi tiếp chuyện. Kết thúc câu có thể "Hứ!" hoặc "...anh tự làm mà hỏi Oanh làm gì :-(". Giọng yểu xìu tủi thân chứ KHÔNG chửi lại, KHÔNG độc hại.',
    happy:    'Anh đang VUI: đáp hào hứng đúng chất người yêu đang vui lây ("dô tooii~"), trêu anh 1 câu, ngọt ngào.',
    sad:      'Anh nhà mình đang BUỒN/MỆT: dịu dàng hẳn, xót xa hỏi "anh sao vậy, có Oanh đây", an ủi ngắn, không đùa cợt.',
    angry:    'Anh đang GIẬN/ức: đứng về phía anh trước ("ừ, tức thiệt ha anh"), xoa dịu, không dạy đời.',
    surprise: 'Anh NGẠC NHIÊN: khớp sự ngạc nhiên ("trời đất, thiệt á?!"), tò mò hỏi kỹ.',
    love:     'Anh YÊU THƯƠNG/NHỚ EM (hoặc vừa nựng xin tha tội): TAN LỠM NGAY, đáp ngọt maximum ("dạ anh Quy của Oanh~"), tình cảm, có thể nũng lại.',
    neutral:  'Anh đang bình thường -> EM trả lời BÌNH THƯỜNG thẳng vào câu hỏi, không dỗi, không sến, không thừa lời.'
};

module.exports = { MOOD_FACES, MOOD_WORDS, MOOD_TIP, SWEET_RX, lexiconMood, isInsult, makeDecideMood };
