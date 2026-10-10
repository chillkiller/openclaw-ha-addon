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

## 4.2a Phase 2.19 — Turn-1-Race-Fix (§4.2-Delegation mit config-getriebenem Fallback-Roster)

**Befund (codex-Diagnose 7e9298af):** `createDashboardBridge` startet ASYNC hinter
`registerFull` (der Host ruft `registerFull` synchron und awaitet die Rückgabe nicht —
Phase-2.6-Befund), während der Adapter in `registerDashboardBindingRuntime` SOFORT registriert
ist. In dieser Lücke ist der §4.2-Modul-Pointer (`activeBridgeResolution`) noch `null`; die
Delegation antwortete mit dem UNBEGRÜNDETEN Fallback-Roster (`createConfigHarnessRoster(undefined)`
→ leer → null), so dass der Adapter in seine eigene `deriveBindingRecord`-Synthese fiel — deren
Record weicht von der Bridge-Synthese ab (anderes `bindingId`-Format, andere Metadata) und
missachtet bei hydration-flip-übergreifenden Turns den harnessSessions-Target. Konnten beide
Seiten innerhalb des Host-Resolve→touch→re-resolve-Vergleichs unterschiedliche Records sehen,
drehte der Turn-1-Pfad auf ein synthetisches Target (→ `ACP_TURN_FAILED` /
„ACP input must be durably committed", §7).

**Gewählte Lösung — Adapter-Fallback (definitiv), NICHT synchroner Bridge-Start:**

1. `resolveDashboardBinding(Async)` nimmt einen `context.roster` entgegen; **roster-Precedence:
   aktive Brücke > caller-context > unbebackener Safe-Default.** Die aktive Brücke behält
   Vorrang (§4.2-Vertrag, Rows/Tombstones gehören zu IHREM Roster; getestet in
   dashboard-bridge.test.ts „context roster is a FALLBACK").
2. `binding-adapter.ts` übergibt an BEIDE Delegation-Calls (`bridgedRecord` sync +
   `resolveByConversationAsync`) einen config-getriebenen Roster
   (`createConfigHarnessRoster(options.getConfig?.())` — pro Resolve frisch gelesen,
   Phase-2.7-Vertrag). Die Lücke synthesed damit aus der Live-Config inklusive
   `harnessSessions` statt der blinden Derivation.
3. Warum kein synchroner Start: der Host kontrolliert den `registerFull`-Aufrufpunkt und
   awaitet nicht — Bridge-Erzeugung kann dort nicht deterministisch „vor Turn 1" abgeschlossen
   werden; `await createDashboardBridge` im Entry wäre tot (Phase-2.6-Befund,
   dist-core-*.mjs). Der Adapter-Fallback ist race-frei, weil die Adapter-Config IMMER lebt.

**Metadata-Parity:** dadurch die Delegation ab Turn 1 antwortet, ist die Bridge-Synthese der
LEAD-Record für webchat; `synthesizeDashboardBindingRecord` trägt jetzt zusätzlich
`acpAgentId` (aus `runtime.acp.agent`, via `HarnessAgentDefaults`) — dasselbe informative
Feld, das die Adapter-Derivation immer setzte. Der Adapter-Derive-Pfad bleibt als
Synthese-Antwort für den plugin-eigenen Channel-Scope (dort antwortet die Bridge nicht) und
Non-Dashboard-Formate.

**Tests:** channel.test.ts „Phase 2.19 Turn-1-Race" (Lücke: echter Key statt Derivation;
Sync/Async byte-identisch; Record bleibt über den Hydration-Flip identisch; undefined-Config
bleibt null) + dashboard-bridge.test.ts (async-Mirror ehrt context-roster; context-roster ist
nur Fallback gegen eine aktive Brücke). Mutation-Checks: beide Delegation-Calls ohne Roster
→ neue Tests schlagen fehl (Fix wird real erkannt).

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

## 7. F3: ACP-Session-Init für binding-keys (Phase 2.12 Design-Doku → Phase 2.18b ENTSCHEIDUNG)

**Status-Update Phase 2.18b (Orchestrator-Entscheidung, RE-besätigt):** Die nachstehende
Dist-Analyse der synthetischen Record-Timing-Gefahr bleibt gültig; die ENTSCHEIDUNG ist aber
gefallen und implementiert (Weg A, Plugin-seitig, §9): `config.harnessSessions` liefert für
ausdrücklich gespawnte persistente Harness-Sessions den ECHTEN Session-Key als Target, so dass
der strict resolve→touch→re-resolve-Vergleich und die ACP-Session-Init auf einen Key treffen,
hinter dem eine echte `acp_sessions`-Row liegt. **Weg B (host-seitiger ensure-Pfad inkl.
Turn-1-Fehler-UX) bleibt Upstream-Issue** gegen OpenClaw — so lange bleibt der synthetische
Fallback-Pfad in seiner unten dokumentierten Einschränkung bestehen (brauchbar erst nach
einer host-seitigen `/acp spawn`-Initialisierung, die es nicht gibt).

---
**Original-Design-Dokumentation Phase 2.12 (Implementierung damals ausdrücklich NICHT Teil;
die Design-Entscheidung traf der Orchestrator/GaRoN):** dieses Kapitel dokumentiert die beiden
Kandidaten-Optionen und ihre Trade-offs, damit die Entscheidung auf belegtem Grund getroffen
wird.

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
---

## 8. Binding-Auswahl-Philosophie (GaRoN 09:29 — Phase 2.17)

**Ausgangspunkt (Argument 09:29):** „Der Kunde bekommt, was er will, nicht was wir ihm
geben." KEINE Verbote ohne Escape-Hatch — aber auch KEIN Selbstschuss ohne Safe-Default
(Argument 08:14). Beides gilt gleichzeitig; die Prioritätenspur folgt daraus.

### 8.1 Die Prioritätenleiter (`isRosterEligibleAgentId`, agent-map.ts)

Welche `agents.entries.<id>`-Agenten landen im Harness-Roster (und damit als Bindungsziele
für Dashboard-Konversationen), entscheidet DIREKTE Priorität:

1. **`plugins.entries['acp-dashboard-binding'].config.boundAgents`** *(gesetzt — höchste
   Priorität)*: Positive-Liste und damit das „Kunde bekommt was er will"-Hebel. Sie
   GEWINNT über JEDE Exclusion — sie kann sogar `main`/`coding-main`/`coding-review`
   explizit aufnehmen, die werden dann gebunden (dokumentierter Escape-Hatch). Semantik:
   Nur die gelisteten (kanonisierten) ids rosteren; **explizit leeres Array = „nichts
   binden"** (ebenfalls dokumentierte Semantik, kein Fallback auf Defaults).
2. **`config.excludedAgents`** *(nur wenn `boundAgents` NICHT gesetzt)*: Ersetzt die
   Default-Exclusion KOMPLETT — akzeptiert eine CSV (`"main,coding-main"`) oder eine
   Liste. Erklärung: Der User entscheidet, was „gefährlich" ist; sein Wert schlägt unsere
   hardcoded Liste.
3. **Safe-Default-Exclusion** *(nur wenn beides fehlt)*: `ORCHESTRATOR_AGENT_IDS`
   (`main`, `coding-main`, `coding-review`) rosteren nicht, auch wenn ihre Entries
   `runtime.acp` tragen — verhindert das Selbstschuss-Szenario von 08:14 ohne User-Konfig.

Die Leiter gilt **einzeln über beide Pfade** identisch: Adapter-Ableitung
(`resolveHarnessAgentSpec`/`resolveHarnessAgentSpecs` in agent-map.ts) UND Roster-Frage
(`createConfigHarnessRoster().isHarnessAgent` in dashboard-bridge.ts) rufen dieselbe
Gate-Funktion. Konfig-Änderungen wirken live (kein Cache — pro resolve frisch gelesen).

### 8.2 Warum boundAgents vor Exclusion gewinnt (Begründung)

Eine Exclusion, die sich nicht überschreiben lässt, ist ein Verbot — und Verbote ohne
Escape-Hatch widersprechen der GaRoN-Regel. Deshalb ist die hardcoded
Orchestrator-Exclusion ab Phase 2.17 KEINE Konstante mehr im Entscheidungsweg, sondern
nur noch der DEFAULT-Knoten der Leiter (Stufe 3). Der Safe-Default existiert für den
Fall „kein Bewusstsein über das Feature" (08:14: Haupt-Orchestrator darf nie versehentlich
durch das ACP-Binding laufen), nicht als Mauer gegen bewusste Konfiguration.

### 8.3 Test-Matrix (Phase 2.17, dashboard-bridge.test.ts)

| Konfig | Ergebnis |
| --- | --- |
| nichts gesetzt | Coding-Main/Coding-Review/Main ausgeschlossen, `runtime.acp`-Rest rostert (Safe-Default) |
| `boundAgents: ["coding-main","codex"]` | beide gebunden — Exclusion überschrieben (Escape-Hatch) |
| `boundAgents: []` | gar nichts gebunden (dokumentierte Semantik) |
| `excludedAgents: "codex"` | Default-Exclusion ersetzt: Coding-Main rostert, Codex nicht |
| `excludedAgents: []` | gar nichts ausgeschlossen (dokumentierte Semantik) |
| `boundAgents` + `excludedAgents` kombiniert | `boundAgents` gewinnt (Stufe 1 > Stufe 2) |
| Live-Reload | Gate liest Config pro Resolve frisch — Adapter-Generation ohne Cache |

---

## 9. Phase 2.18b — `harnessSessions` (F3, Weg A: real gespawnte Session-Keys)

**RE-Befund (Orchestrator, dist-verifiziert):** `manager.utils-Cu8bbvjj.mjs`
`resolveStoredAcpSession()` antwortet `kind:"stale"` + `ACP_SESSION_INIT_FAILED`, wenn der
Key ACP-geformt ist (`isAcpSessionKey`), aber KEINE `acp_sessions`-Row mit `stored.acp`
existiert. `upsertAcpSessionMetaRow` (package-update-activation-recovery.mjs:431990) schreibt
solche Rows **nur beim echten Harness-Spawn** (Felder: `session_id`, `backend`, `agent`,
`mode`, `cwd`, …) — **synthetische binding-keys können deshalb NIE initialisiert werden.**

**Weg A (Plugin-seitig, implementiert):** neue Config-Option
`plugins.entries['acp-dashboard-binding'].config.harnessSessions` — Mapping harness-id →
der ECHTE persistente Session-Key, den der User nach einem einmaligen `/acp spawn <harness>`
einträgt. Lookup-Key: `runtime.acp.agent` (harness-id) ODER der kanonische agent id —
harness-id gewinnt bei Kollision, agent id deckt Entries ohne `acp.agent` ab.

- **Gate-Ladder bleibt** (`boundAgents` > `excludedAgents` > Safe-Default, §8.1): sie
  entscheidet unverändert, WER bindet. NUR das TARGET ändert sich: gesetzt + gültig →
  `targetSessionKey` = der echte Key; NICHT gesetzt oder ungültig → wie bisher synthetisch
  (dokumentiert: brauchbar erst nach `/acp spawn`-Initialisierung, siehe §7).
- **Validierung:** Target-Key muss ACP-geformt sein (Host-`isAcpSessionKey`-Shape,
  `isAcpShapedSessionKey`) und DARF NICHT auf einen Orchestrator zielen
  (`agent:main:acp:…`/`agent:coding-main:…` werden abgelehnt → Eintrag ignoriert, synthetisch).
  Metadata (`mode`/`cwd`/`backend`/`acpAgentId`) bleibt informativ.
- **Beide Pfade teilen eine Herleitung** (`resolveHarnessSessionTargetKey` in agent-map.ts):
  Adapter-`deriveBindingRecord` UND Bridge-`resolveDashboardBindingDecision` (via
  `HarnessRoster.harnessSessionTargetKey`) liefern denselben Target — Pflicht, weil in der
  MVP-Komposition die Brücke aktiv ist (hooks-only nach Adapter-Registrierung) und die
  §4.2-Row-Miss-Delegation vor der Adapter-Synthese antwortet; unterschiedliche Targets
  hier würden das Fix im Produktbetrieb tot stellen.
- **Resilienz:** ungültige Einträge (not-ACP-shaped, Orchestrator-Target, Array-/Nicht-Objekt-Shape)
  werden ignoriert (Fallback synthetisch) statt die ganze Bindung abzulehnen.

**Weg B — host-seitiger ensure-Pfad (Materialisierung der `acp_sessions`-Row host-seitig)**
ist seit Phase 2.21 überflüssig geworden: der Plugin nutzt den offiziellen
`ensureConfiguredAcpBindingReady`-Contract (plugin-sdk `acp-binding-runtime`) SELBST —
siehe §11.1 (synthetische Keys bleiben unbeinitialisierbar, aber provisionierte Keys sind
echt gespawned und ready).

## 10. Reply-Delivery-Claim (Phase 2.20 F4 → Phase 3.1 Fix 2.0, Weg A: Agent-Spawn)

**Problem (F4):** Webchat-UI-Delivery ist Transcript-Projektion auf die ORIGIN-Konversation
(dispatch-from-config ~1926 scannt per runId-Match); retargetete Dispatches schreiben den Reply
NUR ins TARGET-Transcript, und `resolveReplyRoutingDecision` (:2926) liefert webchat→webchat immer
false → der Harness-Reply stirbt im Target. Der Host-eigene Pfad für plugin-owned Bindings claimt
stattdessen den Turn: plugin-owned Records (`pluginBindingOwner:"plugin"` + pluginId + pluginRoot,
gesetz seit Phase 2.20 in derive/synthesize/hydrate; adapter-bind bleibt marker-frei) →
`resolveBoundAcpDispatchSessionKey` SKIP Retarget (:191) → `hookRunner.runInboundClaimForPluginOutcome`
→ case `handled`: `persistPluginBindingUserTurn` + `deliverBindingPayload(reply,"terminal",owner)` →
Mirror-Append (TARGET) + `broadcastChatTerminal` (LIVE ORIGIN).

**Phase 2.20-Seam (verworfen):** der Claim-Handler startete den Turn via
`api.runtime.gateway.request("sessions.send" → ack.runId → "agent.wait" → terminalReply)`.
LIVE-BEFUND 12:09:58: `Gateway requests are only available to bundled or trusted official
plugins. Plugin "acp-dashboard-binding"` — `dispatchTrustedPluginGatewayMethod`
(server-plugins-CzOpf53P.mjs:369) verlangt `canTrustedOfficialPluginRequestScopes` (offizielle
Katalog-Provenienz + Integrität; Source-Path-Plugin erreicht das NIE, kein Config-Flag).

**Phase 3.1 Weg A (implementiert, src/reply-claim.ts):** Turn-Start über `api.runtime.subagent`:
- `subagent.run({sessionKey: target, message})` dispatcht den `agent`-Gateway-Method **in-process**
  (`dispatchGatewayMethodInProcess`, `agentRunTracking:"plugin_subagent"`, synthetischer
  system-Operator-Client) — OHNE den trusted-official-Gate (Beleg:
  `createGatewayPluginRuntimeBindings` binde `subagent` unangetastet neben `gateway`
  (package-update-activation-recovery.mjs:1308663); `createGatewaySubagentRuntime.run` ruft
  `dispatchGatewayMethodInProcess("agent", …)` direkt, server-plugins-CzOpf53P.mjs).
  Doc: docs/plugins/sdk-runtime/background-work.md#api-runtime-subagent.
- `subagent.waitForRun({runId, timeoutMs})` → kanonisches Wait-Result (`AgentWaitResult`,
  run-wait.types.d.ts) mit `terminalReply {disposition:"visible", text}`; Status auch `pending`
  (in-process, kein Client-Timeout-Grace nötig; Timeout cancelt NICHT den Run).
- `api.runtime.hooks.dispatchHookAgentTurn` ist explizit trust-gated + `hook:`-key-gebunden —
  NICHT verwendbar; subagent ist der Architektur-korrekte Agent-Spawn-Weg.
- Delivery bleibt Claim-Result-basiert: `{handled:true, reply:{text}}` → Host `deliverBindingPayload`
  (kein eigener Session-Write — alle Write-Seams ohne Gateway wären Trust-gesichert).
- Fallback-Vertrag unverändert: `handled:false` NUR vor Turn-Start (run wirft/kein runId/keine
  subagent-Surface/gateway unavailable → Host-Notice + Normal-Processing); NACH Turn-Start immer
  `handled:true` (Wait-Failure-Notice bei waitForRun-Throw), sonst Doppel-Processing.
- Option `harnessReplyWaitMs` (default 120s, clamp 1s–15min) bounds waitForRun.

## 11. Phase 2.21 — Auto-Provisioning + Workspace-Konvention (GaRoN 11:59/12:30)

### 11.1 Auto-Provisioning (harnessSessions wird optional)

**RE-Befund (dist-verifiziert, 2026-10-10):** Es gibt einen un-gegateten OFFIZIELLEN
Spawn-Contract in der Plugin-SDK: `openclaw/plugin-sdk/acp-binding-runtime` exportiert
`ensureConfiguredAcpBindingReady` (dist/persistent-bindings.lifecycle-DU_YBswY.mjs:
`ensureConfiguredAcpBindingSession`) → `acpManager.resolveSessionAsync` (Struktur-Check) →
`acpManager.initializeSession` (manager-DsPnlciX.mjs:1041 `runManagerInitializeSession`) →
`runtime.ensureSession` (ECHTER Backend-Spawn, cwd/model/thinking through runtimeOptions) →
Session-Meta-Write (`writeSessionMeta`/`upsertAcpSessionMetaRow`, state "idle"). Danach
antwortet `resolveStoredAcpSession` `kind:"ready"` — d. h. **die §9-Lücke
(synthetische Keys können nie initialisiert werden) ist für keys, die der Plugin selbst
via diesem Contract initialisiert, geschlossen.** Kein Trust-Gate auf diesem Weg (anders
als `api.runtime.gateway.request`, siehe §10).

**Implementierung:**
- Neue Config-Option `plugins.entries['acp-dashboard-binding'].config.autoProvision`
  (default **true**; nur explizites `false` deaktiviert). `harnessSessions` bleibt als
  manueller Override und ist keine PFLICHT mehr.
- **Target-Kaskade** (eine Herleitung, geteilt von Adapter-Derive UND Bridge-Decision —
  `resolveHarnessTargetOrigin`/`HarnessRoster.harnessProvisionedTargetKey` in agent-map.ts):
  1. `harnessSessions` (validiert, wie §9) → configured target.
  2. Auto-Provision (autoProvision aktiv + Provisioner registriert) → deterministischer
     Key pro Agent, Ensure fire-and-forget gekickt.
  3. Synthetischer per-Conversation-Key (Pre-2.21-Fallback, §9-Lücke bleibt dokumentiert).
- **Deterministischer Keys statt random Mint:** `agent:<agentId>:acp:binding:webchat:default:<sha16("webchat:default:harness:<agentId>")>`
  (buildHarnessProvisionedSessionKey — exakt `buildConfiguredAcpSessionKey`-Grammatik,
  conversationId ist das Pseudo-Ergebnis `harness:<agentId>`). Vorteile: Derive bleibt
  synchron/deterministisch (Resolve→Touch→Re-Resolve-Stabilität, §4.2/§10-Vertrag bricht
  nicht), Restart-regenerierbar, ein Key pro Agent.
- **Dedupe/Lifecycle (agent-map):** Ensure-Dedupe pro Agent (in-flight Join), Spec-Signatur-
  Cache nach Erfolg (gleiche spec → Skip), Spec-Änderung → Re-Ensure (ensure contract
  selbst schließt/neuspawnt bei Struktur-Mismatch), Fehler → kein Cache, nächster Consult
  retried. Provisioner-Registrierung: setDashboardBindingProvisioner (index.ts, registerFull),
  Dispose cleared via eigenem RuntimeLifecycle (`acp-dashboard-binding.auto-provision`).
- **Barrier:** resolved Records handen den Key IMMER sofort aus (fire-and-forget) — der
  erste echte Dispatch wartet im Reply-Claim (src/reply-claim.ts) auf den in-flight Ensure
  (`pendingDashboardHarnessProvisioning`), NUR für provisionierte Targets. Ein
  fehlgeschlagener Ensure blockiert den Claim nicht: der Turn startet trotzdem und der
  Host surfact die ACP-Init-Fehlermeldung als Reply (`handled:true`, sonst Doppel-Processing).
- **Metadata-Parität:** provisionierte Records (Derive UND Bridge-Synthese) tragen
  `metadata.provisioned: true` (informativ); configured/synthetisch nicht.

### 11.2 Workspace-Konvention

Persistente Harness-Workspaces leben auf der AGENT-KONVENTION:
`/config/clawd/agents/<agentId>/` (codex, claude, opencode, …). `DEFAULT_CWD_PREFIX`
(agent-map.ts) ist jetzt `/config/clawd/agents/`; das Plugin liest die eigentlichen
Workspace-Pfade ohnehin aus `agents.entries` cfg (Präzedenz `runtime.acp.cwd` >
`entry.cwd` > `entry.workspace` > Default-Prefix). Die `/share/temp/acpx-workspace/`-Welt
ist ab jetzt NUR noch Pipeline-Run-Scratch (sessions_spawn mit cwd-Isolation je run).

### 11.3 Alt-Last (Bereinigung = Trash-Go des Operators, der Plugin löscht NICHTS)

Die Harness-Workspaces `/share/temp/acpx-workspace/{codex,claude}` tragen GaRoN-Test-
Verunreinigungen (codex: `memory/2026-10-10-1101.md`, claude: `memory/dreaming/`) +
geseedete Identitätsdateien (AGENTS/SOUL/IDENTITY/USER + avatars; BOOTSTRAP.md in opencode)
aus dem alten Workflow. Der neue Workflow legt Identität+Workspace am
`/config/clawd/agents/<id>/` an; die alten Dateien sind Alt-Last und können vom Operator
separat bereinigt werden (der neue Workflow referenziert sie nicht mehr).

## 12. Phase 3.5 — Transcript-Mirror-Fehlt (GaRoN 12:23 — Forensik + Fix, 2026-10-10)

### 12.1 Befund

Test 5 (Session cbaa0035 @ 12:23, live): der Turn WURDE sauber geroutet — der Target-Session
26b6335a erhielt `human_direct_message` + `run_completed` ✓, `state_heads` aktualisiert ✓ —
ABER GaRoN sah die Antwort in seinem UI-Chat (cbaa0035) nicht.

### 12.2 Verifizierte Mirror-Mechanik (dist, 2026.9.9)

- **Claim-Delivery-Kette:** `deliverBindingPayload(reply, "terminal", transcriptOwner)`
  (dispatch-from-config-BG9rT_X3.mjs:3077-3094) baut
  `sourceReplyTranscriptMirror: transcriptOwner` in das Reply-Payload; falls
  `routeReplyOperationToOriginating` null liefert (webchat→webchat: `routeReplyRuntime`
  :2967 ist für interne Webchat-Turns nie geladen) → `turnLedger`-Fallback → projektierter
  Chat-Dispatcher → `finalizeChatSendDispatchedReplies`
  (chat-send-handler-CxoF4cDR.mjs:2297): Assistant-Append an den MIRROR-OWNER (kind
  "owner", `expectedSessionId` erfüllt) ODER Skip (kind "blocked", Recorder hat den
  Turn bereits persistiert) + immer `broadcastChatTerminal({sessionKey: ORIGIN})` (:2491)
  als LIVE-Delivery.
- **Mirror-Owner ist IMMER das TARGET:** `persistPluginBindingUserTurn`
  (dispatch-from-config:2603-2645, :2601) nimmt `pluginBindingSessionKey =
  pluginOwnedBindingRecord.targetSessionKey` und persistiert den User-Turn (approved)
  in die TARGET-Session — `resolveTranscriptMirrorOwner` (chat-send-handler:2266) löst
  also auf `record.targetSessionKey` auf. Der ORIGIN-Transcript erhält in der
  Claim-Pipeline NIE eine Assistant-Zeile — per Host-Code (empirisch bestätigt:
  codex-DB Target-Window 8c5d21fa seq15 = Mirror-Append der Notice mit
  `idem ph35-mirror-test-0001`; Origin-Window fd0f1d7d steht ohne Reply).
- **Unsere Row kann daran nichts ändern** (alle drei Host-Design-Pfade void):
  (a) `deliverBindingPayload` liest KEINE Binding-Row-Metadata für den Mirror
  (Owner ist Recorder/host-hergeleitet);
  (b) `session_upstream_links` ist eine EXTERNAL-Catalog-Watcher-Tabelle
  (join mit session_watch_cursors nötig; dist-Datei ist reine Watcher-Verwaltung) —
  KEIN Reply-Mirror-Mechanismus; live leer;
  (c) direkte Origin-Transcript-Writes via `sessions.*`/Transcript-Append sind für
  Source-Path-Plugins trust-gegatet (§10: `dispatchTrustedPluginGatewayMethod`).
- **Alternativer Host-Modus (warum kein Patch):** die designed acpx-Thread-Lage
  (🤖-Threads, z. B. 79ce1bb3→claude ad83e8ed) hat KEINEN Origin-Transcript-Window
  überhaupt — das Control-UI liest die Historie aus der gebundenen TARGET-Session.
  Plugin-owned Records sind aber vom Reply/Historie-Retarget-Pfad ausgeschlossen
  (`isPluginOwnedSessionBindingRecord`, get-reply-eZY--4sq.mjs) — für einen
  Origin-Chat, der die Target-Historie anzeigt, müsste das Record-Marker-Prädikat
  des Hosts einen zweiten Ausschluss-Zweck bekommen bzw. das Control-UI müsste
  gebundene Chats auf die Target-Session-Lese-Pfad legen. Beides ist Host-(Upstream-)Sache.

### 12.3 Sichtbarkeit = Live-Broadcast + Target-Historie

In der Phase-3.1-Architektur ist die Antwort in GaRoN's Chat daher BY HOST DESIGN
LIVE-only sichtbar (`broadcastChatTerminal`, chat-send-handler:2414/:2491 — solange die
UI-Verbindung steht). Vollständige Historie (User+Assistant) ist im TARGET/Harness-
Session-Transcript persistiert (dorthin spiegelte der Host), nicht im Origin-Chat.
Nach einem Reload der Origin-Chat-Ansicht fehlen die Antworten bis zum Upstream-Fix.
Fix-Weg (Upstream-Issue, nicht Plugin): Origin-Transcript-Mirror für plugin-owned
Bindings in `persistPluginBindingUserTurn`/`sourceReplyTranscriptMirror` ergänzen
(Owner-Berechnung um `originSessionKey` erweitern) — dokumentiert als der gewählte
"kein Host-Patch"-Pfad.

### 12.4 MVP-Fix im Rahmen (Race-Hardening)

Neuer Live-Bug aus Phase 3.5: `subagent.run` ackt den runId BEVOR der Gateway den Run
registriert (audit `agent.run.started` ~200 ms nach dem Ack) — der sofortige
`waitForRun` warf und degradierte zur "waiting failed"-Notice (traf BEIDE Live-Tests).
`settleRunWait` (src/reply-claim.ts) retried jetzt schnelle Wait-Failures mit kurzem
Backoff [100,250,500,750] ms (Optionen `waitRetryDelaysMs`/`waitRetryCallBudgetMs`
für Tests); langsame Throws gehen direkt zur Notice (echter API-Fehler). 123 Tests,
tsc 0; MVP==Repo==/config/.openclaw/plugins bit-identisch.
