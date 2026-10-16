## [0.7.13.34] - 2026-10-17

### Fixed
- **harness-config-writer hardening (audit-fix batch + augment/merge + marker hardening).** Match key is scheme-free (http↔https catalog match — the multi-model auto-match was silently dead); `smallModel` always present in the opencode models map when differing; per-harness fail-soft (one bad file no longer collapses the deployment loop); bare-filename `OPENCLAW_CONFIG_PATH` → `.`. Foreign operator configs are AUGMENTED/MERGED instead of replaced (marker-framed codex section, operator content byte-preserved, collision-skip + warning; opencode JSON merge with operator keys preserved; NOTE for shorthand/commented files and real-content legacy config.toml). Marker lifecycle hardened: full-line matching, unterminated-BEGIN protection, dead-section strip on empty refresh (converges), bare≡quoted header aliasing, positive writer-owned detection (no silent replacement of `{"model":…}` operator files). Each fix carries a regression test (95/95 vitest, tsc strict 0).

### Added
- **copilot BYOK/Ollama ENV mechanism:** `COPILOT_PROVIDER_BASE_URL` (+/v1), `COPILOT_PROVIDER_API_KEY`, `COPILOT_PROVIDER_WIRE_API="responses"` (only with baseUrl — key-only is the GitHub-token route), `COPILOT_MODEL`. Docs+binary dual-verified (docs.ollama.com/integrations/copilot-cli; @github/copilot 1.0.98 help text). Helper lists synced (`HARNESS_WRITER_ENV_IDS`, `KNOWN_WRITER_HARNESS_IDS`); `cursor` stays NONE (ACP local-provider wiring missing in the current Cursor build — documented, re-evaluate upstream).

## [0.7.13.33] - 2026-10-16

### Fixed
- **§25 Leg 2: Plugin-RPC-Pfad live tot → Builtin-Delegation (Fix `3369e1d`, Codex-auditiert).** Live-Beleg .32 (05:41:44, Conversation `9a89172d`): Leg 2 feuerte (der `068f77f`-Reverse-Lookup-Claim greift), aber der RPC `sessions.reset` wurde vom Plugin-Ownership-Gate abgewiesen — `resolvePluginSessionOwnershipError` verlangt `normalized(pluginOwnerId) === authorizedPluginId` EXAKT; owner-less host-created Conversation-Rows (`createdVia:"operator"`) werden AUCH abgewiesen („Plugin … cannot reset session … did not create it."). Der trusted-plugin-Dispatch stempelt `authorizedPluginId` — der RPC-Weg ist für Conversations damit UNBENUTZBAR. Fix: Leg 2 = **zweiter Aufruf desselben Builtin-"acp"-Drivers `resetInPlace`** mit dem Conversation-Key — host-seitig ohne Plugin-Identität, exakt die Primitve des normalen `/reset` auf ungebundenen Conversations. Best-effort wie gehabt (jede Leg-2-Failure loggt und degradiert nie das Work-Result). Eingearbeitete Codex-Findings: **F6** Cross-Session Guard im Claim (Agent-Teil von Work-Key und Conversation-Key müssen matchen, sonst defer), **F4** `:conversation-leg`-Suffix am `commandSource` (Log-Forensik: Legs jetzt attribuierbar), **F5** reason-Passthrough statt Kollaps auf "reset", **F11** agentId-Fallback aus dem Work-Key beim Stray-Guard (`hasSessionEntry(key, agentId)`) — fing einen ECHTEN Live-Bug: `sessionKey is not defined` im `resetInPlace`-Scope hätte jede Leg 2 geworfen (Suite beweist ihn), **F13** fehlgeschlagene Lifecycle-Registrierung uninstalliert den Driver sofort statt Leak-in-Registry, **F14** Leg-2-`bindingTarget` gehört dem Builtin (`driverId:"acp"`). Refuted/dokumentiert: F7/F8 (Cache-Staleness — Host-Flow resolved das Binding unmittelbar vor dem Registry-Resolve, dist-verifiziert), F10 (Leg-Race — best-effort by design), F15 (Map-Key-Unique im sync JS). Verifikation: Dual-Reset-Suite 19/19 (+ Agent-Mismatch-, Lifecycle-Fail-, `/new`-Mapping-Tests), Binding-Gesamtsuite **254/254 (3×)**, tsc strict 0.

### Known issues (neu belegt, Upstream-Material)
- **„plugins reload" tauscht Plugin-Modul-Code NICHT aus:** live belegt 07:02→07:44 (Replacement queued → „Plugin replacement applied", danach lief ein `/reset` IMMER NOCH gegen das alte Modul — der Ownership-Gate-Fehler ist im neuen Code-Pfad strukturell unmöglich, dist-Beweis: Builtin übergibt kein `authorizedPluginId`, Gate liest `params.authorizedPluginId`). Ursache im dist gelesen: der native Modul-Load (`tryNativeRequireJavaScriptModule`) landet im prozessweiten require-Cache (Pfad-gebunden), die Reload-Caches (`moduleLoaders`/`source.variants`, keyed am Dateipfad) fischen aus keinem dieser Caches. Neue Bundle-Bytes werden erst vom nächsten Gateway-Prozess-Start geladen.

## [0.7.13.32] - 2026-10-16


### Fixed
- **§25 Leg 2 tot für derived/bridged Bindings (Fix `068f77f`):** der in .31 gelieferte Dual-Reset-Driver (v1) verfehlte sein Ziel live (Owner-Test auf Conversation `ca7fde5b`: Work-Session reset OK, Dashboard-Conversation unverändert, 0 „dual reset"-Logzeilen). Root Cause: der Dashboard-Binding-Adapter speichert nur EXPLICIT-Binds — bridged/derived Records (jede nativ-dispatchte Dashboard-Conversation) werden on-the-fly berechnet und nie gespeichert ⇒ `listBySession(workKey)` (die Reverse-Lookup, über die der Driver beim Registry-Resolve claimt) antwortete `[]` ⇒ Driver deferte an den builtin (Status quo Work-only). Fix: Reverse-Lookup-Cache `derivedByTarget` (bounded 512) in `binding-adapter.ts` — jede Cascade-Leg (sync resolve + resolveByConversationAsync, bridged + derived) notiert ihren projizierten Record; `listBySession` konsultiert explicit ∪ Cache (re-projiziert). Cache warmt sich pro Turn-Dispatch — fehlt er (kein Resolve seit Boot), defert der Driver = Status quo, selbstheilend. Verifikation: vitest Binding 251/251 (+3: listBySession-answered-for-derived inkl. Live-Hash-Integrationstest `22afb5c2cb951156`, defer-when-no-resolve), tsc strict 0. Achtung: Tag `v0.7.13.31` schnitt VOR diesem Fix — daher Patch-Step .32 (Versionierungs-Regel).

### Changed
- **ttyd-Reviver-Forensics erweitert (Bug ①):** der .31-Snapshot beim ersten Live-Hang (pid 15737: `stat=S wchan=do_epoll_wait threads=1 fds=14`, kein Listener) stellte die Hypothese „lws verliert den Listen-Socket" auf, konnte sie aber nicht belegen (nur fd-COUNT). Neu beim Revive: vollständige fd-Target-Liste (`/proc/PID/fd` → `socket:[inode]`/File) je ttyd-PID + `ss -tlnp`-Kreuzsnapshot — der nächste Live-Hang beweist/widerlegt direkt, ob ein Listener-fd fehlt oder vorhanden-but-verbunden ist.

### Known issues (unverändert aus .31)
- Slow-Boot (Bug ④, watchdog_start_seconds-Folgearbeit); §25 Trust-Gate live (Verifikation nach dem .32-Deploy via `/reset` in gebundener Test-Conversation); resetSkipped→ok:true (Upstream-Report-Material); ttyd alive-but-hung Root-Cause (Forensik jetzt mit fd-Targets); Translation-Drift bg/es/pl/pt-BR (Backlog).

## [0.7.13.31] - 2026-10-16

### Fixed
- **ciao-mDNS-Self-Conflict-Storm (Bug ②, Root-Cause + Build-Patch):** `@homebridge/ciao` (1.3.12, gebundelt via openclaw) keyed `CiaoService.serviceRecords.reverseAddressPTRs` mit den RAW `os.networkInterfaces()`-Strings (Node FULL-Form, z. B. `fd12:8ca5:a145:0:872:…`), während inbound AAAA-rdata via `shortenIPv6` dekodiert (RFC-komprimiert, `fd12:8ca5:a145::…`). `hasAddress()` = raw-string Map-Lookup ⇒ ciao's EIGENE ULA-Adresse (FRITZ!Box-Default-ULA `fd12:8ca5:a145::/48`, jeder LAN-Adapter) sah im RFC-6762-9-Conflict-Check FOREIGN aus ⇒ jede eigene Echo-Reflection = "conflicting record" ⇒ probe→rename (`Name (N)`)→re-publish→echo→… Endlos-Storm (~1 rename/s gemessen; live-Instanz erreichte "(76)" in ~4.5 h). Fix: Build-Time-Dist-Patch `ciao-mdns-guard/apply-ciao-mdns-guard-patch.mjs` normalisiert die Map-Keys auf die dekodierte Form (`shortenIPv6∘enlargeIPv6`) — Foreign-Claims konfliktieren weiterhin, nur das Selbst-Reflexions-Falsch-Positiv verschwindet; A-Records (IPv4) unberührt. Verankert wie der unicode-guard-Patch (fail-loud, idempotent, `node --check`, Universality-Sweep; akzeptiert auch hoisted Dependency-Layouts). Live-verifiziert: 0 Konflikte in beiden Modis nach Patch, A/B-Beleg ~1 rename/s davor; wirkt mit dem nächsten Gateway-Restart (neues Image).
- **Boot-Heal-Timing (Bug ③, §23.3):** der Single-Shot-Boot-Sweep beim `gateway_start` fiel auf großen Stores wholesale durch (alle Agents noch in der Background-Admission — "5 second foreground startup budget elapsed" ⇒ alle settle/listSessionEntries UNAVAILABLE) ⇒ 9 Legacy-Stamps blieben ungeheilt. Fix: `runBootHealWithRetries` (bounded Retry-Treiber, Delays 0/15/30/60/120/240 s; Failure-Signal = jede logger.warn im Attempt; Legs bleiben idempotent; `bootCutoff` wird EINMAL vor Attempt 1 erfasst) — der `gateway_start`-Handler ist async und startet den Treiber DETACHED (der Hook-Runner wird nie von einem Retry-Sleep gehalten); Give-up-Log verweist auf `gateway_start`-Re-Attempt bzw. `/config/pushbug-tools/`-Scripte.

### Changed
- **OpenClaw-Pin 2026.10.2 → 2026.10.4.** (Bump 2026.10.3 wurde zwischenzeitlich obsolet — npm `latest` rückte im Build-Fenster auf 2026.10.4 = UPSTREAM-STABILITY-PATCH auf 10.3 ohne neue Features/Config-Änderungen; relevante Fixe für UNS: Gateway-Shutdown/Restart hängt nicht mehr an transcript-worker/lifecycle-Events (#170493/#170555 — exit-137-Kaskaden-Thema), keine writer-claim-Fehler mehr auf plugin-launched turns (#170077), Gateway responsive bei langen Reply-Streams (#166782/#171573)). Re-Verifikationen gegen den 10.4-Tarball: unicode-guard-Patch applied CLEAN (0 Remanenten, Sweep über 9890 Files); agentId-Fix weiterhin nativ fixiert (`dist/openai-http-C1OgQgtd.mjs`, `resolveGatewayRequestContext`-Pfad — Kommentar-Kette im Dockerfile verlängert); ciao unverändert 1.3.12 (ciao-mdns-guard-Patch nötig + kompatibel); §25-Surfaces unverändert (Driver-Registry-Symbol, `emitResetCommandHooks`+sessionEntry, `sessions.reset`-RPC); resetSkipped-Code unverändert (Upstream-Report bleibt gültig).
- **ttyd-Reviver-Forensics (Bug ①, Mitigation + Beweissammlung):** Root-Cause weiter offen — ttyd 1.7.7 kann ALIVE-but-not-listening stehen (belegt: `stop_stale_ttyd` loggt "Stopping previous ttyd process" nur bei erfolgreichem `kill -0`, d. h. JEDE Revive-Entscheidung traf einen lebenden Prozess; Hang-Rate skaliert sichtbar mit aktiver Terminal-Nutzung). Der 30-s-Reviver hält die Fläche; neu: beim Revive wird der vollständige Forensic-Snapshot (stat/wchan/threads/fd-count pro Thread) in den Container-Log gedumpt, statt dass die Beweislage wieder verdampft.

### Added
- **§25 Dual-Reset-Driver („/reset wirkt in der verbundenen Session"):** `/reset` in einer ACP-gebundenen Session resettete bisher NUR die acp-Work-Session — die sichtbare Dashboard-Conversation behielt Kontext/Transcript (by design, aber Nutzern unbemerkbar ⇒ wirkt wie „keine Wirkung"; DB-Beweis: die 9 reset-Boundary-Events liegen exakt auf den ✅-Momenten). Fixes jetzt in `dual-reset-driver.ts` (Commit `916c55e` auf `feature/25-dual-reset-driver`, fast-forward gemergt): Registrierung in der Driver-Registry (`Symbol.for("openclaw.statefulBindingTargetDrivers")`, builtin „acp" wird identitätserhaltend NACH unserem Driver re-appended — Insertion-Order); Leg 1 (Work-Session) delegiert 1:1 an den builtin-Driver, Leg 2 (Verbindungs-Conversation) resettet per offizieller plugin-sdk-Oberfläche `api.runtime.gateway.request("sessions.reset", …)` mit `["operator.admin"]`-Scopes (pluginOrigin "bundled"), best-effort (scheitert Leg 2, degradiert es nie das Work-Result). Doku: `BRIDGE.md` §25. Verifikation: vitest Binding 248/248 (+14 dual-reset-Tests), `tsc --noEmit` strict 0.

### Verification
- vitest Binding 248/248 (+3 Retry-Treiber-Anker: warn-free single run; Re-run-bis-warnfrei mit Live-2026-10-15-Motiv; gethrowte runOnce = 3 Attempts + "giving up"), vitest Writer 81/81, `tsc --noEmit` strict 0 beide Plugins, `bash -n run.sh` OK, ciao-mdns-guard: 1 File gepatcht + idempotent (Live) + 1 File gepatcht (10.3-Tree, hoisted layout).

### Known issues (nicht in .31)
- **Slow-Boot (Bug ④):** Kaltstart beim .30-Deploy real 367 s (>2× über dem Supervisor-Start-Fenster-Budget) — der `watchdog_start_seconds`-Komplex bleibt eigene Folgearbeit (Kandidaten: ttyd-Boot-Gate 30 s, Plugin-Load ~150 s, Gateway-Start; `startup_trace`-Option als Post-Mortem-Lage).
- **§25 Trust-Gate live nicht verifiziert** (statisch nicht prüfbar): scheitert es live, loggt Leg 2 eine Warning, Work-Reset bleibt unverändert — Verifikation nach Deploy (Owner tippt /reset in einer gebundenen Test-Conversation). Upstream-Report-Material: `resetSkipped`-Branch meldet `ok:true` (stiller ✅-Pfad, nie live manifestiert); ttyd alive-but-hung Root-Cause weiter offen, WS-Stress (100 Runden) reproduziert ihn nicht — Auslöser offenbar aktive Terminal-Nutzung (Reviver-Forensics in .31 fängt ihn beim nächsten Live-Hang).
- Translation-Drift bg/es/pl/pt-BR (options-Listen) — preexisted, Backlog.

## [0.7.13.30] - 2026-10-14

### Fixed
- **mDNS/openclaw.local repariert (nativ, 2026-10-15):** das native OpenClaw-bonjour-Plugin schaltete sich still ab (`isDisabledByEnv`: `OPENCLAW_DISABLE_BONJOUR` unset ⇒ Container-Erkennung greift) — obwohl `discovery.mdns.mode=minimal` konfiguriert war, lief der ciao-Responder nie ⇒ `openclaw.local` war im LAN unresolvable. Fix: run.sh exportiert `OPENCLAW_DISABLE_BONJOUR` passend zu `mdns_mode` (`off` ⇒ `true`, sonst `false` — host-networked Multicast erreicht das LAN direkt; via `gateway_env_vars` nicht überschreibbar, da reserviertes `OPENCLAW_*`). Diagnose-Beweise: QU-Unicast-Query vom Host von der FRITZ!Box mit `openclaw.local → 192.168.178.68` beantwortet, ciao-Probe im Container advertised/records OK; LAN-WebUI-Surface = nginx `https://openclaw.local:18789` (Gateway 18790 bleibt bewusst loopback-only, TXT `gatewayPort` ehrlich). Live-Wirkung nach Add-on-Restart (Owner-GO).
- **harness-config-writer lebte LIVE als stummer No-op** (Owner-Design "leere/unvollständige configs aktualisiert, schon korrekte so belassen"): der Plugin-Read nutzte `api.config.harnesses` (die VOLLE OpenClawConfig → immer undefined) statt `api.pluginConfig` (dist-belegt; auch im .29-Live-Dist nachgewiesen). Fix: `resolvePluginConfig` — primär `api.pluginConfig`, Fallback-Drill über die volle Config; Legacy-Key unter `acp-dashboard-binding` erzeugt jetzt ein sichtbares WARN statt eines stillen No-ops (M2).
- **Review-Fix-Batch M1–M5 + N1–N3** (adversariale 4er-Session 2026-10-14, ALLE Fixings vor dem GO): M1 `model_catalog_json` NUR bei non-null Katalog-Build (kein dangling Key auf eine nie geschriebene Datei); M3 opencode.jsonc 0600 + Secret-Files schreiben ihren Mode am TMP VOR dem rename (kein Exposé-Fenster; Updates behalten den bestehenden Mode); M4 maxTokens-Sammlung entfernt (keine konsumierende Surface); M5 "SKIP ⇒ Picker-Verlust (REPLACE-ALL)" in §15.7 R9 + §15.11 dokumentiert; N1 Doppel-Warning bei invalid `models`; N2 `modelsSource:"optout"` (Operator-`models: []` ≠ Katalog-"none"); N3 neutraler Katalog-`description` ("custom model …").
- **Audit-Runde-2-Nachtrag (r2, vor Deploy):** unchanged-Heal (Ziel-Mode wird auch bei byte-identischem Content nachgezogen), chmod-Fehlschläge sichtbar in den Warnings, ehrliches Katalog-Skip-Log (models abwesend vs. kein contextWindow), Test-Anker +5 (M2 both-keys, (models:optout) e2e, M3 Mode-Heal ×2, N1 Positiv/Negativ) → vitest 81/81.

### Added
- **Multi-Model γ re-landed** (Cherry-Picks `e6dbb18` + `7a0351e` auf main): alle openclaw.json-Provider-Modelle wandern in die Harness-Surfaces (codex-[profiles.*], opencode models-Map, claude `CLAUDE_MODEL_CONFIG`, ENV-Kommentarlisten); das Add-on-Modell bleibt Default; Signatur-Semantik (`# harness-config-writer (generated)`) macht writer-generierte config.toml bytes-sync-refreshbar.
- **γ.1 codex `model_catalog_json`:** Operator-`contextWindow`-Metadaten aus openclaw.json → `/config/.codex/model-catalog.json` (binary-verifiziertes Entry-Template); fixt die codex-Warnung "Model metadata for `X` not found" (65× belegt) für direkte CLI-Nutzer. ACP-Sessions bleiben bundled-Katalog (Key nicht acpx-vererbt — upstream-Watchlist).
- **Binding-Pack gemerged** (`feature/binding-native-unarchive` @ 2a7ea59, Session 4b5b8fbd; Merge `c2ecc3e`): §23 **native-mode un-archive** — Boot-Heal der legacy γ-Stamps im Native-Modus, es werden (anders als im Claim-Modus) keine Stamps mehr geschrieben; §23.2/**V39** — derselbe Boot-Heal räumt `spawnedBy`-Over-Hiding-Stamps auf der Clone-Grammatik auf (5 REAL-Sessions live falsch als Subagenten verhüllt, jetzt sichtbar); §24 **Init-Race** — bounded (10 s) Join der in-flight Provision an 4 async-Ingress-Grenzen, §24 join gap — explizit gebundene Records joinen denselben Readiness-Lauf. Doku: `BRIDGE.md` §23/§23.6/§24; Merge-Szenarien/Restrisiken: `MERGE-HANDOVER.md`. Deploy-Beweis = Boot-Log-Greps (`un-archived 4 legacy γ stamp(s)`, `cleared spawnedBy … 5 overstamped work session(s)`) + Smoke `/acp status`/`/reset` auf 60bac3d6.
- Nota für Bestands-Setups mit `harness_base_url`: der Helper generiert ab γ einen claude-Entry by Default (Ausschluss via `harness_excluded_agents`).

### Changed
- **Options-UI-Restrukturierung (verhandelt mit Owner 2026-10-15, Kollapsible-Layout v2):** `ha_integration` ist die ERSTE Gruppe (über ACPX/Harness). Die zwei Plugin-Schalter `acpx_enabled` (bundled acpx-Harness-Infrastruktur) und `harness_config_writer_enabled` rücken als top-level Standalone-Schalter VOR die custom-plugin-Gruppe `harness` (neu: harness_base_url/harness_api_key/… — alle Provider-Keys sind HARNESS-scoped, nicht Ollama-scoped). **`enable_terminal` ist retired**: das Web-Terminal ist über Ingress IMMER an und funktionierend (Wartungs-/Reparatur-Fläche), nur `terminal_port` (jetzt top-level, vor `enable_webui`) ist konfigurierbar; `enable_webui`/`enable_docs` ebenfalls top-level. Umbenennungen (run.sh koalisiert alt+neu beim Lesen): `ollama_base_url`→`harness_base_url`, `ollama_acp_codex/opencode/claude_model`→`harness_codex/opencode/claude_model`, `acp_additional_allowed_agents`→`additional_agents`. Der harness-config-writer-Aktivator liest STRICT den neuen `harness_base_url` (keine Überraschungs-Generierung vor der Options-Migration). Migration-Tool `/config/pushbug-tools/options_migrate_sections.py` (host-persistent) auf v2-Mapping umgebaut (akzeptiert flat + v1-sektioniert, merged leer-safe, emittiert alle Root-Gruppen — "Missing option '<group>' in root" beweist Pflicht-Gruppen).
- Rollback-Lage: die γ-Commits lagen seit dem .28-Rollback nur auf `feature/harness-writer-multimodel`; Re-Land = gezielte Cherry-Picks (Merge wäre No-op, `revert db81147` wäre fatal = .27-Paket-Re-Landung).
- Ops: das First-Enable-Backup-Manifest (11.10. 16:31) wurde archiviert (`manifest.json.archived-pre-gamma-20261011`) — der Helper nimmt beim nächsten Enabled-Boot einen FRISCHEN Snapshot des γ-Stands (der alte Stand hätte OFF-Restore die 7 env-Files löschen + 24→1 Modelle einkürzen lassen).
- Ops-Wissen: die Crash-Kaskade begann 13.10. 14:03 lok. mit dem .26-Deploy (erster 120-s-Timeout schon auf .26); der Writer ist exkulpiert (Plugin-Load ~150 s > Watchdog-Fenster); exit 137 = Watchdog-Stop-Kill, kein OOM; supervisor-Log-Stamps nach jedem Supervisor-Boot +2 h zweideutig (`docker logs -t` ist verlässlich).

- **acp(x)-Schalter-Reset (Owner-Direktive 2026-10-15):** `acpx_enabled` ist der **MASTER-Gate** (Owner-Klarstellung): `acpx_enabled=false` ⇒ KEINE Config-Übertragung für writer/binding (deren Schalter wirkungslos, sichtbare INFO-Zeile); `acpx_enabled=true` ⇒ Freigabe — dann entscheiden `harness_config_writer_enabled` / `acp_dashboard_binding_enabled` (beide default **false**) eigenständig, untereinander entkoppelt (Tri-state UNSET-follow des Writers retired). Ohne `harness_base_url` werden alle Harness-Gruppen-Werte IGNORIERT, nur die Schalter gelten (BASE_URL-Gate-Zweig in run.sh + INFO-Zeile). Helper-Bootstrap läuft nur hinter dem Master; die ACPX-Infrastruktur (npm project + openclaw.json-acp-Patch) bei jedem Helper-Run mitgebaut (Custom-Plugins ohne ACPX nutzlos). writer=true kopiert configs, überschreibt NIE Einträge ohne die gesetzte BASE_URL.

### Verification
- vitest Writer 81/81 (r2-Anker +5) + vitest Binding 231/231, tsc strict 0, Python-Helper 46/46, `bash -n run.sh` OK.

## [0.7.13.29] - 2026-10-14

### Fixed
- **acp-dashboard-binding ohne Auto-Archivierung (GaRoN-Direktive 2026-10-14).** Neue Config-Option `cloneAutoArchive` (Default **false**): das Plugin schreibt nie Archive-Stamps (Turn-Settle UND Boot-Sweep); die γ-v2 Re-Archive-Race ist im Default strukturell tot. `true` = Legacy-γ-Verhalten (Rollback-Schalter).
- **Unarchive-vor-Dispatch unverändert:** Legacy-γ-Stamps heilen beim nächsten Dispatch selbst (nur OUR-Marked).

### Changed
- Basis = exakter 0.7.13.28-Bestand (0.7.13.25-Code); binding-only, kein sonstiger Scope.

## [0.7.13.28] - 2026-10-14

### Changed
- **Rollback auf den v0.7.13.25-Codebestand (GaRoN-GO 2026-10-14).** Der Code ist exakt `v0.7.13.25`; einzige Abweichung ist dieser Versions-Bump. Grund: Login-/Ingress- und Stabilitätsregressionen ab 0.7.13.26.
- **Entfernt:** `harness-config-writer` Multi-Model-γ, `acp-dashboard-binding` PUSHBUG-C7-Fixes (V39-Clone-Guard, deferred γ re-archive) + reply-claim/session-settle-Deltas, `run.sh` Claude-Ladder, `oc_acpx_helper.py` claude-Ladder.
- **Nicht adressiert:** der Slow-Boot/`watchdog_start_seconds`-Komplex (>120 s Kaltstart vs. Supervisor-Start-Timeout) — eigene Folgearbeit.

## [0.7.13.25] - 2026-10-13

### Fixed
- **γ-v2 clone invisibility (archive-when-idle):** idle harness clone nodes no longer surface in the user-visible session list; archived state keeps the dispatch path clean (no binding-record toxicity). Codex delta-audit GO.

### Added
- **Weg-B native dispatch (non-mirror, config-gated):** `dispatchMode: "claim" | "native"` (default `claim` — zero behavior change until flipped). `native` emits generic binding records (ownership metadata `pluginBindingOwner/pluginId/pluginRoot/pluginName` stripped; all informative fields kept), so the host dispatch gate routes the webchat conversation natively into the target ACP session — the conversation IS the harness session, no clone/mirror/claim, and `/reset` is the harness's own flow. Rollback = flip back to `claim` (applies at next boot). Docs + verification record: `plugins/acp-dashboard-binding/BRIDGE.md` §21; deep host-parity suite against the real 2026.10.2 dist (real adapter service, real route facts, real `resolveBoundAcpDispatchSessionKey`) 7/7.
- **Gateway lifecycle operators (`oc-gateway`, installed on boot to `/usr/local/bin`):** `status` (probe capped 10 s), `health`, `stop` (latch + `openclaw gateway stop --force` + pkill fallback + port-free wait), `resume`, `maintenance-status`, `restart` (Supervisor API), `update` hint. Maintainance latch flag `/config/.openclaw/.gateway-maintenance` survives addon restarts by design; the supervision loop checks it AFTER exit detection and BEFORE backoff/auto-doctor, and a boot that starts with the flag skips the initial gateway start entirely.
- **ttyd runtime supervisor:** port-based (not PID-based) liveness check every 30 s; one-line local respawn when the terminal went silent; disabled when `enable_terminal=false`.
- **Terminal-first boot gate:** gateway start waits up to 30 s for the terminal to listen; warning + continue on permanent failure (nginx/Ingress + agent remain the escape hatches).

### Docs
- DOCS.md: "Taking the gateway DOWN for maintenance" troubleshooting section (oc-gateway usage, latch semantics).

## [0.7.13.24] - 2026-10-13

### Fixed
- **Boot sweep now actually dispatched:** `gateway_start` is typed-hook-runner-only (live-boot log proof); the sweep moved from an inert `registerHook` registration to `api.on("gateway_start", …)`, so the §19c stuck-session settle runs on every boot (Denken-Bug root).

## [0.7.13.23] - 2026-10-13

### Fixed
- **Register crash "hook registration missing name" (v0.7.13.22 post-deploy, root):** the 2026.10.2 registry throws for every nameless `api.registerHook` (`registry-854ZO8XT.mjs:2937-2941`); the sync boot-sweep one aborted `registerFull` on every boot. All hook registrations are now named: `acp-dashboard-binding:boot-sweep` (gateway_start), `acp-dashboard-binding:inbound` (message_received + before_dispatch).
- **Projection opts forwarding:** `dashboardBridgeApi` now forwards hook opts verbatim to `api.registerHook` instead of dropping the third argument — bridge hook names reach the host again.
- **Contract inventory tests (`src/hook-contract.test.ts`, new):** registerFull against the verbatim host name contract (negative witness proven) + static tripwire ensuring every `registerHook` call passes non-undefined opts. `vitest.config.ts` (new) aliases the pinned gateway dist, so the SDK imports resolve and the channel module tests run for real.

## [0.7.13.22] - 2026-10-13

### Fixed
- **Claim-path conversation settle (§19, Denken-Bug root):** the host never writes run-terminal entries for claimed turns — the ORIGIN conversation node stayed `running` with the claim's `lifecycleRunId` (live-DB proof 99d8daf5), the boot recovery mark was only the consequence. The plugin settles origin after every claim return and the clone target after terminal waits, mirroring the host's own settle shape (status + endedAt + runtimeMs + abortedLastRun outcome mapping; full 17-field restart-recovery claim set cleared only for our claim run). Boot sweep at gateway_start terminates orphaned `running` nodes in the plugin's key grammar.
- **Claim-reply transcript persistence (§20, "flüchtige Antworten" root):** delivered claim replies were never transcribed into the origin conversation (only agent-run finals mirror to transcript) — re-renders lost them. The plugin mirrors every handled claim reply via `appendAssistantMirrorMessageByIdentity` (official plugin-sdk/session-transcript-runtime, Telegram-channel precedent) with `acp-claim-final:<runId>`, best-effort.

### Added
- **Hidden harness sub-session (V39):** `spawnedBy` provenance stamp hides harness clones from ControlUI lists (excludeSubagents).
- **`runtime.acp.thinking` passthrough (d1):** operator config reaches the ensure-spec runtimeOptions, reconciled into live ACP sessions.
- **`utility_model` option (V36.2):** merges `agents.defaults.utilityModel` (session-observer strict-JSON root fix); unset = no write.

## [0.7.13.21] - 2026-10-12

### Changed
- **OpenClaw 2026.10.2 pin bump** with dist verification.
- **Dashboard binding default ON:** `acp_dashboard_binding_enabled` defaults to `true`; explicit `false` is a real opt-out that disables the plugin entry and strips the channel block.
- **Activation manifest:** `openclaw.plugin.json` adds `activation:{"onStartup":true}` for bundled-channel startup qualification.

### Fixed
- **Protection chain:** off-switch no longer leaves stale `channels['acp-dashboard-binding']` keys that would refuse gateway boot.

## [0.7.13.20] - 2026-10-12

### Fixed
- **Gateway never instantiated the binding plugin after the bundled-root deploy (Punkt 1b, BRIDGE §18):** the v0.7.13.18 move into `dist/extensions/` made the host run the plugin through the bundled-channel entry pipeline, which enforces a contract on the default export (`dist/bundled-CMChYPbG.mjs:129 resolveBundledChannelModuleEntry`: `kind === "bundled-channel-entry"`, string id/name/description, functions `register` + `loadChannelPlugin`). The shipped `defineChannelPluginEntry` record (plugin-sdk channel-core shape) has no `kind` and no `loadChannelPlugin` → host WARN `[channels] bundled channel entry acp-dashboard-binding missing bundled-channel-entry contract; skipping` (11× on 2026-10-12, incl. every boot) → `bundledChannelArtifactLoaders.plugin` returns undefined → `registerFull` (adapters, claim hook, bridge) never ran in the gateway → every dispatch consult null, `pluginOwnedBinding` null, embedded dispatch everywhere. Upstream bundled channels (telegram/a2a/reef) build their entries over dist `defineBundledChannelEntry` with exactly this contract.
- **Evidence (three independent, host code not replicas):** (1) host `getBundledChannelPlugin("acp-dashboard-binding")` → undefined with the live WARN; `telegram` → plugin; `listBundledChannelPlugins()` = [a2a, reef, telegram]. (2) gateway boot trace `sidecars.ready loadedPluginCount=14` = exactly the 14-plugin loader list without ours (would be 15 if loaded). (3) `channels.telegram.*` 6 runtime startup steps vs `channels.acp-dashboard-binding.*` 0 lines in the whole log. Live dispatch side-effect: probe turn with debug logging showed hot-path spans but no "plugin-bound inbound routed" line and zero plugin log lines.
### Added
- `src/entry.ts`: `defineBundledChannelCompatibleEntry<C,F>` — contract-conformant record; `register()` mirrors `defineChannelPluginEntry`/`defineBundledChannelEntry` semantics 1:1 (cli-metadata / tool-discovery / discovery / full / other modes; registerChannel only outside cli-metadata+tool-discovery; registerFull on full+tool-discovery); extra `channelPlugin` + exposed `registerFull` for the legacy external path and probes.
- `src/entry.test.ts`: replicates `resolveBundledChannelModuleEntry` as a regression witness — legacy shape MUST fail, shim shape MUST pass; register branch semantics (full/tool-discovery/cli-metadata/discovery/setup-runtime).
- Smoke-check 6b: new first-block grep for `missing bundled-channel-entry contract` (backlog 6b) — the old `failed to load bundled channel` pattern never sees this skip, which is why the 2026-10-11 18:01 boot smoke reported ALL GREEN while binding was already dead.
- BRIDGE §18: full forensics chain (timeline, pipeline, contract, fix, r2 caveat: with the claim hook dead, the "3/3 claimed turns" of 2026-10-12 predate real claims and must be re-evaluated once binding is live).
### Changed
- `index.ts` default export now built via the shim; `registerFull` body unchanged (pluginRoot → origin workspace → runtime → claim hook → auto-provision → bridge); header docs updated.
### Verified
- vitest binding 171 passed + 1 skipped (172; 5 new entry-contract tests) · binding strict tsc 0 errors · `bash -n` acp_smoke_check.sh ok · E2E in-process (`/tmp/probe/contract-e2e.mjs`, esbuild bundle with the helper's exact flags): contract gate passes, `register(full)` registers both adapter scopes (`webchat:default`, `acp-dashboard-binding:default`), full `resolveDispatchConversationBinding` binds `agent:claude:main`, lane 433a6269 (explicit → 4fbe) and the user's new "+"-session conversation efadc1d4 (hash16 lane 15194739cdb25a85).
- Audited by the acpx-codex harness via the explicit `/acp spawn codex` chain (session `agent:codex:acp:fc99d140-dd1c-4b89-bbc7-8f1cd92a8e21`, runId 08a052b6): 5/5 brief checks ✅ — **VERDICT: GO**; non-blocking observation (shim omits `setChannelRuntime`, unused here — lossless). Report: `agents/coding-review/findings/2026-10-12-bundled-channel-entry-contract-audit.md`.
- Deploy: needs add-on image rebuild. Boot proof checklist: contract WARN gone · `loadedPluginCount=15` · `channels.acp-dashboard-binding.*` steps present · next main-conversation turn logs `plugin-bound inbound routed` (debug level) · then re-evaluate the §17 terminal-write race on real claimed turns.

## [0.7.13.19] - 2026-10-12

### Fixed
- **Terminal-write owner race on claimed binding turns (Punkt 1, BRIDGE §17):** the claimed reply turn completes (host `finishPluginBindingDispatch` → `completeDispatchReplyOperation`, dist `dispatch-from-config-BG9rT_X3.mjs:3453/3461`) but the run-terminal session-entry persistence fails — `session-entry.patch` throws `Terminal write owner changed before commit` (`agent-run-terminal-writes-CZ5u4nvB.mjs:39`, `assertCurrent` guards owner/terminalWrites-entry/captured-context/delegatedAuthority; capture at `server-runtime-subscriptions-CLhV3Vvh.mjs:2707`, bind site `prepare.runtime-CraZtPFh.mjs:360`). Result: `session_nodes` row stays `status:"running"` with dangling `lifecycleRunId` despite `observerDigest: "Run completed"` — 3/3 deterministic (claimed turns 4fbefeb91c0aed3d etc., log `/tmp/openclaw/openclaw-2026-10-11.log`); healthy counter-example: main-clone session `60bac3d6` (no claim-mirror path). Hypotheses H1 (mirror/delivery writes rebind the owner between capture and commit — both hang in the same completion tick) leading; H2 (delegatedAuthority invalidation) weaker, no fallback/retry markers in log.
- **Plugin fix = post-settle yield:** `reply-claim.ts` sleeps 500 ms (exported `DEFAULT_POST_SETTLE_YIELD_MS`, clamp 0..10000, option `postSettleYieldMs`) after a terminal `waitForRun` result — only ok/error-terminal; timeout/pending/wait-failure paths skip, so no added latency on non-terminal waits. No host patch, no manifest change.
### Corrected
- **`harnessReplyWaitMs` IS wired** (earlier claim retracted): live getter `getConfig: () => api.config` (`index.ts:189`), `readWaitMs` reads `plugins.entries['acp-dashboard-binding'].config.harnessReplyWaitMs`, clamp 1000..900000 default 120000; declared as number in `openclaw.plugin.json`. Live config simply has no key set — nothing to implement.
### Added
- `tsconfig.check.json` for the binding plugin: strict, noEmit, nodenext, explicit `openclaw/plugin-sdk/*` dist mapping (`plugin-sdk/*.d.ts`), typeRoots from the gateway's own @types; excludes `src/**/*.test.ts` (vitest types not vendored — tests run via vitest). Runs clean: 0 errors.
- **Audit report artifact:** `agents/coding-review/findings/2026-10-12-punkt1-terminal-write-race-audit.md` (gitignored findings convention).
### Verified
- vitest binding file 28/28 (5 new post-settle-yield tests incl. skip-paths and disable-by-0), full suite 166 passed + 1 skipped, binding strict tsc 0, writer baseline tsc 0. Audited by the acpx-codex harness — explicit `/acp spawn codex` chain (persistent session `agent:codex:acp:3115ba34-5018-4e04-ac27-5a5720db3de9`, harness verified: `kimi-k2.7-code:cloud`, `model_control: "config_option"`, `--openclaw-run-configured`): all 7 brief checks ✅ — **VERDICT: GO**; INFO applied (timing assertions 60→100 ms to de-flake CI, re-run 28/28).
- Docs: BRIDGE §17 (forensics + mechanism + hypotheses + fix + §12-Mirror kernel for upstream #149801/#163078); BACKLOG V34 rewritten with corrected evidence + audit block.
- Live smoke outstanding: next claimed turn in a binding conversation must show the `Terminal write owner changed before commit` error gone (acp_smoke_check stuck-node guard covers follow-up).

## [0.7.13.18] - 2026-10-11

### Fixed
- **PluginTrustRefusalError on every restart boot (live-log Kammerjäger, 16:32 boot):** the gateway runtime gates `openKeyedStore` behind `assertTrustedPluginRuntime` (dist `loader-runtime-load-DpgEqnzx.mjs:4607` → proxy :4645) — only `origin === "bundled"` or `trustedOfficialInstall` grants the persisted store. Path-deployed external plugins resolve to `trust.reason "record-missing"` (`installed-plugin-record-match-BHcdsxjn.mjs:217`; no config/flag trust grant exists), so the binding bridge's persisted store threw and fell back to memory-only rows ("persisted bridge state unavailable"). Root fix is TRUST, not exception-swallowing.
- **Helper deploy switched to the bundled root** (`oc_acpx_helper.py`): new `BUNDLED_EXTENSIONS_DIR` (`/usr/lib/node_modules/openclaw/dist/extensions`), `_find_esbuild()` (gateway-pinned `openclaw/node_modules/.bin/esbuild` first, `shutil.which` fallback), `_compile_bundled_plugin()` (esbuild `--bundle --format=esm --platform=node --target=node26`, externals `openclaw`/`openclaw/*`/`@openclaw/*`; bytes | None), `_write_bytes_and_cache()` (byte-compare first → read-only boots stay untouched on identity; otherwise `tempfile.mkstemp` + chmod 0o644 BEFORE `os.replace`). `_deploy_and_register_plugin()`: when the bundled root exists and the bundle compiles → deploy `index.mjs` + package.json patched with `openclaw.extensions=["./index.mjs"]` + `openclaw.plugin.json` + BRIDGE.md/README → `shutil.rmtree` the stale external `CONFIG_DIR/plugins/<name>` (both candidates of an id → the explicitly-enabled config candidate WINS and would shadow the trusted bundled one) → registration. Bundled `.ts` sources fail hard upstream ("Stripping types is currently unsupported for files under node_modules") — hence the esbuild-compile requirement.
- **Fail-soft fallback:** missing bundled root / esbuild / compile → legacy external deploy exactly as v0.7.13.17, WARN logged. Live empirics (no restart needed): `openclaw plugins inspect` shows both plugins `origin: "bundled"`, `trust.reason: "bundled"`, `status: "loaded"`; the binding bundle also fixes the 64s-block hypothesis (huge TS-stripping load cost of the config-origin entry).
- **Bridge WARN carries the cause** (`dashboard-bridge.ts` ~:984): `(caused by: ${error.message})` in the persist-failure message — the gateway log serializes messages only.
### Added
- **`gateway_startup_trace` add-on option:** run.sh exports `OPENCLAW_GATEWAY_STARTUP_TRACE` (dist `server-startup-trace-aq2f6BT1.mjs` emits `startup trace: <phase> <ms>` INFO lines; `plugins.runtime-post-bind` = `loadStartupPlugins()`); config.yaml option + schema. Default false.
- **Read-only post-restart smoke check** `openclaw_ha_addon/acp_smoke_check.sh`: (1) gateway process, (2) bundled payload validity (index.mjs non-empty, package.json parses with `openclaw.extensions`, NO stale external copy — shadowing check), (3) openclaw.json plugin config, (4) ACP session roster + harnessSessions, (5) stuck session_nodes >15 min, (6) ERROR/FATAL since last boot, (6b) bundled-channel load warnings, (7) harness env wiring. exit 0/1; zero writes.
### Changed
- `._register_plugin_entry()` extracted as the shared registration path (entries-enabled opt-out semantics B3 UNCHANGED, `plugins.load.paths` KEPT for fallback functionality, `plugins.allow` union, atomic write_json) — both deploy roots call it; legacy path behavior byte-for-byte preserved.
- Live-box hygiene during this fix round: the manual probe left 0-byte package.json files in the live bundled dirs (probe artifact, not helper output — tmp-repro proves the helper writes correct files); corrected live + covered by smoke check 2.
### Verified
- python 35/35 (new `BundledRootDeployTest`: payload write + package.json patch + NO external copy / stale-external removal / byte-identical ⇒ read-only second boot / compile-fail fallback / REAL esbuild integration probe with skipUnless), vitest writer 34/34, vitest binding 161 passed + 1 skipped, strict tsc clean; smoke check run live on the box (deployment block ALL GREEN). Audited by the acpx-codex harness — explicitly spawned through the ACP path this time (`/acp spawn codex` → session `agent:codex:acp:05b72d7c…`, harness config verified applied: `model_control: "config_option"`, `kimi-k2.7-code:cloud`): **GO** (notes: 0-byte probe package.json, missing trailing newline — both addressed; finding: tests file needed the newline fix).

## [0.7.13.17] - 2026-10-11

### Added
- **Repo-Split A2 (owner GO), two runtime plugins instead of one:** `harness-config-writer` is now a STANDALONE feature plugin (`definePluginEntry`, no channel code, zero imports from the binding plugin) — the channel plugin survives a writer crash and vice versa. The writer owns its config surface `plugins.entries['harness-config-writer'].config.harnesses` (additively preserved semantics: absent entry ⇒ nothing written); `acp-dashboard-binding` stays the dashboard/webchat binding channel plugin only.
- **Add-on-level harness defaults (request GaRoN):** new add-on options `harness_base_url` (the ACTIVATOR — empty means nothing is generated), `harness_model` (shared across all non-excluded harnesses), `harness_api_key` (shared), `harness_excluded_agents` (comma-separated harness ids). The helper merges these additively into the writer's `config.harnesses` each writer-enabled boot; operator hand-entries in openclaw.json are never touched, stale generated entries are removed only when byte-identical to the generated value (never guess). Book file: `CONFIG_DIR/harness-config-writer/managed-defaults.json` (0600/0700). codex/opencode keep their `ollama_acp_*_model` defaults unless `harness_model` is set.
- **Backup-rewrite (request GaRoN):** enable/disable is now fully reversible — the first writer-enabled boot snapshots the pre-writer state of every managed file surface (`.codex/auth.json`, `.codex/config.toml`, both `opencode.jsonc`, legacy `opencode-home/config.toml`, `harness-env/*.env`) into `CONFIG_DIR/harness-config-writer-backup/manifest.json` (0600/0700, base64, atomic); turning the option OFF restores the originals + consumes the snapshot; re-enable takes a FRESH snapshot. Snapshot runs BEFORE the gateway so it can never capture writer output; quarantined (`.corrupt`) manifests veto re-snapshots until resolved.
- **ENV gate at the plugin (audit B2):** the writer plugin itself gates its deploy on `HARNESS_CONFIG_WRITER_ENABLED` (explicit wins) falling back to `ACP_DASHBOARD_BINDING_ENABLED` (unset ⇒ follows, mirrored from the helper) — the helper's off-restore survives gateway boots durably without de-registration (re-enable needs no rebuild).
- Option gating is now per plugin in `deploy_plugins()` (`_deploy_and_register_plugin(name)` parametrized): `acp_dashboard_binding_enabled` (channel, default OFF / Phase-2.15 semantics) and `harness_config_writer_enabled` (unset = follows the channel option; true runs it even with the channel off). New add-on option documented in config.yaml.
### Fixed
- **One-time legacy migration** (`plugins.entries['acp-dashboard-binding'].config.harnesses` → the writer entry) now respects an operator `enabled:false` opt-out (audit B3): config content is transported (data move; the legacy key would fail the binding manifest's additionalProperties:false), but an explicit opt-out is NEVER flipped; `enabled:true` is set only for a fresh writer entry.
- **Corrected over-stated harness count** from v0.7.13.16 notes: the installed acpx registry holds 18 adapters (SKILL doc lists 13 — behind the dist), of which the writer can configure 9 with effect (2 FILE + 7 ENV, names docs-verified); binding criterion (GaRoN): docs-verified config surface AND no OAuth/vendor login required — cursor/copilot/kilocode (OAuth), pi/mux/qoder/fast-agent/trae (env not yet verified, follow-up when docs exist), openclaw (the gateway itself) stay OUT.
### Changed
- Plugin hygiene: plugin `node_modules`/lockfiles are npm-local — excluded from the repo (.gitignore) and from the image build context (new `openclaw_ha_addon/.dockerignore`); `resolve_plugin_src_dir()` probes `PLUGIN_SRC_DIR` first (mock-correct).
### Verified
- python helper tests 30/30 (incl. restore cycle, quarantine, operator opt-out migration, merge semantics, idempotency, secrets-tight file modes); vitest writer 34/34 (24 src + 10 entry-level ENV-gate tests, fs-proven); vitest binding 161 passed + 1 skipped; strict tsc (writer tsconfig.check.json) clean. Audited by the ACP-Codex `coding-review` harness (spawned directly via the gateway CLI, session agent:coding-review:audit-a2-20261011): round 1 NO-GO (3 blockers: package.json corruption, gate-off reverse semantics, migration opt-out flip) → all fixed → delta re-audit GO + delta-2 GO (merge feature, cross-checked against the GO state).

## [0.7.13.16] - 2026-10-11

### Added
- **Generalized harness config (Phase 3, owner GO 11:10):** the plugin now carries the harness config deployment (previously the python helper's job) for ALL 22 acpx harnesses — normalized config (`plugins.entries['acp-dashboard-binding'].config.harnesses.<id>`: model/baseUrl/apiKey/thinking/smallModel/trustProjects), three mechanisms (FILE: codex/opencode; ENV: claude/gemini/droid/qwen/kimi/kiro/iflow; NONE: copilot/cursor CLI-OAuth).
- **Additive guarantee:** absent harness entry ⇒ no plugin writes, bundled acpx default runs unchanged (native subscriptions intact).
- **Deploy trigger:** registerFull, idempotent + fail-soft; config applies at next boot (BRIDGE.md §15.4).
### Changed
- `oc_acpx_helper.py`: `deploy_harness_configs`/`prepare_opencode_home` retired to no-ops with log marker; `deploy_plugin`/`install_acpx_npm_project` remain (bootstrapping).
### Verified
- 186/186 vitest (5 files), tsc strict clean, python helper tests 5/5; trust-dedupe (`/pfad` vs `/pfad/` tomllib header risk closed), auth never-overwrite, custom-preservation semantics verbatim from the helper.

## [0.7.13.15] - 2026-10-11

### Added
- **Phase 2.24b — session-key clone mode for MAIN conversations (owner 'B GO', GaRoN 06:26):** the MAIN conversation of a roster ACP agent (`agent:<id>:main`, exact 3-segment shape) now binds too. The adapter's derive answers a binding record whose target is the deterministic clone of the origin session-key text (conversation 1:1): for claude exactly `agent:claude:acp:binding:webchat:default:60bac3d65e697154` — live-verified `sha16("webchat:default:agent:claude:main")`, the night's `acp_error:acp_session_init_failed` "ghost" key becomes the ENSURED key (the ensure contract carries no conversationId shape gate — dist-verified).
### Changed
- New separate gate `isMainConversationEligible(agent-map)` beside the UNTOUCHED dashboard gate (`isBindEligibleConversationId`, 18:03 rule): main binds only for roster agents (Phase-2.17 precedence ladder + `runtime.type==='acp'`) and only while `plugins.entries['acp-dashboard-binding'].config.bindMainSessions !== false` (default true).
- Manifest `configSchema` declares `bindMainSessions` (boolean, default true).
- Origin-workspace cwd ladder: eligible main conversations now consult the fail-soft reader; **live-verified 2026-10-11:** `agent:claude:main` session_nodes row carries NO cwd/sessionRoot/projectId → null → agent-default cwd (`runtime.acp.cwd`); forward-compat ladder leg `origin-entry-cwd` added for a future host `entry_json.cwd`.
- Bridge (`resolveDashboardBindingDecision`) stays dashboard-only — main clone records come from the adapter derive; reply-claim barrier + `pendingDashboardHarnessProvisioning` work unchanged on the raw main clone key.
### Verified
- 162/162 vitest (--cache=false, was 152), tsc strict clean (tsconfig.scratch); new tests: main gate matrix (dashboard gate byte-unchanged), adapter record with the literal 60bac key + ensure kick + stability, non-roster/bindMainSessions-off rejections, harnessSessions override precedence for main, ensure-spec carries the origin key text, cwd ladder for main, main claim barrier; BRIDGE.md §14 documents decision/risks. NOT deployed (report-only per phase rules).

### Added
- **Session-key clone mode (owner design, GaRoN 04:16 proposal + GO 05:09):** every dashboard conversation gets its OWN persistent ACP session. The ACP key is a deterministic clone of the origin session key's conversation identity (`buildAcpBindingSessionKey` over the origin conversation id) — new UI session ⇒ new ACP session (persistent until host retention); existing session ⇒ existing key. The 1:1 binding window per conversation is trivially debuggable.
### Changed
- **Provisioner signature upgraded to object params** (`DashboardHarnessProvisionerParams {spec, conversation, targetSessionKey, cwd?}`) — the cascade passes the origin conversation directly; the previous positional `(spec, targetSessionKey)` form is gone.
- **Cwd flows ONLY into the ensure spec** (spawn process) — never into key identity. The origin-workspace reader stays unchanged as the cwd source; the phase-2.23 `:ws:`-reverse-parse in index.ts is removed entirely (no key-text parsing anymore).
- Legacy helpers (`buildHarnessProvisionedConversationId`/`SessionKey` in the scope-free grammar) stay exported with `@deprecated` jsdoc for config-leg and test compatibility.
### Fixed
- **The synthetic-leg `ACP_SESSION_INIT_FAILED` class dies structurally:** the provisioned leg now answers `buildAcpBindingSessionKey` over the ORIGIN conversation — exactly the key shape the night's failing turns routed to — and the ensure contract mints the `acp_sessions` row on that same key (ensure-key ≡ resolve-key by construction, no text parsing).
- The binding gate (`agent:<id>:main`/`acp`-class never bind) and the `harnessSessions` override leg are untouched.
### Verified
- 152/152 vitest (4 files), tsc strict clean; new clone-isolation tests: two conversations of the same agent ⇒ different keys, same conversation ⇒ stable key, ensure-spec carries origin-key + origin-cwd.
## [0.7.13.13] - 2026-10-11

### Fixed
- **Per-cwd binding keys now get real sessions (GaRoN night test 03:22, root cause fully traced):** the auto-provisioner discarded the cascade's `targetSessionKey` and passed a legacy `harness:<agent>` conversation id to the host ensure contract (`ensureConfiguredAcpBindingReady` → `buildConfiguredAcpSessionKey(spec)`). Consequently `acp_sessions` rows landed on the legacy per-agent key (`…:eb7bc1038d1aa310`, sha16 of `webchat:default:harness:claude`) while every resolve answered the cwd-scoped key (`…:ws:<hash>`) — dashboard-bound turns on the scoped key died with `ACP_SESSION_INIT_FAILED: ACP metadata is missing`, and the ensure-spawned session (idle, correct repo cwd) sat unreachable.
- **Harmonization:** `buildHarnessProvisionedConversationId(agentId, cwdScope?)` appends `:ws:<sha16(cwd)[0..12]>` and is now the single source of truth used by both the key builder and the spec converter; the provisioner carries the target key and the spec converter reverse-parses the scoped conversation id from it (bit-identical ensure-key ≡ resolve-key). Legacy no-scope keys keep the plain grammar.
### Verified
- In-process E2E against live copies with the owner's test conversation (`agent:claude:dashboard:65d8c362…`): ensure-key == resolve-key == `agent:claude:acp:binding:webchat:default:a32f2849a6a41b20`.
- 149/149 vitest, tsc strict clean.
## [0.7.13.12] - 2026-10-11

### Added
- **Origin-workspace cwd derivation (Phase 2.22, owner GO GaRoN 03:10):** bound harness sessions inherit the origin dashboard conversation's working directory instead of a fixed one. Read-only `node:sqlite` ladder: `workspaces[<conversationId>]` > `workspaces[<projectId>]` > `session_nodes.entry_json.sessionRoot` > `projects.repo_root` > agent-default. Fail-soft everywhere (missing state dir/degraded node drops the cached handle and retries on a later turn; misses memoized with a 30 s TTL, hits permanently).
- **Per-cwd deterministic session keys:** `harness:<agentId>:ws:<sha16(cwd)[0..12]>` — one persistent ACP session per agent × workspace; the ensure spec carries the resolved cwd directly into `acpManager.initializeSession` (meta-cwd ≠ spec-cwd would close+reinit, now impossible per scope).
- **Plugin-config surface (manifest `configSchema`, reload-deadlock-safe):** `workspaces` (explicit cwd map, conversation-id keys beat project-id keys), `deriveOriginWorkspace` (default on, opt-out), plus previously-undeclared `harnessReplyWaitMs`.
- **Binding eligibility gate (owner design rule 18:03):** only dashboard-class conversations (`agent:<id>:dashboard:<uuid>`, ≥4 parts) are auto-bound; `agent:<id>:main`, `acp`-class and unknown keys keep untouched builtin dispatch. The explicit `harnessSessions` override and explicit binding rows stay above the gate.
- **E2E evidence (live-verified):** `resolveOriginWorkspaceCwd('claude', 'agent:claude:dashboard:65d8c362…')` → `{cwd: /share/projekte/github/openclaw-ha-addon, source: origin-session-root}` against the real claude agent DB.
### Changed
- Ensure dedupe/signature cache keyed per target key (per-cwd scope); legacy agent-id keys stay compatible.
- Metadata parity: `metadata.cwd` (effective) + `metadata.originWorkspace` (ladder leg) on both synthesis paths.
### Fixed
- The synthetic-leg bootstrap trap for fresh dashboard conversations (the 17:51/20:56 `ACP_SESSION_INIT_FAILED` class): with derivation on, fresh conversations get a provisioned per-cwd key instead of an uninitialized synthetic key.
## [0.7.13.11] - 2026-10-10

### Fixed
- **Turn-1 binding race (proven by GaRoN's live test):** the async bridge start left `activeBridgeResolution` null on the first turn, so `binding-adapter.ts:259` fell into `resolveDashboardBinding()` without a config roster and ignored `harnessSessions` — the chat.send died with `ACP_TURN_FAILED: ACP input must be durably committed`. Fix: both delegation calls now pass `createConfigHarnessRoster(options.getConfig?.())` (roster precedence: active bridge > caller context > safe default), race-free by construction since the adapter's config always lives.
## [0.7.13.10] - 2026-10-10

### Added
- **`harnessSessions` config option (F3 fix, proven live):** dashboard conversations bind to a real, explicitly spawned persistent ACP session per harness (`plugins.entries['acp-dashboard-binding'].config.harnessSessions = {codex: '<session-key>', ...}`) instead of synthetic binding keys that die with `ACP_SESSION_INIT_FAILED` (the host only writes `acp_sessions` rows on real spawns — reverse-engineered: `manager.utils` `resolveStoredAcpSession` → `kind:"stale"`).
- Manifest `configSchema` now declares `boundAgents`, `excludedAgents`, `harnessSessions`.
- `deploy_plugin()` gates 1-4: deploy + `plugins.entries` + `plugins.load.paths` + **`plugins.allow`** (the 4th discovery gate, proven live: allowlist miss ⇒ "plugin disabled (not in allowlist)").

### Verified
- 86/86 plugin tests (incl. 13 harnessSessions cases), tsc strict; codex RE-Gegenverifikation of the host metadata contract; MVP == repo == live config bit-identical.
## [0.7.13.9] - 2026-10-10

### Changed
- **Binding selection philosophy (GaRoN 09:29):** replaced the hard Orchestrator block with a prioritized gate — `boundAgents` (explicit allowlist, may bind anything including orchestrator agents) > `excludedAgents` (replaces the default exclusion entirely) > safe-default exclusion (`main`/`coding-main`/`coding-review`). No ban without an escape hatch: the customer gets what they want.
- **Python unit tests for the deploy option gate** (tests/test_oc_acpx_helper_deploy_plugin.py, 5 cases: unset/false/true/case/idempotent).
- Docs: BRIDGE.md §8 documents the priority ladder + test matrix.

### Verified
- claude fix-run + independent codex final review (RELEASE-READY); 73/73 plugin tests, tsc strict; MVP == repo == live config bit-identical.
## [0.7.13.8] - 2026-10-10

### Fixed
- **Operator opt-out for the binding plugin never overridden:** `deploy_plugin()` flipped `plugins.entries["acp-dashboard-binding"].enabled` to `true` unconditionally on every boot; an operator-set `false` (GaRoN, 2026-10-10 ~08:45 attempt) was silently re-enabled by the next start. An explicit `false` is now respected across boots (helper logs `operator opt-out ... respected`, skips the `plugins.load.paths` registration while disabled), giving a one-plugin disable switch without touching `acp.*`/harness config.

## [0.7.13.7] - 2026-10-10

### Fixed
- **Plugin discovery path (F1c):** `deploy_plugin()` now also ensures `plugins.load.paths` contains the user-plugins root (`/config/.openclaw/plugins`) — registration (`plugins.entries`) alone does not make the gateway discover external plugins (proven live: 0.7.13.6 booted with the plugin deployed+registered but absent from the boot list until the path was patched by hand). User path entries are preserved.
## [0.7.13.6] - 2026-10-10

### Fixed
- **Plugin never deployed (F1):** the Dockerfile had no `COPY plugins` — `deploy_plugin()` early-returned "plugin source not found" and the acp-dashboard-binding plugin was absent at boot (proven 07:41 build). Fix: `COPY plugins /openclaw_ha_addon/plugins` after the acpx COPY, plus `resolve_plugin_src_dir()` fallback chain in `oc_acpx_helper.py` (image path → helper-dir → host checkout, logged) and manifest-scope orphan pruning after deploys.
## [0.7.13.5] - 2026-10-10

### Added
- **Custom ACP harness support (generic, user-independent):**
  - New options `ollama_acp_codex_model` / `ollama_acp_opencode_model` (harness model overrides, previously env-only) and `acp_additional_allowed_agents` (CSV of extra harness names beside claude/codex/opencode/openclaw).
  - `oc_acpx_helper.py`: `acp.allowedAgents` no longer overwrites user sets — union of built-ins + user extras (`or`-defaults for empty option values); new `deploy_plugin()` (sha256-manifest per file, copy only on change, prune node_modules, registers `plugins.entries` user-preserving).
  - New bundled plugin `acp-dashboard-binding`: webchat `SessionBindingAdapter` that routes Control-UI dashboard sessions at configured ACP harness agents automatically (dynamic roster read from `agents.entries.*.runtime.acp` — no hardcoded agent list; `main` never matched; empty roster = safe no-op). Resolves the last manual step (`/acp spawn --bind here`) for harness chats in the Control UI.

### Verified
- 9 live ACP-harness pipeline runs (recherche/build/review/fix/generalization): codex + claude + opencode harnesses against local Ollama; 56/56 plugin tests, tsc strict clean, py/bash/yaml checks green; independent codex re-review: READY FOR PHASE 3.

## [0.7.13.4] - 2026-10-09

### Security
- **Verified root command-execution via `gateway_remote_url` removed (audit):** `start_openclaw_runtime` eval'd Python-printed shell assignments; `urlparse` preserves `$(...)`/backticks in hostnames, so `gateway_remote_url = "ws://a$(cmd)b"` executed `cmd` as root at boot. Fix: Python emits plain data (host/port/flag, one per line) consumed as quoted shell arguments — no `eval` anywhere in the parse path; hostname additionally restricted to shell-safe characters (`[A-Za-z0-9._:-]`). (`run.sh`)
- **Repo-committed gateway token eliminated (audit):** the ACPX helper bootstrapped `openclaw.json` with the literal `PLACEHOLDER_ONBOARDING_TOKEN` (public in the repo); the post-onboard render loop treated any non-empty token as real and injected it as bearer auth in nginx, authenticating every Ingress client with a publicly known string. Fix: the duplicate helper bootstrap was removed entirely — run.sh is the single bootstrap owner and uses a per-install random token plus the correct internal gateway port per network mode (e.g. 18790 in `lan_https`) instead of hardcoded 18789; the helper only patches the `acp` section when the file exists. (`run.sh`, `oc_acpx_helper.py`)
- **Quarantine copy never clobbered + boot guard (follow-up audit):** if `openclaw.json.corrupt` already existed, a new corruption silently replaced the recovery copy. Fix: the second quarantine gets a timestamped name; and run.sh refuses to bootstrap a stub when only a quarantined copy exists (that stub would silently replace the real configuration and permanently undo the quarantine — the boot fails closed with host-level repair instructions, since web terminal/nginx are intentionally not started in this state). (`oc_config_helper.py`, `run.sh`)
- **Unreadable ≠ corrupt (follow-up audit):** a transient `EIO`/`EACCES` read error renamed a possibly-good config to `.corrupt`, bricking the next boot behind the corrupt-copy guard. Fix: only corrupt CONTENT (JSON/UnicodeDecodeError) triggers quarantine + exit; unreadable files exit 1 fail-closed WITHOUT renaming. (`oc_config_helper.py`)

### Fixed
- **Corrupt `openclaw.json` no longer overwritten with a minimal stub (audit, data loss):** parse failures fell back to `read_config() or {}` and a later write-back replaced the whole config (provider keys, agents, plugins) by a gateway-only stub. Fix: a corrupt config is quarantined as `openclaw.json.corrupt` and the helper exits 1 — never overwritten. All JSON writes (`oc_config_helper.write_config`, `oc_acpx_helper.write_json`, the run.sh first-boot bootstrap) are now atomic (temp + rename). (`oc_config_helper.py`, `oc_acpx_helper.py`, `run.sh`)
- **HEALTHCHECK failed in `tailnet_serve`/`tailnet_funnel` (watchdog restart loop):** the probe used plain HTTP against the gateway port, which serves HTTPS in both tailnet modes; a healthy container was flipped `unhealthy` after 4 probes. Fix: the healthcheck reads `gateway.tls.enabled` from the persisted config and probes `https://` with `--no-check-certificate` in TLS modes. (`Dockerfile`)
- **`gateway_env_vars` could override app-validated runtime variables (audit H):** `is_reserved_gateway_env_var` did not reserve `TERMINAL_PORT`, `GATEWAY_INTERNAL_PORT`, `HTTPS_PROXY_PORT`, `CERTS_DIR`, `ACCESS_MODE`, `INGRESS_PORT` and the other runtime control variables — overriding them (schema-valid for `gateway_env_vars`) bypassed the run.sh port/`nginx`-injection guards. Fix: all runtime control variables are reserved (follow-up audits completed the app-derived remainder: `TAILSCALE_MODE`, `GATEWAY_ADDITIONAL_ALLOWED_ORIGINS`, `MDNS_MODE`, `CONTROLUI_DISABLE_DEVICE_AUTH`, `ACPX_ENABLED`, `ENABLE_OPENAI_API`, `BLOCKED_HOSTNAMES`, `AUTO_CONFIGURE_MCP`, `TRACE_LOG_TO_CONSOLE`, `GATEWAY_LOG_TO_CONSOLE`); `render_nginx.py` additionally validates every port (`GATEWAY_INTERNAL_PORT` mandatory — it fills 16 proxy_pass directives; ASCII digits 1-65535 only, `str.isdigit()` also accepted Unicode digits like `²`), `CERTS_DIR` and the token charset before rendering. (`run.sh`, `render_nginx.py`)
- **Helper failures logged "exit code 0" and exited 0 (audit):** `rc=$?` captured the exit status of the `if !` negation — real config-helper failures caused a silent exit-0 crash-loop before nginx/ttyd started. Fix: rc captured from the helper itself. (`run.sh`)
- **ACPX helper error line was unreachable (follow-up audit):** the helper logged npm/patch failures but still exited 0, so run.sh's new `ACPX harness initialization failed (exit $?)` could never fire. Fix: `main()` now returns 1 on real failures (npm install failure, config unreadable/unwritable); run.sh logs and continues non-fatally. Also: `write_json` cleans up its `.tmp` file when a dump fails mid-write, and `patch_openclaw_config()`'s docstring no longer documents the removed bootstrap behavior (it would invite a maintainer to remove the actual run.sh bootstrap owner). (`oc_acpx_helper.py`)
- **Bogus "exit code 127" persisted on supervised restarts (follow-up audit):** the fix only covered the initial start; when a loop-retry `start_openclaw_runtime` failed, the stale (already reaped) `GW_PID` stayed set with `GW_IS_CHILD=true` and the next iteration `wait`ed on it. Fix: a failed restart clears `GW_PID` / sets `GW_IS_CHILD=false`, mirroring the failed-initial-start state. (`run.sh`)
- **Failed TLS cert regeneration no longer fakes success (follow-up audit):** with a stale `gateway.crt` from the previous boot still present, the `[ -f gateway.crt ]` success gate passed after BOTH openssl attempts failed and markers/INFO claimed the NEW IP/SANs for the OLD certificate (permanent hostname-mismatch TLS errors, never regenerated). Fix: the previous cert and its `.cert_*` markers are removed before generation AND success requires a parsable certificate (`openssl x509 -noout`) — a truncated/empty leftover from a failed openssl run must not pass the existence gate; a failed run leaves no cert (loud nginx failure + regeneration next boot). (`run.sh`)
- **ACPX `node_modules` gap (follow-up audit):** `need_install` compared only `package.json` strings; a failed first `npm install` left a matching `package.json` and every later boot took the "already up to date" path with `node_modules` absent — harnesses silently broken until a version pin changed. Fix: the managed node project checks every pinned dependency (acpx, codex, opencode) landed in `node_modules` (reinstalls when any is missing/failed). (`oc_acpx_helper.py`)
- **Remaining `gateway_env_vars` overridable closed (follow-up audit):** the last option-derived runtime variables (`ENABLE_OPENAI_API`, `BLOCKED_HOSTNAMES`, `AUTO_CONFIGURE_MCP`, `TRACE_LOG_TO_CONSOLE` — whose override flipped `set -x` and echoed token/key exports into the log — `GATEWAY_LOG_TO_CONSOLE`) are now reserved. The `gateway_port` option is validated at its read boundary (numeric 1024-65535, default 18789 fallback); the bootstrap heredoc keeps a defensive 18789 fallback for non-numeric `GATEWAY_INTERNAL_PORT`. (`run.sh`)
- **Stale ControlUI origins pruned (audit):** `allowedOrigins` was union-merged each boot, so origins from old LAN IPs survived DHCP changes forever. Fix: deterministic replace (config-derived defaults + `gateway_additional_allowed_origins` user extras); pruned entries are logged so hand-added origins can be re-added via the option. (`oc_config_helper.py`)
- **Boot-killing cert pipeline hardened (audit):** unsupported SAN hosts (IDN/IPv6/special chars) reached the unguarded `openssl x509 -extfile` step and aborted boot via `set -e`. Fix: SAN hosts are charset-validated, unsupported ones are skipped with a warning, and cert generation falls back to base SANs instead of killing boot. (`run.sh`)
- **Minor boot-logic fixes:** ingress-port-in-use check now actually runs (single-quoting bug); `GW_IS_CHILD` no longer forces `true` after a failed initial start (bogus "exit code 127" log); the post-onboard re-render subshell releases the startup lock (fd 9); `umask 077` no longer leaks past the HA-token write; `NODE_PATH` no longer gains a trailing colon (CWD in module resolution); timezone fallback aligned with the option default (`Europe/Berlin`); `oc-cleanup` no longer dies on EOF (`read ... || choice=q`); `NETWORK_MODE` now reaches the rendered Docs page. (`run.sh`, `oc-cleanup.sh`)

### Docs
- `SECURITY.md` rewritten for the 0.7.12.3+ `network_mode` presets (previously instructed `gateway_bind_mode`/`allow_insecure_auth`, which no longer exist), with a preset table and a Supported Versions section. `DEPLOYMENT.md` RAM section now documents the RAM-adaptive heap (8192/6144/4096/2048 MB by host RAM); duplicate 0.7.12.7 changelog bullet removed; `Dockerfile` `io.hass.version` label synced to the release version.

## [0.7.13.3] - 2026-10-09

### Fixed
- **Boot unbound-variable kill in the 0.7.13.2 ambient-env routing (day-zero, 2026-10-09):** `run.sh` line 81 read `$ANTHROPIC_API_KEY` under `set -euo pipefail`; the variable is not preset in the addon container (no real Anthropic key configured), so every start failed with `line 81: ANTHROPIC_API_KEY: unbound variable` and the watchdog cycled (21:34-21:45, supervisor stop/start actions, container never reached nginx/gateway stages). Fix: POSIX-safe default expansion `${ANTHROPIC_API_KEY:-}` — unset/empty still triggers the intended Ollama routing, a configured key is respected. Proven in `bash -u` (negative control: old form -> rc 127 with the byte-identical error; fixed: unset->fallback, set->keep-real, empty->fallback); `bash -n` OK; repo-wide `set -u` conditional-read sweep found no additional unguarded reads (`env_count`, `max_env_vars`, `HA_TOKEN` etc. are all assigned before use).

## [0.7.13.2] - 2026-10-09

### Changed
- **ACP harness modernization (B9):** removed all three custom ACP wrappers (`claude/codex/opencode-acp-wrapper.mjs`) plus `oc_provider_env.mjs` — the acpx plugin generates passthrough wrappers at gateway start and custom wrappers cannot survive that regeneration (they were repeatedly clobbered at 18:04/earlier). Provider routing now flows through ambient environment exports and config templates:
  - `run.sh` exports `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` (default `glm-5.3-flash:cloud`, override via `OLLAMA_ACP_MODEL`) when no real `ANTHROPIC_API_KEY` is present — Claude Code reaches the local Ollama backend with zero wrapper or key files (proven end-to-end: `end_turn` against Ollama, 17.4k tokens).
  - New template `acpx/.codex-source/config.toml`: codex provider routing to Ollama (`garon_ollama`, `wire_api = "responses"`, `requires_openai_auth = true` reading `auth.json`), `sandbox_mode = "workspace-write"`, trusted project entries. TOML model ids carry **no** `ollama/` prefix; opencode JSONC refs keep the prefix. Placeholders only — real endpoints live in runtime env, never committed.
  - New template `acpx/opencode.jsonc`: OpenCode provider via OpenAI-compatible `baseURL` with role model token.
  - `oc_acpx_helper.py`: role-differentiated model deployment (`__CODEX_MODEL__` for codex/audit, `__OPENCODE_MODEL__` for opencode/forge), env-overridable via `OLLAMA_CODEX_MODEL` / `OLLAMA_OPENCODE_MODEL`; harness config deploy now targets the acpx inheritance source (`/config/.codex`) instead of the regenerated `codex-home` (fixes recurring config-clobber root cause); dead code removed (`make_executable`, `find_installed_acp_binary`) per audit run.
  - Verified by 4 live audit runs through the real gateway (codex harness on `kimi-k2.7-code:cloud`): sandbox/trust gating fixed (sandbox_mode + trusted project entries are runtime gates in the operative codex config), one real defect found and fixed (dead code), template/placeholder consistency re-audited clean (run 4: zero findings).

## [0.7.13.1] - 2026-10-09

### Fixed
- **Boot exit-3 loop on real `options.json` (0.7.13 day-zero, 2026-10-09):** the safety-net option reads used the invented jq builtin `|number`. On any `options.json` that actually contained `upgrade_backup_keep` / `gateway_doctor_repair_max` (both present by default), jq refused to compile the program ("number/0 is not defined", exit 3) and `set -euo pipefail` ended the start before nginx/gateway could run - watchdog restart loop with ExitCode=3 (~10 cycles 05:26-05:31). Fix: real builtin `tonumber` + explicit `!= null` guard per the V7 has-guard pattern (missing key -> default 3, null -> default 3, string `"5"` -> 5, explicit `0` -> 0). Empirical proof in the 0.7.13 image (jq 1.6): old program -> exit 3 on the real options.json (negative control), new program 6/6 probes green, `bash -n` OK, repo-wide `|number` sweep negative.

## [0.7.13] - 2026-10-09

### Changed
- **OpenClaw pin 2026.9.8 → 2026.9.9** (v0.7.13 delta analysis, tarball-verified 2026-10-09):
  - **Verification before the bump:** `resolveThresholds` (memory threshold calibration) byte-identical between 2026.9.8 and 2026.9.9 dist tarballs — our RAM-adaptive heap ladder stays correct; exit-classifier token counts identical (AbortError×3, ECONN×2, fatal×5, network×1, sqlite×5, watch×10); npm engines unchanged (`>=24.16.0 <25 || >=26.1.0`, Node 24 compliant); no schema retirements, no option renames, no controlUi/allowedOrigins/device-auth/CSP/health-endpoint changes; openai-http agentId fix present natively (dist/openai-http-CQ7X8xZA.mjs).
  - **Patch anchors re-verified against the real 2026.9.9 dist:** unicode-guard applies 8/8 sites (4+4), 5/5 `node --check`, universality sweep 0 residues across 9160 dist files, exit 0; undefined-rejection shim registry symbol present in the new dist (upstream still ships no equivalent — the shim stays required).
  - **Upstream gains for our restart-heavy profile:** failed-update recovery hardening (#164497/#164724), restart-recovery triage retry (#160173), Docker upgrade-loop fix reusing verified rollback backups (#162305), doctor session-archive repair imports (#164867), quarantined-database respect + WAL-preservation guidance (#161783), long memory-checkpoint no longer stalls channel replies (#137359), scheduled-job isolation.
  - **Watch items (no action):** gateway token storage trend toward the secret store (#162372) — our helper still writes the bootstrap token directly; Telegram `/controlui` vs `/dashboard` split (irrelevant behind HA Ingress).

### Added
- **Pre-upgrade state backup gate (TechArtDev 0.5.94 parity):**
  - `backup_upgrade_state()` + `upgrade_backup_gate()` in `run.sh`: on any detected version change, archives `openclaw.json` + `state/` + `agents/` (WAL files included; SHM/locks/corrupt files excluded) to `/config/.openclaw/upgrade-backups/openclaw-state-<version>-<stamp>.tar.gz` (chmod 600) before the gateway starts.
  - Runs inside `start_openclaw_runtime()` so every attempt (initial + supervised restarts) is covered; skip-on-fail integrates with the hardened restart backoff.
  - **Options:** `abort_on_upgrade_backup_failure` (bool, default true — data fail-closed: no start into the new version without a complete archive; container stays up with nginx/terminal so the operator can free disk), `upgrade_backup_keep` (int, default 3, pruning keeps the newest).
  - **Rationale:** upstream verified backups engage only while the gateway starts; a boot that dies during its own migration (proven 2026-10-04/05 crash-loop: 130 restart cycles, corrupted state DB, manual SQLite surgery) previously had no honest rollback path.
- **Automatic doctor repair after consecutive start failures (TechArtDev 0.5.90 parity, BACKLOG V16/B4):**
  - After 2 consecutive failed starts, the repair runs in the restart path only — with openclaw.json snapshotted first — invoking `openclaw doctor --fix --non-interactive --yes`; budget `gateway_doctor_repair_max` (int, default 3, 0 disables) per app start; local modes only (remote mode never repairs a foreign gateway).
- **Three new schema options** (all with jq `has()` guards — explicit false/0 wins per the V7 lesson): `abort_on_upgrade_backup_failure`, `upgrade_backup_keep`, `gateway_doctor_repair_max`.

### Fixed
- **Restart storm hazard removed (TechArtDev 0.5.90 parity, BACKLOG V16/B8):**
  - Flat `sleep 2` replaced by exponential backoff `2^streak` capped at 60s; streak resets only when the previous boot survived ≥ 120s (measured at exit detection time, not after the ~20s self-restart detection sleeps — measuring after sleeps was the peer's pinned-at-2s bug).
  - Failure-streak telemetry in the log line (exit code + streak + backoff); loud diagnostic hint after 5+ consecutive failures.

### Changed (config hygiene)
- **Retired key no longer written (BACKLOG V8/B2):**
  - `oc_config_helper.py::set_control_ui_origins` now REMOVES `gateway.controlUi.dangerouslyDisableDeviceAuth` from the gateway config instead of writing it every boot (retired + ignored upstream since 2026.9.8: lint rule says "retired and ignored", doctor deletes it). Ends the boot-time fight with `openclaw doctor --fix`.
  - `controlui_disable_device_auth` option kept (config compatibility), marked deprecated in the comment; all six translation descriptions now describe the real behavior (device-flow pairing in every mode, no 1008 exception). Their earlier text promised a pairing-skip the gateway no longer honors.

### Security
- Both 0.7.12.7 security controls re-verified against the 2026.9.9 dist (unicode-guard patch green live against the actual tarball; shim registry present). No new ingest boundaries introduced in 2026.9.9.

### Deliberately open
- The undefined-rejection crash-loop root cause (§ REPAIR_STATUS 12.1 factor C) is NOT fixed upstream in 2026.9.9 (0 changelog hits); the shim + the three safety nets above remain the mitigation.

## [0.7.12.7] - 2026-10-08

### Security
- **OWASP LLM01:2026 Control #5 — context-sensitive invisible-unicode stripping at every external-content ingest boundary:**
  - **Gap in OpenClaw 2026.9.8:** `web_fetch` texts were stripped with a naive character-class strip (`INVISIBLE_UNICODE_RE`) that unconditionally removed U+200D (ZWJ) — breaking valid emoji sequences — and left isolated variation selectors (U+FE00–U+FE0F, a documented smuggling channel, Rehberger 2024/2025) untouched; `web_search` results (titles/snippets/answer/citations) were not stripped at all.
  - **Fix — build patch `unicode-guard/`** (runs in the Dockerfile after `npm install -g openclaw@2026.9.8`): `apply-unicode-guard-patch.mjs` splices the tested implementation from `strip-invisible-unicode.mjs` (single source of truth) into ALL naive copies in the dist tree — the unicode-visibility module, the gateway bundle AND the minified worker bundles `dist/worker/worker.mjs` + `dist/worker/sqlite-store.worker.mjs` (audit F1: independent copies of both targets, including Email/Webhook hook session logic; design decision: Option B over an exception list).
  - **Coverage:** also patches `sanitizeExternalContentText` — the funnel for wrapExternalContent/wrapWebContent and thereby web_search, web_fetch spill, Email/Webhook/Cron/Browser/Channel metadata — so every external-content boundary strips before prompt rendering.
  - **Context-sensitive stripping:** VS16 after an emoji base, keycaps and ZWJ sequences survive; the tag block U+E0000–U+E007F, isolated VS, ZWSP/ZWNJ/word joiner/FEFF and bidi controls are removed.
  - **Verification:** anchors byte-exact at top level plus whitespace-/parameter-tolerant regex anchors for the minified worker copies (captured parameter reused in the replacement); idempotent; every patched file secured with `node --check`; a post-patch universality sweep over the entire dist tree fails the build loudly on ANY naive remainder (audit N1b: silent exit 0, hence closed); when upstream fixes this natively, the sweep deliberately fails as the decision trigger for patch-block removal.
  - **Tests (15):** 8 spec vectors + edge cases + dist verification against patched modules, including real `web_fetch` extraction and worker-splice byte identity (vector 7: clean 56 KB ≈ 3 µs/call, polluted 59 KB ≈ 1.6–6 ms/call).
  - **Behavior + tradeoffs** (subdivision flags, ZWNJ orthography, CJK SVS): `unicode-guard/README.md`. Gateway config unchanged; long-term upstream path noted.

### Fixed
- **Healthcheck kill on clean Pi boot fixed (HEALTHCHECK start-period 120s → 420s, retries 3 → 4):**
  - **Evidence:** Supervisor log 2026-10-07 19:41:39 — "Watchdog found app OpenClaw Assistant is unhealthy, restarting…" + docker kill exit 137 despite a clean boot.
  - **Root cause:** Homebrew sync, skill copy and gateway init can take >4 minutes on the Pi; the old 120s window expired before the gateway answered `/startupz` — 3 consecutive fails marked the container unhealthy, the Supervisor watchdog killed it (ONE mechanism, no second kill path).
  - **Fix semantics:** fails within the Docker start-period grace window do not count against the retries — the kill ring for slow but clean boots is closed; genuine hangs stay quickly detected (4 consecutive fails at 30s intervals after the start period).
- **V21 — external WebUI button ("WebUI ↗") now always targets the same-origin ingress URL:**
  - **Old defect:** the button carried the statically rendered `__GATEWAY_PUBLIC_URL__` (render_nginx.py auto-constructed from `hostname -I` → a borrowed LAN IP while option `gateway_public_url` is empty) and was unusable from the internet (Nabu Casa/DyndNS).
  - **Why same-origin is always correct:** since the 0.7.12.1 ingress lockdown the landing runs exclusively inside the HA ingress session (local + external via Nabu/DyndNS identical — the inline tab is the proof path).
  - **Implementation** (GaRoN spec 2026-09-26 17:36): client-side on load, `btnWebuiExternal.href = './webui/#token=' + <token>` with autologin parity to the inline tab — same `GATEWAY_TOKEN` placeholder (render_nginx.py substitution), same `#token=` mechanism, same guard against unreplaced placeholders; static no-JS fallback `./webui/`.
  - **Deliberate drops:** LAN-18789 ingress bypass removed (functionally irrelevant); NO Python/nginx touch — render_nginx.py unchanged, its `__GATEWAY_PUBLIC_URL__` replace becomes a no-op; placeholder inventory confirmed.
  - **Companion item:** a DyndNS origin for `allowedOrigins` proceeds separately as an add-on option.


### Added
- **`sshpass` baked into the image (apt zone 1, next to openssh-client):** sshpass previously existed only as a runtime post-install inside the running container and was lost on every rebuild/container swap (password-based SSH to the host then dead again without `apt-get install sshpass`). Debian bookworm/main arm64: the package exists, verified live via `apt-cache policy` (sshpass 1.09-1); zone-1 syntax consistent with the openssh-client line.

## [0.7.12.6] - 2026-10-07

### Fixed
- **Import check switched to `importlib.metadata`:** crawl4ai 0.9.4 exports `__version__` as a submodule (not a string) — the first Supervisor build failed with `TypeError: can only concatenate str (not "module") to str` in the version-echo line. The 0.7.12.5 predecessor carried the same bug, hidden behind `2>/dev/null || echo "version check failed"`. `version("crawl4ai")` (stdlib) is stable within the package and verified live (0.9.4).
- **Dangling `/usr/bin/chromium` on every arm64 rebuild (P1)**:
  - **Failure mode:** Playwright ≥1.63 installs arm64 Chromium to `chromium-<rev>/chrome-linux-arm64/`; the Dockerfile symlink glob hardcoded the x64 layout (`chromium-*/chrome-linux/chrome`), matched nothing on arm64, and `ln -sf` silently produced dangling symlinks — masked by the trailing `|| echo 'version check failed'`.
  - **Effect:** every rebuild shipped green with a dead OpenClaw browser tool (`browser.executablePath not found: /usr/bin/chromium`) while the binary existed at `/opt/ms-playwright/chromium-1243/chrome-linux-arm64/chrome`.
  - **Fix:** shared resolver `browser_links.sh` → `/usr/local/bin/link-playwright-chromium` — layout-agnostic `find` (path `chromium-*/chrome-linux*/chrome`, highest revision wins via `sort -V`), re-links `/usr/bin/chromium` + `/usr/bin/chromium-browser`, and fails the build hard when no executable is found.
- **crawl4ai browser-revision drift**:
  - Crawl4ai 0.9.4 launches through both `playwright` and `patchright` (browser_manager.py, browser_adapter.py and install.py reference patchright); both pin Chromium revision 1243 today, but browsers were only downloaded in the playwright layer — a future crawl4ai bump upgrading playwright/patchright would resolve revisions never present in `PLAYWRIGHT_BROWSERS_PATH` (green build, broken crawls). The crawl4ai layer now re-runs `playwright install chromium` and `patchright install chromium` (idempotent no-ops at revision parity) and refreshes the links via the shared resolver.
- **Stale Dockerfile comment**: claimed `run.sh` symlinks `/config/.cache/ms-playwright -> /opt/ms-playwright` at runtime — no such code ever existed, and `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright` makes it unnecessary. The comment now describes the real mechanism.

### Added
- **Boot self-heal in run.sh**: before the browser-config ensure step, run.sh re-runs the linker whenever `/usr/bin/chromium` is missing or non-executable, so future layout changes or rebuilds self-repair at start; a loud WARN (carrying the resolver's own error) replaces silent failure.

### Changed
- **Version pins** (owner-approved 2026-10-07): `crawl4ai==0.9.4`, `playwright==1.63.0`, `patchright==1.63.0` — all three were the PyPI latest at survey time, so nothing is lost today; pins move updates from build-time chance to deliberate release steps (survey + audit + owner GO), giving reproducible images.

### Expectation map (the durable contract)
- OpenClaw consumes `/usr/bin/chromium` (`browser.executablePath` in `openclaw.json`; CDP transport, no Python involved).
- crawl4ai consumes revision-matched builds under `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright` via Python `playwright`/`patchright` (system packages; the persistent `/config/clawd/.venvs/crawl4ai` stays user-managed, currently the same revision).
- Under `/opt/ms-playwright` the revision directory is the single source of truth; `/usr/bin/chromium` is only an alias, maintained at build and boot — never by hardcoded globs.

## [0.7.12.4] - 2026-10-03

### Performance
- **RAM-adaptive Node.js heap budget:**
  - **Root cause (dist-verified):** OpenClaw derives its memory-pressure warning threshold from the heap limit (`rssWarningBytes = max(1536 MB, heapLimit * 0.5)`); the static 4096 MB budget on hosts with 12+ GB RAM kept the gateway's normal working set (~2.2–2.4 GiB, 13–14 workers) permanently above the 2048 MB threshold, so cooperative yields stalled `sessions.list` for 5+ seconds on every Control UI first load.
  - **Change:** the heap is now sized from host RAM at boot — ≥24 GB → 8192 MB, ≥12 GB → 6144 MB, ≥8 GB → 4096 MB, below → 2048 MB; on this host the threshold rises to 3 GiB, above the working set.

### Fixed
- **🩹 Server TLS certificate generation restored (P0)**:
  - **Defect:** the v0.7.10.0 network-mode refactor accidentally dropped the server-cert generation inherited from the original run.sh (only the local CA survived); nginx terminates TLS on :18789 with `/config/certs/gateway.crt` and `gateway.tls` is disabled, so **fresh lan_https installs had no server certificate at all** and DHCP IP changes never regenerated it.
  - **Restored:** SAN certificate covering LAN IP, loopback, homeassistant(.local) plus origins from `gateway_additional_allowed_origins`/`gateway_public_url`, regenerated on IP or SAN change, gated to the HTTPS-proxy modes.
  - **Hardened (X.509v3):** CA and server cert carry `basicConstraints`, `keyUsage` and `extendedKeyUsage` (serverAuth) so strict clients (Python `requests` with `verify=`, OpenSSL strict) accept them; pre-0.7.12.4 certificates regenerate once via a `.cert_ext` marker.
- **Boolean option reads (`jq // true` trap)**: `jq`'s `//` alternative fires for an explicit `false` just like for a missing key, so six boolean reads (`enable_terminal`, `enable_webui`, `enable_docs`, `controlui_disable_device_auth`, `force_ipv4_dns`, `acpx_enabled`) silently reverted the user's OFF choice to the default on every start. All reads now use `if has(...)` so an explicit `false` survives (same fix the peer add-on shipped in their 0.5.88).
- **502 during gateway startup**: the `/webui` locations now intercept 502/503/504 and serve the loading page, which explains that the terminal is already usable while the gateway finishes its multi-minute SQLite warmup (previously a raw 502 flooded the supervisor log and confused users).
- **nginx warning**: removed the duplicate `sub_filter_types text/html` declaration (the default is already text/html) that produced a "duplicate MIME type" warning on every config test.

### Changed
- **OpenClaw 2026.9.8** (from 2026.9.6; tarball-verified: the OpenAI `agentId` fix remains native in `dist/openai-http-E_fP_MwD.mjs` L386/400
  - Node requirement `>=24.16.0 <25 || >=26.1.0` satisfied by the image's Node 24; no schema migrations — upgrade is low-risk). Release highlights for this setup: GPT-6.1 Sol model, Codex catalog processes on demand (RAM reduction), delegated results tied to their conversation, container update hardening, Control UI tab retention across updates. Note for multi-agent teams: internal sessions can no longer end with `NO_REPLY` and automatic peer back-and-forth/announcement turns were removed — explicit `sessions_send` coordination (as used here) is unaffected.
- **`openssh-client` added to the image**: the official OpenClaw Dockerfile documents that the sandbox backend spawns `ssh` directly; the app image never shipped an `ssh` binary, so every SSH-based agent capability (SSH gateway connections, paired-node diagnostics, host access) failed with `command not found`. SSH-based tools now work out of the box.
- **Supervisor watchdog** (`tcp://[HOST]:49200`): the Supervisor restarts the app when the Ingress front door stops answering. The probe originates from the Supervisor network (172.30.32.0/23), which the 0.7.12.1 lockdown allowlist explicitly permits.
- **`backup_exclude`** (Home Assistant backup size reduction): regenerable caches and toolchains are excluded from HA backups — `.linuxbrew`, `.node_global`, `.npm`, `.cache`, `.node-compile-cache`, `__pycache__`, `*.jsonl.lock` (verified present on this install: ~12 GB combined). User state (openclaw.json, agent databases, skills, sessions, clawd workspace, keys, certificates) is always backed up.
- **Configuration diet (audited, 36 → 30 options)**: removed the dead `router_ssh_host`/`router_ssh_user`/`router_ssh_key_path` options (their only consumer was an info dump in `/config/CONNECTION_NOTES.txt`) and hardcoded `cron_skip_missed_jobs` (true is always right for an HA app that restarts frequently; also the live victim of the `jq` trap: an explicit `false` was being silently ignored) and `clean_session_locks_on_start/exit` (always-on is the only sane default) — no behavior change, fewer knobs.

### Upgrade notes
- After updating, open the app configuration once and save to drop the removed options from the supervisor store (clears the last schema warnings).
- A pre-upgrade database backup was taken and verified before this release (32/32 SQLite files, WAL-consistent copy + integrity check via node:sqlite; the system Python's SQLite 3.40.1 cannot check 2026.9.6+ schema-23 databases that use `octet_length()` — see the two-stage backup recipe).
- Verified pre-push: sandbox-rendered nginx config (`nginx -t` OK), `bash -n` on all scripts, YAML parity across all six translations against the cleaned schema, no remaining `jq // true` boolean reads, certificate regeneration marker in place.

## [0.7.12.3] - 2026-09-26

### Changed
- **Terminology: Add-ons → Apps** (HA 2026.2 renamed add-ons to apps; upstream keeps slugs, `addon_config` mounts, `/addons` Supervisor API endpoints and repo URLs as technical identifiers — see home-assistant/architecture discussion #1287): all user-facing strings in this project now say "app" — README/README.de, DOCS.md, SECURITY.md, CONTRIBUTING.md, DEPLOYMENT.md, config comments, all six UI translations, landing/docs pages, runtime log messages, oc-cleanup output.
- **Translation fix (es/bg/pl/pt-BR)**: `mdns_host_name` descriptions claimed the default hostname is "openclaw-ha-addon"; the actual default is `openclaw` (run.sh `jq … // "openclaw"`).

## [0.7.12.2] - 2026-09-26

### Performance
- **Ingress asset compression restored**: the static ControlUI locations (`/webui/assets/`, `/themes/`, `/favicon`, `/apple-touch-icon`, `/manifest.webmanifest`) now pass the client's `Accept-Encoding` through to the gateway instead of forcing `identity`. The gateway serves brotli/gzip natively (measured: 468 KB → 138 KB for the largest bundle, 3.4× less transfer per cold load; ~1 MB total). The `/webui/` HTML locations keep `identity` because `sub_filter` requires uncompressed responses; the `= /webui` WebSocket bridge is untouched.

### Fixed
- **CSP synced with upstream 2026.9.6** (`buildControlUiCspHeader`, dist-verified): added `frame-src 'self' http: https:` (link-preview iframes were blocked), `img-src https:` (remote agent avatars were blocked), `connect-src data:`; replaced the over-broad `script-src 'unsafe-eval'` with `'wasm-unsafe-eval'` (bundle-verified: zero `eval`/`new Function` across all 8 ControlUI bundles, one WebAssembly consumer). `frame-ancestors 'self'` intentionally kept for the HA Ingress iframe; `'unsafe-inline'` for scripts kept because the sub_filter base-path injection cannot be hash-covered.

## [0.7.12.1] - 2026-09-25

### Security
- **Ingress lockdown**: nginx `:49200` now only accepts loopback and the HA Supervisor network (`172.30.32.0/23`). Direct LAN access to the terminal (previously an unauthenticated root shell) and the token-bearing landing page is rejected with 403; Terminal/TUI surfaces are exclusively reachable through the authenticated HA Ingress session. (P0)
- **nginx.conf permissions**: the rendered config embeds the gateway bearer token and is now written with `0600` instead of the umask default `0644`. (P1)

### Changed
- **Boot order inverted**: nginx and the web terminal now start BEFORE the OpenClaw gateway. The Ingress panel (Terminal as fallback surface) is reachable during slow gateway startup (SQLite session validation can take minutes); the gateway starts after the ingress proxy is serving.
- **TUI removed**: the `openclaw tui` iframe tab, its ttyd instance, and the `enable_tui`/`tui_port`/`tui_session` options are gone — the bash Terminal is the only fallback surface. Terminal is the default active tab.

### Fixed
- **Schema drift**: `cron_skip_missed_jobs` is back in the `schema:` block (dropped in a06a272 while remaining in `options:`), fixing the recurring supervisor warning `Option 'cron_skip_missed_jobs' does not exist in the schema`.
- **CRLF pollution**: `oc_config_helper.py` had CRLF line endings in the worktree (Git index LF); renormalized so image builds copy the exact committed bytes.
- **Dead code removed**: the `docs/index.html` copy block in run.sh never executed (Dockerfile ships `docs/index.html.tpl`, rendered by render_nginx.py); TUI assets are no longer copied.

### Added
- **Translations**: schema parity for all 6 languages (en/de/es/bg/pl/pt-BR) — every schema option now has a name/description (`acpx_enabled`, `blocked_hostnames`, `cron_skip_missed_jobs`, `enable_docs`, `enable_webui`, `enable_openai_api`, `force_ipv4_dns`, `nginx_log_level`, `network_mode`, `ollama_base_url`); stale keys for options that no longer exist (`gateway_bind_mode`, `access_mode`, `gateway_auth_mode`, `mdns_service_port`, `mdns_interface_name`) removed from es/bg/pl/pt-BR.
- **Audit hardening** (coding-review NO-GO findings, fixed pre-merge): a failed gateway start no longer exits the container — nginx and the terminal stay up and the supervisor loop retries (P1); duplicate `__SHOW_TERMINAL_JS__` replacement removed (P1); hardcoded `127.0.0.1:18790` in the `location = /webui` WebSocket bridge replaced with `__GATEWAY_INTERNAL_PORT__` so `gateway_port` changes no longer break the no-slash reconnect path (P2).

> **Upgrade note**: stored add-on options from previous versions may still contain `enable_tui`, `tui_port` and `tui_session`. Until the next options save, the supervisor may log benign `Option ... does not exist in the schema` warnings for these keys. Open the add-on Configuration page once and save to prune them permanently.

## [0.7.12.0] - 2026-09-25

### Changed
- **OpenClaw**: Update to `2026.9.6` (from 2026.9.5). Major upstream improvements relevant to this add-on:
  - **Restart recovery**: unfinished conversations survive restarts with saved history, progress and tool results; interrupted subagents are continued by the leading agent instead of auto-relaunching (fixes the recurring boot-time "Cannot delete session while competing work is in flight" zombie sessions).
  - **Slow-startup detection**: health/restart checks now distinguish "still starting" from "failed" (exit code 2 = starting). Directly mitigates the SQLite session-reclamation startup timeout on high-usage SD-card installs.
  - **`openclaw doctor --session-sqlite recover`**: new repair tool for session databases.
  - **Storage compaction** (agent schema 23, shared-state schema 18): lossless history compression + compact memory vectors. Migration is one-way — downgrades require the pre-upgrade backup. A full WAL-consistent backup of all 31 agent/state DBs was taken before this release (integrity-verified).
  - **WebChat reconnect resilience**: chat stays usable during reconnects; "Forget this browser" in Settings → Connections resets stale browser sign-ins (the tool we were missing during the localStorage debugging).
  - **KillMode=mixed systemd policy repair** via Doctor (resolves the long-standing stale service-unit warning).
- **Dockerfile**: no agentId patch block needed — the openai-http agentId fix remains native in 2026.9.6 (tarball-verified).

### Notes
- Ingress fixes from 0.7.11.15.x (asset paths dbc00fe, localStorage cleanup 0d32951, /webui WS proxy d037bd1) are all retained and unaffected by the OpenClaw bump.
- Verified against the full 2026.9.6 changelog: no changes to loopback Host-header validation (proxy_attribution), controlUi.basePath, Ollama provider, or gateway auth model. Only breaking change is TypeScript-only code cells (not used by this setup).
- Disk usage at release time: 84% (37GB free). Old full backups under /share/backups (42GB) are cleanup candidates for future headroom.

## [0.7.11.15.3] - 2026-09-25

### Fixed
- **Nabu Casa / external "Gateway nicht erreichbar" after reconnects (the real killer)**:
  - **Root cause:** the ControlUI stores the gateway URL in its normalized localStorage form as `.../webui` *without* a trailing slash; after stripping the ingress prefix the Supervisor bridge forwards that exact path to nginx, whose config only had trailing-slash locations — so `/webui` fell through to an implicit 301 redirect to `/webui/`.
  - **Failure chain:** WebSocket clients never follow redirects — the supervisor completed the client-side 101 and then silently dropped the tunneled socket. First panel loads (via `/webui/`) worked; every reconnect after Nabu Casa idle disconnects (1006 every ~2 min) used the stored slash-less URL, died at the redirect, and landed in the "Gateway not reachable" connect dialog with an `ha-panel-app.ts:339 Uncaught (in promise) 3` crash.
  - **Fix:** explicit `location = /webui` proxies directly to the gateway (WebSocket headers included) instead of redirecting.
  - **Verified live:** GET `/webui` → 200 (was 301), WS upgrade `/webui` → 101, `/webui/` unchanged, panel load 200; confirmed end-to-end via Nabu Casa from the iOS Companion App. (d037bd1)

## [0.7.11.15.2] - 2026-09-24

### Fixed
- **Ingress ControlUI asset 404s (local + Nabu Casa)**:
  - HA Supervisor sends `X-Ingress-Path` *without* the `/webui` panel suffix. The previous maps built asset and base-path prefixes directly from that value, so the ControlUI bundle resolved assets as `/api/hassio_ingress/<token>/assets/...` — after the supervisor strips the ingress prefix those requests hit the nginx catch-all 404. New `$ingress_path_norm` map strips any trailing `/webui` (also defends against the 2026-09-22 double-`/webui` variant) and rebuilds **all** prefixes as `norm + "/webui/..."`. Direct nginx access without an ingress path keeps relative `./assets/` URLs. (dbc00fe);
- **Nabu Casa "Gateway nicht erreichbar" connect dialog**:
  - **Defect:** the injected cleanup script only removed localStorage `gatewayUrl`/`bootRecord` entries pointing at `127.0.0.1:18789`; browsers that cached a gateway URL with the bare Nabu host and no ingress path kept trying `wss://<slug>.ui.nabu.casa/` instead of the ingress route, so no WebSocket attempt ever reached the gateway.
  - **Fix:** the script now removes ANY entry whose value does not contain the current ingress base path, forcing the ControlUI to re-derive the WebSocket URL from the injected `data-openclaw-control-ui-base-path` attribute on every load. (0d32951)

### Notes
- Both fixes are nginx `sub_filter`/map changes only; no OpenClaw version, add-on startup, or gateway changes.
- Server-side verified live: ControlUI HTML + script tags resolve under `/api/hassio_ingress/<token>/webui/`, WebSocket upgrade with Nabu origin returns `101 Switching Protocols` + `connect.challenge`.

## [0.7.11.15.1] - 2026-09-23

### Fixed
- **Ingress WebSocket through HA/Nabu Casa**: Force loopback `Host` header in nginx `/webui/` proxy so OpenClaw 2026.9.5 treats HA Ingress traffic as local loopback.
- **Ingress asset loading**: Add unauthenticated nginx locations under `/webui/` for static assets, themes, favicon, apple-touch-icon and manifest, so HA Supervisor can fetch them without the add-on bearer token.
- **Ingress asset paths**: Remove duplicate `/webui` suffix from X-Ingress-Path base path maps so ControlUI builds correct asset URLs under `/api/hassio_ingress/<token>/webui`.

### Notes
- Conservative fix release based on 0.7.11.15. Only nginx configuration changed; no OpenClaw version or add-on startup changes.

## [0.7.10.25] - 2026-09-05

## [0.7.11.11] - 2026-09-23

### Changed
- **Rollback**: Revert add-on code base to v0.7.11.3, which was the last release where HA Ingress (including Nabu Casa remote access) worked reliably.
- **OpenClaw**: Stay on `2026.9.4` as included in v0.7.11.3.

### Notes
- This release intentionally does **not** include the nginx/Ingress changes from v0.7.11.4–v0.7.11.10, because those releases broke the ControlUI WebSocket connection through Nabu Casa Ingress.
- The OpenAI-compatible `agentId` patch for 2026.9.4 remains in place.
- If you are already on v0.7.11.10 and seeing “Gateway not reachable” through Ingress, install this update and reload the add-on store in HA (`Settings → Add-ons → Add-on Store → ⋮ → Reload`).


### Changed
- **OpenClaw**: Update to `2026.9.1`.
- **Add-on schema**: Add `cron_skip_missed_jobs` (default `true`) and `blocked_hostnames` options for OpenClaw 2026.9.1 configuration controls.
- **run.sh**: Log detected OpenClaw version at startup for easier support diagnosis.

### Fixed
- **Ingress WebUI asset loading**: `nginx.conf.tpl` already forces uncompressed upstream HTML and rewrites ControlUI asset paths; kept compatible with 2026.9.1. Verify after upgrade.

### Notes
- OpenClaw 2026.9.1 introduces `cron.skipMissedJobs` and `blockedHostnames`. Back up `/config/clawd` before first start after update.


## [0.7.10.17] - 2026-09-04

### Fixed
- **Ingress WebUI assets with OpenClaw 2026.8.2**: OpenClaw 2026.8.2 ships the Control UI with `<base href="/">`, which caused all assets to resolve against the Home Assistant origin and return 404 inside the Ingress iframe. nginx now rewrites `<base href="/">` to the HA Ingress base path and strips `Accept-Encoding` from the upstream request so `sub_filter` can operate on uncompressed HTML.

## [0.7.10.2] - 2026-09-04

### Fixed
- **Ingress WebUI with HTTPS gateway**: nginx now proxies `/webui/` to `https://127.0.0.1:18789/` when the gateway runs in `lan_https` / TLS mode, accepting the auto-generated self-signed certificate. Previously Ingress broke when `network_mode` was switched from `ingress_only` to `lan_https`.
- **TUI startup**: `openclaw tui` now starts with `--session agent:coding-main:main` for OpenClaw 2026.8.2 multi-agent requirement (0.7.10.1).
- **Ingress base-path injection**: nginx `sub_filter` now injects the HA Ingress base path for both `data-openclaw-terminal-enabled="false"` and `"true"` (0.7.10.1).

## [0.7.10.1] - 2026-09-04

### Fixed
- **TUI startup**: `openclaw tui` now starts with `--session agent:coding-main:main` to satisfy OpenClaw 2026.8.2 multi-agent requirement.
- **Ingress WebUI**: nginx `sub_filter` now injects the HA Ingress base path for both `data-openclaw-terminal-enabled="false"` and `"true"`, fixing WebUI inside HA Ingress.

## [0.7.9.28] - 2026-09-03

### Fixed
- **Homebrew install**: Robustified Homebrew installation path for Node 24 / OpenClaw 2026.8.2.

## [0.7.9.27] - 2026-09-02

### Changed
- **OpenClaw**: Update to `2026.8.2`.
- **Node.js**: Update from NodeSource `node_22.x` to `node_24.x`.
- **mcporter**: Add global install `mcporter@0.12.3` for MCP server auto-configuration.
- **node-llama-cpp**: Keep at `3.20.0` as requested.

### Notes
- This release follows the upstream 2026.8.x line. The 2026.8.x OpenClaw release migrates sessions/transcripts to SQLite; a full `/config` backup is required before first start after update.

## [0.7.9.26] - 2026-08-23

### Changed
- **Landing Page Titlebar Redesign**: Home Assistant Material Design 3 Stil mit korrigierten Farben. Alte Titlebar-Struktur mit Tabs oben beibehalten.
- **UX**: removed the HTTPS/secure-context warning banner inside the ingress.

### Fixed
- **Tab visibility**: tabs are shown/hidden correctly based on app configuration and iframe context.

## [0.7.9.24] - 2026-08-23

### Changed
- **Landing page redesign**: Home Assistant Material Design 3 style with cards, chips and tile navigation.
- **Security**: `__GATEWAY_TOKEN__` is escaped with `html.escape()` in `render_nginx.py`.
- **Features restored**: CA cert download (only `lan_https`) and disk usage display in the footer.

## [0.7.9.23] - 2026-08-23

### Fixed
- **Ingress Gateway Health Sensor (HA iframe path)**: Changed health fetch from absolute `/api/health` to relative `./api/health` in landing page, TUI and docs, so requests resolve correctly inside the HA Ingress iframe context.

## [0.7.9.22] - 2026-08-23

### Fixed
- **Ingress Gateway Health Sensor**: `/api/health` now proxies to the actual OpenClaw Gateway `/health` endpoint instead of returning a static nginx 200 OK.
- landing, TUI and docs pages parse JSON response and check `data.ok`.

## [0.7.9.21] - 2026-08-23

### Fixed
- **Codex ACP Wrapper auth race**: `resolveProviderEnv()` is now called before checking/writing `auth.json`, ensuring the Ollama fallback key is correctly visible to the wrapper.

## [0.7.9.20] - 2026-08-23

### Fixed
- **Plugin API version compatibility**: `run.sh` now exports a plain semver string for `OPENCLAW_VERSION` so the plugin API compatibility check (`>=2026.7.1`) passes and ACPX loads.

## [0.7.9.19] - 2026-08-13

### Fixed
- Quote ACPX_ENABLED jq selector in run.sh.

## [0.7.9.18] - 2026-08-13

### Fixed
- Line-ending normalization in `run.sh` so HA picks up the file correctly.


## [0.7.10.29] - 2026-09-12

### Changed
- **OpenClaw**: Update to `2026.9.4`.
- **Add-on version**: Bump to `0.7.10.29`; Dockerfile and metadata aligned.

### Notes
- OpenClaw 2026.9.4 introduces safer rollback for compatible failed updates. Database migrations still require a verified pre-update backup; back up `/config/clawd` before first start after update.
- No new add-on schema options in this release.

## [0.7.10.28] - 2026-09-08

### Changed
- **OpenClaw**: Update to `2026.9.3`.
- **Node.js**: NodeSource `node_24.x` channel provides Node 24.20.0, satisfying the OpenClaw 2026.9.3 minimum requirement (Node 24.16.0+ on 24.x).

### Fixed
- **Release build correctness**: Previous 0.7.10.26/27 releases bumped the add-on version while the Dockerfile still installed OpenClaw 2026.9.1/2026.9.2. This release aligns add-on version, Dockerfile, and installed OpenClaw version.

### Notes
- OpenClaw 2026.9.3 requires Node 24.16.0+ or Node 26.1.0+. The add-on continues to use the NodeSource 24.x LTS channel.
- OpenClaw 2026.9.3 introduces breaking SDK changes for plugin authors (execution-policy SDK, approval SDK, SDK aliases, search/directory callbacks) and agent-owned Workshop skills. These do not affect the add-on image itself but may affect custom plugins/skills you develop.
- Back up `/config/clawd` before first start after update.

## [0.7.10.27] - 2026-09-08

### Fixed
- **Dockerfile alignment**: Actually install `openclaw@2026.9.2` (the 0.7.10.26 release only updated `config.yaml` version metadata). Bumped add-on version to 0.7.10.27 so Home Assistant rebuilds the image.

## [0.7.10.26] - 2026-09-08

### Changed
- **OpenClaw**: Intended update to `2026.9.2`.

### Notes
- This release did not update the Dockerfile install line, so the built image still contained OpenClaw 2026.9.1. Superseded by 0.7.10.27 and 0.7.10.28.
- Compatibility note: preserves active settings, enabled skills, and default-agent ownership across Gateway restarts triggered by HA add-on updates.

## 0.7.10.30
- fix(ingress): inject OpenClaw ControlUI base path on <html> tag for 2026.9.4.
  OpenClaw 2026.9.4 no longer ships the empty `data-openclaw-control-ui-base-path` attribute,
  so nginx now adds it explicitly when missing. This fixes "Gateway not reachable 127.0.0.1:18789"
  when loading the dashboard through the HA Ingress iframe.

## 0.7.10.31
- fix(ingress): inject a client-side base-path fallback for OpenClaw 2026.9.4
  when HA Supervisor does not pass X-Ingress-Path (e.g. Companion App iframe).
  The ControlUI now reads `data-openclaw-control-ui-base-path` from the actual
  browser URL instead of falling back to `127.0.0.1:18789`.
