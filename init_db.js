// =========================================================================
// INI DB: Tạo bảng trí nhớ (chạy bằng: node init_db.js)
// =========================================================================
try {
    if (typeof process.loadEnvFile === 'function') process.loadEnvFile();
} catch (e) {}

const { Pool } = require('pg');

const dbURL = process.env.NEON_DB_URL || process.env.DATABASE_URL;
if (!dbURL) {
    console.error('[-] Thiếu biến môi trường NEON_DB_URL / DATABASE_URL trong .env');
    console.error('    Thêm vào .env:  NEON_DB_URL=postgresql://user:pass@host/db?sslmode=require');
    process.exit(1);
}

const pool = new Pool({
    connectionString: dbURL,
    connectionTimeoutMillis: 10000,
    // Neon (PostgreSQL hosted) buộc TLS
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    try {
        console.log('[Neon DB] Đang khởi tạo các bảng dữ liệu trí nhớ...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_memories (
                id SERIAL PRIMARY KEY,
                category VARCHAR(50) NOT NULL,
                key_name VARCHAR(100) NOT NULL,
                content TEXT NOT NULL,
                remind_at TIMESTAMP WITH TIME ZONE NULL,
                is_done BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_memories_cat ON user_memories(category);
            CREATE INDEX IF NOT EXISTS idx_memories_key ON user_memories(key_name);
            CREATE INDEX IF NOT EXISTS idx_memories_done ON user_memories(is_done);
        `);
        console.log('[Neon DB] Khởi tạo bảng user_memories THÀNH CÔNG!');

        // Nhật ký hội thoại - robot nhớ chuyện cũ qua server restart
        await pool.query(`
            CREATE TABLE IF NOT EXISTS chat_log (
                id SERIAL PRIMARY KEY,
                direction VARCHAR(8) NOT NULL,      -- 'user' | 'ai'
                text TEXT NOT NULL,
                mood VARCHAR(16) NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_chatlog_time ON chat_log(created_at);
        `);
        console.log('[Neon DB] Khởi tạo bảng chat_log THÀNH CÔNG!');

        const check = await pool.query('SELECT count(*) FROM user_memories');
        console.log('[Neon DB] Tổng số mục nhớ hiện tại:', check.rows[0].count);
        await pool.end();
        process.exit(0);
    } catch (e) {
        console.error('[-] Lỗi khởi tạo Neon DB:', e.message);
        await pool.end().catch(() => {});
        process.exit(1);
    }
}

initDB();
