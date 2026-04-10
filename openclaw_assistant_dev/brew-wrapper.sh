#!/usr/bin/env bash
# brew-wrapper.sh - Delegiert root-Aufrufe an linuxbrew-User
# Fällt elegant um wenn Homebrew nicht verfügbar ist

if [ -x /home/linuxbrew/.linuxbrew/bin/brew ]; then
  # Homebrew verfügbar - als linuxbrew-User ausführen
  exec su linuxbrew -c "/home/linuxbrew/.linuxbrew/bin/brew \"$@\""
else
  # Homebrew nicht verfügbar - elegant fehlschlagen
  echo "FEHLER: Homebrew nicht installiert oder nicht verfügbar. Einige Skills die brew benötigen könnten nicht funktionieren." >&2
  exit 1
fi
