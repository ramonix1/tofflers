#!/usr/bin/env bash
# Imprime o link secreto do anfitrião (túnel público + ?h=<chave>).
# Garante o serviço de pé e espera o túnel gerar data/host-link.txt (até ~40s).
# O endereço do túnel muda a cada reinício do serviço — rode de novo para o link atual.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/data/host-link.txt"

systemctl --user start enterprise.service

for _ in $(seq 1 40); do
  if [ -s "$FILE" ]; then cat "$FILE"; exit 0; fi
  sleep 1
done

echo "O link do anfitrião não apareceu em 40s (túnel não subiu)." >&2
echo "Veja os logs: journalctl --user -u enterprise.service -e" >&2
exit 1
