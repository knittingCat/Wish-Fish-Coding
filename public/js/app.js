// Migrate token from localStorage → sessionStorage (one-time, for existing sessions)
if (!sessionStorage.getItem('token') && localStorage.getItem('token')) {
  sessionStorage.setItem('token',    localStorage.getItem('token'));
  sessionStorage.setItem('username', localStorage.getItem('username'));
  localStorage.removeItem('token');
  localStorage.removeItem('username');
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Keep Render server warm (free tier sleeps after ~15 min inactivity)
setInterval(() => fetch('/ping').catch(() => {}), 8 * 60 * 1000);

// Shared utilities — included on every page

const API = {
  async req(method, path, data) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    const token = sessionStorage.getItem('token');
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (data) opts.body = JSON.stringify(data);
    const res = await fetch(path, opts);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Request failed');
    return json;
  },
  get:    (path)       => API.req('GET',    path),
  post:   (path, data) => API.req('POST',   path, data),
  delete: (path)       => API.req('DELETE', path)
};

function getToken()    { return sessionStorage.getItem('token'); }
function getUsername() { return sessionStorage.getItem('username'); }

function requireAuth() {
  if (!getToken()) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = '/?next=' + next;
    return false;
  }
  return true;
}

function logout() {
  sessionStorage.removeItem('token');
  sessionStorage.removeItem('username');
  window.location.href = '/';
}

document.addEventListener('DOMContentLoaded', () => {
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) {
    const btn = document.getElementById('updateAppBtn');
    if (btn) btn.style.display = '';
  }
});

async function updateApp() {
  const btn = document.getElementById('updateAppBtn');
  if (btn) { btn.disabled = true; btn.textContent = '↻'; }
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch {}
  window.location.reload(true);
}

// Toast notifications
let _toastTimer;
function toast(msg, type = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `toast show ${type ? 'toast-' + type : ''}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = 'toast'; }, 3500);
}

// Contacts notification badge
async function loadNotifBadge() {
  if (!getToken()) return;
  try {
    const d = await API.get('/api/contacts/notifications');
    const total = d.pendingRequests + d.unreadMessages;
    const btn = document.getElementById('navNotifBtn');
    const count = document.getElementById('navNotifCount');
    if (!btn || !count) return;
    count.textContent = total;
    btn.style.display = total > 0 ? '' : 'none';
  } catch {}
}

// Format timestamp
function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtChatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today - dDate) / 86400000);
  const label = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${label} · ${time}`;
}
function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Tags input (email chips)
function initTagsInput(container, inputEl) {
  const tags = [];
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(inputEl.value.trim());
    }
    if (e.key === 'Backspace' && !inputEl.value && tags.length) {
      removeTag(tags.length - 1);
    }
  });
  inputEl.addEventListener('blur', () => {
    if (inputEl.value.trim()) addTag(inputEl.value.trim());
  });
  container.addEventListener('click', () => inputEl.focus());

  function addTag(val) {
    if (!val || tags.includes(val)) return;
    tags.push(val);
    inputEl.value = '';
    renderTags();
  }
  function removeTag(i) {
    tags.splice(i, 1);
    renderTags();
  }
  function renderTags() {
    const chips = container.querySelectorAll('.tag');
    chips.forEach(c => c.remove());
    tags.forEach((t, i) => {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.innerHTML = `${t} <button onclick="event.stopPropagation()">&times;</button>`;
      chip.querySelector('button').addEventListener('click', () => removeTag(i));
      container.insertBefore(chip, inputEl);
    });
  }
  return { getTags: () => [...tags] };
}
