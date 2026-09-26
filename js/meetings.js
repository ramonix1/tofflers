/**
 * meetings.js — Lógica da sala de reunião.
 * Detecta presença na zona, gerencia timer e participantes (pessoas reais).
 */

import { ZONES } from './office.js';

const MEETING_ZONE = ZONES.reuniao;

export class MeetingManager {
  /**
   * @param {import('./chat.js').Chat} chat
   * @param {import('./sprint.js').SprintManager} [sprint]
   */
  constructor(chat, sprint) {
    this._chat   = chat;
    this._sprint = sprint || null;

    this._inZone      = false;   // jogador está na sala de reunião?
    this._active      = false;   // reunião em andamento?
    this._elapsed     = 0;       // ms desde início da reunião
    this._type        = 'Daily'; // tipo selecionado

    // Referência ao jogador local (injetada depois)
    this._player = null;

    this._initDOM();
  }

  /**
   * Registra o jogador local. Chamado em startOffice.
   * @param {import('./player.js').Player} player
   */
  registerEntities(player) {
    this._player = player;
  }

  // ── DOM ─────────────────────────────────────────────────────────────────

  _initDOM() {
    this._card          = document.getElementById('meeting-card');
    this._startBtn      = document.getElementById('meeting-start-btn');
    this._info          = document.getElementById('meeting-info');
    this._timerEl       = document.getElementById('meeting-timer');
    this._participantsEl = document.getElementById('meeting-participants');

    // Seleção de tipo de reunião
    const typeBtns = this._card.querySelectorAll('.meeting-type-btn');
    typeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        typeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._type = btn.dataset.type;
      });
    });

    // Botão iniciar/encerrar
    this._startBtn.addEventListener('click', () => {
      if (this._active) {
        this._endMeeting();
      } else {
        this._startMeeting();
      }
    });
  }

  // ── Lógica ──────────────────────────────────────────────────────────────

  _isInZone(entity) {
    const z = MEETING_ZONE;
    return (
      entity.x >= z.x && entity.x <= z.x + z.w &&
      entity.y >= z.y && entity.y <= z.y + z.h
    );
  }

  _startMeeting() {
    this._active  = true;
    this._elapsed = 0;

    // Atualiza UI
    this._startBtn.textContent = '⏹ Encerrar reunião';
    this._info.classList.add('visible');
    this._updateParticipantsUI();

    // Posta no chat Geral
    this._chat.postEvent('geral', `📅 ${this._type} iniciada por Você`);

    // Notifica o SprintManager para cerimônias integradas
    if (this._sprint) {
      this._sprint.onMeetingStart(this._type);
    }
  }

  _endMeeting() {
    this._active = false;

    const duration = this._formatTime(this._elapsed);
    this._chat.postEvent('geral', `✅ ${this._type} encerrada — duração: ${duration}`);

    // Reseta UI
    this._startBtn.textContent = '▶ Iniciar reunião';
    this._info.classList.remove('visible');
    this._timerEl.textContent  = '00:00';
    this._elapsed = 0;
  }

  _updateParticipantsUI() {
    // Mostra só o jogador local (presença de remotos não é rastreada localmente)
    const present = this._player && this._isInZone(this._player) ? ['Você'] : ['Você'];
    this._participantsEl.textContent = 'Participantes: ' + present.join(', ');
  }

  _formatTime(ms) {
    const totalS = Math.floor(ms / 1000);
    const m = Math.floor(totalS / 60).toString().padStart(2, '0');
    const s = (totalS % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  // ── Update loop ──────────────────────────────────────────────────────────

  /**
   * @param {number} dt — delta em ms
   */
  update(dt) {
    if (!this._player) return;

    const wasInZone = this._inZone;
    this._inZone    = this._isInZone(this._player);

    // Mostra/oculta card quando o jogador entra/sai da zona (sem reunião ativa)
    if (this._inZone !== wasInZone) {
      if (this._inZone) {
        this._card.classList.add('visible');
      } else if (!this._active) {
        this._card.classList.remove('visible');
      }
    }

    // Avança timer da reunião
    if (this._active) {
      this._elapsed += dt;
      this._timerEl.textContent = this._formatTime(this._elapsed);
      this._updateParticipantsUI();

      // Garante que o card fique visível durante reunião
      this._card.classList.add('visible');
    }
  }
}
