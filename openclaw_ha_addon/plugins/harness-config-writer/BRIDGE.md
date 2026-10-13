# BRIDGE.md — harness-config-writer (Phase 3, Generalisierte Harness-Config)

> **Repo-Split A2 (2026-10-11):** Dieses Modul lebt seit dem A2-Umbau als
> eigenständiges Feature-Plugin `harness-config-writer` (GaRoN-Split-Idee:
> config-writer unabhängig vom acp-dashboard Channel-Plugin). Der
> Config-Key ist ab der Migration
> `plugins.entries['harness-config-writer'].config.harnesses`;
> der Legacy-Key `plugins.entries['acp-dashboard-binding'].config.harnesses`
> wird vom Add-on-Deployment-Helper (oc_acpx_helper.py) einmalig migriert.
> Die Additiv-Garantie und alle Semantiken sind unverändert.

## 15. Phase 3 — Generalisierte Harness-Config (GaRoN 10:37 / Owner-Design 10:37, 2026-10-11)

Plugin-seitige Generierung der Harness-Konfiguration statt des retired
Python-Helpers (`oc_acpx_helper.deploy_harness_configs` /
`prepare_opencode_home` sind seit v0.7.13.16 no-ops mit INFO-Log). Modul:
`src/harness-config-writer.ts` — ein Writer pro Mechanismus, getriggert
idempotent aus `registerFull`.

### 15.1 Surface + ADDITIV-GARANTIE (bindend)

`plugins.entries['harness-config-writer'].config.harnesses` — normalisiert
je Harness:

```jsonc
"harnesses": {
  "<harnessId>": {
    "model": "...",          // Pflicht (non-empty) — bleibt in ALLEN Fällen der Default
    "baseUrl": "...",        // OAI-kompatibel (Ollama/vLLM/LocalAI/llama.cpp)
    "apiKey": "...",         // absent → Helper-Placeholder "ollama"
    "thinking": "...",       // codex: model_reasoning_effort wenn non-empty
    "smallModel": "...",     // opencode small_model / claude SMALL_FAST_MODEL
    "trustProjects": ["/pfad"], // codex: [projects.".."] trust_level=trusted
    "models": ["id1", "id2"] // γ Multi-Model: verfügbare Modelle (§15.10);
                             // absent = Auto-Match über models.providers,
                             // [] = explizites Opt-out
  }
}
```

**ABSENCE = no-op**: Fehlt ein Harness in `harnesses` (oder die Section
ganz / ist leer), schreibt das Plugin für ihn NICHTS — kein mkdir, kein
Write, kein Log-Noise. Der bundled acpx-Default (eigene Auth/Config) greift
unverändert: native Abos (Claude Pro, ChatGPT Plus, Copilot-OAuth) laufen
exakt wie ohne das Plugin ("Vendor auth must already exist on the host").
Das macht Ollama/vLLM/LocalAI/llama.cpp (OpenAI-kompatibel) konfigurierbar,
ohne native Abos zu berühren. Katalog (22 ids, acp-agents quickstart+setup):
`claude, codex, copilot, cursor, droid, fast-agent, gemini, grok-build,
iflow, kilocode, kimi, kiro, mcode, mux, opencode, openclaw, pi, pool,
qoder, qwen, trae, zeroclaw`.

### 15.2 Drei Mechanismen

| Mechanismus | Harnesses | Was der Writer tut |
|---|---|---|
| **A FILE** | `codex` | `auth.json` (OPENAI_API_KEY, 2-Indent-JSON) nach `<STATE>/acpx/codex-home/` — Helper-Semantik: install-if-missing, 0600, **NIE overwrite**; `/config/.codex/config.toml` (acpx-Inheritance-Quelle) generiert: `model`, `model_provider` (generiert `binding_<host>`, NICHT `ollama` — reserviert), `base_url = baseUrl+/v1` (kein Doppel-/v1), `wire_api="responses"`, `requires_openai_auth=true`, `sandbox_mode="workspace-write"`, `model_reasoning_effort` nur bei `thinking`, `[projects."…"] trust_level="trusted"` je trustProjects (dedupe+sort, keine Doppel-Header) — Helper-Semantik verbatim: install-if-missing / upgrade NUR wenn current KEINEN `[model_providers.`-Block trägt / customized **NIE** überschrieben (NOTE) |
| **A FILE** | `opencode` | `opencode.jsonc` (provider-Block: npm `@ai-sdk/openai-compatible`, baseURL baseUrl+/v1, apiKey; `model` + `small_model` als `provider/model`) nach `opencode-home/` UND `/config/opencode/` (beide wie Helper, bytes-sync), legacy `config.toml`-Placeholder in opencode-home neutralisiert (comment-only) |
| **B ENV** | `claude` | `harness-env/claude.env`: `ANTHROPIC_MODEL`/`ANTHROPIC_BASE_URL` (verbatim, KEIN /v1)/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_SMALL_FAST_MODEL` |
| **B ENV** | `gemini` | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GOOGLE_GEMINI_BASE_URL` |
| **B ENV** | `droid` | `FACTORY_API_KEY` (kein Base-URL-Env → Warnung wenn baseUrl gesetzt) |
| **B ENV** | `qwen` | `OPENAI_API_KEY`, `OPENAI_BASE_URL` (baseUrl+/v1), `OPENAI_MODEL` |
| **B ENV** | `kimi` | `KIMI_MODEL_API_KEY`, `KIMI_MODEL_BASE_URL` (baseUrl+/v1), `KIMI_MODEL_NAME` — Kimi Code liest Provider-Credentials NICHT via Shell-Env; die `KIMI_MODEL_*`-Familie ist die einzige Shell-Surface (docs 2026-10-11) |
| **B ENV** | `kiro` | `KIRO_API_KEY` (kein Base-URL-Env → Warnung wenn baseUrl gesetzt) |
| **B ENV** | `iflow` | `IFLOW_API_KEY`, `IFLOW_BASE_URL` (baseUrl+/v1), `IFLOW_modelName` (camelCase-Konvention der iflow-docs) |
| **C NONE** | `copilot`, `cursor` + alle übrigen/ungekatalogisierten ids | Skip — CLI-OAuth-owned, Plugin schreibt nichts; bewusst STUMM (kein Warn-Noise) |

Alle ENV-Namen docs-verifiziert am 2026-10-11 (kimi.com kimi-code env-vars,
kiro.dev authentication, iflow-ai settings.md, qwen-code OPENAI_*).
`deriveProviderId(baseUrl)`: deterministisch aus dem Host
(`http://localhost:11434` → `binding_localhost_11434`) — multi-Backend-safe,
reine `[a-z0-9_]`-ids sind als TOML-Header unquoted safe.

### 15.3 ENV-Verdrahtung (Command-Override, offizieller Mechanismus)

Die env-Dateien werden NICHT ambient exportiert (Plugin kann die Gateway-proc
ENV nicht ändern) — sie werden wrapperartig gesourcet vom acpx-Command-Override
`plugins.entries.acpx.config.agents.<id>.command/args`:

```jsonc
"plugins.entries.acpx.config.agents.claude": {
  "command": "/bin/sh",
  "args": ["-c",
    ". /config/.openclaw/acpx/harness-env/claude.env && exec claude ... <acp-adapter-args>"]
}
```

`exec` ersetzt die Shell, das Adapter-Child erbt die gesetzten Vars. Der
env-Datei-Header trägt einen Hinweis auf diese Verdrahtung + Generierung.
Werte sind sh-safe quoted (single quotes, `'` als `'"'"'`). Dateien mit
Tokens/Keys erhalten 0600.

### 15.4 Trigger + Config-Change (ehrlich)

Deploy am Plugin-Load (`registerFull`), idempotent:
auth.json/config.toml install-if-missing bzw. upgrade-only-no-providers,
jsonc/env bytes-sync. Einen verifizierten config-change-Hook am Host gibt es
NICHT → **Harness-Config-Änderungen gelten beim nächsten Boot**. Deployment-
Fehler sind fail-soft (error-Log, Plugin-Load unberührt). Pfadauflösung via
`resolveOpenClawStateDir`-Ladder (Host: `/config/.openclaw` →
`/config/.codex` + `/config/opencode` — exakt die Helper-Konstanten).

### 15.5 Manifest

`configSchema` um `harnesses` erweitert (Gate-4-Regel; `model` required,
Objekt je Harness mit model/baseUrl/apiKey/thinking/smallModel/trustProjects).

### 15.6 Tests (vitest, src/harness-config-writer.test.ts)

codex fresh/upgraded(no-providers)/custom-preserved(NOTE)/auth-NIE-overwrite;
thinking gesetzt/leer; trust dedupe+sort; opencode beide Dirs + sync-on-diff +
legacy-neutralize + small_model; env je CLI (kimi KIMI_MODEL_*, kiro ohne
Base-URL + Warnung, iflow camelCase), sh-safe quoting, 0600 auf Secret-Files;
ABSENCE=no-op byte-hart (keine Dirs); copilot/cursor/kilocode → mechanism
none ohne Files; vLLM/LocalAI baseUrl-Varianten ohne Doppel-/v1 (TOML+JSONC);
codex/opencode ohne baseUrl → skip mit Warning, kein Write.

### 15.7 Ehrliche Risiken

1. **ENV-Writer braucht Wrapper-Verdrahtung (15.3)**: ohne den
   acpx-Command-Override passiert mit den env-Dateien NICHTS — der Writer
   allein macht qwen/kimi/… nicht backend-fähig. Der Override ist der
   offizielle acpx-Mechanismus, aber die konkret nötigen Adapter-Args je CLI
   sind Host-Konfiguration (User-Aufgabe), nicht Plugin-Aufgabe.
2. **Config-Change ohne Live-Surface** (15.4) — gilt beim nächsten Boot.
3. **Inheritance-Window bei model-Änderungen (codex)**: verbatim-Helper-
   Semantik bedeutet, eine abweichende custom config.toml MIT
   model_providers-Block wird NIE überschrieben — Modells/BaseUrl-Wechsel
   über `harnesses.codex` erreichen solch eine Datei nicht; der NOTE-Log macht
   es sichtbar. Frisch installs/upgrades (ohne Block) übernehmen die config.
4. **auth.json-Ersatz nach OAuth-Migration**: install-if-missing heißt, eine
   existierende auth.json (auch native ChatGPT-Stände) bleibt — wer auf API
   Key wechseln will, trägt apiKey in der config UND löscht die alte
   auth.json (oder löscht die harnesses.codex-Entry — dann greift nativ).
5. env-Namen sind docs-Stand 2026-10-11 (kimi/kiro/iflow CLI-Entwicklung ist
   schnelllebig; kiro hat bewusst KEIN Base-URL-Mapping).
6. **codex [profiles.*] sind NICHT acpx-vererbt** (dist-belegt:
   renderIsolatedCodexConfig/INHERITED_TOP_LEVEL_CODEX_CONFIG_KEYS übernimmt
   nur model/model_provider/model_reasoning_effort/sandbox_mode +
   [model_providers.*]): die γ-Profile nutzen direkte codex-CLI-Nutzer mit
   CODEX_HOME auf /config/.codex/config.toml. Welche Modelle ein ACP-codex-
   Session zur Wahl anbietet, entscheidet codex' `model/list` am app-server
   (leer → Adapter-Fehler) — für Custom-Provider live zu verifizieren.
7. **γ-Signatur-Semantik vs. Legacy/Custom-Files**: nur Dateien mit der
   `# harness-config-writer (generated)`-Erstzeile werden bytes-sync
   aktualisiert. Vor-γ vom Writer generierte (signaturlose) config.toml und
   jede customized Datei mit model_providers-Block bleiben NOTE — ein
   Modelllisten-Refresh erfordert dort einmaliges manuelles Löschen (Doku
   §15.10).
8. **γ-Config-Plumbing-Fix (index.ts)**: der Writer liest jetzt
   `api.pluginConfig` (Fallback-Drill über api.config.plugins.entries) statt
   des bisherigen `api.config.harnesses`-Reads — der war dist-belegt ein
   stiller No-op (api.config = die VOLLE OpenClawConfig). Erster echter
   Writer-Deploy am Host ist daher zu erwarten; bestehende Helper-Shape-Files
   (opencode.jsonc "Ollama (OLLAMA_BASE_URL)") wechseln dann auf Writer-Shape.

### 15.8 Backup-Rewrite (GaRoN 2026-10-11, Helper-seitig)

Make enable/disable fully reversible: das Add-on-Boot-Helper
(oc_acpx_helper.py) sichert beim ERSTEN Enabled-Boot den
Pre-Writer-Zustand der kompletten Write-Surface (`.codex/auth.json`,
`.codex/config.toml`, beide `opencode.jsonc`, legacy
`opencode-home/config.toml`, `harness-env/<id>.env`) in
`/config/.openclaw/harness-config-writer-backup/manifest.json` (base64 im
Manifest, atomar temp+rename). Snapshot läuft VOR dem Gateway-Start — er
kann aus prinzipiellen Gründen nie Writer-generierten Content einfangen.
- Schaltet der Operator die Option wieder OFF, spielt der Helper den
  Snapshot zurück (existierende Files bytegenau + Mode, Writer-alleinige
  Files gelöscht) und verbraucht ihn; das nächste Re-Enabled nimmt einen
  FRISCHEN Snapshot (Zustand nach Restore).
- Canonical env-Id-Liste im Helper (HARNESS_WRITER_ENV_IDS) = TS-Sync-Regel
  mit ENV_MECHANISM (dieselbe Konvention wie dieresolveOpenClawStateDir
  Doppel-Copy). Zusätzliche, bereits existente `*.env` in harness-env/ werden
  MIT gesichert (nur existierende).
- Defense: Restore touched nur Pfade unter den verwalteten Roots
  (acpx/, .codex/, opencode/) — Manifest-Pfade draußen werden geskippt.
- Fail-soft: korruptes Manifest → WARN + wegwerfen; Fehler beim Restore →
  Snapshot bleibt, nächster Boot retryt. Fehler beim Backup → kein Manifest,
  nächster Boot retryt (Writer läuft trotzdem — die Write-Semantik selbst
  [install-if-missing / customized never overwritten] bleibt ja bestehen;
  der Backup ist die ROLLBACK-Extra-Absicherung).

Limitierung (ehrlich): der Snapshot ist der FIRST-ENABLE-Stand. Ändert der
Operator danach eigenes Config (custom config.toml o.ä.) und schaltet DANN
off, wird der FIRST-Stand wiederhergestellt — die spätere eigene Änderung
ließe sich nicht vom Writer-Output unterscheiden (Writer schreibt custom
Files eh nie an). Für den Anwendungsfall "Writer ausprobiert, dann
Originalzustand zurück" ist das exakt das gefragte Verhalten.

**Beilage (Audit B2, 2026-10-11): ENV-Gate am Entry.** Der Writer triggert
NUR, wenn die Add-on-Option ihn aktiviert: `HARNESS_CONFIG_WRITER_ENABLED`
explizit truthy/false gewinnt; leer/unset folgt `ACP_DASHBOARD_BINDING_ENABLED`
(Spiegel des Helper `_env_flag` inkl. "unset = follow", run.sh exportiert
beide ENVs an den Gateway-Prozess). Gate OFF am Load → INFO "inactive by env
gate — no write": der Helper-Restore bleibt dauerhaft wirksam (die 4
Discovery-Gates payload/entries/load.paths/allow bleiben absichtlich aktiv,
damit ein Re-Enable KEIN Rebuild braucht). Manual-Deploy des Plugins ohne
beide ENVs (nicht über den Add-on-Boot) bleibt dadurch inaktiv. Entry-Level-Tests:
`index.test.ts` (Gate-Tabelle + Write/No-Write je Kombination, fs-verifiziert).

### 15.9 Add-on-Level-Harness-Defaults (GaRoN 2026-10-11, Helper-seitig)

Einfache Add-on-Optionen statt nur openclaw.json-Hand-Editing (GaRos
Anforderung: "eine Konfiguration jeweils für BASE_URL, MODEL, etc. und eine
Zeile zum Excluden, kommagetrennt"):

- `harness_base_url` — AKTIVATOR (leer = kein Eintrag wird generiert,
  ADDITIV bleibt).
- `harness_model` — geteilt über alle nicht-excluded Harnesses; codex/
  opencode übernehmen base_url/api_key ebenso, behalten aber ihre
  dedizierten Modell-Zeilen (`ollama_acp_codex_model` /
  `ollama_acp_opencode_model`), solange `harness_model` leer ist.
- `harness_api_key` — geteilt (im options.json Klartext — gleiches Threat-
  Modell wie das homeassistant_token).
- `harness_excluded_agents` — Kommazeile von Harness-Ids
  (z.B. "codex,opencode"), die KEINEN generierten Entry bekommen.

Merge-Semantik (oc_acpx_helper.py merge_addon_harness_defaults, idempotent
jeder Writer-Enabled-Boot, env: HARNESS_WRITER_*):
- Entry fehlt → generiert.  Operator-Handeintrag → UNBERÜHRT.
- Vorher generiert + unverändert → von Optionen aktualisiert/gelöscht
  (Refresh/Stale-Cleanup, geführt im Buch-File
  CONFIG_DIR/harness-config-writer/managed-defaults.json, 0600/0700 — kann
  apiKey halten).
- Vorher generiert + vom Operator geändert → bleibt + WARN (Ownership
  übernommen, we never guess).
- ENV-IDs ohne Modellvorgabe → bewusst NICHT generiert (unbrauchbare
  "nur-baseUrl"-Entries vermeiden: z.B. ANTHROPIC_BASE_URL ohne ANTHROPIC_
  MODEL routet den Vendor-Default gegen den falschen Host).

TS-Plugin-Konsum unverändert (config.harnesses → Mechanismen A/B/C).

**Aufnahme-Kriterium (GaRoN 2026-10-11, bindend):** ein Harness kommt nur in
KNOWN_WRITER_HARNESS_IDS, wenn (a) sein Konfig-Surface (env-Namen bzw.
Datei-Semantik) docs-verifiziert ist UND (b) KEIN OAuth/Vendor-Login nötig
ist — der Writer kann configs/env eintragen, aber keine Vendor-Auth
erzeugen. Deshalb draußen: cursor/copilot/kilocode (OAuth), pi/mux/
qoder/fast-agent/trae (env nicht verifiziert — Nachzug sobald dokumentiert),
openclaw (Gateway selbst).

## 15.10 Multi-Model aus `api.config.models.providers` (γ, 2026-10-13, Owner-Briefing)

Owner-Frage: "alle verfügbaren Modelle eintragen, das Add-on-Config-Modell nur
als Default". Der Writer reichert je Entry die VERFÜGBAREN Modelle an und
schreibt sie aufs Harness-optimale Surface (`model` bleibt in ALLEN Fällen der
Default-Modell-Eintrag):

| Harness | Multi-Model-Surface | Herkunft |
|---|---|---|
| opencode | `provider.models`-Map (alle Ids, default `model` zuerst; smallModel-Zusatz nur bei differenter Liste) | native Surface |
| codex | `[profiles."<id>"]` in der Source-config.toml (je Block `model` + `model_provider` [+ `model_reasoning_effort` bei thinking]) — **nicht acpx-vererbt**, nutzt direkte codex-CLI-Nutzer; ACP-Session-Modellwahl entscheidet codex `model/list` | native Surface, Inheritance-Caveat im Header |
| claude | `CLAUDE_MODEL_CONFIG` ENV = JSON `{ "availableModels": [...] }` — dist-belegt (claude-agent-acp `parseModelConfig`); Default läuft via ANTHROPIC_MODEL (Adapter-Priorität 1.) | ENV via Command-Override (§15.3) |
| übrige ENV (gemini/droid/qwen/kimi/kiro/iflow) | INFORMATIONAL-Kommentar-Block in der .env (`# - <id>`, cap 25, `(+N more)`) | keine Multi-Model-ENV-Surface docs-verifiziert |
| Mechanismus C (copilot/cursor/…) | NICHTS | OAuth-owned, bewusst stumm |

**Modell-Auflösung** (`resolveEntryModels`):
1. `entry.models` explicit non-empty → gewinnt (Ownership "never guess").
2. `entry.models: []` → explizites OPT-OUT (kein models-Surface).
3. absent → Auto-Matching: `api.config.models.providers[*].models[].id` des
   Providers, dessen `baseUrl` (normalisiert: trailing `/`+`/v1` stripped,
   Host lowercased) zur Entry-baseUrl passt; Union bei Mehrfach-Providern.
4. kein Match → `source: "none"` — models-Surface ABWESEND (keine
   Regression gegen den Vor-γ-Stand; Default läuft weiter über top-level).

`entry.model` wird bei explicit/matched an Position 0 PREPENDET, wenn
fehlend (claude-Adapter-Fallback ist models[0]). Fail-soft: invalid
`models` (kein Array/Items) → Warning + Fallback auf Auto-Match, Entry wird
NIEMALS deswegen geskippt. Dedupe first-occurrence (Reihenfolge = kuratiert),
Cap MAX_MODELS=200 (echte Surfaces) / COMMENT_MODEL_CAP=25 (env-Kommentare).

**Self-Recognition-Signatur** (`CODEX_SIGNATURE_LINE`,
`# harness-config-writer (generated)`): jede writer-generierte config.toml
trägt die Erstzeile; `upgradeOrNoteIfMissingOrDiffers` updatet NUR signatur-
makierte Dateien bytes-genau (Modelllisten-Änderungen wirken!), signaturlose
customized Dateien bleiben NOTE. One-time-Migration: vor-γ writer-generierte
config.toml einmal manuell löschen, damit der aktuelle Stand mit Signatur
installs; die aktuelle Live-Datei des Owners (garon_ollama, customized) bleibt
bewusst unangetastet.

**Config-Zufuhr-Fix (index.ts `resolvePluginConfig`)**: erst
`api.pluginConfig` (dist: validatedConfig.value), Fallback-Drill
`api.config.plugins.entries['harness-config-writer'].config` (Pattern
agent-map.ts resolvePluginEntryConfig); beurteilt allein am non-empty
`harnesses`-Inhalt (Absence = no-op bleibt). Katalog-Bau ist fail-soft
(`buildModelCatalog`): garbage `models.providers` → leere Map + Warning,
nie ein Crash.

Helper-Interaktion (§15.9): der Python-Helper generiert KEINE models-Felder
(in-memory Enrichment ist TS-Plugin-only) — helper-generierte Entries bleiben
byte-stabil. Operator-Einträge mit hand-geschriebenem `models`-Array
differieren vom managed-Buch → Ownership "operator-owned, untouched" (bewusst:
Wer kuratiert, übernimmt den Entry komplett).

Flaggschiff-Defaults (Add-on-level, `ollama_acp_*_model`): codex/opencode
existierten bereits; γ ergänzt `ollama_acp_claude_model` → run.sh export
`OLLAMA_CLAUDE_MODEL` (ambient ANTHROPIC_MODEL-Ladder synchron:
Option → legacy `OLLAMA_ACP_MODEL` → Default `glm-5.3-flash:cloud`) +
helper `_writer_model_for` claude-Ladder (dieselbe Reihenfolge). Netto-Ver-
änderung für Bestands-Setups: base_url-aktivierte Deployments generieren ab
γ einen claude-Entry by Default (CHANGELOG-Nota; Ausschluss via
harness_excluded_agents bzw. Operator-Ownership).
