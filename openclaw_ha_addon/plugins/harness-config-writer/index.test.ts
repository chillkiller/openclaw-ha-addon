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

import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("explicit writer=on wins over binding", () => {
    env.HARNESS_CONFIG_WRITER_ENABLED = "true";
    env.ACP_DASHBOARD_BINDING_ENABLED = "false";
    expect(resolveWriterGate(env)).toBe(true);
  });

  it("explicit writer=false wins over binding=on (operator veto)", () => {
    env.HARNESS_CONFIG_WRITER_ENABLED = "false";
    env.ACP_DASHBOARD_BINDING_ENABLED = "true";
    expect(resolveWriterGate(env)).toBe(false);
  });

  it("unset writer follows binding=on (run.sh exports empty string)", () => {
    env.HARNESS_CONFIG_WRITER_ENABLED = "";
    env.ACP_DASHBOARD_BINDING_ENABLED = "true";
    expect(resolveWriterGate(env)).toBe(true);
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

  it("writer empty (run.sh unset) + binding=on → follows binding, write", () => {
    boot({ HARNESS_CONFIG_WRITER_ENABLED: "", ACP_DASHBOARD_BINDING_ENABLED: "true" });
    const { api } = makeApi({ harnesses: { codex: CODEX_ENTRY } });
    registerHarnessConfigDeployment(api as never);
    expect(existsSync(codexTomlPath(root))).toBe(true);
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