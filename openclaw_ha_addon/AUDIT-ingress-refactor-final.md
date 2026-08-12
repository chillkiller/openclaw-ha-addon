# Final Audit — OpenClaw HA Addon Ingress-UI Refactor

**Auditor:** coding-review subagent  
**Date:** 2026-08-12 (follow-up)  
**Previous Audit:** `AUDIT-ingress-refactor.md` (2026-08-12)  
**Subject:** Ingress-UI files — current state after fixes

---

## 1. Files Audited (This Round)

| File | Path |
|------|------|
| `landing.html.tpl` | `openclaw_ha_addon/landing.html.tpl` |
| `nginx.conf.tpl` | `openclaw_ha_addon/nginx.conf.tpl` |
| `tui/index.html` | `openclaw_ha_addon/tui/index.html` |
| `docs/index.html` | `openclaw_ha_addon/docs/index.html` |
| `render_nginx.py` | `openclaw_ha_addon/render_nginx.py` |
| `run.sh` | `openclaw_ha_addon/run.sh` (Ingress/TUI/docs/env-var sections) |
| `config.yaml` | `openclaw_ha_addon/config.yaml` (ingress_port, enable_* flags) |

---

## 2. P0 Bug Status — Previous Audit Items

All 7 P0 bugs from the previous audit have been **individually verified fixed** in `render_nginx.py` and/or `nginx.conf.tpl`:

| # | Bug | File | Status |
|---|-----|------|--------|
| 1 | `__INGRESS_PORT__` not substituted | `render_nginx.py` | ✅ **FIXED** — `conf.replace('__INGRESS_PORT__', ingress_port)` present (line ~67) |
| 2 | `__SHOW_WEBUI_JS__` et al. not substituted | `render_nginx.py` | ✅ **FIXED** — all 4 flags replaced with `'true'`/`'false'` (lines ~104–107) |
| 3 | `root /var/www` vs actual `/etc/nginx/html/` | `nginx.conf.tpl` | ✅ **FIXED** — `root /etc/nginx/html` used for all locations |
| 4 | TUI `try_files /tui.html` wrong path | `nginx.conf.tpl` | ✅ **FIXED** — `try_files $uri $uri/ =404` |
| 5 | Docs `alias` + `try_files $uri` double-prefix bug | `nginx.conf.tpl` | ✅ **FIXED** — `root /etc/nginx/html` + `try_files $uri $uri/ =404` |
| 6 | `__CERTS_DIR__` not substituted | `render_nginx.py` | ✅ **FIXED** — `conf.replace('__CERTS_DIR__', certs_dir)` present |
| 7 | `__GATEWAY_INTERNAL_PORT__` not substituted | `render_nginx.py` | ✅ **FIXED** — `conf.replace('__GATEWAY_INTERNAL_PORT__', internal_gw_port)` present |

---

## 3. New / Remaining Bug Found

### Bug #8 — `run.sh` hardcodes port 48099 for nginx lifecycle; `config.yaml` uses 49200

**Severity:** Medium (latent bug; nginx starts correctly on 49200 but lifecycle commands hit wrong port)

**Details:**

`config.yaml` defines `ingress_port: 49200`. `run.sh` sets `INGRESS_PORT=49200` and passes it to `render_nginx.py`, which correctly substitutes `__INGRESS_PORT__` in `nginx.conf.tpl`. **nginx therefore starts on port 49200** — this is correct.

However, `run.sh` contains hardcoded references to port `48099` for nginx management:

| Line | Code | Issue |
|------|------|-------|
| ~1176 | `ss -tlnp … grep ':48099 '` | Health check looks at wrong port |
| ~1181 | `ss -tlnp … grep ':48099 '` | Pre-start port-occupancy check against 48099 |
| ~1182 | `"Port 48099 still in use…"` | Warning message says 48099 |
| ~1242 | `"Starting ingress proxy (nginx) on :48099"` | Startup message says 48099 |

**Impact:**
- The startup message is misleading (nginx actually listens on 49200)
- The pre-start port check tests 48099 instead of 49200 — false negative (48099 free ≠ 49200 free)
- The stop logic (`kill $(cat $PIDFILE)`) would still work since it uses the PID file, not the port
- The `ss … grep :48099` health check after start would always report "not found" even when nginx IS running

**Fix:** Replace all `48099` occurrences in run.sh with `$(cat $INGRESS_PORT)` or the actual port variable. Ideally, set `ACTUAL_INGRESS_PORT` after reading `ingress_port` from options.json and use that consistently.

---

## 4. Informational Notes (Not Blockers)

### Note A — `__HTTPS_GATEWAY_BLOCK__` leaves blank line when HTTPS disabled

When `ENABLE_HTTPS_PROXY=false`, `https_block = ''` and the substitution in `nginx.conf.tpl` leaves the `__HTTPS_GATEWAY_BLOCK__` line as a blank line. This is syntactically valid for nginx and has no runtime impact. Previous audit called this Issue #8; downgraded to informational.

### Note B — `docs/index.html` contains hardcoded example data

`tui/index.html` correctly fetches live data from `/api/health` and `/api/logs`. `docs/index.html` has static content (e.g., hardcoded port numbers). This is intentional — docs is meant as a reference page, not a live dashboard. Not a bug.

### Note C — TUI served at both `/tui/` and `/tui.html`

`run.sh` copies `tui/index.html` to both:
- `/etc/nginx/html/tui/index.html` (matches nginx `location ^~ /tui/`)
- `/etc/nginx/html/tui.html` (as a side-effect of the double cp)

The `try_files $uri $uri/ =404` correctly serves `/tui/` from the directory. The extra `/tui.html` copy is harmless.

---

## 5. config.yaml Verification

| Option | Default | Schema Valid | Consumed By |
|--------|---------|--------------|-------------|
| `ingress_port` | `49200` | `int(1,65535)` ✅ | `render_nginx.py` → `__INGRESS_PORT__` |
| `enable_webui` | `true` | `bool?` ✅ | `run.sh` → `SHOW_WEBUI` → `render_nginx.py` |
| `enable_terminal` | `true` | `bool?` ✅ | `run.sh` → `SHOW_TERMINAL` → `render_nginx.py` |
| `enable_tui` | `true` | `bool?` ✅ | `run.sh` → `SHOW_TUI` → `render_nginx.py` |
| `enable_docs` | `true` | `bool?` ✅ | `run.sh` → `SHOW_DOCS` → `render_nginx.py` |

All Ingress-related config options are correctly wired from `config.yaml` → `run.sh` environment variables → `render_nginx.py` → template substitutions.

---

## 6. Summary

| Category | Count |
|----------|-------|
| P0 bugs from previous audit | 7 — all FIXED ✅ |
| New bug found | 1 (Bug #8 — run.sh port 48099 vs 49200) |
| Informational notes | 2 (cosmetic/no impact) |
| Config wiring issues | 0 ✅ |

---

## 7. Go / No-Go Recommendation

**✅ GO — with one known medium-priority bug**

**Reasoning:**

All 7 P0 template-substitution bugs from the previous audit have been confirmed fixed. The nginx config is syntactically correct, all substitutions are in place, and the access-mode preset architecture is sound. Ingress would start and serve all four tabs (WebUI, Terminal, TUI, Docs) correctly.

The one remaining issue (Bug #8 — `run.sh` hardcoded port 48099) does **not** prevent nginx from starting correctly on the right port (49200). It causes misleading log messages and a faulty port-check, but the PID-file-based lifecycle management still works. It should be fixed before release, but it is not a blocker.

**Fix for Bug #8** (1 line in run.sh, or a find-replace):
```bash
# In run.sh, replace the hardcoded 48099 with the actual ingress port:
INGRESS_PORT=49200  # already correct; just remove the 48099 references
```

**After that fix: merge at discretion.** The Ingress UI refactor is functionally complete and ready.
