// E2E do ciclo de sessão (host = quem apresenta a chave HOST_KEY; convidado = token ?k=).
// Uso: node tools/session-e2e.mjs [dirDoServidor]   (sobe server.js na porta 8282 com data/ descartável, mata ao fim)
// Usa o pacote `ws` (já dependência) porque o WebSocket global não permite headers custom.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

setTimeout(() => { console.error('TIMEOUT global'); process.exit(1); }, 60_000).unref();

const DIR = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const PORT = 8282, GRACE = 1500;
const HOST_KEY = 'chave-de-teste-do-anfitriao';
const TUNNEL_URL = 'https://fake-test.trycloudflare.com';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-e2e-')); // não toca nos dados/link reais
const srv = spawn('node', ['server.js'], {
  cwd: DIR, stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT), SESSION_GRACE_MS: String(GRACE), TEST_TUNNEL_URL: TUNNEL_URL, HOST_KEY, ENTERPRISE_DATA_DIR: DATA },
});
const cleanup = () => { try { srv.kill('SIGKILL'); } catch {} try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) fails++; };

const TUNNEL = { 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'abc123-GRU', 'x-forwarded-for': '203.0.113.9', host: 'fake-test.trycloudflare.com' };
const HK = { 'x-host-key': HOST_KEY };
function req(method, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject); r.end();
  });
}
/** Abre WS; devolve {ws, msgs, closed:Promise<code>}. Sem argumentos = host (chave). */
function open(guestToken /* undefined = host */, headers = null, qs = null) {
  const url = `ws://127.0.0.1:${PORT}/ws${qs ?? (guestToken ? `?k=${guestToken}` : `?h=${HOST_KEY}`)}`;
  const ws = new WebSocket(url, { headers: headers || {} });
  const c = { ws, msgs: [], code: null };
  ws.on('message', (d) => c.msgs.push(JSON.parse(d.toString())));
  c.closed = new Promise(r => ws.on('close', (code) => { c.code = code; r(code); }));
  c.opened = new Promise(r => ws.on('open', () => r(true)));
  ws.on('error', () => {});
  return c;
}
const waitMsg = async (c, t, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const m = c.msgs.find(x => x.t === t && !x._seen); if (m) { m._seen = true; return m; } await sleep(30); }
  return null;
};
async function tokenFromHost() {
  await req('POST', '/api/invite/start', HK);
  const j = JSON.parse((await req('GET', '/api/invite', HK)).body);
  return { url: j.url, token: j.url && new URL(j.url).searchParams.get('k') };
}

// aguarda servidor
for (let i = 0; i < 50; i++) { try { await req('GET', '/'); break; } catch { await sleep(100); } }

// ── a. autenticação
let g = open('qualquer', TUNNEL);
check('a0 convidado SEM sessão ativa é rejeitado (4401)', (await g.closed) === 4401);
g = open(undefined, null, '');
check('a00 loopback sem chave e sem k é recusado (4401)', (await g.closed) === 4401 && !g.msgs.some(m => m.t === 'welcome'));
g = open(undefined, null, '?h=chave-errada');
check('a01 chave de anfitrião errada é recusada (4401)', (await g.closed) === 4401 && !g.msgs.some(m => m.t === 'welcome'));
check('a02 recusas não abriram sessão', JSON.parse((await req('GET', '/api/invite', HK)).body).url === undefined);

let host = open();
await host.opened; host.ws.send(JSON.stringify({ t: 'join', name: 'Host', role: 'Gestor' }));
const w1 = await waitMsg(host, 'welcome');
check('host com chave válida entra e recebe welcome isHost=true', w1 && w1.isHost === true);
const sess1 = (await waitMsg(host, 'session'))?.id;

const { url: url1, token: tok1 } = await tokenFromHost();
check('c URL de convite = <túnel>/?k=<token ≥128 bits>', (url1 || '').startsWith(`${TUNNEL_URL}/?k=`) && tok1.length >= 22, `(${tok1?.length} chars b64url)`);

g = open(undefined, TUNNEL, '');
check('a1 convidado SEM token rejeitado (4401)', (await g.closed) === 4401 && !g.msgs.some(m => m.t === 'welcome'));
g = open('errado' + tok1.slice(6), TUNNEL);
check('a2 convidado com token ERRADO rejeitado (4401)', (await g.closed) === 4401);
g = open(tok1, TUNNEL); await g.opened;
g.ws.send(JSON.stringify({ t: 'join', name: 'Guest', role: 'Dev' }));
const gw = await waitMsg(g, 'welcome');
check('a3 convidado com token correto aceito (welcome, isHost=false)', gw && gw.isHost === false);

// ── b. convidado não toca em /api/invite* nem /api/session*
const r = [];
r.push((await req('GET', '/api/invite', TUNNEL)).status);
r.push((await req('POST', '/api/invite/start', TUNNEL)).status);
r.push((await req('POST', '/api/invite/stop', TUNNEL)).status);
r.push((await req('POST', '/api/session/end', TUNNEL)).status);
check('b convidado recebe 403 em /api/invite* e /api/session/end', r.every(s => s === 403), JSON.stringify(r));
const still = JSON.parse((await req('GET', '/api/invite', HK)).body);
check('b2 túnel/sessão intactos após tentativas do convidado', still.status === 'ready');
const noKey = [(await req('GET', '/api/invite')).status, (await req('POST', '/api/invite/stop')).status, (await req('POST', '/api/session/end')).status];
check('d /api/invite* e /api/session* sem X-Host-Key (loopback) → 403', noKey.every(s => s === 403), JSON.stringify(noKey));
const badKey = await req('POST', '/api/invite/stop', { 'x-host-key': 'errada' });
check('b3 X-Host-Key errada → 403', badKey.status === 403);
const hl = (() => { try { return fs.readFileSync(path.join(DATA, 'host-link.txt'), 'utf8').trim(); } catch { return null; } })();
check('b4 host-link.txt = <túnel>/?h=<chave>', hl === `${TUNNEL_URL}/?h=${HOST_KEY}`, `(${hl})`);

// ── c. chat, grace e fim de sessão
host.ws.send(JSON.stringify({ t: 'demanda_add', assunto: 'sobrevive', prioridade: 'alta' }));
host.ws.send(JSON.stringify({ t: 'chat', channel: 'geral', text: 'olá convidado' }));
const chatSeen = await waitMsg(g, 'chat');
check('c1 convidado vê o chat do host', chatSeen && chatSeen.text === 'olá convidado');

host.ws.close(); await host.closed;
await sleep(500);
host = open(); await host.opened; // reconecta dentro do grace (com a chave)
await sleep(GRACE + 600);
check('c2 reconexão do host DENTRO do grace não encerra a sessão', g.ws.readyState === WebSocket.OPEN && !g.msgs.some(m => m.t === 'session_end'));

host.ws.close(); await host.closed;
const t0 = Date.now();
const end = await waitMsg(g, 'session_end', GRACE + 3000);
const code = await Promise.race([g.closed, sleep(2000).then(() => null)]);
check('c3 host some > grace: convidado recebe session_end e socket fecha (4400)', !!end && code === 4400, `(após ${Date.now() - t0}ms)`);

// ── d. depois do fim
g = open(tok1, TUNNEL);
check('d1 token antigo rejeitado após o fim (4401)', (await g.closed) === 4401);
const inv = JSON.parse((await req('GET', '/api/invite', HK)).body);
check('e túnel continua ready após o fim da sessão (sem url de convite)', inv.status === 'ready' && !inv.url);
host = open(); await host.opened; host.ws.send(JSON.stringify({ t: 'join', name: 'Host', role: 'Gestor' }));
const w2 = await waitMsg(host, 'welcome');
const sess2 = (await waitMsg(host, 'session'))?.id;
check('d3 novo host: chat vazio', w2 && w2.state.chat.geral.length === 0 && Object.keys(w2.state.chat.dm).length === 0);
const { token: tok2 } = await tokenFromHost();
check('d4 novo token diferente do anterior', tok2 && tok2 !== tok1);
check('d4b id público de sessão mudou', sess1 && sess2 && sess1 !== sess2);
g = open(tok1, TUNNEL); const oldStill = await g.closed;
check('d5 token antigo continua rejeitado na sessão nova', oldStill === 4401);
g = open(tok2, TUNNEL); await g.opened;
check('d6 token novo aceito', await waitMsg(g, 'session') !== null);

// ── demandas
check('e2 demanda criada na sessão 1 sobreviveu ao fim', (w2.state.demandas || []).some(d => d.assunto === 'sobrevive'));

// ── fim explícito pelo host
// ── f. parar de compartilhar gira o token (quem já está conectado permanece)
const g2 = open(tok2, TUNNEL); await g2.opened;
const stop = await req('POST', '/api/invite/stop', HK);
const afterStop = JSON.parse((await req('GET', '/api/invite', HK)).body);
const tok3 = afterStop.url && new URL(afterStop.url).searchParams.get('k');
check('f1 /api/invite/stop devolve 200, túnel segue ready e token girou', stop.status === 200 && afterStop.status === 'ready' && tok3 && tok3 !== tok2);
const gOld = open(tok2, TUNNEL);
check('f2 k antigo recusado após girar (4401)', (await gOld.closed) === 4401);
check('f3 quem já estava conectado permanece', g.ws.readyState === WebSocket.OPEN && g2.ws.readyState === WebSocket.OPEN);
const gNew = open(tok3, TUNNEL); await gNew.opened;
check('f4 k novo aceito', await waitMsg(gNew, 'session') !== null);

// ── fim explícito pelo host
const ex = await req('POST', '/api/session/end', HK);
const exMsg = await waitMsg(g, 'session_end');
check('g POST /api/session/end (host) derruba convidados', ex.status === 200 && !!exMsg);

cleanup();
console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(fails ? 1 : 0);
