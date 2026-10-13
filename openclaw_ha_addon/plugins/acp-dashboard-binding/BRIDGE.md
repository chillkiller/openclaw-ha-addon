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

## 13. Phase 2.22 — Origin-Workspace-cwd (GaRoN Phase B, 18:46 Befund → GO)

### 13.1 Befund (GaRoN-UI-Test 18:46)

Binding + Zustellung + Spiegelung funktionieren ALLE (human_direct_message →
Harness-Antwort live + persistiert in der gebundenen ACP-Session). EINZIGER Defekt:
die gebundene Harness-Session hatte cwd=`/share/temp/acp-rebuild` (Beweislauf-Debris
über den `harnessSessions`-Override). Persistente ACP-Sessions behalten ihren
SPAWN-cwd (`runtime.acp.cwd` wirkt nur beim ersten Spawn) — der Agent sah nur den
temp-Ordner, nicht den Projekt-Ordner desselben Dashboard-Fensters.

### 13.2 Kandidatenprüfung (dist + plugin-sdk verifiziert)

- **(a) InboundClaimContextLike volles Shape** (`message-hook-mappers-1uJn41lN.mjs:
  buildPluginInboundClaimContext:215-231`): der Host liefert channel/accountId/
  conversationId/**sessionKey**/agentId/parentConversationId/senderId/messageId/
  runId/callDepth + reply-/trace-Felder — **KEIN projectId, KEIN cwd**. Toter Endpunkt
  für cwd (sessionKey haben wir ohnehin über die Binding-Ref).
- **(b) message_received/before_dispatch-Hook-Kontexte** (dispatch-from-config
  ~900-920, `toPluginMessageReceivedEvent`): sessionKey + metadata
  (originatingChannel/surface/…), kein Projekt/cwd. Toter Endpunkt.
- **(c) api.runtime als Read-Surface**: `runtime.state.openKeyedStore` ist
  plugin-scoped (keine Host-Session-Nodes lesbar), `gateway` ist Trust-geklärt
  (Phase 3.1, §10), `subagent` ist Turn-Delivery, kein Lesen. Kein officieller
  session→project-Export im plugin-sdk (agent-workspace-runtime ist Memory-only).
- **(d) Konfig-Mapping `plugins.entries[…].config.workspaces`**:
  implemented (unten).
- **(e) Ensure-Contract cwd-Parameter**: **JA** — und das ist der Schlüssel;
  `ensureConfiguredAcpBindingReady({cfg, configuredBinding})`
  (plugin-sdk `openclaw/plugin-sdk/acp-binding-runtime`, un-gegatet) liest im Core
  (persistent-bindings.lifecycle-DU_YBswY.mjs) NUR `configuredBinding.spec` — der
  Plugin übersetzt `spec.cwd` direkt in `acpManager.initializeSession` (cwd-Param)
  und `sessionStructurallyMatchesConfiguredBinding` (:19-21) vergleicht Meta-cwd
  gegen `spec.cwd` (Mismatch → Close+Reinit). Ein per-cwd-ge-scopeter Session-Key ist
  frei wählbar: `buildConfiguredAcpSessionKey` hasht nur channel/accountId/
  conversationId — pseudo conversationId `harness:<agentId>:ws:<sha16(cwd)12>`
  kollidiert nicht (Präfix `harness:`, anders als echte Dashboard-uuids) und
  erzeugt KEINE Host-Kollision (die acp_sessions-Zeile schreibt unser eigener
  Ensure). Damit kann ein cwd-Wechsel NIE eine bestehende Session wegclonken.

### 13.3 Verifizierter Datenpfad (live geprüft, 2026-10-10)

1. Agent-DB `/config/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`,
   `session_nodes.session_key` = die Origin-Conversation-Key
   (z. B. `agent:claude:dashboard:27eddc7c-…`) → `project_id` +
   `entry_json` mit **`sessionRoot`** (verbatim Origin-cwd) und `projectId`.
2. State-DB `/config/.openclaw/state/openclaw.sqlite`, `projects`:
   `id` → `repo_root` (Fallback, wenn entry_json keinen sessionRoot trägt).
Beide DBs sind node:sqlite/WAL — read-only Concurrent-Reader ist vom Host selbst
unterstützte Semantik (LIVE mit node-26 `process.getBuiltinModule('node:sqlite')`
gegen beide Dateien nachgewiesen; auch `state/openclaw.sqlite`).
Plugin-lokale Helfer: `resolveOpenClawStateDir` (Env-Kette OPENCLAW_STATE_DIR >
OPENCLAW_CONFIG_DIR > dirname(OPENCLAW_CONFIG_PATH) > XDG_CONFIG_HOME/.openclaw >
HOME/.openclaw — im Add-on landen alle auf `/config/.openclaw`), `trimOriginConversationKey`
(Thread-Suffix → Basis-Key), `parseOriginWorkspaceEntryJson`.

### 13.4 Gewählter Weg (ohne Upstream-Änderung, openclaw.json-konfigurierbar)

Sync-Reader-Seam (`setOriginWorkspaceReader`, agent-map.ts) + node:sqlite-
Implementierung (src/origin-workspace.ts, wired in index.ts registerFull VOR
Runtime/Bridge). **Sync**, weil Resolve/Ensure sync und deterministisch bleiben
müssen (resolve → touch → re-resolve); Memoization macht das günstig und stabil:
Treffer permanent gecached (sessionRoot eines Dashboard-Gesprächs ändert sich nicht
unter dem Key), Misses mit 30-s-TTL (transiente DB-Fehler heilen turns später statt
falschen cwd zu pinnen).

**cwd-Ladder** (`resolveOriginWorkspaceCwd`, agent-map.ts) — UNTER dem unveränderten
`harnessSessions`-Override und ÜBER dem Agent-Default (`runtime.acp.cwd` > `entry.cwd`
> `entry.workspace` > `/config/clawd/agents/<id>`):

1. `config.workspaces[<conversationId>]` (explizit, ohne DB-Zugriff)
2. `config.workspaces[<projectId>]` (explizit, projectId via Reader)
3. Origin-`sessionRoot` (verbatim cwd der ORIGIN-Session)
4. Origin-`projects.repo_root`
5. null → Agent-Default-Ladder unverändert.

Nur absolute Pfade zählen; `deriveOriginWorkspace:false` schaltet die Beine 2-4 ab
(config-only Modus). Reader wird NUR für bind-eligible Dashboard-Klassen-IDs
angerufen — `harness:<id>`-pseudo-Keys und `agent:<id>:main`/acp-Klassen berühren
die DBs nie.

**Key-Scope** (`buildHarnessProvisionedSessionKey(spec, cwdScope?)`): mit Origin-cwd
wird der pseudo conversationId `harness:<agentId>:ws:<sha16(cwd).slice(0,12)>` —
**ein persistent Session pro Agent × cwd-Scope** (Sessions behalten Spawn-cwd;
unterschiedliche Workspaces teilen sich eine Session sonst close/reopen-Krieg).
Ohne Origin-Treffer exakt das 2.21-Verhalten (per-Agent-Key, Agent-Default-cwd).
Ensure-Dedupe/Signature-Cache/Barrier sind jetzt per TARGET-KEY (nicht Agent-Id)
— `pendingDashboardHarnessProvisioning(target)` nimmt den Session-Key (bzw. legacy
Agent-Id). Reply-Claim-Barrier keyed auf `metadata.provisioned` + Target-Key.

**Metadata-Parität**: beide Synthese-Pfade (Adapter-Derive + Bridge-Synthesis)
stempeln `metadata.cwd` = effektiver cwd (Origin schlägt Config-Default) und
`metadata.originWorkspace` = Ladder-Leg (provenienz für GaRoN-Forensik).

**Manifest**: `workspaces` (map) + `deriveOriginWorkspace` (boolean) + `harnessReplyWaitMs`
(bereits gelesen seit 3.1, jetzt erstmals deklariert) im configSchema
(openclaw.plugin.json) — Reload-Deadlock-Regel beachtet.

### 13.5 Ehrliche Risiken / fehlende Steine

1. **Kein offizieller Read-Surface für session_nodes/projects** — der Reader liest
   HOST-EIGENE sqlite-Dateien (read-only). Schema-Kopplung: `session_nodes`
   (session_key, project_id, entry_json) + `projects` (id, repo_root) sind
   Daten-Schema (stabler als dist-Modulhashes, aber NICHT vertraglich). Alle
   Fehler fail-soft → Agent-Default-cwd. **Upstream-Fix-Kandidat**: SDK-Export
   „lookup origin session workspace (conversationId → {projectId, cwd})" oder
   projectId im BindingConversationRef (session-conversation-binding:31-35).
   Danach kann der Reader durch ein einziges SDK-Call ersetzt werden.
2. **Turn-1-Freeze**: die Bridge-Zeile (§4.2-Row) friert den ersten Record ein —
   ein cwd-Änderungs-Ergebnis nach TTL-Retry ändert den Target NICHT für bereits
   resolve-antwortende Konversationen (Rows bleiben). Deterministisch pro
   Konversation, aber Operator muss Row-Invalidation (Tombstone) nutzen, wenn er
   die cwd-Herleitung nach dem ersten Turn ändert.
3. **harnessSessions-Override bleibt oberste Prio** (GaRoN-Regel) — der
   live-stehende Override `claude → agent:claude:acp:0abbe325-…` (Beweislauf-Session,
   cwd=/share/temp/acp-rebuild) übersteuert die Herleitung, SOLANGE er in der
   Konfig steht. Deploy-Hinweis: Override entfernen oder durch den gewünschten
   Key ersetzen — erst dann greift die Origin-Herleitung für claude.
4. **node:sqlite Verfügbarkeit**: Host-Node ≥22.3 nötig (`process.getBuiltinModule`);
   ohne → Reader null → Agent-Default-cwd (Log warn). Kein static Import im
   Modul (keine Load-Abhängigkeit).
5. Lesen der DBs erfolgt in-process im Gateway — ein sqlite-Lesefehler (z. B.
   exotic Lock-Situation) kostet eine Miss-TTL-Phase mit falschem (Default-)cwds,
   kein Crash; konkurrierende WAL-Writer blockieren Reader nicht.

### 13.6 Tests

149 Tests (war 123/127), tsc 0: channel.test (12 neue: Env-Kette, DB-Layout,
entry_json-Parse, Thread-Trim, workspaces-Validierung, Flag, cwd-Scoped-Key,
Memoization/TTL/Throw, Ladder-Präzedenz, Ensure-Spec-Override, Legacy-Fallback,
Override/„synthetic“-Prezedenz, Metadata+Stabilität, Barrier per
Target-Key), dashboard-bridge.test (4 neue: Provisioned-Roster-Shape + Legacy,
§4.2-Parität mit Origin-cwd, harnessSessions-Prezedenz), reply-claim.test
(Barrier am cwd-scoped Key), origin-workspace.test (3 Integrationstests gegen
ECHTE sqlite-Dateien im tmp-Layout: sessionRoot/Thread-Fallback/Fail-soft,
projects.repo_root-Fallback, End-to-End Resolve/Ensure mit Scope-Key).

---

## 14. Phase 2.24b — Session-key clone mode: MAIN-Konversation (GaRoN 'B GO', 06:26, 2026-10-11)

### 14.1 Befund (Orchestrator, Nacht)

agent:claude:main-Turns WERDEN über die Binding-Service-Kette konsultiert
(`resolveDispatchConversationBinding → getSessionBindingService()
.resolveByConversationAsync(bindingContext)`, conversationId
`agent:claude:main`) — Beweis 17:10:52: sessionKey `agent:claude:main`,
outcome completed, `acp_error:acp_session_init_failed` (die Bindung stammte
dann noch aus dem Generic-Store auf dem 60bac-Key). Das Phase-2.10-Gate
(`isBindEligibleConversationId`) lehnt 3-Tel-Keys ab → resolve null → Host
wählt builtin. 2.24b: der Adapter liefert EINEN Binding-Record für main.

### 14.2 Der Gate (SEPARAT — dashboard-Gate bleibt UNVERÄNDERT)

`isMainConversationEligible(cfg, conversationId)` (agent-map.ts), geteilt von
Adapter-Derive und cwd-Ladder-Reader-Gate:

  1. EXAKTER 3-Tel-Shape `agent:<agentId>:main` (`agent:<id>:main:<thread>`,
     4-Tel, andere Klassen → nein).
  2. Roster: Phase-2.17-Ladder (boundAgents > excludedAgents >
     safe-default exclus.) UND `runtime.type === "acp"`
     (`resolveHarnessAgentSpec` — Hauptagent `agent:main:main` bindet ohne
     expliziten Escape-Hatch NIE).
  3. Flag: `plugins.entries['acp-dashboard-binding'].config
     .bindMainSessions !== false` (default TRUE; Manifest
     openclaw.plugin.json configSchema deklariert das Feld — Regel 4).

`isBindEligibleConversationId` (dashboard 18:03-Regel) ist BYTE-UNVERÄNDERT.

### 14.3 Klon-Key (dist-verifiziert, live gezeigt)

Target = Kaskade unverändert; Klon-Regel 1:1: der origin session-key-Text IST
die conversationId des ACP-Keys. Für claude:

  buildAcpBindingSessionKey({conversationId: "agent:claude:main",
                             agentId: "claude", channel: "webchat",
                             accountId: "default"})
    = agent:claude:acp:binding:webchat:default:60bac3d65e697154

Live verifiziert: sha256("webchat:default:agent:claude:main")[0..16] =
`60bac3d65e697154` — der "Nachtklassiker"-Ghost-Key wird zum geensurten Key
(ensure-spec conversationId = `agent:claude:main`, dist
persistent-bindings.lifecycle-DU_YBswY.mjs: der ensure-Contract setzt KEINE
Shape/Gate auf spec.conversationId; buildConfiguredAcpSessionKey baut den Key
aus channel:accountId:conversationId und initializeSession erhält nur
agentId/mode/cwd/backend — ensure-key ≡ resolve-key by construction).
Ensure-Regeln (dedupe, signature, stabil, boundAt 0) teilen sich die
Dashboard-Klone unverändert; `metadata.provisioned` markiert der Leg.

### 14.4 cwd-Ladder für main (EHRLICH — live geprüft, 2026-10-11)

Die MAIN-session_nodes-Zeile von agent:claude:main in
/config/.openclaw/agents/claude/agent/openclaw-agent.sqlite:

  - project_id = NULL,
  - entry_json: sessionId/createdAt/lifecycleRevision/usageFamilyKey/… —
    **KEIN cwd**, auch kein sessionRoot/projectId (parseOriginWorkspaceEntryJson
    → null).

→ Der Reader wird für MAIN-Keys NUN angerufen (fail-soft, memoized, gleiche
TTL-Regel), antwortet aber HEUTE immer null → `resolveOriginWorkspaceCwd`
null → **Agent-Default-cwd** (runtime.acp.cwd aus der Entry; live für claude:
`/config/clawd/agents/claude`). Forward-compat-Bein eingebaut: sobald eine
Zeile ein absolutes `cwd`-Feld in entry_json trägt, greift das neue
Ladder-Bein `origin-entry-cwd` (NACH sessionRoot/repoRoot, dashboard-Verhalten
unberührt). Konsequenz: der ensure für main spawnt eine persistent-session
mit Agent-Default-cwd (GaRoN weiß das).

### 14.5 Unverändert (verifiziert)

  - Bridge (`resolveDashboardBindingDecision`) bleibt DASHBOARD-only:
    parseDashboardConversationKey lehnt `agent:<id>:main` ab → §4.2-Delegation
    antwortet null → Adapter-Derive erzeugt den main-Record (keine §4.2-Rows
    für main). dashboard-bridge.test beweist beides Beine.
  - reply-claim Barrier: `pendingDashboardHarnessProvisioning(<raw key>)`
    (isAcpShapedSessionKey-Pfad) — der main-Klon-Key ist acp-geformt; Barrier
    keyed auf metadata.provisioned + target key, verifiziert auf dem
    60bac-Key. bindMainSessions:false → Claim handled:false, kein Ensure/Run.
  - Kaskaden-Reihenfolge auch für main: harnessSessions-Override >
    auto-provisioned Klon > synthetisch (dokumentiert: der Override gilt auch
    für main — live steht harnessSessions = {} → Klon-Leg aktiv).
  - `acp`-Klassen, 4-Tel-`agent:<id>:main:<x>`, andere Kanäle: nie gebunden.

### 14.6 Tests (162/162 grün, --cache=false; tsc strict clean)

channel.test (7 neue in "Phase 2.24b: MAIN-Klon"): Gate-Matrix (Shape/Flag/
Roster/Escape-Hatch + dashboard-Gate byte-unverändert), Adapter-Record mit
LITERALLY 60bac3d65e697154 + Ensure-Kick + Stabilität, Nicht-Roster-Agenten
null, bindMainSessions:false (dashboard-Leg unberührt),
harnessSessions-Override-Präzedenz für main, Ensure-Spec trägt den origin
session-key-Text ohne Reverse-Parse, cwd-Ladder für main.
reply-claim.test (2 neue): Barrier auf dem main-Klon-Key (raw-key-Pfad,
Reihenfolge ensure→run beweisbar), Flag-off → handled:false.
origin-workspace.test (1 neuer, ECHTES sqlite): main-Zeile ohne cwd → null →
Agent-Default; cwd-Feld → `origin-entry-cwd`; relative Werte zählen nicht.
dashboard-bridge.test (1 neuer): Bridge-Entscheidung bleibt dashboard-only.

### 14.7 Ehrliche Risiken / fehlende Steine

1. **Agent-Default-cwd für main-Klone** (14.4) — die persistent main-Klon-
   Session läuft im Workspace der ENTRY, nicht im Projekt-Workspace irgendeines
   Dashboard-Fensters. Kein cwd-Bein vom Host heute; upstream-Kandidat wie §13.5.1.
2. **Eine session pro agent**: alle main-turns des agents teilen SICH den einen
   Klon-Key (`agent:<id>:acp:binding:<hash von agent:<id>:main>`) — Klon-Regel
   ist "agent × main = 1 Session", NICHT "ein session pro main-turn".
   Persistente Session, Host-Retention wie gehabt.
3. **Generic-Store-Ghost**: der alte Generic-Store-Record auf 60bac bleibt im
   Host-Store, ist aber während des plugin Ladens gespiegelt (Phase-2.10-
   Limitation) — der Derive gewinnt. Nach plugin-Disable würde der Ghost
   (wieder ohne acp_sessions-Zeile NACH Retention) sichtbar; heute liegt die
   Zeile auf dem Key (ensure) — dann ists kein Ghost mehr.
4. **main-Record ohne Provisioner/autoProvision:false** → synthetische main-Leg
   (gleicher Key, kein ensure) → ACP_SESSION_INIT_FAILED wie die 2.24-Note
   für dashboards. Vor-2.21-Verhalten, dokumentiert.
5. bindMainSessions:false betrifft NUR den Adapter-Derive; die Kaskade selbst
   (harnessProvisionedTarget etc.) bleibt shape-agnostisch — konsistent mit
   der Dashboard-Kaskade (Gate liegt IMMER upstream im Derive).

---


## 15 (archiviert) — Phase 3 — Generalisierte Harness-Config → eigenständiges Plugin

Repo-Split A2 (2026-10-11, GaRoN-GO "Direkt A2"): die generalisierte
Harness-Config-Generierung lebt jetzt als EIGENSTÄNDIGES Feature-Plugin
`harness-config-writer` in `openclaw_ha_addon/plugins/harness-config-writer/`
(GaRoN-Split-Idee: 3 unabhängig pflegbare Teile — ha-addon / dashboard-channel /
config-writer). Vollständige Doku inkl. §15.1–15.7 siehe
`plugins/harness-config-writer/BRIDGE.md`.

Was sich geändert hat:
- **Config-Key:** `plugins.entries['harness-config-writer'].config.harnesses`
  (Legacy-Key `plugins.entries['acp-dashboard-binding'].config.harnesses`
  wird vom Add-on-Helper `oc_acpx_helper.py` einmalig migriert: copy → delete).
- **Trigger:** Plugin-Load des Writer-Plugins (idempotent, next-boot-Semantik,
  ADDITIV-GARANTIE unverändert: Absence = no-op, bundled acpx Vendor-Auth
  läuft weiter).
- Dieses Channel-Plugin ist seitdem reiner Bracket/Claim-Brücken-Code
  (channel/bridge/reply-claim/agent-map/binding-adapter/origin-workspace).

## 16. Bundled-Root-Trust-Deploy (Kammerjäger Restart-Log, 2026-10-11)

**Befund (v0.7.13.17-Boot, 16:32):** `[acp-dashboard-binding] persisted bridge
state unavailable; memory-only rows` — beim Boot liefen ALLE `openKeyedStore`-
Calls des Bridge persistierten Stores in `PluginTrustRefusalError`. Belegkette
(dist 2026.9.9):

- `loader-runtime-load-DpgEqnzx.mjs:411` — `createRuntimeBase()` stellt
  `state.openKeyedStore` als `unavailable()` (throws) bereit; nur der
  runtime-Proxy überschreibt es (Zeile 4645) mit `createPluginStateKeyedStore`.
- `:4607` — der Proxy gated das dahinter: `assertTrustedPluginRuntime`
  wirft, wenn `record.origin !== "bundled" && record.trustedOfficialInstall
  !== true`.
- `installed-plugin-record-match-BHcdsxjn.mjs:217` — `resolvePluginTrust`
  gibt "trusted-official" NUR über den offiziellen Katalog
  (`official-external-plugin-catalog`, npm `@openclaw/*` oder ClawHub
  "official"-Channel). Path-Deployed Plugins: `trust.reason = "record-missing"`
  (empirisch via `openclaw plugins inspect --runtime --json`).
- `discovery-BDmn67Fz.mjs` — origin "bundled" kommt rein durch physische
  Zugehörigkeit zu `trustedBundledPluginRootsForPackageRoot` =
  `<pkgRoot>/dist/extensions` (bzw. dist-runtime/extensions; Source-Checkout
  zusätzlich `<pkgRoot>/extensions`). Kein Config-Flag, kein Datei-Marker —
  Trust ist hier PATH-is.
- Bundled-Plugins werden über `openclaw.extensions` im package.json geladen
  und brauchen EINE kompilierte Entry-Datei: `.ts` im Image-Bundled-Root
  scheitert hart an "Stripping types is currently unsupported for files under
  node_modules".

**Fix (Helper-Deploy-Umstellung, beides fail-soft):**
1. `oc_acpx_helper.py::_deploy_and_register_plugin` deployt bei vorhandenem
   Bundled-Root (`/usr/lib/node_modules/openclaw/dist/extensions`) den Payload
   VORKOMPIILIERT: esbuild bündelt `index.ts` zu einem self-contained
   `index.mjs` (relative Imports inlined; `openclaw/plugin-sdk/*` bleibt
   bare specifier — der Loader-Alias löst das, gleiche Mechanik wie beim
   config-origin TS-Load), `package.json`-Kopie mit
   `openclaw.extensions = ["./index.mjs"]`, dazu `openclaw.plugin.json` +
   BRIDGE.md. Byte-Vergleich → identische Boots bleiben read-only.
2. Der stale externe Deploy unter `CONFIG_DIR/plugins/<name>` wird entfernt
   (Shadow-Kandidat neben der bundled Variante — Inspect bewies: beide
   Kandidaten existieren parallel, der config-origin gewinnt mit
   explicit-Enable). `plugins.load.paths` bleibt registriert (harmlos +
   Fallback-funktional).
3. Fällt zurück auf den legacy externen Deploy (v0.7.13.17-Verhalten), wenn
   esbuild fehlt oder der Bundling-Step scheitert.
4. Plugin-Seite: die Bridge-WARN nennt jetzt die Ursache im Message-Text
   (das Gateway-Log serialisiert `message`, nicht das Error-Objekt) —
   `persisted bridge state unavailable … (caused by: <error.message>)`.

**Empirischer Probe (dieser Box, ohne Gateway-Restart):** `plugins inspect
acp-dashboard-binding --runtime --json` nach Umzug → `origin: "bundled"`,
`trust: {reason: "bundled"}`, `status: "loaded"` — beides für
acp-dashboard-binding UND harness-config-writer.

**Erwartete Rest-Folgen im Restart-Log:** die beiden Boot-Blocker (64s
`plugins.runtime-post-bind` und die Kaskade Slow-SQLite/Observer-Disabled/
sessions.list-Timeouts) müssen NACH dem Umstieg neu gemessen werden — das
Bündel ist kompiliert (kein TS-Stripping) und die Store-Öffnung geht jetzt
über den trusted Proxy; ob die 64s verschwinden, zeigt der nächste
Restart-Log (`gateway_startup_trace: true` → per-Plugin-Breakdown). Der
Terminal-Write-Ownership-Race (Agenda Punkt 1) bleibt davon UNBERÜHRT.

### 16.1. "Bundled channel"-WARN-Kette (Scan-Befund, 2026-10-11)

Der Vormittags-Run (9a45bc46) meldete 11×
`[channels] failed to load bundled channel acp-dashboard-binding: Stripping
types is currently unsupported … index.ts` (ab ~16:35). Ursachen-Chain
(dist `bundled-CMChYPbG.mjs`:

- `listBundledChannelMetadata` scannt ein `channels[]`-Feld im
  `openclaw.plugin.json` und klassifiziert das Plugin additionally als
  Bundled Channel — das ist die Channel-Discovery selbst, KEINE
  Misclassification: ein Channel-Plugin MUSS diesen Weg haben.
- Die LOAD-Warns entstanden, weil der Discovery-Entry auf ein TS-Stück
  lief (Probe-Phase: frisch kopierte .ts-Quelle bzw. leere package.json
  im Bundled-Dir) → der node-side Loader verweigert TS-Strip unter
  node_modules.
- Stand nach dem Trust-Deploy: Bundled-Dir trägt NUR `index.mjs` +
  package.json mit `openclaw.extensions=["./index.mjs"]` (0-Byte-legacy
  der manuellen Probe korrigiert) — der Scanner lädt es als Bundled
  Channel MIT Trust; die WARNs müssen beim nächsten Boot ausbleiben.
  Smoke-Check (6b) bewacht das.
- Manifest-Change bewusst NICHT: `channels[]` ist der
  Registrations-Contract der Channel-Plugin-Discovery. Erst beobachten;
  nur falls der Restart Double-Registration-Artefakte zeigt (normale
  Plugin-Pipeline + Bundled-Channel-Pfad gleichzeitig), dann gezielt
  fixen + auditieren.

### 16.2. Debug-Restart-Messung: 64-s-Block bestätigt weg (2026-10-11, 18:0x)

Der Boot nach dem v0.7.13.18-Update (Supervisor baute den Container frisch
aus dem Image) wurde mit ALLEN Debug-Channeln gefahren
(`gateway_log_level=debug`, beide Consoles, trace, `gateway_startup_trace=true`):

- **0 × "event loop blocked"** in der Trace-Summary und im Log — der
  64-s-`plugins.runtime-post-bind`-Block (Kammerjäger #1) ist WEG.
  Summary: `eventLoopMax=0.0ms`, `loadedPluginCount=14`,
  `gatewayMethodCount=491`.
- **Kein PluginTrustRefusal mehr** — `openKeyedStore` öffnet den
  persistierten Store über den trusted bundled Proxy (§16-Fix).
- **Keine "Bundled channel"-Load-Warns** — der Scanner lädt das
  kompilierte + trusted Entry oder skipped sauber (§16.1).
- Verbleibende Slowliness (gepumpte Phasen wie auto-enable ~48s /
  control-ui-assets ~107s, Slow-SQLite-Reflexe) = I/O-Wait + Debug-Log-
  Overhead, KEINE Event-Loop-Blockade. `gateway_startup_trace` selbst ist
  unschädlich — Messung `runtime-post-bind 83877.7ms total=209926.9ms`
  ist Summen-/Wait-Zeit unter Debug-Last, nicht mehr Blockade.
- Offene Beobachtung: clean-Info-Boot (nur startup_trace an, debug aus)
  als Vergleichswert zur 64-s-Ära; stuck session_nodes der claude-DB
  (Agenda Punkt 1, BACKLOG V34) sind vom Boot unabhängig und bleiben
  Claim-Pfad-Sache.

## 17. Punkt-1-Forensik: Terminal-Write-Owner-Race am Binding-Session-Entry (2026-10-12)

**Befund (live, v0.7.13.18-Boot, `/tmp/openclaw/openclaw-2026-10-11.log`):** 3/3
`acp_dispatch`-Turns in `agent:claude:acp:binding:webchat:default:4fbefeb91c
0aed3d` (18:22:31 / 18:29:36 / 18:40:22) reporteten `outcome=completed`,
scheiterten aber SOFORT danach (gleiche Sekunde) an der Terminal-Persistenz:

```
WARN  reply hot path timings … sessionKey=agent:claude:acp:binding:…4fbefeb9…
      outcome=completed reason=acp_dispatch
WARN  SQLite session write failed {"operation":"session-entry.patch",
      "storePath":"…/claude/agent/openclaw-agent.sqlite",
      "error":"Terminal write owner changed before commit"}
ERROR terminal session persistence failed session=…4fbefeb91c0aed3d
      run=<runId> error=Error: Terminal write owner changed before commit
```

**Entry-Folgezustand (claude-DB `session_nodes`, empirisch):**
`status:"running"`, `lifecycleRunId:"6c5fdecf…"` (Boot-Markierung 16:44:02),
KEIN `lastRunId`/`endedAt` — aber `observerDigest: "Run completed"`,
`health:"done"`. Der Run ist terminiert, der Entry-Status nie auf done
geklappt.

**Healthy-Counter-Example (gleiches Boot, gleicher Agent, gleiche Klasse):**
`agent:claude:acp:binding:webchat:default:60bac3d65e697154` — die
Main-Klon-Session (§14, bindMainSessions) — endet sauber: `status:"done"`,
`endedAt` + `lastRunId` persistiert. Der Unterschied zum Zombie: die
Main-Klon-Session läuft OHNE plugin-owned Claim-Mirror-Pfad.

### 17.1. Mechanik (dist 2026.9.9, file:line)

- `agent-run-terminal-writes-CZ5u4nvB.mjs`: `bindAgentRunTerminalWrite
  Context` (bindet den Write-Kontext des Prepared-Runtime an den
  Operational-Owner, `prepare.runtime-CraZtPFh.mjs:360` ist der einzige
  Bind-Site), `captureAgentRunTerminalWriteContext` (Capture vor async
  Session-Resolution) und `assertCurrent` (Z.3 9): wirft
  `"Terminal write owner changed before commit"`, wenn zwischen Capture und
  Commit (a) `getAgentRunContext(runId) !== owner`, (b) der terminalWrites-
  Entry ersetzt wurde, (c) der gebundene Context geändert (REBIND via
  bind) oder (d) die delegatedAuthority invalide wurde.
- `server-runtime-subscriptions-CLhV3Vvh.mjs:2707`: am Lifecycle
  `end`/`error` captured der Subscriber den Kontext und übergibt ihn an
  `sessionLifecyclePersistence.observe({…, writeContext})` → der
  Session-Entry-Patch läuft durch `writeContext.run` → assertCurrent. Die
  ERROR-Zeile ist `subsystem-BdcD5rKP.mjs:224`.
- **Korrektur der alten Punkt-1-Hypothese (BACKLOG V34):** der Host
  schließt den Dispatch-Lifecycle sehr wohl — `finishPluginBinding
  Dispatch("handled")` (dispatch-from-config-BG9rT_X3.mjs:3453) ruft
  `completeDispatchReplyOperation()` (Z.3461) und die Dispatch-Operation
  endet. Was dangle, ist NUR der Session-Entry-Patch, weil der
  Terminal-Write-Kommit scheitert.

### 17.2. Interpretation (Hypothesen, ehrlich gerankt)

- **H1 (führend):** Unser Claim-Reply löst im SELBEN Completion-Tick die
  Binding-Mirror-/Delivery-Writes aus (`{handled:true, reply}` → host
  `deliverBindingPayload` → transcript append am Mirror-Owner = TARGET =
  derselbe Session-Entry). Diese Writes wechseln den Write-Owner-Kontext
  des Entries zwischen Capture (lifecycle end) und Commit → assertCurrent
  wirft deterministisch. Die 3/3-Determinismus + der saubere Main-Klon
  (kein Mirror-Pfad) stützen das.
- **H2 (alternativ):** die delegatedAuthority des acpx-Agent-Runs wird
  durch die Turn-Lifecycle ersetzt (`validateAgentRunDelegatedAuthority`
  fällt). Die 3 Fehl-RunIds (7555140b/97f0f542/e8142904) zeigen im Log
  KEINE Fallback-/Retry-Marker — schwächer belegt.
- Der exakt identifizierbare REBIND-Site ist aus Dist-Reading allein
  nicht abschließend zu bestimmen — für den Upstream-Report ist die
  reproduzierbare Oberfläche (geclaimte Turn + failure-Sekunde + Entry-
  Zustand) vollständig belegt; die Hypothesen sind als solche benannt.

### 17.3. Plugin-Fix (Punkt 1, umgesetzt 2026-10-12): post-settle yield

`reply-claim.ts`: nach einem TERMINALEN `waitForRun`-Ergebnis (status
`ok`/Fehler-terminal) wartet der Handler `DEFAULT_POST_SETTLE_YIELD_MS
= 500` (clamp 0..10000, Option `postSettleYieldMs`), BEVOR er die Reply
zurückgibt — der Terminal-Entry-Patch (started sofort am lifecycle end)
commitet dann VOR den durch die Reply ausgelösten Mirror-Writes.
`timeout`/`pending` (Run läuft noch, kein Terminal-Write geplant) und der
Wait-Failure-Pfad yield-frei. Reine Scheduling-Änderung — Delivery-
Semantik unverändert, Max-Kosten 0,5 s/Turn.

**Verifikation:** vitest 28/28 in der Datei (+5 neue Yield-Tests:
terminal-yield ≥ Window, pending/timeout/wait-failure skip, negative
Option deaktiviert), Suite 166 passed + 1 skipped; strict tsc über die neue
`tsconfig.check.json` (deliverable source, tests via vitest) 0 Fehler;
Writer-Baseline unverändert 0. Live-Beweis steht beim nächsten geclaimten
Turn aus (Fehlspur "Terminal write owner" muss verschwinden; Smoke-
Check 5 bewacht die stuck-Metrik).

**Audit (2026-10-12, acpx-codex, GO):** Scope-Wächter 4 Dateien,
Semantics/Timing-Window (nach INFO-Rest: Assertions auf 100 ms verbreitert,
28/28), tsc 0/0, harnessReplyWaitMs-Belag bestätigt, Risiko-Review frei
(kein Dispatcher-Blocker, kein Double-Processing-Risk), §17-Docs konsistent.
Report: `agents/coding-review/findings/2026-10-12-punkt1-terminal-write-race-audit.md`
(gitignored).

### 17.4. §12-Mirror → Upstream #149801 (+ Familie #163078)

Upstream-PR **#149801 "fix(channels): dispatch replies in ACP-bound
conversations"** (OPEN, fd2fa6b9/a9c6c055) adressiert die Reply-Dispatch-
OWNER-Disziplin am selben Session-Entry, aber am anderen Saum: Turn-START
("prepared reply dispatch runtime owner was not published", Familie
#163078) vs. unser Befund am Run-Terminal (agent-run terminal writes).
Gemeinsame Wurzel: Cross-Owner-Writes am ACP-bound Session-Entry brauchen
eine Owner-Generationen/Zeitfenster-Disziplin; #149801 löst die
Admission-Seite (configured source agent als reply-runtime owner), lässt
die Terminal-Commit-Seite offen. **Unser Befund ist die fehlende
Terminal-Seite — passgenau als Ergänzungsevidenz für
#149801/#163078 nutzbar, nicht als Duplikat.**

Upstream-reifer Kern (für GaRoN zum Fileen):
1. Repro: conversation binding → geclaimter Turn (`runInboundClaim
   ForPluginOutcome` → reply via `deliverBindingPayload`) → lifecycle end
   captured Terminal-Write-Kontext; Entry-Patch wirft deterministisch
   "Terminal write owner changed before commit".
2. Folge: session_nodes-Entry bleibt `status:"running"` + dangling
   lifecycleRunId trotz `observerDigest: "Run completed"`; kein
   `lastRunId`/`endedAt`. Lazy-Heal nur über shouldClearRotatedState/…
   beim nächsten Prep — solange falscher Run-Status in UI/Smoke sichtbar.
3. Counter-Evidence: identische Main-Klon-Session OHNE Claim-Mirror
   committed sauber → der Mirror-/Claim-Pfad ist der deterministische
   Anteil.

**Kein Add-on-Host-Patch** (Unicode-guard-Klasse wäre hier zu groß für
einen Commit-Race), **kein Manifest-Change**, Plugin-fix ist
defensiv (yield). Upstream-PR bleibt der eigentliche Fix-Weg.
## 18. Bundled-Channel-Entry-Contract — Binding tot seit v0.7.13.18 (Forensik, 2026-10-12)

**Symptom (GaRoN):** Auto-Binding tot — neue Dashboard-Session (`+` neben dem
Agent-Namen) startet OHNE ACP-Klon (Beispiel: conversation `efadc1d4…`);
das ist VOR dem .19-Update begonnen (Main-Session), d. h. exakt mit dem
v0.7.13.18 Bundled-Root-Deploy (§16). Live-Beleg (debug-level, probe-debuglog-1
05:22): Hot-Path-Spans da, aber KEIN "plugin-bound inbound routed"-Verbose,
KEINE `[acp-dashboard-binding]`-Plugin-Zeilen → `pluginOwnedBinding` war live
null, während probe6/7 mit DEMSELBEN Deployment-Bundle in-process bindet.

**Wurzel (dist 2026.9.9):** Der §16-Umzug nach `<pkgRoot>/dist/extensions/`
macht das Plugin für den Host zum BUNDLED CHANNEL (`listBundledChannelMetadata`
filtert `manifest.channels > 0` — das `openclaw.channel`-Object wird zu
channels[] normalisiert). Der Host lädt dann den Entry-Wrap über den
Bundled-Channel-Pfad (`loadGeneratedBundledChannelEntry` →
`resolveBundledChannelModuleEntry`, bundled-CMChYPbG.mjs:129-141), der am
Default-Export EINEN VERTRAG durchsetzt:

    kind === "bundled-channel-entry" && id/name/description: string
    && register: function && loadChannelPlugin: function

Unser Entry war ein `defineChannelPluginEntry`-Record (channel-core SDK-Form):
**kein `kind`, kein `loadChannelPlugin`** → Check scheitert → Live-WARN
`[channels] bundled channel entry acp-dashboard-binding missing
bundled-channel-entry contract; skipping` (Boot 04:29:58 + jede CLI-Load,
11× am 2026-10-12) → `bundledChannelArtifactLoaders.plugin` (:283370) gibt
`undefined` → das Channel-Plugin wird im Gateway NIE instanziiert →
`registerFull` (Adapter, Claim-Hook, Bridge) läuft NIE → jeder Dispatch-
Consult null → embedded überall. Die Upstream-Bundled-Channels
(telegram/a2a/reef) bauen den Entry deshalb über dist
`defineBundledChannelEntry` (channel-entry-contract-4VRRlxPz.mjs:218) mit
`plugin: {specifier, exportName}`-Seitendatei.

**Warum der 18:01-Boot-Smoke "ALL GREEN" meldete:** der Smoke-Check griff
nur auf "failed to load bundled channel …" (Trust-Refusal, §16) — der
Contract-Skip logged eine ANDERE Zeile und war unsichtbar (Backlog 6b:
Check erweitert, acp_smoke_check.sh).

**Fix (dieser Commit, vor GaRoN-GO verifiziert):**
- `src/entry.ts` NEU: `defineBundledChannelCompatibleEntry` — baut den
  vertragskonformen Record (`kind` + `loadChannelPlugin`, plus `channelPlugin`-
  Kompatibilitätsfläche für den externen Pfad/Probes) und spiegelt die
  `defineChannelPluginEntry.register`-Semantik exakt ( gleiche
  Registration-Mode-Branches, registerChannel-vor-registerFull-Reihenfolge
  wie defineBundledChannelEntry).
- `index.ts`: Default-Export über den kompatiblen Builder statt
  `defineChannelPluginEntry`; `registerFull`-Body unverändert
  (pluginRoot → origin-workspace → runtime → claim hook →
  auto-provision → bridge).
- `src/entry.test.ts` NEU: repliziert `resolveBundledChannelModuleEntry`
  als Regression-Witness (Legacy-Form MUSS Scheitern, Shim-Form MUSS
  durchgehen, register-Branch-Semantik).

**In-process E2E (fix-Bundle via esbuild, /tmp/probe/contract-e2e.mjs):**
1. Contract auf dem gebauten Bundle: PASST. 2. `register(full-FakeApi)` →
registerChannel 1×, beiden Adapter-Keys registriert (`webchat:default`,
`acp-dashboard-binding:default`). 3. Vollständige
`resolveDispatchConversationBinding`-Kette: bindet `agent:claude:main`
(derive, 60bac3d65e697154), Lane 433a6269 (explicit → 4fbe) UND die neue
+-Session-Konversation efadc1d4 (→ hash16-Lane 15194739cdb25a85). Die
"ensure failed"-Zeilen im Probe sind Artefakte (kein acpx-Backend im
nackten node-Prozess).

**Warum probe6/7 trotzdem banden:** sie riefen `registerFull` DIREKT und
umgingen damit exakt die Pipeline, die live nie lief. Der Contract-Mechanismus
(selbiger `resolveBundledChannelModuleEntry`) wurde separat belegt:
Legacy-Deploy-Record → null (contract-probe.mjs A), Shim-Record → Record
(contract-probe.mjs B).

**Rest offen:** Live-Deploy braucht Image-Rebuild + Neustart; Beweis im
Restart-Log: die contract-WARN verschwindet UND der nächste Main-Turn loggt
"plugin-bound inbound routed". Der Terminal-Write-Race (§17/Punkt 1) ist
UNBERÜHRT — erst mit wieder-laufendem Binding wieder testbar (3/3
Fehlschläge live am 2026-10-12 trotz .19 post-settle yield); das r2-Forensik-Redo
läuft parallel weiter.

## 19/20. Claim-Settle §19 + Claim-Reply-Transkript-Spiegel §20 (v0.7.13.22, 2026-10-12/13)

### §19 — Claim-Path Conversation Settle (src/session-settle.ts, src/reply-claim.ts)

Live belegt (sqlite claude-store, 99d8daf5/4fbefeb9): der Host schreibt nach
`deliverBindingPayload` am Claim-Pfad NIE die Run-Terminal-Knoteneinträge — die
ORIGIN-Konversation bleibt `status:"running"` mit dem Claim-`lifecycleRunId`
(Denken-Spinner; Boot-Recovery-Mark = nur Folge), der Klon-Knoten kann beim
§17-Race am Direkt-Pfad ebenfalls hängen. Fix: Plugin settled beide Knoten mit
dem Host-Parity-Shape (`clearPendingFinalDeliveryAfterSuccess`-Spiegel: status
done/failed/timeout/interrupted + endedAt + runtimeMs + abortedLastRun — die
vollen 17 restartRecovery-Felder cleared NUR wenn `restartRecoveryDeliveryRunId
=== claimRunId`; Terminal-Evidence-Merges unangetastet). Boot-Sweep an
gateway_start: alle `running`-Entries unserer Key-Grammatiken
(`dashboard:<uuid>`-Origins, `acp:binding:…`-Klone, Roster-Harness-Agents) mit
Pre-Boot-`updatedAt` → `interrupted` (Host mark_interrupted-Parität). V39:
`spawnedBy = <origin key>`-Stamp auf jedem Klon (ControlUI excludeSubagents →
"versteckte Sub-Session"); idempotent, fremde Provenance bleibt. Bekannte
Residual (bewusst nicht faked): ein Entry ohne Origin-Referenz (Klon-Entry
trägt KEINE) kann nach einem Pre-Boot-Restempel nicht nachgestempelt werden.

### §20 — Claim-Reply-Transkript-Spiegel (src/claim-reply-mirror.ts, NEU)

**Live-DB-Befund (Root der "flüchtigen" Antworten):** die ORIGIN-Konversation
(048d96d7…) enthält nach geclaimten Turns NUR das session-start-Event und die
User-Message (seq=1, idempotencyKey `<turn>:user`, von
`persistPluginBindingUserTurn`, dispatch-from-config:2528) — KEINE
Assistant-Node. Der Host liefert die Reply aus (`deliverBindingPayload(reply,
"terminal", transcriptOwner)` :3397), aber der einzige
`mirrorDeliveredReplyToTranscript`-Writer lebt in der Agent-Run-Finalisierung
(:800/:848) — am Claim-Pfad schreibt niemand. Re-Renders baute
das UI aus dem Transkript → Antwort weg.

Fix (plugin-seitig, Host-Präzedenz Telegram):
`appendAssistantMirrorMessageByIdentity` (official
`plugin-sdk/session-transcript-runtime` Export; Aufruf-Form:
bot-message-BSJK5l6G.mjs:2456) — nach dem Terminal-Wait spiegelt der Claim
JEDE geleifte Reply (echte Harness-Antworten + Status-Notices — alles, was
der User im Origin sieht) mit `idempotencyKey: acp-claim-final:<runId>` +
`deliveryMirror: {kind:"channel-final", sourceMessageId}` in das
Origin-Transkript. Best-effort (wirft nie), Dedupe über den
Idempotency-Key, sessionId-Guard gegen Session-Rebind, types-less Host-Export
über ambient d.ts (src/host-transcript.d.ts). Kein Competing-Writer am
Claim-Pfad (verifiziert) → kein Double-Record.

Upstream-Notiz: der Host sollte geclaimte Replies selbst spiegeln
(sendBindingNotice/Deliver-Branch) — bis dahin ist §20 die plugin-seitige
Parität zu Telegram; bei einem künftigen Host-Mirror mit eigenem Key wäre das
Resultat ein zweiter (deduplizierbarer) Assistent-Record — in Kauf genommen,
dokumentiert (session-transcript-runtime erkennt Channel-Endre
Equivalent-Antworten nur keyless).

## 21. Weg-B Native Dispatch (Non-Mirror) — config-gated `dispatchMode` (GaRoN „Re-Engineering GO“, 2026-10-13)

### §21.1 Befund: der native Pfad war genau EIN Metadatum entfernt

Die Forensik im Live-Dist (2026.10.2 Pin) hat gezeigt, dass der gesamte
Non-Mirror-Umbau keine neue Dispatch-Logik braucht — der Host hat den nativen
Pfad komplett eingebaut, er ist nur hinter dem plugin-owned-Metadatum
verschlossen:

1. **Gate:** `conversation-binding-metadata-CFOhDjMh.mjs:7` —
   `isPluginOwnedSessionBindingRecord(record)` = `metadata.pluginBindingOwner
   === "plugin" && typeof pluginId === "string" && typeof pluginRoot ===
   "string"`.
2. **Dispatch:** `dispatch-from-config-C7FQOe54.mjs:170-194`
   `resolveBoundAcpDispatchSessionKey` — bei `:186` steigt die Funktion AUS,
   sobald das Binding plugin-owned ist (Claim-Branch); bei generischem
   Metadata (`:194`) liefert sie den **Target-ACP-Session-Key** zurück → der
   Turn läuft **nativ** in der Target-Session.
3. **Claim-Branch tot bei generisch:** `:2521/:2525` —
   `toPluginConversationBinding(record)` → `null` bei generischem Metadata ⇒
   `pluginOwnedBinding = null` ⇒ kein `runInboundClaimForPluginOutcome`, kein
   Plugin-Fallback, kein `persistPluginBindingUserTurn`.
4. **Alle Konsequenz-Sites drehen mit:** `get-reply-CtePPkmr.mjs:4838`
   (boundSessionKey-Route), `get-reply:5010` (Reset-Suppression greift nur bei
   plugin-owned → in Weg B **fährt `/reset` der Harness selbst** — löst den
   /reset-Finding), `chat-send-handler-M9HxenMX.mjs:2387` (Origin-Emission),
   plugin-binding-Projektion.

Der historische Weg-A-Grund (F4, Phase 2.20) — plugin-owned Marker gegen den
F3-Blocker (synthetische Targets ohne acp_sessions-Row →
ACP_SESSION_INIT_FAILED) — ist seit Phase 2.21 (Ensure-Provisioning,
`ensureConfiguredAcpBindingReady` → `ensureConfiguredAcpBindingSession`,
persistent-bindings.lifecycle-11LczMOa.mjs:23-60) weg. Weg A ist Historie,
 Weg B ist die Zielarchitektur.

### §21.2 Design: `dispatchMode: "claim" | "native"` (Config-Gate)

Feature-Branch `feature/weg-b-native-dispatch` (ab γ-v2-Fix `abddcd8`),
Commit `a705d0f`. Als **Risiko-Controller** (GaRoN „kein Risiko mehr“):

- `plugins.entries["acp-dashboard-binding"].config.dispatchMode`:
  `"claim"` (Default, Status quo inkl. γ-v2) | `"native"` (Weg B).
- Resolution in `registerFull` (`resolvePluginDispatchMode(api.config)` →
  `setDashboardBindingDispatchMode`) — **Flip greift beim nächsten Boot**, bewusst
  nicht hot mid-flight.
- **In `native`:** JEGLICHER Record-Pfad antwortet generisch —
  `buildPluginOwnedBindingMetadata()` → `null` (agent-map.ts:137), dazu
  `projectRecordForDispatchMode` am Adapter an allen Rückgaben (resolve,
  resolveByConversationAsync, bind, listBySession) und
  `withPluginOwnedMetadata` als Modus-Gate im Bridge (Synthese +
  Legacy-Row-Re-Arm am Hydrate). Ownership-Keys
  (`pluginBindingOwner/pluginId/pluginRoot/pluginName`, `OWNERSHIP_METADATA_KEYS`)
  werden gestrippt, informative Metadata bleibt.
- **Claim-Hook steht still:** erster Check in
  `createHarnessReplyClaimHandler` (`reply-claim.ts:400`) — `native` →
  `{handled:false}` VOR jedem Guard/Pre-Flight/Run/Wait/Settle/§20-Mirror.
  Second Line of Defense für einen Mid-Flight-Flip (Config-Reload, bevor ein
  stale plugin-owned Row neu ausgelöst wurde). Weg-A-Blöcke bleiben im Code,
  unerreicht — Rollback-Sicherheit.
- **Session-settle/Boot-Sweep unverändert:** die Sweep-Legs zielen auf Legacy-
  Klon-Keys; in native entstehen keine neuen, Altlasten werden weiter weggeräumt.

**Rollback = Config-Flip auf `"claim"` + Restart.** Kein Code-Rollback
erforderlich.

### §21.3 Verifikation (4 Stufen, alle grün, 2026-10-13)

1. **Suite:** vitest 214/214 (8 Dateien; +8 Weg-B-Tests: Modus-Resolution
   inkl. Garbage-falls-back-to-claim, Claim-Golden-Shape vs Native-Generic,
   „differ ONLY in the ownership keys“-Invariante, Bind-Pfad, Handler-Stand-Down
   ink. Fremd-Plugin-Priorität, Rollback-Re-Entry, Hook-Inventar unverändert in
   beiden Modi). Strict `tsc -p tsconfig.check.json` 0 Fehler, esbuild-Bundle
   clean.
2. **Host-Parity-Prädikate** (`/tmp/wegb-sandbox/repro.mjs`): gegen REAL-Dist —
   claim: `isPluginOwnedSessionBindingRecord = true`,
   `toPluginConversationBinding` non-null; native: beides null/false, Gate
   liefert den Target-Session-Key.
3. **Deep Host-Parity** (`/tmp/wegb-sandbox/dispatch-parity.mjs`) — die volle
   Dispatch-Pfad-Form, nicht nur Prädikate: unser ECHTER Adapter via
   `registerSessionBindingAdapter` am echten Host-Service registriert, Route-
   Facts via echtem `withConversationBindingRouteFacts` gebaut, dann die reale
   `resolveBoundAcpDispatchSessionKey` gelaufen: claim → `undefined` (Claim-
   Branch engaged, `:186`), native → **Target-ACP-Session-Key** (`:194`),
   `isAcpSessionKey = true`, unmanaged Conversations bleiben draußen. 7/7 PASS.
4. **Live-Beweis NACH GaRoN-GO** (Deploy gehalten): neuer Control-UI-Chat an
   Harness-Agent mit `dispatchMode:"native"` → Chat-Panel rendert natively das
   Harness-Transkript, `/reset` resettet sichtbar (Harness fährt selbst), KEIN
   Klon-Knoten (`agent:…:acp:binding:`) im Sessions-Panel, keine
   `plugin-binding-`-Logzeilen.

### §21.4 Bewusst NICHT in diesem Zug (Backlog)

- **Adapter-Gap** (`compileConfiguredBinding` + `matchInboundConversation` am
  Channel-Plugin, configured-binding-registry-Dbpv38Br.mjs:131-147) →
  deklarative `bindings[]`-Entries für webchat; eigener Schritt nach der
  Native-Bestätigung.
- **Wrapper-Regeneration-Aufpasser** (B1-Regel): das acpx-`claude`-Wrapper
  trägt jetzt das Subagent-Model-Mapping (Ollama-Katalog statt Claude-IDs,
  Backup `claude-agent-acp-wrapper.mjs.bak-subagent-mapping-20261013`) —
  falls der Writer den Wrapper je regeneriert, Mapping nachziehen.
- Migration alter Klon-Artefakte: γ-Stamps bleiben als Legacy-Räumung im Sweep.

## 22. Benigne Wait-Cancellation („agent.wait observation cancelled") — Root Cause + Soap-Suppression (v0.7.13.25+, 2026-10-13)

### §22.1 Befund (live-forensisch, run `5087eb55`)

Turn 1 eines neuen Webchats endete mit dem Error-Notice
`… waiting for its reply failed: agent.wait observation cancelled — the turn is
still running there.` — **und zeigte danach trotzdem die Antwort** (Self-Heal).
Beweiskette aus Live-Log + Transkript-DB:

| t (local, +02:00) | Event |
|---|---|
| 10:32:47.841 | Message 1 via Control-UI-conn `0f28fd74…` (`dispatchInboundMessage`) |
| 10:32:54.477 | `inbound_claim: dispatching harness turn` → Binding-Session (γ-v2 `spawnedBy`-Stamp live) |
| 10:33:56.176/.439 | **beide Webchat-Conns starben** (code=1000, Dauer 326 391/340 988 ms — Page-Reload-/conn-Lebenszeit, nicht idle: letzte Aktivität 69 s vorher) |
| 10:33:56.443 | `waitForRun failed — agent.wait observation cancelled` (**4 ms nach Conn-Tod**) |
| 10:33:56.469 | §19a-Settle (Origin nonterminal) |
| 10:33:56.514 | §20-Mirror `acp-claim-final:5087eb55…` — **β2 erstmals live beobachtet** |

Der 60s+2s-Fingerprint (61,97 s ≈ `addTimerTimeoutGraceMs`) war ein rotes
Herring — kein Timer. Ausgeschlossen: Plugin-Timeout (120 s Default, Config
`{}`), `clampTimerTimeoutMs`-Max, `requestEntryLifetime` (nur Shutdown),
in-process-10s-Cap, Drain-Signal.

### §22.2 Root Cause (dist verifiziert)

Der in-process `agent.wait` der Claim-Wait **erbt die Lifetime der
zustellenden WebSocket-Conn**: `dispatchGatewayMethodInProcessRaw` wrapped den
erfassten `scope.client` (server-plugin-in-process-dispatch-DoFGQ0iV.mjs:64),
dessen `connectionSignal` in die Observation-Scope-Kette geht
(server-methods-DiAePJ8B.mjs `runWithGatewayObservationScope` =
`AbortSignal.any([drain, callerWork, client.connectionSignal])`). Ein
UI-Reload/conn-Drop während eines langen Turns bricht **den Wait, nie den Run**
(`waitForRun`-Kontrakt: der Wait cancelt den Run nicht) — der Host konvertiert
den Work-Abort in UNAVAILABLE „observation cancelled" (retryable). Das erklärt
den von GaRoN berichteten „Lag": Reload während eines Lang-Turns → Spinner →
Notice/Soap → Antwort kommt verspätet über den Mirror-Pfad.

Konsequenz aus dem Transkript-Beweis: die Soap wurde als **assistant-Row ins
Origin-Transkript gespiegelt** (§20-Mirror des Notice-Texts) — Reload-Reiter
zeigt das Error-Artefakt als „Antwort". Die echte Antwort bleibt im
Target/Binding-Transkript (designed Layout, Phase-3.5-Doku).

### §22.3 Fix (Plugin-Defense, src/reply-claim.ts)

- `isBenignObservationCancel(note)` — Detektion über „observation cancelled"
  (immer benign per Kontrakt: der Wait cancelt den Run nie).
- Wait-Fail-Branch: auf dem benignen Edge `log.info` („benign client-conn
  edge") statt `warn`, Notice-Text ohne Failure-Framing
  („is still running — this chat connection ended …, reply is kept in the
  harness transcript"). §19a-Settle + §20-Mirror unverändert (Self-Heal-Path
  identisch wie live belegt).
- Kein Re-Request des Waits: ein erneuter in-process wait erbt dasselbe
  Conn-Signal (bereits abgebrochen) und abortet instant — geprüft gegen
  `throwIfGatewayDispatchAborted`.
- Upstream-Kandidat (unser Nicht-Segment): Observations sollen nicht an der
  delivering-conn hängen — das `forceSyntheticClient`-Konzept existiert im
  Dispatch-Layer bereits (deleteSession nutzt es), ist für agent.wait aber
  nicht generisch zugreifbar.

### §22.4 Verifikation

Binding-Suite 215/215 (neu: „observation-cancelled wait is a benign
still-running notice, not a failure frame"; Regression „waitForRun throwing →
wait-failure notice" unverändert grün), strict tsc 0. Live-Deploy des Fixes
wartet auf GaRoN-GO (kein Release im „kein Risiko"-Regime).
