// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 8000;
const LOG_FILE = path.join(__dirname, 'server.log');

// Cryptographically secure active sessions storage (in-memory)
const activeSessions = new Set();

// Middleware for parsing JSON body
app.use(express.json({ limit: '10mb' })); // limit JSON payload to protect from Denial of Service (DoS)

// Serve static frontend files safely
app.use(express.static(__dirname));

// Cybersecurity Standard: Logging utility
function writeLog(level, message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    fs.appendFile(LOG_FILE, logMessage, (err) => {
        if (err) console.error('Error writing to log file:', err);
    });
    console.log(`[${level}] ${message}`);
}

// Error formatting helper to handle Node AggregateError (e.g. for connection errors)
function formatError(err) {
    if (!err) return 'Unknown error';
    if (err.errors && Array.isArray(err.errors)) {
        return err.errors.map(e => e.message).join('; ');
    }
    return err.message || err.toString();
}

/* ==========================================================================
   PostgreSQL DATABASE INITIALIZATION
   ========================================================================== */

// Handle SSL requirements for hosted databases (like Railway/Supabase/Neon)
const sslConfig = process.env.DATABASE_URL && 
                  !process.env.DATABASE_URL.includes('localhost') && 
                  !process.env.DATABASE_URL.includes('127.0.0.1')
    ? { rejectUnauthorized: false }
    : false;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslConfig
});

async function initDb() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS reports (
                id SERIAL PRIMARY KEY,
                token VARCHAR(50) UNIQUE NOT NULL,
                date_submitted VARCHAR(50) NOT NULL,
                is_anonim INTEGER NOT NULL DEFAULT 1,
                category VARCHAR(100) NOT NULL,
                title VARCHAR(200) NOT NULL,
                incident_date VARCHAR(50),
                location VARCHAR(200) NOT NULL,
                description TEXT NOT NULL,
                file_name VARCHAR(255),
                file_data TEXT,
                status VARCHAR(50) NOT NULL DEFAULT 'Diajukan',
                reporter_name VARCHAR(100),
                reporter_nik VARCHAR(50),
                reporter_email VARCHAR(100),
                reporter_hp VARCHAR(50)
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS report_history (
                id SERIAL PRIMARY KEY,
                report_token VARCHAR(50) NOT NULL REFERENCES reports(token) ON DELETE CASCADE,
                status VARCHAR(50) NOT NULL,
                note TEXT,
                date VARCHAR(50) NOT NULL,
                is_user_msg INTEGER NOT NULL DEFAULT 0,
                file_name VARCHAR(255),
                file_data TEXT
            );
        `);

        // Check and create indexes safely
        await client.query(`CREATE INDEX IF NOT EXISTS idx_reports_token ON reports(token);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_history_token ON report_history(report_token);`);

        writeLog('SYSTEM', 'PostgreSQL database initialized successfully.');
    } catch (err) {
        writeLog('ERROR', `Failed to initialize PostgreSQL database: ${formatError(err)}`);
        throw err;
    } finally {
        client.release();
    }
}

/* ==========================================================================
   AUTO-MIGRATION: Import existing reports.json/reports_backup.json data to PostgreSQL
   ========================================================================== */

async function migrateFromJson() {
    let jsonPath = path.join(__dirname, 'reports.json');
    if (!fs.existsSync(jsonPath)) {
        jsonPath = path.join(__dirname, 'reports_backup.json');
    }
    
    if (!fs.existsSync(jsonPath)) return;
    
    try {
        const countRes = await pool.query('SELECT COUNT(*) as count FROM reports');
        const count = parseInt(countRes.rows[0].count, 10);
        if (count > 0) {
            writeLog('INFO', `Database already has ${count} reports. Skipping JSON migration.`);
            return;
        }
        
        const jsonData = fs.readFileSync(jsonPath, 'utf8');
        const reports = JSON.parse(jsonData || '[]');
        if (reports.length === 0) return;
        
        writeLog('INFO', `Migrating ${reports.length} reports from ${path.basename(jsonPath)} to PostgreSQL...`);
        
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            const insertReportText = `
                INSERT INTO reports (token, date_submitted, is_anonim, category, title, incident_date, location, description, file_name, file_data, status, reporter_name, reporter_nik, reporter_email, reporter_hp)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                ON CONFLICT (token) DO NOTHING
            `;
            
            const insertHistoryText = `
                INSERT INTO report_history (report_token, status, note, date, is_user_msg, file_name, file_data)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `;
            
            for (const report of reports) {
                await client.query(insertReportText, [
                    report.token,
                    report.dateSubmitted,
                    report.isAnonim ? 1 : 0,
                    report.category,
                    report.title,
                    report.incidentDate,
                    report.location,
                    report.description,
                    report.fileName || null,
                    report.fileData || null,
                    report.status || 'Diajukan',
                    report.reporterName || null,
                    report.reporterNik || null,
                    report.reporterEmail || null,
                    report.reporterHp || null
                ]);
                
                if (report.history && Array.isArray(report.history)) {
                    for (const hist of report.history) {
                        await client.query(insertHistoryText, [
                            report.token,
                            hist.status,
                            hist.note || null,
                            hist.date,
                            hist.isUserMsg ? 1 : 0,
                            hist.fileName || null,
                            hist.fileData || null
                        ]);
                    }
                }
            }
            
            await client.query('COMMIT');
            writeLog('INFO', `Successfully migrated ${reports.length} reports from JSON to PostgreSQL.`);
            
            // Rename reports.json if it exists to avoid running migration from it next time
            const oldJson = path.join(__dirname, 'reports.json');
            if (fs.existsSync(oldJson)) {
                fs.renameSync(oldJson, path.join(__dirname, 'reports_backup.json'));
                writeLog('INFO', `Old reports.json renamed to reports_backup.json as backup.`);
            }
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }
    } catch (err) {
        writeLog('ERROR', `Failed to migrate from JSON to PostgreSQL: ${formatError(err)}`);
    }
}

// Database Startup IIFE
(async () => {
    try {
        await initDb();
        await migrateFromJson();
    } catch (err) {
        writeLog('ERROR', `Database startup failed: ${formatError(err)}`);
    }
})();

/* ==========================================================================
   DATABASE QUERY HELPERS
   ========================================================================== */

// Get a single report with its history (formatted as the frontend expects)
async function getReportByToken(token) {
    const reportRes = await pool.query('SELECT * FROM reports WHERE UPPER(token) = UPPER($1)', [token]);
    if (reportRes.rows.length === 0) return null;
    const report = reportRes.rows[0];
    
    const historyRes = await pool.query('SELECT * FROM report_history WHERE report_token = $1 ORDER BY id ASC', [report.token]);
    
    return {
        token: report.token,
        dateSubmitted: report.date_submitted,
        isAnonim: report.is_anonim === 1,
        category: report.category,
        title: report.title,
        incidentDate: report.incident_date,
        location: report.location,
        description: report.description,
        fileName: report.file_name,
        fileData: report.file_data,
        status: report.status,
        reporterName: report.reporter_name,
        reporterNik: report.reporter_nik,
        reporterEmail: report.reporter_email,
        reporterHp: report.reporter_hp,
        history: historyRes.rows.map(h => ({
            status: h.status,
            note: h.note,
            date: h.date,
            isUserMsg: h.is_user_msg === 1,
            fileName: h.file_name,
            fileData: h.file_data
        }))
    };
}

// Get all reports with their history
async function getAllReports() {
    const reportsRes = await pool.query('SELECT * FROM reports ORDER BY date_submitted DESC');
    const reports = reportsRes.rows;
    
    const result = [];
    for (const report of reports) {
        const historyRes = await pool.query('SELECT * FROM report_history WHERE report_token = $1 ORDER BY id ASC', [report.token]);
        result.push({
            token: report.token,
            dateSubmitted: report.date_submitted,
            isAnonim: report.is_anonim === 1,
            category: report.category,
            title: report.title,
            incidentDate: report.incident_date,
            location: report.location,
            description: report.description,
            fileName: report.file_name,
            fileData: report.file_data,
            status: report.status,
            reporterName: report.reporter_name,
            reporterNik: report.reporter_nik,
            reporterEmail: report.reporter_email,
            reporterHp: report.reporter_hp,
            history: historyRes.rows.map(h => ({
                status: h.status,
                note: h.note,
                date: h.date,
                isUserMsg: h.is_user_msg === 1,
                fileName: h.file_name,
                fileData: h.file_data
            }))
        });
    }
    return result;
}

/* ==========================================================================
   TELEGRAM INTEGRATION
   ========================================================================== */

function sendTelegramNotification(report) {
    // Use env vars with hardcoded fallbacks to ensure Telegram always works
    const botToken = process.env.TELEGRAM_BOT_TOKEN || "8960174423:AAG6fMbo1ZZaTCoLVKAmWOSdNllK-7hqdsM";
    const primaryChatId = process.env.TELEGRAM_CHAT_ID || "-1003944424009";
    
    if (!botToken || !primaryChatId) {
        writeLog('WARN', 'Telegram bot token or chat ID not configured. Skipping notification.');
        return;
    }
    
    writeLog('INFO', `Attempting Telegram notification to chat ID: ${primaryChatId} for token: ${report.token}`);
    
    const chatIds = [primaryChatId];
    
    const formatDate = (isoString) => {
        if (!isoString) return '-';
        try {
            const date = new Date(isoString);
            return date.toLocaleDateString('id-ID', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
        } catch (e) {
            return isoString;
        }
    };

    const text = `🔔 *PENGADUAN BARU WBS* 🔔\n` +
                 `--------------------------------------\n` +
                 `*Token:* \`${report.token}\`\n` +
                 `*Kategori:* ${report.category}\n` +
                 `*Judul:* ${report.title}\n` +
                 `*OPD/Lokasi:* ${report.location}\n` +
                 `*Tanggal Kejadian:* ${formatDate(report.incidentDate)}\n` +
                 `*Tipe Pelapor:* ${report.isAnonim ? 'Anonim (Dirahasiakan)' : 'Identitas Asli'}\n` +
                 `*Kronologi:* \n_${report.description.substring(0, 300)}${report.description.length > 300 ? '...' : ''}_\n` +
                 `--------------------------------------\n` +
                 `Silakan periksa di Dashboard Admin WBS Padang.`;

    const trySend = (index) => {
        if (index >= chatIds.length) {
            writeLog('ERROR', `Failed sending Telegram to all chat IDs. Please ensure the bot has been added to the target group.`);
            return;
        }
        
        const chatId = chatIds[index];
        const data = JSON.stringify({
            chat_id: chatId,
            text: text,
            parse_mode: 'Markdown'
        });

        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${botToken}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    writeLog('WARN', `Telegram send failed for chat ID ${chatId} (status ${res.statusCode}): ${body}. Retrying next ID...`);
                    trySend(index + 1);
                } else {
                    writeLog('INFO', `Telegram notification sent successfully to chat ID ${chatId} for token: ${report.token}`);
                }
            });
        });

        req.on('error', (error) => {
            writeLog('ERROR', `Error sending Telegram message request: ${error.message}`);
            trySend(index + 1);
        });

        req.write(data);
        req.end();
    };

    trySend(0);
}

/* ==========================================================================
   INPUT VALIDATION
   ========================================================================== */

function validateReportInput(report) {
    // Check required fields
    if (!report.category || typeof report.category !== 'string' || report.category.trim() === '') return 'Kategori aduan wajib diisi';
    if (!report.title || typeof report.title !== 'string' || report.title.trim() === '') return 'Judul aduan wajib diisi';
    if (!report.incidentDate || typeof report.incidentDate !== 'string' || report.incidentDate === '') return 'Tanggal kejadian tidak valid';
    if (!report.location || typeof report.location !== 'string' || report.location.trim() === '') return 'Lokasi dinas/OPD wajib diisi';
    if (!report.description || typeof report.description !== 'string' || report.description.trim() === '') return 'Deskripsi aduan wajib diisi';
    
    // Length constraints (Cybersecurity input sanitation)
    if (report.title.length > 150) return 'Judul aduan terlalu panjang (maksimal 150 karakter)';
    if (report.location.length > 200) return 'Lokasi kejadian terlalu panjang (maksimal 200 karakter)';
    if (report.description.length > 5000) return 'Deskripsi kronologi terlalu panjang (maksimal 5000 karakter)';
    
    // File validation: Size and allowed extensions (.pdf, .jpg, .jpeg, .png, .mp4, .mov, .heic)
    if (report.fileName && report.fileName.trim() !== '') {
        const allowedExtensions = ['pdf', 'jpg', 'jpeg', 'png', 'mp4', 'mov', 'heic'];
        const ext = report.fileName.split('.').pop().toLowerCase();
        if (!allowedExtensions.includes(ext)) {
            return 'Format berkas tidak diizinkan. Hanya diperbolehkan: PDF, JPG, JPEG, PNG, MP4, MOV, HEIC.';
        }
        
        if (report.fileData) {
            // Validate base64 length against max 5MB (Base64 string length * 0.75 is actual bytes)
            const sizeInBytes = report.fileData.length * 0.75;
            const maxBytes = 5 * 1024 * 1024;
            if (sizeInBytes > maxBytes) {
                return 'Ukuran berkas melebihi batas maksimal 5MB';
            }
        }
    }
    
    // Non-anonymous reporter details validation
    if (!report.isAnonim) {
        if (!report.reporterName || report.reporterName.trim() === '') return 'Nama pelapor wajib diisi';
        if (!report.reporterNik || !/^\d{16}$/.test(report.reporterNik)) return 'NIK pelapor tidak valid (harus 16 digit angka)';
        if (!report.reporterEmail || !/^\S+@\S+\.\S+$/.test(report.reporterEmail)) return 'Email pelapor tidak valid';
        if (!report.reporterHp || report.reporterHp.length < 9) return 'Nomor handphone tidak valid';
    }
    
    return null;
}

/* ==========================================================================
   ACCESS CONTROL MIDDLEWARE
   ========================================================================== */

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>"
    
    if (!token) {
        writeLog('WARN', `Access denied: Token missing on ${req.method} ${req.url} from ${req.ip}`);
        return res.status(401).json({ success: false, message: 'Akses ditolak: Token tidak ditemukan' });
    }
    
    if (!activeSessions.has(token)) {
        writeLog('WARN', `Access denied: Invalid session token used on ${req.method} ${req.url}`);
        return res.status(403).json({ success: false, message: 'Akses ditolak: Sesi tidak valid' });
    }
    
    next();
}

/* ==========================================================================
   PUBLIC API ENDPOINTS
   ========================================================================== */

// PUBLIC API: Health check & diagnostics (for Railway deployment verification)
app.get('/api/health', async (req, res) => {
    try {
        const reportCountRes = await pool.query('SELECT COUNT(*) as count FROM reports');
        const count = parseInt(reportCountRes.rows[0].count, 10);
        res.json({
            status: 'OK',
            database: 'PostgreSQL connected',
            reports: count,
            telegram: {
                botToken: process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'using fallback',
                chatId: process.env.TELEGRAM_CHAT_ID || '-1003944424009 (fallback)'
            },
            environment: {
                nodeVersion: process.version,
                platform: process.platform,
                port: PORT
            }
        });
    } catch (err) {
        writeLog('ERROR', `Health check failed: ${formatError(err)}`);
        res.status(500).json({ status: 'ERROR', database: 'PostgreSQL connection failed', message: formatError(err) });
    }
});

// PUBLIC API: Get report statistics for home landing page
app.get('/api/reports/stats', async (req, res) => {
    try {
        const statsRes = await pool.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status IN ('Diverifikasi', 'Diajukan') THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'Ditindaklanjuti' THEN 1 ELSE 0 END) as process,
                SUM(CASE WHEN status = 'Selesai' THEN 1 ELSE 0 END) as resolved
            FROM reports
        `);
        const stats = statsRes.rows[0];
        
        res.json({
            success: true,
            total: parseInt(stats.total || 0, 10),
            pending: parseInt(stats.pending || 0, 10),
            process: parseInt(stats.process || 0, 10),
            resolved: parseInt(stats.resolved || 0, 10)
        });
    } catch (err) {
        writeLog('ERROR', `Error in GET /api/reports/stats: ${err.message}`);
        res.status(500).json({ success: false, message: 'Kesalahan internal server' });
    }
});

// PUBLIC API: Submit new complaint
app.post('/api/reports', async (req, res) => {
    try {
        const report = req.body;
        
        // Input Validation
        const validationError = validateReportInput(report);
        if (validationError) {
            writeLog('WARN', `Report validation failed: ${validationError}`);
            return res.status(400).json({ success: false, message: validationError });
        }
        
        // Check for token duplicates
        const existingRes = await pool.query('SELECT token FROM reports WHERE token = $1', [report.token]);
        if (existingRes.rows.length > 0) {
            return res.status(409).json({ success: false, message: 'Token aduan duplikat' });
        }
        
        // Insert report and history in a transaction
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            await client.query(`
                INSERT INTO reports (token, date_submitted, is_anonim, category, title, incident_date, location, description, file_name, file_data, status, reporter_name, reporter_nik, reporter_email, reporter_hp)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            `, [
                report.token,
                report.dateSubmitted,
                report.isAnonim ? 1 : 0,
                report.category,
                report.title,
                report.incidentDate,
                report.location,
                report.description,
                report.fileName || null,
                report.fileData || null,
                'Diajukan',
                report.reporterName || null,
                report.reporterNik || null,
                report.reporterEmail || null,
                report.reporterHp || null
            ]);
            
            // Insert initial history entry
            if (report.history && report.history.length > 0) {
                const h = report.history[0];
                await client.query(`
                    INSERT INTO report_history (report_token, status, note, date, is_user_msg)
                    VALUES ($1, $2, $3, $4, $5)
                `, [report.token, h.status, h.note, h.date, 0]);
            }
            
            await client.query('COMMIT');
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }
        
        writeLog('INFO', `New report registered: ${report.token} (${report.isAnonim ? 'Anonim' : 'Identitas Asli'})`);
        
        // Securely notify Telegram from backend
        sendTelegramNotification(report);
        
        res.status(201).json({ success: true, message: 'Pengaduan berhasil dikirim' });
        
    } catch (err) {
        writeLog('ERROR', `Error in POST /api/reports: ${err.message}`);
        res.status(500).json({ success: false, message: 'Kesalahan internal server' });
    }
});

// PUBLIC API: Track report (Secure Data Protection)
app.get('/api/reports/track/:token', async (req, res) => {
    try {
        const token = req.params.token.toUpperCase();
        const report = await getReportByToken(token);
        
        if (!report) {
            writeLog('INFO', `Tracking failed: Token not found: ${token}`);
            return res.status(404).json({ success: false, message: 'Token aduan tidak ditemukan' });
        }
        
        // Data Protection: Never leak whistleblower's sensitive information on public endpoint
        const secureReport = {
            token: report.token,
            dateSubmitted: report.dateSubmitted,
            isAnonim: report.isAnonim,
            category: report.category,
            title: report.title,
            incidentDate: report.incidentDate,
            location: report.location,
            description: report.description,
            fileName: report.fileName,
            fileData: report.fileData,
            status: report.status,
            history: report.history,
            // Masked identity variables
            reporterName: report.isAnonim ? 'Anonim' : 'Pelapor (Identitas Dilindungi)',
            reporterNik: '-',
            reporterEmail: '-',
            reporterHp: '-'
        };
        
        res.json({ success: true, report: secureReport });
    } catch (err) {
        writeLog('ERROR', `Error in GET /api/reports/track: ${err.message}`);
        res.status(500).json({ success: false, message: 'Kesalahan internal server' });
    }
});

// PUBLIC API: Whistleblower submits comment
app.post('/api/reports/comment', async (req, res) => {
    try {
        const { token, note, date, isUserMsg } = req.body;
        
        if (!token || !note || note.trim() === '') {
            return res.status(400).json({ success: false, message: 'Data tidak lengkap' });
        }
        
        // Check if report exists
        const reportRes = await pool.query('SELECT token, status FROM reports WHERE token = $1', [token]);
        if (reportRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Token tidak ditemukan' });
        }
        const report = reportRes.rows[0];
        
        await pool.query(`
            INSERT INTO report_history (report_token, status, note, date, is_user_msg)
            VALUES ($1, $2, $3, $4, $5)
        `, [token, report.status, note, date, isUserMsg ? 1 : 0]);
        
        writeLog('INFO', `Whistleblower comment added to report: ${token}`);
        res.json({ success: true });
        
    } catch (err) {
        writeLog('ERROR', `Error in POST /api/reports/comment: ${err.message}`);
        res.status(500).json({ success: false, message: 'Kesalahan internal server' });
    }
});

/* ==========================================================================
   SECURE ADMIN API ENDPOINTS
   ========================================================================== */

// SECURE API: Admin Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    // Server-Side Authentication using environment variables
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    
    if (username === adminUser && password === adminPass) {
        // Generate secure cryptographically random session token
        const token = crypto.randomBytes(32).toString('hex');
        activeSessions.add(token);
        
        writeLog('INFO', `Admin login successful. Session token generated.`);
        res.json({ success: true, token: token });
    } else {
        writeLog('WARN', `Failed admin login attempt using username: "${username}"`);
        res.status(401).json({ success: false, message: 'Username atau Password salah!' });
    }
});

// SECURE API: Admin logout
app.post('/api/admin/logout', authenticateToken, (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (token) {
        activeSessions.delete(token);
    }
    writeLog('INFO', 'Admin logout successful');
    res.json({ success: true });
});

// SECURE API: Get all reports (Requires session token validation)
app.get('/api/admin/reports', authenticateToken, async (req, res) => {
    try {
        const reports = await getAllReports();
        res.json({ success: true, reports: reports });
    } catch (err) {
        writeLog('ERROR', `Error in GET /api/admin/reports: ${err.message}`);
        res.status(500).json({ success: false, message: 'Kesalahan internal server' });
    }
});

// SECURE API: Admin update status (Requires session token validation with optional file attachment)
app.post('/api/admin/reports/update-status', authenticateToken, async (req, res) => {
    try {
        const { token, status, note, date, fileName, fileData } = req.body;
        
        if (!token || !status || !note) {
            return res.status(400).json({ success: false, message: 'Data tidak lengkap' });
        }
        
        // Attachment validation if present
        if (fileName && fileName.trim() !== '') {
            const allowedExtensions = ['pdf', 'jpg', 'jpeg', 'png', 'mp4', 'mov', 'heic'];
            const ext = fileName.split('.').pop().toLowerCase();
            if (!allowedExtensions.includes(ext)) {
                return res.status(400).json({ success: false, message: 'Format berkas tanggapan tidak diizinkan. Hanya diperbolehkan: PDF, JPG, JPEG, PNG, MP4, MOV, HEIC.' });
            }
            if (fileData) {
                const sizeInBytes = fileData.length * 0.75;
                const maxBytes = 5 * 1024 * 1024;
                if (sizeInBytes > maxBytes) {
                    return res.status(400).json({ success: false, message: 'Ukuran berkas tanggapan melebihi batas maksimal 5MB' });
                }
            }
        }
        
        // Check if report exists
        const reportRes = await pool.query('SELECT token FROM reports WHERE token = $1', [token]);
        if (reportRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Pengaduan tidak ditemukan' });
        }
        
        // Update status and add history entry in a transaction
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            await client.query('UPDATE reports SET status = $1 WHERE token = $2', [status, token]);
            
            await client.query(`
                INSERT INTO report_history (report_token, status, note, date, is_user_msg, file_name, file_data)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [token, status, note, date, 0, fileName || null, fileData || null]);
            
            await client.query('COMMIT');
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }
        
        writeLog('INFO', `Admin updated status of report ${token} to ${status}${fileName ? ' with attachment: ' + fileName : ''}`);
        res.json({ success: true });
        
    } catch (err) {
        writeLog('ERROR', `Error in POST /api/admin/reports/update-status: ${err.message}`);
        res.status(500).json({ success: false, message: 'Kesalahan internal server' });
    }
});

// SECURE API: Admin resets database (Requires session token validation)
app.post('/api/admin/reports/reset', authenticateToken, async (req, res) => {
    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM report_history');
            await client.query('DELETE FROM reports');
            await client.query('COMMIT');
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }
        
        writeLog('INFO', 'Database was cleared/reset by Admin.');
        res.json({ success: true });
        
    } catch (err) {
        writeLog('ERROR', `Error in POST /api/admin/reports/reset: ${err.message}`);
        res.status(500).json({ success: false, message: 'Kesalahan internal server' });
    }
});

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Graceful shutdown: close database connection
process.on('SIGINT', async () => {
    writeLog('SYSTEM', 'Server shutting down, closing database...');
    await pool.end();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    writeLog('SYSTEM', 'Server shutting down, closing database...');
    await pool.end();
    process.exit(0);
});

// Start the server securely
app.listen(PORT, () => {
    writeLog('SYSTEM', `WBS Inspektorat Padang server is listening on port ${PORT} (PostgreSQL database)`);
});
