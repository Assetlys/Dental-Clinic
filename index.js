const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');
const adminRouter = require('./admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Security & Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"]
        }
    }
}));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false });
app.use('/api', limiter);

// MongoDB Connection (Cached for Serverless)
let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {
    if (cachedDb) return cachedDb;
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI environment variable is missing.');
    const client = new MongoClient(uri, { maxPoolSize: 10 });
    await client.connect();
    const db = client.db(process.env.MONGODB_DB_NAME || 'brightbite_clinic');
    
    // Ensure concurrency control via unique sparse index
    await db.collection('bookings').createIndex(
        { slotKey: 1 }, 
        { unique: true, partialFilterExpression: { status: { $in: ['Pending', 'Confirmed'] } } }
    );
    
    cachedClient = client;
    cachedDb = db;
    await initializeSiteContent(db);
    return db;
}

// Session Middleware
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI,
        dbName: process.env.MONGODB_DB_NAME || 'brightbite_clinic',
        collectionName: 'sessions'
    }),
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 // 1 day
    }
});
app.use(sessionMiddleware);

// Initial Dummy Content
async function initializeSiteContent(db) {
    const siteContent = db.collection('siteContent');
    const count = await siteContent.countDocuments();
    if (count === 0) {
        await siteContent.insertOne({
            type: 'config',
            clinicInfo: {
                name: 'BrightBite Dental Studio',
                phone: '+91 98765 43210',
                email: 'hello@brightbite.example',
                address: '24 Sample Market Road, New Delhi, India',
                hours: 'Monday–Saturday, 9:00 AM–7:00 PM',
                announcement: 'Complimentary Initial Consultation (Sample Promotion)'
            },
            services: [
                { id: 's1', name: 'General Dentistry', desc: 'Routine checkups and preventive care.', price: '₹500', active: true },
                { id: 's2', name: 'Teeth Cleaning and Scaling', desc: 'Professional removal of plaque and tartar.', price: '₹1500', active: true },
                { id: 's3', name: 'Teeth Whitening', desc: 'Advanced bleaching for a brighter smile.', price: '₹4000', active: true }
            ],
            doctors: [
                { id: 'd1', name: 'Dr. Aisha Sharma', specialty: 'General Dentist', bio: '10+ years experience in family dentistry.', active: true, img: 'https://images.unsplash.com/photo-1559839734-2b71ea197ec2?auto=format&fit=crop&w=300&q=80' },
                { id: 'd2', name: 'Dr. Rohan Mehta', specialty: 'Orthodontist', bio: 'Specialist in braces and clear aligners.', active: true, img: 'https://images.unsplash.com/photo-1622253692010-333f2da6031d?auto=format&fit=crop&w=300&q=80' },
                { id: 'd3', name: 'Dr. Neha Kapoor', specialty: 'Cosmetic Dentist', bio: 'Creating beautiful smiles with veneers.', active: true, img: 'https://images.unsplash.com/photo-1594824436916-2485fae46124?auto=format&fit=crop&w=300&q=80' }
            ],
            testimonials: [
                { id: 't1', name: 'A. Gupta', review: 'Fantastic experience. Very professional and painless treatment. (Placeholder)' },
                { id: 't2', name: 'S. Singh', review: 'The clinic is beautiful and the staff is extremely welcoming. (Placeholder)' }
            ],
            faqs: [
                { q: 'How do I book an appointment?', a: 'Simply click "Book Appointment" and follow the three-step process.' },
                { q: 'Can I choose my dentist?', a: 'Yes, you can select your preferred specialist during booking.' },
                { q: 'How much does an initial consultation cost?', a: 'Sample consultations are listed at ₹500.' }
            ]
        });
    }
}

// Global DB Middleware
app.use(async (req, res, next) => {
    try {
        req.db = await connectToDatabase();
        next();
    } catch (error) {
        console.error('Database connection failed:', error);
        res.status(500).json({ error: 'Internal Server Error. Database unavailable.' });
    }
});

// Admin Routes (Mounted securely)
app.use('/admin', adminRouter);

// Public APIs
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/api/site-content', async (req, res) => {
    const content = await req.db.collection('siteContent').findOne({ type: 'config' });
    res.json(content);
});

app.get('/api/availability', async (req, res) => {
    const { doctorId, date } = req.query;
    if (!doctorId || !date) return res.status(400).json({ error: 'Missing doctorId or date' });
    
    // Fetch bookings for this doctor and date that are active
    const bookings = await req.db.collection('bookings').find({
        dentistId: doctorId,
        date: date,
        status: { $in: ['Pending', 'Confirmed'] }
    }).toArray();
    
    const bookedTimes = bookings.map(b => b.time);
    res.json({ bookedTimes });
});

app.post('/api/bookings', async (req, res) => {
    const { serviceId, doctorId, date, time, patientName, patientEmail, patientPhone, note } = req.body;
    
    if (!serviceId || !doctorId || !date || !time || !patientName || !patientEmail || !patientPhone) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Server-side validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(patientEmail)) return res.status(400).json({ error: 'Invalid email format' });
    
    // Check if slot is in the past
    const slotDateTime = new Date(`${date}T${time}:00+05:30`); // Asia/Kolkata
    if (slotDateTime < new Date()) return res.status(400).json({ error: 'Cannot book in the past' });

    // Validate Doctor and Service exist
    const config = await req.db.collection('siteContent').findOne({ type: 'config' });
    const doctor = config.doctors.find(d => d.id === doctorId && d.active);
    const service = config.services.find(s => s.id === serviceId && s.active);
    
    if (!doctor || !service) return res.status(400).json({ error: 'Invalid or inactive service/doctor selected' });

    const ref = 'BB-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const slotKey = `${doctorId}_${date}_${time}`;

    const booking = {
        ref, serviceId, dentistId: doctorId, date, time, slotKey,
        serviceName: service.name, dentistName: doctor.name,
        patientName, patientEmail, patientPhone, note: note || '',
        status: 'Pending', createdAt: new Date(), updatedAt: new Date()
    };

    try {
        await req.db.collection('bookings').insertOne(booking);
        res.json({ success: true, ref, message: 'Booking confirmed' });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ error: 'This time slot was just booked by someone else. Please select another time.' });
        }
        console.error('Booking error:', error);
        res.status(500).json({ error: 'Failed to save booking. Please try again.' });
    }
});

// Serve Public Website (Embedded HTML/CSS/JS)
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BrightBite Dental Studio</title>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #f0f4f8; --text-main: #0f172a; --text-muted: #475569;
            --teal: #14b8a6; --sky: #0ea5e9; --mint: #34d399; --coral: #f43f5e;
            --glass-bg: rgba(255, 255, 255, 0.65);
            --glass-border: rgba(255, 255, 255, 0.4);
            --glass-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.07);
            --clay-bg: #ffffff;
            --clay-shadow: 6px 6px 12px #d1d9e6, -6px -6px 12px #ffffff;
            --clay-inner: inset 2px 2px 4px rgba(255, 255, 255, 0.5);
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
        body { background: var(--bg-color); color: var(--text-main); line-height: 1.6; overflow-x: hidden; scroll-behavior: smooth; }
        body::before { content: ''; position: fixed; top: -10%; left: -10%; width: 120%; height: 120%; background: radial-gradient(circle at 20% 30%, rgba(20, 184, 166, 0.15) 0%, transparent 40%), radial-gradient(circle at 80% 70%, rgba(14, 165, 233, 0.15) 0%, transparent 40%); z-index: -1; }
        
        .glass-panel { background: var(--glass-bg); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid var(--glass-border); box-shadow: var(--glass-shadow); border-radius: 20px; }
        .clay-btn { background: var(--clay-bg); border: none; border-radius: 16px; box-shadow: var(--clay-shadow); cursor: pointer; font-weight: 600; color: var(--teal); transition: all 0.2s; padding: 12px 24px; position: relative; overflow: hidden; display: inline-flex; align-items: center; justify-content: center; text-decoration: none; }
        .clay-btn:hover { box-shadow: 4px 4px 8px #d1d9e6, -4px -4px 8px #ffffff; transform: translateY(1px); color: var(--sky); }
        .clay-btn.primary { background: linear-gradient(135deg, var(--teal), var(--sky)); color: white; box-shadow: 0 4px 15px rgba(20, 184, 166, 0.4); }
        .clay-btn.primary:hover { box-shadow: 0 6px 20px rgba(14, 165, 233, 0.5); transform: translateY(-2px); }
        
        /* Layout */
        .container { max-width: 1200px; margin: 0 auto; padding: 0 20px; }
        header { position: fixed; top: 0; width: 100%; z-index: 100; transition: 0.3s; }
        .announcement { background: linear-gradient(90deg, var(--teal), var(--sky)); color: white; text-align: center; padding: 8px; font-size: 0.85rem; font-weight: 500; }
        .nav-bar { display: flex; justify-content: space-between; align-items: center; padding: 15px 20px; margin: 10px auto; max-width: 1200px; }
        .logo { font-size: 1.5rem; font-weight: 700; color: var(--text-main); text-decoration: none; display: flex; align-items: center; gap: 8px; }
        .logo svg { width: 28px; height: 28px; fill: var(--teal); }
        .nav-links { display: flex; gap: 24px; }
        .nav-links a { text-decoration: none; color: var(--text-muted); font-weight: 500; transition: 0.2s; }
        .nav-links a:hover { color: var(--teal); }
        
        section { padding: 100px 0; }
        h1, h2, h3 { line-height: 1.2; margin-bottom: 16px; }
        .section-title { text-align: center; font-size: 2.5rem; margin-bottom: 50px; color: var(--text-main); }
        
        /* Hero */
        .hero { min-height: 100vh; display: flex; align-items: center; padding-top: 120px; }
        .hero-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; align-items: center; }
        .hero-text h1 { font-size: 3.5rem; background: linear-gradient(135deg, var(--text-main), var(--teal)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .hero-text p { font-size: 1.1rem; color: var(--text-muted); margin-bottom: 30px; }
        .hero-image { position: relative; border-radius: 40px; overflow: hidden; box-shadow: var(--glass-shadow); }
        .hero-image img { width: 100%; height: auto; display: block; border-radius: 40px; }
        .floating-badge { position: absolute; bottom: 20px; left: -20px; padding: 16px; display: flex; align-items: center; gap: 12px; animation: float 4s ease-in-out infinite; }
        @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
        
        /* Services & Doctors & Testimonials */
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 30px; }
        .card { padding: 30px; text-align: center; transition: transform 0.3s; }
        .card:hover { transform: translateY(-5px); }
        .card-img { width: 100%; height: 200px; object-fit: cover; border-radius: 12px; margin-bottom: 20px; }
        .card h3 { font-size: 1.3rem; color: var(--text-main); }
        .card p { color: var(--text-muted); font-size: 0.95rem; margin-bottom: 20px; min-height: 45px; }
        .price-tag { display: inline-block; background: rgba(20, 184, 166, 0.1); color: var(--teal); padding: 4px 12px; border-radius: 20px; font-weight: 600; font-size: 0.85rem; margin-bottom: 15px; }
        
        /* FAQ */
        .faq-item { margin-bottom: 15px; border-radius: 16px; overflow: hidden; }
        .faq-question { padding: 20px; width: 100%; text-align: left; background: transparent; border: none; font-weight: 600; font-size: 1.05rem; cursor: pointer; display: flex; justify-content: space-between; color: var(--text-main); }
        .faq-answer { padding: 0 20px; max-height: 0; overflow: hidden; transition: 0.3s; color: var(--text-muted); }
        .faq-item.active .faq-answer { padding: 0 20px 20px 20px; max-height: 200px; }
        
        /* Footer */
        footer { padding: 60px 0 20px; background: rgba(255,255,255,0.4); backdrop-filter: blur(10px); border-top: 1px solid var(--glass-border); margin-top: 50px; }
        .footer-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 40px; margin-bottom: 40px; }
        .disclaimer { font-size: 0.8rem; color: var(--text-muted); text-align: center; border-top: 1px solid rgba(0,0,0,0.05); padding-top: 20px; }

        /* Booking Modal */
        .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15, 23, 42, 0.5); backdrop-filter: blur(5px); z-index: 1000; display: flex; justify-content: center; align-items: center; opacity: 0; pointer-events: none; transition: 0.3s; }
        .modal-overlay.active { opacity: 1; pointer-events: auto; }
        .modal { width: 90%; max-width: 600px; padding: 40px; position: relative; max-height: 90vh; overflow-y: auto; }
        .modal-close { position: absolute; top: 20px; right: 20px; background: transparent; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted); }
        .step { display: none; animation: fadeIn 0.4s; }
        .step.active { display: block; }
        @keyframes fadeIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
        
        .form-group { margin-bottom: 20px; text-align: left; }
        .form-group label { display: block; margin-bottom: 8px; font-weight: 600; font-size: 0.9rem; }
        .form-control { width: 100%; padding: 14px; border: 1px solid var(--glass-border); border-radius: 12px; background: rgba(255,255,255,0.7); color: var(--text-main); font-family: inherit; transition: 0.3s; }
        .form-control:focus { outline: none; border-color: var(--teal); background: white; box-shadow: 0 0 0 4px rgba(20, 184, 166, 0.1); }
        
        .time-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 10px; }
        .time-slot { padding: 10px; text-align: center; border-radius: 10px; border: 1px solid var(--glass-border); background: rgba(255,255,255,0.5); cursor: pointer; transition: 0.2s; }
        .time-slot:hover:not(.disabled) { background: white; border-color: var(--teal); }
        .time-slot.selected { background: var(--teal); color: white; border-color: var(--teal); }
        .time-slot.disabled { opacity: 0.4; cursor: not-allowed; text-decoration: line-through; }
        
        .btn-group { display: flex; justify-content: space-between; margin-top: 30px; }
        
        /* Toast */
        #toast { position: fixed; bottom: 30px; right: 30px; background: white; color: var(--text-main); padding: 15px 25px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); z-index: 2000; transform: translateY(100px); opacity: 0; transition: 0.4s; border-left: 5px solid var(--teal); }
        #toast.show { transform: translateY(0); opacity: 1; }
        #toast.error { border-left-color: var(--coral); }

        @media (max-width: 768px) {
            .hero-grid { grid-template-columns: 1fr; }
            .hero-text h1 { font-size: 2.5rem; }
            .nav-links { display: none; }
        }
    </style>
</head>
<body>
    <header id="main-header">
        <div class="announcement" id="announcement-strip">Loading promotions...</div>
        <div class="nav-bar glass-panel">
            <a href="#" class="logo">
                <svg viewBox="0 0 24 24"><path d="M12,2C8.36,2 5,4.32 5,7.7C5,9.65 6.25,11 7,12C7.38,12.5 7.5,13.11 7.25,13.68C6.93,14.44 6,16.59 6,18.5C6,20.43 7.57,22 9.5,22C10.74,22 11.66,21.36 12,20.89C12.34,21.36 13.26,22 14.5,22C16.43,22 18,20.43 18,18.5C18,16.59 17.07,14.44 16.75,13.68C16.5,13.11 16.62,12.5 17,12C17.75,11 19,9.65 19,7.7C19,4.32 15.64,2 12,2Z" /></svg>
                <span id="brand-name">BrightBite</span>
            </a>
            <div class="nav-links">
                <a href="#services">Services</a>
                <a href="#dentists">Our Dentists</a>
                <a href="#about">Why Us</a>
                <a href="#testimonials">Testimonials</a>
                <a href="#faq">FAQ</a>
            </div>
            <button class="clay-btn primary" onclick="openBookingModal()">Book Appointment</button>
        </div>
    </header>

    <main>
        <section class="hero container">
            <div class="hero-grid">
                <div class="hero-text">
                    <h1>A Healthier Smile Starts Here.</h1>
                    <p>Personalized dental care, experienced professionals, and convenient appointments designed around you.</p>
                    <div style="display: flex; gap: 15px; flex-wrap: wrap;">
                        <button class="clay-btn primary" onclick="openBookingModal()">Book Your Appointment</button>
                        <a href="#services" class="clay-btn">Explore Our Services</a>
                    </div>
                </div>
                <div class="hero-image">
                    <img src="https://images.unsplash.com/photo-1606811841689-23dfddce3e95?auto=format&fit=crop&w=800&q=80" alt="Smiling patient at dental clinic" />
                    <div class="floating-badge glass-panel">
                        <div style="width:40px; height:40px; background:var(--teal); border-radius:50%; display:flex; align-items:center; justify-content:center; color:white; font-weight:bold;">4.9</div>
                        <div><strong style="display:block;">Patient Satisfaction</strong><span style="font-size:0.8rem; color:var(--text-muted);">(Sample Rating)</span></div>
                    </div>
                </div>
            </div>
        </section>

        <section id="services" class="container">
            <h2 class="section-title">Our Dental Services</h2>
            <div class="grid" id="services-grid">Loading services...</div>
        </section>

        <section id="dentists" class="container">
            <h2 class="section-title">Meet Our Specialists</h2>
            <div class="grid" id="doctors-grid">Loading doctors...</div>
        </section>

        <section id="about" class="container">
            <h2 class="section-title">Why Choose Us</h2>
            <div class="grid">
                <div class="card glass-panel"><h3>Personalized Plans</h3><p>Care tailored to your unique smile and needs.</p></div>
                <div class="card glass-panel"><h3>Modern Equipment</h3><p>Comfortable treatments in a welcoming environment.</p></div>
                <div class="card glass-panel"><h3>Easy Scheduling</h3><p>Seamless online booking and management.</p></div>
            </div>
        </section>
        
        <section id="how-it-works" class="container" style="text-align: center;">
            <h2 class="section-title">How Booking Works</h2>
            <div class="grid" style="align-items: center;">
                <div class="glass-panel" style="padding: 30px;"><h2>1</h2><p>Choose a treatment</p></div>
                <div class="glass-panel" style="padding: 30px;"><h2>2</h2><p>Select a dentist, date & time</p></div>
                <div class="glass-panel" style="padding: 30px;"><h2>3</h2><p>Submit your details</p></div>
            </div>
        </section>

        <section id="testimonials" class="container">
            <h2 class="section-title">Patient Testimonials</h2>
            <div class="grid" id="testimonials-grid"></div>
        </section>

        <section id="faq" class="container" style="max-width: 800px;">
            <h2 class="section-title">Frequently Asked Questions</h2>
            <div id="faq-list"></div>
        </section>
    </main>

    <footer>
        <div class="container">
            <div class="footer-grid">
                <div>
                    <h3 id="footer-name">BrightBite Studio</h3>
                    <p id="footer-address">Address...</p>
                    <p id="footer-email">Email...</p>
                    <p id="footer-phone">Phone...</p>
                </div>
                <div>
                    <h3>Quick Links</h3>
                    <ul style="list-style:none; padding:0;">
                        <li><a href="#services" style="color:var(--text-muted); text-decoration:none;">Services</a></li>
                        <li><a href="#dentists" style="color:var(--text-muted); text-decoration:none;">Our Dentists</a></li>
                        <li><a href="/admin" style="color:var(--text-muted); text-decoration:none;">Admin Login</a></li>
                    </ul>
                </div>
                <div>
                    <h3>Operating Hours</h3>
                    <p id="footer-hours">Hours...</p>
                </div>
            </div>
            <div class="disclaimer">
                &copy; <span id="year"></span> <span id="copyright-name">BrightBite Dental Studio</span>. All rights reserved.<br>
                Disclaimer: The information on this website is for general informational purposes only and is not a substitute for professional dental evaluation.
            </div>
        </div>
    </footer>

    <!-- Booking Modal -->
    <div class="modal-overlay" id="booking-modal">
        <div class="modal glass-panel">
            <button class="modal-close" onclick="closeBookingModal()">&times;</button>
            <h2 style="margin-bottom: 20px;">Book an Appointment</h2>
            
            <div id="step-1" class="step active">
                <h3>Step 1: Choose Service</h3>
                <div class="form-group" style="margin-top:20px;">
                    <label>Select Treatment</label>
                    <select id="book-service" class="form-control"></select>
                </div>
                <div class="btn-group" style="justify-content: flex-end;">
                    <button class="clay-btn primary" onclick="nextStep(2)">Next</button>
                </div>
            </div>

            <div id="step-2" class="step">
                <h3>Step 2: Dentist & Time</h3>
                <div class="form-group" style="margin-top:20px;">
                    <label>Select Dentist</label>
                    <select id="book-doctor" class="form-control" onchange="checkAvailability()"></select>
                </div>
                <div class="form-group">
                    <label>Select Date</label>
                    <input type="date" id="book-date" class="form-control" onchange="checkAvailability()" min="">
                </div>
                <div class="form-group">
                    <label>Available Times (Asia/Kolkata)</label>
                    <div id="time-slots" class="time-grid">Select a doctor and date first.</div>
                    <input type="hidden" id="book-time">
                </div>
                <div class="btn-group">
                    <button class="clay-btn" onclick="nextStep(1)">Back</button>
                    <button class="clay-btn primary" onclick="validateStep2()">Next</button>
                </div>
            </div>

            <div id="step-3" class="step">
                <h3>Step 3: Patient Details</h3>
                <div class="form-group" style="margin-top:20px;">
                    <label>Full Name</label>
                    <input type="text" id="book-name" class="form-control" placeholder="John Doe">
                </div>
                <div class="form-group">
                    <label>Email Address</label>
                    <input type="email" id="book-email" class="form-control" placeholder="john@example.com">
                </div>
                <div class="form-group">
                    <label>Mobile Number</label>
                    <input type="tel" id="book-phone" class="form-control" placeholder="+91 98765 43210">
                </div>
                <div class="form-group">
                    <label>Note (Optional)</label>
                    <textarea id="book-note" class="form-control" rows="2"></textarea>
                </div>
                <div class="form-group" style="display:flex; align-items:center; gap:10px;">
                    <input type="checkbox" id="book-privacy">
                    <label style="margin:0; font-weight:normal; font-size:0.85rem;">I acknowledge the privacy notice.</label>
                </div>
                <div class="btn-group">
                    <button class="clay-btn" onclick="nextStep(2)">Back</button>
                    <button class="clay-btn primary" onclick="submitBooking()" id="submit-btn">Submit Booking</button>
                </div>
            </div>

            <div id="step-success" class="step" style="text-align: center;">
                <div style="font-size: 3rem; color: var(--teal); margin-bottom: 20px;">✓</div>
                <h3>Booking Confirmed!</h3>
                <p>Your reference number is: <strong id="booking-ref" style="color:var(--sky); font-size:1.2rem;"></strong></p>
                <p style="margin-top: 15px; color: var(--text-muted);">Please keep this reference for your records. We will contact you shortly.</p>
                <button class="clay-btn primary" style="margin-top:30px;" onclick="closeBookingModal()">Done</button>
            </div>
        </div>
    </div>

    <div id="toast">Message</div>

    <script>
        document.getElementById('year').textContent = new Date().getFullYear();
        
        let globalContent = {};
        
        // Fetch Content
        async function fetchContent() {
            try {
                const res = await fetch('/api/site-content');
                globalContent = await res.json();
                renderContent();
            } catch (err) {
                console.error('Failed to load content', err);
            }
        }

        function renderContent() {
            const { clinicInfo, services, doctors, testimonials, faqs } = globalContent;
            
            document.getElementById('announcement-strip').innerText = clinicInfo.announcement;
            document.getElementById('brand-name').innerText = clinicInfo.name;
            document.getElementById('footer-name').innerText = clinicInfo.name;
            document.getElementById('copyright-name').innerText = clinicInfo.name;
            document.getElementById('footer-address').innerText = clinicInfo.address;
            document.getElementById('footer-email').innerText = clinicInfo.email;
            document.getElementById('footer-phone').innerText = clinicInfo.phone;
            document.getElementById('footer-hours').innerText = clinicInfo.hours;

            // Render Services
            const srvGrid = document.getElementById('services-grid');
            const srvSelect = document.getElementById('book-service');
            srvGrid.innerHTML = ''; srvSelect.innerHTML = '<option value="">Select Treatment...</option>';
            services.filter(s=>s.active).forEach(s => {
                srvGrid.innerHTML += \`<div class="card glass-panel">
                    <span class="price-tag">\${s.price}*</span>
                    <h3>\${s.name}</h3>
                    <p>\${s.desc}</p>
                    <button class="clay-btn" onclick="preselectService('\${s.id}')">Book This</button>
                </div>\`;
                srvSelect.innerHTML += \`<option value="\${s.id}">\${s.name}</option>\`;
            });

            // Render Doctors
            const docGrid = document.getElementById('doctors-grid');
            const docSelect = document.getElementById('book-doctor');
            docGrid.innerHTML = ''; docSelect.innerHTML = '<option value="">Select Dentist...</option>';
            doctors.filter(d=>d.active).forEach(d => {
                docGrid.innerHTML += \`<div class="card glass-panel">
                    <img src="\${d.img}" alt="\${d.name}" class="card-img" onerror="this.style.display='none'">
                    <h3>\${d.name}</h3>
                    <p style="color:var(--teal); font-weight:600; margin-bottom:5px;">\${d.specialty}</p>
                    <p>\${d.bio}</p>
                    <button class="clay-btn" onclick="preselectDoctor('\${d.id}')">Book Appointment</button>
                </div>\`;
                docSelect.innerHTML += \`<option value="\${d.id}">\${d.name} (\${d.specialty})</option>\`;
            });

            // Render Testimonials
            const tGrid = document.getElementById('testimonials-grid');
            tGrid.innerHTML = '';
            testimonials.forEach(t => {
                tGrid.innerHTML += \`<div class="card glass-panel">
                    <p>"\${t.review}"</p>
                    <h4 style="margin-top:15px; color:var(--teal);">– \${t.name}</h4>
                </div>\`;
            });

            // Render FAQs
            const faqList = document.getElementById('faq-list');
            faqList.innerHTML = '';
            faqs.forEach(f => {
                faqList.innerHTML += \`<div class="faq-item glass-panel">
                    <button class="faq-question">\${f.q} <span>+</span></button>
                    <div class="faq-answer"><p style="padding-top:10px;">\${f.a}</p></div>
                </div>\`;
            });

            // FAQ Accordion Logic
            document.querySelectorAll('.faq-question').forEach(btn => {
                btn.addEventListener('click', () => {
                    const parent = btn.parentElement;
                    parent.classList.toggle('active');
                });
            });

            // Set Min Date
            const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
            document.getElementById('book-date').min = today;
        }

        // Booking Modal Logic
        function openBookingModal() {
            document.getElementById('booking-modal').classList.add('active');
            nextStep(1);
        }
        function closeBookingModal() {
            document.getElementById('booking-modal').classList.remove('active');
            resetForm();
        }
        function nextStep(step) {
            document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
            document.getElementById('step-' + step).classList.add('active');
        }
        function preselectService(id) { document.getElementById('book-service').value = id; openBookingModal(); nextStep(2); }
        function preselectDoctor(id) { document.getElementById('book-doctor').value = id; openBookingModal(); nextStep(2); }

        async function checkAvailability() {
            const doctorId = document.getElementById('book-doctor').value;
            const date = document.getElementById('book-date').value;
            const slotsContainer = document.getElementById('time-slots');
            
            if (!doctorId || !date) { slotsContainer.innerHTML = 'Select a doctor and date first.'; return; }
            
            slotsContainer.innerHTML = 'Loading...';
            try {
                const res = await fetch(\`/api/availability?doctorId=\${doctorId}&date=\${date}\`);
                const { bookedTimes } = await res.json();
                
                // Generate slots 9:00 to 17:00
                const allSlots = ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00'];
                slotsContainer.innerHTML = '';
                
                allSlots.forEach(time => {
                    const isBooked = bookedTimes.includes(time);
                    const div = document.createElement('div');
                    div.className = \`time-slot \${isBooked ? 'disabled' : ''}\`;
                    div.textContent = time;
                    if (!isBooked) {
                        div.onclick = () => selectTime(div, time);
                    }
                    slotsContainer.appendChild(div);
                });
            } catch (err) {
                slotsContainer.innerHTML = 'Error checking availability.';
            }
        }

        function selectTime(el, time) {
            document.querySelectorAll('.time-slot').forEach(e => e.classList.remove('selected'));
            el.classList.add('selected');
            document.getElementById('book-time').value = time;
        }

        function validateStep2() {
            const dr = document.getElementById('book-doctor').value;
            const dt = document.getElementById('book-date').value;
            const tm = document.getElementById('book-time').value;
            if(!dr || !dt || !tm) { showToast('Please select doctor, date, and time.', true); return; }
            nextStep(3);
        }

        async function submitBooking() {
            if(!document.getElementById('book-privacy').checked) { showToast('Please acknowledge privacy notice.', true); return; }
            
            const payload = {
                serviceId: document.getElementById('book-service').value,
                doctorId: document.getElementById('book-doctor').value,
                date: document.getElementById('book-date').value,
                time: document.getElementById('book-time').value,
                patientName: document.getElementById('book-name').value,
                patientEmail: document.getElementById('book-email').value,
                patientPhone: document.getElementById('book-phone').value,
                note: document.getElementById('book-note').value
            };
            
            if(!payload.patientName || !payload.patientEmail || !payload.patientPhone) {
                showToast('Please fill all required contact fields.', true); return;
            }

            const btn = document.getElementById('submit-btn');
            btn.textContent = 'Submitting...'; btn.disabled = true;

            try {
                const res = await fetch('/api/bookings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                
                if (res.ok) {
                    document.getElementById('booking-ref').textContent = data.ref;
                    nextStep('success');
                } else {
                    showToast(data.error || 'Failed to submit', true);
                    if(res.status === 409) { nextStep(2); checkAvailability(); } // Conflict
                }
            } catch(err) {
                showToast('Network error', true);
            } finally {
                btn.textContent = 'Submit Booking'; btn.disabled = false;
            }
        }

        function resetForm() {
            document.getElementById('book-service').value = '';
            document.getElementById('book-doctor').value = '';
            document.getElementById('book-date').value = '';
            document.getElementById('book-time').value = '';
            document.getElementById('book-name').value = '';
            document.getElementById('book-email').value = '';
            document.getElementById('book-phone').value = '';
            document.getElementById('book-note').value = '';
            document.getElementById('book-privacy').checked = false;
            document.getElementById('time-slots').innerHTML = 'Select a doctor and date first.';
        }

        function showToast(msg, isError=false) {
            const t = document.getElementById('toast');
            t.textContent = msg;
            t.className = isError ? 'error show' : 'show';
            setTimeout(() => t.className = '', 3000);
        }

        // Header scroll effect
        window.addEventListener('scroll', () => {
            const nav = document.querySelector('.nav-bar');
            if(window.scrollY > 50) {
                nav.style.background = 'var(--clay-bg)';
                nav.style.boxShadow = 'var(--clay-shadow)';
            } else {
                nav.style.background = 'var(--glass-bg)';
                nav.style.boxShadow = 'var(--glass-shadow)';
            }
        });

        fetchContent();
    </script>
</body>
</html>`);
});

// Export app for Vercel
module.exports = app;

if (require.main === module) {
    app.listen(PORT, () => console.log(`BrightBite running on http://localhost:${PORT}`));
}
