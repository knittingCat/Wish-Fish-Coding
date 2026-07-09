require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const cron = require('node-cron');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = process.env.JWT_SECRET || 'wishfish-dev-secret';
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// ── Database ──────────────────────────────────────────────────────────────────
// Strip sslmode from the connection string so pg-connection-string doesn't apply its
// deprecated sslmode->ssl-object aliasing; the explicit `ssl` option below is authoritative.
function stripSslMode(url) {
  if (!url) return url;
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  return u.toString();
}

const pool = new Pool({
  connectionString: stripSslMode(process.env.DATABASE_URL),
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 3,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 10000,
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
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      requester_id INTEGER NOT NULL REFERENCES users(id),
      addressee_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(requester_id, addressee_id)
    );
    CREATE TABLE IF NOT EXISTS contact_messages (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      sender_id  INTEGER NOT NULL REFERENCES users(id),
      content    TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reminder_options TEXT DEFAULT '["1h","15m"]'`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'UTC'`);
  await pool.query(`ALTER TABLE invites ADD COLUMN IF NOT EXISTS reminder_1d_sent INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE invites ADD COLUMN IF NOT EXISTS reminder_30m_sent INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE invites ADD COLUMN IF NOT EXISTS reminder_5m_sent INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE invites ADD COLUMN IF NOT EXISTS reminder_now_sent INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE session_bans ADD COLUMN IF NOT EXISTS reason TEXT DEFAULT 'removed'`);
  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS requester_last_read TIMESTAMP`);
  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS addressee_last_read TIMESTAMP`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_chats (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS group_chat_members (
      group_id INTEGER NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
      user_id  INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS group_chat_messages (
      id SERIAL PRIMARY KEY,
      group_id  INTEGER NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      content   TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS group_chat_reads (
      group_id  INTEGER NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL REFERENCES users(id),
      last_read TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS group_chat_invites (
      id         SERIAL PRIMARY KEY,
      group_id   INTEGER NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
      inviter_id INTEGER NOT NULL REFERENCES users(id),
      invitee_id INTEGER NOT NULL REFERENCES users(id),
      status     TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(group_id, invitee_id)
    );
  `);
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

function emailShell(extraStyles, content) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  .wrap { font-family:Arial,sans-serif; background:#ffffff; color:#1a1a2e; padding:36px; border-radius:12px; max-width:480px; margin:auto; border:1px solid #d0d8e8; }
  .btn { display:inline-block; background:linear-gradient(135deg,#1e90ff,#0070dd); color:white !important; padding:12px 28px; border-radius:8px; text-decoration:none; font-weight:600; }
  a[href^="mailto:"] { color:inherit !important; text-decoration:none !important; pointer-events:none; cursor:text; }
  @media (prefers-color-scheme: dark) {
    .wrap { background:#161b27 !important; color:#e8f0ff !important; border-color:#2a3550 !important; }
  }
  ${extraStyles}
</style>
</head><body style="margin:0;padding:16px;background:#f0f4f8">
<div class="wrap">
  <div style="margin-bottom:24px">
    <span style="font-size:22px;vertical-align:middle;position:relative;top:-1px">🐟</span>
    <span style="font-size:1.4rem;font-weight:800;vertical-align:middle;margin-left:10px">Wish Fish Coding</span>
  </div>
  ${content}
</div>
</body></html>`;
}

function inviteEmailHtml(title, code, scheduledTime, isReminder, reminderText, timezone) {
  const tz = timezone || 'UTC';
  const schedLine = scheduledTime
    ? `<p class="sched">Scheduled: <strong>${new Date(scheduledTime).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz, timeZoneName: 'short' })}</strong></p>`
    : '';
  const heading = isReminder
    ? `Reminder: "${title}" starts ${reminderText}`
    : `You're invited to "${title}"`;
  return emailShell(`
  .heading { color:#1a1a2e; margin-bottom:12px; }
  .sched { color:#555; }
  .sched strong { color:#1a1a2e; }
  .label { color:#555; margin-bottom:20px; }
  .code-box { background:#f0f4fa; border:1px solid #b0c4de; border-radius:10px; padding:20px; text-align:center; margin-bottom:24px; }
  .code { font-family:'Courier New',monospace; font-size:2.2rem; font-weight:900; color:#1e90ff; letter-spacing:4px; }
  @media (prefers-color-scheme: dark) {
    .heading { color:#e8f0ff !important; }
    .sched { color:#7a9cc8 !important; }
    .sched strong { color:#e8f0ff !important; }
    .label { color:#7a9cc8 !important; }
    .code-box { background:#1a2035 !important; border-color:#2a3550 !important; }
  }`, `
  <h2 class="heading">${heading}</h2>
  ${schedLine}
  <p class="label">Session code:</p>
  <div class="code-box"><span class="code">${code}</span></div>
  <a href="${APP_URL}/session?code=${code}" class="btn">Join Session</a>`);
}

function contactEmailHtml(type, fromUsername) {
  const heading = type === 'request'
    ? `${fromUsername} sent you a contact request`
    : type === 'accepted'
      ? `${fromUsername} accepted your contact request!`
      : `${fromUsername} removed you as a contact`;
  const body = type === 'request'
    ? `<p style="color:#555;margin-bottom:24px">${fromUsername} wants to connect with you on Wish Fish Coding. Log in to accept or decline.</p>`
    : type === 'accepted'
      ? `<p style="color:#555;margin-bottom:24px">You and ${fromUsername} are now contacts on Wish Fish Coding. Open your dashboard to start chatting.</p>`
      : `<p style="color:#555;margin-bottom:24px">${fromUsername} has removed you from their contacts on Wish Fish Coding.</p>`;
  return emailShell('', `
  <h2 style="margin-bottom:16px">${heading}</h2>
  ${body}
  <a class="btn" href="${APP_URL}/dashboard?tab=contacts">Open Contacts</a>`);
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

app.get('/ping', (_, res) => res.json({ ok: true }));
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
  await pool.query(`UPDATE sessions SET is_scheduled=0 WHERE is_scheduled=1 AND is_active=1 AND scheduled_time <= NOW()`);
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
  const { title, is_scheduled, scheduled_time, reminder_options, timezone } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const code = await uniqueCode();
  const remOpts = JSON.stringify(Array.isArray(reminder_options) && reminder_options.length ? reminder_options : ['1h', '15m']);
  const tz = timezone || 'UTC';
  const result = await pool.query(
    'INSERT INTO sessions (code,title,host_id,is_scheduled,scheduled_time,reminder_options,timezone) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [code, title.trim(), req.user.id, is_scheduled ? 1 : 0, scheduled_time || null, remOpts, tz]
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
  const notFound = [];
  for (const raw of emails) {
    const entry = raw.trim();
    if (!entry) continue;
    let email;
    if (entry.includes('@')) {
      email = entry.toLowerCase();
    } else {
      const userRes = await pool.query('SELECT email FROM users WHERE LOWER(username)=$1', [entry.toLowerCase()]);
      if (!userRes.rows[0]) { notFound.push(entry); continue; }
      email = userRes.rows[0].email;
    }
    await pool.query(
      'INSERT INTO invites (session_id,email) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [session.id, email]
    );
    const subj = session.is_scheduled
      ? `You're invited to "${session.title}" on Wish Fish Coding`
      : `Join "${session.title}" now on Wish Fish Coding`;
    sendEmail(email, subj, inviteEmailHtml(session.title, session.code, session.scheduled_time, false, '', session.timezone));
  }
  if (notFound.length) return res.status(207).json({ success: true, notFound });
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

// ── Invites for current user ──────────────────────────────────────────────────
app.get('/api/invites', authMiddleware, async (req, res) => {
  const emailRes = await pool.query('SELECT email FROM users WHERE id=$1', [req.user.id]);
  const email = emailRes.rows[0]?.email;
  if (!email) return res.json([]);
  const { rows } = await pool.query(`
    SELECT i.id, s.code, s.title, s.scheduled_time, s.is_scheduled, s.is_active,
           u.username AS host_username
    FROM invites i
    JOIN sessions s ON s.id = i.session_id
    JOIN users u ON u.id = s.host_id
    WHERE LOWER(i.email)=LOWER($1) AND s.host_id != $2
    ORDER BY s.created_at DESC
  `, [email, req.user.id]);
  res.json(rows);
});

// ── Contacts ──────────────────────────────────────────────────────────────────

app.post('/api/contacts', authMiddleware, async (req, res) => {
  let { targetUserId, targetUsername } = req.body || {};
  if (!targetUserId && targetUsername) {
    const u = await pool.query('SELECT id FROM users WHERE LOWER(username)=LOWER($1)', [targetUsername]);
    if (!u.rows.length) return res.status(404).json({ error: `No user found with username "${targetUsername}"` });
    targetUserId = u.rows[0].id;
  }
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId or targetUsername required' });
  if (targetUserId === req.user.id) return res.status(400).json({ error: 'Cannot add yourself' });
  try {
    const existing = await pool.query(
      'SELECT id, status FROM contacts WHERE (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1)',
      [req.user.id, targetUserId]
    );
    if (existing.rows.length) {
      const s = existing.rows[0].status;
      return res.status(409).json({ error: s === 'accepted' ? 'Already contacts' : 'Request already sent' });
    }
    const result = await pool.query(
      'INSERT INTO contacts (requester_id, addressee_id) VALUES ($1,$2) RETURNING id',
      [req.user.id, targetUserId]
    );
    const [senderRes, addresseeRes] = await Promise.all([
      pool.query('SELECT username FROM users WHERE id=$1', [req.user.id]),
      pool.query('SELECT email FROM users WHERE id=$1', [targetUserId])
    ]);
    const senderUsername = senderRes.rows[0]?.username;
    io.to(`user-${targetUserId}`).emit('contact-request-received', {
      contactId: result.rows[0].id,
      from: { id: req.user.id, username: senderUsername }
    });
    if (addresseeRes.rows[0]?.email) {
      sendEmail(addresseeRes.rows[0].email, `${senderUsername} sent you a contact request`, contactEmailHtml('request', senderUsername));
    }
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to send request' }); }
});

app.get('/api/contacts/notifications', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const pend = await pool.query(`SELECT COUNT(*) FROM contacts WHERE addressee_id=$1 AND status='pending'`, [uid]);
  const cons = await pool.query(
    `SELECT id, requester_id, requester_last_read, addressee_last_read FROM contacts WHERE (requester_id=$1 OR addressee_id=$1) AND status='accepted'`,
    [uid]
  );
  let unread = 0;
  for (const c of cons.rows) {
    const since = c.requester_id === uid ? c.requester_last_read : c.addressee_last_read;
    const r = await pool.query(
      `SELECT COUNT(*) FROM contact_messages WHERE contact_id=$1 AND sender_id!=$2 AND created_at > $3`,
      [c.id, uid, since || new Date(0)]
    );
    unread += parseInt(r.rows[0].count);
  }
  const groups = await pool.query('SELECT group_id FROM group_chat_members WHERE user_id=$1', [uid]);
  for (const g of groups.rows) {
    const readRow = await pool.query('SELECT last_read FROM group_chat_reads WHERE group_id=$1 AND user_id=$2', [g.group_id, uid]);
    const lastRead = readRow.rows[0]?.last_read || new Date(0);
    const r = await pool.query(
      `SELECT COUNT(*) FROM group_chat_messages WHERE group_id=$1 AND sender_id!=$2 AND created_at>$3`,
      [g.group_id, uid, lastRead]
    );
    unread += parseInt(r.rows[0].count);
  }
  const groupInvites = await pool.query(`SELECT COUNT(*) FROM group_chat_invites WHERE invitee_id=$1 AND status='pending'`, [uid]);
  res.json({ pendingRequests: parseInt(pend.rows[0].count) + parseInt(groupInvites.rows[0].count), unreadMessages: unread });
});

app.get('/api/contacts', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const rows = await pool.query(`
    SELECT c.id, c.status, c.created_at, c.requester_id, c.addressee_id,
      c.requester_last_read, c.addressee_last_read,
      u_r.username AS requester_username, u_a.username AS addressee_username
    FROM contacts c
    JOIN users u_r ON u_r.id=c.requester_id
    JOIN users u_a ON u_a.id=c.addressee_id
    WHERE c.requester_id=$1 OR c.addressee_id=$1
    ORDER BY c.created_at DESC
  `, [uid]);
  const result = await Promise.all(rows.rows.map(async c => {
    const isReq = c.requester_id === uid;
    const lastRead = isReq ? c.requester_last_read : c.addressee_last_read;
    const lastMsg = await pool.query(
      `SELECT content, created_at, sender_id FROM contact_messages WHERE contact_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [c.id]
    );
    const unread = c.status === 'accepted' ? await pool.query(
      `SELECT COUNT(*) FROM contact_messages WHERE contact_id=$1 AND sender_id!=$2 AND created_at>$3`,
      [c.id, uid, lastRead || new Date(0)]
    ) : { rows: [{ count: '0' }] };
    return {
      id: c.id, status: c.status, isRequester: isReq,
      otherId: isReq ? c.addressee_id : c.requester_id,
      otherUsername: isReq ? c.addressee_username : c.requester_username,
      lastMessage: lastMsg.rows[0]?.content || null,
      lastMessageAt: lastMsg.rows[0]?.created_at || null,
      unreadCount: parseInt(unread.rows[0].count)
    };
  }));
  res.json(result);
});

app.post('/api/contacts/:id/accept', authMiddleware, async (req, res) => {
  const r = await pool.query(
    `UPDATE contacts SET status='accepted' WHERE id=$1 AND addressee_id=$2 AND status='pending' RETURNING requester_id`,
    [req.params.id, req.user.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Request not found' });
  const [me, requesterRes] = await Promise.all([
    pool.query('SELECT username FROM users WHERE id=$1', [req.user.id]),
    pool.query('SELECT email FROM users WHERE id=$1', [r.rows[0].requester_id])
  ]);
  const acceptorUsername = me.rows[0]?.username;
  io.to(`user-${r.rows[0].requester_id}`).emit('contact-request-accepted', {
    contactId: parseInt(req.params.id),
    by: { id: req.user.id, username: acceptorUsername }
  });
  if (requesterRes.rows[0]?.email) {
    sendEmail(requesterRes.rows[0].email, `${acceptorUsername} accepted your contact request!`, contactEmailHtml('accepted', acceptorUsername));
  }
  res.json({ success: true });
});

app.post('/api/contacts/:id/decline', authMiddleware, async (req, res) => {
  await pool.query(
    `DELETE FROM contacts WHERE id=$1 AND addressee_id=$2 AND status='pending'`,
    [req.params.id, req.user.id]
  );
  res.json({ success: true });
});

app.post('/api/contacts/:id/cancel', authMiddleware, async (req, res) => {
  const contact = await pool.query(
    `DELETE FROM contacts WHERE id=$1 AND requester_id=$2 AND status='pending' RETURNING addressee_id`,
    [req.params.id, req.user.id]
  );
  if (contact.rows.length) {
    const [senderRes, addresseeRes] = await Promise.all([
      pool.query('SELECT username FROM users WHERE id=$1', [req.user.id]),
      pool.query('SELECT email FROM users WHERE id=$1', [contact.rows[0].addressee_id])
    ]);
    const senderUsername = senderRes.rows[0]?.username;
    if (addresseeRes.rows[0]?.email) {
      sendEmail(
        addresseeRes.rows[0].email,
        `${senderUsername} cancelled their contact request`,
        emailShell('', `
          <h2 style="margin-bottom:16px">${senderUsername} cancelled their contact request</h2>
          <p style="color:#555;margin-bottom:24px">${senderUsername} has cancelled their contact request on Wish Fish Coding.</p>
          <a class="btn" href="${APP_URL}/dashboard?tab=contacts">Open Contacts</a>`)
      );
    }
  }
  res.json({ success: true });
});

app.delete('/api/contacts/:id', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const contact = await pool.query(
    `SELECT * FROM contacts WHERE id=$1 AND (requester_id=$2 OR addressee_id=$2) AND status='accepted'`,
    [req.params.id, uid]
  );
  if (!contact.rows.length) return res.status(404).json({ error: 'Contact not found' });
  await pool.query('DELETE FROM contact_messages WHERE contact_id=$1', [req.params.id]);
  await pool.query('DELETE FROM contacts WHERE id=$1', [req.params.id]);
  const otherId = contact.rows[0].requester_id === uid ? contact.rows[0].addressee_id : contact.rows[0].requester_id;
  io.to(`user-${otherId}`).emit('contact-removed', { contactId: parseInt(req.params.id) });
  const [me, otherRes] = await Promise.all([
    pool.query('SELECT username FROM users WHERE id=$1', [uid]),
    pool.query('SELECT email FROM users WHERE id=$1', [otherId])
  ]);
  if (otherRes.rows[0]?.email) {
    sendEmail(otherRes.rows[0].email, `${me.rows[0]?.username} removed you as a contact`, contactEmailHtml('removed', me.rows[0]?.username));
  }
  res.json({ success: true });
});

app.get('/api/contacts/:id/messages', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const contact = await pool.query(
    `SELECT * FROM contacts WHERE id=$1 AND (requester_id=$2 OR addressee_id=$2) AND status='accepted'`,
    [req.params.id, uid]
  );
  if (!contact.rows.length) return res.status(404).json({ error: 'Contact not found' });
  const msgs = await pool.query(
    `SELECT m.id, m.content, m.created_at, m.sender_id, u.username AS sender_username
     FROM contact_messages m JOIN users u ON u.id=m.sender_id
     WHERE m.contact_id=$1 ORDER BY m.created_at ASC LIMIT 200`,
    [req.params.id]
  );
  const c = contact.rows[0];
  const col = c.requester_id === uid ? 'requester_last_read' : 'addressee_last_read';
  await pool.query(`UPDATE contacts SET ${col}=NOW() WHERE id=$1`, [req.params.id]);
  res.json(msgs.rows);
});

app.post('/api/contacts/:id/messages', authMiddleware, async (req, res) => {
  const { content } = req.body || {};
  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
  const uid = req.user.id;
  const contact = await pool.query(
    `SELECT * FROM contacts WHERE id=$1 AND (requester_id=$2 OR addressee_id=$2) AND status='accepted'`,
    [req.params.id, uid]
  );
  if (!contact.rows.length) return res.status(404).json({ error: 'Contact not found' });
  const c = contact.rows[0];
  const r = await pool.query(
    `INSERT INTO contact_messages (contact_id, sender_id, content) VALUES ($1,$2,$3) RETURNING *`,
    [req.params.id, uid, content.trim()]
  );
  const col = c.requester_id === uid ? 'requester_last_read' : 'addressee_last_read';
  await pool.query(`UPDATE contacts SET ${col}=NOW() WHERE id=$1`, [req.params.id]);
  const me = await pool.query('SELECT username FROM users WHERE id=$1', [uid]);
  const msgData = {
    contactId: parseInt(req.params.id),
    message: { id: r.rows[0].id, content: r.rows[0].content, created_at: r.rows[0].created_at, sender_id: uid, sender_username: me.rows[0]?.username }
  };
  const otherId = c.requester_id === uid ? c.addressee_id : c.requester_id;
  io.to(`user-${otherId}`).emit('new-contact-message', msgData);
  res.json({ success: true, message: msgData.message });
});

// ── Group Chats ───────────────────────────────────────────────────────────────

app.post('/api/group-chats', authMiddleware, async (req, res) => {
  const { name, memberUserIds } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  if (!Array.isArray(memberUserIds) || !memberUserIds.length)
    return res.status(400).json({ error: 'At least one member required' });
  const r = await pool.query(
    'INSERT INTO group_chats (name, created_by) VALUES ($1,$2) RETURNING id',
    [name.trim(), req.user.id]
  );
  const groupId = r.rows[0].id;
  const allMembers = [...new Set([req.user.id, ...memberUserIds.map(Number)])];
  for (const uid of allMembers) {
    await pool.query(
      'INSERT INTO group_chat_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [groupId, uid]
    );
  }
  res.json({ id: groupId, name: name.trim() });
});

app.get('/api/group-chats', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const groups = await pool.query(`
    SELECT gc.id, gc.name FROM group_chats gc
    JOIN group_chat_members gcm ON gcm.group_id=gc.id
    WHERE gcm.user_id=$1 ORDER BY gc.created_at DESC
  `, [uid]);
  const result = await Promise.all(groups.rows.map(async g => {
    const lastMsg = await pool.query(
      `SELECT m.content, m.created_at, u.username AS sender_username
       FROM group_chat_messages m JOIN users u ON u.id=m.sender_id
       WHERE m.group_id=$1 ORDER BY m.created_at DESC LIMIT 1`, [g.id]
    );
    const readRow = await pool.query(
      'SELECT last_read FROM group_chat_reads WHERE group_id=$1 AND user_id=$2', [g.id, uid]
    );
    const lastRead = readRow.rows[0]?.last_read || new Date(0);
    const unread = await pool.query(
      `SELECT COUNT(*) FROM group_chat_messages WHERE group_id=$1 AND sender_id!=$2 AND created_at>$3`,
      [g.id, uid, lastRead]
    );
    const members = await pool.query(
      `SELECT u.id, u.username FROM group_chat_members gcm JOIN users u ON u.id=gcm.user_id WHERE gcm.group_id=$1`, [g.id]
    );
    return {
      id: g.id, name: g.name, isGroup: true,
      lastMessage: lastMsg.rows[0]?.content || null,
      lastMessageAt: lastMsg.rows[0]?.created_at || null,
      unreadCount: parseInt(unread.rows[0].count),
      members: members.rows
    };
  }));
  res.json(result);
});

app.get('/api/group-chats/:id/messages', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const member = await pool.query(
    'SELECT 1 FROM group_chat_members WHERE group_id=$1 AND user_id=$2', [req.params.id, uid]
  );
  if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });
  const msgs = await pool.query(
    `SELECT m.id, m.content, m.created_at, m.sender_id, u.username AS sender_username
     FROM group_chat_messages m JOIN users u ON u.id=m.sender_id
     WHERE m.group_id=$1 ORDER BY m.created_at ASC LIMIT 200`, [req.params.id]
  );
  await pool.query(
    `INSERT INTO group_chat_reads (group_id, user_id, last_read) VALUES ($1,$2,NOW())
     ON CONFLICT (group_id, user_id) DO UPDATE SET last_read=NOW()`,
    [req.params.id, uid]
  );
  res.json(msgs.rows);
});

app.post('/api/group-chats/:id/messages', authMiddleware, async (req, res) => {
  const { content } = req.body || {};
  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
  const uid = req.user.id;
  const member = await pool.query(
    'SELECT 1 FROM group_chat_members WHERE group_id=$1 AND user_id=$2', [req.params.id, uid]
  );
  if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });
  const r = await pool.query(
    'INSERT INTO group_chat_messages (group_id, sender_id, content) VALUES ($1,$2,$3) RETURNING *',
    [req.params.id, uid, content.trim()]
  );
  await pool.query(
    `INSERT INTO group_chat_reads (group_id, user_id, last_read) VALUES ($1,$2,NOW())
     ON CONFLICT (group_id, user_id) DO UPDATE SET last_read=NOW()`,
    [req.params.id, uid]
  );
  const me = await pool.query('SELECT username FROM users WHERE id=$1', [uid]);
  const msgData = {
    groupId: parseInt(req.params.id),
    message: { id: r.rows[0].id, content: r.rows[0].content, created_at: r.rows[0].created_at, sender_id: uid, sender_username: me.rows[0]?.username }
  };
  const others = await pool.query(
    'SELECT user_id FROM group_chat_members WHERE group_id=$1 AND user_id!=$2', [req.params.id, uid]
  );
  for (const m of others.rows) io.to(`user-${m.user_id}`).emit('new-group-message', msgData);
  res.json({ success: true, message: msgData.message });
});

// User search
app.get('/api/users/search', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const result = await pool.query(
    `SELECT id, username FROM users WHERE LOWER(username) LIKE LOWER($1) AND id != $2 LIMIT 10`,
    [`%${q}%`, req.user.id]
  );
  res.json(result.rows);
});

// Invite members to group (sends request, does not auto-add)
app.post('/api/group-chats/:id/members', authMiddleware, async (req, res) => {
  const { userIds } = req.body || {};
  if (!Array.isArray(userIds) || !userIds.length) return res.status(400).json({ error: 'userIds required' });
  const member = await pool.query('SELECT 1 FROM group_chat_members WHERE group_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });
  const group = await pool.query('SELECT name FROM group_chats WHERE id=$1', [req.params.id]);
  if (!group.rows.length) return res.status(404).json({ error: 'Group not found' });
  for (const uid of userIds.map(Number)) {
    await pool.query(
      `INSERT INTO group_chat_invites (group_id, inviter_id, invitee_id)
       VALUES ($1,$2,$3) ON CONFLICT (group_id, invitee_id) DO UPDATE SET status='pending', created_at=NOW()`,
      [req.params.id, req.user.id, uid]
    );
    io.to(`user-${uid}`).emit('group-invite-received', {
      groupId: parseInt(req.params.id),
      groupName: group.rows[0].name,
      from: { username: req.user.username }
    });
  }
  res.json({ success: true });
});

// Get pending group invites for current user
app.get('/api/group-chats/invites', authMiddleware, async (req, res) => {
  const result = await pool.query(`
    SELECT gci.id, gci.group_id, gc.name AS group_name,
           u.username AS inviter_username, gci.created_at
    FROM group_chat_invites gci
    JOIN group_chats gc ON gc.id = gci.group_id
    JOIN users u ON u.id = gci.inviter_id
    WHERE gci.invitee_id=$1 AND gci.status='pending'
    ORDER BY gci.created_at DESC
  `, [req.user.id]);
  res.json(result.rows);
});

// Accept group invite
app.post('/api/group-chat-invites/:inviteId/accept', authMiddleware, async (req, res) => {
  const inv = await pool.query(
    `SELECT * FROM group_chat_invites WHERE id=$1 AND invitee_id=$2 AND status='pending'`,
    [req.params.inviteId, req.user.id]
  );
  if (!inv.rows.length) return res.status(404).json({ error: 'Invite not found' });
  const { group_id } = inv.rows[0];
  await pool.query(`UPDATE group_chat_invites SET status='accepted' WHERE id=$1`, [req.params.inviteId]);
  await pool.query(`INSERT INTO group_chat_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [group_id, req.user.id]);
  res.json({ success: true, groupId: group_id });
});

// Decline group invite
app.post('/api/group-chat-invites/:inviteId/decline', authMiddleware, async (req, res) => {
  const inv = await pool.query(
    `SELECT * FROM group_chat_invites WHERE id=$1 AND invitee_id=$2 AND status='pending'`,
    [req.params.inviteId, req.user.id]
  );
  if (!inv.rows.length) return res.status(404).json({ error: 'Invite not found' });
  await pool.query(`UPDATE group_chat_invites SET status='declined' WHERE id=$1`, [req.params.inviteId]);
  res.json({ success: true });
});

// Remove member from group
app.delete('/api/group-chats/:id/members/:userId', authMiddleware, async (req, res) => {
  const group = await pool.query('SELECT created_by FROM group_chats WHERE id=$1', [req.params.id]);
  if (!group.rows.length) return res.status(404).json({ error: 'Group not found' });
  const isCreator = group.rows[0].created_by === req.user.id;
  const isSelf = parseInt(req.params.userId) === req.user.id;
  if (!isCreator && !isSelf) return res.status(403).json({ error: 'Not authorized' });
  await pool.query('DELETE FROM group_chat_members WHERE group_id=$1 AND user_id=$2', [req.params.id, req.params.userId]);
  if (!isSelf) {
    const [groupRes, removerRes, removedRes] = await Promise.all([
      pool.query('SELECT name FROM group_chats WHERE id=$1', [req.params.id]),
      pool.query('SELECT username FROM users WHERE id=$1', [req.user.id]),
      pool.query('SELECT email FROM users WHERE id=$1', [req.params.userId])
    ]);
    if (removedRes.rows[0]?.email) {
      const groupName = groupRes.rows[0]?.name;
      const removerUsername = removerRes.rows[0]?.username;
      sendEmail(removedRes.rows[0].email, `You were removed from "${groupName}"`, emailShell('', `
        <h2 style="margin-bottom:16px">You were removed from "${groupName}"</h2>
        <p style="color:#555;margin-bottom:24px">${removerUsername} removed you from the group chat "${groupName}" on Wish Fish Coding.</p>
        <a class="btn" href="${APP_URL}/dashboard?tab=contacts">Open Contacts</a>`));
    }
  }
  res.json({ success: true });
});

// Delete group chat
app.delete('/api/group-chats/:id', authMiddleware, async (req, res) => {
  const group = await pool.query('SELECT created_by FROM group_chats WHERE id=$1', [req.params.id]);
  if (!group.rows.length) return res.status(404).json({ error: 'Group not found' });
  if (group.rows[0].created_by !== req.user.id) return res.status(403).json({ error: 'Only the creator can delete the group' });
  await pool.query('DELETE FROM group_chats WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
const roomState = new Map();

function broadcastWaitingRoom(room, state) {
  io.to(room).emit('waiting-room-update', { waiting: [...state.waitingRoom.values()] });
}

async function doJoin(socket, session, room, state) {
  const flagRow = await pool.query('SELECT is_flagged FROM users WHERE id=$1', [socket.user.id]);
  const isFlagged = flagRow.rows[0]?.is_flagged || false;

  socket.join(room);
  socket.sessionCode = room;
  socket.sessionDbId = session.id;

  state.participants.set(socket.id, { socketId: socket.id, username: socket.user.username, userId: socket.user.id, suspended: false, flagged: isFlagged });

  await pool.query(
    'INSERT INTO participants (session_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [session.id, socket.user.id]
  );

  const peers = [...state.participants.values()].filter(p => p.socketId !== socket.id);
  socket.emit('room-state', { peers, sharerIds: [...state.sharerIds], isLocked: state.isLocked, waitingRoomEnabled: state.waitingRoomEnabled, controls: state.controls });
  io.to(room).emit('participants-update', [...state.participants.values()]);
  socket.to(room).emit('user-joined', { socketId: socket.id, username: socket.user.username });
}

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
  socket.join(`user-${socket.user.id}`);

  socket.on('join-session', async ({ code }) => {
    const room = code.toUpperCase();
    const result = await pool.query('SELECT * FROM sessions WHERE code=$1', [room]);
    const session = result.rows[0];
    if (!session) { socket.emit('error', { message: 'Session not found' }); return; }

    const banRow = await pool.query(
      'SELECT reason FROM session_bans WHERE session_id=$1 AND user_id=$2',
      [session.id, socket.user.id]
    );
    if (banRow.rows.length) {
      const msg = banRow.rows[0].reason === 'denied'
        ? 'Your request to join this session was denied and you cannot rejoin.'
        : 'You have been removed from this session and cannot rejoin.';
      socket.emit('join-rejected', { message: msg });
      return;
    }

    if (!roomState.has(room)) {
      roomState.set(room, {
        participants: new Map(), sharerIds: new Set(), isLocked: false,
        audioParticipants: new Map(), waitingRoom: new Map(), waitingRoomEnabled: false,
        hostId: session.host_id,
        controls: { audioJoin: true, audioUnmute: true, chat: true, viewChat: true, screenShare: true }
      });
    }
    const state = roomState.get(room);

    if (state.isLocked && session.host_id !== socket.user.id) {
      socket.emit('join-rejected', { message: 'This session is locked by the host.' });
      return;
    }

    if (state.waitingRoomEnabled && session.host_id !== socket.user.id) {
      socket.pendingRoom = room;
      socket.pendingSession = session;
      state.waitingRoom.set(socket.id, { socketId: socket.id, username: socket.user.username, userId: socket.user.id });
      socket.emit('join-waiting');
      broadcastWaitingRoom(room, state);
      return;
    }

    await doJoin(socket, session, room, state);
  });

  socket.on('chat-message', ({ content }) => {
    if (!socket.sessionCode || !content?.trim()) return;
    const roomSt = roomState.get(socket.sessionCode);
    if (roomSt?.participants.get(socket.id)?.suspended) return;
    const text = content.trim();
    const ts = new Date().toISOString();
    socket.broadcast.to(socket.sessionCode).emit('chat-message', {
      username: socket.user.username,
      content: text,
      timestamp: ts
    });
    pool.query(
      'INSERT INTO messages (session_id,user_id,username,content) VALUES ($1,$2,$3,$4)',
      [socket.sessionDbId, socket.user.id, socket.user.username, text]
    ).catch(err => console.error('Failed to save message:', err));
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
  socket.on('set-controls', async (controls) => {
    if (!await verifyHost(socket)) return;
    const state = roomState.get(socket.sessionCode);
    if (!state) return;
    state.controls = {
      audioJoin:   !!controls.audioJoin,
      audioUnmute: !!controls.audioUnmute,
      chat:        !!controls.chat,
      viewChat:    !!controls.viewChat,
      screenShare: !!controls.screenShare,
    };
    io.to(socket.sessionCode).emit('controls-update', state.controls);
  });

  socket.on('audio-join', () => {
    if (!socket.sessionCode) return;
    const state = roomState.get(socket.sessionCode);
    if (!state || !state.participants.has(socket.id)) return;
    const isHostUser = state.hostId === socket.user.id;
    if (!isHostUser && !state.controls?.audioJoin) {
      socket.emit('error', { message: 'Audio is disabled by the host.' });
      return;
    }
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
    // Suspended users and participants when audioUnmute is off cannot unmute
    const isHostUser = state.hostId === socket.user.id;
    if (!muted && state.participants.get(socket.id)?.suspended) return;
    if (!muted && !isHostUser && !state.controls?.audioUnmute) return;
    entry.muted = !!muted;
    io.to(socket.sessionCode).emit('audio-user-muted', { socketId: socket.id, muted: entry.muted });
  });

  socket.on('toggle-waiting-room', async () => {
    if (!socket.sessionCode) return;
    const r = await pool.query('SELECT host_id FROM sessions WHERE code=$1', [socket.sessionCode]);
    if (!r.rows[0] || r.rows[0].host_id !== socket.user.id) return;
    const state = roomState.get(socket.sessionCode);
    if (!state) return;
    state.waitingRoomEnabled = !state.waitingRoomEnabled;
    io.to(socket.sessionCode).emit('waiting-room-state', { enabled: state.waitingRoomEnabled });
    // Auto-approve everyone waiting when the waiting room is turned off
    if (!state.waitingRoomEnabled && state.waitingRoom.size > 0) {
      const sessRes = await pool.query('SELECT * FROM sessions WHERE code=$1', [socket.sessionCode]);
      const session = sessRes.rows[0];
      if (session) {
        for (const sid of [...state.waitingRoom.keys()]) {
          const target = io.sockets.sockets.get(sid);
          if (target) await doJoin(target, session, socket.sessionCode, state);
        }
      }
      state.waitingRoom.clear();
      broadcastWaitingRoom(socket.sessionCode, state);
    }
  });

  socket.on('waiting-room-approve', async ({ targetSocketId }) => {
    if (!await verifyHost(socket)) return;
    const room = socket.sessionCode;
    const state = roomState.get(room);
    if (!state || !state.waitingRoom.has(targetSocketId)) return;
    state.waitingRoom.delete(targetSocketId);
    broadcastWaitingRoom(room, state);
    const target = io.sockets.sockets.get(targetSocketId);
    if (!target) return;
    const sessRes = await pool.query('SELECT * FROM sessions WHERE code=$1', [room]);
    const session = sessRes.rows[0];
    if (session) await doJoin(target, session, room, state);
  });

  socket.on('waiting-room-deny', async ({ targetSocketId }) => {
    if (!await verifyHost(socket)) return;
    const state = roomState.get(socket.sessionCode);
    if (!state) return;
    const waiting = state.waitingRoom.get(targetSocketId);
    state.waitingRoom.delete(targetSocketId);
    broadcastWaitingRoom(socket.sessionCode, state);
    if (waiting?.userId) {
      await pool.query(
        'INSERT INTO session_bans (session_id, user_id, reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [socket.sessionDbId, waiting.userId, 'denied']
      );
    }
    const target = io.sockets.sockets.get(targetSocketId);
    if (target) target.emit('join-denied');
  });

  socket.on('disconnect', () => {
    // Clean up from waiting room if they disconnected while waiting
    if (socket.pendingRoom && !socket.sessionCode) {
      const state = roomState.get(socket.pendingRoom);
      if (state) {
        state.waitingRoom.delete(socket.id);
        broadcastWaitingRoom(socket.pendingRoom, state);
      }
    }
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
const REMINDER_OPTS = {
  'now': { ms: 0,       col: 'reminder_now_sent', label: 'now' },
  '5m':  { ms: 300000,  col: 'reminder_5m_sent',  label: 'in 5 minutes' },
  '15m': { ms: 900000,  col: 'reminder_15m_sent', label: 'in 15 minutes' },
  '30m': { ms: 1800000, col: 'reminder_30m_sent', label: 'in 30 minutes' },
  '1h':  { ms: 3600000, col: 'reminder_1h_sent',  label: 'in 1 hour' },
};

let burstInterval = null;
let burstUntil = 0;

async function runCheck(win) {
  const now = Date.now();
  async function checkReminders(opt) {
    const { ms, col, label } = REMINDER_OPTS[opt];
    const lo = new Date(now + ms - win).toISOString();
    const hi = new Date(now + ms + win).toISOString();
    const result = await pool.query(`
      SELECT i.id, i.email, s.title, s.code, s.scheduled_time, s.timezone
      FROM invites i JOIN sessions s ON i.session_id=s.id
      WHERE s.is_scheduled=1 AND s.is_active=1
        AND i.${col}=0
        AND s.scheduled_time BETWEEN $1 AND $2
        AND s.reminder_options LIKE $3
    `, [lo, hi, `%"${opt}"%`]);
    for (const r of result.rows) {
      const subj = opt === 'now'
        ? `"${r.title}" is starting now`
        : `Reminder: "${r.title}" starts ${label}`;
      sendEmail(r.email, subj, inviteEmailHtml(r.title, r.code, r.scheduled_time, true, label, r.timezone));
      await pool.query(`UPDATE invites SET ${col}=1 WHERE id=$1`, [r.id]);
    }
  }
  for (const opt of Object.keys(REMINDER_OPTS)) await checkReminders(opt);
  await pool.query(
    `UPDATE sessions SET is_scheduled=0 WHERE is_scheduled=1 AND is_active=1 AND scheduled_time <= $1`,
    [new Date(now).toISOString()]
  );
}

cron.schedule('*/5 * * * *', async () => {
  try {
    // Wide window (3 min) so nothing falls between 5-min ticks
    await runCheck(3 * 60 * 1000);

    // If a session starts within the next 10 min, burst-check every second for 5 min
    const lo = new Date().toISOString();
    const hi = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const { rows } = await pool.query(
      `SELECT 1 FROM sessions WHERE is_scheduled=1 AND is_active=1 AND scheduled_time BETWEEN $1 AND $2 LIMIT 1`,
      [lo, hi]
    );
    if (rows.length > 0 && Date.now() >= burstUntil) {
      burstUntil = Date.now() + 5 * 60 * 1000;
      clearInterval(burstInterval);
      burstInterval = setInterval(async () => {
        if (Date.now() >= burstUntil) { clearInterval(burstInterval); burstInterval = null; return; }
        try { await runCheck(2000); } catch (err) { console.error('[Burst]', err.message); }
      }, 1000);
    }
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
