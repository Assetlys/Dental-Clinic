const express = require('express');
const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');

const router = express.Router();

// Middleware: Check if authenticated
const requireAuth = (req, res, next) => {
    if (req.session && req.session.adminId) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
    res.redirect('/admin');
};

// Admin Login API
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminHash = process.env.ADMIN_PASSWORD_HASH;

    if (!adminEmail || !adminHash) {
        return res.status(500).json({ error: 'Server configuration missing. Contact support.' });
    }

    if (email === adminEmail && bcrypt.compareSync(password, adminHash)) {
        req.session.adminId = email;
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

router.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Admin API Routes
router.get('/api/dashboard', requireAuth, async (req, res) => {
    const db = req.db;
    const [total, pending, confirmed, completed] = await Promise.all([
        db.collection('bookings').countDocuments(),
        db.collection('bookings').countDocuments({ status: 'Pending' }),
        db.collection('bookings').countDocuments({ status: 'Confirmed' }),
        db.collection('bookings').countDocuments({ status: 'Completed' })
    ]);
    res.json({ total, pending, confirmed, completed });
});

router.get('/api/bookings', requireAuth, async (req, res) => {
    const bookings = await req.db.collection('bookings').find().sort({ createdAt: -1 }).limit(100).toArray();
    res.json(bookings);
});

router.patch('/api/bookings/:id', requireAuth, async (req, res) => {
    const { status } = req.body;
    const validStatuses = ['Pending', 'Confirmed', 'Completed', 'Cancelled'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    try {
        await req.db.collection('bookings').updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { status, updatedAt: new Date() } }
        );
        // Audit log
        await req.db.collection('adminAuditLogs').insertOne({
            action: 'UPDATE_BOOKING_STATUS',
            bookingId: req.params.id,
            newStatus: status,
            admin: req.session.adminId,
            timestamp: new Date()
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Update failed' });
    }
});

// Serve Admin UI
router.get('/', (req, res) => {
    const isAuthenticated = !!(req.session && req.session.adminId);
    
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin - BrightBite Dental Studio</title>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root { --bg-color: #f0f4f8; --text-main: #0f172a; --teal: #14b8a6; --sky: #0ea5e9; --glass-bg: rgba(255, 255, 255, 0.7); --clay-bg: #ffffff; }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
        body { background: var(--bg-color); color: var(--text-main); }
        .glass-panel { background: var(--glass-bg); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.4); border-radius: 16px; box-shadow: 0 4px 30px rgba(0,0,0,0.05); }
        .clay-btn { background: var(--clay-bg); border: none; border-radius: 8px; box-shadow: 4px 4px 8px #d1d9e6, -4px -4px 8px #ffffff; cursor: pointer; font-weight: 600; padding: 10px 20px; transition: 0.2s; color: var(--teal); }
        .clay-btn:hover { transform: translateY(1px); }
        .clay-btn.primary { background: var(--teal); color: white; box-shadow: 0 4px 15px rgba(20,184,166,0.3); }
        input, select { width: 100%; padding: 12px; margin-bottom: 15px; border-radius: 8px; border: 1px solid #ccc; outline: none; }
        input:focus, select:focus { border-color: var(--teal); }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background: rgba(20,184,166,0.1); color: var(--teal); }
        .status-badge { padding: 4px 8px; border-radius: 12px; font-size: 0.8rem; font-weight: bold; }
        .status-Pending { background: #fef08a; color: #854d0e; }
        .status-Confirmed { background: #bfdbfe; color: #1e40af; }
        .status-Completed { background: #bbf7d0; color: #166534; }
        .status-Cancelled { background: #fecdd3; color: #9f1239; }
        
        #login-screen { display: flex; height: 100vh; justify-content: center; align-items: center; }
        .login-box { padding: 40px; width: 100%; max-width: 400px; text-align: center; }
        
        #dashboard { display: none; padding: 20px; max-width: 1200px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; }
        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 30px; }
        .stat-card { padding: 20px; text-align: center; }
        .stat-card h3 { font-size: 2rem; color: var(--teal); }
        
        @media (max-width: 768px) { .stats-grid { grid-template-columns: 1fr 1fr; } table { display: block; overflow-x: auto; } }
    </style>
</head>
<body>

    ${!isAuthenticated ? `
    <div id="login-screen">
        <div class="login-box glass-panel">
            <h2 style="margin-bottom: 20px; color: var(--teal);">Admin Login</h2>
            <input type="email" id="email" placeholder="Admin Email" required>
            <input type="password" id="password" placeholder="Password" required>
            <button class="clay-btn primary" onclick="login()" style="width: 100%;">Secure Login</button>
            <p id="login-error" style="color: red; margin-top: 10px; display:none;"></p>
        </div>
    </div>` : `
    
    <div id="dashboard">
        <div class="header">
            <h2>BrightBite Admin</h2>
            <button class="clay-btn" onclick="logout()">Logout</button>
        </div>
        
        <div class="stats-grid">
            <div class="stat-card glass-panel"><h3 id="stat-total">0</h3><p>Total Bookings</p></div>
            <div class="stat-card glass-panel"><h3 id="stat-pending">0</h3><p>Pending</p></div>
            <div class="stat-card glass-panel"><h3 id="stat-confirmed">0</h3><p>Confirmed</p></div>
            <div class="stat-card glass-panel"><h3 id="stat-completed">0</h3><p>Completed</p></div>
        </div>

        <div class="glass-panel" style="padding: 20px;">
            <h3>Recent Appointments</h3>
            <table>
                <thead>
                    <tr>
                        <th>Ref</th><th>Patient</th><th>Service</th><th>Date & Time</th><th>Status</th><th>Actions</th>
                    </tr>
                </thead>
                <tbody id="bookings-table">
                    <tr><td colspan="6" style="text-align:center;">Loading...</td></tr>
                </tbody>
            </table>
        </div>
    </div>
    `}

    <script>
        const isAuth = ${isAuthenticated};
        
        async function login() {
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const res = await fetch('/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const data = await res.json();
            if (res.ok) window.location.reload();
            else {
                document.getElementById('login-error').innerText = data.error;
                document.getElementById('login-error').style.display = 'block';
            }
        }

        async function logout() {
            await fetch('/admin/logout', { method: 'POST' });
            window.location.reload();
        }

        if (isAuth) {
            document.getElementById('dashboard').style.display = 'block';
            loadDashboard();
        }

        async function loadDashboard() {
            try {
                const statsRes = await fetch('/admin/api/dashboard');
                const stats = await statsRes.json();
                document.getElementById('stat-total').innerText = stats.total;
                document.getElementById('stat-pending').innerText = stats.pending;
                document.getElementById('stat-confirmed').innerText = stats.confirmed;
                document.getElementById('stat-completed').innerText = stats.completed;

                const bookingsRes = await fetch('/admin/api/bookings');
                const bookings = await bookingsRes.json();
                
                const tbody = document.getElementById('bookings-table');
                if (bookings.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No bookings found.</td></tr>';
                    return;
                }
                
                tbody.innerHTML = '';
                bookings.forEach(b => {
                    tbody.innerHTML += \`<tr>
                        <td><strong>\${b.ref}</strong></td>
                        <td>\${b.patientName}<br><small>\${b.patientPhone}</small></td>
                        <td>\${b.serviceName}<br><small>\${b.dentistName}</small></td>
                        <td>\${b.date} <br> \${b.time}</td>
                        <td><span class="status-badge status-\${b.status}">\${b.status}</span></td>
                        <td>
                            <select onchange="updateStatus('\${b._id}', this.value)" style="margin:0; padding:6px; width:auto;">
                                <option value="" disabled selected>Update...</option>
                                \${b.status !== 'Confirmed' ? '<option value="Confirmed">Confirm</option>' : ''}
                                \${b.status !== 'Completed' ? '<option value="Completed">Complete</option>' : ''}
                                \${b.status !== 'Cancelled' ? '<option value="Cancelled">Cancel</option>' : ''}
                            </select>
                        </td>
                    </tr>\`;
                });
            } catch (err) {
                console.error('Failed to load dashboard data');
            }
        }

        async function updateStatus(id, status) {
            if(!confirm(\`Change status to \${status}?\`)) { loadDashboard(); return; }
            await fetch(\`/admin/api/bookings/\${id}\`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status })
            });
            loadDashboard();
        }
    </script>
</body>
</html>`);
});

module.exports = router;
