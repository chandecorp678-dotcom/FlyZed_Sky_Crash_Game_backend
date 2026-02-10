'use strict';

/**
 * FlyZed Frontend with Socket.IO real-time support
 * Optional: Use this instead of inline script if you want WebSockets
 */

const API_BASE = '/api';
const TOKEN_KEY = 'flyzed_token';

let authMode = null;
let currentUser = null;
let guestBalance = 10;
let socket = null;
let running = false;
let currentBet = 0;
let multiplier = 1.0;
let currentRoundId = null;

// ===== API FETCH =====
async function apiFetch(path, opts = {}, withAuth = true) {
  const url = API_BASE + path;
  const headers = opts.headers || {};

  if (withAuth) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) headers['Authorization'] = 'Bearer ' + token;
  }

  opts.headers = headers;
  if (opts.body && typeof opts.body === 'object') {
    opts.body = JSON.stringify(opts.body);
    opts.headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    json = null;
  }

  if (!res.ok) {
    throw new Error(json?.error || `HTTP ${res.status}`);
  }

  return json;
}

// ===== SOCKET.IO SETUP =====
function connectSocket() {
  try {
    socket = io({
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5
    });

    socket.on('connect', () => {
      console.log('Socket connected:', socket.id);
    });

    socket.on('multiplier', (data) => {
      if (running && data.status === 'running') {
        multiplier = Number(data.multiplier || 1).toFixed(2);
        document.getElementById('multiplier').textContent = multiplier + 'x';
      }
    });

    socket.on('roundStarted', (data) => {
      console.log('Round started:', data);
      running = true;
      currentRoundId = data.roundId;
      document.getElementById('cashOutBtn').disabled = false;
    });

    socket.on('crash', (data) => {
      console.log('Round crashed:', data);
      running = false;
      document.getElementById('cashOutBtn').disabled = true;
    });

    socket.on('disconnect', () => {
      console.log('Socket disconnected');
    });
  } catch (err) {
    console.warn('Socket.IO not available, using fallback polling');
  }
}

connectSocket();

// ===== EXPORT FOR INLINE SCRIPT =====
window.flyzedAPI = { apiFetch, connectSocket };
