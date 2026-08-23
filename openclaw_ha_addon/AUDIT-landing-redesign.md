# Audit: Landing Page Redesign

**Datei:** `landing.html.tpl` (neu) vs `landing.html.tpl.v0.7.9.23.bak` (alt)  
**Datum:** 2026-08-23  
**Reviewer:** coding-review subagent

---

## 1. Design-Bewertung

**GO** — Die neue Seite ist visuell deutlich näher am Home Assistant Material Design 3.

| Kriterium | Alt | Neu |
|-----------|-----|-----|
| HA-Dark-Farbpalette (CSS Variables) | ❌ Eigenes Design (#0b0f14) | ✅ `--ha-bg: #111416`, `--ha-card: #1c1c21` etc. |
| Abgerundete Cards (12px) | ❌ Eckig | ✅ |
| Chip-Badges für Status | ❌ Button-Style | ✅ Pill/Chip-Style |
| Flexibles Grid für Tabs | ❌ Button-Leiste | ✅ `grid-template-columns: repeat(auto-fit, ...)` |
| Viewport `viewport-fit=cover` | ❌ Fehlt | ✅ (notwendig für iOS Safe Area) |
| Mobile Breakpoint | ❌ Nur `640px` | ✅ `480px` (feiner) |
| Sprache `lang="de"` | ❌ `lang="en"` | ✅ |
| Deutsche Texte in deutschen UI | ❌ Mix (En/De) | ✅ Konsistent Deutsch |

### Fehlende Elemente im Vergleich zum alten Design

- ❌ **CA-Zertifikat-Download-Button** (`lan_https`-Modus): Der alte `.btn.green.small #btnCert` fehlt komplett.
  → Nginx-Config hat `/cert/ca.crt` noch, aber kein UI-Button mehr.
- ❌ **Disk-Usage-Anzeige**: Alt zeigte `DISK_TOTAL / DISK_USED / DISK_AVAIL` in der Footer-Region.
  → Die Token `__DISK_TOTAL__` etc. werden in `render_nginx.py` ersetzt, aber im neuen Template nirgends verwendet.

---

## 2. Funktionalitäts-Check

| Feature | Status | Bemerkung |
|---------|--------|-----------|
| Tabs: WebUI, Terminal, TUI, Docs | ✅ | Alle 4 vorhanden |
| Token-Injection (`__GATEWAY_TOKEN__`) | ⚠️ | Token wird in URL eingebaut, aber **nicht HTML-escaped** (→ Security, s.u.) |
| External WebUI bei HTTP | ✅ | `window.open(cfg.external, '_blank')` |
| Secure-Context-Check | ✅ | `window.isSecureContext && window.top !== window` |
| `iframe` Visibility-Toggle pro Tab | ✅ | `updateVisibility()` + CSS `.hidden` |
| Health-Polling (15s) | ✅ | `pollGateway()` + `setInterval` |
| Ingress-Status-Badge | ✅ | `statusIngress`永远是`connected` |
| Auto-Load erster Tab | ✅ | `for mode of ['webui', 'terminal', 'tui', 'docs']` |

---

## 3. Sicherheitsanalyse

### 🔴 Medium: Token nicht HTML-escaped

**Datei:** `landing.html.tpl`, Zeile ~122

```javascript
const GATEWAY_TOKEN = '__GATEWAY_TOKEN__';
// ...
src: './webui/?token=' + encodeURIComponent(GATEWAY_TOKEN),
```

`render_nginx.py` macht **keine** HTML-Escaping:

```python
landing = landing.replace('__GATEWAY_TOKEN__', token)  # Kein html.escape!
```

**Szenario:** Wenn `GW_TOKEN` in der Config einen Wert wie `test"><script>alert(1)</script>` enthält, wird das als Teil des `<script>`-Blocks substituiert → **gespeichertes XSS**.

**Workaround (LOW severity):** Token kommt aus `run.sh` via `openclaw status token` oder Config-File. Unter normalen HA-Addon-Bedingungen hat nur der Addon-Admin Zugriff darauf. Dennoch: **Sollte gefixt werden.**

**Empfohlener Fix in `render_nginx.py`:**

```python
import html
# ...
landing = landing.replace('__GATEWAY_TOKEN__', html.escape(token, quote=True))
```

### 🟢 Sonst sicher

- `public_url` wird in `window.open()` und `href` verwendet — aber nur über `__GATEWAY_PUBLIC_URL__` eingesetzt, kein User-Input
- CSP-Header in nginx.conf.tpl ist streng und korrekt
- `X-Frame-Options` / `Content-Security-Policy` werden für HA Ingress korrekt gehandhabt
- Keine `innerHTML` oder `document.write` mit unsicheren Daten

---

## 4. Ungenutzte / Defekte Token

| Token | Ersetzt in `render_nginx.py`? | Im neuen Template verwendet? | Problem |
|-------|-------------------------------|------------------------------|---------|
| `__GW_PUBLIC_URL_PATH__` | ✅ | ❌ | Taucht im Template nicht auf — ungenutzt, kein Bug |
| `__HTTPS_PORT__` | ✅ | ❌ | Taucht im Template nicht auf — ungenutzt, kein Bug |
| `__TUI_PORT__` | ✅ | ❌ | Taucht im Template nicht auf — ungenutzt, kein Bug |
| `__DISK_TOTAL__` etc. | ✅ | ❌ | Fehlt im UI — **Feature-Verlust** |
| `__ACCESS_MODE__` | ✅ | ✅ (Textersetzung) | ✅ Korrekt |
| `__OPENCLAW_VERSION__` | ✅ | ✅ | ✅ Korrekt |

---

## 5. Referenz-Vergleich (Hermes-Muster)

Das Hermes-Referenzverzeichnis `/tmp/hermes-ha-addon/hermes_agent/` war zum Audit-Zeitpunkt nicht vorhanden (`ENOENT`). Der Vergleich konnte daher nicht durchgeführt werden.

---

## 6. Empfehlung

### GO (mit 2 Hinweisen)

Die Landing-Page-Neugestaltung ist **funktional, sicher und designtechnisch deutlich besser** als die alte Version. Sie passt zum HA-Iframe-Stil und alle Kern-Features funktionieren.

**Hinweis 1 (Medium):** `__GATEWAY_TOKEN__` in `render_nginx.py` mit `html.escape()` escapen. Das ist der einzige echte Sicherheitshinweis.

**Hinweis 2 (Low):** Entweder den CA-Zertifikat-Download-Button wieder hinzufügen (für `lan_https`-Nutzer) oder die nginx-Config-Zeile `/cert/ca.crt` entfernen, um Verwirrung zu vermeiden.

**Hinweis 3 (cosmetic):** Falls Disk-Usage-Anzeige gewünscht ist, die alten Token wieder ins Template einbauen.

### Konkrete Fixes

1. **`render_nginx.py` Zeile ~98:**

```python
import html
# ...
landing = landing.replace('__GATEWAY_TOKEN__', html.escape(token, quote=True))
```

2. **`landing.html.tpl` — CA-Button wiederherstellen** (optional, falls `lan_https` unterstützt werden soll):

```html
<!-- Irgendwo in der .header oder .status-row -->
<a class="btn green small" id="btnCert" href="./cert/ca.crt" download="openclaw-ca.crt">CA Cert</a>
```

3. **Config-Änderung in `render_nginx.py` für `ACCESS_MODE` Badge:** Das Token `__ACCESS_MODE__` muss auch in der Landing-Page-Config-Ersetzung auftauchen (neben `nginx.conf`).

---

*Generiert von coding-review subagent — 2026-08-23*
