/**
 * sprint.js — Ciclo de Sprint inspirado em Scrum.
 * Estado compartilhado via servidor (net.sendSprintSet / net.onSprint).
 * Sem falas simuladas de NPC — apenas eventos factuais do sistema.
 */

import { showToast } from './demandas.js';

// ── Estado local padrão ────────────────────────────────────────────────────────

function estadoInicial() {
  return {
    numero:   1,
    objetivo: '',
    ativa:    false,
    items:    [],
  };
}

// ── SprintManager ─────────────────────────────────────────────────────────────

export class SprintManager {
  /**
   * @param {import('./chat.js').Chat} chat
   * @param {import('./demandas.js').DemandasPanel} demandasPanel
   */
  constructor(chat, demandasPanel) {
    this._chat          = chat;
    this._demandasPanel = demandasPanel;
    this._net           = null;  // injetado via setNet()

    // Estado local (fonte real = servidor; este é otimista/espelho)
    this._sprint = estadoInicial();

    this._initDOM();
    this._renderBoard();
  }

  /**
   * Injeta a instância de Net após a construção.
   * @param {import('./net.js').Net} net
   */
  setNet(net) {
    this._net = net;

    // Recebe broadcasts do servidor (welcome ou sprint_set de qualquer cliente)
    net.onSprint = (sprint) => {
      // Normaliza contra o shape válido — um sprint incompleto (ex.: sem `items`)
      // NÃO pode quebrar o render (senão aborta o processamento do welcome).
      const base = estadoInicial();
      if (sprint && typeof sprint === 'object' && sprint.numero !== undefined) {
        this._sprint = {
          numero:   sprint.numero,
          objetivo: sprint.objetivo || '',
          ativa:    !!sprint.ativa,
          items:    Array.isArray(sprint.items) ? sprint.items : [],
        };
      } else {
        this._sprint = base;
      }
      this._atualizarUI();
      this._renderBoard();
    };
  }

  // ── Envio para o servidor ──────────────────────────────────────────────────

  /**
   * Publica o estado atual do sprint no servidor.
   * Todos os clientes receberão o broadcast onSprint e re-renderizarão.
   */
  _publicar() {
    if (this._net) {
      this._net.sendSprintSet(this._sprint);
    }
  }

  // ── DOM ───────────────────────────────────────────────────────────────────

  _initDOM() {
    // Painel principal do sprint
    this._painel       = document.getElementById('sprint-panel');
    this._boardEl      = document.getElementById('sprint-board');

    // Botão de toggle do painel
    document.getElementById('sprint-toggle-btn').addEventListener('click', () => {
      this._painel.classList.toggle('visible');
    });

    // Botão Planning (abre modal de seleção)
    document.getElementById('sprint-planning-btn').addEventListener('click', () => {
      this._abrirPlanning();
    });

    // Botão Daily
    document.getElementById('sprint-daily-btn').addEventListener('click', () => {
      this._runDaily();
    });

    // Botão Encerrar Sprint
    document.getElementById('sprint-encerrar-btn').addEventListener('click', () => {
      this._encerrarSprint();
    });

    // Modal Planning
    this._modalPlanning = document.getElementById('sprint-planning-modal');
    document.getElementById('sprint-modal-cancelar').addEventListener('click', () => {
      this._modalPlanning.classList.remove('visible');
    });
    document.getElementById('sprint-modal-iniciar').addEventListener('click', () => {
      this._iniciarSprint();
    });

    this._atualizarUI();
  }

  _atualizarUI() {
    const { ativa, numero, items } = this._sprint;

    // Título do sprint no painel
    document.getElementById('sprint-titulo').textContent =
      ativa ? `Sprint ${numero} — em andamento` : `Sprint ${numero} — aguardando`;

    // Habilita/desabilita botões
    document.getElementById('sprint-planning-btn').disabled = ativa;
    document.getElementById('sprint-daily-btn').disabled    = !ativa;
    document.getElementById('sprint-encerrar-btn').disabled = !ativa;

    // Contadores
    const todo  = items.filter(i => i.status === 'todo').length;
    const doing = items.filter(i => i.status === 'doing').length;
    const done  = items.filter(i => i.status === 'done').length;
    document.getElementById('sprint-count-todo').textContent  = todo;
    document.getElementById('sprint-count-doing').textContent = doing;
    document.getElementById('sprint-count-done').textContent  = done;
  }

  // ── Planning ──────────────────────────────────────────────────────────────

  _abrirPlanning() {
    const demandas = this._demandasPanel.getDemandas().filter(d => d.status === 'backlog');
    const lista    = document.getElementById('sprint-planning-lista');
    const objInput = document.getElementById('sprint-objetivo-input');
    objInput.value = '';

    // Atualiza número da sprint no modal
    const numEl = document.getElementById('sprint-modal-num');
    if (numEl) numEl.textContent = this._sprint.numero;

    lista.innerHTML = '';
    if (demandas.length === 0) {
      lista.innerHTML = '<p style="color:var(--text-muted);font-size:12px;padding:8px 0;">Sem demandas no backlog.</p>';
    } else {
      for (const d of demandas) {
        const label = document.createElement('label');
        label.className = 'sprint-planning-item';
        label.innerHTML = `
          <input type="checkbox" value="${d.id}" />
          <span class="demanda-prioridade prio-${d.prioridade}" style="font-size:9px;padding:1px 5px;">${d.prioridade}</span>
          <span>${d.assunto}</span>
        `;
        lista.appendChild(label);
      }
    }

    this._modalPlanning.classList.add('visible');
  }

  _iniciarSprint() {
    const checkboxes = document.querySelectorAll('#sprint-planning-lista input[type="checkbox"]:checked');
    const ids = Array.from(checkboxes).map(c => c.value);

    if (ids.length === 0) {
      showToast('⚠️ Selecione ao menos uma demanda.');
      return;
    }

    const objetivo = document.getElementById('sprint-objetivo-input').value.trim() || 'Entregar as histórias selecionadas';

    // Coleta as demandas selecionadas
    const demandas = this._demandasPanel.getDemandas();
    const items = ids.map(id => {
      const d = demandas.find(d => d.id === id);
      return { id: d.id, assunto: d.assunto, prioridade: d.prioridade, status: 'todo' };
    });

    // Atualiza status das demandas via rede
    for (const id of ids) {
      this._demandasPanel.setStatus(id, 'todo');
    }

    // Monta novo estado e publica
    this._sprint = {
      ...this._sprint,
      objetivo,
      ativa:  true,
      items,
    };

    this._modalPlanning.classList.remove('visible');

    // Anuncia no chat — evento factual do sistema
    this._chat.postEvent('geral', `🚀 Sprint ${this._sprint.numero} iniciada — objetivo: ${objetivo}`);

    // Publica no servidor; onSprint vai re-renderizar
    this._publicar();
    showToast(`🚀 Sprint ${this._sprint.numero} iniciada!`);
  }

  // ── Board ─────────────────────────────────────────────────────────────────

  _renderBoard() {
    const colunas = {
      todo:  document.getElementById('board-col-todo'),
      doing: document.getElementById('board-col-doing'),
      done:  document.getElementById('board-col-done'),
    };

    for (const col of Object.values(colunas)) {
      // Preserva o header e limpa só os cards
      const cards = col.querySelectorAll('.board-card');
      for (const c of cards) c.remove();
    }

    const items = Array.isArray(this._sprint.items) ? this._sprint.items : [];

    if (!this._sprint.ativa || items.length === 0) {
      const msg = document.createElement('div');
      msg.style.cssText = 'color:var(--text-muted);font-size:11px;padding:8px;text-align:center;grid-column:1/-1;';
      msg.textContent = this._sprint.ativa ? 'Nenhuma história na sprint.' : 'Inicie uma sprint para ver o board.';
      this._boardEl.appendChild(msg);
      return;
    }

    for (const item of items) {
      const card = this._buildBoardCard(item);
      const col  = colunas[item.status];
      if (col) col.appendChild(card);
    }
  }

  _buildBoardCard(item) {
    const card = document.createElement('div');
    card.className = 'board-card';
    card.dataset.id = item.id;

    const prioLabel = { alta: 'Alta', media: 'Média', baixa: 'Baixa' }[item.prioridade] || '';

    card.innerHTML = `
      <div class="board-card-header">
        <span class="board-card-id">${item.id}</span>
        <span class="demanda-prioridade prio-${item.prioridade}" style="font-size:9px;">${prioLabel}</span>
      </div>
      <div class="board-card-title">${item.assunto}</div>
      <button class="board-card-avancar" title="Avançar coluna">→</button>
    `;

    card.querySelector('.board-card-avancar').addEventListener('click', () => {
      this._avancarCard(item);
    });

    return card;
  }

  _avancarCard(item) {
    const proximo = { todo: 'doing', doing: 'done', done: 'done' };
    const anterior = item.status;
    const novoStatus = proximo[item.status] || item.status;

    if (anterior === novoStatus) return; // já em Done

    // Atualiza o item no estado local (otimista)
    item.status = novoStatus;

    // Sincroniza o status da demanda via rede
    this._demandasPanel.setStatus(item.id, novoStatus);

    // Publica sprint atualizado; onSprint re-renderiza todos
    this._publicar();
  }

  // ── Daily ─────────────────────────────────────────────────────────────────

  _runDaily() {
    if (!this._sprint.ativa) return;

    // Anuncia início da daily — as pessoas reais conversam no chat
    this._chat.postEvent('geral', `☀️ Daily Sprint ${this._sprint.numero} iniciada — cada membro, por favor reporte: o que fez, o que vai fazer e impedimentos.`);

    showToast('☀️ Daily iniciada!');
  }

  // ── Encerrar Sprint ───────────────────────────────────────────────────────

  _encerrarSprint() {
    if (!this._sprint.ativa) return;

    const done = this._sprint.items.filter(i => i.status === 'done');
    const nDone = done.length;

    // Move os Done para "entregue" no painel de demandas (via rede)
    for (const item of done) {
      this._demandasPanel.setStatus(item.id, 'entregue');
    }

    // Itens não-done voltam para backlog (via rede)
    const naoEntregues = this._sprint.items.filter(i => i.status !== 'done');
    for (const item of naoEntregues) {
      this._demandasPanel.setStatus(item.id, 'backlog');
    }

    const numAnterior = this._sprint.numero;

    // Evento factual do sistema
    this._chat.postEvent('geral', `✅ Sprint ${numAnterior} encerrada — entregues: ${nDone} ite${nDone === 1 ? 'm' : 'ns'}`);

    // Prepara próxima sprint e publica
    this._sprint = {
      numero:   numAnterior + 1,
      objetivo: '',
      ativa:    false,
      items:    [],
    };

    this._publicar();
    showToast(`🏁 Sprint ${numAnterior} encerrada! ${nDone} entr${nDone === 1 ? 'egue' : 'egues'}.`);
  }

  // ── Integração com MeetingManager ────────────────────────────────────────

  /**
   * Chamado pelo MeetingManager quando o tipo "Sprint Planning" é selecionado e
   * a reunião é iniciada. Abre o modal de planning.
   */
  onMeetingStart(tipo) {
    if (tipo === 'Sprint Planning') {
      setTimeout(() => this._abrirPlanning(), 300);
    } else if (tipo === 'Daily') {
      setTimeout(() => this._runDaily(), 300);
    }
  }
}
