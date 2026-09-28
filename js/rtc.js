/**
 * rtc.js — Áudio/vídeo/tela espacial por proximidade (WebRTC mesh).
 *
 * Cada par de pessoas mantém UMA RTCPeerConnection P2P. A sinalização
 * (offer/answer/ICE) viaja pelo WebSocket existente (net.sendSignal / net.onSignal),
 * relayada de forma direcionada pelo servidor.
 *
 * Regras (definidas pelo chamador em main.js via updateAudibility):
 *   - Mesma sala  → volume cheio.
 *   - Bolha de proximidade → volume com falloff gradual (js/spatial.js).
 *   - Fora da bolha → conexão derrubada após uma carência (privacidade real).
 *
 * O volume espacial é aplicado por um GainNode do WebAudio por peer, ajustado
 * a cada frame. Vídeo e tela aparecem como tiles em #video-strip.
 */

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // TURN (relay) — ESSENCIAL para pessoas em redes diferentes (NAT). Sem isto,
    // o P2P direto falha entre a maioria dos usuários remotos (só STUN não basta).
    // Usando o TURN público gratuito Open Relay (Metered) — bom para começar/testar.
    // Para produção confiável, troque por um TURN dedicado (Metered com API key,
    // Twilio, ou coturn num VPS). As portas 443/tcp ajudam a furar firewalls.
    { urls: 'turn:openrelay.metered.ca:80',                 username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',                username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp',  username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

/** Carência antes de derrubar a conexão de um peer que saiu da bolha. */
const TEARDOWN_GRACE_MS = 4000;

export class RtcManager {
  /**
   * @param {object} opts
   * @param {import('./net.js').Net} opts.net
   * @param {Map<string, {name:string, role:string}>} opts.remotePlayers — para rótulos
   * @param {HTMLElement} opts.videoStrip — container dos tiles
   * @param {() => string} [opts.selfLabel] — rótulo do tile local
   * @param {(kind:'mic'|'cam'|'screen', active:boolean, denied?:boolean) => void} [opts.onStateChange]
   */
  constructor({ net, remotePlayers, videoStrip, selfLabel, onStateChange }) {
    this.net = net;
    this.remotePlayers = remotePlayers;
    this.videoStrip = videoStrip;
    this.selfLabel = selfLabel || (() => 'Você');
    this.onStateChange = onStateChange || (() => {});

    /** @type {Map<string, PeerState>} */
    this.peers = new Map();

    /** Tracks locais ativas por tipo (null = desligado). */
    this.local = { mic: null, cam: null, screen: null };
    this._localStreams = { mic: null, cam: null, screen: null };

    /** Tiles de auto-visualização (câmera/tela própria). */
    this._selfTiles = { cam: null, screen: null };

    /** @type {AudioContext|null} */
    this.audioCtx = null;

    /** Z-index incremental para trazer tiles arrastados para a frente. */
    this._tileZ = 200;
    /** Contador para escalonar a posição inicial de novos tiles. */
    this._tileSpawnN = 0;

    // Autoplay policy: cria/retoma o AudioContext em QUALQUER gesto do usuário.
    // Sem isso, quem só ESCUTA (não ligou o mic) fica com o contexto suspenso e
    // não ouve os outros (o áudio remoto toca via WebAudio, com o <audio> mudo).
    const _resumeAudio = () => { try { this._ensureAudioCtx(); } catch { /* noop */ } };
    document.addEventListener('pointerdown', _resumeAudio, { passive: true });
    document.addEventListener('keydown', _resumeAudio, { passive: true });

    // Diagnóstico: digite rtcPeers() no console para ver o estado de cada conexão.
    try {
      window.rtcPeers = () => [...this.peers.entries()].map(([id, p]) => ({
        id,
        conn: p.pc.connectionState,
        ice: p.pc.iceConnectionState,
        gain: Number(p.gainTarget.toFixed(2)),
        senders: Object.entries(p.senders).filter(([, s]) => s).map(([k]) => k).join(',') || '(nenhum)',
      }));
      window.rtcAudioCtx = () => this.audioCtx && this.audioCtx.state;
    } catch { /* noop */ }
  }

  /** ID do jogador local (só existe após o welcome). */
  get selfId() { return this.net.youId; }

  // ── AudioContext (lazy; resume exige gesto do usuário) ──────────────────────

  _ensureAudioCtx() {
    if (!this.audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new Ctx();
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    return this.audioCtx;
  }

  // ── Ciclo de vida das conexões ──────────────────────────────────────────────

  /** Cria (se preciso) a conexão com um peer e devolve seu estado. */
  ensurePeer(id) {
    if (id === this.selfId) return null;
    let peer = this.peers.get(id);
    if (peer) return peer;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    // Perfect negotiation: papel determinístico por comparação de IDs.
    const polite = String(this.selfId) > String(id);

    peer = {
      id, pc, polite,
      makingOffer: false,
      ignoreOffer: false,
      senders: { mic: null, cam: null, screen: null },
      audio: null,           // { source, gain, el }
      gainTarget: 0,
      tiles: new Map(),      // mid -> { wrap, video, kind }
      metaByMid: {},         // mid -> 'cam' | 'screen'
      _teardown: null,
    };
    this.peers.set(id, peer);
    console.log(`[rtc] ▶ NOVA conexão com ${id} (polite=${polite})`);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        console.log(`[rtc] → enviando OFFER/negociação para ${id}`);
        this.net.sendSignal(id, { description: pc.localDescription });
      } catch (err) {
        console.error('[rtc] negotiationneeded falhou:', err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        // candidate.type: host (local) | srflx (STUN) | relay (TURN funcionando!)
        console.log(`[rtc] ICE local ${id}: ${candidate.type}/${candidate.protocol}`);
        this.net.sendSignal(id, { candidate });
      }
    };

    pc.onsignalingstatechange = () => {
      if (pc.signalingState === 'stable') this._sendMeta(peer);
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[rtc] iceConnectionState ${id}: ${pc.iceConnectionState}`);
    };

    pc.onconnectionstatechange = () => {
      console.log(`[rtc] connectionState ${id}: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        console.warn(`[rtc] ✖ conexão com ${id} FALHOU (provável NAT sem TURN válido)`);
        try { pc.restartIce(); } catch { /* noop */ }
      }
    };

    pc.ontrack = (ev) => this._onTrack(peer, ev);

    // Envia nossas tracks locais ativas para este peer (dispara negociação).
    this._syncSenders(peer);
    return peer;
  }

  /** Encerra a conexão com um peer e limpa mídia associada. */
  closePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    if (peer._teardown) { clearTimeout(peer._teardown); peer._teardown = null; }
    try { peer.pc.close(); } catch { /* noop */ }
    if (peer.audio) {
      try { peer.audio.source.disconnect(); } catch { /* noop */ }
      if (peer.audio.el) peer.audio.el.remove();
    }
    for (const tile of peer.tiles.values()) tile.wrap.remove();
    this.peers.delete(id);
  }

  /** Encerra tudo (ex.: logout). */
  closeAll() {
    for (const id of [...this.peers.keys()]) this.closePeer(id);
  }

  // ── Sinalização recebida ────────────────────────────────────────────────────

  /** Handler para net.onSignal. */
  async handleSignal(from, data) {
    if (!data) return;

    // Peer avisou que parou um vídeo/tela (mid): remove o tile correspondente.
    if (data.mediaOff != null) {
      const peer = this.peers.get(from);
      const tile = peer && peer.tiles.get(data.mediaOff);
      if (tile) { tile.wrap.remove(); peer.tiles.delete(data.mediaOff); }
      return;
    }

    // Metadados de tipo de vídeo (cam vs tela) — não exige conexão prévia.
    if (data.meta) {
      const peer = this.peers.get(from);
      if (peer) {
        Object.assign(peer.metaByMid, data.meta);
        // Re-rotula tiles já criados cujo mid agora tem tipo conhecido.
        for (const [mid, tile] of peer.tiles) {
          const kind = peer.metaByMid[mid];
          if (kind && kind !== tile.kind) this._relabelTile(peer, mid, kind);
        }
      }
      return;
    }

    const peer = this.ensurePeer(from);
    if (!peer) return;
    const pc = peer.pc;

    try {
      if (data.description) {
        const desc = data.description;
        const offerCollision =
          desc.type === 'offer' &&
          (peer.makingOffer || pc.signalingState !== 'stable');

        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        await pc.setRemoteDescription(desc); // rollback implícito se colidir (polite)
        if (desc.type === 'offer') {
          await pc.setLocalDescription();
          this.net.sendSignal(from, { description: pc.localDescription });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!peer.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.error('[rtc] handleSignal falhou:', err);
    }
  }

  // ── Audibilidade (chamado a cada frame pelo main.js) ────────────────────────

  /**
   * @param {Map<string, number>} gainById — ganho 0..1 desejado por peer.
   *   Peers com ganho > 0 são conectados; ausentes/0 são derrubados após carência.
   */
  updateAudibility(gainById) {
    // Peers desejados agora.
    for (const [id, g] of gainById) {
      if (g <= 0 || id === this.selfId) continue;
      const peer = this.ensurePeer(id);
      if (!peer) continue;
      peer.gainTarget = g;
      if (peer.audio) peer.audio.gain.gain.value = g;
      if (peer._teardown) { clearTimeout(peer._teardown); peer._teardown = null; }
    }
    // Peers conectados que saíram da bolha → silencia e agenda teardown.
    for (const [id, peer] of this.peers) {
      const g = gainById.get(id) || 0;
      if (g > 0) continue;
      peer.gainTarget = 0;
      if (peer.audio) peer.audio.gain.gain.value = 0;
      if (!peer._teardown) {
        peer._teardown = setTimeout(() => this.closePeer(id), TEARDOWN_GRACE_MS);
      }
    }
  }

  // ── Toggles de mídia local ──────────────────────────────────────────────────

  async toggleMic() {
    if (this.local.mic) { this._stopKind('mic'); this.onStateChange('mic', false); return; }
    try {
      this._ensureAudioCtx();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this._localStreams.mic = stream;
      this.local.mic = stream.getAudioTracks()[0];
      this.local.mic.onended = () => { this._stopKind('mic'); this.onStateChange('mic', false); };
      this._syncAllSenders();
      this.onStateChange('mic', true);
    } catch (err) {
      console.error('[rtc] getUserMedia(mic) falhou:', err);
      this.onStateChange('mic', false, true, err && err.name);
    }
  }

  async toggleCam() {
    if (this.local.cam) { this._stopKind('cam'); this.onStateChange('cam', false); return; }
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
      } catch (e) {
        // Constraints muito restritas para a câmera → tenta sem restrição.
        if (e && e.name === 'OverconstrainedError') {
          stream = await navigator.mediaDevices.getUserMedia({ video: true });
        } else { throw e; }
      }
      this._localStreams.cam = stream;
      this.local.cam = stream.getVideoTracks()[0];
      this.local.cam.onended = () => { this._stopKind('cam'); this.onStateChange('cam', false); };
      this._syncAllSenders();
      this._updateSelfTile('cam');
      this.onStateChange('cam', true);
    } catch (err) {
      console.error('[rtc] getUserMedia(cam) falhou:', err);
      this.onStateChange('cam', false, true, err && err.name);
    }
  }

  async toggleScreen() {
    if (this.local.screen) { this._stopKind('screen'); this.onStateChange('screen', false); return; }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      this._localStreams.screen = stream;
      this.local.screen = stream.getVideoTracks()[0];
      // Se o usuário parar pela UI nativa do browser, reflete no nosso estado.
      this.local.screen.onended = () => { this._stopKind('screen'); this.onStateChange('screen', false); };
      this._syncAllSenders();
      this._updateSelfTile('screen');
      this.onStateChange('screen', true);
    } catch (err) {
      console.error('[rtc] getDisplayMedia falhou:', err);
      this.onStateChange('screen', false, true, err && err.name);
    }
  }

  _stopKind(kind) {
    const track = this.local[kind];
    if (track) { try { track.stop(); } catch { /* noop */ } }
    this.local[kind] = null;
    const stream = this._localStreams[kind];
    if (stream) { for (const t of stream.getTracks()) { try { t.stop(); } catch { /* noop */ } } }
    this._localStreams[kind] = null;
    if (kind !== 'mic') this._removeSelfTile(kind);

    // Avisa cada peer para remover o tile correspondente ANTES de remover o
    // sender: removeTrack não dispara 'ended' de forma confiável no lado remoto,
    // então o vídeo/tela ficaria "preso" na tela do outro. Enviamos o mid.
    if (kind !== 'mic') {
      for (const peer of this.peers.values()) {
        const sender = peer.senders[kind];
        if (!sender) continue;
        const tr = peer.pc.getTransceivers().find((x) => x.sender === sender);
        if (tr && tr.mid != null) this.net.sendSignal(peer.id, { mediaOff: tr.mid });
      }
    }

    this._syncAllSenders();
  }

  // ── Sincronização de senders (add/replace/remove tracks por peer) ───────────

  _syncAllSenders() {
    for (const peer of this.peers.values()) this._syncSenders(peer);
  }

  _syncSenders(peer) {
    const pc = peer.pc;
    for (const kind of ['mic', 'cam', 'screen']) {
      const track = this.local[kind];
      const sender = peer.senders[kind];
      if (track && !sender) {
        peer.senders[kind] = pc.addTrack(track, this._localStreams[kind]);
      } else if (track && sender && sender.track !== track) {
        sender.replaceTrack(track);
      } else if (!track && sender) {
        try { pc.removeTrack(sender); } catch { /* noop */ }
        peer.senders[kind] = null;
      }
    }
  }

  /** Envia o mapa mid→tipo dos nossos vídeos para o peer distinguir cam/tela. */
  _sendMeta(peer) {
    const map = {};
    for (const kind of ['cam', 'screen']) {
      const sender = peer.senders[kind];
      if (!sender) continue;
      const t = peer.pc.getTransceivers().find((x) => x.sender === sender);
      if (t && t.mid != null) map[t.mid] = kind;
    }
    if (Object.keys(map).length) this.net.sendSignal(peer.id, { meta: map });
  }

  // ── Tracks remotas recebidas ────────────────────────────────────────────────

  _onTrack(peer, ev) {
    const track = ev.track;
    const stream = ev.streams[0] || new MediaStream([track]);
    const mid = ev.transceiver && ev.transceiver.mid;

    if (track.kind === 'audio') {
      this._setupRemoteAudio(peer, stream);
    } else {
      this._addVideoTile(peer, stream, track, mid);
    }
  }

  _setupRemoteAudio(peer, stream) {
    const ctx = this._ensureAudioCtx();
    // Workaround Chrome: a MediaStream WebRTC precisa estar presa a um elemento
    // <audio> (mudo) para o WebAudio conseguir puxar o áudio.
    const el = document.createElement('audio');
    el.srcObject = stream;
    el.muted = true;
    el.autoplay = true;
    el.style.display = 'none';
    document.body.appendChild(el);

    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = peer.gainTarget || 0;
    source.connect(gain).connect(ctx.destination);
    peer.audio = { source, gain, el };
  }

  _peerName(peer) {
    const p = this.remotePlayers.get(peer.id);
    return p ? p.name : peer.id;
  }

  _addVideoTile(peer, stream, track, mid) {
    const kind = (mid != null && peer.metaByMid[mid]) || 'cam';
    const key = mid != null ? mid : `t-${track.id}`;

    // Se já existe tile para este mid, atualiza o stream.
    let tile = peer.tiles.get(key);
    if (!tile) {
      const wrap = document.createElement('div');
      wrap.className = `video-tile ${kind === 'screen' ? 'screen' : ''}`;
      const video = document.createElement('video');
      video.autoplay = true; video.playsInline = true; video.muted = true;
      const label = document.createElement('div');
      label.className = 'video-label';
      wrap.appendChild(video);
      wrap.appendChild(label);
      this.videoStrip.appendChild(wrap);
      this._makeTileInteractive(wrap, kind);
      tile = { wrap, video, label, kind };
      peer.tiles.set(key, tile);
    }
    tile.video.srcObject = stream;
    this._relabelTile(peer, key, kind);

    track.onended = () => {
      tile.wrap.remove();
      peer.tiles.delete(key);
    };
  }

  _relabelTile(peer, key, kind) {
    const tile = peer.tiles.get(key);
    if (!tile) return;
    tile.kind = kind;
    tile.wrap.className = `video-tile ${kind === 'screen' ? 'screen' : ''}`;
    tile.label.textContent = `${this._peerName(peer)}${kind === 'screen' ? ' · tela' : ''}`;
  }

  // ── Tiles de auto-visualização ──────────────────────────────────────────────

  _updateSelfTile(kind) {
    const stream = this._localStreams[kind];
    if (!stream) return;
    let tile = this._selfTiles[kind];
    if (!tile) {
      const wrap = document.createElement('div');
      wrap.className = `video-tile self ${kind === 'screen' ? 'screen' : ''}`;
      const video = document.createElement('video');
      video.autoplay = true; video.playsInline = true; video.muted = true;
      const label = document.createElement('div');
      label.className = 'video-label';
      label.textContent = `${this.selfLabel()} · você${kind === 'screen' ? ' (tela)' : ''}`;
      wrap.appendChild(video);
      wrap.appendChild(label);
      this.videoStrip.appendChild(wrap);
      this._makeTileInteractive(wrap, kind);
      tile = { wrap, video };
      this._selfTiles[kind] = tile;
    }
    tile.video.srcObject = stream;
  }

  _removeSelfTile(kind) {
    const tile = this._selfTiles[kind];
    if (tile) { tile.wrap.remove(); this._selfTiles[kind] = null; }
  }

  // ── Tiles flutuantes: arrastar, redimensionar e maximizar ───────────────────

  /** Injeta (uma vez) os estilos dos tiles flutuantes/alças. */
  _ensureTileStyles() {
    if (document.getElementById('rtc-tile-styles')) return;
    const st = document.createElement('style');
    st.id = 'rtc-tile-styles';
    st.textContent = `
      .video-tile.floating { position: fixed; margin: 0; cursor: grab; touch-action: none; }
      .video-tile.floating:active { cursor: grabbing; }
      .video-tile .tile-bar {
        position: absolute; top: 0; left: 0; right: 0; height: 22px; z-index: 2;
        display: flex; align-items: center; justify-content: flex-end; gap: 4px;
        padding: 2px 4px; cursor: grab;
        background: linear-gradient(rgba(0,0,0,0.6), transparent);
        opacity: 0; transition: opacity 0.15s;
      }
      .video-tile.floating:hover .tile-bar { opacity: 1; }
      .video-tile .tile-btn {
        min-width: 18px; height: 18px; line-height: 16px; text-align: center;
        font-size: 12px; color: #fff; background: rgba(255,255,255,0.18);
        border-radius: 4px; cursor: pointer; user-select: none;
      }
      .video-tile .tile-btn:hover { background: rgba(255,255,255,0.4); }
      .video-tile .tile-resize {
        position: absolute; right: 0; bottom: 0; width: 20px; height: 20px;
        cursor: nwse-resize; z-index: 3; touch-action: none;
        background: linear-gradient(135deg, transparent 45%, rgba(255,255,255,0.55) 45%, rgba(255,255,255,0.55) 60%, transparent 60%);
      }
    `;
    document.head.appendChild(st);
  }

  /**
   * Torna um tile de vídeo/tela FLUTUANTE: pode ser arrastado para qualquer lugar,
   * redimensionado pela alça inferior-direita e maximizado (apresentação).
   * @param {HTMLElement} wrap — o `.video-tile`
   * @param {'cam'|'screen'} kind
   */
  _makeTileInteractive(wrap, kind) {
    this._ensureTileStyles();
    wrap.classList.add('floating');

    // Tamanho e posição inicial (escalonados p/ não empilhar). Tela maior.
    const w0 = kind === 'screen' ? 440 : 240;
    const n = this._tileSpawnN++;
    const vw = window.innerWidth, vh = window.innerHeight;
    wrap.style.width = w0 + 'px';
    wrap.style.left  = Math.max(12, vw - w0 - 24 - (n % 4) * 26) + 'px';
    wrap.style.top   = (72 + (n % 6) * 26) + 'px';
    const bringFront = () => { wrap.style.zIndex = String(++this._tileZ); };
    bringFront();

    // Barra superior (arraste + botão maximizar/apresentar)
    const bar = document.createElement('div');
    bar.className = 'tile-bar';
    const btnMax = document.createElement('div');
    btnMax.className = 'tile-btn';
    btnMax.textContent = '⛶';
    btnMax.title = 'Maximizar / apresentar (duplo-clique também)';
    bar.appendChild(btnMax);
    wrap.appendChild(bar);

    // Alça de redimensionamento
    const rh = document.createElement('div');
    rh.className = 'tile-resize';
    rh.title = 'Arraste para redimensionar';
    wrap.appendChild(rh);

    // ── Arrastar (corpo do tile e barra; ignora alça e botão) ──
    wrap.addEventListener('pointerdown', (e) => {
      if (e.target === rh || e.target === btnMax) return;
      e.preventDefault();
      bringFront();
      const r = wrap.getBoundingClientRect();
      const offX = e.clientX - r.left, offY = e.clientY - r.top;
      const move = (ev) => {
        const maxL = window.innerWidth - 50, maxT = window.innerHeight - 28;
        wrap.style.left = Math.min(maxL, Math.max(-r.width + 60, ev.clientX - offX)) + 'px';
        wrap.style.top  = Math.min(maxT, Math.max(0, ev.clientY - offY)) + 'px';
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    // ── Redimensionar (mantém proporção do vídeo via height:auto do CSS) ──
    rh.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      bringFront();
      const startW = wrap.getBoundingClientRect().width;
      const startX = e.clientX;
      const move = (ev) => {
        const nw = Math.max(140, Math.min(window.innerWidth * 0.95, startW + (ev.clientX - startX)));
        wrap.style.width = nw + 'px';
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    // ── Maximizar / apresentar (toggle) ──
    let saved = null;
    const toggleMax = () => {
      if (saved) {
        wrap.style.left = saved.left; wrap.style.top = saved.top; wrap.style.width = saved.width;
        saved = null;
      } else {
        saved = { left: wrap.style.left, top: wrap.style.top, width: wrap.style.width };
        const bw = Math.min(window.innerWidth * 0.82, 1100);
        wrap.style.width = bw + 'px';
        wrap.style.left  = ((window.innerWidth - bw) / 2) + 'px';
        wrap.style.top   = '64px';
        bringFront();
      }
    };
    btnMax.addEventListener('click', (e) => { e.stopPropagation(); toggleMax(); });
    wrap.addEventListener('dblclick', (e) => { if (e.target !== rh && e.target !== btnMax) toggleMax(); });
  }
}
