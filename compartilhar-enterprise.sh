#!/usr/bin/env bash
# compartilhar-enterprise.sh
# Abre um túnel Cloudflare para expor o Enterprise publicamente.
# Compartilhe a URL gerada com seu colega.

set -euo pipefail

if ! command -v cloudflared &>/dev/null; then
  echo "Erro: 'cloudflared' não encontrado."
  echo "Instale com:"
  echo "  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared"
  echo "  chmod +x /usr/local/bin/cloudflared"
  exit 1
fi

echo "Abrindo túnel Cloudflare para http://localhost:8080 ..."
echo "Aguarde a URL pública aparecer (linha 'trycloudflare.com')."
echo "Pressione Ctrl+C para encerrar o túnel."
echo ""

cloudflared tunnel --url http://localhost:8080
