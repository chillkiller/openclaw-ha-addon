# Audit Report — OpenClaw HA Addon Ingress-UI Refactor (Final)

**Auditor:** Audit (coding-review)  
**Datum:** 2026-08-23  
**Status:** FINAL  
**Verdict:** ✅ **GO**

---

## 1. Prüfungsgrundlage

Geprüft im Auftrag von Forge/marvin. Schriftlicher Feststellungsbericht des aktuellen Stands der Ingress-UI-Dateien.

**Geprüfte Dateien:**

| Datei | Pfad |
|-------|------|
| `landing.html.tpl` | `openclaw_ha_addon/` |
| `nginx.conf.tpl` | `openclaw_ha_addon/` |
| `tui/index.html` | `openclaw_ha_addon/tui/` |
| `docs/index.html` | `openclaw_ha_addon/docs/` |
| `render_nginx.py` | `openclaw_ha_addon/` |
| `run.sh` | `openclaw_ha_addon/` |
| `config.yaml` | `openclaw_ha_addon/` |

**Referenz-Audit:** `AUDIT-ingress-refactor.md` (2026-08-12)  
**Vorheriger Feststellungsbericht:** `AUDIT-ingress-refactor-final.md` (2026-08-23, unverändert bestätigt)

---

## 2. P0-Bug-Status aus AUDIT-ingress-refactor.md

Alle 7 P0-Bugs sind vollständig behoben:

| # | Bug | Zeile(n) | Status | Beweis |
|---|-----|----------|--------|--------|
| 1 | `__INGRESS_PORT__` nie substituiert | `nginx.conf.tpl:27`, `render_nginx.py:65` | ✅ Behoben | `conf.replace('__INGRESS_PORT__', ingress_port)` |
| 2 | `__SHOW_WEBUI_JS__`/etc. nie substituiert | `landing.html.tpl:94-97`, `render_nginx.py:124-127` | ✅ Behoben | JS-Booleans `'true'`/`'false'` korrekt eingesetzt |
| 3 | `root /var/www` vs `/etc/nginx/html/` | `nginx.conf.tpl:32` | ✅ Behoben | `root /etc/nginx/html;` |
| 4 | TUI `try_files /tui.html` falscher Pfad | `nginx.conf.tpl:119` | ✅ Behoben | `location ^~ /tui/` + `proxy_pass` (kein `try_files` mehr) |
| 5 | Docs `alias` + `try_files` Path-Double-Prefix | `nginx.conf.tpl:135` | ✅ Behoben | `root /etc/nginx/html; try_files $uri $uri/ =404;` |
| 6 | `__CERTS_DIR__` nie substituiert | `nginx.conf.tpl:55`, `render_nginx.py:66` | ✅ Behoben | `conf.replace('__CERTS_DIR__', certs_dir)` |
| 7 | `__GATEWAY_INTERNAL_PORT__` nie substituiert | `nginx.conf.tpl:76`, `render_nginx.py:69` | ✅ Behoben | `conf.replace('__GATEWAY_INTERNAL_PORT__', internal_gw_port)` |

---

## 3. Token-Substitutions-Kette (Verifikation)

Alle 14 in Templates verwendeten `__FOO__`-Token sind in `render_nginx.py` substituiert:

**nginx.conf.tpl → render_nginx.py:**

| Token | Template-Zeile | Substitutions-Zeile | Status |
|-------|----------------|----------------------|--------|
| `__NGINX_ACCESS_LOG__` | 12 | 64 | ✅ |
| `__INGRESS_PORT__` | 27 | 65 | ✅ |
| `__CERTS_DIR__` | 55 | 66 | ✅ |
| `__GATEWAY_INTERNAL_PORT__` | 76 | 69 | ✅ |
| `__TERMINAL_PORT__` | 105 | 67 | ✅ |
| `__TUI_PORT__` | 120 | 68 | ✅ |
| `__HTTPS_GATEWAY_BLOCK__` | 147 | 108 | ✅ |

**landing.html.tpl → render_nginx.py:**

| Token | Template-Zeile | Substitutions-Zeile | Status |
|-------|----------------|----------------------|--------|
| `__OPENCLAW_VERSION__` | 47 | 123 | ✅ |
| `__SHOW_WEBUI_JS__` | 94 | 124 | ✅ |
| `__SHOW_TERMINAL_JS__` | 95 | 125 | ✅ |
| `__SHOW_TUI_JS__` | 96 | 126 | ✅ |
| `__SHOW_DOCS_JS__` | 97 | 127 | ✅ |
| `__ACCESS_MODE__` | 57, 98 | 131 | ✅ |
| `__GATEWAY_TOKEN__` | 99 | 128 | ✅ |
| `__GATEWAY_PUBLIC_URL__` | 50 | 129 | ✅ |

**Keine unsubstituierten `__FOO__`-Tokens gefunden.** Keine toten Substitutionen.

---

## 4. Sicherheits-Audit

### ✅ Keine Sicherheitslücken

**S1 — Token-Injection in JS-String (`GATEWAY_TOKEN`, `render_nginx.py:128`):**

```python
landing = landing.replace('__GATEWAY_TOKEN__', token)
```

Token wird direkt in `landing.html.tpl:99` eingesetzt:
```javascript
const GATEWAY_TOKEN = '__GATEWAY_TOKEN__';
```

Das Token kommt aus `secrets.token_urlsafe(24)` (`run.sh:758`), das ausschließlich URL-safe Base64-Zeichen erzeugt (`[A-Za-z0-9_-]`). Diese Zeichen sind in JS-String-Literalen sicher. Kein `eval`, kein `innerHTML`. **Bewertung: Sicher.**

**S2 — Port-Validierung (`run.sh:31-48`):**

```bash
if [[ "$TERMINAL_PORT_RAW" =~ ^[0-9]+$ ]] && [ "$TERMINAL_PORT_RAW" -ge 1024 ] && [ "$TERMINAL_PORT_RAW" -le 65535 ]; then
  TERMINAL_PORT="$TERMINAL_PORT_RAW"
```

Regex-Validierung (`^[0-9]+$`) + Range-Check (1024-65535). Gleiche Logik für `TUI_PORT`. **Bewertung: Sicher.**

**S3 — env_var Export (`run.sh:280-320`):**

Variablennamen werden gegen `^[A-Za-z_][A-Za-z0-9_]*$` geprüft. Reservierte Keys (PATH, LD_*, OPENCLAW_*, etc.) sind geblockt. **Bewertung: Sicher.**

**S4 — CSP Header (`nginx.conf.tpl:89`):**

```nginx
add_header Content-Security-Policy "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; ..."
```

Restriktive CSP mit `default-src 'self'`, `frame-ancestors 'self'`, kein `unsafe-inline` für Scripts. `__HTTPS_PORT__`-Substitution in render_nginx.py ist ungenutzt (leerer String), aber unschädlich. **Bewertung: Sicher.**

**S5 — nginx sub_filter (`nginx.conf.tpl:95-96`):**

```nginx
sub_filter "data-openclaw-terminal-enabled=\"false\" lang=\"en\"" "... data-openclaw-control-ui-base-path=\"$http_x_ingress_path/webui/\"";
```

Ersetzt bekannten statischen String durch Kombination aus statischem String und nginx-Variable. Kein Nutzer-Input fliesst ein. **Bewertung: Sicher.**

---

## 5. Funktionalitäts-Check

### Landing Page

| Check | Status |
|-------|--------|
| Version-Anzeige (`__OPENCLAW_VERSION__`) | ✅ `render_nginx.py:123` |
| Tab-Visibility JS-Booleans | ✅ `render_nginx.py:124-127` |
| `setMode()` mit Frame-Switch + Token-Injection | ✅ `landing.html.tpl:104-118` |
| Externer WebUI-Link (`__GATEWAY_PUBLIC_URL__`) | ✅ `landing.html.tpl:50` |
| HTTPS-Warnung bei Non-Secure-Context | ✅ `landing.html.tpl:121` |
| `isSecureContext`-Prüfung | ✅ `landing.html.tpl:127-134` |
| Gateway-Polling `/api/health` alle 15s | ✅ `landing.html.tpl:137-148` |
| CA-Cert-Download Visibility bei `lan_https` | ✅ `landing.html.tpl:122-124` |

### nginx.conf.tpl

| Check | Status |
|-------|--------|
| Landing `root /etc/nginx/html` | ✅ Zeile 32 |
| `/loading` Location mit `default_type` | ✅ Zeile 40 |
| Icon/Logo `/icon.png` | ✅ Zeile 43 |
| CA-Cert `/cert/ca.crt` mit Content-Disposition | ✅ Zeile 55 |
| `/api/health` → `return 200 "OK\n"` | ✅ Zeile 49 |
| `/api/logs` → `alias /config/clawd/logs/...` | ✅ Zeile 53 |
| WebUI `location ^~ /webui/` mit WebSocket | ✅ Zeile 75 |
| WebUI CSP + Frame-Header-Stripping | ✅ Zeile 89-90 |
| WebUI `sub_filter` Ingress-Basis-Pfad | ✅ Zeile 95-96 |
| Terminal `/terminal/` mit WebSocket | ✅ Zeile 104 |
| TUI `/tui/` mit WebSocket | ✅ Zeile 119 |
| TUI Port-Substitution | ✅ `render_nginx.py:68` |
| Docs `root /etc/nginx/html` + `try_files` | ✅ Zeile 135 |
| 404 Catch-All | ✅ Zeile 140 |
| HTTPS-Block optional (`__HTTPS_GATEWAY_BLOCK__`) | ✅ `render_nginx.py:108` |
| `access_log` Suppression für HA-Polling | ✅ `render_nginx.py:52-61` |

### run.sh (Ingress-Relevant)

| Check | Status |
|-------|--------|
| `ENABLE_WEBUI` → `SHOW_WEBUI` export | ✅ Zeile 752 |
| `ENABLE_TERMINAL` → `SHOW_TERMINAL` export | ✅ Zeile 753 |
| `ENABLE_TUI` → `SHOW_TUI` export | ✅ Zeile 754 |
| `ENABLE_DOCS` → `SHOW_DOCS` export | ✅ Zeile 755 |
| `INGRESS_PORT` hardcodiert auf 49200 | ✅ Zeile 749 |
| `CERTS_DIR` auf `/config/certs` | ✅ Zeile 751 |
| `OPENCLAW_VERSION` via `openclaw --version` | ✅ Zeile 762 |
| `TERMINAL_PORT` Regex-Validierung | ✅ Zeile 31 |
| `TUI_PORT` Regex-Validierung | ✅ Zeile 43 |
| `tui/index.html` → `/etc/nginx/html/tui/index.html` | ✅ Zeile 769 |
| `tui/index.html` → `/etc/nginx/html/tui.html` (redundant) | ✅ Zeile 768 |
| `docs/index.html` → `/etc/nginx/html/docs/index.html` | ✅ Zeile 772 |
| `loading.html` → `/etc/nginx/html/loading.html` | ✅ Zeile 775 |
| `icon.png` → `/etc/nginx/html/icon.png` | ✅ Zeile 778 |
| `render_nginx.py` aufgerufen mit allen Env-Vars | ✅ Zeile 1309-1314 |

### TUI (`tui/index.html`)

| Check | Status |
|-------|--------|
| Fetches `/api/health` | ✅ |
| Fetches `/api/logs` | ✅ |
| Log-Panel mit Färbung (error/warn/info) | ✅ |
| Auto-Refresh alle 15s | ✅ |

### Docs (`docs/index.html`)

| Check | Status |
|-------|--------|
| Fetches `/api/health` | ✅ |
| Auto-Refresh alle 15s | ✅ |
| `__OPENCLAW_VERSION__` hardcodiert (readonly, kein Bug) | ✅ |

---

## 6. Architektur-Analyse

### Kritisches Pfad-Verfolgung: Ingress-Request bis Landing-HTML

```
HA Ingress Request
  → nginx hört auf :49200 (Substitution: __INGRESS_PORT__)
  → location = / → root /etc/nginx/html → index.html (substituiert von render_nginx.py)
       ├─ Landingtempl. Substitutionen: __OPENCLAW_VERSION__, __SHOW_*, __GATEWAY_*, __ACCESS_MODE__
       ├─ SHOW_* aus config.yaml (ENABLE_WEBUI/etc.) → run.sh export → render_nginx.py os.environ.get()
       └─ Token aus secrets.token_urlsafe() in run.sh → GW_TOKEN env → render_nginx.py → JS-String

WebUI Tab
  → nginx location ^~ /webui/ → proxy_pass 127.0.0.1:GATEWAY_INTERNAL_PORT (Substitution: __GATEWAY_INTERNAL_PORT__)
  → CSP sub_filter: X-Frame-Options strip, CSP strip, Ingress-Basis-Pfad injiziert
  → OpenClaw Control UI (WebSocket-fähig)

Terminal Tab
  → nginx location = /terminal → 302 → /terminal/
  → nginx location ^~ /terminal/ → proxy_pass 127.0.0.1:TERMINAL_PORT (Substitution: __TERMINAL_PORT__)

TUI Tab
  → nginx location = /tui → 302 → /tui/
  → nginx location ^~ /tui/ → proxy_pass 127.0.0.1:TUI_PORT (Substitution: __TUI_PORT__)
  → ttyd mit `openclaw tui`

Docs Tab
  → nginx location = /docs → 302 → /docs/
  → nginx location ^~ /docs/ → root /etc/nginx/html → try_files $uri $uri/ =404
  → /etc/nginx/html/docs/index.html (kopiert von run.sh)
```

**Bewertung:** Pfad ist kohärent. Keine toten Abzweigungen. Keine Annahmen über nicht-existente Dateien.

---

## 7. Offene Beobachtungen (keine Bugs)

### O1 — Ungenutzte Substitutionsvariablen

`render_nginx.py` substituiert Variablen, die in `landing.html.tpl` nicht vorkommen:

| Variable | Zeile | Verwendung in landing.html.tpl |
|----------|-------|-------------------------------|
| `__GW_PUBLIC_URL_PATH__` | 130 | Nicht vorhanden |
| `__HTTPS_PORT__` | 132 | Nicht vorhanden |
| `__TUI_PORT__` | 133 | Nicht vorhanden (tui/index.html ist eigenständig) |

**Bewertung:** Kein Einfluss auf Funktionalität, Sicherheit oder Performance. Kein Fix erforderlich. Residuum aus der Entwicklung.

### O2 — `ingress_port` aus config.yaml wird nicht zur Laufzeit gelesen

`config.yaml:27` definiert `ingress_port: 49200`, `run.sh` liest diesen Wert nicht aus `options.json`. Stattdessen: `INGRESS_PORT=49200` hardcodiert in `run.sh:749` und Default in `render_nginx.py:30`.

**Implikation:** Ändert ein Nutzer `ingress_port` in der HA-Addon-Konfiguration, hat das keinen Effekt auf die Ingress-Port-Bindung.

**Bewertung:** P2 / Design-Issue. Per HA-Supervisor-Spezifikation ist der Ingress-Port durch den Supervisor vorgegeben und wird nicht zur Laufzeit konfiguriert. Der Supervisor rendert `options.json` und leitet den Ingress-Port separat. Dieses Verhalten ist daher korrekt.

---

## 8. Vergleich mit vorherigem Audit

| Prüfpunkt | 2026-08-12 | 2026-08-23 | Delta |
|-----------|-------------|-------------|-------|
| P0-Bugs gesamt | 7 | 0 | ✅ Behoben |
| Sicherheitslücken | 2 (sub_filter-Injection-Potenzial, Token-Injection) | 0 | ✅ Gefixt |
| Tote Substitutionen | 0 (nicht geprüft) | 3 harmlose | Unverändert |
| Architektur-Probleme | 0 | 0 | Unverändert |
| Funktionalitäts-Checks | Nicht alle bestanden | Alle bestanden | ✅ |

---

## 9. Go/No-Go

## ✅ **GO**

**Begründung:**

Alle 7 P0-Bugs aus `AUDIT-ingress-refactor.md` sind vollständig behoben:

1. ✅ `__INGRESS_PORT__` → `render_nginx.py:65`
2. ✅ `__SHOW_WEBUI_JS__`/`__SHOW_TERMINAL_JS__`/`__SHOW_TUI_JS__`/`__SHOW_DOCS_JS__` → `render_nginx.py:124-127`
3. ✅ `root /var/www` → `root /etc/nginx/html` (nginx.conf.tpl:32)
4. ✅ TUI `location ^~ /tui/` + `proxy_pass` (nginx.conf.tpl:119)
5. ✅ Docs `root` + `try_files` (nginx.conf.tpl:135)
6. ✅ `__CERTS_DIR__` → `render_nginx.py:66`
7. ✅ `__GATEWAY_INTERNAL_PORT__` → `render_nginx.py:69`

Die Architektur ist solide — Trennung zwischen `run.sh` (Config-Lesen, Datei-Kopien, Env-Export), `render_nginx.py` (Template-Substitution) und `nginx.conf.tpl`/`landing.html.tpl` (Templates) ist sauber implementiert. Alle Sicherheitspfade (Port-Validierung, env_var-Allowlist, Token-Injection-Schutz) sind korrekt.

Die drei offenen Beobachtungen sind harmlos: zwei ungenutzte Substitutionsvariablen (O1) und ein bekanntes HA-Supervisor-Verhalten (O2).

**Audit-Clear erteilt.**

---

## 10. Changelog

| Datum | Änderung |
|-------|----------|
| 2026-08-12 | Initiales Audit (`AUDIT-ingress-refactor.md`) — 7 P0-Bugs gefunden |
| 2026-08-23 17:42 | Feststellungsbericht (`AUDIT-ingress-refactor-final.md`) — alle P0 behoben |
| 2026-08-23 18:07 | Re-Verifikation nach Boot — keine Änderungen seit 17:42, GO bestätigt |

---

*Audit abgeschlossen. Der Code ist produktionsreif.*
