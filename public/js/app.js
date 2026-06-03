// Shared utilities — included on every page

const API = {
  async req(method, path, data) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    const token = localStorage.getItem('token');
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

function getToken()    { return localStorage.getItem('token'); }
function getUsername() { return localStorage.getItem('username'); }

function requireAuth() {
  if (!getToken()) { window.location.href = '/'; return false; }
  return true;
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  window.location.href = '/';
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

// Format timestamp
function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
    // Basic email check
    if (!val.includes('@')) { toast('Enter a valid email', 'err'); return; }
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
