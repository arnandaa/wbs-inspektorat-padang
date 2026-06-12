// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 8000;

const DB_PATH = path.join(__dirname, 'wbs_database.db');
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

/* ==========================================================================
   SQLite DATABASE INITIALIZATION
   ========================================================================== */

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// Create tables if they don't exist
db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE NOT NULL,
        date_submitted TEXT NOT NULL,
        is_anonim INTEGER NOT NULL DEFAULT 1,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        incident_date TEXT,
        location TEXT NOT NULL,
        description TEXT NOT NULL,
        file_name TEXT,
        file_data TEXT,
        status TEXT NOT NULL DEFAULT 'Diajukan',
        reporter_name TEXT,
        reporter_nik TEXT,
        reporter_email TEXT,
        reporter_hp TEXT
    );

    CREATE TABLE IF NOT EXISTS report_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_token TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        date TEXT NOT NULL,
        is_user_msg INTEGER NOT NULL DEFAULT 0,
        file_name TEXT,
        file_data TEXT,
        FOREIGN KEY (report_token) REFERENCES reports(token)
    );

    CREATE INDEX IF NOT EXISTS idx_reports_token ON reports(token);
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
    CREATE INDEX IF NOT EXISTS idx_history_token ON report_history(report_token);
`);

writeLog('SYSTEM', 'SQLite database initialized successfully.');

// Startup diagnostics: log environment variable status
writeLog('SYSTEM', `ENV CHECK — TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? 'SET ✓' : 'NOT SET (using fallback)'}`);
writeLog('SYSTEM', `ENV CHECK — TELEGRAM_CHAT_ID: ${process.env.TELEGRAM_CHAT_ID ? 'SET ✓' : 'NOT SET (using fallback)'}`);
writeLog('SYSTEM', `ENV CHECK — ADMIN_USERNAME: ${process.env.ADMIN_USERNAME ? 'SET ✓' : 'NOT SET (using fallback)'}`);
writeLog('SYSTEM', `ENV CHECK — PORT: ${process.env.PORT || '8000 (default)'}`);

/* ==========================================================================
   AUTO-MIGRATION: Import existing reports.json data into SQLite
   ========================================================================== */

function migrateFromJson() {
    const JSON_FILE = path.join(__dirname, 'reports.json');
    
    if (!fs.existsSync(JSON_FILE)) return;
    
    try {
        const jsonData = fs.readFileSync(JSON_FILE, 'utf8');
        const reports = JSON.parse(jsonData || '[]');
        
        if (reports.length === 0) return;
        
        // Check if database already has data
        const count = db.prepare('SELECT COUNT(*) as count FROM reports').get();
        if (count.count > 0) {
            writeLog('INFO', `Database already has ${count.count} reports. Skipping JSON migration.`);
            return;
        }
        
        writeLog('INFO', `Migrating ${reports.length} reports from reports.json to SQLite...`);
        
        const insertReport = db.prepare(`
            INSERT OR IGNORE INTO reports (token, date_submitted, is_anonim, category, title, incident_date, location, description, file_name, file_data, status, reporter_name, reporter_nik, reporter_email, reporter_hp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        const insertHistory = db.prepare(`
            INSERT INTO report_history (report_token, status, note, date, is_user_msg, file_name, file_data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        
        const migrate = db.transaction(() => {
            for (const report of reports) {
                insertReport.run(
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
                );
                
                // Migrate history entries
                if (report.history && Array.isArray(report.history)) {
                    for (const hist of report.history) {
                        insertHistory.run(
                            report.token,
                            hist.status,
                            hist.note || null,
                            hist.date,
                            hist.isUserMsg ? 1 : 0,
                            hist.fileName || null,
                            hist.fileData || null
                        );
                    }
                }
            }
        });
        
        migrate();
        writeLog('INFO', `Successfully migrated ${reports.length} reports from JSON to SQLite.`);
        
        // Rename old JSON file as backup
        const backupPath = path.join(__dirname, 'reports_backup.json');
        fs.renameSync(JSON_FILE, backupPath);
        writeLog('INFO', `Old reports.json renamed to reports_backup.json as backup.`);
        
    } catch (err) {
        writeLog('ERROR', `Failed to migrate from JSON: ${err.message}`);
    }
}

migrateFromJson();

/* ==========================================================================
   DATABASE QUERY HELPERS
   ========================================================================== */

// Get a single report with its history (formatted as the frontend expects)
function getReportByToken(token) {
    const report = db.prepare('SELECT * FROM reports WHERE UPPER(token) = UPPER(?)').get(token);
    if (!report) return null;
    
    const history = db.prepare('SELECT * FROM report_history WHERE report_token = ? ORDER BY id ASC').all(report.token);
    
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
        history: history.map(h => ({
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
function getAllReports() {
    const reports = db.prepare('SELECT * FROM reports ORDER BY date_submitted DESC').all();
    const historyStmt = db.prepare('SELECT * FROM report_history WHERE report_token = ? ORDER BY id ASC');
    
    return reports.map(report => ({
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
        history: historyStmt.all(report.token).map(h => ({
            status: h.status,
            note: h.note,
            date: h.date,
            isUserMsg: h.is_user_msg === 1,
            fileName: h.file_name,
            fileData: h.file_data
        }))
    }));
}

/* ==========================================================================
   TELEGRAM INTEGRATION
   ========================================================================== */

function sendTelegramNotification(report) {
    // Use env vars with hardcoded fallbacks to ensure Telegram always works
    const botToken = process.env.TELEGRAM_BOT_TOKEN || "8960174423:AAGRTippEoPzFt5XJxkzKIBqWi3-rgYJZuo";
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
app.get('/api/health', (req, res) => {
    try {
        const reportCount = db.prepare('SELECT COUNT(*) as count FROM reports').get();
        res.json({
            status: 'OK',
            database: 'SQLite connected',
            reports: reportCount.count,
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
        res.status(500).json({ status: 'ERROR', message: err.message });
    }
});

// PUBLIC API: Get report statistics for home landing page
app.get('/api/reports/stats', (req, res) => {
    try {
        const stats = db.prepare(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status IN ('Diverifikasi', 'Diajukan') THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'Ditindaklanjuti' THEN 1 ELSE 0 END) as process,
                SUM(CASE WHEN status = 'Selesai' THEN 1 ELSE 0 END) as resolved
            FROM reports
        `).get();
        
        res.json({
            success: true,
            total: stats.total,
            pending: stats.pending,
            process: stats.process,
            resolved: stats.resolved
        });
    } catch (err) {
        writeLog('ERROR', `Error in GET /api/reports/stats: ${err.message}`);
        res.status(500).json({ success: false, message: 'Kesalahan internal server' });
    }
});

// PUBLIC API: Submit new complaint
app.post('/api/reports', (req, res) => {
    try {
        const report = req.body;
        
        // Input Validation
        const validationError = validateReportInput(report);
        if (validationError) {
            writeLog('WARN', `Report validation failed: ${validationError}`);
            return res.status(400).json({ success: false, message: validationError });
        }
        
        // Check for token duplicates
        const existing = db.prepare('SELECT token FROM reports WHERE token = ?').get(report.token);
        if (existing) {
            return res.status(409).json({ success: false, message: 'Token aduan duplikat' });
        }
        
        // Insert report into database
        const insertReport = db.prepare(`
            INSERT INTO reports (token, date_submitted, is_anonim, category, title, incident_date, location, description, file_name, file_data, status, reporter_name, reporter_nik, reporter_email, reporter_hp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        const insertHistory = db.prepare(`
            INSERT INTO report_history (report_token, status, note, date, is_user_msg)
            VALUES (?, ?, ?, ?, ?)
        `);
        
        const transaction = db.transaction(() => {
            insertReport.run(
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
            );
            
            // Insert initial history entry
            if (report.history && report.history.length > 0) {
                const h = report.history[0];
                insertHistory.run(report.token, h.status, h.note, h.date, 0);
            }
        });
        
        transaction();
        
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
app.get('/api/reports/track/:token', (req, res) => {
    try {
        const token = req.params.token.toUpperCase();
        const report = getReportByToken(token);
        
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
app.post('/api/reports/comment', (req, res) => {
    try {
        const { token, note, date, isUserMsg } = req.body;
        
        if (!token || !note || note.trim() === '') {
            return res.status(400).json({ success: false, message: 'Data tidak lengkap' });
        }
        
        // Check if report exists
        const report = db.prepare('SELECT token, status FROM reports WHERE token = ?').get(token);
        if (!report) {
            return res.status(404).json({ success: false, message: 'Token tidak ditemukan' });
        }
        
        db.prepare(`
            INSERT INTO report_history (report_token, status, note, date, is_user_msg)
            VALUES (?, ?, ?, ?, ?)
        `).run(token, report.status, note, date, isUserMsg ? 1 : 0);
        
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
app.get('/api/admin/reports', authenticateToken, (req, res) => {
    try {
        const reports = getAllReports();
        res.json({ success: true, reports: reports });
    } catch (err) {
        writeLog('ERROR', `Error in GET /api/admin/reports: ${err.message}`);
        res.status(500).json({ success: false, message: 'Kesalahan internal server' });
    }
});

// SECURE API: Admin update status (Requires session token validation with optional file attachment)
app.post('/api/admin/reports/update-status', authenticateToken, (req, res) => {
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
        const report = db.prepare('SELECT token FROM reports WHERE token = ?').get(token);
        if (!report) {
            return res.status(404).json({ success: false, message: 'Pengaduan tidak ditemukan' });
        }
        
        // Update status and add history entry in a transaction
        const transaction = db.transaction(() => {
            db.prepare('UPDATE reports SET status = ? WHERE token = ?').run(status, token);
            
            db.prepare(`
                INSERT INTO report_history (report_token, status, note, date, is_user_msg, file_name, file_data)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(token, status, note, date, 0, fileName || null, fileData || null);
        });
        
        transaction();
        
        writeLog('INFO', `Admin updated status of report ${token} to ${status}${fileName ? ' with attachment: ' + fileName : ''}`);
        res.json({ success: true });
        
    } catch (err) {
        writeLog('ERROR', `Error in POST /api/admin/reports/update-status: ${err.message}`);
        res.status(500).json({ success: false, message: 'Kesalahan internal server' });
    }
});

// SECURE API: Admin resets database (Requires session token validation)
app.post('/api/admin/reports/reset', authenticateToken, (req, res) => {
    try {
        const transaction = db.transaction(() => {
            db.prepare('DELETE FROM report_history').run();
            db.prepare('DELETE FROM reports').run();
        });
        
        transaction();
        
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
process.on('SIGINT', () => {
    writeLog('SYSTEM', 'Server shutting down, closing database...');
    db.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    writeLog('SYSTEM', 'Server shutting down, closing database...');
    db.close();
    process.exit(0);
});

// Start the server securely
app.listen(PORT, () => {
    writeLog('SYSTEM', `WBS Inspektorat Padang server is listening on port ${PORT} (SQLite database)`);
});
