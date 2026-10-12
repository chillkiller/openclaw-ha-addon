#!/usr/bin/env bash
# acp_smoke_check.sh — read-only health check after a Gateway restart.
#
# Answers in one run: did the restart of the gateway break the
# acp-dashboard-binding plugin / ACP-main session, or is everything intact?
#
# Checks:
#   1. Gateway process
#   2. Deployed plugins: bundled root (/usr/lib .../dist/extensions) valid,
#      stale external copies absent
#   3. openclaw.json plugin config present + valid
#   4. Webchat conversation bindings (plugin-owned vs generic) + ACP sessions
#   5. Stuck session_nodes (running > 15 min) in the agent DB
#   6. Gateway log errors since last boot (JSON log, extracts messages)
#   7. harness-config-writer env on the gateway process (Ollama wiring)
#   8. "bundled channel" load warnings (stale TS payload in the bundled root)
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
# Since the bundled-root-trust deploy (0.7.13.18) the helper compiles each
# plugin (esbuild index.mjs) into the gateway's bundled extensions root
# (origin "bundled" → trusted runtime stores) and REMOVES the external
# $CFG/plugins/<name> copy (both candidates of an id → config wins and
# shadows the trusted bundled candidate).
BUNDLED_ROOT=/usr/lib/node_modules/openclaw/dist/extensions
bold "2) Plugin deployment (bundled root / external removal)"
for plugin in acp-dashboard-binding harness-config-writer; do
    if [ -d "$BUNDLED_ROOT/$plugin" ]; then
        if [ -s "$BUNDLED_ROOT/$plugin/index.mjs" ]; then
            ok "$plugin bundled index.mjs present ($(( $(stat -c%s "$BUNDLED_ROOT/$plugin/index.mjs") / 1024 )) KiB)"
        else
            bad "$plugin bundled index.mjs missing/empty in $BUNDLED_ROOT/$plugin"
            fail
        fi
        if python3 -c "import json;json.load(open('$BUNDLED_ROOT/$plugin/package.json'))" 2>/dev/null; then
            ok "$plugin bundled package.json valid"
        else
            bad "$plugin bundled package.json missing/invalid JSON"
            fail
        fi
        if [ -d "$DEPLOY_PLUGIN/$plugin" ]; then
            bad "$plugin stale external copy still at $DEPLOY_PLUGIN/$plugin (shadows bundled candidate)"
            fail
        else
            ok "$plugin no stale external copy"
        fi
    elif [ -d "$DEPLOY_PLUGIN/$plugin" ]; then
        warn "$plugin NOT in bundled root — legacy external deploy at $DEPLOY_PLUGIN/$plugin (esbuild fallback active?)"
    else
        bad "$plugin deployed nowhere (bundled root AND $DEPLOY_PLUGIN missing)"
        fail
    fi
done

# --------------------------------------------------- 3. openclaw.json sanity
bold "3) openclaw.json plugin config"
if python3 - "$CONFIG_JSON" <<'PY'
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except Exception as e:
    print("  FAIL cannot parse openclaw.json:", e); sys.exit(1)
paths = cfg.get("plugins", {}).get("load", {}).get("paths", [])
entries = cfg.get("plugins", {}).get("entries", {})
ok = True
if "/config/.openclaw/plugins" not in paths:
    print("  FAIL plugins.load.paths misses /config/.openclaw/plugins:", paths); ok = False
for p in ("acp-dashboard-binding", "harness-config-writer"):
    if p not in entries:
        print(f"  FAIL plugins.entries['{p}'] missing"); ok = False
    elif not entries[p].get("enabled", True):
        print(f"  WARN plugins.entries['{p}'] disabled")
sys.exit(0 if ok else 1)
PY
then ok "load.paths + plugin entries present"
else fail
fi

# --------------------------- 4. conversation bindings + ACP session roster
bold "4) ACP sessions + binding health"
# NOTE: current_conversation_bindings being EMPTY is expected here — the
# plugin's SessionBindingAdapter SHADOWS the host generic store and derives
# records deterministically (binding-adapter.ts: deriveBindingRecord,
# boundAt:0). The truth for live ACP targets is the acp_sessions roster.
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
            case "$key" in
                *acp:binding:webchat*) ok "acp: $info  [$key]" ;;
                *) ok "acp: $info" ;;
            esac
        done
    fi
    hs=$(python3 -c "
import json,sys
try:
    cfg=json.load(open('$CONFIG_JSON'))
    c=cfg.get('plugins',{}).get('entries',{}).get('acp-dashboard-binding',{}).get('config',{})
    hs=c.get('harnessSessions') or {}
    print(json.dumps(hs) if hs else '-')
except Exception as e:
    print('-')
" 2>/dev/null)
    if [ "$hs" = "-" ]; then
        echo "       harnessSessions: not configured (adapter derives keys deterministically)"
    else
        ok "harnessSessions: $hs"
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
[ $found_stuck -eq 0 ] && ok "no stuck running nodes"

# ----------------------------------------------------------- 6. log errors
bold "6) Log errors since last boot"
LOG=$(ls -t $LOG_GLOB 2>/dev/null | head -1)
if [ -z "$LOG" ] || [ ! -f "$LOG" ]; then
    warn "no gateway log found ($LOG_GLOB)"
else
    python3 - "$LOG" <<'PY'
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

# -------------------------------------------------- 6b. bundled-channel warns
bold "6b) 'bundled channel' plugin load warnings (today's log)"
# Entry-contract skip (Forensik 2026-10-12): the host's bundled-channel load
# check can also SKIP the plugin ("missing bundled-channel-entry contract")
# without ever logging "failed to load" — that skip silently suppresses
# registerFull (no adapter/claim hook/bridge) and kills ALL binding. Catch both.
if [ -n "$LOG" ] && [ -f "$LOG" ] && grep -q 'missing bundled-channel-entry contract' "$LOG" 2>/dev/null; then
    warn "$(grep -c 'missing bundled-channel-entry contract' "$LOG")× today: \"bundled channel entry acp-dashboard-binding missing bundled-channel-entry contract; skipping\""
    echo "       the deployed entry record fails resolveBundledChannelModuleEntry"
    echo "       (needs kind:\"bundled-channel-entry\" + register + loadChannelPlugin);"
    echo "       the gateway never instantiates the plugin — binding is dead."
else
    ok "no bundled-channel entry-contract skips"
fi
if [ -n "$LOG" ] && [ -f "$LOG" ] && grep -q 'failed to load bundled channel acp-dashboard-binding' "$LOG" 2>/dev/null; then
    n=$(grep -c 'failed to load bundled channel acp-dashboard-binding' "$LOG")
    if [ -s "$BUNDLED_ROOT/acp-dashboard-binding/index.mjs" ]; then
        # Only today's entries BEFORE the last gateway start are stale history.
        warn "$n× today: \"failed to load bundled channel acp-dashboard-binding\" —"
        echo "       compiled payload present now; if the LAST boot still shows this,"
        echo "       the bundled copy is not the compiled one or discovery sees .ts."
    else
        warn "$n× today: \"failed to load bundled channel …\" and bundled copy has no index.mjs"
        echo "       cause: openclaw.plugin.json declares channels[] → scanner refuses a TS entry."
        echo "       Run the helper/redeploy so the compiled payload lands."
    fi
else
    ok "no bundled-channel load warnings"
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

bold "Result: $([ $RC -eq 0 ] && echo 'ALL GREEN' || echo 'ATTENTION NEEDED')"
exit $RC