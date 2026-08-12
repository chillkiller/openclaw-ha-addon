# FINAL CODE REVIEW: OpenClaw HA Add-on Ingress-UI Refactor

**Auditor:** Iris (vision)
**Date:** 2026-08-12
**Status:** 🚫 NO-GO

---

## 1. Verdict: NO-GO

The current implementation of the Ingress-UI refactor is **non-functional**. While the architectural design of access mode presets and the HTTPS proxy is solid, the implementation contains multiple critical template substitution and pathing errors. 

If deployed as-is:
- **Nginx will fail to start** due to unsubstituted placeholders in the config.
- **The Landing Page will be blank** (showing "No services enabled") because JS flags are not rendered.
- **TUI and Docs will return 404** due to incorrect `root`/`alias` configurations.

---

## 2. Open Bugs (Critical P0)

### Template Substitution Failures (`render_nginx.py`)
The following placeholders are present in `.tpl` files but are **never** replaced in `render_nginx.py`:
- `__INGRESS_PORT__` (in `nginx.conf.tpl`) $\rightarrow$ Causes Nginx startup failure.
- `__CERTS_DIR__` (in `nginx.conf.tpl`) $\rightarrow$ Causes Nginx startup failure.
- `__GATEWAY_INTERNAL_PORT__` (in `nginx.conf.tpl`) $\rightarrow$ Causes Nginx startup failure in `lan_https` mode.
- `__SHOW_WEBUI_JS__`, `__SHOW_TERMINAL_JS__`, `__SHOW_TUI_JS__`, `__SHOW_DOCS_JS__` (in `landing.html.tpl`) $\rightarrow$ Causes all UI tabs to be hidden.

### Pathing & Routing Errors (`nginx.conf.tpl`)
- **Landing Root:** `root /var/www;` is used, but the file is written to `/etc/nginx/html/`. $\rightarrow$ Result: 404.
- **TUI Routing:** `try_files /tui.html =404;` is used, but the file is at `/tui/index.html`. $\rightarrow$ Result: 404.
- **Docs Routing:** Combination of `alias` and `try_files $uri` causes double-prefixing of the path. $\rightarrow$ Result: 404.

---

## 3. P0 Bug Resolution Check (vs `AUDIT-ingress-refactor.md`)

The previous audit (`AUDIT-ingress-refactor.md`) identified several critical issues. 

**Status:** **NOT FIXED.**
The bugs identified in the previous audit persist and have potentially expanded. The current state is a regression or a failure to implement the previous recommendations. Specifically, the template substitution logic in `render_nginx.py` remains incomplete, and the Nginx root paths are inconsistent with the filesystem layout defined in `run.sh`.

---

## 4. Required Fixes

| Priority | File | Action |
|----------|------|--------|
| **P0** | `render_nginx.py` | Implement replacements for all `__PORT__`, `__DIR__`, and `__SHOW_*_JS__` placeholders. |
| **P0** | `nginx.conf.tpl` | Change `root /var/www` to `root /etc/nginx/html`. |
| **P0** | `nginx.conf.tpl` | Fix TUI `try_files` to use `$uri $uri/ =404`. |
| **P0** | `nginx.conf.tpl` | Change Docs `alias` to `root /etc/nginx/html` for the `/docs/` location. |
