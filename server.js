require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = process.env.JWT_SECRET || 'wishfish-dev-secret';
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'wishfish.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    host_id INTEGER NOT NULL,
    is_scheduled INTEGER DEFAULT 0,
    scheduled_time DATETIME,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (host_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    invited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reminder_1h_sent INTEGER DEFAULT 0,
    reminder_15m_sent INTEGER DEFAULT 0,
    UNIQUE(session_id, email),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, user_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
`);

// ── Email ─────────────────────────────────────────────────────────────────────
const transporter = process.env.SMTP_USER
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  : null;

async function sendEmail(to, subject, html) {
  if (!transporter) {
    console.log(`[Email SKIPPED - no SMTP config] To: ${to} | Subject: ${subject}`);
    return;
  }
  try {
    await transporter.sendMail({
      from: `"Wish Fish Coding" <${process.env.SMTP_USER}>`,
      to, subject, html
    });
    console.log(`[Email sent] To: ${to}`);
  } catch (err) {
    console.error('[Email error]', err.message);
  }
}

function inviteEmailHtml(title, code, scheduledTime, isReminder, reminderText) {
  const schedLine = scheduledTime
    ? `<p style="color:#7a9cc8">Scheduled: <strong style="color:#e8f0ff">${new Date(scheduledTime).toLocaleString()}</strong></p>`
    : '';
  const heading = isReminder
    ? `⏰ Reminder: "${title}" starts ${reminderText}`
    : `You're invited to "${title}"`;
  return `
    <div style="font-family:Arial,sans-serif;background:#0a0e1a;color:#e8f0ff;padding:36px;border-radius:12px;max-width:480px;margin:auto;border:1px solid rgba(30,144,255,.2)">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
        <span style="font-size:28px">🐟</span>
        <span style="font-size:1.4rem;font-weight:800;background:linear-gradient(135deg,#1e90ff,#00b4d8);-webkit-background-clip:text;-webkit-text-fill-color:transparent">Wish Fish Coding</span>
      </div>
      <h2 style="color:#e8f0ff;margin-bottom:12px">${heading}</h2>
      ${schedLine}
      <p style="color:#7a9cc8;margin-bottom:20px">Session code:</p>
      <div style="background:#111c35;border:1px solid rgba(30,144,255,.4);border-radius:10px;padding:20px;text-align:center;margin-bottom:24px">
        <span style="font-family:'Courier New',monospace;font-size:2.2rem;font-weight:900;color:#1e90ff;letter-spacing:4px">${code}</span>
      </div>
      <a href="${APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#1e90ff,#0070dd);color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Open Wish Fish Coding</a>
    </div>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function genCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const D = '0123456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += L[Math.floor(Math.random() * L.length)];
  for (let i = 0; i < 3; i++) c += D[Math.floor(Math.random() * D.length)];
  return c;
}

function uniqueCode() {
  let code;
  do { code = genCode(); }
  while (db.prepare('SELECT id FROM sessions WHERE code=?').get(code));
  return code;
}

function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Express ───────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// HTML routes
app.get('/dashboard', (_, res) => res.sendFile(path.join(__dirname, 'public/dashboard.html')));
app.get('/session', (_, res) => res.sendFile(path.join(__dirname, 'public/session.html')));
app.get('/register', (_, res) => res.sendFile(path.join(__dirname, 'public/register.html')));

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { email, username, password } = req.body || {};
  if (!email || !username || !password)
    return res.status(400).json({ error: 'All fields are required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (email,username,password_hash) VALUES (?,?,?)')
      .run(email.trim().toLowerCase(), username.trim(), hash);
    const token = jwt.sign({ id: lastInsertRowid, username: username.trim() }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: username.trim() });
  } catch (err) {
    if (err.message.includes('UNIQUE'))
      return res.status(400).json({ error: 'Email or username already taken' });
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username.trim());
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username });
});

// ── Sessions ──────────────────────────────────────────────────────────────────
app.get('/api/sessions', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, u.username AS host_username,
      (SELECT COUNT(*) FROM participants WHERE session_id=s.id) AS participant_count,
      (SELECT COUNT(*) FROM invites WHERE session_id=s.id) AS invite_count
    FROM sessions s JOIN users u ON s.host_id=u.id
    WHERE s.host_id=? ORDER BY s.created_at DESC
  `).all(req.user.id);
  res.json(rows);
});

app.post('/api/sessions', authMiddleware, (req, res) => {
  const { title, is_scheduled, scheduled_time } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const code = uniqueCode();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO sessions (code,title,host_id,is_scheduled,scheduled_time) VALUES (?,?,?,?,?)')
    .run(code, title.trim(), req.user.id, is_scheduled ? 1 : 0, scheduled_time || null);
  res.json(db.prepare('SELECT * FROM sessions WHERE id=?').get(lastInsertRowid));
});

app.get('/api/sessions/:code', authMiddleware, (req, res) => {
  const session = db.prepare(`
    SELECT s.*, u.username AS host_username
    FROM sessions s JOIN users u ON s.host_id=u.id
    WHERE s.code=?
  `).get(req.params.code.toUpperCase());
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const invites = db.prepare('SELECT email FROM invites WHERE session_id=?').all(session.id);
  const messages = db.prepare(`
    SELECT id, username, content, created_at FROM messages
    WHERE session_id=? ORDER BY created_at ASC LIMIT 200
  `).all(session.id);
  res.json({ ...session, invites, messages });
});

app.post('/api/sessions/:code/invite', authMiddleware, async (req, res) => {
  const { emails } = req.body || {};
  if (!emails?.length) return res.status(400).json({ error: 'Emails required' });
  const session = db.prepare('SELECT * FROM sessions WHERE code=?').get(req.params.code.toUpperCase());
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const insert = db.prepare('INSERT OR IGNORE INTO invites (session_id,email) VALUES (?,?)');
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (!email) continue;
    insert.run(session.id, email);
    const subj = session.is_scheduled
      ? `You're invited to "${session.title}" on Wish Fish Coding`
      : `Join "${session.title}" now on Wish Fish Coding`;
    sendEmail(email, subj, inviteEmailHtml(session.title, session.code, session.scheduled_time, false, ''));
  }
  res.json({ success: true });
});

app.delete('/api/sessions/:code', authMiddleware, (req, res) => {
  const session = db
    .prepare('SELECT * FROM sessions WHERE code=? AND host_id=?')
    .get(req.params.code.toUpperCase(), req.user.id);
  if (!session) return res.status(404).json({ error: 'Session not found or not yours' });
  db.prepare('UPDATE sessions SET is_active=0 WHERE id=?').run(session.id);
  io.to(req.params.code.toUpperCase()).emit('session-ended');
  res.json({ success: true });
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
// roomState: code -> { participants: Map<socketId, {socketId,username,userId}>, sharerId: string|null }
const roomState = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  socket.on('join-session', ({ code }) => {
    const room = code.toUpperCase();
    const session = db.prepare('SELECT * FROM sessions WHERE code=?').get(room);
    if (!session) { socket.emit('error', { message: 'Session not found' }); return; }

    socket.join(room);
    socket.sessionCode = room;
    socket.sessionDbId = session.id;

    if (!roomState.has(room)) roomState.set(room, { participants: new Map(), sharerId: null });
    const state = roomState.get(room);
    state.participants.set(socket.id, { socketId: socket.id, username: socket.user.username, userId: socket.user.id });

    db.prepare('INSERT OR IGNORE INTO participants (session_id,user_id) VALUES (?,?)').run(session.id, socket.user.id);

    // Tell joining user about existing peers (for WebRTC)
    const peers = [...state.participants.values()].filter(p => p.socketId !== socket.id);
    socket.emit('room-state', { peers, sharerId: state.sharerId });

    // Tell everyone about the updated list
    io.to(room).emit('participants-update', [...state.participants.values()]);
    socket.to(room).emit('user-joined', { socketId: socket.id, username: socket.user.username });
  });

  socket.on('chat-message', ({ content }) => {
    if (!socket.sessionCode || !content?.trim()) return;
    const text = content.trim();
    db.prepare('INSERT INTO messages (session_id,user_id,username,content) VALUES (?,?,?,?)')
      .run(socket.sessionDbId, socket.user.id, socket.user.username, text);
    io.to(socket.sessionCode).emit('chat-message', {
      username: socket.user.username,
      content: text,
      timestamp: new Date().toISOString()
    });
  });

  // WebRTC signaling (pass-through)
  socket.on('webrtc-offer', ({ offer, targetSocketId }) => {
    io.to(targetSocketId).emit('webrtc-offer', { offer, fromSocketId: socket.id, username: socket.user.username });
  });
  socket.on('webrtc-answer', ({ answer, targetSocketId }) => {
    io.to(targetSocketId).emit('webrtc-answer', { answer, fromSocketId: socket.id });
  });
  socket.on('webrtc-ice', ({ candidate, targetSocketId }) => {
    io.to(targetSocketId).emit('webrtc-ice', { candidate, fromSocketId: socket.id });
  });

  socket.on('screen-share-start', () => {
    if (!socket.sessionCode) return;
    const state = roomState.get(socket.sessionCode);
    if (state) state.sharerId = socket.id;
    socket.to(socket.sessionCode).emit('screen-share-started', { socketId: socket.id, username: socket.user.username });
  });

  socket.on('screen-share-stop', () => {
    if (!socket.sessionCode) return;
    const state = roomState.get(socket.sessionCode);
    if (state) state.sharerId = null;
    socket.to(socket.sessionCode).emit('screen-share-stopped', { socketId: socket.id });
  });

  // A new viewer asking the current sharer for a stream
  socket.on('request-stream', ({ sharerSocketId }) => {
    io.to(sharerSocketId).emit('viewer-wants-stream', { viewerSocketId: socket.id });
  });

  socket.on('disconnect', () => {
    if (!socket.sessionCode) return;
    const state = roomState.get(socket.sessionCode);
    if (!state) return;
    state.participants.delete(socket.id);
    if (state.sharerId === socket.id) {
      state.sharerId = null;
      io.to(socket.sessionCode).emit('screen-share-stopped', { socketId: socket.id });
    }
    if (state.participants.size === 0) roomState.delete(socket.sessionCode);
    else io.to(socket.sessionCode).emit('participants-update', [...state.participants.values()]);
    socket.to(socket.sessionCode).emit('user-left', { socketId: socket.id, username: socket.user.username });
  });
});

// ── Email reminder cron (every minute) ───────────────────────────────────────
cron.schedule('* * * * *', () => {
  const now = Date.now();
  const window = 90 * 1000; // ±90s tolerance

  function checkReminders(offsetMs, sentCol) {
    const target = new Date(now + offsetMs).toISOString();
    const lo = new Date(now + offsetMs - window).toISOString();
    const hi = new Date(now + offsetMs + window).toISOString();
    const rows = db.prepare(`
      SELECT i.id, i.email, s.title, s.code, s.scheduled_time
      FROM invites i JOIN sessions s ON i.session_id=s.id
      WHERE s.is_scheduled=1 AND s.is_active=1
        AND i.${sentCol}=0
        AND s.scheduled_time BETWEEN ? AND ?
    `).all(lo, hi);
    for (const r of rows) {
      const label = offsetMs >= 3600000 ? 'in 1 hour' : 'in 15 minutes';
      sendEmail(r.email, `Reminder: "${r.title}" starts ${label}`,
        inviteEmailHtml(r.title, r.code, r.scheduled_time, true, label));
      db.prepare(`UPDATE invites SET ${sentCol}=1 WHERE id=?`).run(r.id);
    }
  }

  checkReminders(3600000, 'reminder_1h_sent');
  checkReminders(900000,  'reminder_15m_sent');
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🐟 Wish Fish Coding running at ${APP_URL}\n`);
});
