#!/usr/bin/env bash
# Abre o escritório virtual Enterprise direto no navegador.
# O servidor roda em segundo plano (serviço systemd --user), desacoplado deste atalho,
# então continua no ar mesmo depois de fechar o navegador. Para encerrar, use o atalho
# "Parar Enterprise" ou: systemctl --user stop enterprise.service
export PATH="$HOME/.local/bin:$PATH"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
DIR="$HOME/enterprise"
PORT=8080
URL="http://127.0.0.1:$PORT"

# Sobe o servidor se ainda não estiver respondendo.
if ! curl -sf -o /dev/null "$URL/" 2>/dev/null; then
  if command -v systemctl >/dev/null 2>&1 \
     && systemctl --user start enterprise.service 2>/dev/null; then
    :  # subiu via systemd (independente deste processo)
  else
    # Fallback: daemoniza manualmente, desacoplado do atalho.
    setsid nohup python3 -m http.server "$PORT" \
      >> "$DIR/enterprise.log" 2>&1 < /dev/null &
  fi
  # Espera o servidor responder (até ~30s).
  for _ in $(seq 1 30); do
    curl -sf -o /dev/null "$URL/" 2>/dev/null && break
    sleep 1
  done
fi

# Abre o Chrome em modo app (janela isolada, sem abas, perfil dedicado).
# --user-data-dir dedicado evita restaurar sessão antiga e abrir na segunda janela.
# Roda em PRIMEIRO plano de propósito: se rodar em segundo plano, o GNOME encerra
# o processo do atalho e pode matar o xdg-open antes de o navegador abrir.
if command -v google-chrome >/dev/null 2>&1; then
  google-chrome \
    --user-data-dir="$HOME/.local/share/enterprise-chrome" \
    --app="$URL/" \
    --new-window \
    --no-first-run \
    --no-default-browser-check \
    >/dev/null 2>&1
else
  xdg-open "$URL" >/dev/null 2>&1 || gio open "$URL" >/dev/null 2>&1 || true
fi
sleep 2  # dá tempo do navegador destacar antes do atalho encerrar
