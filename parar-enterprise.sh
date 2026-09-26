#!/usr/bin/env bash
# Encerra o servidor do escritório virtual Enterprise (systemd e/ou instância avulsa de fallback).
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
systemctl --user stop enterprise.service 2>/dev/null
systemctl --user reset-failed enterprise.service 2>/dev/null
# Fallback: mata instância avulsa (iniciada sem systemd), se houver.
# O colchete em [h]ttp evita que o pkill se auto-mate ao buscar o padrão.
pkill -f "[h]ttp.server 8080" 2>/dev/null
exit 0
