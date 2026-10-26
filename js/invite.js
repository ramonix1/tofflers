/**
 * invite.js — Gerencia o modal de convite com link Cloudflare Tunnel.
 *
 * Fluxo:
 *  1. Clicar em "🔗 Convidar" → abre modal → consulta GET /api/invite
 *  2. Se status=off → dispara POST /api/invite/start → polling GET /api/invite (~1.5s)
 *  3. Quando ready → mostra URL + botão copiar
 *  4. Botão "Parar de compartilhar" → POST /api/invite/stop → gira o token (link antigo morre; o túnel segue)
 *  5. Se error → mostra mensagem e opção de retry
 */

import { getHostKey } from './host-key.js';

const POLL_INTERVAL_MS  = 1500;
const POLL_TIMEOUT_MS   = 30_000;

// ── Elementos DOM ────────────────────────────────────────────────────────────

const modal          = document.getElementById('invite-modal');
const closeBtn       = document.getElementById('invite-modal-close');
const inviteBtn      = document.getElementById('invite-btn');

const stateLoading   = document.getElementById('invite-state-loading');
const stateReady     = document.getElementById('invite-state-ready');
const stateError     = document.getElementById('invite-state-error');

const urlInput       = document.getElementById('invite-url-input');
const copyBtn        = document.getElementById('invite-copy-btn');
const stopBtn        = document.getElementById('invite-stop-btn');
const errorMsg       = document.getElementById('invite-error-msg');
const retryBtn       = document.getElementById('invite-retry-btn');

// ── Estado interno ────────────────────────────────────────────────────────────

let pollTimer   = null;
let pollDeadline = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function showState(which) {
  stateLoading.style.display = which === 'loading' ? '' : 'none';
  stateReady.style.display   = which === 'ready'   ? '' : 'none';
  stateError.style.display   = which === 'error'   ? '' : 'none';
}

function openModal() {
  modal.classList.add('visible');
  fetchStatus();
}

function closeModal() {
  modal.classList.remove('visible');
  stopPolling();
}

function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function apiFetch(method, path) {
  const headers = { 'Content-Type': 'application/json' };
  const hostKey = getHostKey();
  if (hostKey) headers['X-Host-Key'] = hostKey;
  const res = await fetch(path, { method, headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Lógica principal ──────────────────────────────────────────────────────────

async function fetchStatus() {
  try {
    const data = await apiFetch('GET', '/api/invite');
    handleStatus(data);
  } catch (err) {
    showError(`Erro de comunicação com o servidor: ${err.message}`);
  }
}

function handleStatus(data) {
  stopPolling();

  if (data.status === 'ready') {
    urlInput.value = data.url || '';
    showState('ready');

  } else if (data.status === 'error') {
    showError(data.error || 'Erro desconhecido ao gerar o link.');

  } else if (data.status === 'starting') {
    showState('loading');
    schedulePoll();

  } else {
    // status === 'off' — dispara o túnel
    showState('loading');
    startTunnel();
  }
}

async function startTunnel() {
  try {
    await apiFetch('POST', '/api/invite/start');
    pollDeadline = Date.now() + POLL_TIMEOUT_MS;
    schedulePoll();
  } catch (err) {
    showError(`Falha ao iniciar o túnel: ${err.message}`);
  }
}

function schedulePoll() {
  stopPolling();
  if (Date.now() > pollDeadline) {
    showError('Tempo esgotado ao aguardar o link. Tente novamente.');
    return;
  }
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    try {
      const data = await apiFetch('GET', '/api/invite');
      handleStatus(data);
    } catch (err) {
      showError(`Erro de comunicação: ${err.message}`);
    }
  }, POLL_INTERVAL_MS);
}

function showError(msg) {
  stopPolling();
  errorMsg.textContent = msg;
  showState('error');
}

// ── Ações dos botões ──────────────────────────────────────────────────────────

copyBtn.addEventListener('click', async () => {
  const url = urlInput.value;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    copyBtn.textContent = 'Copiado ✓';
    setTimeout(() => { copyBtn.textContent = 'Copiar'; }, 2000);
  } catch {
    // Fallback: seleciona o input para o usuário copiar manualmente
    urlInput.select();
    try {
      document.execCommand('copy');
      copyBtn.textContent = 'Copiado ✓';
      setTimeout(() => { copyBtn.textContent = 'Copiar'; }, 2000);
    } catch {
      copyBtn.textContent = 'Selecione e copie';
    }
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    await apiFetch('POST', '/api/invite/stop');
    showState('loading');
    // Volta ao estado off — não inicia novo túnel automaticamente
    stateLoading.querySelector('.invite-status-text').textContent = 'Link antigo invalidado.';
    setTimeout(() => {
      stateLoading.querySelector('.invite-status-text').textContent = 'Gerando link seguro…';
      closeModal();
    }, 1200);
  } catch (err) {
    showError(`Erro ao parar de compartilhar: ${err.message}`);
  }
});

retryBtn.addEventListener('click', () => {
  showState('loading');
  pollDeadline = Date.now() + POLL_TIMEOUT_MS;
  startTunnel();
});

inviteBtn.addEventListener('click', openModal);
closeBtn.addEventListener('click', closeModal);

// Fecha ao clicar fora do box
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});

// ESC fecha o modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modal.classList.contains('visible')) closeModal();
});
