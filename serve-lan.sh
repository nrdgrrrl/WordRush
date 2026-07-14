#!/usr/bin/env bash
set -e
PORT="${1:-18765}"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "Wordrush multiplayer LAN server"
echo "Open on this machine: http://localhost:${PORT}"
echo "Open on phones on the same Wi-Fi: http://${IP}:${PORT}"
LOG="${TMPDIR:-/tmp}/wordrush.log"
if command -v ss >/dev/null 2>&1 && ss -ltn | grep -q ":${PORT} "; then echo "Port ${PORT} is already in use."; exit 1; fi
nohup setsid env PORT="${PORT}" node server.js >"${LOG}" 2>&1 </dev/null &
PID=$!
echo "Started Wordrush server in background (PID ${PID})"
echo "Log: ${LOG}"


