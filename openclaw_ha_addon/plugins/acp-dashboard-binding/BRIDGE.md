# BRIDGE.md — Dashboard-Key-Brücke (Phase 2, opencode-harness)

Plugin: `acp-dashboard-binding` — meine Dateien: `mvp/BRIDGE.md`, `mvp/src/dashboard-bridge.ts`, `mvp/src/dashboard-bridge.test.ts`.
Keine Cross-Edits (channel.ts/binding-adapter.ts/agent-map.ts/… gehören claude-harness).

**Host-Grundlage:** OpenClaw 2026.9.9, dist `/usr/lib/node_modules/openclaw/dist/`. Alle Zeilenbelege unten wurden am 2026-10-10 direkt im dist gelesen (Recherchen von INBOUND-PATH.md bestätigt/ergänzt).

---

## Kernentscheidung (1 Satz)

Die Brücke macht frische `agent:<id>:dashboard:<uuid>`-Keys für die Harness-Agenten über einen **Webchat-SessionBindingAdapter** (`openclaw/plugin-sdk/session-binding-runtime` → `registerSessionBindingAdapter({channel:"webchat", accountId:"default"})`, Konsult-Zeitpunkt-Synthese, deterministisch `boundAt:0`) **und zusätzlich über Hooks (`message_received`/`before_dispatch`) materialisierte plain generic Runtime-Binding-Records** (identischer Mechanismus wie `/acp spawn --bind here`, aber ohne `pluginBindingOwner`-Metadaten) im Binding-System sichtbar, weil das der einzige Mechanismus ist, der beide passiven Inbound-Consults retargetet, ohne den Turn an das Plugin zu übergeben.

---

## 1. Warum dieser Mechanismus

### 1.1 Das Problem

Das Control-UI erzeugt Sessions als agent-qualifizierte Keys `agent:<id>:dashboard:<uuid>`
(SPEC-Fakt 5; INBOUND-PATH.md:18/38-39). Gateway-Admission bindet diesen Key fix
(chat-send-handler-CxoF4cDR.mjs:4488/5841, **kein** Binding-Consult, INBOUND-PATH.md:17-19).
Ohne Plugin dispatcht der Turn zur Builtin-Agent-Session des Agenten.

### 1.2 Die beiden Consults im Inbound-Flow (verifiziert)

Ein Turn dispatcht exakt dann in den ACP-Pfad, wenn der Binding-Consult einen
ACP-geformten Key liefert (`resolveSessionDispatchKind(sessionKey, entry)`, session-key-BC4m_Ly5.mjs:170-172,
`entry?.acp || isAcpSessionKey(sessionKey)`; `isAcpSessionKey` akzeptiert `…:acp:…`-rest, :162-168):

1. **Dispatch-Consult:** `dispatchReplyFromConfig` → `resolveBoundAcpDispatchSessionKey` (dispatch-from-config-BG9rT_X3.mjs:2100-2103):
   ```js
   const boundAcpDispatchSessionKey = state.allowInboundHandlers ? await resolveBoundAcpDispatchSessionKey({ctx, cfg}) : void 0;
   const acpDispatchSessionKey = boundAcpDispatchSessionKey ?? initialSessionStoreEntry.sessionKey ?? sessionKey;
   ```
2. **Session-Init-Consult:** `get-reply` `resolveSessionConversationBinding` → `getSessionBindingService().resolveByConversationAsync` (get-reply-eZY--4sq.mjs:5196), Retarget-Entscheidung :5201-5202 (`boundSessionKey` vor Builtin-Falloff).

Beide landen im `SessionBindingService`; für `{channel:"webchat"}` gibt es **keinen** Channel-Registry-Adapter
(FEASIBILITY.md A, `resolveChannelConversationBindingSupport` matcht `plugin.id === channel`),
also den **Generic-Store-Fallback** — webchat ist explizit generic-eligible
(`session-binding-service-DuwTjh-a.mjs:395-405`: `if (normalized.channel === "webchat") return true;`).

### 1.3 Der pluginBindingOwner-Takeover ist NICHT unser Weg (belegt)

INBOUND-PATH.md:56-63 nennt `resolveDispatchConversationBinding` (dispatch-from-config:2599 → 
`package-update-activation-recovery.mjs:1222897-1222903`) als früheste Plugin-Intervention mit
Full-Turn-Takeover (`:3471 if (pluginOwnedBinding) { … }` → `runInboundClaimForPluginOutcome`,
hooks-3uEO1KNL.mjs:876-884). Dist-Verifikation zeigt, dass dieser Pfad für unser Ziel **falsch** ist:

- **Plugin-owned Records werden aus ALLEN passiven Retarget-Consults ausgeschlossen.** `resolveBoundAcpDispatchSessionKey` endet mit:
  ```js
  … isAcpSessionKey(currentTargetSessionKey) && !isPluginOwnedSessionBindingRecord(currentBinding) ? … : void 0;
  ```
  (package-update-activation-recovery.mjs:1223272; gleiches Muster get-reply, 1266696; dispatch-from-config:191/199).
- **`toPluginConversationBinding`** (package-update-activation-recovery.mjs:821128-821145) wird nur aus Record-Metadaten mit
  `pluginBindingOwner:"plugin"` + `pluginId` + `pluginRoot` ein Takeover-Objekt (conversation-binding-metadata-CFOhDjMh.mjs:5-7);
  ein solcher Record zwingt das Plugin zur Full-Turn-Ausführung (claim outcomes `handled`/`missing_plugin`/`no_handler`/`declined`/`error`,
  dispatch-from-config:3512-3545; `no_handler` erzeugt zusätzlich eine "plugin binding unavailable"-Notice an den User).
- **Deshalb: plain Record** (Metadaten OHNE `pluginBindingOwner`/`pluginRoot` und bewusst ohne den Metadaten-Schlüssel `pluginId`).
  Ein plain Record fließt als `selection.kind:"agent"` (package-update-activation-recovery.mjs:1222606-1222628) durch beide
  Consults → `acpDispatchSessionKey` = ACP-Target → `dispatchKind:"acp"` (dispatch-from-config:2122) → Harness-Dispatch;
  `pluginOwnedBinding` wird `toPluginConversationBinding(record) === null` → Takeover-Block :3471 wird übersprungen.
  Das ist exakt der Record-Typ, den `/acp spawn --bind here` erzeugt (INBOUND-PATH.md:115) — nur programmatisch.

### 1.4 ACP-Target-Key (exaktes Format, dist-verifiziert)

`buildConfiguredAcpSessionKey` (package-update-activation-recovery.mjs:961809-961812):

```js
function buildConfiguredAcpSessionKey(spec) {
  const hash = sha256HexPrefixCore(`${spec.channel}:${spec.accountId}:${spec.conversationId}`, 16);
  return `agent:${sanitizeAgentId(spec.agentId)}:acp:binding:${spec.channel}:${spec.accountId}:${hash}`;
}
```

- `sha256HexPrefixCore` = sha256-Hexdigest, `slice(0,16)` (node-crypto-BInnzoVt.mjs:34-36).
- `sanitizeAgentId` = `normalizeAgentId`: trim → lowercase; gültig gegen `/^[a-z0-9][a-z0-9_-]{0,63}$/i`, sonst
  `[^a-z0-9_-]+`→`-`, Dashes an den Rändern trimmen, max 64, sonst `DEFAULT_AGENT_ID` (agent-id-D1-Q6vR4.mjs).
- Kein SDK-Subpath exportiert `buildConfiguredAcpSessionKey`/`sha256HexPrefixCore` → **lokale Mirror-Implementierung**
  im Bridge-Modul (pinned durch Tests; TODO: Austausch gegen agent-map.ts/SDK-Import in Phase 3).
  `isAcpSessionKey`/`sanitizeAgentId`/`parseAgentSessionKey` sind dagegen über `openclaw/plugin-sdk/routing` exportiert
  (dist/plugin-sdk/routing.d.ts:72).
- Record-Präzedenz für deterministisches `boundAt:0`: `toConfiguredAcpBindingRecord` nutzt `boundAt: 0`
  (package-update-activation-recovery.mjs:961826).

---

## 2. Früheste Interventionspunkte im Turn-Flow (alle Belege)

Flow-Reihenfolge pro Inbound-Turn (INBOUND-PATH.md:87-110, Zeilen in dist nachgelesen):

| # | Punkt | Ort (dist) | awaited? | Wirkung |
|---|-------|------------|----------|---------|
| 0 | Gateway-Admission, Session-Key fix | chat-send-handler-CxoF4cDR.mjs:4488/5841 | ja | **kein Binding-Consult, kein Hook** |
| 1 | Dispatch-Consult | dispatch-from-config:2100-2103 → `resolveBoundAcpDispatchSessionKey` (package-update:1223243-1223280) | ja | retarget bei plain ACP-Record |
| 2 | `dispatchKind` | dispatch-from-config:2122 | — | `"acp"`/`"agent"` |
| 3 | Plugin-owned-Binding-Resolution | dispatch-from-config:2599 → package-update:1222897 | ja | **nur** für `pluginBindingOwner`-Records → Takeover :3471-3545 |
| 4 | `before_dispatch` Claiming-Hook | dispatch-from-config:888-946 (result-Claim :928, `runBeforeDispatch`, hooks-3uEO1KNL.mjs:886-888) | **ja** | Claim → Turn vorbei (:928-946); ohne Claim → Built-in-Dispatch läuft |
| 5 | `message_received` Hook | dispatch-from-config:2576-2593 (`fireAndForgetHook` :2583-2590), Call-Sites :2874/:3365/:3547 | nein (fire-and-forget) | Beobachtung |
| 6 | `reply_dispatch` Claiming-Hook | dispatch-from-config:963 → :461 `runReplyDispatchTakeover` | ja | Full-Turn-Übernahme (müsste ACP-Run selbst starten) |

Hook-Namensliste (`pluginHookNameSet`, incl. `message_received`, `before_dispatch`, `inbound_claim`, `reply_dispatch`, `session_start`/`session_end`): hooks-3uEO1KNL.mjs:314-367; Registrierung: `api.registerHook(events, handler, opts)` (plugin-entry-DYuWNw2N.d.ts:51038). Claiming-Semantik: Handler `{handled:true}` → Claim (hooks-3uEO1KNL.mjs:788-816), sonst Fallthrough. `SuppressMessageReceivedHooks` wird für webchat nicht gesetzt (nur Lese-Sites dispatch-from-config:2577, package-update-activation-recovery:1269759).

**Konsequenz (Cold Window):** Die Consults #1/#2 laufen **vor** allen Hooks — ein Turn kann sich mit einer
Record-Anlage in seinem eigenen Consult nicht mehr retargeten. Für eine Kalt eröffnete Dashboard-Session gibt es
zwei Schließungswege:

- **Primär (gewählt): Konsult-Zeit-Synthese.** Der Webchat-Adapter beantwortet `resolveByConversationAsync` **im Consult selbst**
  (Synthese, deterministisch) — damit dispatcht **Turn 1** zum Harness. Kein Hook-Timing nötig.
- **Sekundär: Hooks als Materialisierungs-/Frühwarnschicht.** `message_received` + (awaited) `before_dispatch`
  erzeugen den Record beim ersten Kontakt (idempotent, siehe §3.3), sobald der Adapter **nicht** dem Bridge gehört
  (Fremd-Adapter (claude) oder generischer Core-Pfad) — dort schließt der Record die Lücke ab Turn N+1
  (N = erster Kontakt), identisch zum INBOUND-PATH.md:115-Weg. Ist der Bridge selbst Adapter-Owner, ist der Hook-Upsert
  ein No-op (Konsult-Synthese deckt alles ab; vermeidet `boundAt`-Wackeln zwischen Consult und Re-Consult).

**Ausgeschlossen als primärer Weg (belegt):** `before_dispatch`/`reply_dispatch`-Claim (Müsste Harness-Run selbst
ausführen — INBOUND-PATH.md:67/70); `message_received` wirkt nicht auf die Session-Wahl (INBOUND-PATH.md:73-74).

---

## 3. Implementierung: `src/dashboard-bridge.ts`

### 3.1 Bausteine

1. **Key-Grammatik & Synthese (rein, hermetisch testbar):**
   - `parseDashboardConversationKey(conversationId)` → `{agentId, rest}` mit `agent:<agentId>:dashboard:<rest>`
     (Thread-Suffixe `:thread:…` sind Teil von `rest`; `null` bei Nicht-Match).
   - `sanitizeAgentId`/`normalizeAgentId`/`normalizeAccountId` — exakte Mirrors der dist-Semantik (§1.4;
     accountCanon analog agent-id-Regeln, Fallback `"default"`, account-id-CW6dlabA.mjs:18-28).
   - `buildDashboardAcpTargetSessionKey({agentId, channel, accountId, conversationId})` — Formel §1.4.
   - `synthesizeDashboardBindingRecord(ref, roster)` → Plain-`SessionBindingRecord`:
     ```ts
     {
       bindingId: `generic:${channel}␟${accountId}␟${parentConversationId ?? ""}␟${conversationId}`,  // buildBindingId, package-update:819310-819312; buildConversationKey :819302-819309 (Separator U+241F „␟")
       targetSessionKey: <ACP-Key nach §1.4>,
       targetKind: "session",
       conversation: {channel, accountId, conversationId, parentConversationId?},
       status: "active",
       boundAt: 0,                       // deterministisch; Präzedenz package-update:961826
       metadata: { source: "plugin", plugin: "acp-dashboard-binding", mode: "persistent", agentId, …backend?/cwd?/label?, origin: "dashboard-bridge" }
     }
     ```
     Metadaten enthalten bewusst **nicht** `pluginId`/`pluginRoot`/`pluginBindingOwner` (§1.3) und **nicht** `boundBy:"system"`
     (`routableBinding`-Gate, session-binding-service-DuwTjh-a.mjs:758-767).
2. **Roster (bis agent-map.ts):** `resolveHarnessAgentDefaults(cfg, agentId)` liest
   `agents.entries.<id>.runtime` mit `runtime.type === "acp"` → `{mode, backend, cwd, label}`
   (Doku-Beleg: docs/gateway/config-agents/entries-and-multi-agent.md:40-56/86). Harness-Gate = `HARNESS_AGENT_IDS` ∩
   config-Eintrag (TODO: Import der geteilten Konstanten aus `src/agent-map.ts`, s. §5).
3. **Eigenes Row-Store (nur für bind/unbind/Tombstones):** `api.runtime.state.openKeyedStore<T>({namespace: 'webchat.dashboard-bridge.rows', maxEntries: 1000})`
   bzw. `{namespace: 'webchat.dashboard-bridge.tombstones', maxEntries: 1000}` (plugin-entry-DYuWNw2N.d.ts:44932,
   `OpenKeyedStoreOptions` agent-harness-runtime-R8dTs5zl.d.ts:27590-27597, Usage-Beleg bot-native-command-menu-hfLaQk2g.mjs:307),
   best-effort mit In-Memory-Fallback; Keys: `row:<conversationRef-canonical>` / `tombstone:<…>`.
   Konsult-Synthese nutzt den Store **nicht** als Quelle, sondern nur für `bind()`-Rows (Spawn-Flows) und
   `unbind()`-Tombstones (`/acp close`/`/session unbind` soll eine Dashboard-Session dauerhaft freischalten können —
   Synthese respektiert Tombstones). **Phase 2.12 F1:** der vorherige `{name: …}`-Optionsname war falsch (der Host
   hat ihn stillschweigend verworfen) — der dist-Vertrag ist `{namespace, maxEntries}`.
   **Phase 2.12 F2 Boot-Hydration:** `BridgeRowStore.hydrate()` lädt beim `createDashboardBridge` persistierte
   `entries()` in die Memory-Maps (Rows/Tombstones), idempotent, niemals rejectend — In-Memory-Writes während der
   Hydration gewinnen (live Row > persistierter Row > persistierter Tombstone). Resilienz: alle async Store-Consumer
   (`resolveByConversationAsync`/`inspectByConversationAsync`/`touchAsync` des Adapters, `handle.resolveDashboardBindingAsync`,
   exported `resolveDashboardBindingAsync`) awaiten `store.whenReady()`, so dass kein Read gegen die halb geladene
   Hydration läuft; bei Store-Fehlern läuft es memory-only weiter (Warnlog).

### 3.2 Webchat-Adapter (`createWebchatDashboardBindingAdapter`)

Registriert via `registerSessionBindingAdapter` (`openclaw/plugin-sdk/session-binding-runtime`,
dist/plugin-sdk/session-binding-runtime.js; core-Registry: session-binding-service-DuwTjh-a.mjs:705-741, Match nur
`channel:accountId`, „last registered wins" `.at(-1)`):

- `{channel:"webchat", accountId:"default"}`; `capabilities: {placements:["current"], bindSupported:true, unbindSupported:true}`
  (bindSupported ist Pflicht, sobald der Adapter existiert: `service.bind` wirft sonst `BINDING_CAPABILITY_UNSUPPORTED`
  — session-binding-service-DuwTjh-a.mjs:869-895; das würde `/acp spawn --bind here` auf webchat brechen).
- `resolveByConversation`/`resolveByConversationAsync`: Row → Tombstone? `null`; sonst Harness-Dashboard-Key → **Synthese (deterministisch)**;
  sonst `null`.
- `inspectByConversationAsync`: identisch (kein Schreibverhalten, keine Prune — passt zum prepared-route-Vergleich
  readPreparedConversationBindingRouteCurrent, package-update:1222930-1222944).
- `touchAsync(bindingId)`: nur `lastActivityAt` bumpen (boundAt stabil — erforderlich für den
  resolve→touch→re-resolve-Zyklus in `resolveBoundAcpDispatchSessionKey`, package-update:1223266-1223272).
- `bind(input)` → Row-Upsert mit `input.targetSessionKey` (Spawn/`/acp spawn --bind here` auf webchat bleibt über uns konsistent;
  Placement-Gate `["current"]` entspricht `getGenericCurrentConversationBindingCapabilities`, session-binding-service-DuwTjh-a.mjs:422-429).
- `unbind(input)` → Tombstone + Entfernen (by bindingId/targetSessionKey, scope-webchat-bewacht), löscht Rows.
- `listBySession(targetSessionKey)` → Rows-Filter (Service-Contract, session-binding-service-DuwTjh-a.mjs:930-938).

**Registrierung nur wenn frei:** beim Setup prüft die Brücke über `testing.getRegisteredAdapterKeys()`
(dist/plugin-sdk/session-binding-runtime.js) auf `"webchat:default"` (Key-Format `buildChannelAccountKey`,
current-conversation-binding-row-DmEvsvM_.mjs:41-43) — vorhanden (z. B. claude's Adapter) → **keine** Doppel-Registrierung
(last-wins-Verhalten vermeiden); der Adapter-Eigentümer soll §4-Schnittstelle erfüllen. `dispose()` kann via SDK nicht
un-registrieren (kein `unregisterSessionBindingAdapter`-Export im Subpath) — dispose stoppt nur die Hook-Aktivität
(dokumentierte Limitation).

**Bekannte Schattenbildung (dokumentiert, akzeptiert):** Sobald ein Webchat-Adapter existiert, ist der Generic-Store
für `{webchat, default}` hinter dem Adapter verborgen (session-binding-service-DuwTjh-a.mjs:921-929 — Adapterpfad
ist exklusiv). Bestehende legacy `generic:`-Records auf webchat (z. B. manuelles `/acp spawn --bind here` in einer
**main**-Dashboard-Session vor Plugin-Load) beantwortet der Adapter nicht (Rückgabe `null`) — für Harness-Keys ist das
neutral (Synthese-Target == Konfig-Target), für main/unknown ist es die eine akzeptierte Abweichung vom
„main unverändert"-Kriterium in dem Randfall. Nicht-Ziel: Weg-1 in Harness-Sessions bleibt durch `bind()`/`unbind()`-Delegation voll erhalten.

### 3.3 Hook-Wiring (`registerDashboardBridge`)

```ts
export function createDashboardBridge(args: DashboardBridgeArgs): DashboardBridgeHandle
```

- `args.api`: `{id, config, logger?, registerHook, runtime?}` (strukturell getippt; keine hart-gepinnten Host-Typen im
  Modul, damit vitest hermetisch bleibt).
- Registriert `["message_received","before_dispatch"]` mit einem Handler:
  - Gate: `event.channel ?? event.channelId === "webchat"` (before_dispatch-Event: dispatch-from-config:903;
    message_received-Kontext: message-hook-mappers-1uJn41lN.mjs:59-68 — `channelId = OriginatingChannel ?? Surface ?? Provider`).
  - Key: `event.sessionKey ?? event.conversationId` → `parseDashboardConversationKey` → Harness-Gate →
    `ensureDashboardBindingRecord(ref)`.
  - **Wenn Bridge Adapter-Owner ist:** ensure = No-op (Konsult-Synthese deckt den Turn ab; kein `boundAt`-Wechsel).
  - **Sonst:** `getSessionBindingService().bind({targetSessionKey, targetKind:"session", conversation, placement:"current", metadata})`
    (SDK-Subpath `openclaw/plugin-sdk/session-binding-runtime`). Idempotent: nur binden, wenn `resolveByConversationAsync`
    keinen Record mit gleichem Target liefert (Generic-Bind setzt `boundAt:now` bei jedem Aufruf,
    package-update:819567-819590 → Blind-Bind zwischen Consult und re-resolve könnte `SessionWorkStartChangedError`,
    package-update:1222930-1222944, triggern — deshalb Resolve-first). Fehler werden geloggt, nie geworfen.
  - `before_dispatch`-Handler gibt **nie** `{handled:true}` zurück (Claiming-Hook, aber ungenutzt — Claim-Branch dispatch-from-config:928).
- Returns: `{dispose(), ownsWebchatAdapter, webchatAdapterKeys}`.

---

## 4. Komposition mit claude-harness (Schnittstelle, keine Cross-Edits)

1. **index.ts (claude)** ruft in Phase 3 nach `registerChannel(...)` einen 1-Zeiler:
   ```ts
   const bridge = await createDashboardBridge({ api });
   ```
   Reihenfolge egal: die Brücke registriert den Webchat-Adapter nur, wenn `"webchat:default"` frei ist.
2. **binding-adapter.ts (claude, alternativ):** wenn claude den Webchat-Adapter selbst registrieren will (kriterium-2-Weg),
   delegiert sein `resolveByConversationAsync` nach Row-Miss an `resolveDashboardBindingAsync(ref)` aus
   dashboard-bridge.ts (exportiert, deterministisch, ohne Schreibzugriff) — dann bleibt die Turn-1-Synthese erhalten und
   die Brücke bleibt im No-op-Hook-Modus. **Akzeptanzkriterium 2 verlangt in beiden Varianten:**
   `resolveByConversationAsync({channel:"webchat", accountId:"default", conversationId:"agent:codex:dashboard:<uuid>"})`
   → ACP-Target `agent:codex:acp:binding:webchat:default:<hash16>`; für main/unknown `null`.
3. **Geteilte Konstanten** (`HARNESS_AGENT_IDS`, `BINDING_MODE`, `DEFAULT_CWD_PREFIX`, `CHANNEL_ID`, Ziel-Channel `webchat`)
   kommen aus `mvp/src/agent-map.ts` — siehe TODO-Markierung im Code; bis dahin sind sie hier inline doppelt
   (vertraglich identisch, CONTRACT.md:27-32). **Stand 2026-10-10 verifiziert:** `agent-map.ts` exportiert exakt diese
   Konstanten mit identischen Werten (Zeilen 13-41) und semantikgleiche Mirrors `sanitizeAgentId`/`normalizeAccountId` —
   der Phase-3-Swap ist ein reiner Import-Umstieg (`./agent-map.js`), der Core-Präfix `generic:` bleibt dabei
   bridge-lokal (agent-map's `BINDING_ID_PREFIX "plugin-binding:"` ist ein anderer Kontext und wird NICHT importiert).

---

## 5. Risiko-/Unsicherheitsliste

1. **Ausschluss-Semantik `main`/Weg-1-legacy** (§3.2): Adapter verdeckt generische webchat-Records; Randfall
   „manuelles `/acp spawn --bind here` in einer main-Dashboard-Session" verliert seine Binding-Wirkung, solange der
   Adapter für webchat:default registriert ist. Phase 3: verifizieren (und ggf. Konfig-Flag „adapter off"→hooks-only-Modus).
2. **Register-Ordnung (last wins):** wenn claude's Adapter NACH der Brücke registriert, hat er das Konsult-Erbe; dann MUSS
   er die §4.2-Delegation implementieren, sonst verliert Turn 1 die Synthese. Phase 3 verifiziert die Ladereihenfolge.
3. *`deriveInboundMessageHookContext`-Felder* (event.sessionKey für webchat): belegt (message-hook-mappers-1uJn41lN.mjs:66),
   aber Phase 3 muß den realen Dashboard-Turn smoke-testen (Hook-Event-Metadaten sind dist-intern zusammengesetzt).
4. **Key-Sanitisierung lokal gespiegelt:** falls `agents.entries.<id>`-IDs Nicht-ASCII enthalten, greift
   `sanitizeAgentId`-Fallback `main` — der Key müsste dann gegen das Roster-Mismatch geprüft werden (Phase 3).
5. Der ACP-Dispatch konsumiert nur `targetSessionKey` (Virtual-Key-Auflösung); Metadaten sind informativ —
   Phase 3 prüft, ob `mode/cwd/backend` im Record vom Harness-Pfad respektiert werden oder rein config-getrieben sind.

## 6. Phase-3-Checkliste (was die Brücke alleine nicht leisten kann)

- End-to-End-Smoke: neue Dashboard-Session an codex → Turn 1 mit `acp_session_id` + `agent_command` im Session-Record
  (Kriterium 3). Requires: Plugin-Load (index.ts-Wiring, §4.1), laufender Harness-Backend.
- `openclaw plugins inspect` (Kriterium 1) — Manifest/Load gehört claude (`openclaw.plugin.json`, index.ts).
- Verifizieren, dass Turn-1-Retarget auch über `get-reply:5196/:5201`-Session-Init konsistent läuft (prepared-route-Assertions).
- Entscheidung/Delegation in binding-adapter.ts (§4.2) — Integrationstest mit claude-Dateien.
- Tombstone-/unbind-UX (`/acp close` auf webchat) End-to-End.

---

## 7. F3: ACP-Session-Init für binding-keys (Phase 2.12 — NUR DESIGN-DOKUMENTATION)

**Status: Implementierung ausdrücklich NICHT Teil von Phase 2.12. Die Design-Entscheidung trifft der
Orchestrator/GaRoN.** Dieses Kapitel dokumentiert die beiden Kandidaten-Optionen und ihre Trade-offs, damit
die Entscheidung auf belegtem Grund getroffen wird.

**Problem (Marvin-Bugreport Punkt 3):** Die ACP-Session-Init-Phase eines Dashboard-Turns konsultiert das
Binding-System erneut, während der Turn läuft. Der dist-Resolve-Pfad vergleicht resolve → `touchAsync` →
Re-resolve **strikt** über `bindingId/boundAt/targetSessionKey/targetKind/conversation`
(package-update-activation-recovery.mjs:1223266-1223272). Trifft die Init auf einen **synthetisierten**
Record (`boundAt: 0`, Konsult-Zeit-Synthese §2/Primärweg) während parallel ein materialisierter Record
(`boundAt: Date.now()`) ins Spiel kommt — oder umgekehrt — divergiert der Vergleich und das Risiko eines
`SessionWorkStartChangedError` (package-update:1222930-1222944, siehe §3.3) bzw. eines stillen Retargets
steigt exakt in dem Moment, in dem der ACP-Session-Key erstmals hart gebunden werden soll.

### Option A — Host-seitiger ensure-Pfad (Materialisierung vor Turn 1)

Idee: Der Record wird **vor** der ACP-Session-Init materialisiert, so dass alle Consults einen echten
Row (`boundAt > 0`) sehen und der strict-Vergleich deterministisch besteht.

- Mechanismen-Kandidaten: `message_received`/`before_dispatch`-Hook ruft auch bei Bridge-Owner-Adapter
  `service.bind` (heute bewusst No-op, §3.3, um `boundAt`-Wackeln zu vermeiden) — oder ein separater
  ensure-Aufruf beim Dashboard-Session-Create.
- **Pro:** Turn 1 sieht konsistent materialisierte Rows; kein Synthese-/Materialisierungs-Mismatch in der
  Init; `boundAt` stabil über alle Consults.
- **Contra:** Reaktiviert genau das `boundAt`-Wackeln zwischen Consult und Re-Consult, das das heutige
  No-op-Design vermeiden will (§3.3); Hook-Timing hängt an fire-and-forget (`message_received`, §2-Punkt 5)
  bzw. awaited `before_dispatch` (Punkt 4) — Blinde Flecken, wenn Hooks für den ersten Turn nicht feuern;
  Zuständigkeits-Verschmelzung von Bridge-Adapter und Host-Service.

### Option B — Turn-1-Fehler-UX (kein ensure, Fehler explizit machen)

Idee: Am Mechanismus wird nichts geändert (Konsult-Zeit-Synthese bleibt primär, §2). Falls die ACP-Session-Init
auf den Synthese-/Materialisierungs-Mismatch läuft (`SessionWorkStartChangedError` oder abweichendes Re-resolve),
wird das nicht still weggeschluckt, sondern in eine sichtbare Turn-1-Fehler-UX übersetzt (Fehlernachricht an den
User + Retry-Hinweis; der Retry läuft dann auf materialisierten Rows und geht durch).

- **Pro:** Minimale invasive Änderung; das bewährte deterministische Synthese-Design bleibt unangetastet;
  Fehler-UX macht ein ansonsten schwer diagnostizierbares Timing-Problem beobachtbar (Logs/Telemetrie).
- **Contra:** Erster Turn einer Kalt eröffneten Dashboard-Session kann erkennbar fehlschlagen (Negativ-Erlebnis);
  UX-Pfad liegt außerhalb der Brücke (Control-UI/webchat-Fehlerdarstellung) und muss vom Host mitgetragen werden.

### Offene Punkte für die Entscheidung

1. Kann der Host einen ensure-Pfad anbieten, der garantiert **vor** der Session-Init-Consult läuft
   (§2-Punkte 0-2 laufen vor allen Hooks — sonst braucht es einen Punkt vor dem Gateway-Admission-Window)?
2. Wie verhält sich der strict-Vergleich konkret, wenn beide Seiten deterministisch `boundAt: 0` liefern
   (Konfig-Variante, §1.4 Record-Präzedenz) — ist der Mismatch reale oder theoretische Gefahr?
3. Wer gehört die Fehler-UX (Plugin vs. Host), falls Option B gewählt wird?