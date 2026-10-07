#!/bin/sh
# browser_links.sh — resolve the Playwright-managed Chromium and expose it system-wide.
#
# Two consumers share one binary source:
#   - OpenClaw: browser.executablePath=/usr/bin/chromium (openclaw.json, CDP transport)
#   - scripts/tools expecting chromium-browser
# while the real binary lives under $PLAYWRIGHT_BROWSERS_PATH (=/opt/ms-playwright)
# inside a revision directory whose inner layout varies by platform and Playwright
# version (chrome-linux/ on x64, chrome-linux-arm64/ on arm64 since Playwright ~1.63).
# Hardcoded globs therefore silently decay on rebuilds (dangling symlinks, green
# build, dead browser). This resolver:
#   1. finds the real binary dynamically (highest revision wins, chrome-linux* covers
#      x64, arm64 and future layouts),
#   2. re-links /usr/bin/chromium and /usr/bin/chromium-browser,
#   3. FAILS HARD when nothing is found — build/boot must not stay green quietly.
# Idempotent: safe to run at image build time and on every boot (run.sh self-heal).
set -eu

BROWSERS_ROOT="${PLAYWRIGHT_BROWSERS_PATH:-/opt/ms-playwright}"
CHROME_BIN="$(find "$BROWSERS_ROOT" -type f -path "$BROWSERS_ROOT/chromium-*/chrome-linux*/chrome" 2>/dev/null | sort -V | tail -n 1)"

if [ -z "$CHROME_BIN" ] || [ ! -x "$CHROME_BIN" ]; then
    echo "browser_links: ERROR - no executable Playwright Chromium found under $BROWSERS_ROOT" >&2
    echo "browser_links: DEBUG - directories present:" >&2
    ls -1 "$BROWSERS_ROOT" 2>/dev/null | sed 's/^/browser_links:   /' >&2 || true
    exit 1
fi

ln -sfn "$CHROME_BIN" /usr/bin/chromium
ln -sfn "$CHROME_BIN" /usr/bin/chromium-browser
echo "browser_links: /usr/bin/chromium -> $CHROME_BIN ($("$CHROME_BIN" --version 2>/dev/null))"