#!/usr/bin/env node
/**
 * rtc-e2e.mjs — teste E2E real de vídeo/tela WebRTC com dois Chromes (CDP).
 *
 * Uso:  node tools/rtc-e2e.mjs            (usa porta 8181, copia a árvore p/ scratch)
 * Env:  RTC_SCRATCH=<dir>  (padrão /tmp/rtc-e2e)   RTC_PORT=8181
 * Sem deps novas (Node 24: WebSocket global). Nunca toca a instância real (8080).
 */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = process.env.RTC_SCRATCH || '/tmp/rtc-e2e';
const PORT = Number(process.env.RTC_PORT || 8181);
const APP = path.join(SCRATCH, 'app');
const HOST_KEY = 'rtc-e2e-host-key';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const killAll = () => { for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} } };
process.on('exit', killAll);
setTimeout(() => { console.error('TIMEOUT global'); killAll(); process.exit(2); }, Number(process.env.RTC_TIMEOUT_MS || 420000)).unref();

// ── Copia da árvore + servidor descartável ──
mkdirSync(APP, { recursive: true });
execSync(`rsync -a --delete --exclude .git --exclude data "${ROOT}/" "${APP}/"`);
mkdirSync(path.join(APP, 'data'), { recursive: true });
let srv = readFileSync(path.join(APP, 'server.js'), 'utf8');
srv = srv.replace(/listen\(8080/, `listen(${PORT}`).replace(/localhost:8080/g, `localhost:${PORT}`);
// RTC_DELAY=<ms>: atrasa o relay de sinalização na CÓPIA (simula RTT de túnel; ordem preservada).
const DELAY = Number(process.env.RTC_DELAY || 0);
if (DELAY) srv = srv.replace("send(target.ws, { t: 'rtc_signal', from: playerId, data: msg.data });",
  `{ const _m = { t: 'rtc_signal', from: playerId, data: msg.data }; setTimeout(() => send(target.ws, _m), ${DELAY}); }`);
writeFileSync(path.join(APP, 'server.js'), srv);
function start(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts });
  procs.push(p); return p;
}
// Anfitrião = quem apresenta HOST_KEY (?h=). Sem RTC_TUNNEL, o túnel é simulado (TEST_TUNNEL_URL).
const srvEnv = { ...process.env, PORT: String(PORT), HOST_KEY };
if (!process.env.RTC_TUNNEL) srvEnv.TEST_TUNNEL_URL = 'https://fake-test.trycloudflare.com';
start('node', ['server.js'], { cwd: APP, env: srvEnv });

async function waitHttp(url, n = 60) {
  for (let i = 0; i < n; i++) { try { const r = await fetch(url); if (r.ok) return; } catch {} await sleep(250); }
  throw new Error('sem resposta: ' + url);
}
await waitHttp(`http://127.0.0.1:${PORT}/`);

// ── Chromes ──
async function launchChrome(port) {
  start('google-chrome', [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${SCRATCH}/prof-${port}`,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-sandbox',
    '--window-size=1280,800', 'about:blank',
  ]);
  await waitHttp(`http://127.0.0.1:${port}/json/version`, 80);
}
class Page {
  constructor(port, tag) { this.port = port; this.tag = tag; this.id = 0; this.cb = new Map(); this.logs = []; }
  async open() {
    const list = await (await fetch(`http://127.0.0.1:${this.port}/json`)).json();
    const t = list.find((x) => x.type === 'page');
    this.ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => this.ws.addEventListener('open', r));
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.cb.has(m.id)) { this.cb.get(m.id)(m); this.cb.delete(m.id); }
      else if (m.method === 'Runtime.consoleAPICalled') {
        this.logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });
    await this.send('Runtime.enable'); await this.send('Page.enable');
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => { this.cb.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
    return r.result.result.value;
  }
  async goto(url) {
    await this.send('Page.navigate', { url }); await sleep(1500);
    if (url.startsWith('http')) for (let i = 0; i < 30; i++) {
      try { if (await this.eval(`!!document.querySelector('#media-dock [data-media="cam"]')`)) return; } catch {}
      await sleep(500);
    }
  }
}
const A = new Page(9331, 'A'), B = new Page(9332, 'B');
await launchChrome(9331); await launchChrome(9332); await launchChrome(9333);
console.log('chromes ok'); await A.open(); await B.open();
const C = new Page(9333, 'C'); await C.open();

// RTC_TUNNEL=1: B entra como CONVIDADO pelo túnel cloudflared real (A segue como host em 127.0.0.1, com ?h=).
// Sem RTC_TUNNEL todos entram em 127.0.0.1 com a chave de anfitrião (como antes, em que todo loopback era host).
let tunnelBase = null;
if (process.env.RTC_TUNNEL) {
  const HK = { 'X-Host-Key': HOST_KEY };
  await A.goto(`http://127.0.0.1:${PORT}/?h=${HOST_KEY}&name=Host&role=Dev`); await sleep(2000);
  await fetch(`http://127.0.0.1:${PORT}/api/invite/start`, { method: 'POST', headers: HK });
  for (let i = 0; i < 60 && !tunnelBase; i++) {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/api/invite`, { headers: HK })).json();
    if (j.url) tunnelBase = j.url; else await sleep(1000);
  }
  if (!tunnelBase) { console.error('túnel não subiu'); killAll(); process.exit(3); }
  for (let i = 0; i < 60; i++) { try { const r = await fetch(tunnelBase); if (r.ok) break; } catch {} await sleep(1000); }
  console.log('túnel:', tunnelBase.replace(/\?k=.*/, '?k=***'));
}
const url = (n, guest) => (guest && tunnelBase)
  ? `${tunnelBase}&name=${n}&role=Dev`
  : `http://127.0.0.1:${PORT}/?h=${HOST_KEY}&name=${n}&role=Dev`;
const click = (kind) => `document.querySelector('#media-dock [data-media="${kind}"]').click()`;
// Mede se existe <video> remoto com frames avançando.
const probe = `(async () => {
  const vs = [...document.querySelectorAll('.video-tile:not(.self) video')];
  const out = [];
  for (const v of vs) {
    const f0 = v.getVideoPlaybackQuality().totalVideoFrames;
    await new Promise(r => setTimeout(r, 1200));
    const f1 = v.getVideoPlaybackQuality().totalVideoFrames;
    out.push({ w: v.videoWidth, h: v.videoHeight, frames: f1 - f0, paused: v.paused,
               tile: v.parentElement.className, status: !!v.parentElement.querySelector('.video-status') });
  }
  return out;
})()`;
async function waitConn(P, n = 40) {
  for (let i = 0; i < n; i++) {
    const s = await P.eval('JSON.stringify(window.rtcPeers ? window.rtcPeers() : [])');
    const a = JSON.parse(s);
    if (a.length && a.every((p) => p.conn === 'connected')) return a;
    await sleep(500);
  }
  return JSON.parse(await P.eval('JSON.stringify(window.rtcPeers ? window.rtcPeers() : [])'));
}
async function expectVideo(P, label, kindClass) {
  for (let i = 0; i < 12; i++) {
    const r = JSON.parse(await P.eval(`${probe}.then(JSON.stringify)`));
    const ok = r.find((x) => x.w > 0 && x.frames > 0 && (!kindClass || x.tile.includes(kindClass)));
    if (ok) return { pass: true, info: ok };
    if (i === 11) return { pass: false, info: r };
  }
}
const results = [];
function rec(name, r) {
  results.push({ name, ...r });
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(r.info)}`);
}
async function fresh(order = 'both') {
  await A.goto('about:blank'); await B.goto('about:blank'); await sleep(500);
  if (order === 'both') { await A.goto(url('Alice' + Date.now() % 1000)); await B.goto(url('Bob' + Date.now() % 1000, true)); }
  await sleep(2500);
}

// Cenário 1: câmera DEPOIS do áudio estabelecido (bidirecional)
await fresh();
await A.eval(click('mic')); await B.eval(click('mic'));
console.log('conn A', JSON.stringify(await waitConn(A)), 'conn B', JSON.stringify(await waitConn(B)));
await A.eval(click('cam')); await sleep(1500);
rec('1a cam A->B (após áudio)', await expectVideo(B, 'B'));
await B.eval(click('cam')); await sleep(1500);
rec('1b cam B->A (após áudio)', await expectVideo(A, 'A'));

// Cenário 2: glare — ambos ligam câmera quase simultâneo
await fresh();
await A.eval(click('mic')); await B.eval(click('mic')); await waitConn(A); await waitConn(B);
await Promise.all([A.eval(click('cam')), B.eval(click('cam'))]); await sleep(2000);
rec('2a glare cam -> B vê A', await expectVideo(B, 'B'));
rec('2b glare cam -> A vê B', await expectVideo(A, 'A'));

// Cenário 3: câmera ligada ANTES do peer existir (A entra, liga cam; B entra depois)
await A.goto('about:blank'); await B.goto('about:blank'); await sleep(500);
await A.goto(url('Ana' + Date.now() % 1000)); await sleep(2500);
await A.eval(click('cam')); await sleep(1000);
await B.goto(url('Beto' + Date.now() % 1000, true)); await sleep(3000);
rec('3a cam A antes de B entrar -> B vê A', await expectVideo(B, 'B'));

// Cenário 4: só câmera, sem mic (sem áudio prévio)
await fresh();
await A.eval(click('cam')); await sleep(3000);
rec('4a só cam A (sem mic) -> B vê A', await expectVideo(B, 'B'));

// Cenário 6: liga/desliga/liga câmera (reuso de transceiver) + guest só ouvinte
await fresh();
await A.eval(click('mic')); await waitConn(A); await waitConn(B);   // B sem mic (só ouve)
await A.eval(click('cam')); await sleep(1500);
rec('6a cam A -> B (B só ouvinte)', await expectVideo(B, 'B'));
await A.eval(click('cam')); await sleep(1500);
const gone = await B.eval(`document.querySelectorAll('.video-tile:not(.self)').length`);
rec('6b desligar cam remove tile em B', { pass: gone === 0, info: { tiles: gone } });
await A.eval(click('cam')); await sleep(2000);
rec('6c religar cam A -> B', await expectVideo(B, 'B'));
await B.eval(click('cam')); await sleep(2000);
rec('6d cam B -> A (B ligou depois)', await expectVideo(A, 'A'));

// Cenário 7: afastar (teardown da conexão), voltar (reconexão) e só então ligar a câmera
async function hold(P, key, ms) {
  const ev = (type) => P.send('Input.dispatchKeyEvent', { type, key, text: key, code: 'Key' + key.toUpperCase() });
  await ev('keyDown'); await sleep(ms); await ev('keyUp');
}
const npeers = async (P) => JSON.parse(await P.eval('JSON.stringify(window.rtcPeers())')).length;
await fresh();
await A.eval(click('mic')); await B.eval(click('mic')); await waitConn(A); await waitConn(B);
let apart = 'nunca';
for (let i = 0; i < 25; i++) {
  await hold(B, 'd', 700);
  if ((await npeers(B)) === 0 && (await npeers(A)) === 0) { apart = `ok(${i})`; break; }
}
// pequena folga e volta
let back = 'nunca';
for (let i = 0; i < 40; i++) {
  await hold(B, 'a', 700);
  const pa = JSON.parse(await A.eval('JSON.stringify(window.rtcPeers())')), pb = JSON.parse(await B.eval('JSON.stringify(window.rtcPeers())'));
  if (pa.length && pb.length && pa[0].conn === 'connected' && pb[0].conn === 'connected') { back = `ok(${i})`; break; }
}
await sleep(2000);
console.log('7: afastou:', apart, '| voltou:', back, '| peers A/B', await npeers(A), await npeers(B));
await A.eval(click('cam')); await sleep(1500);
rec('7a cam A -> B após afastar e voltar', await expectVideo(B, 'B'));
await B.eval(click('cam')); await sleep(1500);
rec('7b cam B -> A após afastar e voltar', await expectVideo(A, 'A'));

// Cenário 8: malha com 3 participantes (A, B, C) — câmera em ordens variadas
await A.goto('about:blank'); await B.goto('about:blank'); await C.goto('about:blank'); await sleep(500);
await A.goto(url('Ada' + Date.now() % 1000)); await B.goto(url('Bia' + Date.now() % 1000, true)); await C.goto(url('Cai' + Date.now() % 1000, true));
await sleep(2500);
for (const P of [A, B, C]) await P.eval(click('mic'));
for (const P of [A, B, C]) await P.eval('new Promise(r=>setTimeout(r,1500))');
const peersOf = async (P) => JSON.parse(await P.eval('JSON.stringify(window.rtcPeers())'));
console.log('8: peers A/B/C', (await peersOf(A)).length, (await peersOf(B)).length, (await peersOf(C)).length);
await A.eval(click('cam')); await sleep(2500);
const cnt = async (P) => JSON.parse(await P.eval(`${probe}.then(JSON.stringify)`)).filter((x) => x.w > 0 && x.frames > 0).length;
rec('8a cam A -> B e C veem (1 tile cada)', { pass: (await cnt(B)) === 1 && (await cnt(C)) === 1, info: { B: await cnt(B), C: await cnt(C) } });
await C.eval(click('cam')); await B.eval(click('cam')); await sleep(3000);
rec('8b cam B e C -> cada um vê 2 tiles remotos', { pass: (await cnt(A)) === 2 && (await cnt(B)) === 2 && (await cnt(C)) === 2, info: { A: await cnt(A), B: await cnt(B), C: await cnt(C) } });

console.log('rtcStats A:', await A.eval('window.rtcStats().then(JSON.stringify)'));

// Cenário 9: botão "Diagnóstico de vídeo" (A, B e C estão com câmera ligada)
async function diag(P, label, blockClipboard) {
  await P.eval(`document.getElementById('rtc-diag-modal')?.remove();
    ${blockClipboard ? "navigator.clipboard.writeText = () => Promise.reject(new Error('bloqueado'));" : ''}
    document.getElementById('rtc-diag-btn').click()`);
  for (let i = 0; i < 30; i++) {
    if (await P.eval(`!!document.querySelector('#rtc-diag-modal textarea')`)) break;
    await sleep(500);
  }
  return JSON.parse(await P.eval(`JSON.stringify({ text: document.querySelector('#rtc-diag-modal textarea')?.value || '',
    note: document.querySelector('#rtc-diag-modal .invite-modal-box > div:nth-child(2)')?.textContent || '',
    sel: (() => { const t = document.querySelector('#rtc-diag-modal textarea'); return t ? t.selectionEnd - t.selectionStart : 0; })(),
    btns: [...document.querySelectorAll('#rtc-diag-modal button')].map(b => b.textContent) })`));
}
for (const [P, n] of [[A, 'A'], [B, 'B']]) {
  const d = await diag(P, false);
  const inV = /in video: pacotes=[1-9]\d*\(\+[1-9]\d*\/3s\).*AVANÇANDO/.test(d.text);
  const outV = /out video: pacotes=[1-9]\d*\(\+[1-9]\d*\/3s\).*AVANÇANDO/.test(d.text);
  rec(`9a diagnóstico ${n}: contadores de vídeo in/out avançando + tiles + UA`, { pass: inV && outV && /videoWidth=[1-9]/.test(d.text) && d.text.includes('Chrome'), info: { inV, outV, len: d.text.length } });
  if (n === 'A') console.log(d.text);
}
const dfb = await diag(A, 'A', true);
rec('9b fallback: modal com textarea pré-selecionado + Copiar/Fechar quando clipboard falha',
  { pass: dfb.text.length > 200 && dfb.sel === dfb.text.length && dfb.btns.join() === 'Copiar,Fechar' && !dfb.note.includes('COPIADO'), info: { sel: dfb.sel, len: dfb.text.length, btns: dfb.btns, note: dfb.note } });

// Cenário 5: tela compartilhada depois do áudio
await fresh();
await A.eval(click('mic')); await B.eval(click('mic')); await waitConn(A); await waitConn(B);
let scr = 'ok';
try { await A.eval(click('screen')); await sleep(2500); } catch (e) { scr = String(e); }
const aScreen = await A.eval(`!!document.querySelector('.video-tile.self.screen')`);
if (!aScreen) rec('5a tela A->B', { pass: false, info: 'getDisplayMedia indisponível em headless (sem self-tile): ' + scr });
else rec('5a tela A->B (após áudio)', await expectVideo(B, 'B', 'screen'));

console.log('\nRESUMO:', results.filter((r) => r.pass).length + '/' + results.length, 'PASS');
console.log('--- logs RTC de B (últimos) ---');
console.log(B.logs.filter((l) => l.includes('[rtc]')).slice(-25).join('\n'));
killAll();
process.exit(results.every((r) => r.pass) ? 0 : 1);
