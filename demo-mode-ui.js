'use strict';

/*
 * Demo/real mode UI integration for public-index.html.
 * Load this script after the existing inline game script. Demo wallet and bets
 * use only /api/demo endpoints; existing real-money handlers remain untouched.
 */
(() => {
  const MODE_KEY = 'flyzed_game_mode';
  const API_BASE = 'https://ka-ndeke-backend-5dgy.onrender.com/api';
  let mode = localStorage.getItem(MODE_KEY) === 'DEMO' ? 'DEMO' : 'REAL';
  let demoBalance = null;
  let demoBetId = null;
  let loadingWallet = false;
  let crashWatcher = null;

  const realStartGame = window.startGame;
  const realCashOut = window.cashOut;
  const realUpdateUI = window.updateUI;

  function byId(id) { return document.getElementById(id); }

  function addModeUI() {
    if (byId('modeControls')) return;
    const userPanel = document.querySelector('main > .panel');
    const controls = document.querySelector('main > .controls');
    if (!userPanel || !controls) return;

    const modePanel = document.createElement('section');
    modePanel.id = 'modeControls';
    modePanel.className = 'controls';
    modePanel.innerHTML = `
      <div><strong>Play mode:</strong> <span id="modeLabel">Real Money</span></div>
      <div class="row" role="group" aria-label="Choose game mode">
        <button type="button" class="btn-secondary" id="realModeButton">Real Money</button>
        <button type="button" class="btn-secondary" id="demoModeButton">Demo Mode</button>
        <button type="button" class="btn-secondary hidden" id="resetDemoButton">Reset demo credits</button>
      </div>
      <div id="demoModeNotice" class="hidden" style="color:var(--warning);font-size:13px">
        Demo only: virtual credits; deposits and withdrawals are disabled in this mode.
      </div>
      <div id="demoHistory" class="hidden" style="font-size:13px;color:var(--muted)"></div>`;
    userPanel.insertAdjacentElement('afterend', modePanel);

    byId('realModeButton').addEventListener('click', () => setMode('REAL'));
    byId('demoModeButton').addEventListener('click', () => setMode('DEMO'));
    byId('resetDemoButton').addEventListener('click', resetDemoWallet);
  }

  function setWalletDisplay(value, currency) {
    const balance = byId('balance');
    if (balance) balance.textContent = `${Number(value).toFixed(2)} ${currency}`;
  }

  function updateModeUI() {
    const demo = mode === 'DEMO';
    const label = byId('modeLabel');
    const notice = byId('demoModeNotice');
    const reset = byId('resetDemoButton');
    const history = byId('demoHistory');
    const realButton = byId('realModeButton');
    const demoButton = byId('demoModeButton');
    if (!label) return;

    label.textContent = demo ? 'DEMO — virtual credits only' : 'Real Money';
    notice.classList.toggle('hidden', !demo);
    realButton.setAttribute('aria-pressed', String(!demo));
    demoButton.setAttribute('aria-pressed', String(demo));
    history.classList.toggle('hidden', !demo);

    const betInput = byId('betAmount');
    if (betInput) {
      betInput.min = demo ? '1' : '1';
      betInput.max = demo ? '9.99' : '';
      betInput.step = demo ? '0.01' : '1';
      betInput.placeholder = demo ? 'Demo bet (1–9.99 VC)' : 'Bet amount (K)';
    }

    // Deposits and withdrawals are real-wallet operations; hide them in demo.
    document.querySelectorAll('button[onclick="deposit()"], button[onclick="withdraw()"], button[onclick="openCheckStatus()"]')
      .forEach(button => button.classList.toggle('hidden', demo));

    if (demo) {
      if (demoBalance === null) setWalletDisplay(0, 'VC');
      else setWalletDisplay(demoBalance, 'VC');
      reset.classList.toggle('hidden', demoBalance !== 0 || !!demoBetId);
    } else if (typeof realUpdateUI === 'function') {
      realUpdateUI();
    }
  }

  async function loadDemoWallet() {
    if (loadingWallet || mode !== 'DEMO') return;
    if (typeof authMode === 'undefined' || authMode !== 'server' || !localStorage.getItem('flyzed_token')) {
      demoBalance = null;
      setWalletDisplay(0, 'VC');
      const history = byId('demoHistory');
      if (history) history.textContent = 'Log in to load your separate demo wallet.';
      updateModeUI();
      return;
    }
    loadingWallet = true;
    try {
      const wallet = await apiFetch('/demo/wallet', {}, true);
      demoBalance = Number(wallet.balance);
      await loadDemoHistory();
    } catch (error) {
      const history = byId('demoHistory');
      if (history) history.textContent = `Demo wallet unavailable: ${error.message}`;
    } finally {
      loadingWallet = false;
      updateModeUI();
    }
  }

  async function loadDemoHistory() {
    try {
      const result = await apiFetch('/demo/history?limit=5', {}, true);
      const history = byId('demoHistory');
      if (!history) return;
      if (!result.bets || !result.bets.length) {
        history.textContent = 'Recent demo bets: none yet.';
        return;
      }
      history.textContent = 'Recent demo bets: ' + result.bets.map(bet =>
        `${String(bet.status).toUpperCase()} ${Number(bet.bet_amount).toFixed(2)} VC (payout ${Number(bet.payout).toFixed(2)} VC)`
      ).join(' · ');
    } catch (error) {
      const history = byId('demoHistory');
      if (history) history.textContent = `Demo history unavailable: ${error.message}`;
    }
  }

  async function setMode(nextMode) {
    if (nextMode === mode) return;
    if (typeof running !== 'undefined' && running || demoBetId) {
      alert('Finish the current round before switching modes.');
      return;
    }
    mode = nextMode;
    localStorage.setItem(MODE_KEY, mode);
    updateModeUI();
    if (mode === 'DEMO') await loadDemoWallet();
  }

  async function resetDemoWallet() {
    if (mode !== 'DEMO') return;
    try {
      const result = await apiFetch('/demo/wallet/reset', { method: 'POST', body: {} }, true);
      demoBalance = Number(result.balance);
      updateModeUI();
      await loadDemoHistory();
      const status = byId('status');
      if (status) status.textContent = 'Demo credits reset. Ready to play with virtual credits.';
    } catch (error) {
      alert(`Demo reset failed: ${error.message}`);
    }
  }

  async function startDemoGame() {
    if (typeof authMode === 'undefined' || authMode !== 'server' || !localStorage.getItem('flyzed_token')) {
      alert('Log in to play with your separate demo wallet.');
      if (typeof showLogin === 'function') showLogin();
      return;
    }
    if (typeof running !== 'undefined' && running) return alert('Finish the current round first.');
    const betAmount = Number(byId('betAmount').value);
    if (!Number.isFinite(betAmount) || betAmount < 1 || betAmount > 9.99) {
      return alert('Demo bets must be between 1 and 9.99 virtual credits.');
    }
    try {
      const result = await apiFetch('/demo/start', { method: 'POST', body: { betAmount } }, true);
      demoBetId = result.betId;
      running = true;
      crashed = false;
      currentBet = betAmount;
      currentRoundId = result.roundId;
      roundActive = true;
      localCrashDetected = false;
      if (byId('cashOutBtn')) byId('cashOutBtn').disabled = false;
      if (byId('playBtn')) byId('playBtn').disabled = true;
      if (byId('viewProofBtn')) byId('viewProofBtn').disabled = true;
      if (byId('status')) byId('status').textContent = `Demo bet placed: ${betAmount.toFixed(2)} VC`;
      demoBalance = Number(result.balance);
      updateModeUI();
      watchDemoCrash();
    } catch (error) {
      alert(`Demo bet failed: ${error.message}`);
    }
  }

  async function cashOutDemo() {
    if (!demoBetId) return alert('No active demo bet.');
    try {
      const result = await apiFetch('/demo/cashout', { method: 'POST', body: { betId: demoBetId } }, true);
      demoBetId = null;
      running = false;
      crashed = true;
      if (byId('cashOutBtn')) byId('cashOutBtn').disabled = true;
      if (byId('playBtn')) byId('playBtn').disabled = false;
      if (byId('status')) byId('status').textContent = result.success
        ? `Demo cashed out at ${Number(result.multiplier).toFixed(2)}x — ${Number(result.payout).toFixed(2)} VC credited.`
        : 'Demo bet lost: the round had already crashed.';
      demoBalance = Number(result.balance);
      updateModeUI();
      await loadDemoHistory();
    } catch (error) {
      alert(`Demo cashout failed: ${error.message}`);
    }
  }

  function watchDemoCrash() {
    if (crashWatcher) clearInterval(crashWatcher);
    crashWatcher = setInterval(async () => {
      if (mode !== 'DEMO' || !demoBetId) {
        clearInterval(crashWatcher);
        crashWatcher = null;
        return;
      }
      try {
        const status = await apiFetch('/game/status', {}, false);
        if (status.status === 'crashed') {
          demoBetId = null;
          running = false;
          crashed = true;
          if (byId('cashOutBtn')) byId('cashOutBtn').disabled = true;
          if (byId('playBtn')) byId('playBtn').disabled = false;
          if (byId('status')) byId('status').textContent = 'Demo bet lost: the round crashed.';
          await loadDemoWallet();
          await loadDemoHistory();
          clearInterval(crashWatcher);
          crashWatcher = null;
        }
      } catch (_) { /* Existing game status handling remains active. */ }
    }, 500);
  }

  function initialize() {
    addModeUI();
    if (!byId('modeControls')) return;
    window.updateUI = function() {
      if (typeof realUpdateUI === 'function') realUpdateUI();
      updateModeUI();
      if (mode === 'DEMO' && typeof authMode !== 'undefined' && authMode === 'server') loadDemoWallet();
    };
    window.startGame = function() {
      return mode === 'DEMO' ? startDemoGame() : realStartGame();
    };
    window.cashOut = function() {
      return mode === 'DEMO' ? cashOutDemo() : realCashOut();
    };
    updateModeUI();
    if (mode === 'DEMO') loadDemoWallet();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
