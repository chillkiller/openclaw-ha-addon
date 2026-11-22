/**
 * Entry-Level-Tests (Audit B2, 2026-10-11): das ENV-Gate an der
 * register-Surface — beide Option-ENVs je Kombination, Write/No-Write hart
 * gegen das Dateisystem bewiesen (Gateway-Boot-Ebene: Helper-Restore muss
 * Writer-Boots überleben können, wenn die Option OFF ist).
 *
 * Multi-Model γ (2026-10-13): Config-Zufuhr ist `api.pluginConfig` (dist:
 * validated plugins.entries[id].config) mit Fallback-Drill über die volle
 * `api.config` — der vormalige `api.config.harnesses`-Read war ein stiller
 * No-op (BUG-Fix, hier fs-bewiesen). Plus Modellkatalog-Matching End-to-End
 * (api.config.models.providers → claude.env CLAUDE_MODEL_CONFIG).
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ts from "typescript";

// SDK-Mock VOR dem import (hoisted): index.ts bindet den Entry-Spec nur ein.
vi.mock("openclaw/plugin-sdk/core", () => ({
  definePluginEntry: (spec: unknown) => spec,
}));

// eslint-disable-next-line import/order
import { registerHarnessConfigDeployment, resolveWriterGate } from "./index.js";

type Logger = {
  debug?: (m: string) => void;
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
};

type ApiOptions = {
  /** Entry-Config (dist: api.pluginConfig = validated plugins.entries[id].config). */
  harnesses?: Record<string, unknown>;
  /** γ: harnesses NUR über den Fallback-Drill der vollen Config anboten. */
  viaFullConfig?: boolean;
  /** γ: volle Gateway-Config (models.providers-Katalog etc.). */
  fullConfig?: Record<string, unknown>;
  /** M2: Legacy-Key (A2-Vorläufer) unterm acp-dashboard-binding Entry. */
  legacyHarnesses?: Record<string, unknown>;
};

function makeApi(options: ApiOptions = {}): {
  api: { config: Record<string, unknown>; pluginConfig: Record<string, unknown>; logger: Logger };
  logs: string[];
} {
  const logs: string[] = [];
  const logger: Logger = {
    debug: (m) => logs.push(`debug: ${m}`),
    info: (m) => logs.push(`info: ${m}`),
    warn: (m) => logs.push(`warn: ${m}`),
    error: (m) => logs.push(`error: ${m}`),
  };
  const pluginConfig: Record<string, unknown> = {};
  const config: Record<string, unknown> = { ...(options.fullConfig ?? {}) };
  if (options.harnesses !== undefined) {
    if (options.viaFullConfig) {
      config.plugins = {
        entries: { "harness-config-writer": { config: { harnesses: options.harnesses } } },
      };
    } else {
      pluginConfig.harnesses = options.harnesses;
    }
  }
  if (options.legacyHarnesses !== undefined) {
    config.plugins = {
      ...(config.plugins as Record<string, unknown> | undefined),
      entries: {
        ...((config.plugins as { entries?: Record<string, unknown> } | undefined)?.entries ?? {}),
        "acp-dashboard-binding": { config: { harnesses: options.legacyHarnesses } },
      },
    } as Record<string, unknown>;
  }
  return { api: { config, pluginConfig, logger }, logs };
}

const CODEX_ENTRY = { model: "audit-m", baseUrl: "http://b:1234" };

function codexTomlPath(root: string): string {
  return join(root, ".codex", "config.toml");
}

function claudeEnvPath(root: string): string {
  return join(root, "state", "acpx", "harness-env", "claude.env");
}

describe("resolveWriterGate (ENV-Gate, Audit B2)", () => {
  let env: Record<string, string>;

  beforeEach(() => {
    env = {};
  });

  it("explicit writer=on enables the writer independently of other plugin flags", () => {
    env.HARNESS_CONFIG_WRITER_ENABLED = "true";
    env.ACP_DASHBOARD_BINDING_ENABLED = "false";
    expect(resolveWriterGate(env)).toBe(true);
  });

  it("explicit writer=false is the negative control even when the obsolete binding flag is on", () => {
    env.HARNESS_CONFIG_WRITER_ENABLED = "false";
    env.ACP_DASHBOARD_BINDING_ENABLED = "true";
    expect(resolveWriterGate(env)).toBe(false);
  });

  it("unset/empty writer stays off when the obsolete binding flag is on (no fallback)", () => {
    env.HARNESS_CONFIG_WRITER_ENABLED = "";
    env.ACP_DASHBOARD_BINDING_ENABLED = "true";
    expect(resolveWriterGate(env)).toBe(false);
    delete env.HARNESS_CONFIG_WRITER_ENABLED;
    expect(resolveWriterGate(env)).toBe(false);
  });

  it("both empty/unset = off (Phase-2.15-Default)", () => {
    env.HARNESS_CONFIG_WRITER_ENABLED = "";
    delete env.ACP_DASHBOARD_BINDING_ENABLED;
    expect(resolveWriterGate(env)).toBe(false);
  });

  it("case-insensitive truthy tokens (helper _env_flag mirror)", () => {
    env.HARNESS_CONFIG_WRITER_ENABLED = "TRUE";
    expect(resolveWriterGate(env)).toBe(true);
    env.HARNESS_CONFIG_WRITER_ENABLED = "on";
    expect(resolveWriterGate(env)).toBe(true);
    env.HARNESS_CONFIG_WRITER_ENABLED = "junk";
    expect(resolveWriterGate(env)).toBe(false);
  });
});

describe("registerHarnessConfigDeployment — ENV-Gate-Verdrahtung am Entry", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "writer-entry-gate-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.HARNESS_CONFIG_WRITER_ENABLED;
    delete process.env.ACP_DASHBOARD_BINDING_ENABLED;
  });

  function boot(envOver: Record<string, string | undefined>) {
    process.env.OPENCLAW_STATE_DIR = join(root, "state");
    process.env.HARNESS_CONFIG_WRITER_ENABLED = envOver.HARNESS_CONFIG_WRITER_ENABLED ?? "";
    if (envOver.ACP_DASHBOARD_BINDING_ENABLED === undefined) {
      delete process.env.ACP_DASHBOARD_BINDING_ENABLED;
    } else {
      process.env.ACP_DASHBOARD_BINDING_ENABLED = envOver.ACP_DASHBOARD_BINDING_ENABLED;
    }
  }

  it("gate ON (writer=true, binding=false) → config.toml written", () => {
    boot({ HARNESS_CONFIG_WRITER_ENABLED: "true", ACP_DASHBOARD_BINDING_ENABLED: "false" });
    const { api } = makeApi({ harnesses: { codex: CODEX_ENTRY } });
    registerHarnessConfigDeployment(api as never);
    const toml = codexTomlPath(root);
    expect(existsSync(toml)).toBe(true);
    expect(readFileSync(toml, "utf-8")).toContain("[model_providers.");
  });

  it("gate OFF (writer=false, binding=true) → operator veto wins, NO write", () => {
    boot({ HARNESS_CONFIG_WRITER_ENABLED: "false", ACP_DASHBOARD_BINDING_ENABLED: "true" });
    const { api, logs } = makeApi({ harnesses: { codex: CODEX_ENTRY } });
    registerHarnessConfigDeployment(api as never);
    expect(existsSync(codexTomlPath(root))).toBe(false);
    expect(logs.join("\n")).toContain("inactive by env gate");
  });

  it("writer empty + obsolete binding=on → NO write (explicit-enable negative control)", () => {
    boot({ HARNESS_CONFIG_WRITER_ENABLED: "", ACP_DASHBOARD_BINDING_ENABLED: "true" });
    const { api, logs } = makeApi({ harnesses: { codex: CODEX_ENTRY } });
    registerHarnessConfigDeployment(api as never);
    expect(existsSync(codexTomlPath(root))).toBe(false);
    expect(logs.join("\n")).toContain("explicit enable required");
    expect(logs.join("\n")).not.toContain("follows ACP_DASHBOARD_BINDING_ENABLED");
  });

  it("writer empty + binding empty/unset → off, NO write despite harnesses config", () => {
    boot({ HARNESS_CONFIG_WRITER_ENABLED: "" });
    const { api, logs } = makeApi({ harnesses: { codex: CODEX_ENTRY } });
    registerHarnessConfigDeployment(api as never);
    expect(existsSync(codexTomlPath(root))).toBe(false);
    expect(logs.join("\n")).toContain("inactive by env gate");
  });

  it("gate ON + no harnesses section → still no write (ADDITIV-GARANTIE)", () => {
    boot({ HARNESS_CONFIG_WRITER_ENABLED: "true" });
    const { api } = makeApi();
    registerHarnessConfigDeployment(api as never);
    expect(existsSync(codexTomlPath(root))).toBe(false);
  });

  it("loads and deploys from a tree containing only harness-config-writer", () => {
    const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
    const pluginsRoot = join(root, "standalone", "plugins");
    const isolatedPlugin = join(pluginsRoot, "harness-config-writer");
    const topLevelRuntimeFiles = new Set(["index.ts", "openclaw.plugin.json", "package.json"]);
    cpSync(sourceRoot, isolatedPlugin, {
      recursive: true,
      filter: (source) => {
        const rel = relative(sourceRoot, source);
        return rel === "" || topLevelRuntimeFiles.has(rel) || rel === "src" ||
          (rel.startsWith(`src${sep}`) && !rel.endsWith(".test.ts"));
      },
    });

    // The old plugin directory and its manifest do not exist in this tree.
    expect(readdirSync(pluginsRoot)).toEqual(["harness-config-writer"]);
    expect(existsSync(join(pluginsRoot, "acp-dashboard-binding"))).toBe(false);

    // Static guard in addition to the runtime absence proof: no runtime module
    // may import the removed plugin or read its manifest.
    const runtimeFiles = [
      join(isolatedPlugin, "index.ts"),
      ...readdirSync(join(isolatedPlugin, "src"))
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
        .map((name) => join(isolatedPlugin, "src", name)),
    ];
    for (const file of runtimeFiles) {
      const source = readFileSync(file, "utf-8");
      expect(source).not.toMatch(/from\s+["'][^"']*acp-dashboard-binding/);
      expect(source).not.toMatch(/(?:import|require)\s*\(\s*["'][^"']*acp-dashboard-binding/);
      expect(source.includes("acp-dashboard-binding") && source.includes("openclaw.plugin.json")).toBe(false);
      const transpiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
        fileName: file,
      });
      writeFileSync(file.replace(/\.ts$/, ".js"), transpiled.outputText, "utf-8");
    }

    // Run the real entry in a fresh Node process. The only host stub is the
    // definePluginEntry SDK surface; it lives outside the plugin catalogue.
    const sdkRoot = join(root, "standalone", "node_modules", "openclaw");
    mkdirSync(join(sdkRoot, "plugin-sdk"), { recursive: true });
    writeFileSync(join(sdkRoot, "package.json"), JSON.stringify({
      name: "openclaw",
      type: "module",
      exports: { "./plugin-sdk/core": "./plugin-sdk/core.js" },
    }), "utf-8");
    writeFileSync(
      join(sdkRoot, "plugin-sdk", "core.js"),
      "export const definePluginEntry = (spec) => spec;\n",
      "utf-8",
    );
    const runner = join(root, "standalone", "run.mjs");
    writeFileSync(runner, `
import entry from "./plugins/harness-config-writer/index.js";
const api = {
  config: {},
  pluginConfig: { harnesses: { codex: ${JSON.stringify(CODEX_ENTRY)} } },
  logger: {
    debug() {}, info() {}, warn() {},
    error(message) { throw new Error(message); },
  },
};
entry.register(api);
`, "utf-8");
    const child = spawnSync(process.execPath, [runner], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: join(root, "state"),
        HARNESS_CONFIG_WRITER_ENABLED: "true",
        ACP_DASHBOARD_BINDING_ENABLED: "true",
      },
      encoding: "utf-8",
      timeout: 20_000,
    });
    expect(child.status, `${child.stdout}\n${child.stderr}\n${child.error?.message ?? ""}`).toBe(0);
    expect(readFileSync(codexTomlPath(root), "utf-8")).toContain("[model_providers.");
  });
});

describe("registerHarnessConfigDeployment — PluginConfig-Zufuhr (γ-Fix)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "writer-entry-plugincfg-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.HARNESS_CONFIG_WRITER_ENABLED;
    delete process.env.ACP_DASHBOARD_BINDING_ENABLED;
  });

  function bootOn() {
    process.env.OPENCLAW_STATE_DIR = join(root, "state");
    process.env.HARNESS_CONFIG_WRITER_ENABLED = "true";
  }

  it("legacy Top-Level-Shape (api.config.harnesses) wird NICHT mehr gelesen (BUG-Fix)", () => {
    // Beweis des γ-Fixes: harnesses oben auf api.config ist die VOLLE Config —
    // dort ist der Key nie gültig (dist: pluginConfig = plugins.entries[id].config).
    bootOn();
    const { api, logs } = makeApi({
      harnesses: { codex: CODEX_ENTRY },
      fullConfig: { harnesses: { codex: CODEX_ENTRY } },
    });
    registerHarnessConfigDeployment({ ...api, pluginConfig: {} } as never);
    expect(existsSync(codexTomlPath(root))).toBe(false);
  });

  it("Fallback-Drill: harnesses unter api.config.plugins.entries → write", () => {
    bootOn();
    const { api, logs } = makeApi({
      harnesses: { codex: CODEX_ENTRY },
      viaFullConfig: true,
    });
    registerHarnessConfigDeployment({ ...api, pluginConfig: {} } as never);
    expect(existsSync(codexTomlPath(root))).toBe(true);
  });

  it("M2: Legacy-Key-only (Migration lief nicht) → WARN sichtbar + NO write (kein stiller No-op)", () => {
    bootOn();
    const { api, logs } = makeApi({
      legacyHarnesses: { codex: CODEX_ENTRY },
    });
    registerHarnessConfigDeployment({ ...api, pluginConfig: {} } as never);
    expect(existsSync(codexTomlPath(root))).toBe(false);
    expect(logs.join("\n")).toContain(
      "legacy harnesses key found under plugins.entries['acp-dashboard-binding'].config",
    );
    expect(logs.join("\n")).toContain("NOT deployed (no-op)");
  });

  it("M2: gar keine harnesses (echte Absence) → logfrei (ADDITIV-GARANTIE unverändert)", () => {
    bootOn();
    const { api, logs } = makeApi();
    registerHarnessConfigDeployment({ ...api, pluginConfig: {} } as never);
    expect(existsSync(codexTomlPath(root))).toBe(false);
    expect(logs.join("\n")).not.toContain("legacy harnesses key");
  });

  it("M2 (r2): legacy key + valid pluginConfig → deploy LÄUFT, kein legacy-WARN (kein False-Positive)", () => {
    bootOn();
    const { api, logs } = makeApi({
      harnesses: { codex: CODEX_ENTRY },
      legacyHarnesses: { codex: { model: "legacy-m", baseUrl: "http://b:9999" } },
    });
    registerHarnessConfigDeployment(api as never);
    expect(existsSync(codexTomlPath(root))).toBe(true);
    // Deploy konsumiert die eigene Entry-Config, nicht den Legacy-Key:
    expect(logs.join("\n")).not.toContain("legacy harnesses key");
    expect(readFileSync(codexTomlPath(root), "utf-8")).toContain("[model_providers.");
  });
});

describe("registerHarnessConfigDeployment — Modellkatalog-Matching (γ)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "writer-entry-catalog-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.HARNESS_CONFIG_WRITER_ENABLED;
    delete process.env.ACP_DASHBOARD_BINDING_ENABLED;
  });

  function bootOn() {
    process.env.OPENCLAW_STATE_DIR = join(root, "state");
    process.env.HARNESS_CONFIG_WRITER_ENABLED = "true";
  }

  const OLLAMA_PROVIDER = {
    baseUrl: "http://b:1234/v1",
    models: [{ id: "a" }, { id: "b" }],
  };

  it("Auto-Match End-to-End: catalog baseUrl+models → claude.env CLAUDE_MODEL_CONFIG", () => {
    bootOn();
    const { api, logs } = makeApi({
      harnesses: { claude: { model: "a", baseUrl: "http://b:1234", apiKey: "k" } },
      fullConfig: { models: { providers: { ollama: OLLAMA_PROVIDER } } },
    });
    registerHarnessConfigDeployment(api as never);
    const env = readFileSync(claudeEnvPath(root), "utf-8");
    expect(env).toContain(`CLAUDE_MODEL_CONFIG='{"availableModels":["a","b"]}'`);
    expect(env).toContain(`ANTHROPIC_MODEL='a'`);
    expect(logs.join("\n")).toContain("claude=env (models:matched)");
  });

  it("explicit entry.models wins over the catalog", () => {
    bootOn();
    const { api, logs } = makeApi({
      harnesses: {
        claude: { model: "b", baseUrl: "http://b:1234", apiKey: "k", models: ["x", "y"] },
      },
      fullConfig: { models: { providers: { ollama: OLLAMA_PROVIDER } } },
    });
    registerHarnessConfigDeployment(api as never);
    const env = readFileSync(claudeEnvPath(root), "utf-8");
    expect(env).toContain(`CLAUDE_MODEL_CONFIG='{"availableModels":["b","x","y"]}'`);
    expect(logs.join("\n")).toContain("claude=env (models:explicit)");
  });

  it("e2e (r2): entry models:[] (Opt-out) → kein CLAUDE_MODEL_CONFIG, Log meldet (models:optout)", () => {
    bootOn();
    const { api, logs } = makeApi({
      harnesses: { claude: { model: "a", baseUrl: "http://b:1234", apiKey: "k", models: [] } },
      fullConfig: { models: { providers: { ollama: OLLAMA_PROVIDER } } },
    });
    registerHarnessConfigDeployment(api as never);
    const env = readFileSync(claudeEnvPath(root), "utf-8");
    expect(env).toContain("ANTHROPIC_MODEL='a'");
    expect(env).not.toContain("CLAUDE_MODEL_CONFIG");
    expect(logs.join("\n")).toContain("claude=env (models:optout)");
  });

  it("garbage models.providers → catalog warning, deploy continues", () => {
    bootOn();
    const { api, logs } = makeApi({
      harnesses: { codex: CODEX_ENTRY },
      fullConfig: { models: { providers: "junk" } },
    });
    registerHarnessConfigDeployment(api as never);
    expect(existsSync(codexTomlPath(root))).toBe(true);
    expect(logs.join("\n")).toContain("models.providers: unexpected shape");
  });

  it("no catalog providers → no models surface, plain deploy", () => {
    bootOn();
    const { api, logs } = makeApi({
      harnesses: { codex: CODEX_ENTRY },
      fullConfig: { models: { providers: {} } },
    });
    registerHarnessConfigDeployment(api as never);
    const toml = readFileSync(codexTomlPath(root), "utf-8");
    expect(toml).not.toMatch(/^\[profiles\./m);
    expect(logs.join("\n")).toContain("codex=file-codex (models:none)");
  });
});