# Enterprise — Escritório Virtual (Protótipo v1)

Protótipo visual de escritório virtual estilo Gather/Kumospace para equipe de software.
100% client-side, sem dependências externas, sem build step.

## Como rodar

```bash
cd /home/itarget/enterprise
python3 -m http.server 8080
# Abra http://localhost:8080 no navegador
```

## Atalho na área de trabalho

Clicar no ícone **Enterprise** (na busca do GNOME ou fixado no dock) abre o escritório
direto no navegador, **sem abrir terminal**. O servidor roda em segundo plano como serviço
`systemd --user` (`enterprise.service`), desacoplado do ícone — continua no ar mesmo depois
de fechar a janela. O Chrome abre em **modo app** (janela sem abas) com **perfil dedicado**
(`~/.local/share/enterprise-chrome`), o que evita restaurar sessão antiga / abrir segunda
janela / usar cache velho.

Para encerrar o servidor, use o ícone **Parar Enterprise** ou:
`systemctl --user stop enterprise.service`.

Peças: `abrir-enterprise.sh` / `parar-enterprise.sh` (launchers), `enterprise.desktop` /
`parar-enterprise.desktop` (atalhos, instalados em `~/.local/share/applications/`),
`static/icone.svg` + `static/icone.png` (ícone) e `~/.config/systemd/user/enterprise.service`.
O launcher tem fallback para `setsid`/`nohup` caso o systemd do usuário não esteja disponível.
Reinstalar após mudar de pasta:

```bash
systemctl --user daemon-reload
cp enterprise.desktop parar-enterprise.desktop ~/.local/share/applications/
update-desktop-database ~/.local/share/applications
```

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
