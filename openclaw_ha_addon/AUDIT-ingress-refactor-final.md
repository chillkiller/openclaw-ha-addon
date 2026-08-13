# FINAL Audit Report — OpenClaw HA Addon Ingress-UI Refactor

**Auditor:** coding-review subagent  
**Date:** 2026-08-13  
**Subject:** Current state of all Ingress/TUI/Docs files after previous P0 fixes  
**Previous Audit:** `AUDIT-ingress-refactor.md` (2026-08-12)

---

## 1. Files Audited

| File | Path |
|------|------|
| `landing.html.tpl` | `openclaw_ha_addon/landing.html.tpl` |
| `nginx.conf.tpl` | `openclaw_ha_addon/nginx.conf.tpl` |
| `tui/index.html` | `openclaw_ha_addon/tui/index.html` |
| `docs/index.html` | `openclaw_ha_addon/docs/index.html` |
| `render_nginx.py` | `openclaw_ha_addon/render_nginx.py` |
| `run.sh` | `openclaw_ha_addon/run.sh` (Ingress/TUI/Docs/Env-var sections) |
| `config.yaml` | `openclaw_ha_addon/config.yaml` (ingress_port, enable_webui/terminal/tui/docs) |

---

## 2. P0 Bug Status — Previous Audit Items

All 7 P0 bugs from `AUDIT-ingress-refactor.md` have been **FIXED**:

| # | Bug | File | Status |
|---|-----|------|--------|
| P0-1 | `__INGRESS_PORT__` never substituted | `render_nginx.py` | ✅ Fixed — `conf.replace('__INGRESS_PORT__', ingress_port)` present |
| P0-2 | `__SHOW_WEBUI_JS__`/`__SHOW_TERMINAL_JS__`/`__SHOW_TUI_JS__`/`__SHOW_DOCS_JS__` never substituted | `render_nginx.py` | ✅ Fixed — all four `landing.replace()` calls present |
| P0-3 | Landing page `root /var/www` vs actual `/etc/nginx/html/` | `nginx.conf.tpl` | ✅ Fixed — `root /etc/nginx/html` now used |
| P0-4 | TUI `try_files /tui.html` wrong path | `nginx.conf.tpl` | ✅ Fixed — `try_files $uri $uri/ =404` (TUI and docs both) |
| P0-5 | Docs `alias` + `try_files $uri` double-prefix path | `nginx.conf.tpl` | ✅ Fixed — uses `root /etc/nginx/html` + `try_files $uri $uri/ =404` |
| P0-6 | `__CERTS_DIR__` never substituted | `render_nginx.py` | ✅ Fixed — `conf.replace('__CERTS_DIR__', certs_dir)` present |
| P0-7 | `__GATEWAY_INTERNAL_PORT__` never substituted | `render_nginx.py` | ✅ Fixed — `conf.replace('__GATEWAY_INTERNAL_PORT__', internal_gw_port)` present |

---

## 3. Current State — Detailed Review

### 3.1 `landing.html.tpl`

- **Template substitutions:** All placeholders (`__OPENCLAW_VERSION__`, `__SHOW_WEBUI_JS__`, `__SHOW_TERMINAL_JS__`, `__SHOW_TUI_JS__`, `__SHOW_DOCS_JS__`, `__GATEWAY_PUBLIC_URL__`, `__ACCESS_MODE__`) are replaced by `render_nginx.py`. ✅
- **Inline WebUI logic:** Inside HA Ingress iframe → inline WebUI tab shown; outside iframe → external link shown. Correctly guards with `webuiInlineOk` and `showExternalWebui`. ✅
- **Security:** No inline event handlers using user input. External link has `rel="noopener noreferrer"`. ✅
- **`__HTTPS_PORT__` substitution:** Present in `render_nginx.py` but not used in template — harmless dead code. No functional impact.
- **`__GW_PUBLIC_URL_PATH__` substitution:** Present in `render_nginx.py` but not used in template — harmless dead code. No functional impact.
- **No new bugs identified.**

### 3.2 `nginx.conf.tpl`

- **Ingress port:** `listen __INGRESS_PORT__` — substituted by `render_nginx.py`. ✅
- **Certs dir:** `alias __CERTS_DIR__/ca.crt` — substituted by `render_nginx.py`. ✅
- **Gateway internal port:** `proxy_pass http://127.0.0.1:__GATEWAY_INTERNAL_PORT__/` — substituted by `render_nginx.py`. ✅
- **TUI location:** Uses `root /etc/nginx/html` + `try_files $uri $uri/ =404` — correct, serves `tui/index.html` via `location ^~ /tui/`. ✅
- **Docs location:** Uses `root /etc/nginx/html` + `try_files $uri $uri/ =404` — correct, serves `docs/index.html`. ✅
- **HTTPS gateway block:** Only rendered when `ENABLE_HTTPS_PROXY=true` — correctly guarded in `render_nginx.py`. ✅
- **`__NGINX_ACCESS_LOG__`:** Replaced by either a `map` block (minimal mode suppressing HA health-check noise) or `access_log stdout`. ✅
- **Health endpoint:** `location = /api/health` returns `200 "OK\n"` with content-type — correct for landing page JS polling. ✅
- **Log endpoint:** `location = /api/logs` aliases `/config/clawd/logs/gateway_startup.log` — correct. ✅
- **No new bugs identified.**

### 3.3 `tui/index.html`

- **`/api/health` polling:** Fetches `/api/health` every 15s with `cache: 'no-store'` — correct. ✅
- **`/api/logs` display:** Shows last 40 lines of startup log, colored by severity. ✅
- **`window.isSecureContext` check:** Used to conditionally show the WebUI warning banner. ✅
- **`escapeHtml()` helper:** Prevents XSS in log lines — correct. ✅
- **No new bugs identified.**

### 3.4 `docs/index.html`

- **`/api/health` polling:** Refreshes gateway/ingress status every 15s. ✅
- **`__OPENCLAW_VERSION__`:** Correctly substituted by `render_nginx.py`. ✅
- **Version hiding:** If version shows `unknown`, the pill is hidden — correct defensive logic. ✅
- **HTTPS info:** Correctly documents when the WebUI tab is hidden (non-secure context → external link shown instead). ✅
- **No new bugs identified.**

### 3.5 `render_nginx.py`

- **Ingress/TUI/Docs flags:** `show_webui`, `show_terminal`, `show_tui`, `show_docs` read from env vars and rendered as JS booleans. ✅
- **`lan_https` public URL auto-construction:** When `enable_https=true` and no explicit public URL, auto-detects LAN IP and constructs `https://<lan_ip>:<https_port>`. ✅
- **Permissions:** `chmod 755/644` on output files — ensures nginx can read. ✅
- **`__NGINX_ACCESS_LOG__`:** Replaced before other substitutions — correct ordering. ✅
- **`__HTTPS_GATEWAY_BLOCK__`:** Only set non-empty when `enable_https=true`. ✅
- **No new bugs identified.**

### 3.6 `run.sh` — Ingress/TUI/Docs Sections

- **`ENABLE_WEBUI`/`ENABLE_TERMINAL`/`ENABLE_TUI`/`ENABLE_DOCS`:** All read from `options.json`, defaults provided. ✅
- **`TERMINAL_PORT` validation:** Regex `^[0-9]+$` + range check `1024–65535` — prevents nginx config injection. ✅
- **Env var export for `render_nginx.py`:** `SHOW_WEBUI`, `SHOW_TERMINAL`, `SHOW_TUI`, `SHOW_DOCS` exported (derived from `ENABLE_*` options). ✅
- **`INGRESS_PORT`:** Read from `config.yaml` (static HA Ingress port) — not dynamically from `options.json`, which is correct since HA manages the Ingress port separately. ✅
- **`GATEWAY_INTERNAL_PORT`:** Correctly set to `$GATEWAY_PORT + 1` for `lan_https` mode, else equal to `$GATEWAY_PORT`. ✅
- **No new bugs identified.**

### 3.7 `config.yaml`

- **`ingress_port: 49200`:** Static Ingress port — correct. ✅
- **`enable_webui: true`, `enable_terminal: true`, `enable_tui: true`, `enable_docs: true`:** All default to `true`. ✅
- **`terminal_port: 7681`:** Schema validates `int(1024,65535)`. ✅
- **`access_mode: custom`:** Default, with presets for `local_only`, `lan_https`, `lan_reverse_proxy`, `tailnet_https`. ✅
- **No new bugs identified.**

---

## 4. Verdict

## ✅ GO — Merge Ready

All 7 P0 bugs from the previous audit have been fixed. No new critical or moderate bugs were identified in the current review. The implementation is solid:

- All nginx template substitution gaps are closed
- Landing page JavaScript correctly handles Ingress iframe detection and external-link fallback
- TUI and docs both serve correctly via `root /etc/nginx/html` with proper `try_files`
- `render_nginx.py` handles both `custom` and `lan_https` modes correctly
- `run.sh` correctly validates `TERMINAL_PORT` and exports the right env vars
- No security issues found (XSS protection in TUI log display, proper `rel="noopener"` on external links, no nginx config injection vectors)

### Minor Observations (Non-Blocking)

| Item | Note | Impact |
|------|------|--------|
| `__HTTPS_PORT__` in `render_nginx.py` | Template substitution present but variable not used in `landing.html.tpl` | Dead code — harmless |
| `__GW_PUBLIC_URL_PATH__` in `render_nginx.py` | Template substitution present but not used in `landing.html.tpl` | Dead code — harmless |
| Docs hardcodes static model/port table | Docs shows example AI-stack ports, not dynamic | Informational only — docs purpose is reference |

These are cosmetic and do not affect functionality. No fix required.

---

## 5. Summary

| Check | Result |
|-------|--------|
| Previous 7 P0 bugs fixed | ✅ All |
| New critical bugs | ✅ None |
| New moderate bugs | ✅ None |
| Security issues | ✅ None |
| Template substitution completeness | ✅ All variables replaced |
| Landing page Ingress logic | ✅ Correct iframe/external-link handling |
| nginx location blocks (TUI, docs, webui, terminal) | ✅ All correct |
| `render_nginx.py` HTTPS guard | ✅ Only rendered when enabled |
| `run.sh` env var wiring | ✅ Correct |
| `config.yaml` schema validation | ✅ Correct |

**Recommendation: APPROVED for merge.**