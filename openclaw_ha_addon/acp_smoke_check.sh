#!/usr/bin/env bash
# acp_smoke_check.sh — read-only health check after a Gateway restart.
#
# Answers in one run: is harness-config-writer still deployed and registered,
# is the removed acp-dashboard-binding fully absent, and are ACP sessions and
# the Gateway healthy after the restart?
#
# Checks:
#   1. Gateway process
#   2. harness-config-writer deployment; removed-plugin artifacts absent
#   3. openclaw.json plugin config present + valid; removed plugin unregistered
#   4. Generic ACP session roster
#   5. Stuck session_nodes (running > 15 min) in the agent DB
#   6. Gateway log errors since last boot (JSON log, extracts messages)
#   7. harness-config-writer env on the gateway process (Ollama wiring)
#   8. Generic plugin load failures + no removed-plugin load since last boot
#
# Usage:  bash acp_smoke_check.sh
# Exit:   0 = all green, 1 = at least one check failed (WARN ignored).
#
# Read-only by design: sqlite3 -readonly, /proc reads, stat/python only. No
# writes anywhere, safe to run anytime without stopping the gateway.

set -u
RC=0
fail() { RC=1; }

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mOK  \033[0m %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$1"; }

bold "ACP smoke check — $(date '+%F %T %Z')"

# ---------------------------------------------------------------- 0. paths
CFG="${OPENCLAW_CONFIG_DIR:-/config/.openclaw}"
case "$CFG" in */.openclaw) ;; *) CFG="$CFG/.openclaw" ;; esac
DEPLOY_PLUGIN="$CFG/plugins"
STATE_DB="$CFG/state/openclaw.sqlite"
CONFIG_JSON="$CFG/openclaw.json"
LOG_GLOB="${TMPDIR:-/tmp}/openclaw/openclaw-$(date +%F).log"
BUNDLED_ROOT="${OPENCLAW_BUNDLED_EXTENSIONS_DIR:-/usr/lib/node_modules/openclaw/dist/extensions}"
WRITER_PLUGIN=harness-config-writer
REMOVED_PLUGIN=acp-dashboard-binding

# --------------------------------------------------------- 1. gateway alive
bold "1) Gateway process"
GW_PIDS=$(pgrep -f 'node.*openclaw' 2>/dev/null | tr '\n' ' ')
if [ -n "${GW_PIDS// /}" ]; then
    ok "gateway pid(s): $GW_PIDS"
else
    bad "no gateway (node/openclaw) process found"
    fail
fi

# --------------------------------------------- 2. plugin deployment matches
# The helper compiles harness-config-writer (esbuild index.mjs) into the
# gateway's bundled extensions root and removes its external $CFG/plugins copy
# so an external candidate cannot shadow the trusted bundled candidate.
bold "2) Plugin deployment (writer present / removed plugin absent)"
if [ -d "$BUNDLED_ROOT/$WRITER_PLUGIN" ]; then
    if [ -s "$BUNDLED_ROOT/$WRITER_PLUGIN/index.mjs" ]; then
        ok "$WRITER_PLUGIN bundled index.mjs present ($(( $(stat -c%s "$BUNDLED_ROOT/$WRITER_PLUGIN/index.mjs") / 1024 )) KiB)"
    else
        bad "$WRITER_PLUGIN bundled index.mjs missing/empty in $BUNDLED_ROOT/$WRITER_PLUGIN"
        fail
    fi
    if python3 -B -c 'import json,sys;json.load(open(sys.argv[1]))' "$BUNDLED_ROOT/$WRITER_PLUGIN/package.json" 2>/dev/null; then
        ok "$WRITER_PLUGIN bundled package.json valid"
    else
        bad "$WRITER_PLUGIN bundled package.json missing/invalid JSON"
        fail
    fi
    if [ -d "$DEPLOY_PLUGIN/$WRITER_PLUGIN" ]; then
        bad "$WRITER_PLUGIN stale external copy still at $DEPLOY_PLUGIN/$WRITER_PLUGIN (shadows bundled candidate)"
        fail
    else
        ok "$WRITER_PLUGIN no stale external copy"
    fi
elif [ -d "$DEPLOY_PLUGIN/$WRITER_PLUGIN" ]; then
    warn "$WRITER_PLUGIN NOT in bundled root — legacy external deploy at $DEPLOY_PLUGIN/$WRITER_PLUGIN (esbuild fallback active?)"
else
    bad "$WRITER_PLUGIN deployed nowhere (bundled root AND $DEPLOY_PLUGIN missing)"
    fail
fi

if [ -e "$BUNDLED_ROOT/$REMOVED_PLUGIN" ] || [ -L "$BUNDLED_ROOT/$REMOVED_PLUGIN" ]; then
    bad "removed $REMOVED_PLUGIN still present in bundled root: $BUNDLED_ROOT/$REMOVED_PLUGIN"
    fail
else
    ok "removed $REMOVED_PLUGIN absent from bundled root"
fi
if [ -e "$DEPLOY_PLUGIN/$REMOVED_PLUGIN" ] || [ -L "$DEPLOY_PLUGIN/$REMOVED_PLUGIN" ]; then
    bad "removed $REMOVED_PLUGIN still has an external payload: $DEPLOY_PLUGIN/$REMOVED_PLUGIN"
    fail
else
    ok "removed $REMOVED_PLUGIN has no external payload"
fi

# --------------------------------------------------- 3. openclaw.json sanity
bold "3) openclaw.json plugin config"
if python3 -B - "$CONFIG_JSON" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as handle:
        cfg = json.load(handle)
except Exception as e:
    print("  FAIL cannot parse openclaw.json:", e)
    sys.exit(1)
paths = cfg.get("plugins", {}).get("load", {}).get("paths", [])
entries = cfg.get("plugins", {}).get("entries", {})
ok = True
if "/config/.openclaw/plugins" not in paths:
    print("  FAIL plugins.load.paths misses /config/.openclaw/plugins:", paths)
    ok = False
writer = "harness-config-writer"
removed = "acp-dashboard-binding"
if writer not in entries:
    print(f"  FAIL plugins.entries['{writer}'] missing")
    ok = False
elif not entries[writer].get("enabled", True):
    print(f"  WARN plugins.entries['{writer}'] disabled")
if removed in entries:
    print(f"  FAIL removed plugins.entries['{removed}'] is still registered")
    ok = False
sys.exit(0 if ok else 1)
PY
then ok "load.paths + writer entry present; removed plugin unregistered"
else fail
fi

# ------------------------------------------------------- 4. ACP session roster
bold "4) ACP sessions"
if [ ! -f "$STATE_DB" ]; then
    bad "state DB missing: $STATE_DB"
    fail
else
    acp=$(sqlite3 -readonly "$STATE_DB" \
        "SELECT session_key, agent || ' / ' || backend || ' / ' || state || ' / ' || coalesce(cwd,'-')
           FROM acp_sessions ORDER BY last_activity_at DESC LIMIT 10;")
    if [ -z "$acp" ]; then
        warn "no ACP sessions registered"
    else
        printf '%s\n' "$acp" | while IFS='|' read -r key info; do
            ok "acp: $info  [$key]"
        done
    fi
fi

# ------------------------------------------------------- 5. stuck run nodes
bold "5) Stuck session_nodes (running > 15 min)"
AGENT_DB=$(ls -t "$CFG"/agents/*/agent/openclaw-agent.sqlite 2>/dev/null | head -5)
found_stuck=0
for db in $AGENT_DB; do
    stuck=$(sqlite3 -readonly "$db" \
        "SELECT session_key, current_session_id, snapshot_revision
           FROM session_nodes
          WHERE status='running'
            AND updated_at < (CAST(strftime('%s','now') AS INTEGER) - 900) * 1000;")
    if [ -n "$stuck" ]; then
        printf '%s\n' "$stuck" | while IFS='|' read -r key sid rev; do
            bad "stuck [$(basename "$(dirname "$(dirname "$db")")")]: $key session=$sid rev=$rev"
        done
        found_stuck=1
        fail
    fi
done
[ "$found_stuck" -eq 0 ] && ok "no stuck running nodes"

# ----------------------------------------------------------- 6. log errors
bold "6) Log errors since last boot"
LOG=$(ls -t $LOG_GLOB 2>/dev/null | head -1)
if [ -z "$LOG" ] || [ ! -f "$LOG" ]; then
    warn "no gateway log found ($LOG_GLOB)"
else
    python3 -B - "$LOG" <<'PY'
import json, sys
lines = open(sys.argv[1], errors="replace").readlines()
first = 0
for i in range(len(lines) - 1, -1, -1):
    if '"message":"gateway start' in lines[i] or 'startup complete' in lines[i]:
        first = i
        break
errs = []
for line in lines[first:]:
    try:
        rec = json.loads(line)
    except Exception:
        continue
    lvl = rec.get("_meta", {}).get("logLevelName", "")
    if lvl not in ("ERROR", "FATAL"):
        continue
    msg = rec.get("message", "")
    if isinstance(msg, str) and msg:
        errs.append(msg)
if errs:
    print(f"  {len(errs)} ERROR/FATAL entries since last boot (last 8):")
    for m in errs[-8:]:
        print("   -", m[:160])
else:
    print("  OK   no ERROR/FATAL entries since last boot")
PY
fi

# --------------------------------- 7. harness-config-writer env on gateway
bold "7) Harness env wiring (Ollama)"
GW_PID=$(pgrep -f 'node.*openclaw' 2>/dev/null | head -1)
if [ -n "$GW_PID" ] && [ -r "/proc/$GW_PID/environ" ]; then
    base=$(tr '\0' '\n' < "/proc/$GW_PID/environ" | grep '^ANTHROPIC_BASE_URL=' | cut -d= -f2-)
    if [ -n "$base" ]; then
        ok "ANTHROPIC_BASE_URL=$base"
    else
        warn "ANTHROPIC_BASE_URL not set on gateway process — harness writer env not applied"
    fi
else
    warn "cannot read gateway process env"
fi

# --------------------------------------- 8. generic plugin load-health check
bold "8) Plugin load health + removed-plugin runtime assertion"
if [ -z "$LOG" ] || [ ! -f "$LOG" ]; then
    warn "cannot inspect current-boot plugin loads without a gateway log"
elif python3 -B - "$LOG" <<'PY'
import json
import re
import sys

lines = open(sys.argv[1], errors="replace").readlines()
first = 0
for i in range(len(lines) - 1, -1, -1):
    if '"message":"gateway start' in lines[i] or "startup complete" in lines[i]:
        first = i
        break

failure_re = re.compile(
    r"failed to load (?:bundled )?(?:channel|plugin)|"
    r"(?:could not|cannot|can't) load (?:bundled )?(?:channel|plugin)|"
    r"plugin (?:load|loading) (?:failed|failure|error)|"
    r"error loading plugin|"
    r"missing bundled-channel-entry contract",
    re.IGNORECASE,
)
removed = "acp-dashboard-binding"
negative_re = re.compile(
    r"failed|failure|error|skipping|skipped|disabled|removed|absent|not loaded|missing",
    re.IGNORECASE,
)
loaded_re = re.compile(r"\b(?:loaded|registered|activated|started)\b|load complete", re.IGNORECASE)
failures = []
removed_loads = []
for raw in lines[first:]:
    try:
        rec = json.loads(raw)
        message = rec.get("message", "")
        if not isinstance(message, str):
            message = json.dumps(message)
    except Exception:
        message = raw.strip()
    if failure_re.search(message):
        failures.append(message)
    lower = message.lower()
    if removed in lower and not negative_re.search(message):
        if loaded_re.search(message) or f"startup trace: plugin {removed}" in lower or f"channels.{removed}." in lower:
            removed_loads.append(message)

if failures:
    print(f"  FAIL {len(failures)} plugin load failure(s) since last boot (last 8):")
    for message in failures[-8:]:
        print("   -", message[:200])
if removed_loads:
    print(f"  FAIL removed {removed} has load-success entries since last boot:")
    for message in removed_loads[-8:]:
        print("   -", message[:200])
if not failures and not removed_loads:
    print("  OK   no generic plugin load failures")
    print(f"  OK   removed {removed} has no load-success entries since last boot")
sys.exit(1 if failures or removed_loads else 0)
PY
then :
else fail
fi

bold "Result: $([ "$RC" -eq 0 ] && echo 'ALL GREEN' || echo 'ATTENTION NEEDED')"
exit "$RC"
