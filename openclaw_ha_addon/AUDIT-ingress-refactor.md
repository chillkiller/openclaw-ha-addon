# Audit Report — OpenClaw HA Addon Ingress-UI Refactor

**Auditor:** coding-review subagent  
**Date:** 2026-08-12  
**Reference:** Hermes HA Addon (`/tmp/hermes-ha-addon/hermes_agent/`)  
**Subject:** Ingress-UI files (landing.html.tpl, nginx.conf.tpl, tui/index.html, docs/index.html)

---

## 1. Files Audited

| File | Path |
|------|------|
| landing.html.tpl | `openclaw_ha_addon/landing.html.tpl` |
| nginx.conf.tpl | `openclaw_ha_addon/nginx.conf.tpl` |
| tui/index.html | `openclaw_ha_addon/tui/index.html` |
| docs/index.html | `openclaw_ha_addon/docs/index.html` |

Reference: `hermes_agent/landing.html.tpl`, `hermes_agent/nginx.conf.tpl`, `hermes_agent/loading.html`

---

## 2. Verdict

**🚫 NO-GO** — Multiple critical template substitution bugs prevent nginx from starting correctly. All affected service paths (landing, TUI, docs) fail at runtime. The add-on would start but the Ingress UI would be blank/non-functional.

---

## 3. Critical Bugs

### Bug #1 — `__INGRESS_PORT__` never substituted in nginx.conf.tpl

**File:** `nginx.conf.tpl`  
**Line:** `listen __INGRESS_PORT__;`

`render_nginx.py` does NOT perform `conf.replace('__INGRESS_PORT__', ingress_port)`. The literal string `__INGRESS_PORT__` would be passed to nginx, causing a configuration error and preventing nginx from starting.

**Impact:** nginx fails to start → Ingress unavailable.

**Fix:** Add `conf = conf.replace('__INGRESS_PORT__', os.environ.get('INGRESS_PORT', '80'))` in render_nginx.py.

---

### Bug #2 — `__SHOW_WEBUI_JS__`, `__SHOW_TERMINAL_JS__`, `__SHOW_TUI_JS__`, `__SHOW_DOCS_JS__` never substituted in landing.html.tpl

**File:** `landing.html.tpl`  
**Lines:** ~62 — JavaScript `isEnabled()` function

`landing.html.tpl` contains Python format-string markers `__SHOW_WEBUI_JS__`, `__SHOW_TERMINAL_JS__`, `__SHOW_TUI_JS__`, `__SHOW_DOCS_JS__` that are NEVER replaced by `render_nginx.py`. The landing page JavaScript ends up with undefined variables:

```javascript
const SHOW_WEBUI = __SHOW_WEBUI_JS__;   // undefined
const SHOW_TERMINAL = __SHOW_TERMINAL_JS__; // undefined
const SHOW_TUI = __SHOW_TUI_JS__;        // undefined
const SHOW_DOCS = __SHOW_DOCS_JS__;      // undefined
```

Since `undefined` is falsy, `isEnabled()` returns false for ALL services, `updateVisibility()` shows the "No services enabled" message, and the entire Ingress UI is blank.

**Impact:** Landing page is completely non-functional; all Ingress tabs are hidden.

**Fix:** Add `landing = landing.replace('__SHOW_WEBUI_JS__', 'true' if show_webui else 'false')` (and for terminal/tui/docs) in render_nginx.py.

---

### Bug #3 — Landing page `root /var/www` vs actual path `/etc/nginx/html/`

**File:** `nginx.conf.tpl`  
**Line:** `root /var/www;`

The landing location block specifies `root /var/www`. But `render_nginx.py` writes the rendered landing page to `/etc/nginx/html/index.html`. There is no step that copies the file to `/var/www/`.

**Impact:** nginx would serve a 404 for the landing page at `/`.

**Fix:** Change `root /var/www` to `root /etc/nginx/html` in nginx.conf.tpl.

---

### Bug #4 — TUI `try_files /tui.html` wrong path

**File:** `nginx.conf.tpl`  
**Line:** `try_files /tui.html =404;`

The TUI HTML file is at `/etc/nginx/html/tui/index.html` (copied by `run.sh` from `tui/index.html`). The directive `try_files /tui.html` looks for a file literally named `tui.html` at `/etc/nginx/html/tui.html` — which does not exist. Falls through to `=404`.

**Impact:** `/tui/` returns 404 instead of the dashboard.

**Fix:** Change to `try_files $uri $uri/ =404;`

---

### Bug #5 — Docs `alias /etc/nginx/html/docs/` + `try_files $uri` broken

**File:** `nginx.conf.tpl`  
**Lines:** `alias /etc/nginx/html/docs/;` + `try_files $uri $uri/ =404;`

The combination of `alias` with a path (`/etc/nginx/html/docs/`) and `try_files $uri` is broken. With `alias`, `$uri` in `try_files` includes the full request URI including the `/docs/` prefix. So nginx looks for `/etc/nginx/html/docs//docs/` inside the alias root, which double-prefixes the path.

**Impact:** `/docs/` and all doc pages return 404.

**Fix:** Change to `location ^~ /docs/` with `root /etc/nginx/html` and `try_files $uri $uri/ =404`.

---

### Bug #6 — `__CERTS_DIR__` never substituted in nginx.conf.tpl

**File:** `nginx.conf.tpl`  
**Line:** `alias __CERTS_DIR__/ca.crt;`

`render_nginx.py` does NOT replace `__CERTS_DIR__`. The CA cert download link (`/cert/ca.crt`) would fail with an nginx config error.

**Fix:** Add `conf = conf.replace('__CERTS_DIR__', os.environ.get('CERTS_DIR', '/etc/nginx/certs'))` in render_nginx.py.

---

### Bug #7 — `__GATEWAY_INTERNAL_PORT__` never substituted in nginx.conf.tpl

**File:** `nginx.conf.tpl`  
**Line:** `proxy_pass http://127.0.0.1:__GATEWAY_INTERNAL_PORT__/;`

`render_nginx.py` does NOT replace `__GATEWAY_INTERNAL_PORT__`. The WebUI proxy pass would fail with an nginx config error in `lan_https` mode.

**Fix:** Pass `GATEWAY_INTERNAL_PORT` env var and substitute it in render_nginx.py.

---

## 4. Moderate Issues

### Issue #8 — `__HTTPS_GATEWAY_BLOCK__` in nginx.conf.tpl unconditionally appended

**File:** `nginx.conf.tpl`  
**Line:** `__HTTPS_GATEWAY_BLOCK__`

When `ENABLE_HTTPS_PROXY=false`, `https_block` is an empty string, but the `__HTTPS_GATEWAY_BLOCK__` marker is still present in the config (blank line). This is cosmetic but inconsistent with the style of other optional blocks.

**Impact:** Minor. Config is valid but has an extra blank line in non-HTTPS modes.

---

### Issue #9 — Docs/index.html hardcodes example data (static mock, not dynamic)

**File:** `docs/index.html`  
**Lines:** 40–46

The docs page hardcodes model name `ollama/glm-5.2:cloud`, thinking mode `medium`, and example token usage. This is static placeholder content. The tui/index.html fetches live data from `/api/health` and `/api/logs` (correct), but the docs page has no dynamic data fetching at all.

**Impact:** Information displayed in docs may be stale/wrong. Not critical since docs is informational.

---

### Issue #10 — Missing `loading.html` fallback page

**Reference:** Hermes has `loading.html` (auto-refresh page shown during startup).  
**OpenClaw:** No equivalent.

The absence means users who access the Ingress URL during startup see a blank screen or browser error instead of a retry page.

**Impact:** Minor UX issue during startup window.

---

## 5. Comparison with Hermes Reference

| Feature | Hermes | OpenClaw | Status |
|---------|--------|----------|--------|
| Landing page template substitution | ✅ Complete (profiles, show flags, api status, dashboard) | ❌ Multiple missing (`__SHOW_*__`, `__CERTS_DIR__`, `__INGRESS_PORT__`) | Broken |
| Nginx landing root path | ✅ Correct | ❌ `root /var/www` vs actual `/etc/nginx/html/` | Broken |
| TUI `try_files` | N/A (no static TUI) | ❌ `try_files /tui.html` wrong path | Broken |
| Docs `try_files` + `alias` | N/A | ❌ Path double-prefix bug | Broken |
| HTTPS proxy block | ✅ Separate `nginx-ports.conf.tpl` | ⚠️ Embedded in main config but empty when disabled | Works |
| Loading/boot page | ✅ `loading.html` | ❌ Missing | Missing |
| Dynamic TUI data | N/A | ✅ Fetches from `/api/health` and `/api/logs` | OK |
| Access mode presets | N/A | ✅ Well-designed (`local_only`, `lan_https`, `tailnet_https`) | Good |

---

## 6. Summary of Required Fixes (Priority Order)

| Priority | File | Issue | Effort |
|----------|------|-------|--------|
| P0 | `render_nginx.py` | Add `__INGRESS_PORT__` substitution | 1 line |
| P0 | `render_nginx.py` | Add `__SHOW_WEBUI_JS__`/`__SHOW_TERMINAL_JS__`/`__SHOW_TUI_JS__`/`__SHOW_DOCS_JS__` substitution | 4 lines |
| P0 | `nginx.conf.tpl` | Change `root /var/www` → `root /etc/nginx/html` | 1 line |
| P0 | `nginx.conf.tpl` | Fix TUI `try_files /tui.html` → `try_files $uri $uri/ =404` | 1 line |
| P0 | `nginx.conf.tpl` | Fix docs `alias` + `try_files` combo (use `root` instead) | 2 lines |
| P0 | `render_nginx.py` | Add `__CERTS_DIR__` substitution | 1 line |
| P0 | `render_nginx.py` | Add `__GATEWAY_INTERNAL_PORT__` substitution | 1 line |
| P1 | `docs/index.html` | Replace hardcoded model/think values with live fetches | Medium |
| P2 | (new file) | Add `loading.html` startup page | Small |

---

## 7. Go / No-Go Recommendation

**🚫 NO-GO** — Do not merge as-is.

The seven P0 bugs are template-substitution failures that would cause nginx to either (a) fail to start entirely (`__INGRESS_PORT__`, `__CERTS_DIR__`, `__GATEWAY_INTERNAL_PORT__`) or (b) render a completely blank Ingress UI (`__SHOW_*__` missing) or (c) 404 on TUI and docs paths. None of the Ingress features would work in a fresh deployment.

The access-mode preset architecture and HTTPS proxy design are solid and should be preserved. The fixes are localized to `render_nginx.py` (missing substitution calls) and `nginx.conf.tpl` (correcting the `root` vs `alias` confusion for docs/TUI).

Once the 7 P0 items are addressed and the TUI/docs paths are confirmed to serve correctly, this is likely mergeable.
