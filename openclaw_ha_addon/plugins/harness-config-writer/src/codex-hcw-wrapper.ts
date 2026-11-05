/**
 * Schritt 4 (Weg A'): HCW-eigener Codex-ACP-Wrapper.
 *
 * Der acpx-Wrapper ruft diesen Wrapper via
 *   --openclaw-run-configured <this-wrapper> <adapter-args>
 * auf. Der HCW-Wrapper ist ein eigener Prozess und darf daher CODEX_HOME in
 * seiner ENV auf ein eigenes Home setzen. Er schreibt auth.json + config.toml
 * + model-catalog.json selbst (idempotent) und startet den Adapter direkt.
 *
 * Format-Quellen (live aus laufendem acpx-Wrapper belegt):
 *   - auth.json: {OPENAI_API_KEY: <key>, tokens: null, last_refresh: null}, mode 0600
 *   - config.toml: Signatur, model, model_provider, model_reasoning_effort,
 *     model_catalog_json (absoluter Pfad, vor erster Tabelle), sandbox_mode,
 *     [model_providers.*], [projects.*]
 *   - Adapter-Start: node <installedBinPath> (Fallback npm exec / npx)
 *
 * WICHTIG: Nur der codex-Pfad wird angefasst - andere Harness-Pfade bleiben
 * unverandert. Die plugin-generierte Datei ~/.openclaw/acpx/codex-acp-wrapper.mjs
 * wird NICHT verandert.
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
  const catalogJson = builtCatalog ? builtCatalog.content : null;
  const authJson = buildCodexHcwAuthJson(entry.apiKey ?? "ollama");

  const installedBinPath = resolve(
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
  renameSync,
  rmSync,
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
const CATALOG_JSON = ${catalogJson ? JSON.stringify(catalogJson) : "null"};
const AUTH_JSON = ${JSON.stringify(authJson)};
const POST_TURN_COMPACT = ${JSON.stringify(postTurnCompactThresholdPercent)};
const SIGNATURE_LINE = ${signatureLine};

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
  if (!existsSync(CONFIG_PATH)) {
    atomicWrite(CONFIG_PATH, CONFIG_TOML);
    return "created";
  }
  const current = readText(CONFIG_PATH);
  if (current === null) {
    process.stderr.write("[hcw-codex-wrapper] " + CONFIG_PATH + " unreadable; leaving intact\\n");
    return "note (customized, left intact)";
  }
  if (current === CONFIG_TOML) return "unchanged";
  if (current.startsWith(SIGNATURE_LINE)) {
    atomicWrite(CONFIG_PATH, CONFIG_TOML);
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

function writeCatalogIfReferenced() {
  if (!CATALOG_JSON) return "skipped";
  const current = readText(CONFIG_PATH) ?? "";
  if (!current.includes(JSON.stringify(CATALOG_PATH))) return "not referenced";
  if (existsSync(CATALOG_PATH) && readText(CATALOG_PATH) === CATALOG_JSON) return "unchanged";
  atomicWrite(CATALOG_PATH, CATALOG_JSON);
  return "created/updated";
}

function resolveAdapterCommand() {
  const installed = ${JSON.stringify(installedBinPath)};
  if (installed && existsSync(installed)) {
    return { command: process.execPath, args: [installed] };
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
  const catalogAction = writeCatalogIfReferenced();

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
