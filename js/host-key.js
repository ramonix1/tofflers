/**
 * host-key.js — Chave do anfitrião.
 * O anfitrião entra pelo link secreto `<túnel>/?h=<chave>`. Ao carregar, guarda a
 * chave em sessionStorage (F5 continua valendo) e REMOVE o `h` da barra de
 * endereço, para não vazar em compartilhamento de tela. Importado por net.js e
 * invite.js — o módulo roda uma única vez, antes de quem o importa.
 */
const STORAGE_KEY = 'enterprise.hostKey';

let hostKey = null;

try {
  const url = new URL(location.href);
  const h = url.searchParams.get('h');
  if (h) {
    hostKey = h;
    try { sessionStorage.setItem(STORAGE_KEY, h); } catch { /* storage bloqueado */ }
    url.searchParams.delete('h');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  } else {
    try { hostKey = sessionStorage.getItem(STORAGE_KEY); } catch { /* storage bloqueado */ }
  }
} catch { /* sem chave: entra como convidado */ }

/** @returns {string|null} chave do anfitrião, ou null (convidado). */
export function getHostKey() {
  return hostKey;
}
