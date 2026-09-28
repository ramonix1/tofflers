/**
 * chat.js — Painel de chat client-side + integração de rede.
 * Canais: Geral, Local (proximity), DMs por jogador remoto.
 * Todas as mensagens são de pessoas reais via servidor.
 */

import { ROLE_COLORS } from './avatar.js';

export class Chat {
  /**
   * @param {import('./net.js').Net} net — instância de rede (pode ser null antes do join)
   */
  constructor(net = null) {
    this._net = net;

    // Armazena mensagens por canal: 'geral', 'local', 'dm:<playerId>'
    this._channels = {
      geral: [],
      local: [],
    };

    this._activeChannel = 'geral';
    this._unread = {};

    // Jogadores remotos reais online: Map(id → {id, name, role})
    this._remotePlayers = new Map();

    this._initDOM();
  }

  /**
   * Registra um jogador remoto online → cria aba DM se não existir.
   * @param {{id:string, name:string, role:string}} p
   */
  registerRemotePlayer(p) {
    this._remotePlayers.set(p.id, p);
    const chanId = 'dm:' + p.id;
    if (!this._channels[chanId]) {
      this._channels[chanId] = [];
      this._addDMTab(chanId, p.name, p.role);
    }
  }

  /**
   * Remove um jogador remoto e sua aba de DM.
   * @param {string} id
   */
  unregisterRemotePlayer(id) {
    this._remotePlayers.delete(id);
    const chanId = 'dm:' + id;
    // Remove a aba do DOM
    const tab = this._tabsEl.querySelector(`.chat-tab[data-channel="${chanId}"]`);
    if (tab) tab.remove();
    // Não apaga mensagens — fica no histórico local
  }

  // ── DOM ─────────────────────────────────────────────────────────────────

  _initDOM() {
    this._tabsEl    = document.getElementById('chat-tabs');
    this._msgsEl    = document.getElementById('chat-messages');
    this._inputEl   = document.getElementById('chat-input');
    this._sendBtn   = document.getElementById('chat-send-btn');

    // Eventos das abas existentes (Geral, Local)
    for (const tab of this._tabsEl.querySelectorAll('.chat-tab')) {
      tab.addEventListener('click', () => this._switchChannel(tab.dataset.channel));
    }

    // Envio de mensagem
    this._sendBtn.addEventListener('click', () => this._send());
    this._inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._send();
      }
    });

    // Mensagem de boas-vindas
    this._postSystem('geral', '👋 Bem-vindo ao Toffies! Use WASD para mover-se pelo escritório.');
  }

  /**
   * Adiciona uma aba de DM para um jogador remoto.
   * @param {string} channelId
   * @param {string} name
   * @param {string} role
   */
  _addDMTab(channelId, name, role) {
    const tab = document.createElement('div');
    tab.className = 'chat-tab';
    tab.dataset.channel = channelId;

    const dot = document.createElement('span');
    dot.style.display = 'inline-block';
    dot.style.width   = '7px';
    dot.style.height  = '7px';
    dot.style.borderRadius = '50%';
    dot.style.background = ROLE_COLORS[role] || '#94a3b8';
    dot.style.marginRight = '4px';
    dot.style.verticalAlign = 'middle';

    tab.appendChild(dot);
    tab.appendChild(document.createTextNode(name));
    tab.addEventListener('click', () => this._switchChannel(channelId));

    // Insere logo após a aba Local
    const localTab = this._tabsEl.querySelector('.chat-tab[data-channel="local"]');
    if (localTab && localTab.nextSibling) {
      this._tabsEl.insertBefore(tab, localTab.nextSibling);
    } else {
      this._tabsEl.appendChild(tab);
    }
  }

  _switchChannel(channelId) {
    this._activeChannel = channelId;
    this._unread[channelId] = 0;

    for (const tab of this._tabsEl.querySelectorAll('.chat-tab')) {
      tab.classList.toggle('active', tab.dataset.channel === channelId);
      if (tab.dataset.channel === channelId) {
        const dotEl = tab.querySelector('.unread-dot');
        if (dotEl) dotEl.remove();
      }
    }

    this._renderMessages();
  }

  _renderMessages() {
    const msgs = this._channels[this._activeChannel] || [];
    this._msgsEl.innerHTML = '';
    for (const m of msgs) {
      this._msgsEl.appendChild(this._buildMsgEl(m));
    }
    this._msgsEl.scrollTop = this._msgsEl.scrollHeight;
  }

  _buildMsgEl(m) {
    const div = document.createElement('div');
    div.className = 'chat-msg';

    if (m.type === 'system') {
      div.innerHTML = `<div class="chat-divider">${m.text}</div>`;
      return div;
    }

    const color = ROLE_COLORS[m.role] || '#94a3b8';
    div.innerHTML = `
      <div class="chat-msg-header">
        <span class="chat-msg-author" style="color:${color}">${m.author}</span>
        <span class="chat-msg-time">${m.time}</span>
      </div>
      <div class="chat-msg-body">${m.text}</div>
    `;
    return div;
  }

  _appendMsg(channelId, msg) {
    if (!this._channels[channelId]) this._channels[channelId] = [];
    this._channels[channelId].push(msg);

    if (channelId === this._activeChannel) {
      this._msgsEl.appendChild(this._buildMsgEl(msg));
      this._msgsEl.scrollTop = this._msgsEl.scrollHeight;
    } else {
      this._unread[channelId] = (this._unread[channelId] || 0) + 1;
      this._showUnreadDot(channelId);
    }
  }

  _showUnreadDot(channelId) {
    for (const tab of this._tabsEl.querySelectorAll('.chat-tab')) {
      if (tab.dataset.channel === channelId) {
        if (!tab.querySelector('.unread-dot')) {
          const dot = document.createElement('span');
          dot.className = 'unread-dot';
          tab.appendChild(dot);
        }
      }
    }
  }

  // ── API pública ──────────────────────────────────────────────────────────

  _postSystem(channelId, text) {
    this._appendMsg(channelId, { type: 'system', text });
  }

  /** Envio de mensagem pelo jogador local. */
  _send() {
    const text = this._inputEl.value.trim();
    if (!text) return;
    this._inputEl.value = '';

    const chan = this._activeChannel;

    if (this._net && this._net.youId) {
      // Modo rede: roteia pelo servidor
      if (chan === 'geral') {
        this._net.sendChat('geral', text);
      } else if (chan === 'local') {
        this._net.sendChat('local', text);
      } else if (chan.startsWith('dm:')) {
        const toId = chan.slice(3);
        this._net.sendChat('dm', text, toId);
      }
    }
  }

  /**
   * Recebe uma mensagem de rede do servidor.
   * @param {object} msg — {t:'chat', from, name, role, channel, to?, text, ts}
   * @param {string} myId — ID do jogador local (para saber qual lado da DM)
   */
  receiveNetMsg(msg, myId) {
    const isMe = msg.from === myId;
    const author = isMe ? (msg.name || 'Você') : (msg.name || 'Remoto');

    if (msg.channel === 'geral') {
      this._appendMsg('geral', {
        type: 'msg',
        author,
        role: msg.role || 'Dev',
        text: msg.text,
        time: this._tsToTime(msg.ts),
      });
    } else if (msg.channel === 'local') {
      this._appendMsg('local', {
        type: 'msg',
        author,
        role: msg.role || 'Dev',
        text: msg.text,
        time: this._tsToTime(msg.ts),
      });
    } else if (msg.channel === 'dm') {
      // Determina com qual player é a conversa
      const otherId = isMe ? msg.to : msg.from;
      const chanId = 'dm:' + otherId;

      // Garante que a aba existe (pode chegar DM de alguém antes do player_join)
      if (!this._channels[chanId]) {
        this._channels[chanId] = [];
        const p = this._remotePlayers.get(otherId) || { id: otherId, name: msg.name || 'Remoto', role: msg.role || 'Dev' };
        this._addDMTab(chanId, p.name, p.role);
      }

      this._appendMsg(chanId, {
        type: 'msg',
        author,
        role: msg.role || 'Dev',
        text: msg.text,
        time: this._tsToTime(msg.ts),
      });
    }
  }

  /**
   * Renderiza uma mensagem do histórico recebido no welcome.
   * @param {string} chanId — 'geral' | 'dm:<id>'
   * @param {{from:string, name:string, role:string, text:string, ts:number}} msg
   */
  receiveHistoryMsg(chanId, msg) {
    if (!this._channels[chanId]) this._channels[chanId] = [];
    this._channels[chanId].push({
      type: 'msg',
      author: msg.name || msg.from,
      role: msg.role || 'Dev',
      text: msg.text,
      time: this._tsToTime(msg.ts),
    });
    // Re-renderiza se é o canal ativo
    if (chanId === this._activeChannel) {
      this._renderMessages();
    }
  }

  /**
   * Posta evento de sistema.
   * @param {string} channelId
   * @param {string} text
   */
  postEvent(channelId, text) {
    this._appendMsg(channelId, { type: 'system', text });
  }

  // ── Update loop ──────────────────────────────────────────────────────────

  /** Mantido para compatibilidade com main.js — sem lógica de NPC. */
  update(dt) {
    // noop — sem timers de NPC
  }

  _now() {
    return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  /**
   * Converte timestamp Unix (ms) para horário local HH:MM.
   * @param {number} ts
   * @returns {string}
   */
  _tsToTime(ts) {
    if (!ts) return this._now();
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
}
