# AUDIT: Landing Page Redesign v2 — Quick Check

## Status: OK

## Prüfergebnisse

| Check | Status | Anmerkung |
|-------|--------|-----------|
| `#contentHost` Höhe | ✅ | `.content` hat `min-height:240px` + `display:flex` via CSS |
| `#contentHost` display-Reset | ✅ | `style.display = any ? '' : 'none'` → '' bedeutet flex (Default aus CSS) |
| HTTP-Ingress WebUI | ✅ | Nutzt `window.top.location.href = cfg.external` statt `window.open` (Popup-Blocker-Problem gelöst) |
| iframe-src Pfade | ✅ | `./webui/`, `./terminal/`, `./tui/`, `./docs/` — stimmen mit nginx.conf.tpl überein |
| Click-Listener | ✅ | Alle `.nav-item`-Kacheln haben `addEventListener('click')` in Zeile ~120 |
| Template-Tokens | ✅ | `__OPENCLAW_VERSION__`, `__ACCESS_MODE__`, `__GATEWAY_TOKEN__`, `__GATEWAY_PUBLIC_URL__`, `__SHOW_WEBUI_JS__`, `__SHOW_TERMINAL_JS__`, `__SHOW_TUI_JS__`, `__SHOW_DOCS_JS__`, `__DISK_*__` — alle vorhanden |

## Keine kritischen Probleme gefunden.

Das `window.top.location.href`-Replacement für HTTP-Ingress ist korrekt und löst das Popup-Blocker-Problem.
