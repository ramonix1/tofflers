/**
 * session-overlay.js — Tela cheia bloqueante quando a sessão acaba (ou o link é inválido).
 * Estilos inline de propósito: não depende do CSS (que pode nem ter carregado certo).
 */
export function showSessionOverlay(reason, isHost = false) {
  if (document.getElementById('session-overlay')) return;
  let title, text;
  if (reason === 'invalid') {
    title = 'Link inválido ou expirado';
    text  = 'Peça um novo convite ao anfitrião.';
  } else if (isHost) {
    title = 'Sessão encerrada';
    text  = 'Feche esta janela, ou recarregue para iniciar uma nova sessão (o link do anfitrião continua valendo).';
  } else {
    title = 'Sessão encerrada pelo anfitrião';
    text  = 'Este link não funciona mais. Peça um novo convite para entrar de novo.';
  }
  const el = document.createElement('div');
  el.id = 'session-overlay';
  el.setAttribute('role', 'alertdialog');
  el.setAttribute('data-testid', 'session-overlay');
  el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0f1020;color:#fff;' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;' +
    'font-family:system-ui,sans-serif;text-align:center;padding:24px';
  el.innerHTML = '<div style="font-size:48px">🔒</div>' +
    '<h1 style="margin:0;font-size:24px"></h1><p style="margin:0;opacity:.8;max-width:420px"></p>';
  el.querySelector('h1').textContent = title;
  el.querySelector('p').textContent = text;
  if (isHost && reason !== 'invalid') {
    const b = document.createElement('button');
    b.textContent = 'Recarregar';
    b.style.cssText = 'margin-top:8px;padding:10px 20px;font-size:15px;border:0;border-radius:8px;cursor:pointer';
    b.addEventListener('click', () => location.reload());
    el.appendChild(b);
  }
  document.body.appendChild(el);
}
