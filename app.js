/* ==========================================================================
   WBS INSPEKTORAT KOTA PADANG - APPLICATION SCRIPT (JAVASCRIPT)
   Handles SPA routing, form validations, token generation, local storage
   persistence, search tracking, and admin dashboard operations.
   ========================================================================== */

// 1. STATE & CONSTANTS
let reports = [];
let currentAdminFilter = 'all';
let selectedFileBase64 = null;
let selectedFileName = "";
let adminSelectedFileBase64 = null;
let adminSelectedFileName = "";

// 2. DOM INITIALIZATION
document.addEventListener('DOMContentLoaded', () => {
    // Check if user is logged into admin
    const isAdminLoggedIn = sessionStorage.getItem('wbs_admin_token') !== null;
    if (isAdminLoggedIn) {
        document.getElementById('nav-admin').textContent = 'Admin Dashboard';
    }
    
    // Initialize stats display on home page
    updateHomeStats();
    
    // Default form configuration
    toggleIdentityFields(true);
    
    // Handle hash routing if page is reloaded
    handleHashRouting();
});

// Operations migrated to Secure Server-Side Database

// 3. SPA ROUTING SYSTEM
function navigateTo(sectionId) {
    // Reset tracking page values and display state
    resetTrackingPage();

    // Deactivate all sections
    const sections = document.querySelectorAll('.app-section');
    sections.forEach(sec => {
        sec.classList.remove('active-section');
    });
    
    // Activate targeted section
    const targetSection = document.getElementById(`section-${sectionId}`);
    if (targetSection) {
        targetSection.classList.add('active-section');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    
    // Update active nav link
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.classList.remove('active');
    });
    
    const activeNavItem = document.getElementById(`nav-${sectionId}`);
    if (activeNavItem) {
        activeNavItem.classList.add('active');
    }
    
    // Handle admin layout sizing
    if (sectionId === 'admin') {
        document.querySelector('.app-main').style.maxWidth = '100%';
    } else {
        document.querySelector('.app-main').style.maxWidth = '1200px';
    }
    
    // Update Home Stats if navigating home
    if (sectionId === 'home') {
        updateHomeStats();
    }
    
    // Update URL Hash
    window.location.hash = sectionId;
}

function handleHashRouting() {
    const hash = window.location.hash.substring(1);
    const validHashes = ['home', 'report', 'track', 'admin'];
    if (validHashes.includes(hash)) {
        if (hash === 'admin') {
            // Check if authenticated
            if (sessionStorage.getItem('wbs_admin_token') !== null) {
                navigateTo('admin');
                fetchAdminReports();
            } else {
                navigateTo('home');
            }
        } else {
            navigateTo(hash);
        }
    } else {
        navigateTo('home');
    }
}

// Mobile Menu toggler
function toggleMobileMenu() {
    const mobileNav = document.getElementById('mobile-nav');
    mobileNav.classList.toggle('active');
}

// Reset tracking page values and display state
function resetTrackingPage() {
    const input = document.getElementById('track-token-input');
    if (input) input.value = "";
    
    const results = document.getElementById('track-results-container');
    if (results) results.classList.add('hidden');
    
    const errorMsg = document.getElementById('track-error-msg');
    if (errorMsg) errorMsg.classList.add('hidden');
    
    const commentInput = document.getElementById('comment-message-input');
    if (commentInput) commentInput.value = "";
}

// 4. COMPLAINT FORM LOGIC (TOGGLE IDENTITY)
function toggleIdentityFields(isAnonim) {
    const container = document.getElementById('identity-fields-container');
    const nameInput = document.getElementById('pelapor-nama');
    const nikInput = document.getElementById('pelapor-nik');
    const emailInput = document.getElementById('pelapor-email');
    const hpInput = document.getElementById('pelapor-hp');
    
    if (isAnonim) {
        container.classList.add('hidden');
        nameInput.required = false;
        nikInput.required = false;
        emailInput.required = false;
        hpInput.required = false;
        // Reset inputs
        nameInput.value = "";
        nikInput.value = "";
        emailInput.value = "";
        hpInput.value = "";
    } else {
        container.classList.remove('hidden');
        nameInput.required = true;
        nikInput.required = true;
        emailInput.required = true;
        hpInput.required = true;
    }
}

// File uploading mock mechanism (converts to base64 if it's an image or doc for mock visualization)
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const allowedExtensions = ['pdf', 'jpg', 'jpeg', 'png', 'mp4', 'mov', 'heic'];
    const ext = file.name.split('.').pop().toLowerCase();
    if (!allowedExtensions.includes(ext)) {
        alert("Format berkas tidak diizinkan. Hanya diperbolehkan: PDF, JPG, JPEG, PNG, MP4, MOV, HEIC.");
        event.target.value = "";
        return;
    }
    
    if (file.size > 5 * 1024 * 1024) {
        alert("Ukuran file terlalu besar! Maksimal 5MB.");
        event.target.value = "";
        return;
    }
    
    selectedFileName = file.name;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        selectedFileBase64 = e.target.result;
        // Display file name inside dropzone
        const display = document.getElementById('selected-file-display');
        const nameSpan = document.getElementById('selected-file-name');
        nameSpan.textContent = file.name;
        display.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
}

function removeSelectedFile(event) {
    event.preventDefault();
    event.stopPropagation();
    
    document.getElementById('aduan-bukti').value = "";
    selectedFileBase64 = null;
    selectedFileName = "";
    
    const display = document.getElementById('selected-file-display');
    display.classList.add('hidden');
}

function handleAdminFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const allowedExtensions = ['pdf', 'jpg', 'jpeg', 'png', 'mp4', 'mov', 'heic'];
    const ext = file.name.split('.').pop().toLowerCase();
    if (!allowedExtensions.includes(ext)) {
        alert("Format berkas tidak diizinkan. Hanya diperbolehkan: PDF, JPG, JPEG, PNG, MP4, MOV, HEIC.");
        event.target.value = "";
        return;
    }
    
    if (file.size > 5 * 1024 * 1024) {
        alert("Ukuran file terlalu besar! Maksimal 5MB.");
        event.target.value = "";
        return;
    }
    
    adminSelectedFileName = file.name;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        adminSelectedFileBase64 = e.target.result;
    };
    reader.readAsDataURL(file);
}

// Handle report submissions
function handleFormSubmit(event) {
    event.preventDefault();
    
    const isAnonim = document.getElementById('toggle-anonim').checked;
    
    // Generate Unique Token (e.g. WBS-PDG-2026-X79K2)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid ambiguous chars
    let randomPart = '';
    for (let i = 0; i < 5; i++) {
        randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const token = `WBS-PDG-2026-${randomPart}`;
    
    const dateSubmitted = new Date().toISOString();
    
    // Create new report object
    const newReport = {
        token: token,
        dateSubmitted: dateSubmitted,
        isAnonim: isAnonim,
        category: document.getElementById('aduan-kategori').value,
        title: document.getElementById('aduan-judul').value,
        incidentDate: document.getElementById('aduan-tanggal').value,
        location: document.getElementById('aduan-lokasi').value,
        description: document.getElementById('aduan-deskripsi').value,
        fileName: selectedFileName,
        fileData: selectedFileBase64,
        status: 'Diajukan',
        history: [
            {
                status: 'Diajukan',
                note: 'Pengaduan berhasil didaftarkan ke sistem WBS Inspektorat Kota Padang.',
                date: dateSubmitted
            }
        ]
    };
    
    // Add data diri if NOT anonymous
    if (!isAnonim) {
        newReport.reporterName = document.getElementById('pelapor-nama').value;
        newReport.reporterNik = document.getElementById('pelapor-nik').value;
        newReport.reporterEmail = document.getElementById('pelapor-email').value;
        newReport.reporterHp = document.getElementById('pelapor-hp').value;
    } else {
        newReport.reporterName = 'Anonim';
        newReport.reporterNik = '-';
        newReport.reporterEmail = '-';
        newReport.reporterHp = '-';
    }
    
    // Send to backend API
    fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newReport)
    })
    .then(res => {
        if (!res.ok) {
            return res.json().then(data => { throw new Error(data.message || 'Gagal mengirim pengaduan') });
        }
        return res.json();
    })
    .then(data => {
        // Reset form
        document.getElementById('wbs-report-form').reset();
        removeSelectedFile(event);
        
        // Open Success Modal
        document.getElementById('success-token-val').textContent = token;
        document.getElementById('modal-success').classList.add('active');
    })
    .catch(err => {
        alert("Gagal mengirim laporan: " + err.message);
        console.error('Error submitting report:', err);
    });
}

function closeSuccessModal() {
    document.getElementById('modal-success').classList.remove('active');
    // Navigate straight to tracking tab with token preset
    const token = document.getElementById('success-token-val').textContent;
    document.getElementById('track-token-input').value = token;
    navigateTo('track');
    // Auto-search
    searchReport(token);
}

function copyTokenToClipboard() {
    const tokenText = document.getElementById('success-token-val').textContent;
    navigator.clipboard.writeText(tokenText).then(() => {
        const msg = document.getElementById('copy-status-msg');
        msg.style.display = 'block';
        setTimeout(() => {
            msg.style.display = 'none';
        }, 2000);
    });
}

// 5. REPORT TRACKING LOGIC
function handleTrackReport(event) {
    event.preventDefault();
    const token = document.getElementById('track-token-input').value.trim();
    searchReport(token);
}

function searchReport(token) {
    const errorMsg = document.getElementById('track-error-msg');
    const resultsContainer = document.getElementById('track-results-container');
    
    fetch(`/api/reports/track/${encodeURIComponent(token)}`)
    .then(res => {
        if (!res.ok) {
            throw new Error('Token tidak ditemukan');
        }
        return res.json();
    })
    .then(data => {
        if (data.success && data.report) {
            const report = data.report;
            errorMsg.classList.add('hidden');
            resultsContainer.classList.remove('hidden');
            
            // Fill in report details
            document.getElementById('display-token').textContent = report.token;
            document.getElementById('display-judul').textContent = report.title;
            document.getElementById('display-kategori').textContent = report.category;
            document.getElementById('display-tanggal-masuk').textContent = formatDate(report.dateSubmitted);
            document.getElementById('display-tanggal-kejadian').textContent = formatDate(report.incidentDate);
            document.getElementById('display-lokasi').textContent = report.location;
            document.getElementById('display-deskripsi').textContent = report.description;
            
            // Handle File Attachment display
            const fileContainer = document.getElementById('display-bukti-link');
            if (report.fileName && report.fileData) {
                fileContainer.innerHTML = `<a href="${escapeHTML(report.fileData)}" download="${escapeHTML(report.fileName)}" class="text-navy" style="text-decoration:underline; font-weight:600;">📁 ${escapeHTML(report.fileName)}</a>`;
            } else {
                fileContainer.textContent = "Tidak ada bukti file dilampirkan.";
            }
            
            // Reporter Identity Shielding
            const reporterNameField = document.getElementById('display-pelapor-nama');
            if (report.isAnonim) {
                reporterNameField.textContent = "Anonim (Kerahasiaan Dijamin)";
                reporterNameField.className = "detail-value text-muted";
            } else {
                reporterNameField.textContent = report.reporterName;
                reporterNameField.className = "detail-value text-bold text-navy";
            }
            
            // Status Badge
            const badge = document.getElementById('display-status-badge');
            badge.textContent = report.status;
            badge.className = `status-badge ${report.status.toLowerCase()}`;
            
            // Update Timeline steps
            updateTimelineSteppers(report);
            
            // Load admin responses log
            renderTrackingComments(report);
            
            // Pass token to whistleblower comment hidden input
            document.getElementById('comment-report-token').value = report.token;
        } else {
            errorMsg.classList.remove('hidden');
            resultsContainer.classList.add('hidden');
        }
    })
    .catch(err => {
        errorMsg.classList.remove('hidden');
        resultsContainer.classList.add('hidden');
        console.error('Error tracking report:', err);
    });
}

// Helper to escape HTML characters (XSS Prevention)
function escapeHTML(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/[&<>'"]/g, 
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag)
    );
}

// Helper to add working days (excluding weekends)
function addWorkingDays(startDate, days) {
    let date = new Date(startDate);
    let count = 0;
    while (count < days) {
        date.setDate(date.getDate() + 1);
        const day = date.getDay();
        if (day !== 0 && day !== 6) { // 0 = Sunday, 6 = Saturday
            count++;
        }
    }
    return date;
}

// Function to calculate SLA and get status text
function calculateSLA(report) {
    if (report.status === 'Selesai') {
        return { text: 'Tuntas', class: 'sla-completed', remainingDays: 0, deadline: null };
    }
    if (report.status === 'Ditolak') {
        return { text: 'Ditolak (Ditutup)', class: 'sla-closed', remainingDays: 0, deadline: null };
    }

    let deadlineDate;
    let label = '';
    
    // Find when the current status was activated
    const historyItem = [...report.history]
        .reverse()
        .find(h => h.status === report.status);
    const baseDate = historyItem ? new Date(historyItem.date) : new Date(report.dateSubmitted);

    if (report.status === 'Diajukan') {
        // SLA: 1 Hari Kerja (Segera) untuk verifikasi/respon awal
        deadlineDate = addWorkingDays(baseDate, 1);
        label = 'Verifikasi';
    } else if (report.status === 'Diverifikasi') {
        // SLA: 6 Hari Kerja untuk telaah awal
        deadlineDate = addWorkingDays(baseDate, 6);
        label = 'Tindak Lanjut';
    } else if (report.status === 'Ditindaklanjuti') {
        // SLA: 14 Hari Kerja untuk penyelesaian akhir
        deadlineDate = addWorkingDays(baseDate, 14);
        label = 'Penyelesaian';
    } else {
        deadlineDate = addWorkingDays(new Date(report.dateSubmitted), 30);
        label = 'Selesai';
    }

    const now = new Date();
    // Reset hours to compare dates
    const d1 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const d2 = new Date(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate());
    
    // Calculate difference in days
    const timeDiff = d2.getTime() - d1.getTime();
    const diffDays = Math.ceil(timeDiff / (1000 * 3600 * 24));

    if (diffDays < 0) {
        return {
            text: `Terlambat ${Math.abs(diffDays)} hari (${label})`,
            class: 'sla-overdue',
            remainingDays: diffDays,
            deadline: deadlineDate
        };
    } else if (diffDays === 0) {
        return {
            text: `Segera hari ini (${label})`,
            class: 'sla-warning',
            remainingDays: diffDays,
            deadline: deadlineDate
        };
    } else {
        return {
            text: `${diffDays} hari lagi (${label})`,
            class: 'sla-safe',
            remainingDays: diffDays,
            deadline: deadlineDate
        };
    }
}

// Helper to format dates to Indonesian representation
function formatDate(isoString) {
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
}

// Timeline Stepper updater based on current status
function updateTimelineSteppers(report) {
    const steps = ['diajukan', 'diverifikasi', 'ditindaklanjuti', 'selesai'];
    const currentStatus = report.status; // Diajukan, Diverifikasi, Ditindaklanjuti, Selesai, Ditolak
    
    // Clear all classes first
    steps.forEach(st => {
        const element = document.getElementById(`step-${st}`);
        element.classList.remove('completed', 'active');
        document.getElementById(`date-${st}`).textContent = '-';
    });
    
    // If Ditolak, we show a special layout or just mark first steps
    if (currentStatus === 'Ditolak') {
        const step1 = document.getElementById('step-diajukan');
        step1.classList.add('completed');
        
        // Change text on diverifikasi to show rejected
        const step2 = document.getElementById('step-diverifikasi');
        step2.classList.add('active');
        step2.querySelector('h4').textContent = "Ditolak";
        step2.querySelector('.step-desc').textContent = "Laporan ditolak setelah penelaahan awal karena tidak memenuhi syarat.";
        
        const act = report.history.find(h => h.status === 'Ditolak');
        if (act) {
            document.getElementById('date-diverifikasi').textContent = formatDate(act.date);
        }
        
        const act1 = report.history.find(h => h.status === 'Diajukan');
        if (act1) {
            document.getElementById('date-diajukan').textContent = formatDate(act1.date);
        }
        return;
    }
    
    // Normal lifecycle: Diajukan -> Diverifikasi -> Ditindaklanjuti -> Selesai
    // Restore default text for step 2 in case it was set to ditolak
    const step2 = document.getElementById('step-diverifikasi');
    step2.querySelector('h4').textContent = "Diverifikasi";
    step2.querySelector('.step-desc').textContent = "Inspektorat meninjau keabsahan laporan dan bukti pendukung.";
    
    // Map current index
    let activeIdx = 0;
    if (currentStatus === 'Diajukan') activeIdx = 0;
    else if (currentStatus === 'Diverifikasi') activeIdx = 1;
    else if (currentStatus === 'Ditindaklanjuti') activeIdx = 2;
    else if (currentStatus === 'Selesai') activeIdx = 3;
    
    for (let i = 0; i < steps.length; i++) {
        const key = steps[i];
        const element = document.getElementById(`step-${key}`);
        
        // Find matching status in history to get date
        const statusMap = {
            'diajukan': 'Diajukan',
            'diverifikasi': 'Diverifikasi',
            'ditindaklanjuti': 'Ditindaklanjuti',
            'selesai': 'Selesai'
        };
        const histItem = report.history.find(h => h.status === statusMap[key]);
        
        if (i < activeIdx) {
            element.classList.add('completed');
            if (histItem) document.getElementById(`date-${key}`).textContent = formatDate(histItem.date);
        } else if (i === activeIdx) {
            element.classList.add('active');
            if (histItem) document.getElementById(`date-${key}`).textContent = formatDate(histItem.date);
        }
    }
}

// Render comments/updates log inside tracking details
function renderTrackingComments(report) {
    const list = document.getElementById('track-response-list');
    list.innerHTML = "";
    
    // Filter history containing notes that aren't empty (we log logs as comments)
    const logHistory = report.history.filter(h => h.note && h.note.trim() !== "");
    
    if (logHistory.length === 0) {
        list.innerHTML = `<div class="response-empty">Belum ada catatan penanganan dari Inspektorat.</div>`;
        return;
    }
    
    // Sort chronological: oldest first, or newest first. Let's do newest first
    const sorted = [...logHistory].sort((a,b) => new Date(b.date) - new Date(a.date));
    
    sorted.forEach(item => {
        const div = document.createElement('div');
        // Check sender type from status / note
        const isUserMsg = item.isUserMsg === true;
        
        div.className = `response-item ${isUserMsg ? 'user-log' : 'admin-log'}`;
        
        let attachmentHtml = "";
        if (item.fileName && item.fileData) {
            attachmentHtml = `
                <div class="comment-attachment" style="margin-top: 0.5rem; font-size: 0.8rem;">
                    <strong>Lampiran Resmi:</strong> 
                    <a href="${escapeHTML(item.fileData)}" download="${escapeHTML(item.fileName)}" style="color: var(--color-accent); text-decoration: underline; font-weight: 600;">
                        📁 ${escapeHTML(item.fileName)}
                    </a>
                </div>
            `;
        }
        
        div.innerHTML = `
            <div class="response-meta">
                <span>${isUserMsg ? 'Pelapor (Tambahan Informasi)' : 'Inspektorat Kota Padang'}</span>
                <span>${formatDate(item.date)}</span>
            </div>
            <div class="response-text">${escapeHTML(item.note)}</div>
            ${attachmentHtml}
        `;
        list.appendChild(div);
    });
}

// Whistleblower adds feedback comment
function handleSendWhistleblowerComment(event) {
    event.preventDefault();
    
    const token = document.getElementById('comment-report-token').value;
    const msgInput = document.getElementById('comment-message-input');
    const msg = msgInput.value.trim();
    
    if (!msg) return;
    
    const date = new Date().toISOString();
    
    fetch('/api/reports/comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            token: token,
            note: msg,
            date: date,
            isUserMsg: true
        })
    })
    .then(res => {
        if (!res.ok) {
            throw new Error('Gagal memperbarui database');
        }
        return res.json();
    })
    .then(data => {
        msgInput.value = "";
        // Refresh display
        searchReport(token);
    })
    .catch(err => {
        alert("Gagal mengirim tanggapan pelapor: " + err.message);
        console.error(err);
    });
}

// 6. ADMIN PORTAL OPERATIONS
function openAdminPortal() {
    // Check if already authenticated
    const authenticated = sessionStorage.getItem('wbs_admin_token') !== null;
    if (authenticated) {
        navigateTo('admin');
        fetchAdminReports();
    } else {
        // Show Auth Username and Password modal
        document.getElementById('modal-admin-login').classList.add('active');
        document.getElementById('admin-username').value = "";
        document.getElementById('admin-password').value = "";
        document.getElementById('login-error-msg').classList.add('hidden');
    }
}

function closeAdminLoginModal() {
    document.getElementById('modal-admin-login').classList.remove('active');
}

function handleAdminLogin(event) {
    event.preventDefault();
    const username = document.getElementById('admin-username').value.trim();
    const password = document.getElementById('admin-password').value.trim();
    const errorMsg = document.getElementById('login-error-msg');
    
    // Validate credentials securely via backend server API
    fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    })
    .then(res => {
        if (!res.ok) {
            throw new Error('Unauthorized');
        }
        return res.json();
    })
    .then(data => {
        if (data.success) {
            sessionStorage.setItem('wbs_admin_token', data.token);
            document.getElementById('nav-admin').textContent = 'Admin Dashboard';
            closeAdminLoginModal();
            navigateTo('admin');
            fetchAdminReports();
        } else {
            errorMsg.classList.remove('hidden');
        }
    })
    .catch(err => {
        console.error('Error logging in:', err);
        errorMsg.textContent = "Username atau Password Salah!";
        errorMsg.classList.remove('hidden');
    });
}

function logoutAdmin() {
    const token = sessionStorage.getItem('wbs_admin_token');
    fetch('/api/admin/logout', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    })
    .finally(() => {
        sessionStorage.removeItem('wbs_admin_token');
        document.getElementById('nav-admin').textContent = 'Admin Area';
        navigateTo('home');
    });
}

// Fetch all reports securely from backend for admin dashboard
function fetchAdminReports() {
    const token = sessionStorage.getItem('wbs_admin_token');
    if (!token) {
        navigateTo('home');
        return;
    }
    
    fetch('/api/admin/reports', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`
        }
    })
    .then(res => {
        if (res.status === 401 || res.status === 403) {
            sessionStorage.removeItem('wbs_admin_token');
            document.getElementById('nav-admin').textContent = 'Admin Area';
            navigateTo('home');
            throw new Error('Sesi kedaluwarsa atau tidak valid');
        }
        if (!res.ok) {
            throw new Error('Gagal memuat data pengaduan');
        }
        return res.json();
    })
    .then(data => {
        if (data.success) {
            reports = data.reports;
            updateAdminStats();
            renderAdminReports();
            renderSLADashboard(reports);
        }
    })
    .catch(err => {
        alert(err.message);
        console.error(err);
    });
}

// Compute SLA compliance rate and statuses breakdown
function renderSLADashboard(reportsList) {
    if (!reportsList || reportsList.length === 0) {
        document.getElementById('sla-compliance-rate').textContent = '100%';
        document.getElementById('sla-stat-safe').textContent = '0';
        document.getElementById('sla-stat-warning').textContent = '0';
        document.getElementById('sla-stat-overdue').textContent = '0';
        return;
    }
    
    let safeCount = 0;
    let warningCount = 0;
    let overdueCount = 0;
    
    reportsList.forEach(report => {
        const sla = calculateSLA(report);
        if (sla.class === 'sla-completed' || sla.class === 'sla-closed' || sla.class === 'sla-safe') {
            safeCount++;
        } else if (sla.class === 'sla-warning') {
            warningCount++;
        } else if (sla.class === 'sla-overdue') {
            overdueCount++;
        }
    });
    
    const total = reportsList.length;
    const complianceRate = Math.round(((safeCount + warningCount) / total) * 100);
    
    document.getElementById('sla-compliance-rate').textContent = `${complianceRate}%`;
    document.getElementById('sla-stat-safe').textContent = safeCount;
    document.getElementById('sla-stat-warning').textContent = warningCount;
    document.getElementById('sla-stat-overdue').textContent = overdueCount;
}

// Calculate admin statistics
function updateAdminStats() {
    const total = reports.length;
    const pending = reports.filter(r => r.status === 'Diajukan').length;
    const process = reports.filter(r => r.status === 'Ditindaklanjuti').length;
    const resolved = reports.filter(r => r.status === 'Selesai').length;
    
    document.getElementById('admin-stat-total').textContent = total;
    document.getElementById('admin-stat-pending').textContent = pending;
    document.getElementById('admin-stat-process').textContent = process;
    document.getElementById('admin-stat-resolved').textContent = resolved;
    
    // Update sidebar navigation badges
    document.getElementById('admin-badge-all').textContent = total;
    document.getElementById('admin-badge-diajukan').textContent = pending;
    document.getElementById('admin-badge-diverifikasi').textContent = reports.filter(r => r.status === 'Diverifikasi').length;
    document.getElementById('admin-badge-ditindaklanjuti').textContent = process;
    document.getElementById('admin-badge-selesai').textContent = resolved;
    document.getElementById('admin-badge-ditolak').textContent = reports.filter(r => r.status === 'Ditolak').length;
}

// Filter administration records table
function filterAdminReports(status) {
    currentAdminFilter = status;
    
    // Update active nav state in sidebar
    const items = document.querySelectorAll('.admin-nav-item');
    items.forEach(it => it.classList.remove('active'));
    
    const mapId = {
        'all': 'admin-filter-all',
        'Diajukan': 'admin-filter-diajukan',
        'Diverifikasi': 'admin-filter-diverifikasi',
        'Ditindaklanjuti': 'admin-filter-ditindaklanjuti',
        'Selesai': 'admin-filter-selesai',
        'Ditolak': 'admin-filter-ditolak'
    };
    
    const activeItem = document.getElementById(mapId[status]);
    if (activeItem) activeItem.classList.add('active');
    
    renderAdminReports();
}

function renderAdminReports(searchQuery = "") {
    const tbody = document.getElementById('admin-table-body');
    tbody.innerHTML = "";
    
    let filtered = [...reports];
    
    // Apply sidebar status filter
    if (currentAdminFilter !== 'all') {
        filtered = filtered.filter(r => r.status === currentAdminFilter);
    }
    
    // Apply search query filter
    if (searchQuery.trim() !== "") {
        const query = searchQuery.toLowerCase();
        filtered = filtered.filter(r => 
            r.token.toLowerCase().includes(query) ||
            r.title.toLowerCase().includes(query) ||
            r.location.toLowerCase().includes(query) ||
            r.category.toLowerCase().includes(query)
        );
    }
    
    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:2rem; color:var(--color-text-muted);">Tidak ada data pengaduan ditemukan.</td></tr>`;
        return;
    }
    
    // Sort: newest first
    filtered.sort((a,b) => new Date(b.dateSubmitted) - new Date(a.dateSubmitted));
    
    filtered.forEach(report => {
        const tr = document.createElement('tr');
        
        const reporterTypeBadge = report.isAnonim ? 
            `<span class="admin-badge-anon">ANONIM</span>` : 
            `<span class="admin-badge-real">IDENTITAS ASLI</span>`;
            
        const sla = calculateSLA(report);
            
        tr.innerHTML = `
            <td style="font-family:monospace; font-weight:700;">${escapeHTML(report.token)}</td>
            <td>${formatDate(report.dateSubmitted)}</td>
            <td><strong>${escapeHTML(report.category)}</strong></td>
            <td style="max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHTML(report.title)}">${escapeHTML(report.title)}</td>
            <td>${escapeHTML(report.location)}</td>
            <td>${reporterTypeBadge}</td>
            <td><span class="status-badge ${escapeHTML(report.status.toLowerCase())}">${escapeHTML(report.status)}</span></td>
            <td><span class="sla-badge ${sla.class}">${escapeHTML(sla.text)}</span></td>
            <td>
                <button class="btn btn-secondary btn-sm" onclick="openAdminDetail('${escapeHTML(report.token)}')">Periksa</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function handleAdminSearch(value) {
    renderAdminReports(value);
}

// Detail modal inside admin panel
function openAdminDetail(token) {
    const report = reports.find(r => r.token === token);
    if (!report) return;
    
    document.getElementById('admin-update-token').value = report.token;
    document.getElementById('admin-detail-token').textContent = report.token;
    document.getElementById('admin-detail-date').textContent = formatDate(report.dateSubmitted);
    document.getElementById('admin-detail-cat').textContent = report.category;
    document.getElementById('admin-detail-title').textContent = report.title;
    document.getElementById('admin-detail-opd').textContent = report.location;
    document.getElementById('admin-detail-incident-date').textContent = formatDate(report.incidentDate);
    
    // SLA Information
    const sla = calculateSLA(report);
    const slaEl = document.getElementById('admin-detail-sla');
    if (slaEl) {
        slaEl.innerHTML = `<span class="sla-badge ${sla.class}">${escapeHTML(sla.text)}</span>` + 
                          (sla.deadline ? ` <span style="font-size: 0.85rem; color: var(--color-text-muted);">(${formatDate(sla.deadline)})</span>` : '');
    }
    
    // Reporter details configuration
    const repType = document.getElementById('admin-detail-reporter-type');
    const repName = document.getElementById('admin-detail-reporter-name');
    const repNik = document.getElementById('admin-detail-reporter-nik');
    const repContact = document.getElementById('admin-detail-reporter-contact');
    
    if (report.isAnonim) {
        repType.innerHTML = `<span class="admin-badge-anon">ANONIM</span>`;
        repName.textContent = "Anonim (Dirahasiakan)";
        repNik.textContent = "-";
        repContact.textContent = "-";
    } else {
        repType.innerHTML = `<span class="admin-badge-real">IDENTITAS ASLI</span>`;
        repName.textContent = report.reporterName || "-";
        repNik.textContent = report.reporterNik || "-";
        repContact.textContent = `${report.reporterEmail} / ${report.reporterHp}`;
    }
    
    document.getElementById('admin-detail-desc').textContent = report.description;
    
    // File display
    const fileArea = document.getElementById('admin-detail-file');
    if (report.fileName && report.fileData) {
        fileArea.innerHTML = `<a href="${escapeHTML(report.fileData)}" download="${escapeHTML(report.fileName)}" class="text-navy">📁 ${escapeHTML(report.fileName)} (Klik untuk mengunduh)</a>`;
    } else {
        fileArea.textContent = "Tidak ada bukti dilampirkan.";
    }
    
    // Select correct status in dropdown
    document.getElementById('admin-status-select').value = report.status;
    document.getElementById('admin-response-text').value = "";
    
    // Reset admin selected file
    const adminFileInput = document.getElementById('admin-response-file');
    if (adminFileInput) adminFileInput.value = "";
    adminSelectedFileBase64 = null;
    adminSelectedFileName = "";
    
    // Load responses log
    renderAdminDetailHistory(report);
    
    // Display Modal
    document.getElementById('modal-admin-detail').classList.add('active');
}

function closeAdminDetailModal() {
    document.getElementById('modal-admin-detail').classList.remove('active');
}

// Render history updates in admin detail dialog
function renderAdminDetailHistory(report) {
    const container = document.getElementById('admin-detail-history-list');
    container.innerHTML = "";
    
    const logHistory = report.history.filter(h => h.note && h.note.trim() !== "");
    
    if (logHistory.length === 0) {
        container.innerHTML = `<div class="response-empty">Belum ada riwayat tanggapan.</div>`;
        return;
    }
    
    const sorted = [...logHistory].sort((a,b) => new Date(b.date) - new Date(a.date));
    
    sorted.forEach(item => {
        const div = document.createElement('div');
        div.className = "history-item";
        
        const badgeClass = item.status === 'Diajukan' ? 'badge-orange' : 
                          item.status === 'Diverifikasi' ? 'badge-yellow' : 
                          item.status === 'Ditindaklanjuti' ? 'badge-blue' : 
                          item.status === 'Selesai' ? 'badge-green' : 'badge-red';
                          
        let attachmentHtml = "";
        if (item.fileName && item.fileData) {
            attachmentHtml = `
                <div style="margin-top: 0.3rem; font-size: 0.75rem;">
                    <strong>Lampiran:</strong> 
                    <a href="${escapeHTML(item.fileData)}" download="${escapeHTML(item.fileName)}" style="color: var(--color-primary); text-decoration: underline;">
                        📁 ${escapeHTML(item.fileName)}
                    </a>
                </div>
            `;
        }
        
        div.innerHTML = `
            <div class="history-meta">
                <span class="history-badge ${badgeClass}">${escapeHTML(item.status)}</span>
                <span>${formatDate(item.date)}</span>
            </div>
            <div style="margin-top:0.3rem;">
                <strong>${item.isUserMsg ? 'Pelapor' : 'Admin'}:</strong> ${escapeHTML(item.note)}
            </div>
            ${attachmentHtml}
        `;
        container.appendChild(div);
    });
}

// Handle administrative status updating and logger responses
function handleAdminUpdateStatus(event) {
    event.preventDefault();
    
    const token = document.getElementById('admin-update-token').value;
    const newStatus = document.getElementById('admin-status-select').value;
    const responseNote = document.getElementById('admin-response-text').value.trim();
    const date = new Date().toISOString();
    const adminToken = sessionStorage.getItem('wbs_admin_token');
    
    fetch('/api/admin/reports/update-status', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify({
            token: token,
            status: newStatus,
            note: responseNote,
            date: date,
            fileName: adminSelectedFileName,
            fileData: adminSelectedFileBase64
        })
    })
    .then(res => {
        if (!res.ok) {
            throw new Error('Gagal memperbarui status pengaduan');
        }
        return res.json();
    })
    .then(data => {
        closeAdminDetailModal();
        fetchAdminReports(); // Refresh local list and metrics
    })
    .catch(err => {
        alert(err.message);
        console.error(err);
    });
}

// Reset database to initial state
function resetMockData() {
    if (confirm("Apakah Anda yakin ingin mengosongkan seluruh data laporan? Semua laporan yang telah dibuat akan dihapus secara permanen.")) {
        const adminToken = sessionStorage.getItem('wbs_admin_token');
        fetch('/api/admin/reports/reset', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${adminToken}`
            }
        })
        .then(res => {
            if (!res.ok) {
                throw new Error('Gagal mengosongkan database');
            }
            return res.json();
        })
        .then(data => {
            alert("Seluruh data laporan berhasil dikosongkan!");
            fetchAdminReports();
        })
        .catch(err => {
            alert(err.message);
            console.error(err);
        });
    }
}

// 7. PUBLIC STATS ON LANDING PAGE
function updateHomeStats() {
    fetch('/api/reports/stats')
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            document.getElementById('stat-total').textContent = data.total;
            document.getElementById('stat-pending').textContent = data.pending;
            document.getElementById('stat-process').textContent = data.process;
            document.getElementById('stat-resolved').textContent = data.resolved;
        }
    })
    .catch(err => console.error('Error fetching home stats:', err));
}
