#!/usr/bin/env bash
set -e
PORT="${1:-8000}"
case "${PORT}" in
  *[!0-9]*|"") echo "Port must be a number between 1 and 65535."; exit 1 ;;
esac
if [ "${PORT}" -lt 1 ] || [ "${PORT}" -gt 65535 ]; then
  echo "Port must be a number between 1 and 65535."
  exit 1
fi
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "Wordrush multiplayer LAN server"
echo "Open on this machine: http://localhost:${PORT}"
if [ -n "${IP}" ]; then
  echo "Open on phones on the same Wi-Fi: http://${IP}:${PORT}"
else
  echo "Could not detect a LAN address; use this machine's Wi-Fi IP with port ${PORT}."
fi
LOG="${TMPDIR:-/tmp}/wordrush.log"
if command -v ss >/dev/null 2>&1 && ss -ltn | grep -q ":${PORT} "; then
  echo "Port ${PORT} is already in use."
  exit 1
fi
nohup setsid env PORT="${PORT}" HOST="0.0.0.0" WORDRUSH_LAN_MODE=1 node server.js >"${LOG}" 2>&1 </dev/null &
PID=$!
echo "Started Wordrush server in background (PID ${PID})"
echo "Log: ${LOG}"
