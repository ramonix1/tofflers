/**
 * net.js — Cliente WebSocket multiplayer.
 * Conecta ao servidor /ws, gerencia reconexão automática e throttle de moves.
 */

export class Net {
  constructor() {
    /** ID do jogador atual (recebido no welcome) */
    this.youId = null;

    /** Callbacks externos */
    this.onWelcome    = null; // (data) => void
    this.onPlayerJoin = null; // (player) => void
    this.onPlayerMove = null; // ({id,x,y,dir}) => void
    this.onPlayerLeave= null; // (id) => void
    this.onChat       = null; // (msg) => void
    this.onDemandas   = null; // (demandas: array) => void
    this.onSprint     = null; // (sprint: object) => void
    this.onSignal     = null; // (from: string, data: object) => void  — sinalização WebRTC

    /** @type {WebSocket|null} */
    this._ws = null;

    /** Fila de msgs enquanto ainda não conectou */
    this._sendQueue = [];

    /** Controle de reconexão */
    this._reconnectDelay = 1000;
    this._maxDelay       = 30000;
    this._reconnecting   = false;
    this._intentionallyClosed = false;

    /** Throttle de move: última posição enviada */
    this._lastSentX   = null;
    this._lastSentY   = null;
    this._lastSentDir = null;
    this._moveTimer   = null;
    this._pendingMove = null;
    const MOVE_INTERVAL = 1000 / 15; // ~15/s

    // Seta timer para enviar moves pendentes
    this._moveInterval = setInterval(() => {
      if (this._pendingMove) {
        const { x, y, dir } = this._pendingMove;
        this._sendRaw({ t: 'move', x, y, dir });
        this._pendingMove = null;
      }
    }, MOVE_INTERVAL);
  }

  /**
   * Deriva a URL do WebSocket a partir de location.
   * @returns {string}
   */
  _wsURL() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  /**
   * Abre a conexão WebSocket.
   * Deve ser chamado apenas após o usuário entrar (join).
   */
  connect() {
    if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this._intentionallyClosed = false;
    this._openWS();
  }

  _openWS() {
    const url = this._wsURL();
    this._ws = new WebSocket(url);

    this._ws.addEventListener('open', () => {
      console.log('[net] Conectado ao servidor');
      this._reconnectDelay = 1000;
      this._reconnecting = false;
      // Drena a fila
      for (const raw of this._sendQueue) {
        this._ws.send(raw);
      }
      this._sendQueue = [];
    });

    this._ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this._handleMessage(msg);
    });

    this._ws.addEventListener('close', () => {
      if (this._intentionallyClosed) return;
      console.log(`[net] Desconectado — reconectando em ${this._reconnectDelay}ms`);
      setTimeout(() => this._openWS(), this._reconnectDelay);
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxDelay);
    });

    this._ws.addEventListener('error', () => {
      // O evento 'close' vai ser disparado em seguida; não precisamos agir aqui.
    });
  }

  _handleMessage(msg) {
    switch (msg.t) {
      case 'welcome':
        this.youId = msg.youId;
        // onWelcome PRIMEIRO (jogadores + chat), e cada callback isolado em try/catch:
        // um erro ao renderizar demandas/sprint NUNCA pode impedir os jogadores de aparecerem.
        try { if (this.onWelcome) this.onWelcome(msg); }
        catch (e) { console.error('[net] onWelcome falhou:', e); }
        if (msg.state) {
          try { if (msg.state.demandas !== undefined && this.onDemandas) this.onDemandas(msg.state.demandas); }
          catch (e) { console.error('[net] onDemandas falhou:', e); }
          try { if (msg.state.sprint !== undefined && this.onSprint) this.onSprint(msg.state.sprint); }
          catch (e) { console.error('[net] onSprint falhou:', e); }
        }
        break;
      case 'player_join':
        if (this.onPlayerJoin) this.onPlayerJoin(msg.player);
        break;
      case 'player_move':
        if (this.onPlayerMove) this.onPlayerMove(msg);
        break;
      case 'player_leave':
        if (this.onPlayerLeave) this.onPlayerLeave(msg.id);
        break;
      case 'chat':
        if (this.onChat) this.onChat(msg);
        break;
      case 'demandas':
        if (this.onDemandas) this.onDemandas(msg.demandas);
        break;
      case 'sprint':
        if (this.onSprint) this.onSprint(msg.sprint);
        break;
      case 'rtc_signal':
        if (this.onSignal) this.onSignal(msg.from, msg.data);
        break;
    }
  }

  /**
   * Envia JSON bruto (ou enfileira se não conectado).
   * @param {object} obj
   */
  _sendRaw(obj) {
    const raw = JSON.stringify(obj);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(raw);
    } else {
      this._sendQueue.push(raw);
    }
  }

  // ── API pública ──────────────────────────────────────────────────────────────

  /**
   * Entra no escritório com nome e papel.
   * @param {string} name
   * @param {string} role
   */
  join(name, role) {
    this._sendRaw({ t: 'join', name, role });
  }

  /**
   * Envia posição/direção (throttled: só se mudou e max 15/s).
   * @param {number} x
   * @param {number} y
   * @param {string} dir
   */
  sendMove(x, y, dir) {
    const rx = Math.round(x);
    const ry = Math.round(y);
    if (rx === this._lastSentX && ry === this._lastSentY && dir === this._lastSentDir) return;
    this._lastSentX   = rx;
    this._lastSentY   = ry;
    this._lastSentDir = dir;
    // Apenas marca o move pendente; o intervalo o envia
    this._pendingMove = { x: rx, y: ry, dir };
  }

  /**
   * Envia mensagem de chat.
   * @param {'geral'|'local'|'dm'} channel
   * @param {string} text
   * @param {string|undefined} [to] — ID do destinatário (para DMs)
   */
  sendChat(channel, text, to) {
    const msg = { t: 'chat', channel, text };
    if (to) msg.to = to;
    this._sendRaw(msg);
  }

  /**
   * Envia sinalização WebRTC direcionada a um peer (offer/answer/ICE).
   * O servidor repassa `data` opaca ao destinatário e carimba o remetente.
   * @param {string} to — ID do peer destinatário
   * @param {object} data — payload de sinalização ({description} ou {candidate})
   */
  sendSignal(to, data) {
    this._sendRaw({ t: 'rtc_signal', to, data });
  }

  // ── Demandas ──────────────────────────────────────────────────────────────────

  /**
   * Solicita ao servidor a criação de uma nova demanda.
   * O servidor gera o id, persiste e re-broadcasta.
   * @param {string} assunto
   * @param {string} prioridade
   * @param {string} link
   */
  sendDemandaAdd(assunto, prioridade, link) {
    this._sendRaw({ t: 'demanda_add', assunto, prioridade, link });
  }

  /**
   * Atualiza o status de uma demanda existente.
   * @param {string} id
   * @param {string} status
   */
  sendDemandaUpdate(id, status) {
    this._sendRaw({ t: 'demanda_update', id, status });
  }

  /**
   * Remove uma demanda.
   * @param {string} id
   */
  sendDemandaRemove(id) {
    this._sendRaw({ t: 'demanda_remove', id });
  }

  // ── Sprint ────────────────────────────────────────────────────────────────────

  /**
   * Envia o estado completo do sprint ao servidor.
   * @param {object} sprint
   */
  sendSprintSet(sprint) {
    this._sendRaw({ t: 'sprint_set', sprint });
  }

  /** Fecha a conexão intencionalmente (sem reconectar). */
  disconnect() {
    this._intentionallyClosed = true;
    clearInterval(this._moveInterval);
    if (this._ws) this._ws.close();
  }
}
