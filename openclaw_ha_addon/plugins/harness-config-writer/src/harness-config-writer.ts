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
 * = Opt-out; abwesig = Auto-Matching. Details: the 15.10 design (model-catalog match keys).
 *
 * Multi-Model γ.1 (2026-10-13): codex Modell-Metadaten-Katalog — die
 * Operator-Metadaten aus `models.providers[*].models[*].contextWindow`
 * wandern in /config/.codex/model-catalog.json und die config.toml tragt
 * `model_catalog_json` (key-Verifizierung am DEPLOYED binary: `codex debug
 * models` parsed die Datei, Custom-Slugs haben echte Metadaten statt
 * Fallback-Warnung). Caveat: ersetzt den built-in Katalog; acpx vererbt den
 * key NICHT → nur direkte CLI-Nutzer (the 15.10 design (model-catalog match keys)).
 *
 * ADDITIV-GARANTIE (bindend): das Plugin ist ein Add-on zum bundled acpx,
 * kein Ersatz. Fehlt ein Harness in `harnesses` (oder die Section ganz),
 * wird für ihn NICHTS geschrieben — native Abos (Claude Pro, ChatGPT Plus,
 * Copilot-OAuth, …) laufen identisch zum acpx-Default über die eigene
 * Vendor-Auth ("Vendor auth must already exist on the host").
 *
 * Drei Mechanismen (Katalog: acpx SKILL.md Abschnitt "Harness aliases" ab Zeile 199 + docs
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
 *            kiro (KIRO_API_KEY), iflow (IFLOW_*), copilot (COPILOT_PROVIDER_*
 *            + COPILOT_MODEL — BYOK/OpenAI-compatible, Aufnahme 2026-10-16,
 *            Ollama-Doku + Binary verifiziert) — je eine env-Datei pro
 *            Harness (harness-env/<id>.env), gesourcet vom acpx-Command-
 *            Override plugins.entries.acpx.config.agents.<id>.command/args
 *            (the 15 design (generalized harness config (HCW phase 3))). Alle ENV-Namen docs-verifiziert.
 *   C NONE : cursor und alle übrigen CLI-OAuth-owned Harnesses —
 *            Skip, das Plugin schreibt für sie nichts.
 *
 * Deployment-Trigger: registerFull (Plugin-Load, idempotent — alle Writer
 * sind install-if-missing bzw. bytes-sync, Helper-Semantik). Es gibt keinen
 * verifizierten config-change-Hook am Host: Harness-Config-Änderungen
 * GELTEN BEIM NÄCHSTEN BOOT (the 15.4 design (trigger + config-change semantics), ehrlich dokumentiert).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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
    // Domain-4-Audit r4 (info): bare filename ohne '/' (z. B. "openclaw.json")
    // lieferte '' → Arm fiel durch auf XDG/HOME. Konvention: relative Datei
    // liegt im CWD → '.' als State-Dir, konsistent mit node's path.dirname.
    const dir = configPath.includes("/")
      ? configPath.replace(/\/+$/, "").split("/").slice(0, -1).join("/")
      : ".";
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
  action: "created" | "updated" | "unchanged" | "augmented" | "note (customized, left intact)";
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

/**
 * Atomarer Write (temp+rename). Optionales `mode` ODER beibehaltener Mode der
 * bestehenden Datei wird am TMP gesetzt VOR dem rename — kein 0644→0600
 * Exposé-Fenster (Helper-Standard `_write_managed_defaults`, M3-Fix).
 * Audit-Batch r2: chmod-Fail wird in `warnings` gemeldet (kein silent 0644
 * an 0600-Erwartungsort mehr) und bleibt fail-soft (rename läuft weiter).
 */
function atomicWrite(path: string, content: string, mode?: number, warnings?: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, content, "utf-8");
    const targetMode =
      mode ?? (existsSync(path) ? statSync(path).mode & 0o777 : undefined);
    if (targetMode !== undefined) {
      try {
        chmodSync(tmp, targetMode);
      } catch (error) {
        // Fail-soft wie der Helper except-branch — aber sichtbar (r2-Audit):
        // fehlgeschlagener Mode ist kein Deploy-Bruch, nur ein Hinweis.
        warnings?.push(`could not chmod ${path} ${targetMode.toString(8)}: ${briefError(error)}`);
      }
    }
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
function writeFileIfMissingOrDiffers(
  path: string,
  content: string,
  mode?: number,
  warnings?: string[],
): FileAction {
  const exists = existsSync(path);
  const current = exists ? tryOr(() => readFileSync(path, "utf-8"), null) : null;
  if (current === content) {
    // r2-Audit (M3-Residuum): auch beim BYTE-IDENTISCHEN Bestand einen
    // falschen Mode heilen (0644 Bestands-Datei mit 0600-Anforderung —
    // sonst bliebe sie bis zum ersten Content-Diff loose). Fail-soft.
    if (mode !== undefined && exists) {
      try {
        const currentMode = statSync(path).mode & 0o777;
        if (currentMode !== mode) {
          chmodSync(path, mode);
        }
      } catch (error) {
        warnings?.push(`could not chmod ${path}: ${briefError(error)}`);
      }
    }
    return "unchanged";
  }
  atomicWrite(path, content, mode, warnings);
  return exists ? "updated" : "created";
}

/**
 * codex config.toml-Semantik VERBATIM (helper deploy_harness_configs) +
 * Self-Recognition (γ): Dateien MIT `CODEX_SIGNATURE_LINE`-Erstzeile sind
 * nachweislich writer-generiert und werden bytes-genau geupdatet — nur so
 * wirken Modelllisten-Änderungen über den [model_providers.-Block hinaus,
 * der den heutigen NOTE-Zweig sonst einfrieren würde (the 15.10 design (model-catalog match keys)).
 * Signaturlose Dateien MIT [model_providers.-Block bleiben customized (NOTE).
 */

/**
 * Augment-Semantik (GaRoN 2026-10-16, Design-GO): eine bestehende FREMDE
 * config.toml (keine Writer-Signatur, kein [model_providers.-Block) wird
 * NICHT mehr ersetzt — der Ollama-Provider wird als MARKIERTER Abschnitt
 * angehängt (Operator-Content byte-erhalten). Der Abschnitt trägt NUR
 * [model_providers.*]/[profiles.*]/[projects.*]-Header — KEINE Top-Level-Keys
 * (model/model_provider/model_catalog_json): das Model-Routing bleibt
 * Operator-Entscheidung, damit mit/ohne Plugin wechselbar bleibt.
 * Kollidierende Operator-Header (gleicher profile/project-Name) werden
 * übersprungen + Warnung (never guess). Idempotent: der Marker-Rahmen wird
 * beim Re-Boot in-place refreshed (gleicher Section-Content → unchanged).
 */
const AUGMENT_BEGIN_MARKER = "# --- BEGIN harness-config-writer (generated) ---";
const AUGMENT_END_MARKER = "# --- END harness-config-writer (generated) ---";
// Final-Audit r2 (glm/deepseek, 2026-10-16): Marker nur als VOLLZEILE matchen —
// ein Substring-Treffer in Operator-Text (z. B. Kommentar, der den Marker
// dokumentiert) schnitt sonst Operator-Content mid-line ab (CRITICAL-1) und
// ein BEGIN ohne END löschte still alles danach (HIGH-1). Refresh bewahrt
// jetzt auch Operator-Content NACH dem END-Marker (Medium-2).
const AUGMENT_END_RE = /^# --- END harness-config-writer \(generated\) ---\s*$/m;
// r2b: LAST-Begin-wins — matchAll braucht das g-Flag; ein Operator-BEGIN
// mitten im Content vor unserem Block am Dateiende darf beim nächsten Boot
// nicht die Slice-Grenze bestimmen (sonst frisst der Refresh Operator-Bytes).
const AUGMENT_BEGIN_RE_G = /^# --- BEGIN harness-config-writer \(generated\) ---\s*$/gm;

/**
 * Alle TOML-Section-Header ([x.y…] — quoted wie [profiles."id"]) einer Datei,
 * NORMALISIERT (Final-Audit HIGH-3/F3): quoted Segmente werden ent-quotet und
 * Whitespace getrimmt — [profiles.m1] und [profiles."m1"] sind dieselbe
 * logische Table (bare-legal) und MÜSSEN kollidieren, sonst erzeugt das
 * Augment doppelte Header, die tomllib rejected.
 */
function collectTomlSectionHeaders(content: string): Set<string> {
  const headers = new Set<string>();
  for (const line of content.split("\n")) {
    const match = /^\s*\[\[?\s*(.+?)\s*\]?\]\s*$/.exec(line);
    if (match) {
      const normalized = match[1]
        .replace(/"([^"]*)"/g, "$1")
        .replace(/'([^']*)'/g, "$1")
        .trim();
      headers.add(normalized);
    }
  }
  return headers;
}

/**
 * Augment-Section aus der Entry: Provider-Block + Profile + Trust-Projekte.
 * Collisions-Filter: Header, die der Operator schon hat, werden NICHT
 * emittiert (die Section kann leer ausfallen → Aufrufer behandelt das).
 */
export function buildCodexAugmentSection(
  entry: HarnessConfigEntry,
  existingHeaders: ReadonlySet<string>,
  skipped: string[],
): string {
  const providerId = deriveProviderId(entry.baseUrl ?? "");
  const baseUrl = withV1Suffix(entry.baseUrl ?? "");
  const thinking = nonEmpty(entry.thinking);
  const lines: string[] = [];
  // Final-Audit HIGH-3: Kollisionen NORMALISIERT vergleichen — der Set trägt
  // ent-quotete Bare-Formen, unsere Emission ist quoted ([profiles."id"]);
  // [profiles.m1] und [profiles."m1"] sind dieselbe logische Table.
  const collides = (rawHeader: string, bareHeader: string): boolean =>
    existingHeaders.has(rawHeader) || existingHeaders.has(bareHeader);
  const providerHeader = `model_providers.${providerId}`;
  if (!collides(providerHeader, providerHeader)) {
    lines.push(
      `[${providerHeader}]`,
      `name = ${tomlString(`harness-config-writer (${baseUrl})`)}`,
      `base_url = ${tomlString(baseUrl)}`,
      `wire_api = "responses"`,
      `requires_openai_auth = true`,
      ``,
    );
  } else {
    skipped.push(`model_providers.${providerId} (operator header collision)`);
  }
  if (entry.models && entry.models.length > 0) {
    for (const modelId of dedupeModelIds(entry.models)) {
      const header = `profiles.${tomlString(modelId)}`;
      if (collides(header, `profiles.${modelId}`)) {
        skipped.push(`profiles.${modelId} (operator header collision)`);
        continue;
      }
      lines.push(`[${header}]`, `model = ${tomlString(modelId)}`);
      if (thinking) lines.push(`model_reasoning_effort = ${tomlString(thinking)}`);
      lines.push(`model_provider = ${tomlString(providerId)}`, ``);
    }
  }
  const trust = [
    ...new Set(
      (entry.trustProjects ?? []).map((p) => {
        const trimmed = p.trim();
        const withoutTrailing = trimmed.replace(/\/+$/, "");
        return withoutTrailing.length > 0 ? withoutTrailing : trimmed;
      }),
    ),
  ].sort();
  for (const project of trust) {
    const header = `projects.${tomlString(project)}`;
    if (collides(header, `projects.${project}`)) {
      skipped.push(`projects.${project} (operator header collision)`);
      continue;
    }
    lines.push(`[${header}]`, `trust_level = "trusted"`, ``);
  }
  // Trailing Blank + Full-Section-Content zurückgeben (ohne BEGIN/END-Marker —
  // die rahmt der Aufrufer).
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

/**
 * codex config.toml Lebenszyklus (erschöpfend, in Präzedenz-Reihenfolge):
 *  1. fehlt                     → created (Writer-Vollform mit Signatur)
 *  2. byte-identisch            → unchanged
 *  3. Writer-Signatur-Zeile 1   → updated (bytes-sync, wir besitzen die Datei)
 *  4. fremd + [model_providers. → NOTE (customized, never overwritten)
 *  5. fremd + AUGMENT-Marker   → Marker-Rahmen refreshed (updated/unchanged)
 *  6. fremd, sonst             → AUGMENTED (markierter Provider-Abschnitt
 *     wird angehängt; Operator-Content bleibt byte-erhalten; Section leer
 *     wegen Kollisionen → NOTE + Warnung)
 */
function manageCodexToml(
  tomlPath: string,
  desired: string,
  entry: HarnessConfigEntry,
  warnings: string[],
): FileAction {
  if (!existsSync(tomlPath)) {
    atomicWrite(tomlPath, desired);
    return "created";
  }
  const current = tryOr(() => readFileSync(tomlPath, "utf-8"), null);
  if (current === null) {
    warnings.push(`codex: ${tomlPath} unreadable; leaving intact`);
    return "note (customized, left intact)";
  }
  if (current === desired) return "unchanged";
  if (current.startsWith(CODEX_SIGNATURE_LINE)) {
    atomicWrite(tomlPath, desired);
    return "updated";
  }
  // Final-Audit r2: Marker-Scan NUR als Vollzeilen (CRITICAL-1) mit geordneter
  // BEGIN/END-Validierung (HIGH-1). r2b: der LETZTE Vollzeilen-BEGIN gewinnt —
  // ein Operator-BEGIN mitten im Content plus unser Block am Dateiende →
  // unser Block ist der letzte; alles davor ist Operator-Content und bleibt.
  const beginMatches = Array.from(current.matchAll(AUGMENT_BEGIN_RE_G));
  const beginMatch = beginMatches.length > 0 ? beginMatches[beginMatches.length - 1] : null;
  const afterBegin = beginMatch !== null ? current.slice(beginMatch.index + beginMatch[0].length) : null;
  const endMatch = afterBegin !== null ? AUGMENT_END_RE.exec(afterBegin) : null;
  const hasManagedBlock = beginMatch !== null && endMatch !== null;
  if (beginMatch !== null && !hasManagedBlock) {
    warnings.push(
      `codex: unterminated writer marker found in ${tomlPath}; treating file as foreign, content preserved`,
    );
  }
  // NOTE nur für FREMDE Dateien ohne validen managed Block — eine augmentierte
  // Datei enthält [model_providers.*] aus unserem eigenen Abschnitt.
  if (!hasManagedBlock && current.includes("[model_providers.")) {
    return "note (customized, left intact)";
  }
  // Operator-Teil = alles VOR dem BEGIN-Marker + alles NACH dem END-Marker
  // (Final-Audit Medium-2: Operator-Edits nach dem Block bleiben erhalten).
  const endMatchSlice = endMatch;
  const before = hasManagedBlock
    ? current.slice(0, beginMatch!.index)
    : current;
  const after = endMatchSlice
    ? afterBegin!.slice(endMatchSlice.index + endMatchSlice[0].length)
    : "";
  const isRefresh = hasManagedBlock;
  const operatorContent = before.replace(/\n+$/, "");
  const operatorTail = after.replace(/^\n+/, "").replace(/\n+$/, "");
  // Headers des Operator-Teils (beide Seiten) — NICHT unseres alten Sections-Teils.
  const existingHeaders = collectTomlSectionHeaders(
    operatorContent + (operatorTail ? `\n${operatorTail}` : ""),
  );
  const skipped: string[] = [];
  const section = buildCodexAugmentSection(entry, existingHeaders, skipped);
  for (const s of skipped) warnings.push(`codex: skipped ${s}`);
  if (section.trim() === "") {
    if (isRefresh) {
      // Final-Audit HIGH-2: Refresh mit Total-Kollision → alter managed Block
      // IST writer-owned und MUSS raus (sonst doppelte Tables + tomllib-Fail,
      // der nie konvergiert). Operator-Bytes bleiben; nur unser toter Block fliegt.
      const next = operatorTail
        ? `${operatorContent}\n\n${operatorTail}\n`
        : `${operatorContent}\n`;
      if (next === current) return "unchanged";
      atomicWrite(tomlPath, next);
      return "updated";
    }
    warnings.push(
      `codex: augment section empty (all headers collide with operator content); leaving intact`,
    );
    return "note (customized, left intact)";
  }
  const next =
    `${operatorContent}\n\n${AUGMENT_BEGIN_MARKER}\n${section}${AUGMENT_END_MARKER}\n` +
    (operatorTail ? `\n${operatorTail}\n` : "");
  if (next === current) return "unchanged";
  atomicWrite(tomlPath, next);
  return isRefresh ? "updated" : "augmented";
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
  // Final-Audit r2 (glm): case-insensitive wie normalizeBaseUrlForMatch (/\v1$/i) —
  // konsistente Behandlung pathologischer http://h:1/V1-Eingaben.
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
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
   * Werte (contextWindow — das einzige codex-surfacige Pflichtfeld). NUR
   * belegte Werte landen hier — der Writer rät niemals ein Kontextfenster
   * (Ownership-Regel).
   */
  metaById: Map<string, ModelMeta>;
};

/** Operator-gepflegte Modell-Metadaten aus `models.providers[*].models[*]`. */
export type ModelMeta = {
  contextWindow?: number;
};

/** N2 (Fix 2026-10-14): "optout" trennt Operator-`models: []` bewusst von "none" (kein Katalogmatch). */
export type ResolvedModelsSource = "explicit" | "matched" | "none" | "optout";

export type ResolvedModels = {
  models: string[];
  source: ResolvedModelsSource;
  warnings: string[];
};

/**
 * Match-Ebene für baseUrl: trailing Slashes + trailing "/v1" neutralisiert,
 * Protokoll GESTRICHEN (http↔https matchen — Domain-4-Audit r3: die Katalog-
 * Seite schreibt https://, die Harness-Entry http:// → Protocol-Preserving
 * ließ die Provider nie matchen, Multi-Model blieb stumm weg), Host
 * lowercased, Pfad erhalten (deriveProviderId-Catch-Pattern für
 * scheme-lose Input).
 */
export function normalizeBaseUrlForMatch(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "").replace(/\/+$/, "");
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.host.toLowerCase()}${path}`;
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
 * je Provider `baseUrl` + `models[].id` (+ `contextWindow` für
 * γ.1 codex-Metadaten). Fail-soft — garbage Config ergibt einen leeren
 * Katalog + Sammel-Warning, nie einen Crash. Provider-Keys sortiert
 * (deterministische Merge-Order), ids first-occurrence-deduped; metaById
 * first-occurrence (kollidierende Provider-Settings entscheiden die erste,
 * sortiert ermittelte Provider — bewusst, dokumentiert in the 15.10 design (model-catalog match keys)).
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
      // γ.1 Metadaten: nur positive Zahlen zählen (contextWindow — das
      // einzige Feld mit codex-Katalog-Surface; M4-Fix: maxTokens wird
      // bewusst NICHT gesammelt, es gibt keine konsumierende Surface).
      for (const m of rawModels) {
        if (typeof m !== "object" || m === null) continue;
        const rec = m as Record<string, unknown>;
        const id = typeof rec.id === "string" ? rec.id.trim() : "";
        if (!id || metaById.has(id)) continue;
        if (typeof rec.contextWindow === "number" && rec.contextWindow > 0) {
          metaById.set(id, { contextWindow: rec.contextWindow });
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
    return { models: [], source: "optout", warnings };
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
    // non-empty gewollt, aber alle Items invalid → Fallback auf matched/none.
    // N1-Fix: die Fallback-Warning NUR bei einem echten Array (ein schon von
    // "models ignored" bewertetes Nicht-Array bekommt keinen Doppel-Satz).
    if (Array.isArray(rawEntry.models) && rawEntry.models.length > 0) {
      warnings.push("entry models resolved to nothing — falling back to catalog match");
    }
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
      // Jagd-F1 (2026-10-17): Fallback auf model — asymmetrisch zum opencode-
      // r3-Fix behoben (dangling small_model-Referenz-Klasse): ohne Fallback
      // läuft die Claude-Fast-Route auf den Anthropic-Default (Haiku-Klasse)
      // gegen die Ollama-URL und scheitert mit model-not-found.
      [
        "ANTHROPIC_SMALL_FAST_MODEL",
        nonEmpty(e.smallModel) ?? nonEmpty(e.model),
      ],
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
  // copilot BYOK/Ollama (Aufnahme 2026-10-16, GaRoN-GO): ENV-Surface doppelt
  // docs-verifiziert — Ollama-Integrations-Doku (docs.ollama.com/integrations/
  // copilot-cli, Manual setup) UND Binary-Help-Text (@github/copilot 1.0.98:
  // "Use openai for OpenAI-compatible endpoints including Ollama";
  // "COPILOT_PROVIDER_API_KEY: optional for local providers like Ollama";
  // "GitHub authentication is not required" beim BYOK-Provider). Wire-API
  // "responses" ist der dokumentierte Default-Wert für Ollama-Backends.
  copilot: (e) => {
    const baseUrl = nonEmpty(e.baseUrl);
    return envMapping([
      ["COPILOT_PROVIDER_BASE_URL", baseUrl ? withV1Suffix(baseUrl) : undefined],
      ["COPILOT_PROVIDER_API_KEY", nonEmpty(e.apiKey)],
      // Jagd-F2 (2026-10-17): WIRE_API bewusst "responses" — der Ollama-
      // Backend-Endpunkt ist /v1/responses; die Copilot-CLI-Doku nennt
      // "completions" als Default, das Ollama-Gateway implementiert aber
      // die Responses-API. Dokumentation statt Config-Flip
      ["COPILOT_PROVIDER_WIRE_API", baseUrl ? "responses" : undefined],
      ["COPILOT_MODEL", nonEmpty(e.model)],
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
    // 0600 am TMP VOR dem rename (Helper-Standard) — kein Exposé-Fenster;
    // r2-Audit: chmod-Fail wandert in `warnings` statt still zu bleiben.
    0o600,
    warnings,
  );
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
 * the 15.10 design (model-catalog match keys)).
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
      description: "custom model (metadata from openclaw.json models.providers)",
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
 * Katalog für Custom-Modelle). NICHT acpx-vererbt (the 15.10 design (model-catalog match keys)) — nur
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
    // ersten Upgrade verloren (the 15.10 design (model-catalog match keys), one-time-Migration Doku).
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
      // direkte CLI-Nutzer — acpx inheritiert den key nicht (the 15.10 design (model-catalog match keys)).
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
  //    M1-Fix (2026-10-14): der `model_catalog_json`-Key wird NUR emittiert,
  //    wenn der Katalog auch tatsächlich geschrieben werden kann — sonst
  //    entstünde ein dangling Key auf eine nie existierende Datei (codex
  //    Startup-Verhalten bei missing file ist unbelegt). "built" wird daher
  //    VOR der TOML-Emission berechnet.
  const tomlPath = join(paths.codexSourceHome, "config.toml");
  const catalogPath = join(paths.codexSourceHome, "model-catalog.json");
  const built =
    modelCatalog && entry.models !== undefined && entry.models.length > 0
      ? buildCodexModelCatalogJson(entry.models, modelCatalog.metaById)
      : null;
  const action = manageCodexToml(
    tomlPath,
    buildCodexConfigToml(entry, built ? catalogPath : undefined),
    entry,
    warnings,
  );
  if (action === "note (customized, left intact)") {
    logger?.info?.(
      `[${harnessId}] ${tomlPath} is customized; leaving intact (helper semantics)`,
    );
  }
  files.push({ path: tomlPath, action });

  // 3) γ.1 Metadaten-Katalog — NUR wenn die TOML writer-kontrolliert ist
  //    (NOTE = customized → KEIN catalog-File — keine Datei streuen, die der
  //    benutzte Key bewusst nie referenziert) und `built` non-null ist
  //    (M1-Fix: models → none / kein contextWindow ⇒ auch KEIN Key). Ein
  //    evtl. verbleibender alter Katalog wird bewusst NICHT gelöscht — von
  //    einer customized toml mit weiterbestehendem Key-Verweis lässt er
  //    sich nicht unterscheiden (never guess, kein destruktiver Write).
  // Final-Audit r2 (Medium-1): Katalog NUR schreiben, wenn das gemanagte
  // TOML den Key auch wirklich trägt — augmentierte/refreshed Dateien
  // referenzieren ihn per Design NICHT (kein Top-Level-Routing), ein
  // geschriebener Katalog wäre ein Orphan mit täuschendem Deploy-Report.
  const tomlNow = tryOr(() => readFileSync(tomlPath, "utf-8"), "");
  const catalogReferenced = tomlNow.includes(tomlString(catalogPath));
  if (built && modelCatalog && action !== "note (customized, left intact)" && catalogReferenced) {
    const catalogFile = writeFileIfMissingOrDiffers(catalogPath, built.content);
    files.push({ path: catalogPath, action: catalogFile });
    logger?.info?.(
      `[${harnessId}] model catalog ${catalogPath}: ${built.included} model(s) with operator metadata` +
        (built.skipped.length > 0
          ? `; ${built.skipped.length} skipped (no contextWindow in openclaw.json — REPLACE-ALL nimmt sie aus dem codex-Picker, the 15.11 design (writer-owned file detection))`
          : ""),
    );
  } else if (built && action === "note (customized, left intact)") {
    logger?.info?.(
      `[${harnessId}] model catalog not written: config.toml is customized (adopt the key manually if wanted)`,
    );
  } else if (!built && modelCatalog) {
    logger?.info?.(
      `[${harnessId}] model catalog skipped: ${entry.models?.length ? "no model of the list has contextWindow in openclaw.json" : "no model list on the entry (models resolved to none/opt-out)"} (codex falls back to its bundled metadata)`,
    );
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
  // Default, smallModel bei Differ ebenfalls). Domain-4-Audit r3: OHNE models
  // bleibt smallModel eine dangling Reference (small_model zeigt auf eine
  // id, die in der Map nicht existiert) — daher wird smallModel bei
  // Differenz zu entry.model IMMER mitgenommen, auch ohne models-Liste.
  let modelIds: string[];
  if (entry.models && entry.models.length > 0) {
    modelIds = dedupeModelIds([entry.model, ...entry.models, smallModel]);
  } else if (smallModel !== entry.model) {
    modelIds = [entry.model, smallModel];
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
 * opencode.jsonc Lebenszyklus (Augment-Design, GaRoN 2026-10-16 GO):
 *  1. fehlt → created (Writer-Vollform, 0600)
 *  2. byte-identisch → unchanged
 *  3. Writer-eigene Datei (exakt unser Vollform-Shape: nur unsere Keys +
 *     $schema) → updated (bytes-sync)
 *  4. fremd, valides plain JSON → MERGE: unser provider-Block wandert in
 *     `provider`, alle Operator-Keys (theme, andere provider, model-Wahl)
 *     bleiben erhalten; model/small_model NICHT angetastet (Operator-
 *     Entscheidung, mit/ohne Plugin wechselbar). 0600 erzwungen (apiKey).
 *  5. fremd mit Kommentaren/unkonventionell → NOTE (never destroy
 *     formatting; adopt manuell).
 */
function manageOpencodeJsonc(
  path: string,
  desired: string,
  entry: HarnessConfigEntry,
  warnings: string[],
): FileAction {
  const exists = existsSync(path);
  const current = exists ? tryOr(() => readFileSync(path, "utf-8"), null) : null;
  if (!exists) {
    atomicWrite(path, desired, 0o600, warnings);
    return "created";
  }
  if (current === desired) {
    // r3: Mode-Heilung auch bei byte-identischem Bestand (0600-Pflicht, apiKey).
    try {
      if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
    } catch (error) {
      warnings.push(`could not chmod ${path}: ${briefError(error)}`);
    }
    return "unchanged";
  }
  if (current === null) {
    warnings.push(`opencode: ${path} unreadable; leaving intact`);
    return "note (customized, left intact)";
  }
  // Writer-eigene Datei? Unser Vollform-Shape parsen und mit dem gewünschten
  // Objekt vergleichen (Keys-identisch → updated via bytes-sync).
  const desiredObj = tryOr(() => JSON.parse(desired) as Record<string, unknown>, null);
  const currentObj = tryOr(() => JSON.parse(current) as Record<string, unknown>, null);
  if (desiredObj === null || currentObj === null) {
    // current ist kein plain JSON (JSONC mit Kommentaren o.ä.) → never destroy.
    warnings.push(
      `opencode: ${path} is customized (non-JSON or commented JSONC); leaving intact — ` +
        `adopt the provider block manually if wanted`,
    );
    return "note (customized, left intact)";
  }
  // Final-Audit r2 (HIGH-4/F1): Writer-Erkennung muss POSITIV sein, nicht
  // Key-Subset — {"model": …} oder ein fremder einzelner Provider sind
  // legitime Operator-Dateien und dürfen NIEMALS still ersetzt werden.
  // Writer-owned = $schema passt UND provider enthält GENAU unsere derived
  // ProviderId mit deepEquals-identischem Block UND alle übrigen Keys sind
  // aus {$schema, model, small_model} mit Werten gleich dem Desired-Stand.
  const providerId = deriveProviderId(entry.baseUrl ?? "");
  const currentProviderObj =
    typeof currentObj.provider === "object" && currentObj.provider !== null &&
      !Array.isArray(currentObj.provider)
      ? (currentObj.provider as Record<string, unknown>)
      : null;
  const desiredProviderObj2 =
    typeof desiredObj?.provider === "object" && desiredObj.provider !== null &&
      !Array.isArray(desiredObj.provider)
      ? (desiredObj.provider as Record<string, unknown>)
      : null;
  // r2-final: Struktur-Marker (npm/name) statt reiner Key-Präsenz — ein
  // Fremd-Block mit UNSERER derived providerId, aber anderem Inhalt, geht
  // in den Merge-Pfad (dort operator-wins-NOTE), nie in den Writer-Replace.
  // Die Marker sind sync-on-diff-stabil (npm/name ändern sich bei Modell-
  // Listen-Änderungen nicht).
  const providerIdInDesired =
    currentProviderObj !== null && desiredProviderObj2 !== null &&
    Object.keys(currentProviderObj).length === 1 &&
    providerId in currentProviderObj &&
    deepLooksGenerated(currentProviderObj[providerId]);
  // Struktur-Marker statt Content-Gleichheit (r2-Fix der r2-Fixes): der
  // Sync-on-Diff-Refresh lebt davon, dass Bestand ≠ Desired ist — Writer-
  // Owned wird an der GENERIERTEN BLOCKFORM erkannt (npm/name-Marker), nicht
  // am aktuellen Content. Ein fremder Block mit unserer providerId geht in
  // den Merge-Pfad (dort operator-wins-NOTE bei abweichendem Content).
  const isWriterOwned =
    typeof currentObj === "object" && currentObj !== null && desiredObj !== null &&
    currentObj.$schema === desiredObj.$schema &&
    providerIdInDesired &&
    Object.keys(currentObj).every((key) => {
      // $schema/provider sind oben geprüft; model/small_model sind Writer-
      // Keys, deren CONTENT sich beim Sync-on-Diff legitim ändert — daher
      // hier NUR Key-Set-Prüfung, keine Content-Gleichheit (r2-Fix).
      return key === "$schema" || key === "provider" || key === "model" || key === "small_model";
    });
  if (isWriterOwned) {
    atomicWrite(path, desired, 0o600, warnings);
    return "updated";
  }
  // MERGE: Operator-Keys erhalten; nur unser provider-Block wandert rein.
  const desiredProviderObj =
    typeof desiredObj?.provider === "object" && desiredObj.provider !== null &&
      !Array.isArray(desiredObj.provider)
      ? (desiredObj.provider as Record<string, unknown>)
      : {};
  const desiredProvider = desiredProviderObj[providerId];
  const merged: Record<string, unknown> = { ...currentObj };
  // Final-Audit r2 (F2): provider als non-object (opencode Shorthand
  // `provider: "ollama"`) ist eine Operator-Entscheidung — niemals spread-en
  // (sonst Index-Key-Korruption); operator wins → NOTE.
  if (desiredProvider !== undefined && merged.provider !== undefined &&
      (typeof merged.provider !== "object" || merged.provider === null || Array.isArray(merged.provider))) {
    warnings.push(
      `opencode: 'provider' in ${path} is not an object (operator shorthand); leaving intact — ` +
        `adopt the provider block manually if wanted`,
    );
    return "note (customized, left intact)";
  }
  const mergedProvider: Record<string, unknown> = {
    ...((merged.provider as Record<string, unknown> | undefined) ?? {}),
  };
  if (desiredProvider !== undefined) {
    if (providerId in mergedProvider && !deepEqualsWriter(mergedProvider[providerId], desiredProvider)) {
      warnings.push(
        `opencode: provider '${providerId}' already present in ${path} with different content; ` +
          `operator wins, not overwriting — adopt manually if wanted`,
      );
      return "note (customized, left intact)";
    }
    mergedProvider[providerId] = desiredProvider;
  }
  merged.provider = mergedProvider;
  const next = `${JSON.stringify(merged, null, 2)}\n`;
  if (next === current) return "unchanged";
  atomicWrite(path, next, 0o600, warnings);
  return "augmented";
}

/** Struktur-Gleichheit für Merge-Konflikt-Erkennung (JSON-Werte). */
/**
 * Struktur-Erkennung für Writer-generierte opencode-Provider-Blöcke
 * (Final-Audit r2): der Block ist an seiner generierten Form erkennbar —
 * npm "@ai-sdk/openai-compatible" UND name-Präfix "harness-config-writer (".
 * Robust gegen Content-Änderungen (Sync-on-Diff-Refresh!) und gegen
 * Fremd-Blöcke (openrouter o.ä. matchen nicht).
 */
function deepLooksGenerated(block: unknown): boolean {
  if (typeof block !== "object" || block === null || Array.isArray(block)) return false;
  const b = block as Record<string, unknown>;
  return (
    b.npm === "@ai-sdk/openai-compatible" &&
    typeof b.name === "string" &&
    b.name.startsWith("harness-config-writer (")
  );
}

function deepEqualsWriter(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  const ka = Object.keys(a as Record<string, unknown>).sort();
  const kb = Object.keys(b as Record<string, unknown>).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) =>
    deepEqualsWriter(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}

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
    // M3-Fix (2026-10-14): die Datei trägt den apiKey in Klartext → 0600
    // (Helper-Standard; Mode geht in atomicWrite — kein Exposé-Fenster).
    const action = manageOpencodeJsonc(path, desired, entry, warnings);
    if (action !== "unchanged") {
      logger?.info?.(`[${harnessId}] ${action} ${path} (provider config)`);
    }
    files.push({ path, action });
  }
  // Legacy TOML neutralisieren — NUR wenn sie fehlt oder bereits der
  // comment-only Placeholder ist (Augment-Design: echte Operator-Configs
  // mit TOML-Inhalt werden NICHT mehr übeschrieben → NOTE + Warnung).
  const legacy = join(paths.acpxDir, "opencode-home", "config.toml");
  let legacyAction: FileAction;
  if (existsSync(legacy)) {
    const legacyCurrent = tryOr(() => readFileSync(legacy, "utf-8"), null);
    if (legacyCurrent === OPENCODE_LEGACY_PLACEHOLDER) {
      legacyAction = "unchanged";
    } else {
      warnings.push(
        `opencode: legacy ${legacy} has real operator content; leaving intact — ` +
          `the provider config lives in opencode.jsonc alongside it`,
      );
      legacyAction = "note (customized, left intact)";
    }
  } else {
    legacyAction = writeFileIfMissingOrDiffers(legacy, OPENCODE_LEGACY_PLACEHOLDER);
    if (legacyAction !== "unchanged") {
      logger?.info?.(`[${harnessId}] Placed legacy opencode config.toml placeholder`);
    }
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
    "plugins.entries.acpx.config.agents.<id>.command/args — the 15.2 design (the three mechanisms: FILE / ENV / NONE).",
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
  const envVarKeys = Object.keys(mapping.vars).sort();
  const secret = /API_KEY|AUTH_TOKEN|TOKEN/.test(envVarKeys.join("|"));
  // Enthält Tokens/Keys → 0600 wie codex auth.json (M3-Verfahren: Mode am
  // TMP VOR dem rename — kein Exposé-Fenster).
  const action = writeFileIfMissingOrDiffers(path, content, secret ? 0o600 : undefined, mapping.warnings);
  if (action !== "unchanged") {
    logger?.info?.(`[${harnessId}] ${action} ${path} (${envVarKeys.join(", ")})`);
  }
  if (secret) {
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
 * C (NONE, Additiv-Garantie: cursor + alle nicht katalogisierten ids
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
    // Domain-4-Audit r3: per-Harness fail-soft — ein atomicWrite-Throw
    // (EACCES/ENOSPC/EROFS o. ä.) kollabierte vormals die GESAMTE Loop über
    // den top-level register try/catch in eine "deployment failed"-Zeile.
    // Jetzt: jede Iteration einzeln try/catch → ein kaputtes Ziel skipt nur
    // sich selbst mit Warning, alle anderen Harnesses deployen weiter.
    try {
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
    } catch (error) {
      results.push({
        harnessId,
        mechanism: "none",
        warnings: [
          `deploy fehlgeschlagen (fail-soft, andere Harnesses laufen weiter): ${briefError(error)}`,
        ],
        files: [],
      });
    }
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