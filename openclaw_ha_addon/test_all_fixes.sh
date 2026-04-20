#!/bin/bash
# /config/clawd/test_all_fixes.sh
# Komplette funktionale Validierung aller Fixes
# Battleplan V2 Test-Set

set -e

FAILED=0
PASSED=0

echo "=========================================="
echo "VALIDATION: ALL FIXES - Battleplan V2"
echo "=========================================="

# --- K10: VIRTUAL MEMORY ---
echo ""
echo "=== K10: VIRTUAL MEMORY ==="
if pgrep -x openclaw-gateway > /dev/null; then
    VMPEAK=$(cat /proc/$(pgrep openclaw-gateway)/status 2>/dev/null | grep VmPeak | awk '{print $2}')
    echo "VmPeak: ${VMPEAK}kB"
    if [ "${VMPEAK:-0}" -lt 8388608 ]; then
        echo "✓ PASS: VmPeak < 8GB"
        ((PASSED++))
    else
        echo "✗ FAIL: VmPeak >= 8GB"
        ((FAILED++))
    fi
else
    echo "⚠ SKIP: Gateway not running"
fi

# --- ZOMBIE PROCESSES ---
echo ""
echo "=== ZOMBIE PROCESSES ==="
ZOMBIES=$(ps aux 2>/dev/null | grep -E '\[sh\]|defunct' | grep -v grep | wc -l)
echo "Zombies: $ZOMBIES"
if [ "$ZOMBIES" -eq 0 ]; then
    echo "✓ PASS: No zombie processes"
    ((PASSED++))
else
    echo "✗ FAIL: Zombie processes detected"
    ((FAILED++))
fi

# --- mDNS FUNCTIONAL ---
echo ""
echo "=== mDNS FUNCTIONAL ==="

# 1. avahi-daemon running
if pgrep avahi-daemon > /dev/null 2>&1; then
    echo "✓ avahi-daemon running"
    ((PASSED++))
else
    echo "✗ avahi-daemon not running"
    ((FAILED++))
fi

# 2. Service advertised
if avahi-browse -r _openclaw._tcp 2>/dev/null | grep -q "openclaw"; then
    echo "✓ mDNS service advertised"
    ((PASSED++))
else
    echo "✗ mDNS service not found"
    ((FAILED++))
fi

# 3. Firewall: UDP 5353
if iptables -L -n 2>/dev/null | grep -q "5353" || nft list ruleset 2>/dev/null | grep -q "5353"; then
    echo "✓ Firewall allows UDP 5353"
    ((PASSED++))
else
    echo "⚠ WARN: Cannot verify UDP 5353 firewall rule"
fi

# 4. Multicast route
if ip route show 2>/dev/null | grep -q "224.0.0.251"; then
    echo "✓ Multicast route for mDNS exists"
    ((PASSED++))
else
    echo "⚠ WARN: No mDNS multicast route found"
fi

# --- AUDIO FUNCTIONAL ---
echo ""
echo "=== AUDIO FUNCTIONAL ==="

# 1. sox
if sox -n /tmp/test_audio_openclaw.wav synth 1 tone 440 2>/dev/null; then
    echo "✓ sox works"
    ((PASSED++))
    rm -f /tmp/test_audio_openclaw.wav
else
    echo "✗ sox failed"
    ((FAILED++))
fi

# 2. espeak-ng
if espeak-ng "test" --stdout > /dev/null 2>&1; then
    echo "✓ espeak-ng works"
    ((PASSED++))
else
    echo "✗ espeak-ng failed"
    ((FAILED++))
fi

# 3. gstreamer
if gst-inspect-1.0 core > /dev/null 2>&1; then
    echo "✓ gstreamer works"
    ((PASSED++))
else
    echo "✗ gstreamer failed"
    ((FAILED++))
fi

# --- TOOLCHAINS ---
echo ""
echo "=== TOOLCHAINS ==="

# bun
if bun --version > /dev/null 2>&1; then
    echo "✓ bun works"
    ((PASSED++))
else
    echo "✗ bun failed"
    ((FAILED++))
fi

# uv
if uv --version > /dev/null 2>&1; then
    echo "✓ uv works"
    ((PASSED++))
else
    echo "✗ uv failed"
    ((FAILED++))
fi

# go
if go version > /dev/null 2>&1; then
    echo "✓ go works"
    ((PASSED++))
else
    echo "✗ go failed"
    ((FAILED++))
fi

# --- GATEWAY ---
echo ""
echo "=== GATEWAY ==="

# 1. Health check
if curl -s http://127.0.0.1:18790/health 2>/dev/null | grep -q "ok"; then
    echo "✓ Gateway health OK"
    ((PASSED++))
else
    echo "✗ Gateway health failed"
    ((FAILED++))
fi

# 2. Ollama (optional)
if curl -s http://127.0.0.1:11434/api/tags 2>/dev/null | grep -q "models"; then
    echo "✓ Ollama connected"
    ((PASSED++))
else
    echo "⚠ WARN: Ollama not available"
fi

# --- HOME-SYNC ---
echo ""
echo "=== HOME-SYNC ==="

# 1. Check if /root has data
ROOT_HAS_DATA=false
if [ -n "$(ls -A /root 2>/dev/null)" ]; then
    ROOT_HAS_DATA=true
    echo "✓ /root has data (backup should exist)"
    ((PASSED++))
else
    echo "⚠ INFO: /root is empty"
fi

# 2. Symlink validation
if [ -L /root/.ssh ] && [ -e /root/.ssh ]; then
    echo "✓ /root/.ssh symlink valid"
    ((PASSED++))
else
    echo "⚠ WARN: /root/.ssh symlink missing or broken"
fi

# 3. Disk space check
FREE_SPACE=$(df -BG /config 2>/dev/null | tail -1 | awk '{print $4}' | tr -d 'G')
if [ "${FREE_SPACE:-0}" -gt 500 ]; then
    echo "✓ Disk space: ${FREE_SPACE}G free"
    ((PASSED++))
else
    echo "⚠ WARN: Low disk space: ${FREE_SPACE}G"
fi

# --- DATABASE TOOLS (optional) ---
echo ""
echo "=== DATABASE TOOLS ==="

if python3 -c "import psycopg2" 2>/dev/null; then
    echo "✓ psycopg2 available"
    ((PASSED++))
else
    echo "⚠ WARN: psycopg2 not available"
fi

if python3 -c "import pyodbc" 2>/dev/null; then
    echo "✓ pyodbc available"
    ((PASSED++))
else
    echo "⚠ WARN: pyodbc not available"
fi

# --- SUMMARY ---
echo ""
echo "=========================================="
echo "VALIDATION SUMMARY"
echo "=========================================="
echo "PASSED: $PASSED"
echo "FAILED: $FAILED"
echo "=========================================="

if [ $FAILED -gt 0 ]; then
    echo "RESULT: ❌ SOME TESTS FAILED"
    exit 1
else
    echo "RESULT: ✅ ALL TESTS PASSED"
    exit 0
fi