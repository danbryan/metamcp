#!/bin/bash
# Watchdog for com.bryanlabs.metamcp (MetaMCP native, Umbrella fork).
# LaunchAgent KeepAlive already restarts on process DEATH; this catches HANGS
# where a child is alive but no longer answering. It probes the backend
# /health (returns 200) and the frontend proxy port (returns 307 to /login,
# which `curl -f` treats as success). A confirmed failure of either kickstarts
# the whole launchd unit, restarting backend + frontend together.
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

LOG="$HOME/Library/Logs/metamcp-watchdog.log"
BACKEND="http://127.0.0.1:12009/health"
FRONTEND="http://127.0.0.1:12008/"

check() {
  curl -s -f --max-time 10 -o /dev/null "$BACKEND"  || return 1
  curl -s -f --max-time 10 -o /dev/null "$FRONTEND" || return 1
  return 0
}

if ! check; then
  # One retry to ride out a boot/restart window before acting.
  sleep 5
  if ! check; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] watchdog: health check failed, kickstarting metamcp" >> "$LOG"
    launchctl kickstart -k "gui/$(id -u)/com.bryanlabs.metamcp" 2>>"$LOG"
  fi
fi
