/**
 * demandas.js — Painel de demandas compartilhado via servidor.
 * O servidor é a fonte da verdade; localStorage não é mais usado para demandas.
 */

// ── Demandas de exemplo (seeds) ────────────────────────────────────────────────
const EXEMPLOS = [
  { assunto: 'Implementar autenticação SSO com Google',  prioridade: 'alta',  link: '' },
  { assunto: 'Corrigir bug no relatório de vendas',      prioridade: 'alta',  link: '' },
  { assunto: 'Criar módulo de notificações push',        prioridade: 'media', link: '' },
];

// ── Classe principal ────────────────────────────────────────────────────────────

export class DemandasPanel {
  /**
   * @param {import('./chat.js').Chat} chat
   */
  constructor(chat) {
    this._chat     = chat;
    this._net      = null;   // definido via setNet()
    this._listEl   = document.getElementById('demandas-list');
    this._demandas = [];

    // Guard: semeou os exemplos nesta sessão (evita re-seed a cada reconexão)
    this._seeded = false;

    this._initFormBtn();
    // Renderiza vazio até o servidor responder
    this._render();
  }

  /**
   * Injeta a instância de Net após a construção.
   * Deve ser chamado antes do welcome/callbacks.
   * @param {import('./net.js').Net} net
   */
  setNet(net) {
    this._net = net;

    // Quando receber a lista do servidor (welcome ou broadcast), re-renderiza
    net.onDemandas = (list) => {
      this._demandas = list;

      // Seed: se o servidor está zerado e este cliente ainda não semeou, popula
      if (list.length === 0 && !this._seeded) {
        this._seeded = true;
        for (const ex of EXEMPLOS) {
          net.sendDemandaAdd(ex.assunto, ex.prioridade, ex.link);
        }
        // Não renderiza ainda — espera o broadcast de volta
        return;
      }

      this._render();
    };
  }

  /** Expõe as demandas para o sprint (leitura). */
  getDemandas() {
    return this._demandas;
  }

  /**
   * Atualiza o status de uma demanda via rede.
   * Chamado pelo sprint quando um card é movido.
   * @param {string} id
   * @param {string} status
   */
  setStatus(id, status) {
    if (this._net) {
      this._net.sendDemandaUpdate(id, status);
    }
  }

  // ── Formulário de nova demanda ─────────────────────────────────────────────

  _initFormBtn() {
    const btnAdd = document.getElementById('demandas-add-btn');
    const form   = document.getElementById('demandas-form');
    const btnSalvar   = document.getElementById('demanda-salvar-btn');
    const btnCancelar = document.getElementById('demanda-cancelar-btn');

    btnAdd.addEventListener('click', () => {
      form.classList.toggle('visible');
      if (form.classList.contains('visible')) {
        document.getElementById('demanda-assunto').focus();
      }
    });

    btnCancelar.addEventListener('click', () => {
      this._resetForm();
      form.classList.remove('visible');
    });

    btnSalvar.addEventListener('click', () => this._salvar());

    // Salva com Enter no campo de assunto
    document.getElementById('demanda-assunto').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._salvar(); }
    });
  }

  _salvar() {
    const assuntoEl   = document.getElementById('demanda-assunto');
    const prioEl      = document.getElementById('demanda-prioridade');
    const linkEl      = document.getElementById('demanda-link');
    const form        = document.getElementById('demandas-form');

    const assunto = assuntoEl.value.trim();
    if (!assunto) {
      assuntoEl.style.borderColor = 'var(--accent-danger)';
      assuntoEl.focus();
      return;
    }
    assuntoEl.style.borderColor = '';

    // Envia ao servidor — NÃO adiciona localmente; espera o broadcast demandas
    if (this._net) {
      this._net.sendDemandaAdd(assunto, prioEl.value, linkEl.value.trim());
    }

    this._resetForm();
    form.classList.remove('visible');
    showToast('✅ Demanda enviada ao servidor…');
  }

  _resetForm() {
    document.getElementById('demanda-assunto').value    = '';
    document.getElementById('demanda-prioridade').value = 'media';
    document.getElementById('demanda-link').value       = '';
    document.getElementById('demanda-assunto').style.borderColor = '';
  }

  // ── Render ────────────────────────────────────────────────────────────────

  _render() {
    this._listEl.innerHTML = '';
    if (this._demandas.length === 0) {
      this._listEl.innerHTML = `
        <div style="color:var(--text-muted);font-size:12px;padding:12px;text-align:center;">
          Nenhuma demanda. Clique em "+ Nova demanda" para criar.
        </div>
      `;
      return;
    }
    for (const d of this._demandas) {
      this._listEl.appendChild(this._buildCard(d));
    }
  }

  _buildCard(demanda) {
    const card = document.createElement('div');
    card.className = 'demanda-card';
    card.id = `card-${demanda.id}`;

    const prioLabel = { alta: 'Alta', media: 'Média', baixa: 'Baixa' }[demanda.prioridade] || 'Baixa';
    const prioClass = `prio-${demanda.prioridade}`;

    const statusLabel = {
      backlog:  '📋 Backlog',
      todo:     '📌 To Do',
      doing:    '⚙️ Doing',
      done:     '✅ Done',
      entregue: '🚀 Entregue',
    }[demanda.status] || '📋 Backlog';

    // Ícone de link externo se houver link preenchido
    const linkHtml = demanda.link
      ? `<a href="${demanda.link}" target="_blank" rel="noopener" class="demanda-link-icon" title="${demanda.link}">🔗</a>`
      : '';

    card.innerHTML = `
      <div class="demanda-header">
        <span class="demanda-id">${demanda.id} ${linkHtml}</span>
        <span class="demanda-prioridade ${prioClass}">${prioLabel}</span>
      </div>
      <div class="demanda-titulo">${demanda.assunto}</div>
      <div class="demanda-fase">${statusLabel}</div>
      <div class="demanda-actions">
        <button class="demanda-acionar-btn" data-id="${demanda.id}">🔔 Acionar equipe</button>
        <button class="demanda-remover-btn" data-id="${demanda.id}" title="Remover demanda">🗑</button>
      </div>
    `;

    card.querySelector('.demanda-acionar-btn').addEventListener('click', () => {
      this._acionar(demanda, card);
    });

    card.querySelector('.demanda-remover-btn').addEventListener('click', () => {
      this._remover(demanda.id);
    });

    return card;
  }

  _remover(id) {
    if (this._net) {
      this._net.sendDemandaRemove(id);
    }
    showToast(`🗑 Removendo ${id}…`);
  }

  /**
   * Aciona a equipe para uma demanda.
   * Posta UMA mensagem factual no Geral (via rede, para todos verem).
   */
  _acionar(demanda, cardEl) {
    const btn = cardEl.querySelector('.demanda-acionar-btn');
    btn.disabled = true;
    btn.textContent = '✅ Equipe acionada';
    cardEl.classList.add('acionada');

    const msg = `🔔 Demanda ${demanda.id} — "${demanda.assunto}" — equipe acionada.`;

    // Usa a rede para que todos os clientes vejam a mensagem
    if (this._net) {
      this._net.sendChat('geral', msg);
    } else {
      this._chat.postEvent('geral', msg);
    }

    showToast(`🔔 Equipe acionada para ${demanda.id}`);
  }
}

// ── Utilitário de toast ─────────────────────────────────────────────────────────

export function showToast(text) {
  const toast = document.getElementById('toast');
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}
