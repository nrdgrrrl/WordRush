#!/usr/bin/env bash
set -e
PORT="${1:-18765}"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "Wordrush multiplayer LAN server"
echo "Open on this machine: http://localhost:${PORT}"
echo "Open on phones on the same Wi-Fi: http://${IP}:${PORT}"
echo "Press Ctrl-C to stop."
PORT="${PORT}" node server.js

