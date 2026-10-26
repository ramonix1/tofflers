# Enterprise — Escritório Virtual (Protótipo v1)

Protótipo visual de escritório virtual estilo Gather/Kumospace para equipe de software.
100% client-side, sem dependências externas, sem build step.

## Como rodar

O servidor (`server.js`, Node + `ws`) roda como serviço `systemd --user`
(`enterprise.service`, porta 8080) e sobe junto um túnel cloudflared "quick" — **todo mundo,
inclusive o anfitrião, entra por link público**.

```bash
./link-enterprise.sh   # sobe o serviço (se preciso) e imprime o link do anfitrião
```

- **Link do anfitrião** — `<túnel>/?h=<chave>`. A chave fica em `data/host-key` (gerada uma vez,
  0600) e o link atual em `data/host-link.txt`. É secreto: não compartilhe. Ao abrir, a chave sai
  da barra de endereço e fica só na aba (F5 continua valendo).
- **Convidados** — botão **🔗 Convidar** gera `<túnel>/?k=<token da sessão>`. "Parar de
  compartilhar" gira o token (o link antigo não entra mais; quem já está dentro permanece).
- **Sessão** — nasce quando o anfitrião conecta e acaba ~8s depois que ele sai: convidados caem,
  o chat é arquivado e o token é renovado. O túnel não cai com a sessão.
- O endereço do túnel (trycloudflare) muda a cada reinício do serviço; rode `./link-enterprise.sh`
  de novo. Se o cloudflared cair, o servidor religa sozinho (backoff 5s a 60s).
- Parar o serviço: `systemctl --user stop enterprise.service`. Logs:
  `journalctl --user -u enterprise.service`.

Testes: `node tools/session-e2e.mjs` (autenticação e ciclo de sessão; usa `HOST_KEY` +
`TEST_TUNNEL_URL` e um `data/` descartável via `ENTERPRISE_DATA_DIR`).

## Controles

| Tecla | Ação |
|-------|------|
| W / ↑ | Mover para cima |
| S / ↓ | Mover para baixo |
| A / ← | Mover para esquerda |
| D / → | Mover para direita |

- Aproxime-se de colegas (raio ~80px) para ver o canal **Local** no chat.
- Entre na **Sala de Reunião** (centro do mapa) para ativar o card de reunião.

## O que está MOCK / STUB

| Módulo | O que é mock |
|--------|-------------|
| `demandas.js` → `fetchDemandas()` | Retorna 4 cards estáticos; **TODO: integrar Pipefy via MCP** |
| NPCs | Movimento via wandering aleatório; falas são strings estáticas |
| Chat | Respostas dos NPCs são escolhidas aleatoriamente de listas fixas |
| Multiplayer | Sem backend; cada aba do navegador é um cliente isolado |
| Pipefy webhooks | Não implementado; demandas não atualizam em tempo real |

## Próximos passos

1. **Backend Node.js + WebSockets** — multiplayer real (posições dos colegas em tempo real).
2. **Integração Pipefy via MCP** — `fetchDemandas()` consome a API real; webhooks atualizam cards ao vivo.
3. **Voice/Video por proximidade** — WebRTC para proximity audio quando dois avatares se aproximam.
4. **Autenticação** — login com Google/Slack; avatar vinculado ao usuário real.
5. **Mapa editável** — admin pode criar salas, mesas e zonas via drag-and-drop.
6. **Notificações push** — quando uma demanda é acionada, todos os membros recebem notificação.

## Estrutura de arquivos

```
enterprise/
├── index.html          — Layout HTML principal
├── css/
│   └── style.css       — Estilos (paleta corporativa, painéis, chat)
├── js/
│   ├── main.js         — Bootstrap + game loop (requestAnimationFrame)
│   ├── office.js       — Mapa 2D (tiles, zonas, colisão, render)
│   ├── avatar.js       — Classe Avatar base (render, balão de fala)
│   ├── player.js       — Controle do jogador (WASD + colisão)
│   ├── npcs.js         — 5 NPCs com wandering + proximity chat + reporte
│   ├── chat.js         — Painel de chat (Geral, Local, DMs)
│   ├── meetings.js     — Sala de reunião (timer, participantes)
│   └── demandas.js     — Painel de demandas mock Pipefy + acionar equipe
└── README.md
```
