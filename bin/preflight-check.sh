#!/usr/bin/env bash
# Pre-Push hygiene gate (GaRoN 2026-10-18: housekeeping, NOT a release).
# Runs the same scan over the TRACKED files of the working tree before every push:
#   FAIL: real LAN host IPs (192.168.x.x) in code/docs — RFC-5737 ranges and
#         CIDR network notation (e.g. 192.168.0.0/16 masks) are whitelisted
#         (functional defaults like NO_PROXY stay legal, per f091042)
#   FAIL: internal design docs tracked (BRIDGE/HANDOVER/DESIGN/ARCHITECTURE/INTERNAL *.md)
#   WARN: literal section-symbol in tracked files (the known 29-comment sweep is
#         pending a GaRoN decision — it must not block; the .36 ride-along fixes it)
# Exit 1=block push, 0=allow. Scans only git-tracked files, so gitignored
# internal dirs (agents/, HCW internals) are out of scope by construction.
# NOTE: this file must not contain the literal section character itself (it
# would self-flag once tracked) — the pattern is built via printf escape.
set -u
GATE_FAIL=0

TRACKED=$(git ls-files '*.sh' '*.py' '*.yaml' '*.yml' '*.ts' '*.mjs' '*.js' '*.md' '*.json' '*.tpl' '*.html' 2>/dev/null)
if [ -z "$TRACKED" ]; then
  echo "GATE: no tracked files (nothing to scan)"
  exit 0
fi

# 1) real LAN host IPs (no CIDR mask suffix) — documentation ranges excluded
HITS=$(git grep -nE '(^|[^0-9.])192\.168\.[0-9]+\.[0-9]+([^\.]|$)' -- $TRACKED 2>/dev/null \
  | grep -vE '192\.0\.2\.|198\.51\.100\.|203\.0\.113\.' \
  | grep -vE '192\.168\.[0-9]+\.[0-9]+/' | head -6)
if [ -n "$HITS" ]; then
  GATE_FAIL=1
  echo "GATE FAIL — real LAN host IPs in tracked files:"
  echo "$HITS"
fi

# 2) internal design docs tracked?
DOCS=$(git ls-files | grep -iE '(BRIDGE|HANDOVER|DESIGN-|ARCHITECTURE-|INTERNAL-)[^/]*\.md$' | head -6)
if [ -n "$DOCS" ]; then
  GATE_FAIL=1
  echo "GATE FAIL — internal docs tracked:"
  echo "$DOCS"
fi

# 3) section symbol — WARN while the 29-reference sweep is pending (decided by GaRoN)
SECHS=$(printf '\302\247')
SEC=$(git grep -n -- "$SECHS" -- $TRACKED 2>/dev/null | head -8)
if [ -n "$SEC" ]; then
  echo "GATE WARN — section symbols in tracked files (27 refs pending the agreed sweep; must not block):"
  echo "$SEC"
fi

if [ "$GATE_FAIL" = "0" ]; then
  echo "GATE OK — no blocking patterns in tracked files"
  exit 0
fi
exit 1