// Frontend app (public/app.js)
// - Improved network/debug helpers
// - Auto-detect / normalize backend URL entered by user (tries variants and picks working API base)
// - Uses phone as the identifier (phone -> server's phone column)
// - Assumes server exposes a health endpoint at <API_BASE>/health (see backend snippet below)

(() => {
  // Default: relative API (when backend serves the frontend)
  let API_BASE = '/api';
  const TOKEN_KEY = 'token';

  // DOM refs (expects elements in public/index.html)
  const backendUrlInput = document.getElementById('backendUrlInput');
  const setBackendBtn = document.getElementById('setBackendBtn');
  const apiStatusEl = document.getElementById('apiStatus');

  const loginBtn = document.getElementById('loginBtn');
  const registerBtn = document.getElementById('registerBtn');
  const logoutBtn = document.getElementById('logoutBtn');

  const usernameEl = document.getElementById('username');
  const balanceEl = document.getElementById('balance');
  const freeRoundsEl = document.getElementById('freeRounds');

  const depositInput = document.getElementById('depositAmount');
  const depositBtn = document.getElementById('depositBtn');
  const withdrawInput = document.getElementById('withdrawAmount');
  const withdrawBtn = document.getElementById('withdrawBtn');

  const betAmountInput = document.getElementById('betAmount');
  const betBtn = document.getElementById('betBtn');
  const cashOutBtn = document.getElementById('cashOutBtn');
  const statusEl = document.getElementById('status');

  // Modal elements (register/login)
  const modalBackdrop = document.getElementById('modalBackdrop');
  const modalTitle = document.getElementById('modalTitle');
  const modalFullname = document.getElementById('modalFullname');
  const modalPhone = document.getElementById('modalPhone');
  const modalPassword = document.getElementById('modalPassword');
  const modalSubmit = document.getElementById('modalSubmit');
  const modalCancel = document.getElementById('modalCancel');
  const modalMessage = document.getElementById('modalMessage');

  // Local / offline account storage keys (phone-based)
  const LOCAL_USERS_KEY = 'localUsers_phone';
  const LOCAL_CURRENT_KEY = 'localCurrent_phone';

  // Simple state
  let authMode = null; // 'server' | 'local' | null
  let currentUser = null; // user object when logged in
  let guestBalance = 10; // guests start with K10

  // ---------- Utilities ----------
  function setApiStatus(text, color) {
    if (!apiStatusEl) return;
    apiStatusEl.textContent = text;
    apiStatusEl.style.background = color || '#072033';
  }

  function saveLocalUsers(obj) { try { localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(obj || {})); } catch (e) {} }
  function loadLocalUsers() { try { return JSON.parse(localStorage.getItem(LOCAL_USERS_KEY) || '{}'); } catch (e) { return {}; } }
  function setLocalCurrent(phone) { try { localStorage.setItem(LOCAL_CURRENT_KEY, phone || ''); } catch (e) {} }
  function getLocalCurrent() { try { return localStorage.getItem(LOCAL_CURRENT_KEY) || ''; } catch (e) { return ''; } }

  function uuidv4() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) { const r = Math.random()*16|0, v = c=='x' ? r : (r&0x3|0x8); return v.toString(16); }); }

  // ---------- Network helpers (debug-friendly) ----------
  // apiFetch: always call with a path starting with '/', e.g. '/auth/register'
  async function apiFetch(path, opts = {}, withAuth = true) {
    const base = (API_BASE || '/api').replace(/\/+$/, '');
    const relPath = (path || '').replace(/^\/+/, '');
    const url = base + '/' + relPath;

    const headers = opts.headers || {};
    if (withAuth) {
      const token = localStorage.getItem(TOKEN_KEY);
      if (token) headers['Authorization'] = 'Bearer ' + token;
    }
    opts.headers = headers;

    console.log(`[API] ${opts.method || 'GET'} ${url}`, opts);

    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      console.error('[API] network error', err);
      throw new Error('Network error: could not reach ' + url);
    }

    const status = res.status;
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }

    console.log(`[API] response ${status} ${url}`, { text: text.slice(0, 2000), json });

    if (!res.ok) {
      if (json && json.error) throw new Error(json.error);
      if (text && /<html|<!doctype/i.test(text)) throw new Error(`Server returned HTML error (status ${status})`);
      throw new Error(text || `Request failed (${status})`);
    }
    return json;
  }

  async function tryApi(path, opts = {}, withAuth = true) {
    try {
      const data = await apiFetch(path, opts, withAuth);
      return { ok: true, data };
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      const isNetwork = /network|could not reach|failed to fetch/i.test(msg);
      return { ok: false, network: isNetwork, error: err };
    }
  }

  // ---------- Auto-detect / normalize backend URL logic ----------
  // User may paste:
  //   - https://example.com
  //   - https://example.com/whatever
  //   - https://example.com/api
  // We'll generate candidate API_BASE values (including '/api' suffix) and test for a health endpoint.
  function buildCandidates(raw) {
    if (!raw) return ['/api'];

    let val = raw.trim();
    // if user supplied no protocol, try https then http fallback
    const withProtocol = (u) => {
      if (/^https?:\/\//i.test(u)) return u;
      return 'https://' + u;
    };

    const normalized = withProtocol(val).replace(/\/+$/, ''); // trim trailing slash
    const candidates = new Set();

    // if user already included '/api'
    if (/\/api(\/|$)/i.test(normalized)) {
      candidates.add(normalized); // exact (likely contains /api)
      // also try without trailing /api in case server expects it in a proxy
      candidates.add(normalized.replace(/\/api\/?$/i, ''));
    } else {
      // common: user gives host -> try host + /api and host itself
      candidates.add(normalized + '/api');
      candidates.add(normalized);
    }

    // also try http version as last resort
    if (!/^http:\/\//i.test(normalized)) {
      candidates.add(normalized.replace(/^https:\/\//i, 'http://') + '/api');
      candidates.add(normalized.replace(/^https:\/\//i, 'http://'));
    }

    return Array.from(candidates);
  }

  // Try candidates in order and pick first that responds to /health (GET)
  async function probeAndSetApiBase(rawInput) {
    const candidates = buildCandidates(rawInput);
    setApiStatus('API: testing...', '#444');
    for (const c of candidates) {
      try {
        // We'll attempt GET <c>/health (if c already contains /api then path is <c>/health else <c>/api/health)
        const base = c.replace(/\/+$/, '');
        const healthUrl = base + '/health';
        console.log('[API] probing', healthUrl);

        // We cannot use apiFetch here because API_BASE may not be set; use fetch direct
        const res = await fetch(healthUrl, { method: 'GET' });
        if (res.ok) {
          // success — set API_BASE appropriately
          // We want API_BASE to be the URL that when appended with '/auth/register' etc works.
          // If 'base' already ends with '/api', keep it; else if base looks like host (no /api) attempt base + '/api' and test that too.
          if (/\/api(\/|$)/i.test(base)) {
            API_BASE = base.replace(/\/+$/, ''); // e.g. https://host/api
            setApiStatus('API: set (reachable)', '#083a1f');
            console.log('[API] selected base', API_BASE);
            return { ok: true, base: API_BASE };
          } else {
            // Try base + '/api' too
            const candidateApi = base + '/api';
            try {
              const res2 = await fetch(candidateApi + '/health', { method: 'GET' });
              if (res2.ok) {
                API_BASE = candidateApi;
                setApiStatus('API: set (reachable)', '#083a1f');
                console.log('[API] selected base', API_BASE);
                return { ok: true, base: API_BASE };
              }
            } catch (e) {
              // ignore and fall back to using base (server may expose health at base)
            }
            // fallback: use base
            API_BASE = base;
            setApiStatus('API: set (reachable)', '#083a1f');
            console.log('[API] selected base (fallback)', API_BASE);
            return { ok: true, base: API_BASE };
          }
        } else {
          console.log('[API] probe non-ok', healthUrl, res.status);
        }
      } catch (err) {
        console.log('[API] probe failed', c, err && err.message);
      }
    }
    setApiStatus('API: unreachable', '#663300');
    return { ok: false };
  }

  // ---------- Auth & user API functions (phone-based) ----------
  async function registerServer(fullname, phone, password) {
    return await tryApi('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: fullname, phone, password })
    }, false);
  }

  async function loginServer(phone, password) {
    return await tryApi('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password })
    }, false);
  }

  async function getMe() {
    return await tryApi('/users/me', { method: 'GET' }, true);
  }

  async function depositServer(amount) {
    return await tryApi('/users/deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount })
    }, true);
  }

  async function withdrawServer(amount) {
    return await tryApi('/users/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount })
    }, true);
  }

  async function changeBalanceServer(delta) {
    return await tryApi('/users/balance/change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delta })
    }, true);
  }

  // ---------- Local offline fallback (phone-keyed) ----------
  function localRegister(fullname, phone, password) {
    const users = loadLocalUsers();
    if (users[phone]) throw new Error('Phone already registered locally');
    const id = uuidv4();
    const now = new Date().toISOString();
    users[phone] = { id, username: fullname, phone, password, balance: 10, freeRounds: 0, createdAt: now, updatedAt: now };
    saveLocalUsers(users);
    setLocalCurrent(phone);
    authMode = 'local';
    currentUser = users[phone];
    localStorage.removeItem(TOKEN_KEY);
    return users[phone];
  }

  function localLogin(phone, password) {
    const users = loadLocalUsers();
    const u = users[phone];
    if (!u) throw new Error('Local account not found');
    if (u.password !== password) throw new Error('Invalid credentials (local)');
    setLocalCurrent(phone);
    authMode = 'local';
    currentUser = u;
    localStorage.removeItem(TOKEN_KEY);
    return u;
  }

  function localApplyChange(delta) {
    const phone = getLocalCurrent();
    const users = loadLocalUsers();
    const u = users[phone];
    if (!u) throw new Error('No local account');
    const updated = Number(u.balance || 0) + Number(delta);
    if (updated < 0) throw new Error('Insufficient funds (local)');
    u.balance = updated;
    u.updatedAt = new Date().toISOString();
    saveLocalUsers(users);
    currentUser = u;
    return u;
  }

  // ---------- Apply user to UI ----------
  function applyUserToUI(user, mode) {
    if (!user) return;
    currentUser = user;
    authMode = mode || authMode;
    usernameEl.textContent = (user.username || user.phone || 'Player') + (authMode === 'local' ? ' (offline)' : '');
    const newBalance = Number(user.balance || (authMode === null ? guestBalance : 0));
    balanceEl.textContent = 'K ' + Number(newBalance).toFixed(2);
    freeRoundsEl.textContent = user.freeRounds ? 'Free rounds: ' + user.freeRounds : '';
    loginBtn.style.display = authMode ? 'none' : '';
    registerBtn.style.display = authMode ? 'none' : '';
    logoutBtn.style.display = authMode ? '' : 'none';
  }

  function clearToGuest() {
    authMode = null;
    currentUser = null;
    usernameEl.textContent = 'Guest';
    balanceEl.textContent = 'K ' + Number(guestBalance).toFixed(2);
    freeRoundsEl.textContent = '';
    loginBtn.style.display = '';
    registerBtn.style.display = '';
    logoutBtn.style.display = 'none';
  }

  // ---------- UI modal handling ----------
  function showModal(mode) {
    modalMessage.textContent = '';
    modalMessage.className = '';
    if (mode === 'login') {
      modalTitle.textContent = 'Login';
      document.getElementById('fullnameRow')?.style.display === 'none';
      modalFullname && (modalFullname.value = '');
      modalPhone.value = '';
      modalPassword.value = '';
      modalSubmit.textContent = 'Login';
    } else {
      modalTitle.textContent = 'Register';
      document.getElementById('fullnameRow') && (document.getElementById('fullnameRow').style.display = '');
      modalFullname && (modalFullname.value = '');
      modalPhone.value = '';
      modalPassword.value = '';
      modalSubmit.textContent = 'Register';
    }
    modalBackdrop.style.display = 'flex';
    modalBackdrop.setAttribute('aria-hidden', 'false');
    modalPhone.focus();
  }

  function hideModal() {
    modalBackdrop.style.display = 'none';
    modalBackdrop.setAttribute('aria-hidden', 'true');
  }

  modalCancel && modalCancel.addEventListener('click', (e) => { e.preventDefault(); hideModal(); });

  // Register/Login form submit handler
  authForm && authForm.addEventListener && authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    modalMessage.textContent = '';
    modalMessage.className = '';
    const isRegister = modalTitle.textContent.toLowerCase().includes('register');
    const phone = modalPhone.value && modalPhone.value.trim();
    const password = modalPassword.value;
    const fullname = modalFullname && modalFullname.value && modalFullname.value.trim();

    if (!phone || !password || (isRegister && !fullname)) {
      modalMessage.textContent = 'Please fill required fields';
      modalMessage.className = 'error';
      return;
    }

    modalSubmit.disabled = true;
    try {
      if (isRegister) {
        // try server, fallback to local on network failure
        const result = await registerFlow(fullname, phone, password);
        if (result && result.user) {
          applyUserToUI(result.user, result.token ? 'server' : 'local');
          modalMessage.textContent = 'Registered and logged in';
          modalMessage.className = 'success';
          setTimeout(hideModal, 700);
        }
      } else {
        const result = await loginFlow(phone, password);
        const user = result && result.payload && result.payload.user ? result.payload.user : (result.user || (result.payload && result.payload.user));
        applyUserToUI(user || currentUser, result.payload ? 'server' : 'local');
        modalMessage.textContent = 'Logged in';
        modalMessage.className = 'success';
        setTimeout(hideModal, 400);
      }
    } catch (err) {
      modalMessage.textContent = err.message || 'Auth failed';
      modalMessage.className = 'error';
    } finally {
      modalSubmit.disabled = false;
    }
  });

  // ---------- Register/login flows with fallback ----------
  async function registerFlow(fullname, phone, password) {
    // try server
    try {
      const serverResp = await registerServer(fullname, phone, password);
      if (serverResp.ok && serverResp.data) {
        localStorage.setItem(TOKEN_KEY, serverResp.data.token);
        return { user: serverResp.data.user, token: serverResp.data.token };
      }
      if (serverResp.network) {
        // fallback local
        const localUser = localRegister(fullname, phone, password);
        return { user: localUser };
      }
      // server returned an error (bad request / duplicate etc)
      throw serverResp.error || new Error('Registration failed');
    } catch (err) {
      throw err;
    }
  }

  async function loginFlow(phone, password) {
    try {
      const serverResp = await loginServer(phone, password);
      if (serverResp.ok && serverResp.data) {
        localStorage.setItem(TOKEN_KEY, serverResp.data.token);
        return { payload: serverResp.data };
      }
      if (serverResp.network) {
        const localUser = localLogin(phone, password);
        return { user: localUser };
      }
      throw serverResp.error || new Error('Login failed');
    } catch (err) {
      throw err;
    }
  }

  // ---------- Deposit / Withdraw / Change balance UI handlers ----------
  depositBtn && depositBtn.addEventListener('click', async () => {
    const amount = Number(depositInput.value);
    if (!(amount > 0)) return alert('Enter deposit amount > 0');
    try {
      if (authMode === 'server') {
        const res = await depositServer(amount);
        if (res.ok) applyUserToUI(res.data, 'server');
      } else if (authMode === 'local') {
        const u = localApplyChange(amount);
        applyUserToUI(u, 'local');
      } else {
        guestBalance += amount;
        updateGuestUI();
        alert('Deposit applied to guest session (not persisted). Register to persist.');
      }
    } catch (err) {
      alert('Deposit failed: ' + (err.message || ''));
    } finally {
      depositInput.value = '';
    }
  });

  withdrawBtn && withdrawBtn.addEventListener('click', async () => {
    const amount = Number(withdrawInput.value);
    if (!(amount > 0)) return alert('Enter withdraw amount > 0');
    try {
      if (authMode === 'server') {
        const res = await withdrawServer(amount);
        if (res.ok) applyUserToUI(res.data, 'server');
      } else if (authMode === 'local') {
        const u = localApplyChange(-amount);
        applyUserToUI(u, 'local');
      } else {
        if (guestBalance < amount) return alert('Insufficient balance (guest)');
        guestBalance -= amount;
        updateGuestUI();
        alert('Withdraw applied to guest session (not persisted). Register to persist.');
      }
    } catch (err) {
      alert('Withdraw failed: ' + (err.message || ''));
    } finally {
      withdrawInput.value = '';
    }
  });

  function updateGuestUI() {
    usernameEl.textContent = 'Guest';
    balanceEl.textContent = 'K ' + Number(guestBalance).toFixed(2);
    freeRoundsEl.textContent = '';
  }

  // ---------- Game bet/cashout handlers (use /users/balance/change) ----------
  let multiplier = 1.0;
  let bet = 0;
  let gameTimer = null;
  let crashed = false;

  betBtn && betBtn.addEventListener('click', async () => {
    if (gameTimer) return;
    bet = Number(betAmountInput.value);
    if (bet <= 0) return alert('Enter a valid bet');

    // handle free plays and balance deduction similarly to previous logic
    let usingFree = false;
    if (authMode && currentUser && currentUser.freeRounds > 0) {
      currentUser.freeRounds--;
      usingFree = true;
    }

    if (!usingFree) {
      if ((authMode === 'server' && Number(currentUser.balance || 0) < bet) ||
          (authMode === 'local' && Number(currentUser.balance || 0) < bet) ||
          (authMode === null && guestBalance < bet)) {
        return alert('Insufficient balance');
      }

      try {
        if (authMode === 'server') {
          const res = await changeBalanceServer(-bet);
          if (res.ok) applyUserToUI(res.data, 'server');
        } else if (authMode === 'local') {
          const u = localApplyChange(-bet);
          applyUserToUI(u, 'local');
        } else {
          guestBalance -= bet;
          updateGuestUI();
        }
      } catch (err) {
        return alert('Could not place bet: ' + (err.message || ''));
      }
    }

    // start round
    multiplier = 1.0;
    crashed = false;
    document.getElementById('plane').style.bottom = '10px';
    document.getElementById('multiplier').innerText = '1.00x';
    statusEl.textContent = '✈️ Plane taking off...';
    cashOutBtn.disabled = false;

    let crashPoint = Math.random() < 0.7 ? 1.1 + Math.random()*0.6 : 2 + Math.random()*3;
    gameTimer = setInterval(() => {
      multiplier += 0.02;
      document.getElementById('multiplier').innerText = multiplier.toFixed(2) + 'x';
      const planeEl = document.getElementById('plane');
      planeEl.style.bottom = (parseFloat(planeEl.style.bottom) + 2) + 'px';
      if (multiplier >= crashPoint) crash();
    }, 100);
  });

  cashOutBtn && cashOutBtn.addEventListener('click', async () => {
    if (crashed) return;
    clearInterval(gameTimer);
    gameTimer = null;
    const win = bet * multiplier;
    statusEl.textContent = '✅ Cashed out at ' + multiplier.toFixed(2) + 'x → Won K ' + win.toFixed(2);
    cashOutBtn.disabled = true;

    try {
      if (authMode === 'server') {
        const res = await changeBalanceServer(win);
        if (res.ok) applyUserToUI(res.data, 'server');
      } else if (authMode === 'local') {
        const u = localApplyChange(win);
        applyUserToUI(u, 'local');
      } else {
        guestBalance += win;
        updateGuestUI();
      }
    } catch (err) {
      alert('Warning: could not save your win: ' + (err.message || ''));
    }
  });

  function crash() {
    clearInterval(gameTimer);
    gameTimer = null;
    crashed = true;
    statusEl.textContent = '💥 CRASH at ' + multiplier.toFixed(2) + 'x — You lost';
    cashOutBtn.disabled = true;
    if (authMode === 'server' && currentUser) applyUserToUI(currentUser, 'server');
    else if (authMode === 'local' && currentUser) applyUserToUI(currentUser, 'local');
    else updateGuestUI();
  }

  // ---------- Set backend button behavior ----------
  setBackendBtn && setBackendBtn.addEventListener('click', async () => {
    const raw = backendUrlInput.value && backendUrlInput.value.trim();
    if (!raw) {
      API_BASE = '/api';
      setApiStatus('API: auto', '#072033');
      return;
    }
    setApiStatus('API: testing...', '#444');
    const result = await probeAndSetApiBase(raw);
    if (!result.ok) {
      alert('Could not reach any API endpoints at that host. The app will operate in offline/local mode.');
    } else {
      // if token exists, optionally refresh user
      const token = localStorage.getItem(TOKEN_KEY);
      if (token) {
        const me = await tryApi('/users/me', { method: 'GET' }, true);
        if (me.ok) {
          applyUserToUI(me.data, 'server');
        } else {
          setApiStatus('API: connected (auth required)', '#083a1f');
        }
      }
    }
  });

  // ---------- Restore session on load ----------
  (async function init() {
    // default guest UI
    updateGuestUI();

    // restore local current if exists
    const lc = getLocalCurrent();
    if (lc) {
      const users = loadLocalUsers();
      if (users[lc]) {
        currentUser = users[lc];
        authMode = 'local';
        applyUserToUI(currentUser, 'local');
      }
    }

    // try server token if present and API reachable
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) {
      // try /users/me
      const attempt = await tryApi('/users/me', { method: 'GET' }, true);
      if (attempt.ok) {
        authMode = 'server';
        applyUserToUI(attempt.data, 'server');
        setApiStatus('API: connected', '#083a1f');
      } else {
        setApiStatus('API: unreachable', '#663300');
      }
    } else {
      setApiStatus('API: auto', '#072033');
    }
  })();

  // expose small helper for debugging
  window.__KaNdeke = {
    getState: () => ({ API_BASE, authMode, currentUser, guestBalance }),
    setApiBase: (b) => { backendUrlInput.value = b; setBackendBtn.click(); }
  };

  // ---------- small convenience event wiring for login/register buttons ----------
  registerBtn && registerBtn.addEventListener('click', () => {
    showModal('register');
  });
  loginBtn && loginBtn.addEventListener('click', () => {
    showModal('login');
  });
  logoutBtn && logoutBtn.addEventListener('click', () => {
    localStorage.removeItem(TOKEN_KEY);
    setLocalCurrent('');
    currentUser = null;
    authMode = null;
    guestBalance = 10;
    updateGuestUI();
  });

  // End IIFE
})();

