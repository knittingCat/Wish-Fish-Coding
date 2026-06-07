require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
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
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      host_id INTEGER NOT NULL REFERENCES users(id),
      is_scheduled INTEGER DEFAULT 0,
      scheduled_time TIMESTAMP,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS invites (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      email TEXT NOT NULL,
      invited_at TIMESTAMP DEFAULT NOW(),
      reminder_1h_sent INTEGER DEFAULT 0,
      reminder_15m_sent INTEGER DEFAULT 0,
      UNIQUE(session_id, email)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS participants (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      joined_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(session_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS session_flags (
      session_id INTEGER NOT NULL,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      flagged_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (session_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS session_bans (
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      user_id    INTEGER NOT NULL REFERENCES users(id),
      banned_at  TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (session_id, user_id)
    );
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT FALSE`);
  console.log('Database ready');
}

// ── Email (Brevo HTTP API) ────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!process.env.BREVO_APIKEY) {
    console.log(`[Email SKIPPED] To: ${to} | Subject: ${subject}`);
    return;
  }
  const fromAddr = process.env.BREVO_FROM || 'wishfishcodenotifications@gmail.com';
  console.log(`[Email] Sending to: ${to} | Subject: ${subject} | From: ${fromAddr}`);
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_APIKEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'Wish Fish Coding', email: fromAddr },
        to: [{ email: to }],
        subject,
        htmlContent: html
      })
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error('[Email error]', res.status, txt);
    } else {
      console.log(`[Email] Sent OK to: ${to}`);
    }
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
    <div style="font-family:Arial,sans-serif;background:#ffffff;color:#1a1a2e;padding:36px;border-radius:12px;max-width:480px;margin:auto;border:1px solid #d0d8e8">
      <div style="margin-bottom:24px">
        <span style="font-size:22px;vertical-align:middle;position:relative;top:-1px">🐟</span>
        <span style="font-size:1.4rem;font-weight:800;color:#1a1a2e;vertical-align:middle;margin-left:10px">Wish Fish Coding</span>
      </div>
      <h2 style="color:#1a1a2e;margin-bottom:12px">${heading}</h2>
      ${schedLine}
      <p style="color:#555;margin-bottom:20px">Session code:</p>
      <div style="background:#f0f4fa;border:1px solid #b0c4de;border-radius:10px;padding:20px;text-align:center;margin-bottom:24px">
        <span style="font-family:'Courier New',monospace;font-size:2.2rem;font-weight:900;color:#1e90ff;letter-spacing:4px">${code}</span>
      </div>
      <a href="${APP_URL}/session?code=${code}" style="display:inline-block;background:linear-gradient(135deg,#1e90ff,#0070dd);color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Join Session</a>
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

async function uniqueCode() {
  let code;
  do {
    code = genCode();
    const res = await pool.query('SELECT id FROM sessions WHERE code=$1', [code]);
    if (res.rows.length === 0) break;
  } while (true);
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

app.get('/dashboard', (_, res) => res.sendFile(path.join(__dirname, 'public/dashboard.html')));
app.get('/session',   (_, res) => res.sendFile(path.join(__dirname, 'public/session.html')));
app.get('/register',  (_, res) => res.sendFile(path.join(__dirname, 'public/register.html')));

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { email, username, password } = req.body || {};
  if (!email || !username || !password)
    return res.status(400).json({ error: 'All fields are required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email,username,password_hash) VALUES ($1,$2,$3) RETURNING id,username',
      [email.trim().toLowerCase(), username.trim(), hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username });
  } catch (err) {
    if (err.code === '23505')
      return res.status(400).json({ error: 'Email or username already taken' });
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });
  const result = await pool.query('SELECT * FROM users WHERE username=$1', [username.trim()]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username });
});

// ── Sessions ──────────────────────────────────────────────────────────────────
app.get('/api/sessions', authMiddleware, async (req, res) => {
  const result = await pool.query(`
    SELECT s.*, u.username AS host_username,
      (SELECT COUNT(*) FROM participants WHERE session_id=s.id) AS participant_count,
      (SELECT COUNT(*) FROM invites WHERE session_id=s.id) AS invite_count
    FROM sessions s JOIN users u ON s.host_id=u.id
    WHERE s.host_id=$1 ORDER BY s.created_at DESC
  `, [req.user.id]);
  res.json(result.rows);
});

app.post('/api/sessions', authMiddleware, async (req, res) => {
  const { title, is_scheduled, scheduled_time } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const code = await uniqueCode();
  const result = await pool.query(
    'INSERT INTO sessions (code,title,host_id,is_scheduled,scheduled_time) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [code, title.trim(), req.user.id, is_scheduled ? 1 : 0, scheduled_time || null]
  );
  res.json(result.rows[0]);
});

app.get('/api/sessions/:code', authMiddleware, async (req, res) => {
  const sessRes = await pool.query(
    'SELECT s.*, u.username AS host_username FROM sessions s JOIN users u ON s.host_id=u.id WHERE s.code=$1',
    [req.params.code.toUpperCase()]
  );
  const session = sessRes.rows[0];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const invites = await pool.query('SELECT email FROM invites WHERE session_id=$1', [session.id]);
  const messages = await pool.query(
    'SELECT id,username,content,created_at FROM messages WHERE session_id=$1 ORDER BY created_at ASC LIMIT 200',
    [session.id]
  );
  res.json({ ...session, invites: invites.rows, messages: messages.rows });
});

app.post('/api/sessions/:code/invite', authMiddleware, async (req, res) => {
  const { emails } = req.body || {};
  if (!emails?.length) return res.status(400).json({ error: 'Emails required' });
  const sessRes = await pool.query('SELECT * FROM sessions WHERE code=$1', [req.params.code.toUpperCase()]);
  const session = sessRes.rows[0];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (!email) continue;
    await pool.query(
      'INSERT INTO invites (session_id,email) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [session.id, email]
    );
    const subj = session.is_scheduled
      ? `You're invited to "${session.title}" on Wish Fish Coding`
      : `Join "${session.title}" now on Wish Fish Coding`;
    sendEmail(email, subj, inviteEmailHtml(session.title, session.code, session.scheduled_time, false, ''));
  }
  res.json({ success: true });
});

app.delete('/api/sessions/:code', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM sessions WHERE code=$1 AND host_id=$2',
    [req.params.code.toUpperCase(), req.user.id]
  );
  const session = result.rows[0];
  if (!session) return res.status(404).json({ error: 'Session not found or not yours' });
  await pool.query('UPDATE sessions SET is_active=0 WHERE id=$1', [session.id]);
  io.to(req.params.code.toUpperCase()).emit('session-ended');
  res.json({ success: true });
});

app.delete('/api/sessions/:code/permanent', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM sessions WHERE code=$1 AND host_id=$2',
    [req.params.code.toUpperCase(), req.user.id]
  );
  const session = result.rows[0];
  if (!session) return res.status(404).json({ error: 'Session not found or not yours' });
  // Cascade delete child rows before removing the session
  await pool.query('DELETE FROM participants   WHERE session_id=$1', [session.id]);
  await pool.query('DELETE FROM messages       WHERE session_id=$1', [session.id]);
  await pool.query('DELETE FROM invites        WHERE session_id=$1', [session.id]);
  await pool.query('DELETE FROM session_bans   WHERE session_id=$1', [session.id]);
  await pool.query('DELETE FROM sessions       WHERE id=$1',         [session.id]);
  res.json({ success: true });
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
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
  socket.on('join-session', async ({ code }) => {
    const room = code.toUpperCase();
    const result = await pool.query('SELECT * FROM sessions WHERE code=$1', [room]);
    const session = result.rows[0];
    if (!session) { socket.emit('error', { message: 'Session not found' }); return; }

    // Check ban before anything else
    const banRow = await pool.query(
      'SELECT 1 FROM session_bans WHERE session_id=$1 AND user_id=$2',
      [session.id, socket.user.id]
    );
    if (banRow.rows.length) {
      socket.emit('join-rejected', { message: 'You have been removed from this session and cannot rejoin.' });
      return;
    }

    // Check lock
    const existingState = roomState.get(room);
    if (existingState?.isLocked && session.host_id !== socket.user.id) {
      socket.emit('join-rejected', { message: 'This session is locked by the host.' });
      return;
    }

    // Load flag status from user profile
    const flagRow = await pool.query('SELECT is_flagged FROM users WHERE id=$1', [socket.user.id]);
    const isFlagged = flagRow.rows[0]?.is_flagged || false;

    socket.join(room);
    socket.sessionCode = room;
    socket.sessionDbId = session.id;

    if (!roomState.has(room)) roomState.set(room, { participants: new Map(), sharerIds: new Set(), isLocked: false, audioParticipants: new Map() });
    const state = roomState.get(room);
    state.participants.set(socket.id, { socketId: socket.id, username: socket.user.username, userId: socket.user.id, suspended: false, flagged: isFlagged });

    await pool.query(
      'INSERT INTO participants (session_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [session.id, socket.user.id]
    );

    const peers = [...state.participants.values()].filter(p => p.socketId !== socket.id);
    socket.emit('room-state', { peers, sharerIds: [...state.sharerIds], isLocked: state.isLocked });
    io.to(room).emit('participants-update', [...state.participants.values()]);
    socket.to(room).emit('user-joined', { socketId: socket.id, username: socket.user.username });
  });

  socket.on('chat-message', async ({ content }) => {
    if (!socket.sessionCode || !content?.trim()) return;
    const roomSt = roomState.get(socket.sessionCode);
    if (roomSt?.participants.get(socket.id)?.suspended) return;
    const text = content.trim();
    await pool.query(
      'INSERT INTO messages (session_id,user_id,username,content) VALUES ($1,$2,$3,$4)',
      [socket.sessionDbId, socket.user.id, socket.user.username, text]
    );
    io.to(socket.sessionCode).emit('chat-message', {
      username: socket.user.username,
      content: text,
      timestamp: new Date().toISOString()
    });
  });

  socket.on('webrtc-offer', ({ offer, targetSocketId }) => {
    io.to(targetSocketId).emit('webrtc-offer', { offer, fromSocketId: socket.id, username: socket.user.username });
  });
  socket.on('webrtc-answer', ({ answer, targetSocketId }) => {
    io.to(targetSocketId).emit('webrtc-answer', { answer, fromSocketId: socket.id });
  });
  socket.on('webrtc-ice', ({ candidate, targetSocketId, type }) => {
    io.to(targetSocketId).emit('webrtc-ice', { candidate, fromSocketId: socket.id, type });
  });

  // ── Audio signaling relay ────────────────────────────────────────────────
  socket.on('audio-offer', ({ offer, targetSocketId }) => {
    io.to(targetSocketId).emit('audio-offer', { offer, fromSocketId: socket.id, username: socket.user.username });
  });
  socket.on('audio-answer', ({ answer, targetSocketId }) => {
    io.to(targetSocketId).emit('audio-answer', { answer, fromSocketId: socket.id });
  });
  socket.on('audio-ice', ({ candidate, targetSocketId }) => {
    io.to(targetSocketId).emit('audio-ice', { candidate, fromSocketId: socket.id });
  });

  socket.on('screen-share-start', () => {
    if (!socket.sessionCode) return;
    const state = roomState.get(socket.sessionCode);
    if (state?.participants.get(socket.id)?.suspended) {
      socket.emit('error', { message: 'Your activities are suspended by the host.' });
      return;
    }
    if (state) state.sharerIds.add(socket.id);
    socket.to(socket.sessionCode).emit('screen-share-started', { socketId: socket.id, username: socket.user.username });
  });

  socket.on('screen-share-stop', () => {
    if (!socket.sessionCode) return;
    const state = roomState.get(socket.sessionCode);
    if (state) state.sharerIds.delete(socket.id);
    socket.to(socket.sessionCode).emit('screen-share-stopped', { socketId: socket.id });
  });

  socket.on('request-stream', ({ sharerSocketId }) => {
    io.to(sharerSocketId).emit('viewer-wants-stream', { viewerSocketId: socket.id });
  });

  socket.on('toggle-lock', async () => {
    if (!socket.sessionCode) return;
    const result = await pool.query('SELECT host_id FROM sessions WHERE code=$1', [socket.sessionCode]);
    if (!result.rows[0] || result.rows[0].host_id !== socket.user.id) return;
    const state = roomState.get(socket.sessionCode);
    if (!state) return;
    state.isLocked = !state.isLocked;
    io.to(socket.sessionCode).emit('lock-state', { isLocked: state.isLocked });
  });

  async function verifyHost(sock) {
    if (!sock.sessionCode) return false;
    const r = await pool.query('SELECT host_id FROM sessions WHERE code=$1', [sock.sessionCode]);
    return r.rows[0]?.host_id === sock.user.id;
  }

  socket.on('host-suspend', async ({ targetSocketId }) => {
    if (!await verifyHost(socket)) return;
    const state = roomState.get(socket.sessionCode);
    const target = state?.participants.get(targetSocketId);
    if (!target) return;
    target.suspended = !target.suspended;
    io.to(socket.sessionCode).emit('participants-update', [...state.participants.values()]);
    io.to(targetSocketId).emit(target.suspended ? 'you-are-suspended' : 'you-are-unsuspended');
    // If suspended while in audio, force-mute immediately
    if (target.suspended) {
      const ap = state.audioParticipants.get(targetSocketId);
      if (ap && !ap.muted) {
        ap.muted = true;
        io.to(socket.sessionCode).emit('audio-user-muted', { socketId: targetSocketId, muted: true });
      }
    }
  });

  socket.on('flag-user', async ({ targetSocketId }) => {
    if (!socket.sessionCode) return;
    const state = roomState.get(socket.sessionCode);
    const target = state?.participants.get(targetSocketId);
    if (!target || target.flagged) return;
    await pool.query('UPDATE users SET is_flagged=true WHERE id=$1', [target.userId]);
    target.flagged = true;
    io.to(socket.sessionCode).emit('participants-update', [...state.participants.values()]);
  });

  socket.on('transfer-host', async ({ targetSocketId }) => {
    if (!await verifyHost(socket)) return;
    const state = roomState.get(socket.sessionCode);
    const target = state?.participants.get(targetSocketId);
    if (!target) return;
    await pool.query('UPDATE sessions SET host_id=$1 WHERE code=$2', [target.userId, socket.sessionCode]);
    io.to(socket.sessionCode).emit('host-transferred', { newHostUsername: target.username, newHostSocketId: targetSocketId });
  });

  socket.on('host-remove', async ({ targetSocketId }) => {
    if (!await verifyHost(socket)) return;
    const state = roomState.get(socket.sessionCode);
    const target = state?.participants.get(targetSocketId);
    if (target) {
      await pool.query(
        'INSERT INTO session_bans (session_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [socket.sessionDbId, target.userId]
      );
    }
    io.to(targetSocketId).emit('you-were-removed');
  });

  // ── Audio channel membership ─────────────────────────────────────────────
  socket.on('audio-join', () => {
    if (!socket.sessionCode) return;
    const state = roomState.get(socket.sessionCode);
    if (!state || !state.participants.has(socket.id)) return;
    const isSuspended = state.participants.get(socket.id)?.suspended || false;
    state.audioParticipants.set(socket.id, { socketId: socket.id, username: socket.user.username, muted: isSuspended });
    const peers = [...state.audioParticipants.values()].filter(p => p.socketId !== socket.id);
    socket.emit('audio-peers', { peers });
    socket.to(socket.sessionCode).emit('audio-user-joined', { socketId: socket.id, username: socket.user.username, muted: isSuspended });
  });

  socket.on('audio-leave', () => {
    if (!socket.sessionCode) return;
    const state = roomState.get(socket.sessionCode);
    if (!state) return;
    state.audioParticipants.delete(socket.id);
    socket.to(socket.sessionCode).emit('audio-user-left', { socketId: socket.id });
  });

  socket.on('audio-mute', ({ muted }) => {
    if (!socket.sessionCode) return;
    const state = roomState.get(socket.sessionCode);
    const entry = state?.audioParticipants.get(socket.id);
    if (!entry) return;
    // Suspended users cannot unmute
    if (!muted && state.participants.get(socket.id)?.suspended) return;
    entry.muted = !!muted;
    io.to(socket.sessionCode).emit('audio-user-muted', { socketId: socket.id, muted: entry.muted });
  });

  socket.on('disconnect', () => {
    if (!socket.sessionCode) return;
    const state = roomState.get(socket.sessionCode);
    if (!state) return;
    state.participants.delete(socket.id);
    if (state.sharerIds.has(socket.id)) {
      state.sharerIds.delete(socket.id);
      io.to(socket.sessionCode).emit('screen-share-stopped', { socketId: socket.id });
    }
    if (state.audioParticipants?.has(socket.id)) {
      state.audioParticipants.delete(socket.id);
      io.to(socket.sessionCode).emit('audio-user-left', { socketId: socket.id });
    }
    if (state.participants.size === 0) roomState.delete(socket.sessionCode);
    else io.to(socket.sessionCode).emit('participants-update', [...state.participants.values()]);
    socket.to(socket.sessionCode).emit('user-left', { socketId: socket.id, username: socket.user.username });
  });
});

// ── Email reminders cron ──────────────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  const now = Date.now();
  const window = 90 * 1000;

  async function checkReminders(offsetMs, sentCol) {
    const lo = new Date(now + offsetMs - window).toISOString();
    const hi = new Date(now + offsetMs + window).toISOString();
    const result = await pool.query(`
      SELECT i.id, i.email, s.title, s.code, s.scheduled_time
      FROM invites i JOIN sessions s ON i.session_id=s.id
      WHERE s.is_scheduled=1 AND s.is_active=1
        AND i.${sentCol}=0
        AND s.scheduled_time BETWEEN $1 AND $2
    `, [lo, hi]);
    for (const r of result.rows) {
      const label = offsetMs >= 3600000 ? 'in 1 hour' : 'in 15 minutes';
      sendEmail(r.email, `Reminder: "${r.title}" starts ${label}`,
        inviteEmailHtml(r.title, r.code, r.scheduled_time, true, label));
      await pool.query(`UPDATE invites SET ${sentCol}=1 WHERE id=$1`, [r.id]);
    }
  }

  try {
    await checkReminders(3600000, 'reminder_1h_sent');
    await checkReminders(900000,  'reminder_15m_sent');
  } catch (err) {
    console.error('[Cron error]', err.message);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`\n🐟 Wish Fish Coding running at ${APP_URL}\n`);
  });
}).catch(err => {
  console.error('Failed to init database:', err.message);
  process.exit(1);
});
