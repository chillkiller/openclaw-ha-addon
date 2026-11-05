/**
 * Schritt 4 (Weg A'): HCW-eigener Codex-ACP-Wrapper.
 *
 * Der acpx-Wrapper ruft diesen Wrapper via
 *   --openclaw-run-configured <this-wrapper> <adapter-args>
 * auf. Der HCW-Wrapper ist ein eigener Prozess und darf daher CODEX_HOME in
 * seiner ENV auf ein eigenes Home setzen. Er schreibt auth.json + config.toml
 * selbst (idempotent) und startet den Adapter direkt. Der Modellkatalog wird
 * vom Writer als separate Datei neben config.toml abgelegt; der Wrapper
 * enthält den Kataloginhalt NICHT inline, sondern prüft zur Laufzeit, ob
 * die Katalogdatei existiert, bevor er config.toml auf den Verweis schreibt.
 *
 * Format-Quellen (live aus laufendem acpx-Wrapper belegt):
 *   - auth.json: {OPENAI_API_KEY: <key>, tokens: null, last_refresh: null}, mode 0600
 *   - config.toml: Signatur, model, model_provider, model_reasoning_effort,
 *     model_catalog_json (absoluter Pfad, vor erster Tabelle), sandbox_mode,
 *     [model_providers.*], [projects.*]
 *   - Adapter-Start: node <stableBinPath> (Fallback capture -> npm exec -> npx)
 *
 * WICHTIG: Nur der codex-Pfad wird angefasst - andere Harness-Pfade bleiben
 * unverändert. Die plugin-generierte Datei ~/.openclaw/acpx/codex-acp-wrapper.mjs
 * wird NICHT verändert.
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { HarnessConfigEntry, HarnessWriterPaths, ModelCatalog } from "./harness-config-writer.js";
import {
  buildCodexConfigToml,
  buildCodexModelCatalogJson,
  normalizeBaseUrlForMatch,
  type HarnessDeployFile,
} from "./harness-config-writer.js";

export const HCW_WRAPPER_NAME = "codex-acp-hcw-wrapper.mjs";
export const HCW_CODEX_HOME_DIR = "codex-home-hcw";
export const HCW_CATALOG_FILE = "model-catalog.json";
export const HCW_CONFIG_FILE = "config.toml";
export const HCW_AUTH_FILE = "auth.json";

/** Relativer Pfad vom Wrapper-Verzeichnis zum stabilen acpx-Extension-Install. */
const STABLE_ADAPTER_REL_PATH = "../extensions/acpx/node_modules/@agentclientprotocol/codex-acp/dist/index.js";

/** Mirror-Datei im Wrapper-Verzeichnis (add-on layout, vom add-on helper geschrieben). */
export const ADAPTER_MIRROR_FILE = "adapter-paths.json";

export function resolveCodexHcwWrapperPath(paths: HarnessWriterPaths): string {
  return join(paths.acpxDir, HCW_WRAPPER_NAME);
}

export function resolveCodexHcwHomePath(paths: HarnessWriterPaths): string {
  return join(paths.acpxDir, HCW_CODEX_HOME_DIR);
}

export function resolveCodexHcwConfigPath(paths: HarnessWriterPaths): string {
  return join(resolveCodexHcwHomePath(paths), HCW_CONFIG_FILE);
}

export function resolveCodexHcwAuthPath(paths: HarnessWriterPaths): string {
  return join(resolveCodexHcwHomePath(paths), HCW_AUTH_FILE);
}

export function resolveCodexHcwCatalogPath(paths: HarnessWriterPaths): string {
  return join(resolveCodexHcwHomePath(paths), HCW_CATALOG_FILE);
}

export function buildCodexHcwAuthJson(apiKey: string): string {
  return `${JSON.stringify(
    { OPENAI_API_KEY: apiKey, tokens: null, last_refresh: null },
    null,
    2,
  )}\n`;
}

export function buildCodexHcwConfigToml(
  entry: HarnessConfigEntry,
  catalogPath?: string,
  postTurnCompactThresholdPercent?: number,
): string {
  return buildCodexConfigToml(entry, catalogPath, postTurnCompactThresholdPercent);
}

export function buildCodexHcwWrapperScript(
  entry: HarnessConfigEntry,
  paths: HarnessWriterPaths,
  modelCatalog?: ModelCatalog,
): string {
  const homeDir = resolveCodexHcwHomePath(paths);
  const authPath = resolveCodexHcwAuthPath(paths);
  const configPath = resolveCodexHcwConfigPath(paths);
  const catalogPath = resolveCodexHcwCatalogPath(paths);

  const normalizedBaseUrl = normalizeBaseUrlForMatch(entry.baseUrl ?? "");
  const providerPolicy = modelCatalog?.policyByBaseUrl.get(normalizedBaseUrl);
  const postTurnCompactThresholdPercent = providerPolicy?.postTurnCompactThresholdPercent ?? 70;

  const builtCatalog =
    modelCatalog && entry.models !== undefined && entry.models.length > 0
      ? buildCodexModelCatalogJson(entry.models, modelCatalog.metaById, [])
      : null;

  const configToml = buildCodexHcwConfigToml(
    entry,
    builtCatalog ? catalogPath : undefined,
    postTurnCompactThresholdPercent,
  );
  const authJson = buildCodexHcwAuthJson(entry.apiKey ?? "ollama");

  // Fallback Capture-Pfad (legacy): aus dem Writer-Source-Stand zur
  // Generierungszeit abgeleitet. Wird nur geprüft, wenn der stabile
  // Extension-Pfad nicht existiert.
  const captureBinPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".openclaw",
    "extensions",
    "acpx",
    "node_modules",
    "@agentclientprotocol",
    "codex-acp",
    "dist",
    "index.js",
  );

  const signatureLine = JSON.stringify(
    buildCodexConfigToml({ model: "", baseUrl: "http://localhost:11434" }, undefined, 70).split("\n")[0] ?? "# harness-config-writer (generated)",
  );

  return `#!/usr/bin/env node
// HCW-eigener Codex-ACP-Wrapper - Schritt 4 (Weg A')
// WIRD VOM harness-config-writer PLUGIN BEI JEDEM BOOT NEU GENERIERT.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CODEX_HOME = ${JSON.stringify(homeDir)};
const AUTH_PATH = ${JSON.stringify(authPath)};
const CONFIG_PATH = ${JSON.stringify(configPath)};
const CATALOG_PATH = ${JSON.stringify(catalogPath)};
const CONFIG_TOML = ${JSON.stringify(configToml)};
const AUTH_JSON = ${JSON.stringify(authJson)};
const POST_TURN_COMPACT = ${JSON.stringify(postTurnCompactThresholdPercent)};
const SIGNATURE_LINE = ${signatureLine};
const STABLE_ADAPTER_REL_PATH = ${JSON.stringify(STABLE_ADAPTER_REL_PATH)};

function atomicWrite(filePath, content, mode) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, ".tmp-" + process.pid + "-" + Date.now());
  try {
    writeFileSync(tmp, content, { mode });
    renameSync(tmp, filePath);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function writeManagedConfigToml() {
  let desired = CONFIG_TOML;
  const hasReference = desired.includes("model_catalog_json =");
  if (hasReference && !existsSync(CATALOG_PATH)) {
    process.stderr.write("[hcw-codex-wrapper] " + CATALOG_PATH + " missing; omitting model_catalog_json reference (codex falls back to built-in catalog)\\n");
    desired = desired.split("\\n").filter((line) => !line.startsWith("model_catalog_json =")).join("\\n");
  }
  if (!existsSync(CONFIG_PATH)) {
    atomicWrite(CONFIG_PATH, desired);
    return "created";
  }
  const current = readText(CONFIG_PATH);
  if (current === null) {
    process.stderr.write("[hcw-codex-wrapper] " + CONFIG_PATH + " unreadable; leaving intact\\n");
    return "note (customized, left intact)";
  }
  if (current === desired) return "unchanged";
  if (current.startsWith(SIGNATURE_LINE)) {
    atomicWrite(CONFIG_PATH, desired);
    return "updated";
  }
  process.stderr.write("[hcw-codex-wrapper] " + CONFIG_PATH + " is customized; leaving intact\\n");
  return "note (customized, left intact)";
}

function writeAuthJson() {
  mkdirSync(dirname(AUTH_PATH), { recursive: true, mode: 0o700 });
  const apiKey = (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || "").trim();
  const content = apiKey
    ? JSON.stringify({ OPENAI_API_KEY: apiKey, tokens: null, last_refresh: null }, null, 2) + "\\n"
    : AUTH_JSON;
  atomicWrite(AUTH_PATH, content, 0o600);
}

function matchGlobSegment(pattern, name) {
  if (pattern === "*") return true;
  if (pattern.indexOf("*") < 0) return pattern === name;
  const parts = pattern.split("*");
  let index = 0;
  for (const part of parts) {
    if (part === "") continue;
    const found = name.indexOf(part, index);
    if (found < 0) return false;
    index = found + part.length;
  }
  return true;
}

function expandGlob(pattern) {
  const segments = pattern.split("/").filter((segment) => segment.length > 0);
  let current = ["/"];
  for (const segment of segments) {
    if (segment.indexOf("*") < 0) {
      current = current.map((dir) => join(dir, segment));
      continue;
    }
    const next = [];
    for (const dir of current) {
      let entries = [];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (matchGlobSegment(segment, entry)) next.push(join(dir, entry));
      }
    }
    current = next;
  }
  return current;
}

// Several plugin captures can exist in parallel (one per plugin build), so
// glob hits are ordered by modification time, newest first - a stale capture
// must never win over the current one.
function newestFirst(paths) {
  const stamped = [];
  for (const candidate of paths) {
    let mtime = 0;
    try {
      mtime = statSync(candidate).mtimeMs;
    } catch {
      mtime = 0;
    }
    stamped.push({ path: candidate, mtime });
  }
  stamped.sort((a, b) => b.mtime - a.mtime);
  return stamped.map((entry) => entry.path);
}

// Mirror contract (add-on helper writes this file next to the wrapper):
//   { "version": 1, "adapterPaths": [<abs>...], "adapterGlobs": [<abs glob>...] }
// Order: concrete paths (first existing wins) -> globs (newest match first) ->
// stable relative path -> capture path -> npm exec.
function resolveMirroredAdapterPath(wrapperDir) {
  try {
    const raw = readFileSync(resolve(wrapperDir, ${JSON.stringify(ADAPTER_MIRROR_FILE)}), "utf-8");
    const parsed = JSON.parse(raw);
    const paths = Array.isArray(parsed?.adapterPaths) ? parsed.adapterPaths : [];
    for (const candidate of paths) {
      if (typeof candidate === "string" && candidate.trim() !== "" && existsSync(candidate)) {
        return candidate;
      }
    }
    const globs = Array.isArray(parsed?.adapterGlobs) ? parsed.adapterGlobs : [];
    const hits = [];
    for (const pattern of globs) {
      if (typeof pattern !== "string" || pattern.indexOf("*") < 0) continue;
      for (const candidate of expandGlob(pattern)) {
        if (existsSync(candidate)) hits.push(candidate);
      }
    }
    const ordered = newestFirst(hits);
    return ordered.length > 0 ? ordered[0] : null;
  } catch {
    return null;
  }
}

function resolveAdapterCommand() {
  const wrapperDir = dirname(fileURLToPath(import.meta.url));
  const mirrored = resolveMirroredAdapterPath(wrapperDir);
  if (mirrored) {
    return { command: process.execPath, args: [mirrored] };
  }
  const stable = resolve(wrapperDir, STABLE_ADAPTER_REL_PATH);
  if (existsSync(stable)) {
    return { command: process.execPath, args: [stable] };
  }
  const capture = ${JSON.stringify(captureBinPath)};
  if (capture && existsSync(capture)) {
    return { command: process.execPath, args: [capture] };
  }
  const npmCliPath = resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(npmCliPath)) {
    return {
      command: process.execPath,
      args: [npmCliPath, "exec", "--yes", "--package", "@agentclientprotocol/codex-acp@2.1.1", "--", "codex-acp"],
    };
  }
  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["--yes", "--package", "@agentclientprotocol/codex-acp@2.1.1", "--", "codex-acp"],
  };
}

function main() {
  mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 });
  writeAuthJson();
  const tomlAction = writeManagedConfigToml();

  const { command, args: adapterArgs } = resolveAdapterCommand();
  const passedArgs = process.argv.slice(2);
  const args = [...adapterArgs, ...passedArgs];

  const env = { ...process.env, CODEX_HOME };

  const child = spawn(command, args, {
    detached: process.platform !== "win32",
    env,
    stdio: ["inherit", "inherit", "pipe"],
    windowsHide: true,
  });

  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));

  let childExitCode = 1;
  child.on("exit", (code) => {
    childExitCode = typeof code === "number" ? code : 1;
  });
  child.on("close", () => {
    process.exitCode = childExitCode;
  });

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.once(signal, () => {
      try { child.kill(signal); } catch {}
    });
  }
}

main();
`;
}

/** Pfadstabil: wrapperPath darf sich nicht zwischen Boots ändern. */
function readCurrentAcpxCodexCommand(config: unknown): string | undefined {
  const cfg = config as
    | {
        plugins?: {
          entries?: Record<
            string,
            { config?: { agents?: Record<string, { command?: string }> } }
          >;
        };
      }
    | undefined;
  return cfg?.plugins?.entries?.["acpx"]?.config?.agents?.codex?.command;
}

/**
 * Setzt plugins.entries.acpx.config.agents.codex.command auf den HCW-eigenen
 * Wrapper. Idempotent: wenn der Pfad bereits gesetzt ist, wird kein Write,
 * kein Reload und kein Restart ausgelöst. Bei tatsächlicher Änderung löst
 * mutateConfigFile einen Plugin-Hot-Reload aus (afterWrite.mode "auto"),
 * damit acpx den neuen Command übernimmt, ohne den Gateway neu zu starten.
 */
export async function setAcpxCodexCommand(
  api: OpenClawPluginApi,
  wrapperPath: string,
  logger?: { warn?: (message: string) => void },
): Promise<{ changed: boolean }> {
  // Pfadstabil: wrapperPath ist deterministisch aus paths.acpxDir +
  // HCW_WRAPPER_NAME; eine Pfad-Änderung würde bei jedem Boot einen Write
  // + Reload auslösen.
  const current = readCurrentAcpxCodexCommand(api.config);
  if (current === wrapperPath) {
    return { changed: false };
  }

  try {
    const mutation = await api.runtime.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        const plugins = (draft.plugins ?? {}) as Record<string, unknown>;
        const entries = (plugins.entries ?? {}) as Record<string, unknown>;
        const acpx = (entries.acpx ?? {}) as Record<string, unknown>;
        const acpxConfig = (acpx.config ?? {}) as Record<string, unknown>;
        const agents = (acpxConfig.agents ?? {}) as Record<string, unknown>;
        const codex = (agents.codex ?? {}) as Record<string, unknown>;

        if (codex.command === wrapperPath) return { changed: false };

        codex.command = wrapperPath;
        // Keine args setzen — der Wrapper bekommt alle Args vom acpx-Wrapper
        // via --openclaw-run-configured durchgereicht.
        agents.codex = codex;
        acpxConfig.agents = agents;
        acpx.config = acpxConfig;
        entries.acpx = acpx;
        plugins.entries = entries;
        draft.plugins = plugins;
        return { changed: true };
      },
    });
    return (mutation.result as { changed: boolean } | undefined) ?? { changed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn?.(`[codex-hcw] failed to mutate acpx codex command (fail-soft) — ${message}`);
    return { changed: false };
  }
}

export type CodexHcwWrapperDeployResult = {
  wrapperPath: string;
  homePath: string;
  configPath: string;
  authPath: string;
  catalogPath?: string;
  files: HarnessDeployFile[];
};

export function deployCodexHcwWrapper(
  entry: HarnessConfigEntry,
  paths: HarnessWriterPaths,
  logger?: { info?: (message: string) => void; warn?: (message: string) => void; debug?: (message: string) => void },
  modelCatalog?: ModelCatalog,
): CodexHcwWrapperDeployResult {
  const wrapperPath = resolveCodexHcwWrapperPath(paths);
  const homePath = resolveCodexHcwHomePath(paths);
  const configPath = resolveCodexHcwConfigPath(paths);
  const authPath = resolveCodexHcwAuthPath(paths);
  const catalogPath = resolveCodexHcwCatalogPath(paths);

  mkdirSync(homePath, { recursive: true, mode: 0o700 });

  const wrapperScript = buildCodexHcwWrapperScript(entry, paths, modelCatalog);
  const wrapperAction = writeWrapperIfDiffers(wrapperPath, wrapperScript);
  logger?.info?.(`[codex-hcw] wrapper ${wrapperPath}: ${wrapperAction}`);

  const normalizedBaseUrl = normalizeBaseUrlForMatch(entry.baseUrl ?? "");
  const providerPolicy = modelCatalog?.policyByBaseUrl.get(normalizedBaseUrl);
  const postTurnCompactThresholdPercent = providerPolicy?.postTurnCompactThresholdPercent ?? 70;

  const builtCatalog =
    modelCatalog && entry.models !== undefined && entry.models.length > 0
      ? buildCodexModelCatalogJson(entry.models, modelCatalog.metaById, [])
      : null;

  const configToml = buildCodexHcwConfigToml(
    entry,
    builtCatalog ? catalogPath : undefined,
    postTurnCompactThresholdPercent,
  );

  const configAction = writeIfMissingOrDiffers(configPath, configToml);

  const files: HarnessDeployFile[] = [
    { path: wrapperPath, action: wrapperAction },
    { path: configPath, action: configAction },
  ];

  const authAction = writeIfMissingOrDiffers(authPath, buildCodexHcwAuthJson(entry.apiKey ?? "ollama"), 0o600);
  files.push({ path: authPath, action: authAction });

  if (builtCatalog) {
    const catalogAction = writeIfMissingOrDiffers(catalogPath, builtCatalog.content);
    files.push({ path: catalogPath, action: catalogAction });
  }

  return { wrapperPath, homePath, configPath, authPath, catalogPath: builtCatalog ? catalogPath : undefined, files };
}


function writeIfMissingOrDiffers(path: string, content: string, mode?: number): "created" | "updated" | "unchanged" {
  if (!existsSync(path)) {
    atomicWrite(path, content, mode);
    return "created";
  }
  const current = tryOr(() => readFileSync(path, "utf-8"), null);
  if (current === content) return "unchanged";
  atomicWrite(path, content, mode);
  return "updated";
}

function writeWrapperIfDiffers(path: string, content: string): "created" | "updated" | "unchanged" {
  const desired = content.startsWith("#!/usr/bin/env node\n") ? content : `#!/usr/bin/env node\n${content}`;
  if (!existsSync(path)) {
    atomicWrite(path, desired, 0o700);
    return "created";
  }
  const current = tryOr(() => readFileSync(path, "utf-8"), null);
  if (current === desired) return "unchanged";
  atomicWrite(path, desired, 0o700);
  return "updated";
}

function atomicWrite(path: string, content: string, mode?: number, warnings?: string[]): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, content, mode !== undefined ? { mode } : undefined);
    if (mode !== undefined) {
      try {
        chmodSync(tmp, mode);
      } catch (error) {
        warnings?.push(`chmod ${path}: ${briefError(error)}`);
      }
    }
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    throw error;
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
