/**
 * Phase 3 (generalisierte Harness-Config, GaRoN 10:37 / Owner-Design 10:37,
 * 2026-10-11): generiert je nach Harness die native Konfiguration für lokale
 * bzw. OpenAI-kompatible Backends (Ollama/vLLM/LocalAI/llama.cpp) aus der
 * normalisierten Section
 *
 *   plugins.entries['harness-config-writer'].config.harnesses
 *     = { <harnessId>: { model, baseUrl?, apiKey?, thinking?, smallModel?,
 *                        trustProjects?, models? } }
 *
 * Multi-Model (γ, 2026-10-13, Owner-Briefing): zusätzlich zum Default-Modell
 * (`model` — bleibt in ALLEN Fällen der Default) schreibt der Writer die
 * VERFÜGBAREN Modelle je nach Surface:
 *   - opencode : provider.models-Map (native Multi-Model-Surface)
 *   - codex    : [profiles."<id>"]-Blöcke in der Source-config.toml — Caveat:
 *                renderIsolatedCodexConfig vererbt KEINE Profiles (nur
 *                model/model_provider/model_reasoning_effort/sandbox_mode +
 *                [model_providers.*], acpx-dist verifiziert); Profile nutzen
 *                direkte codex-CLI-Nutzer mit CODEX_HOME auf dieser Datei.
 *   - claude   : CLAUDE_MODEL_CONFIG ENV (claude-agent-acp-dist-belegt:
 *                JSON { availableModels: [...] }).
 *   - übrige ENV-Harnesses : Kommentar-Block (informational, keine
 *                Multi-Model-Surface).
 * `models`-Präzedenz: explizite Entry-Liste (non-empty) gewinnt über
 * Auto-Matching aus `api.config.models.providers` (baseUrl-Match); `[]`
 * = Opt-out; abwesig = Auto-Matching. Details: BRIDGE.md §15.10.
 *
 * Multi-Model γ.1 (2026-10-13): codex Modell-Metadaten-Katalog — die
 * Operator-Metadaten aus `models.providers[*].models[*].contextWindow`
 * wandern in /config/.codex/model-catalog.json und die config.toml tragt
 * `model_catalog_json` (key-Verifizierung am DEPLOYED binary: `codex debug
 * models` parsed die Datei, Custom-Slugs haben echte Metadaten statt
 * Fallback-Warnung). Caveat: ersetzt den built-in Katalog; acpx vererbt den
 * key NICHT → nur direkte CLI-Nutzer (BRIDGE §15.10).
 *
 * ADDITIV-GARANTIE (bindend): das Plugin ist ein Add-on zum bundled acpx,
 * kein Ersatz. Fehlt ein Harness in `harnesses` (oder die Section ganz),
 * wird für ihn NICHTS geschrieben — native Abos (Claude Pro, ChatGPT Plus,
 * Copilot-OAuth, …) laufen identisch zum acpx-Default über die eigene
 * Vendor-Auth ("Vendor auth must already exist on the host").
 *
 * Drei Mechanismen (Katalog: acpx SKILL.md §"Harness aliases" 199ff + docs
 * acp-agents/quickstart+setup, 10:37 live-gefetched):
 *   A FILE : codex   → CODEX_HOME auth.json + /config/.codex/config.toml
 *                      (die acpx-Inheritance-Quelle; Semantik VERBATIM aus
 *                      oc_acpx_helper.py deploy_harness_configs) + Multi-Model
 *                      via [profiles.*] (Caveat above)
 *            opencode → opencode.jsonc nach opencode-home/ UND /config/opencode/
 *                      (beide wie der Helper) + legacy config.toml neutralisiert
 *                      + Multi-Model via provider.models-Map
 *   B ENV  : claude (ANTHROPIC_* + CLAUDE_MODEL_CONFIG), gemini (GEMINI_*),
 *            droid (FACTORY_API_KEY), qwen (OPENAI_*), kimi (KIMI_MODEL_*),
 *            kiro (KIRO_API_KEY), iflow (IFLOW_*) — je eine env-Datei pro
 *            Harness (harness-env/<id>.env), gesourcet vom acpx-Command-
 *            Override plugins.entries.acpx.config.agents.<id>.command/args
 *            (BRIDGE.md §15). Alle ENV-Namen docs-verifiziert (2026-10-11).
 *   C NONE : copilot/cursor und alle übrigen CLI-OAuth-owned Harnesses —
 *            Skip, das Plugin schreibt für sie nichts.
 *
 * Deployment-Trigger: registerFull (Plugin-Load, idempotent — alle Writer
 * sind install-if-missing bzw. bytes-sync, Helper-Semantik). Es gibt keinen
 * verifizierten config-change-Hook am Host: Harness-Config-Änderungen
 * GELTEN BEIM NÄCHSTEN BOOT (BRIDGE.md §15.4, ehrlich dokumentiert).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// Repo-Split A2 (2026-10-11): resolveOpenClawStateDir lebt hier als EIGENE
// Kopie (origin: acp-dashboard-binding/src/agent-map.ts, Byte-identisch).
// Absichtlich dupliziert statt Cross-Import — die beiden Plugins sind
// unabhängig pflegbar (GaRoN-Split-Idee); Änderungen an der ENV-Ladder
// müssen in BEIDEN Kopien synchron gezogen werden (dieselbe
// acpx/agent-maps-ENV-Konvention, origin Doku: agent-map.ts).
function resolveOpenClawStateDir(env?: Record<string, string | undefined>): string | null {
  const e = env ?? (typeof process !== "undefined" ? process.env : undefined) ?? {};
  const stateDir = typeof e.OPENCLAW_STATE_DIR === "string" ? e.OPENCLAW_STATE_DIR.trim() : "";
  if (stateDir) return stateDir;
  const configDir = typeof e.OPENCLAW_CONFIG_DIR === "string" ? e.OPENCLAW_CONFIG_DIR.trim() : "";
  if (configDir) return configDir;
  const configPath = typeof e.OPENCLAW_CONFIG_PATH === "string" ? e.OPENCLAW_CONFIG_PATH.trim() : "";
  if (configPath) {
    const dir = configPath.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
    if (dir) return dir;
  }
  const xdg = typeof e.XDG_CONFIG_HOME === "string" ? e.XDG_CONFIG_HOME.trim() : "";
  if (xdg) return `${xdg.replace(/\/+$/, "")}/.openclaw`;
  const home = typeof e.HOME === "string" ? e.HOME.trim() : "";
  if (home) return `${home.replace(/\/+$/, "")}/.openclaw`;
  return null;
}

/** Normalisierter per-Harness-Eintrag (configSchema: `harnesses.<id>`). */
export type HarnessConfigEntry = {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  thinking?: string;
  smallModel?: string;
  trustProjects?: string[];
  /**
   * Verfügbare Modelle (Multi-Model γ): aufgelöste, normalisierte Liste.
   * Präzedenz: explizite Entry-Liste (non-empty) > Auto-Matching über
   * `api.config.models.providers` (baseUrl-Match) > absent. `entry.model`
   * bleibt der Default (prepend wenn fehlend, bei explicit/matched).
   */
  models?: string[];
};

/** plugins.entries['harness-config-writer'].config.harnesses (roh geparsed). */
export type HarnessConfigs = Record<string, HarnessConfigEntry>;

// Multi-Model Caps (γ): echte Surfaces (opencode models-Map, codex profiles,
// claude availableModels-JSON) cappen auf MAX_MODELS; ENV-Kommentar-Listen auf
// COMMENT_MODEL_CAP (keine 200-zeiligen env-Dateien).
export const MAX_MODELS = 200;
export const COMMENT_MODEL_CAP = 25;

/**
 * Self-Recognition-Signatur (γ): writer-generierte codex config.toml tragen
 * diese erste Zeile; upgradeOrNoteIfMissingOrDiffers updatet nur Dateien MIT
 * dieser Signatur bytes-genau — signaturlose (operator-/legacy-) Dateien mit
 * [model_providers.-Block bleiben "customized, never overwritten" (NOTE).
 */
export const CODEX_SIGNATURE_LINE = "# harness-config-writer (generated)";

/** Zielwurzel-Layout, identisch zu den Helper-Konstanten (oc_acpx_helper.py). */
export type HarnessWriterPaths = {
  /** <STATE>/acpx — Parent von codex-home/, opencode-home/, harness-env/ */
  acpxDir: string;
  /** Parent/state-dir/.codex — die acpx-Inheritance-Quelle (config.toml). */
  codexSourceHome: string;
  /** Parent/state-dir/opencode — OpenCode global config dir. */
  opencodeGlobalDir: string;
};

export type HarnessMechanism = "file-codex" | "file-opencode" | "env" | "none";

export type HarnessDeployFile = {
  path: string;
  action: "created" | "updated" | "unchanged" | "note (customized, left intact)";
};

export type HarnessDeployResult = {
  harnessId: string;
  mechanism: HarnessMechanism;
  warnings: string[];
  files: HarnessDeployFile[];
  /** Multi-Model γ: Quellkennung der verwendeten Modellliste (explicit/matched/none). */
  modelsSource?: ResolvedModelsSource;
};

export type HarnessDeployReport = {
  results: HarnessDeployResult[];
  /** true → die Section fehlt/ist leer: NICHTS wurde angefasst. */
  skipped: boolean;
};

/** Fail-soft Logger-Shape (api.logger Projection wie sonst im Plugin). */
export type HarnessWriterLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

// ---------------------------------------------------------------------------
// Pfadauflösung — dieselbe ENV-Ladder wie acp-dashboard-binding/agent-map
// (Repo-Split A2: EIGENE Kopie oben, kein Cross-Import — beide Plugins
// unabhängig pflegbar).
// Auf dem Host ist STATE /config/.openclaw → codexSourceHome /config/.codex,
// opencodeGlobalDir /config/opencode — exakt die Helper-Konstanten
// CODEX_SOURCE_HOME / OPENCODE_GLOBAL_DIR (oc_acpx_helper.py:35-48).
// ---------------------------------------------------------------------------

export function resolveHarnessWriterPaths(
  env?: Record<string, string | undefined>,
): HarnessWriterPaths | null {
  const stateDir = resolveOpenClawStateDir(env);
  if (!stateDir) return null;
  const state = stateDir.replace(/\/+$/, "");
  const parent = dirname(state);
  return {
    acpxDir: `${state}/acpx`,
    codexSourceHome: `${parent}/.codex`,
    opencodeGlobalDir: `${parent}/opencode`,
  };
}

// ---------------------------------------------------------------------------
// Datei-Primitive (Helper-Semantik, atomar wie helper.write_json:
// temp+rename — ein Crash mid-write darf nie eine halb geschriebene Datei
// hinterlassen).
// ---------------------------------------------------------------------------

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) {
      try {
        rmSync(tmp);
      } catch (error) {
        // Fail-soft wie der Helper except-branch (orphaned .tmp ist harmlos).
        void error;
      }
    }
  }
}

type FileAction = HarnessDeployFile["action"];

/** install-if-missing + bytes-sync (helper prepare_opencode_home-Semantik). */
function writeFileIfMissingOrDiffers(path: string, content: string): FileAction {
  const exists = existsSync(path);
  const current = exists ? tryOr(() => readFileSync(path, "utf-8"), null) : null;
  if (current === content) {
    return "unchanged";
  }
  atomicWrite(path, content);
  return exists ? "updated" : "created";
}

/**
 * codex config.toml-Semantik VERBATIM (helper deploy_harness_configs) +
 * Self-Recognition (γ): Dateien MIT `CODEX_SIGNATURE_LINE`-Erstzeile sind
 * nachweislich writer-generiert und werden bytes-genau geupdatet — nur so
 * wirken Modelllisten-Änderungen über den [model_providers.-Block hinaus,
 * der den heutigen NOTE-Zweig sonst einfrieren würde (BRIDGE.md §15.10).
 * Signaturlose Dateien MIT [model_providers.-Block bleiben customized (NOTE).
 */
function upgradeOrNoteIfMissingOrDiffers(path: string, desired: string): FileAction {
  if (!existsSync(path)) {
    atomicWrite(path, desired);
    return "created";
  }
  const current = tryOr(() => readFileSync(path, "utf-8"), null);
  if (current === desired) return "unchanged";
  if (current !== null && current.startsWith(CODEX_SIGNATURE_LINE)) {
    atomicWrite(path, desired);
    return "updated";
  }
  if (current !== null && current.includes("[model_providers.")) {
    return "note (customized, left intact)";
  }
  atomicWrite(path, desired);
  return "updated";
}

/** codex auth.json chmod 0600 (Helper try/except WARN-Pattern). */
function chmod0600(path: string, warnings: string[]): void {
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    warnings.push(`could not chmod ${path} 0600: ${briefError(error)}`);
  }
}

function briefError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tryOr<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Shared String-Helper
// ---------------------------------------------------------------------------

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * baseUrl → OAI-kompatible Base: `/v1` angehängt, KEIN Doppel-Suffix wenn
 * baseUrl ihn schon trägt (vLLM/LocalAI-Varianten wie http://host:8000/v1).
 * Abschließende Slashes neutralisiert.
 */
export function withV1Suffix(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * Deterministischer generierter provider-Name aus der baseUrl-host. NICHT
 * "ollama" — bei @openclaw/codex ist die id "ollama" reserviert
 * (.codex-source/config.toml Template-Kommentar verbatim: 'hence
 * "garon_ollama"'). Beispiel: http://localhost:11434 → binding_localhost_11434;
 * https://vllm.lan:8000 → binding_vllm_lan_8000. Reine [a-z0-9_] ids sind als
 * TOML-Header unquoted safe (keine Doppel-Header: dedupe+sort der trusts).
 */
export function deriveProviderId(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl.includes("://") ? baseUrl : `http://${baseUrl}`).host;
  } catch {
    host = baseUrl;
  }
  const sanitized = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `binding_${sanitized || "backend"}`;
}

/** TOML basic string — JSON-Escaping ist TOML-kompatibel (\", \\, \n, \uXXXX). */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Multi-Model (γ) — Modellkatalog aus der vollen Gateway-Config + Entry-
// Auflösung. Die Writer (buildCodexConfigToml / buildOpencodeConfigJsonc /
// ENV_MECHANISM / deployHarnessEnvFile) bleiben reine Entry-Konsumenten; der
// Dispatcher ist der EINZIGE Ort, der Enrichment + Warnings orchestriert.
// ---------------------------------------------------------------------------

export type ModelCatalog = {
  /** normalisierte baseUrl → deduped model-ids (first-occurrence, kuratiert). */
  byBaseUrl: Map<string, string[]>;
  /**
   * γ.1 codex-Metadaten: model-id → vom Operator in openclaw.json gepflegte
   * Werte (contextWindow/maxTokens). NUR belegte Werte landen hier — der
   * Writer rät niemals ein Kontextfenster (Ownership-Regel).
   */
  metaById: Map<string, ModelMeta>;
};

/** Operator-gepflegte Modell-Metadaten aus `models.providers[*].models[*]`. */
export type ModelMeta = {
  contextWindow?: number;
  maxTokens?: number;
};

export type ResolvedModelsSource = "explicit" | "matched" | "none";

export type ResolvedModels = {
  models: string[];
  source: ResolvedModelsSource;
  warnings: string[];
};

/**
 * Match-Ebene für baseUrl: trailing Slashes + trailing "/v1" neutralisiert,
 * Host lowercased, Pfad erhalten (deriveProviderId-Catch-Pattern für
 * scheme-lose Input). http://Host:PORT/path ↔ https-Varianten matchen bewusst
 * über Host:PORT — der Gateway-Catalog schreibt dieselbe baseUrl wie die
 * Harness-Entry, nur Normalisierung, keine Content-Transformation.
 */
export function normalizeBaseUrlForMatch(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "").replace(/\/+$/, "");
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.protocol}//${url.host.toLowerCase()}${path}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

/** dedupe first-occurrence — Operator-/Katalog-Reihenfolge bleibt kuratiert. */
function dedupeModelIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** Auf Cap zuschneiden (vor Cap-Größe melden). */
function capModelIds(ids: string[], max: number): { ids: string[]; dropped: number } {
  if (ids.length <= max) return { ids, dropped: 0 };
  return { ids: ids.slice(0, max), dropped: ids.length - max };
}

type NormalizedModelList = {
  ids: string[];
  /** `models: []` = explizites Opt-out ("bewusst nichts", nicht "nicht gesagt"). */
  explicitEmpty: boolean;
};

/**
 * Entry-`models` fail-soft validieren: nicht-Array → Warning + null-Fall
 * (Fallback auf Matched/None — ein kaputtes models-Feld tötet NIEMALS den
 * Default-Model-Deploy); leere Items werden gefiltert; dedupe + Cap 200.
 */
function normalizeModelListInternal(
  raw: unknown,
  warnings: string[],
  label: string,
): NormalizedModelList | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) {
    warnings.push(`${label} models ignored (must be array of non-empty strings)`);
    return { ids: [], explicitEmpty: false };
  }
  if (raw.length === 0) {
    return { ids: [], explicitEmpty: true };
  }
  const invalidBefore = raw.length;
  let ids = dedupeModelIds(
    raw.filter((m): m is string => typeof m === "string" && m.trim().length > 0).map((m) => m.trim()),
  );
  const dropped = invalidBefore - ids.length;
  if (dropped > 0) {
    warnings.push(`${label} models: ${dropped} invalid ids dropped`);
  }
  const capped = capModelIds(ids, MAX_MODELS);
  ids = capped.ids;
  if (capped.dropped > 0) {
    warnings.push(`${label} models capped at ${MAX_MODELS} (${capped.dropped} dropped)`);
  }
  return { ids, explicitEmpty: false };
}

/**
 * Modellkatalog aus der vollen Gateway-Config (`api.config.models.providers`):
 * je Provider `baseUrl` + `models[].id` (+ `contextWindow`/`maxTokens` für
 * γ.1 codex-Metadaten). Fail-soft — garbage Config ergibt einen leeren
 * Katalog + Sammel-Warning, nie einen Crash. Provider-Keys sortiert
 * (deterministische Merge-Order), ids first-occurrence-deduped; metaById
 * first-occurrence (kollidierende Provider-Settings entscheiden die erste,
 * sortiert ermittelte Provider — bewusst, dokumentiert in BRIDGE §15.10).
 */
export function buildModelCatalog(fullConfig: unknown, warnings: string[]): ModelCatalog {
  const byBaseUrl = new Map<string, string[]>();
  const metaById = new Map<string, ModelMeta>();
  try {
    const models = typeof fullConfig === "object" && fullConfig !== null
      ? (fullConfig as Record<string, unknown>).models
      : undefined;
    const providers =
      typeof models === "object" && models !== null
        ? (models as Record<string, unknown>).providers
        : undefined;
    if (providers === null || providers === undefined) {
      return { byBaseUrl, metaById };
    }
    if (typeof providers !== "object" || Array.isArray(providers)) {
      warnings.push("models.providers: unexpected shape (object expected) — catalog skipped");
      return { byBaseUrl, metaById };
    }
    let malformed = 0;
    for (const key of Object.keys(providers).sort()) {
      const provider = (providers as Record<string, unknown>)[key];
      if (typeof provider !== "object" || provider === null) {
        malformed += 1;
        continue;
      }
      const p = provider as Record<string, unknown>;
      const baseUrl = typeof p.baseUrl === "string" ? p.baseUrl.trim() : "";
      const rawModels = p.models;
      if (!baseUrl || !Array.isArray(rawModels)) {
        malformed += 1;
        continue;
      }
      const normalized = normalizeBaseUrlForMatch(baseUrl);
      if (!normalized) {
        malformed += 1;
        continue;
      }
      // γ.1 Metadaten: nur positive Zahlen zählen (contextWindow/maxTokens).
      for (const m of rawModels) {
        if (typeof m !== "object" || m === null) continue;
        const rec = m as Record<string, unknown>;
        const id = typeof rec.id === "string" ? rec.id.trim() : "";
        if (!id || metaById.has(id)) continue;
        const meta: ModelMeta = {};
        if (typeof rec.contextWindow === "number" && rec.contextWindow > 0) {
          meta.contextWindow = rec.contextWindow;
        }
        if (typeof rec.maxTokens === "number" && rec.maxTokens > 0) {
          meta.maxTokens = rec.maxTokens;
        }
        if (meta.contextWindow !== undefined || meta.maxTokens !== undefined) {
          metaById.set(id, meta);
        }
      }
      const ids = dedupeModelIds(
        rawModels
          .map((m) => (typeof m === "object" && m !== null ? (m as Record<string, unknown>).id : m))
          .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
          .map((id) => id.trim()),
      );
      const merged = capModelIds(
        dedupeModelIds([...(byBaseUrl.get(normalized) ?? []), ...ids]),
        MAX_MODELS,
      );
      if (merged.dropped > 0) {
        warnings.push(
          `model catalog (${normalized}): capped at ${MAX_MODELS} (${merged.dropped} dropped)`,
        );
      }
      byBaseUrl.set(normalized, merged.ids);
    }
    if (malformed > 0) {
      warnings.push(`models.providers: skipped ${malformed} malformed entries`);
    }
  } catch (error) {
    warnings.push(`model catalog build failed (fail-soft): ${briefError(error)}`);
  }
  return { byBaseUrl, metaById };
}

/** Default-prepend (claude-Adapter: models[0] = Fallback-Default). */
function prependDefaultModel(entry: HarnessConfigEntry, ids: string[]): string[] {
  const defaultModel = entry.model?.trim() ?? "";
  if (!defaultModel || ids.includes(defaultModel)) return ids;
  return [defaultModel, ...ids];
}

/**
 * Entry-Modell-Auflösung (Multi-Model γ): explizite Entry-Liste gewinnt über
 * Auto-Matching (catalog.byBaseUrl über normalisierte baseUrl); `models: []`
 * = explizites Opt-out; abwesig + kein Katalogmatch → none. `entry.model`
 * bleibt der Default und wird (falls fehlend) an Position 0 prependet, NUR bei
 * explicit/matched — bei "none" bleibt die models-Surface ABWESEND, weil der
 * Adapter-Fallback models[0] sonst eine single-Modell-Allowlist suggerieren
 * würde (Default läuft weiterhin über `model`/ANTHROPIC_MODEL).
 */
export function resolveEntryModels(
  entry: HarnessConfigEntry,
  catalog: ModelCatalog | null,
): ResolvedModels {
  const warnings: string[] = [];
  // Bewusst als raw gelesen: invalid shapes fliegen nicht (fail-soft), der
  // Caller bekommt die Warning und der Entry bleibt lebenstüchtig.
  const rawEntry = entry as { models?: unknown };
  const explicit = normalizeModelListInternal(rawEntry.models, warnings, "entry");
  if (explicit?.explicitEmpty) {
    return { models: [], source: "none", warnings };
  }
  if (explicit !== null && explicit.ids.length > 0) {
    const withDefault = prependDefaultModel(entry, explicit.ids);
    const capped = capModelIds(withDefault, MAX_MODELS);
    if (capped.dropped > 0) {
      warnings.push(`models capped at ${MAX_MODELS} (${capped.dropped} dropped)`);
    }
    return { models: capped.ids, source: "explicit", warnings };
  }
  if (explicit !== null && explicit.ids.length === 0) {
    // non-empty gewollt, aber alle Items invalid → Fallback auf matched/none
    // (Warning trägt den Befund; der Default-Deploy bleibt unberührt).
    warnings.push("entry models resolved to nothing — falling back to catalog match");
  }
  let matched: string[] = [];
  if (catalog !== null) {
    const key = normalizeBaseUrlForMatch(entry.baseUrl ?? "");
    matched = catalog.byBaseUrl.get(key) ?? [];
  }
  if (matched.length === 0) {
    return { models: [], source: "none", warnings };
  }
  const withDefault = prependDefaultModel(entry, matched);
  const capped = capModelIds(withDefault, MAX_MODELS);
  if (capped.dropped > 0) {
    warnings.push(`models capped at ${MAX_MODELS} (${capped.dropped} dropped)`);
  }
  return { models: capped.ids, source: "matched", warnings };
}

// ---------------------------------------------------------------------------
// Mechanismus B — ENV-Mapping je CLI (alle Namen docs-verifiziert 2026-10-11).
// ---------------------------------------------------------------------------

type EnvMappingResult = { vars: Record<string, string>; warnings: string[] };

function envMapping(
  pairs: readonly (readonly [string, string | undefined])[],
  warnings: readonly string[] = [],
): EnvMappingResult | null {
  const vars: Record<string, string> = {};
  for (const [key, value] of pairs) {
    if (value === undefined) continue;
    vars[key] = value;
  }
  return Object.keys(vars).length > 0 ? { vars, warnings: [...warnings] } : null;
}

/**
 * Mechanismus B — je CLI:
 * - claude : ANTHROPIC_MODEL/BASE_URL/AUTH_TOKEN (+ ANTHROPIC_SMALL_FAST_MODEL
 *            für smallModel). BASE_URL verbatim — die Anthropic-API ist Root,
 *            kein /v1-Suffix (Helper-Doku: "claude ANTHROPIC_*" ambient env).
 *            Multi-Model γ: CLAUDE_MODEL_CONFIG = JSON { availableModels } —
 *            Surface dist-belegt (claude-agent-acp parseModelConfig).
 * - gemini : GEMINI_API_KEY, GEMINI_MODEL, GOOGLE_GEMINI_BASE_URL (Root, vgl.
 *            gemini-cli / Cloudflare AI Gateway docs).
 * - droid  : FACTORY_API_KEY — kein docs-verifizierter Base-URL-Env ⇒ Warnung
 *            wenn baseUrl gesetzt.
 * - qwen   : qwen-code liest OPENAI_* (openai-compatible provider) ⇒ /v1.
 * - kimi   : Kimi Code CLI liest Provider-Credentials NICHT aus der Shell —
 *            einzige Shell-Env-Surface ist die KIMI_MODEL_*-Familie
 *            (KIMI_MODEL_NAME/API_KEY/BASE_URL). BASE_URL-Schema analog
 *            KIMI_BASE_URL default (…/v1) ⇒ /v1.
 * - kiro   : KIRO_API_KEY (ksk_…) — kein Base-URL-Env ⇒ baseUrl-Warnung.
 * - iflow  : IFLOW_API_KEY/IFLOW_BASE_URL (openai-compatible ⇒ /v1) +
 *            IFLOW_modelName (iflow-cli docs: camelCase "recommended").
 */
const ENV_MECHANISM: Record<
  string,
  (entry: HarnessConfigEntry) => EnvMappingResult | null
> = {
  claude: (e) =>
    envMapping([
      ["ANTHROPIC_MODEL", nonEmpty(e.model)],
      ["ANTHROPIC_BASE_URL", nonEmpty(e.baseUrl)],
      ["ANTHROPIC_AUTH_TOKEN", nonEmpty(e.apiKey)],
      ["ANTHROPIC_SMALL_FAST_MODEL", nonEmpty(e.smallModel)],
      // Multi-Model γ (dist-belegt): availableModels-Env — nur gesetzt bei
      // non-empty Liste; ANTHROPIC_MODEL ist/PRIORITÄT-1 bleibt der Default.
      [
        "CLAUDE_MODEL_CONFIG",
        e.models && e.models.length > 0
          ? JSON.stringify({ availableModels: e.models })
          : undefined,
      ],
    ]),
  gemini: (e) =>
    envMapping([
      ["GEMINI_API_KEY", nonEmpty(e.apiKey)],
      ["GEMINI_MODEL", nonEmpty(e.model)],
      ["GOOGLE_GEMINI_BASE_URL", nonEmpty(e.baseUrl)],
    ]),
  droid: (e) =>
    envMapping(
      [["FACTORY_API_KEY", nonEmpty(e.apiKey)]],
      nonEmpty(e.baseUrl)
        ? ["droid: kein docs-verifizierter Base-URL-Env; baseUrl ignoriert"]
        : [],
    ),
  qwen: (e) => {
    const baseUrl = nonEmpty(e.baseUrl);
    return envMapping([
      ["OPENAI_API_KEY", nonEmpty(e.apiKey)],
      ["OPENAI_BASE_URL", baseUrl ? withV1Suffix(baseUrl) : undefined],
      ["OPENAI_MODEL", nonEmpty(e.model)],
    ]);
  },
  kimi: (e) => {
    const baseUrl = nonEmpty(e.baseUrl);
    return envMapping([
      ["KIMI_MODEL_API_KEY", nonEmpty(e.apiKey)],
      ["KIMI_MODEL_BASE_URL", baseUrl ? withV1Suffix(baseUrl) : undefined],
      ["KIMI_MODEL_NAME", nonEmpty(e.model)],
    ]);
  },
  kiro: (e) =>
    envMapping(
      [["KIRO_API_KEY", nonEmpty(e.apiKey)]],
      nonEmpty(e.baseUrl)
        ? ["kiro: kein Base-URL-Env (KIRO_API_KEY-only); baseUrl ignoriert"]
        : [],
    ),
  iflow: (e) => {
    const baseUrl = nonEmpty(e.baseUrl);
    return envMapping([
      ["IFLOW_API_KEY", nonEmpty(e.apiKey)],
      ["IFLOW_BASE_URL", baseUrl ? withV1Suffix(baseUrl) : undefined],
      ["IFLOW_modelName", nonEmpty(e.model)],
    ]);
  },
};

// ---------------------------------------------------------------------------
// Mechanismus A — codex (FILE)
// ---------------------------------------------------------------------------

/**
 * codex auth.json — Helper-Semantik verbatim: install-if-missing, chmod 0600,
 * NIE overwrite (der Helper touched ein vorhandenes auth.json nie). Fehlt
 * `apiKey` in einer konfigurierten Harness-Entry, wird der Helper-Placeholder
 * "ollama" eingesetzt (Template-Parität; die Entry-Präsenz IST das Opt-in).
 */
export function deployCodexAuth(
  entry: HarnessConfigEntry,
  paths: HarnessWriterPaths,
  warnings: string[],
  logger?: HarnessWriterLogger,
  harnessId = "codex",
): HarnessDeployFile {
  const path = join(paths.acpxDir, "codex-home", "auth.json");
  if (existsSync(path)) {
    logger?.debug?.(
      `[${harnessId}] auth.json already present; leaving untouched (helper semantics)`,
    );
    return { path, action: "unchanged" };
  }
  atomicWrite(
    path,
    `${JSON.stringify(
      { OPENAI_API_KEY: entry.apiKey ?? "ollama", tokens: null, last_refresh: null },
      null,
      2,
    )}\n`,
  );
  chmod0600(path, warnings);
  logger?.info?.(`[${harnessId}] Created ${path} (placeholder API key)`);
  return { path, action: "created" };
}

/**
 * γ.1 codex Modell-Metadaten-Katalog (`model_catalog_json`, binary-verifiziert
 * 2026-10-13 am DEPLOYED binary via `codex debug models`): die Datei ersetzt
 * den built-in Katalog — Custom-Modelle (Ollama) bekommen ECHTE Metadaten
 * statt der Fallback-Warnung "Model metadata for `X` not found". Pflichtfelder
 * der deployed Binary (parse-error-iteriert belegt): base_instructions,
 * supports_parallel_tool_calls, experimental_supported_tools + die Struktur-
 * Felder unten; Optionals entfallen. Die Modelle NUR mit Operator-Metadaten
 * aus openclaw.json (`contextWindow`) — Ids ohne Kontextfenster werden
 * geskippt und geplant (never guess). Semantik: catalog REPLACE-ALL (gpt-*
 * built-ins verschwinden aus dem Picker — für Ollama-only-Setups gewollt,
 * BRIDGE §15.10).
 */
const CODEX_MODEL_CATALOG_LIMIT = 10000;

export function buildCodexModelCatalogJson(
  modelIds: readonly string[],
  metaById: ReadonlyMap<string, ModelMeta>,
): { content: string; included: number; skipped: string[] } | null {
  const entries: Record<string, unknown>[] = [];
  const skipped: string[] = [];
  for (const id of dedupeModelIds(modelIds)) {
    const meta = metaById.get(id);
    if (!meta?.contextWindow || meta.contextWindow <= 0) {
      skipped.push(id);
      continue;
    }
    const contextWindow = Math.floor(meta.contextWindow);
    entries.push({
      slug: id,
      display_name: id,
      description: "Ollama model (metadata from openclaw.json models.providers)",
      base_instructions: "",
      supported_reasoning_levels: [],
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      support_verbosity: false,
      default_reasoning_summary: "auto",
      web_search_tool_type: "text",
      truncation_policy: { mode: "bytes", limit: CODEX_MODEL_CATALOG_LIMIT },
      supports_parallel_tool_calls: false,
      experimental_supported_tools: [],
      input_modalities: ["text"],
      context_window: contextWindow,
      max_context_window: contextWindow,
      effective_context_window_percent: 95,
    });
  }
  if (entries.length === 0) return null;
  return {
    content: `${JSON.stringify({ models: entries }, null, 2)}\n`,
    included: entries.length,
    skipped,
  };
}

/**
 * codex config.toml — die acpx-Inheritance-Quelle (der acpx-Plugin-Codex-Wrapper
 * regeneriert daraus das operative codex-home/config.toml bei JEDEM Gateway-
 * Start; inheritiert nur model/model_provider/model_reasoning_effort/
 * sandbox_mode/[model_providers.*]/trust-entries — Template-Kommentar verbatim).
 *
 * Generiert aus der Entry: model, model_provider (derivierter Name, NICHT
 * "ollama" — reserviert), base_url = baseUrl + /v1 (kein Doppel-/v1),
 * wire_api "responses" ("chat" wird von codex rejected — Template verbatim),
 * requires_openai_auth = true (liest auth.json; env_key bricht Gateway-Spawns),
 * sandbox_mode ("workspace-write" — Template-Default, nicht konfigurierbar),
 * model_reasoning_effort nur wenn `thinking` nicht-leer gesetzt,
 * [projects."<p>"] trust_level = "trusted" je unique trustProjects (dedupe+
 * sort — tomllib rejected duplicate table headers, Template-Kommentar verbatim).
 *
 * γ.1: `modelCatalogPath` → top-level `model_catalog_json` key (Metadaten-
 * Katalog für Custom-Modelle). NICHT acpx-vererbt (BRIDGE §15.10) — nur
 * direkte codex-CLI-Nutzer mit CODEX_HOME auf dieser Datei bekommen den
 * Katalog live; ACP-Sessions bleiben bundled-catalog.
 */
export function buildCodexConfigToml(
  entry: HarnessConfigEntry,
  modelCatalogPath?: string,
): string {
  const baseUrl = withV1Suffix(entry.baseUrl ?? "");
  const providerId = deriveProviderId(entry.baseUrl ?? "");
  const lines: string[] = [
    CODEX_SIGNATURE_LINE,
    // Self-Recognition + Refresh-Aufnahme (γ): nachweislich writer-generierte
    // Dateien werden bytes-sync aktualisiert; Hands-Edits haben nach dem
    // ersten Upgrade verloren (BRIDGE.md §15.10, one-time-Migration Doku).
    "# Multi-Model γ: [profiles.*] blocks are NOT inherited by acpx",
    "# renderIsolatedCodexConfig (only model/model_provider/model_reasoning_effort/",
    "# sandbox_mode + [model_providers.*]); profiles serve direct codex-CLI users",
    "# pointing CODEX_HOME at this file.",
    `model = ${tomlString(entry.model)}`,
    `model_provider = ${tomlString(providerId)}`,
  ];
  const thinking = nonEmpty(entry.thinking);
  if (thinking) {
    lines.push(`model_reasoning_effort = ${tomlString(thinking)}`);
  }
  if (modelCatalogPath) {
    lines.push(
      // γ.1: Metadaten-Katalog für Custom-Modelle (binary-verifiziert). Nur
      // direkte CLI-Nutzer — acpx inheritiert den key nicht (BRIDGE §15.10).
      `model_catalog_json = ${tomlString(modelCatalogPath)}`,
    );
  }
  lines.push(
    `sandbox_mode = "workspace-write"`,
    ``,
    `[model_providers.${providerId}]`,
    `name = "harness-config-writer (${baseUrl})"`,
    `base_url = ${tomlString(baseUrl)}`,
    `wire_api = "responses"`,
    `requires_openai_auth = true`,
    ``,
  );
  // Multi-Model γ: je verfügbares Modell ein [profiles."id"]-Block (quoted
  // keys — ':' in Ollama-Ids ist als quoted TOML-Header safe). Default
  // (entry.model) bleibt top-level; die Profile sind die Wahl-Surfaces.
  if (entry.models && entry.models.length > 0) {
    const thinkLine = thinking ? `model_reasoning_effort = ${tomlString(thinking)}` : null;
    for (const modelId of dedupeModelIds(entry.models)) {
      lines.push(`[profiles.${tomlString(modelId)}]`, `model = ${tomlString(modelId)}`);
      if (thinkLine) lines.push(thinkLine);
      lines.push(`model_provider = ${tomlString(providerId)}`, ``);
    }
  }
  // Trailing-Slash-Normalisierung vor dedupe (sonst doppelt-Header-Risiko
  // auf "/pfad" + "/pfad/"); path "/" als Root wird erhalten.
  const trust = [
    ...new Set(
      (entry.trustProjects ?? []).map((p) => {
        const trimmed = p.trim();
        const withoutTrailing = trimmed.replace(/\/+$/, "");
        return withoutTrailing.length > 0 ? withoutTrailing : trimmed;
      }),
    ),
  ].sort();
  lines.push(
    ...trust.flatMap((project) => [
      `[projects.${tomlString(project)}]`,
      `trust_level = "trusted"`,
    ]),
  );
  return `${lines.join("\n")}\n`;
}

export function deployCodexHarnessFiles(
  entry: HarnessConfigEntry,
  paths: HarnessWriterPaths,
  logger?: HarnessWriterLogger,
  harnessId = "codex",
  modelCatalog?: ModelCatalog,
): { warnings: string[]; files: HarnessDeployFile[] } {
  const warnings: string[] = [];
  const files: HarnessDeployFile[] = [];

  // 1) CODEX_HOME auth.json — der acpx-Wrapper-CODEX_HOME, bei jedem
  //    Adapter-Start gelesen; ohne ihn codex "Authentication required"
  //    (Helper-Doku verbatim).
  files.push(deployCodexAuth(entry, paths, warnings, logger, harnessId));

  // 2) /config/.codex/config.toml — Inheritance-Quelle, install-if-missing /
  //    upgrade-only-no-providers / customized NEVER overwritten (NOTE).
  const tomlPath = join(paths.codexSourceHome, "config.toml");
  const catalogPath = modelCatalog ? join(paths.codexSourceHome, "model-catalog.json") : undefined;
  const action = upgradeOrNoteIfMissingOrDiffers(
    tomlPath,
    buildCodexConfigToml(entry, catalogPath),
  );
  if (action === "note (customized, left intact)") {
    logger?.info?.(
      `[${harnessId}] ${tomlPath} is customized; leaving intact (helper semantics)`,
    );
  }
  files.push({ path: tomlPath, action });

  // 3) γ.1 Metadaten-Katalog — NUR wenn die TOML writer-kontrolliert ist
  //    (NOTE = customized → KEIN models.json-Orphan um eine Datei streuen,
  //    die den Key bewusst nie trägt). Ids ohne Operator-Kontextfenster
  //    bleiben draußen (never guess); Info-Log macht die Lücke sichtbar.
  if (modelCatalog && entry.models && entry.models.length > 0 && action !== "note (customized, left intact)") {
    const built = buildCodexModelCatalogJson(entry.models, modelCatalog.metaById);
    if (built) {
      const catalogFile = writeFileIfMissingOrDiffers(catalogPath!, built.content);
      files.push({ path: catalogPath!, action: catalogFile });
      logger?.info?.(
        `[${harnessId}] model catalog ${catalogPath}: ${built.included} model(s) with operator metadata` +
          (built.skipped.length > 0
            ? `; ${built.skipped.length} skipped (no contextWindow in openclaw.json)`
            : ""),
      );
    } else {
      logger?.info?.(
        `[${harnessId}] model catalog skipped: no model of the list has contextWindow in openclaw.json (codex falls back to its bundled-metadata warning)`,
      );
    }
  }
  return { warnings, files };
}

// ---------------------------------------------------------------------------
// Mechanismus A — opencode (FILE)
// ---------------------------------------------------------------------------

/**
 * opencode.jsonc — provider-Block (@ai-sdk/openai-compatible mit baseURL +
 * apiKey, Template-Shape verbatim), `model` + `small_model` aus der Entry.
 * Provider-id generiert (deriveProviderId); das Template nutzte static
 * "ollama" — für opencode nicht reserviert, aber derivierbar bleibt
 * multi-Backend-safe. Plain JSON ist valid JSONC (OpenCode parst JSON(C)
 * unabhängig vom Dateinamen, Helper-Doku verbatim).
 */
export function buildOpencodeConfigJsonc(entry: HarnessConfigEntry): string {
  const baseUrl = entry.baseUrl ?? "";
  const providerId = deriveProviderId(baseUrl);
  const smallModel = nonEmpty(entry.smallModel) ?? entry.model;
  // Multi-Model γ: mit verfügbarer Modellliste wandern ALLE ids in die
  // provider.models-Map (native Multi-Model-Surface; entry.model zuerst =
  // Default, smallModel bei Differ ebenfalls). OHNE models bleibt der Output
  // byte-identisch zum Vor-γ-Stand (single-entry Map, kein smallModel-Entry).
  let modelIds: string[];
  if (entry.models && entry.models.length > 0) {
    modelIds = dedupeModelIds([entry.model, ...entry.models, smallModel]);
  } else {
    modelIds = [entry.model];
  }
  const cfg = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: `harness-config-writer (${withV1Suffix(baseUrl)})`,
        options: {
          baseURL: withV1Suffix(baseUrl),
          apiKey: entry.apiKey ?? "ollama",
        },
        models: Object.fromEntries(modelIds.map((id) => [id, {}])),
      },
    },
    model: `${providerId}/${entry.model}`,
    small_model: `${providerId}/${smallModel}`,
  };
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

/** Comment-only Neutralizer für das legacy-opencode config.toml (Helper). */
export const OPENCODE_LEGACY_PLACEHOLDER =
  "# Neutralisiert (comment-only): OpenCode liest Config-Dateien als JSON(C),\n" +
  '# unabhaengig von der Dateiendung ("config.toml is not valid JSON(C)",\n' +
  "# verifiziert 2026-10-09). Die echte Provider-Config steht in opencode.jsonc\n" +
  "# neben dieser Datei — generiert vom harness-config-writer Plugin (Phase 3, Repo-Split A2).\n";

/**
 * Deploy in BEIDE Dirs wie der Helper (opencode-home der ACPX_DIR + global
 * /config/opencode), bytes-sync; das legacy config.toml (comment-only) wird
 * in opencode-home neutralisiert (Helper copy-on-diff verbatim).
 */
export function deployOpencodeHarnessFiles(
  entry: HarnessConfigEntry,
  paths: HarnessWriterPaths,
  logger?: HarnessWriterLogger,
  harnessId = "opencode",
): { warnings: string[]; files: HarnessDeployFile[] } {
  const warnings: string[] = [];
  const files: HarnessDeployFile[] = [];
  const desired = buildOpencodeConfigJsonc(entry);
  for (const targetDir of [join(paths.acpxDir, "opencode-home"), paths.opencodeGlobalDir]) {
    const path = join(targetDir, "opencode.jsonc");
    const action = writeFileIfMissingOrDiffers(path, desired);
    if (action !== "unchanged") {
      logger?.info?.(`[${harnessId}] Updated ${path} (provider config)`);
    }
    files.push({ path, action });
  }
  // Legacy TOML-Placeholder neutralisieren (Helper-Semantik: copy wenn abweichend).
  const legacy = join(paths.acpxDir, "opencode-home", "config.toml");
  const legacyAction = writeFileIfMissingOrDiffers(legacy, OPENCODE_LEGACY_PLACEHOLDER);
  if (legacyAction !== "unchanged") {
    logger?.info?.(`[${harnessId}] Replaced legacy opencode config.toml placeholder`);
  }
  files.push({ path: legacy, action: legacyAction });
  return { warnings, files };
}

// ---------------------------------------------------------------------------
// Mechanismus B — ENV-Datei pro Harness (harness-env/<id>.env)
// ---------------------------------------------------------------------------

const HARNESS_ENV_DIR = "harness-env";

/**
 * sh-safe quoting: single quotes, ' als '"'"' — das sourcing via
 * `. <env-datei>` im Command-Override-Wrapper expandiert $/backticks nie.
 */
export function renderEnvFile(vars: Record<string, string>, header: readonly string[]): string {
  const lines = [...header.map((line) => `# ${line}`), ""];
  for (const key of Object.keys(vars).sort()) {
    lines.push(`${key}='${vars[key].replace(/'/g, `'"'"'`)}'`);
  }
  return `${lines.join("\n")}\n`;
}

export function deployHarnessEnvFile(
  harnessId: string,
  entry: HarnessConfigEntry,
  paths: HarnessWriterPaths,
  logger?: HarnessWriterLogger,
  modelsComment?: readonly string[],
): { warnings: string[]; file: HarnessDeployFile | null } {
  const mapping = ENV_MECHANISM[harnessId]?.(entry) ?? null;
  if (!mapping) {
    return { warnings: [], file: null };
  }
  const path = join(paths.acpxDir, HARNESS_ENV_DIR, `${harnessId}.env`);
  const header = [
    `harness-config-writer (Phase 3, Repo-Split A2) — harness env file (${harnessId}).`,
    "Gesourcet wrapperartig vom acpx-Command-Override",
    "plugins.entries.acpx.config.agents.<id>.command/args — BRIDGE.md §15.2.",
    "GENERIERT (Phase 3): Hand-Edits werden beim nächsten Boot überschrieben.",
  ];
  let content = renderEnvFile(mapping.vars, header);
  // Multi-Model γ: ENV-Harnesses ohne Multi-Model-Surface bekommen die
  // verfügbaren Modelle als INFORMATIONAL-Kommentar (cap 25 + more-Zeile).
  if (modelsComment !== undefined && modelsComment.length > 0) {
    const shown = modelsComment.slice(0, COMMENT_MODEL_CAP);
    const lines = [
      "",
      `# available models (informational — ${harnessId} exposes no multi-model env surface):`,
      ...shown.map((id) => `# - ${id.replace(/\r?\n/g, " ")}`),
    ];
    if (modelsComment.length > shown.length) {
      lines.push(`# (+${modelsComment.length - shown.length} more)`);
    }
    content += `${lines.join("\n")}\n`;
  }
  const action = writeFileIfMissingOrDiffers(path, content);
  if (action !== "unchanged") {
    logger?.info?.(`[${harnessId}] ${action} ${path} (${Object.keys(mapping.vars).join(", ")})`);
  }
  // Enthält Tokens/Keys → 0600 wie codex auth.json.
  if (/API_KEY|AUTH_TOKEN|TOKEN/.test(Object.keys(mapping.vars).sort().join("|"))) {
    try {
      chmodSync(path, 0o600);
    } catch (error) {
      mapping.warnings.push(`could not chmod ${path} 0600: ${briefError(error)}`);
    }
  }
  return { warnings: mapping.warnings, file: { path, action } };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * deployHarnessConfigs — TRIGGER-Surface (registerFull, idempotent). Liest
 * `config.harnesses`, dispatcht je Harness auf Mechanismus A/B; sonst Mechanismus
 * C (NONE, Additiv-Garantie: copilot/cursor + alle nicht katalogisierten ids
 * bewusst STUMM — kein Warn-Noise für den normalen acpx-Default-Fall).
 *
 * Multi-Model γ: `modelCatalog` (aus der vollen Gateway-Config, index.ts ist
 * der EINZIGE api.config-Konsument) reichert je Entry die Modellliste an
 * (resolveEntryModels: explicit > matched > none) und hält `modelsSource` im
 * Report fest. Mechanismus C wird NICHT angereichert (OAuth-owned, stumm).
 *
 * Fehlt die Section / ist sie leer / kein Harness-Object → report.skipped
 * und NICHTS wird angefasst (kein mkdir, kein Write). Entries müssen
 * non-empty `model: string` tragen (configSchema required); invalide Entries
 * werden mit Warning SKIPPT statt zu crashen (fail-soft).
 */
export function deployHarnessConfigs(
  pluginConfig: unknown,
  paths: HarnessWriterPaths,
  logger?: HarnessWriterLogger,
  modelCatalog?: ModelCatalog,
): HarnessDeployReport {
  const harnesses = readHarnessSection(pluginConfig);
  if (harnesses === null) {
    return { results: [], skipped: true };
  }
  const results: HarnessDeployResult[] = [];
  for (const harnessId of Object.keys(harnesses).sort()) {
    const entry = harnesses[harnessId];
    if (!isValidEntry(entry)) {
      results.push({
        harnessId,
        mechanism: "none",
        warnings: ["invalide Entry (model: non-empty string ist Pflicht) — skipt"],
        files: [],
      });
      continue;
    }
    const resolvedModels =
      harnessId === "codex" || harnessId === "opencode" || harnessId in ENV_MECHANISM
        ? resolveEntryModels(entry, modelCatalog ?? null)
        : null;
    const enriched: HarnessConfigEntry =
      resolvedModels !== null
        ? {
            ...entry,
            models: resolvedModels.models.length > 0 ? resolvedModels.models : undefined,
          }
        : entry;
    const entryWarnings = [
      ...(resolvedModels?.warnings ?? []),
    ];
    if (harnessId === "codex" || harnessId === "opencode") {
      // FILE-Mechanismus ohne baseUrl kann keine sinnvolle Provider-Route
      // erzeugen (base_url wäre "/v1") → skip mit Warning, kein Write.
      if (!nonEmpty(entry.baseUrl)) {
        results.push({
          harnessId,
          mechanism: harnessId === "codex" ? "file-codex" : "file-opencode",
          warnings: [
            ...entryWarnings,
            "baseUrl (non-empty) ist für den FILE-Mechanismus Pflicht — skipt",
          ],
          files: [],
        });
        continue;
      }
      const deploy =
        harnessId === "codex"
          ? // γ.1: Katalog (metabyId) für die codex-Metadaten-Datei mitgeben.
            deployCodexHarnessFiles(enriched, paths, logger, harnessId, modelCatalog)
          : deployOpencodeHarnessFiles(enriched, paths, logger, harnessId);
      results.push({
        harnessId,
        mechanism: harnessId === "codex" ? "file-codex" : "file-opencode",
        ...deploy,
        warnings: [...entryWarnings, ...deploy.warnings],
        modelsSource: resolvedModels?.source,
      });
      continue;
    }
    if (harnessId in ENV_MECHANISM) {
      const { warnings, file } = deployHarnessEnvFile(
        harnessId,
        enriched,
        paths,
        logger,
        // Multi-Model γ: ENV-Dateien ohne echte Multi-Model-Surface (nicht
        // claude — deren CLAUDE_MODEL_CONFIG ist die echte Surface) tragen die
        // verfügbaren Modelle als informational Kommentar.
        harnessId !== "claude" && (resolvedModels?.models.length ?? 0) > 0
          ? (resolvedModels?.models ?? [])
          : undefined,
      );
      results.push({
        harnessId,
        mechanism: "env",
        warnings: [...entryWarnings, ...warnings],
        modelsSource: resolvedModels?.source,
        files: file ? [file] : [],
      });
      continue;
    }
    // Mechanismus C: NONE — CLI-OAuth-owned.
    results.push({ harnessId, mechanism: "none", warnings: [], files: [] });
  }
  return { results, skipped: false };
}

function readHarnessSection(pluginConfig: unknown): HarnessConfigs | null {
  if (pluginConfig === null || typeof pluginConfig !== "object") return null;
  const section = (pluginConfig as Record<string, unknown>).harnesses;
  if (section === null || typeof section !== "object" || Array.isArray(section)) return null;
  const entries = section as Record<string, unknown>;
  if (Object.keys(entries).length === 0) return null;
  return entries as HarnessConfigs;
}

function isValidEntry(candidate: unknown): candidate is HarnessConfigEntry {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const model = (candidate as { model?: unknown }).model;
  return typeof model === "string" && model.trim().length > 0;
}