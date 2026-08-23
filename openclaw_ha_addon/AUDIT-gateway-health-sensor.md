# Audit Report — OpenClaw HA Addon Gateway Health Sensor

**Auditor:** coding-review subagent  
**Date:** 2026-08-23  
**Subject:** Ingress Gateway Health Sensor — `/api/health` correctness and robustness  
**Files examined:** `landing.html.tpl`, `nginx.conf.tpl`, `tui/index.html`, `docs/index.html`

---

## 1. Background

The Ingress UI (landing page, TUI, docs) displays a gateway status badge that polls `GET /api/health`. This report evaluates whether the current implementation correctly reflects the actual OpenClaw Gateway health and whether the proposed fix is sound.

---

## 2. Current Implementation (Broken)

### 2.1 What nginx does

**File:** `nginx.conf.tpl`, location `/api/health`

```
location = /api/health {
  access_log off;
  return 200 "OK\n";
  add_header Content-Type text/plain;
}
```

This returns HTTP 200 with body `"OK\n"` (plain text). It verifies **only that nginx itself is up**, not the OpenClaw Gateway behind it.

### 2.2 What the landing page JS does

**File:** `landing.html.tpl`, `pollGateway()` function

```javascript
fetch('/api/health', { cache: 'no-store' })
  .then(r => {
    if (r.ok) {                    // ← checks HTTP status only
      statusGateway.textContent = 'Gateway OK';
      statusGateway.className = 'status-badge ok';
    } else {
      throw new Error('not ok');
    }
  })
  .catch(() => {
    statusGateway.textContent = 'Gateway down';
    statusGateway.className = 'status-badge err';
  });
```

The JS checks `r.ok` (HTTP 200), which is `true` for the current nginx response. The text `"OK\n"` is never parsed as JSON. The badge will say "Gateway OK" even if the OpenClaw Gateway process is completely down.

### 2.3 What TUI and docs pages do

Both `tui/index.html` and `docs/index.html` have the same pattern: fetch `/api/health`, check `r.ok`, display "reachable" or "Gateway OK". Same conclusion — they only confirm nginx is up, not the gateway.

---

## 3. The Gateway's Real Health Endpoint

The OpenClaw Gateway exposes a true health endpoint at:

```
GET http://127.0.0.1:<GATEWAY_INTERNAL_PORT>/health
Response: {"ok":true,"status":"live"}
```

This actually pings the gateway process (port binding, health check logic).

---

## 4. Proposed Fix — Evaluation

### 4.1 Nginx side

```
location = /api/health {
  access_log off;
  proxy_pass http://127.0.0.1:__GATEWAY_INTERNAL_PORT__/health;
  add_header Content-Type application/json;
}
```

**Verdict: ✅ Correct.** This proxies the request to the actual gateway `/health` endpoint. The `Content-Type` override is redundant (gateway already sets `application/json`) but harmless.

### 4.2 Landing page JS side

```javascript
fetch('/api/health', { cache: 'no-store' })
  .then(r => r.json())
  .then(data => {
    if (data.ok) {
      statusGateway.textContent = 'Gateway OK';
      statusGateway.className = 'status-badge ok';
    } else {
      throw new Error('not ok');
    }
  })
```

**Verdict: ✅ Correct.** Parses the JSON response and checks `data.ok` as intended.

### 4.3 Robustness During Slow Gateway Startup

**Potential issue:** If nginx starts before the gateway, `proxy_pass` to `127.0.0.1:<port>` returns a **502 Bad Gateway** during the startup window. The JS catch block would show "Gateway down" briefly.

**Assessment:** This is **correct behavior**. Showing "Gateway down" when the gateway is actually down is accurate. Once the gateway starts, the next poll (15 s interval) will update the badge. The alternative (current status quo — always "OK" because only nginx is checked) is strictly worse.

**Recommendation:** Consider adding a `proxy_connect_timeout 5s` to the `/api/health` location to fail fast and avoid long browser-level timeouts. This is optional — the 15 s poll interval already provides natural debouncing.

---

## 5. Additional Ingress Health-Check Issues Found

### 5.1 TUI and docs pages don't check JSON

**Files:** `tui/index.html` (JS `refreshAll`), `docs/index.html` (JS `refresh`)

Both pages display "Gateway: reachable" / "Gateway OK" when `/api/health` returns HTTP 200 — the same plain-text-only nginx response. After the fix, these pages would also receive JSON `{"ok":true,"status":"live"}` and should parse and check `data.ok` consistently.

**Impact:** Currently cosmetic (same misleading status). After the nginx fix, these pages will **break** unless their JS is updated to use `.then(r => r.json())` instead of checking `r.ok` alone.

**Fix required for TUI** (`tui/index.html`, `refreshAll` function):
```javascript
// Change:
const health = await fetchText('/api/health');
// To: parse JSON and check data.ok

// Change:
if (health !== null) { connStatus.textContent = 'connected'; ... }
// To: check data.ok
```

**Fix required for docs** (`docs/index.html`, `refresh` function): same pattern.

### 5.2 CSP — No issues found

The `/api/health` endpoint is same-origin, so no CORS concerns. The CSP header added for the WebUI location (`Content-Security-Policy ... connect-src 'self' ws: wss: ...`) does not restrict same-origin fetches. The health check runs on `fetch('/api/health')` (same origin), so no CSP interaction.

### 5.3 Iframe embedding — WebUI CSP headers handled

**File:** `nginx.conf.tpl`, WebUI location

```
proxy_hide_header X-Frame-Options;
proxy_hide_header Content-Security-Policy;
add_header Content-Security-Policy "default-src 'self' ... frame-ancestors 'self' ...";
add_header X-Frame-Options "SAMEORIGIN" always;
```

This correctly strips the gateway's restrictive framing headers and replaces them with `SAMEORIGIN`, allowing embedding in the HA Ingress iframe. ✅

### 5.4 `/api/logs` — No issues found

**File:** `nginx.conf.tpl`, `/api/logs` location

```
location = /api/logs {
  alias /config/clawd/logs/gateway_startup.log;
  default_type text/plain;
  add_header Cache-Control "no-cache";
}
```

This is a straightforward static file alias. The file path comes from a compile-time constant, not from user input. No injection risk. ✅

---

## 6. Summary of Findings

| # | Severity | File | Issue | Status |
|---|----------|------|-------|--------|
| 1 | **P0** | `nginx.conf.tpl` | `/api/health` returns nginx OK instead of proxied gateway health | **Fix needed** |
| 2 | **P0** | `landing.html.tpl` | JS doesn't parse JSON; relies on HTTP status only | **Fix needed** (part of same fix) |
| 3 | **P1** | `tui/index.html` | JS doesn't parse JSON for health check | **Fix needed after nginx change** |
| 4 | **P1** | `docs/index.html` | JS doesn't parse JSON for health check | **Fix needed after nginx change** |
| 5 | P2 | `nginx.conf.tpl` | No `proxy_connect_timeout` on health proxy | Optional improvement |

---

## 7. Verdict

**⚠️ NO-GO** for production — as-is, the gateway health sensor is misleading: it confirms nginx is up, not the gateway. Users see "Gateway OK" even when the OpenClaw Gateway process has crashed.

### Required fixes (in order):

1. **`nginx.conf.tpl`:** Change `/api/health` location to proxy to `http://127.0.0.1:__GATEWAY_INTERNAL_PORT__/health`
2. **`landing.html.tpl`:** Change `pollGateway()` to use `r.json()` and check `data.ok`
3. **`tui/index.html`:** Update `refreshAll()` to parse JSON from `/api/health` and check `data.ok`
4. **`docs/index.html`:** Update `refresh()` to parse JSON from `/api/health` and check `data.ok`

Once items 1–4 are addressed, the sensor will correctly reflect gateway availability, including during startup, crash, and recovery cycles. The design is robust; the 15 s poll interval is appropriate for the use case.

---

## 8. Recommended nginx.conf.tpl Change

```nginx
# Health check — proxy to actual OpenClaw Gateway health endpoint
location = /api/health {
  access_log off;
  proxy_pass http://127.0.0.1:__GATEWAY_INTERNAL_PORT__/health;
  proxy_connect_timeout 5s;
}
```

## 9. Recommended landing.html.tpl pollGateway() Change

```javascript
function pollGateway() {
  fetch('/api/health', { cache: 'no-store' })
    .then(r => r.json())
    .then(data => {
      if (data.ok) {
        statusGateway.textContent = 'Gateway OK';
        statusGateway.className = 'status-badge ok';
      } else {
        throw new Error('not ok');
      }
    })
    .catch(() => {
      statusGateway.textContent = 'Gateway down';
      statusGateway.className = 'status-badge err';
    });
}
```
