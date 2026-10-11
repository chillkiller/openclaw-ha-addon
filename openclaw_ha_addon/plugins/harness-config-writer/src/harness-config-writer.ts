/**
 * Phase 3 (generalisierte Harness-Config, GaRoN 10:37 / Owner-Design 10:37,
 * 2026-10-11): generiert je nach Harness die native Konfiguration für lokale
 * bzw. OpenAI-kompatible Backends (Ollama/vLLM/LocalAI/llama.cpp) aus der
 * normalisierten Section
 *
 *   plugins.entries['harness-config-writer'].config.harnesses
 *     = { <harnessId>: { model, baseUrl?, apiKey?, thinking?, smallModel?,
 *                        trustProjects? } }
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
 *                      oc_acpx_helper.py deploy_harness_configs)
 *            opencode → opencode.jsonc nach opencode-home/ UND /config/opencode/
 *                      (beide wie der Helper) + legacy config.toml neutralisiert
 *   B ENV  : claude (ANTHROPIC_*), gemini (GEMINI_*), droid (FACTORY_API_KEY),
 *            qwen (OPENAI_*), kimi (KIMI_MODEL_*), kiro (KIRO_API_KEY),
 *            iflow (IFLOW_*) — je eine env-Datei pro Harness
 *            (harness-env/<id>.env), gesourcet vom acpx-Command-Override
 *            plugins.entries.acpx.config.agents.<id>.command/args
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
};

/** plugins.entries['harness-config-writer'].config.harnesses (roh geparsed). */
export type HarnessConfigs = Record<string, HarnessConfigEntry>;

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
 * codex config.toml-Semantik VERBATIM (helper deploy_harness_configs):
 *   install-if-missing / upgrade NUR wenn current keinen [model_providers.-
 *   Block trägt / customized (+[model_providers.) = NIE überschrieben (NOTE).
 */
function upgradeOrNoteIfMissingOrDiffers(path: string, desired: string): FileAction {
  if (!existsSync(path)) {
    atomicWrite(path, desired);
    return "created";
  }
  const current = tryOr(() => readFileSync(path, "utf-8"), null);
  if (current === desired) return "unchanged";
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
 */
export function buildCodexConfigToml(entry: HarnessConfigEntry): string {
  const baseUrl = withV1Suffix(entry.baseUrl ?? "");
  const providerId = deriveProviderId(entry.baseUrl ?? "");
  const lines: string[] = [
    `model = ${tomlString(entry.model)}`,
    `model_provider = ${tomlString(providerId)}`,
  ];
  const thinking = nonEmpty(entry.thinking);
  if (thinking) {
    lines.push(`model_reasoning_effort = ${tomlString(thinking)}`);
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
  const action = upgradeOrNoteIfMissingOrDiffers(tomlPath, buildCodexConfigToml(entry));
  if (action === "note (customized, left intact)") {
    logger?.info?.(
      `[${harnessId}] ${tomlPath} is customized; leaving intact (helper semantics)`,
    );
  }
  files.push({ path: tomlPath, action });
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
        models: {
          [entry.model]: {},
        },
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
  const action = writeFileIfMissingOrDiffers(path, renderEnvFile(mapping.vars, header));
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
 * Fehlt die Section / ist sie leer / kein Harness-Object → report.skipped
 * und NICHTS wird angefasst (kein mkdir, kein Write). Entries müssen
 * non-empty `model: string` tragen (configSchema required); invalide Entries
 * werden mit Warning SKIPPT statt zu crashen (fail-soft).
 */
export function deployHarnessConfigs(
  pluginConfig: unknown,
  paths: HarnessWriterPaths,
  logger?: HarnessWriterLogger,
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
    if (harnessId === "codex" || harnessId === "opencode") {
      // FILE-Mechanismus ohne baseUrl kann keine sinnvolle Provider-Route
      // erzeugen (base_url wäre "/v1") → skip mit Warning, kein Write.
      if (!nonEmpty(entry.baseUrl)) {
        results.push({
          harnessId,
          mechanism: harnessId === "codex" ? "file-codex" : "file-opencode",
          warnings: ["baseUrl (non-empty) ist für den FILE-Mechanismus Pflicht — skipt"],
          files: [],
        });
        continue;
      }
      const deploy =
        harnessId === "codex"
          ? deployCodexHarnessFiles(entry, paths, logger, harnessId)
          : deployOpencodeHarnessFiles(entry, paths, logger, harnessId);
      results.push({
        harnessId,
        mechanism: harnessId === "codex" ? "file-codex" : "file-opencode",
        ...deploy,
      });
      continue;
    }
    if (harnessId in ENV_MECHANISM) {
      const { warnings, file } = deployHarnessEnvFile(harnessId, entry, paths, logger);
      results.push({
        harnessId,
        mechanism: "env",
        warnings,
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