import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildClaudeSettingsJson,
  buildCodexConfigToml,
  buildHarnessNativeSettingsJson,
  buildKiloConfigJson,
  buildKimiConfigToml,
  buildModelCatalog,
  buildOpencodeConfigJsonc,
  buildPiModelsJson,
  buildPiSettingsJson,
  buildQwenSettingsJson,
  deployHarnessConfigs,
  deriveProviderId,
  mergeNativeConfigRecord,
  overlayCodexCatalog,
  SUPPORTED_WRITER_HARNESS_IDS,
  type HarnessConfigEntry,
  type HarnessWriterPaths,
} from "./harness-config-writer.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hcw-native-config-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function paths(home = root): HarnessWriterPaths {
  return {
    acpxDir: join(root, "state", "acpx"),
    codexSourceHome: join(root, "config", ".codex"),
    opencodeGlobalDir: join(home, ".config", "opencode"),
    claudeSourceHome: join(root, "config", ".claude"),
    piAgentDir: join(root, "config", ".pi", "agent"),
    kiloGlobalDir: join(home, ".config", "kilo"),
    qwenHome: join(home, ".qwen"),
    nativeHomes: {
      gemini: join(home, ".gemini"),
      copilot: join(home, ".copilot"),
      iflow: join(home, ".iflow"),
      droid: join(home, ".factory"),
      kiro: join(home, ".kiro"),
      kimi: join(home, ".kimi-code"),
    },
  };
}

const BASE: HarnessConfigEntry = {
  model: "main-model",
  baseUrl: "http://localhost:11434",
  apiKey: "synthetic-test-key",
};

const SILENT = { debug: () => {}, info: () => {}, warn: () => {} };

function deploy(config: unknown, p = paths()) {
  return deployHarnessConfigs(config, p, SILENT);
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
}

function writeJson(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function jsonLeafPaths(value: unknown, prefix: string[] = []): string[][] {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => jsonLeafPaths(child, [...prefix, key]));
  }
  return [prefix];
}

function writeLegacyState(configPath: string, harness: string, desired: string): void {
  writeJson(`${configPath}.hcw-managed.json`, {
    version: 1,
    harness,
    paths: jsonLeafPaths(JSON.parse(desired)),
  });
}

describe("nativeConfig schema and merge", () => {
  it("deep-merges records without mutating inputs and replaces arrays explicitly", () => {
    const base = { model: "main", nested: { keep: true, replace: "old" }, list: ["a", "b"] };
    const overlay = { nested: { replace: "new", add: 1 }, list: ["c"] };
    const merged = mergeNativeConfigRecord(base, overlay);
    expect(merged).toEqual({ model: "main", nested: { keep: true, replace: "new", add: 1 }, list: ["c"] });
    expect(base).toEqual({ model: "main", nested: { keep: true, replace: "old" }, list: ["a", "b"] });
    expect(overlay).toEqual({ nested: { replace: "new", add: 1 }, list: ["c"] });
    expect(merged.nested).not.toBe(base.nested);
  });

  it("declares all four native target objects and rejects unknown target names", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"));
    const schema = manifest.configSchema.properties.harnesses.additionalProperties.properties.nativeConfig;
    expect(Object.keys(schema.properties).sort()).toEqual(["catalog", "config", "models", "settings"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("documents every supported id and the providerKey/nativeConfig surfaces without the removed plugin", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"));
    const harnesses = manifest.configSchema.properties.harnesses;
    for (const id of SUPPORTED_WRITER_HARNESS_IDS) {
      expect(manifest.description).toContain(id);
      expect(harnesses.description).toContain(id);
    }
    expect(harnesses.additionalProperties.properties.providerKey.type).toBe("string");
    expect(Object.keys(harnesses.additionalProperties.properties.nativeConfig.properties).sort()).toEqual([
      "catalog", "config", "models", "settings",
    ]);
    expect(JSON.stringify(manifest)).not.toContain("acp-dashboard-binding");
  });

  it("warns instead of silently accepting a non-object target", () => {
    const warnings: string[] = [];
    const entry = { ...BASE, nativeConfig: { config: "invalid" } } as unknown as HarnessConfigEntry;
    buildOpencodeConfigJsonc(entry, undefined, warnings);
    expect(warnings.some((warning) => warning.includes("nativeConfig.config"))).toBe(true);
  });

  it("warns when a valid target object has no target in the selected harness", () => {
    const report = deploy({
      harnesses: { gemini: { ...BASE, nativeConfig: { config: { ignored: true } } } },
    });
    expect(report.results[0].warnings.some((warning) => warning.includes("nativeConfig.config has no native target"))).toBe(true);
  });

  it("returns unsupported-target warnings even for an unknown harness", () => {
    const report = deploy({
      harnesses: { unknownNative: { model: "m", nativeConfig: { settings: { compaction: true } } } },
    });
    expect(report.results[0].mechanism).toBe("none");
    expect(report.results[0].warnings).toEqual([
      "unknownNative: nativeConfig.settings has no native target here; ignoring it",
    ]);
  });
});

describe("Codex native config and models catalog", () => {
  it("writes review, subagent, tools, tables and table arrays without changing protected routing", () => {
    const warnings: string[] = [];
    const toml = buildCodexConfigToml({
      ...BASE,
      nativeConfig: {
        config: {
          model: "must-not-replace-generated-route",
          review_model: "review-large",
          default_subagent_model: "subagent-small",
          default_subagent_reasoning_effort: "high",
          features: { multi_agent: true },
          tools: { web_search: true },
          mcp_servers: { docs: { command: "docs-mcp", args: ["--readonly"] } },
          hooks: [{ event: "PostToolUse", command: "check" }],
        },
      },
    }, undefined, 70, warnings);
    expect(toml).toContain('"review_model" = "review-large"');
    expect(toml).toContain('"default_subagent_model" = "subagent-small"');
    expect(toml).toContain('["features"]\n"multi_agent" = true');
    expect(toml).toContain('["tools"]\n"web_search" = true');
    expect(toml).toContain('["mcp_servers"."docs"]');
    expect(toml).toContain('[["hooks"]]');
    expect(toml.match(/^model = /gm)).toHaveLength(1);
    expect(toml).toContain('model = "main-model"');
    expect(toml).not.toContain('model = "must-not-replace-generated-route"');
    expect(warnings.some((warning) => warning.includes("generated routing field is protected"))).toBe(true);
  });

  it("deep-merges native catalog metadata and supports a native-only catalog", () => {
    const entry: HarnessConfigEntry = {
      ...BASE,
      nativeConfig: { catalog: { catalogVersion: 2, defaults: { capability: "native" } } },
    };
    const merged = overlayCodexCatalog(entry, {
      content: '{"models":[{"id":"main-model","context_window":128000}]}\n',
      included: 1,
      skipped: [],
    }, []);
    const parsed = JSON.parse(merged!.content);
    expect(parsed.models[0].context_window).toBe(128000);
    expect(parsed.catalogVersion).toBe(2);
    const nativeOnly = overlayCodexCatalog(entry, null, []);
    expect(JSON.parse(nativeOnly!.content).defaults).toEqual({ capability: "native" });
  });
  it("deploys native config and catalog directly without a Codex wrapper home", () => {
    const p = paths();
    const entry: HarnessConfigEntry = {
      ...BASE,
      nativeConfig: {
        config: { review_model: "review-large", default_subagent_model: "subagent-small" },
        catalog: { catalogVersion: 7 },
      },
    };
    deploy({ harnesses: { codex: entry } }, p);
    const directToml = readFileSync(join(p.codexSourceHome, "config.toml"), "utf-8");
    expect(directToml).toContain('"review_model" = "review-large"');
    expect(directToml).toContain('"default_subagent_model" = "subagent-small"');
    expect(directToml).toContain("model_catalog_json");
    expect(existsSync(join(p.acpxDir, "codex-home-hcw"))).toBe(false);
    const directCatalog = readJson(join(p.codexSourceHome, "model-catalog.json"));
    expect(directCatalog.catalogVersion).toBe(7);
  });
});

describe("OpenCode and Pi native function fields", () => {
  it("keeps OpenCode small, subagent, agent tools and compaction fields separate", () => {
    const cfg = JSON.parse(buildOpencodeConfigJsonc({
      ...BASE,
      smallModel: "generated-small",
      nativeConfig: {
        config: {
          small_model: "native-small",
          subagent_depth: 3,
          agent: { reviewer: { model: "review-model", tools: { write: false }, compaction: { auto: false } } },
          tools: { externalTool: true },
          compaction: { auto: true, prune: true },
        },
      },
    }));
    expect(cfg.small_model).toBe("native-small");
    expect(cfg.subagent_depth).toBe(3);
    expect(cfg.agent.reviewer).toEqual({ model: "review-model", tools: { write: false }, compaction: { auto: false } });
    expect(cfg.tools).toEqual({ externalTool: true });
    expect(cfg.compaction).toEqual({ auto: true, prune: true });
  });

  it("writes Pi settings and model-file overlays independently", () => {
    const entry: HarnessConfigEntry = {
      ...BASE,
      nativeConfig: {
        settings: {
          compaction: { reserveTokens: 12345, keepRecentTokens: 20000 },
          defaultTools: ["read", "grep"],
          modelThinkingLevels: { "main-model": "high" },
          thinkingBudgets: { high: 8192 },
        },
        models: { nativeMetadata: { source: "operator" } },
      },
    };
    const settings = JSON.parse(buildPiSettingsJson(entry, "ollama", []));
    expect(settings.compaction).toEqual({ reserveTokens: 12345, keepRecentTokens: 20000 });
    expect(settings.defaultTools).toEqual(["read", "grep"]);
    expect(settings.modelThinkingLevels).toEqual({ "main-model": "high" });
    const models = JSON.parse(buildPiModelsJson(entry, "ollama"));
    expect(models.nativeMetadata).toEqual({ source: "operator" });
    expect(models.providers.ollama).toBeDefined();
  });
});

describe("sequential native deployments", () => {
  it("adds newly configured Claude settings and env config on an upgrade while preserving operator fields", () => {
    const p = paths();
    const settingsPath = join(p.claudeSourceHome, "settings.json");
    deploy({ harnesses: { claude: { ...BASE, models: ["main-model", "review-model"] } } }, p);
    const first = readJson(settingsPath);
    first.operatorSetting = { keep: true };
    writeFileSync(settingsPath, JSON.stringify(first, null, 2));

    deploy({
      harnesses: {
        claude: {
          ...BASE,
          models: ["main-model", "review-model"],
          nativeConfig: {
            config: { utilityModel: "utility-model", reviewModel: "review-model" },
            settings: {
              compaction: { enabled: true },
              env: { CLAUDE_NATIVE_FLAG: "enabled" },
              modelSettings: { "main-model": { autoCompactWindow: 222000 } },
            },
          },
        },
      },
    }, p);
    const second = readJson(settingsPath);
    expect(second.operatorSetting).toEqual({ keep: true });
    expect(second.compaction).toEqual({ enabled: true });
    expect(second.env.CLAUDE_NATIVE_FLAG).toBe("enabled");
    expect(second.modelSettings["main-model"].autoCompactWindow).toBe(222000);
    const env = readFileSync(join(p.acpxDir, "harness-env", "claude.env"), "utf-8");
    expect(env).toContain("utilityModel");
    expect(env).toContain("reviewModel");
    expect(env).toContain("ANTHROPIC_SMALL_FAST_MODEL");

    deploy({
      harnesses: {
        claude: {
          ...BASE,
          models: ["main-model", "review-model"],
          nativeConfig: {
            settings: {
              compaction: { enabled: false },
              env: { CLAUDE_NATIVE_FLAG: "changed" },
              modelSettings: { "main-model": { autoCompactWindow: 333000 } },
            },
          },
        },
      },
    }, p);
    const third = readJson(settingsPath);
    expect(third.compaction).toEqual({ enabled: false });
    expect(third.env.CLAUDE_NATIVE_FLAG).toBe("changed");
    expect(third.modelSettings["main-model"].autoCompactWindow).toBe(333000);
    expect(third.operatorSetting).toEqual({ keep: true });
  });

  it("updates Pi native settings and model metadata on later deploys", () => {
    const p = paths();
    deploy({
      harnesses: {
        pi: {
          ...BASE,
          nativeConfig: {
            settings: { compaction: { reserveTokens: 100 } },
            models: { nativeMetadata: { version: 1 } },
          },
        },
      },
    }, p);
    const settingsPath = join(p.piAgentDir, "settings.json");
    const modelsPath = join(p.piAgentDir, "models.json");
    const settings = readJson(settingsPath);
    settings.operatorSetting = "keep";
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    deploy({
      harnesses: {
        pi: {
          ...BASE,
          nativeConfig: {
            settings: { compaction: { reserveTokens: 200 } },
            models: { nativeMetadata: { version: 2 } },
          },
        },
      },
    }, p);
    expect(readJson(settingsPath).compaction.reserveTokens).toBe(200);
    expect(readJson(settingsPath).operatorSetting).toBe("keep");
    expect(readJson(modelsPath).nativeMetadata.version).toBe(2);
  });

  it("writes Kilo native roles and updates a generated route on the second deploy", () => {
    const p = paths();
    const path = join(p.kiloGlobalDir!, "kilo.json");
    const nativeConfig = {
      config: {
        small_model: "small-native",
        subagent_model: "subagent-native",
        memory_model: "memory-native",
        subagent_variant: "review",
        compaction: { auto: true },
        agent: { reviewer: { tools: { write: false } } },
      },
    };
    const first = deploy({ harnesses: { kilocode: { ...BASE, nativeConfig } } }, p);
    expect(first.results[0].mechanism).toBe("file-kilo");
    const oldProvider = deriveProviderId(BASE.baseUrl!);
    const parsed = readJson(path);
    expect(parsed.subagent_model).toBe("subagent-native");
    expect(parsed.memory_model).toBe("memory-native");
    expect(parsed.agent.reviewer.tools.write).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    deploy({ harnesses: { kilocode: { ...BASE, model: "next-model", baseUrl: "http://new-host:8000", nativeConfig } } }, p);
    const updated = readJson(path);
    expect(updated.model).toBe("binding_new_host_8000/next-model");
    expect(updated.provider[oldProvider]).toBeUndefined();
    expect(updated.provider.binding_new_host_8000).toBeDefined();
    expect(updated.subagent_model).toBe("subagent-native");
    updated.operatorKeep = { retained: true };
    writeFileSync(path, JSON.stringify(updated, null, 2));

    deploy({
      harnesses: {
        kilocode: { ...BASE, model: "third-model", baseUrl: "http://third-host:9000" },
      },
    }, p);
    const third = readJson(path);
    expect(third.model).toBe("binding_third_host_9000/third-model");
    expect(third.compaction).toBeUndefined();
    expect(third.subagent_model).toBeUndefined();
    expect(third.operatorKeep).toEqual({ retained: true });
    expect(Object.keys(third.provider)).toEqual(["binding_third_host_9000"]);
  });

  it("writes Qwen native settings without the credential and survives route changes", () => {
    const p = paths();
    const path = join(p.qwenHome!, "settings.json");
    const nativeConfig = {
      settings: {
        fastModel: "fast-model",
        review: { model: "review-model" },
        model: { chatCompression: { contextPercentageThreshold: 0.8 } },
      },
    };
    deploy({ harnesses: { qwen: { ...BASE, nativeConfig } } }, p);
    const firstText = readFileSync(path, "utf-8");
    const first = JSON.parse(firstText);
    expect(firstText).not.toContain(BASE.apiKey!);
    expect(first.fastModel).toBe("fast-model");
    expect(first.review.model).toBe("review-model");
    expect(first.model.name).toBe("main-model");
    expect(first.model.chatCompression.contextPercentageThreshold).toBe(0.8);
    first.operatorFlag = true;
    writeFileSync(path, JSON.stringify(first, null, 2));

    deploy({
      harnesses: {
        qwen: {
          ...BASE,
          model: "next-model",
          baseUrl: "http://new-host:8000",
          nativeConfig: { settings: { ...nativeConfig.settings, fastModel: "next-fast" } },
        },
      },
    }, p);
    const second = readJson(path);
    expect(second.model.name).toBe("next-model");
    expect(second.fastModel).toBe("next-fast");
    expect(second.operatorFlag).toBe(true);
    expect(second.modelProviders[deriveProviderId(BASE.baseUrl!)]).toBeUndefined();
    expect(second.modelProviders.binding_new_host_8000).toBeDefined();
    const env = readFileSync(join(p.acpxDir, "harness-env", "qwen.env"), "utf-8");
    expect(env).toContain(BASE.apiKey!);
  });

  it("keeps foreign Kimi TOML intact, while writer-owned files support secondary pools and route updates", () => {
    const p = paths();
    const providerId = deriveProviderId(BASE.baseUrl!);
    const nativeConfig = {
      config: {
        secondary_model: {
          default_model: `${providerId}/sub-model`,
          models: { [`${providerId}/sub-model`]: "Fast delegated work" },
        },
        tools: { web_search: true },
        loop_control: { max_attempts_per_step: 7 },
      },
    };
    deploy({ harnesses: { kimi: { ...BASE, models: ["sub-model"], nativeConfig } } }, p);
    const path = join(p.nativeHomes!.kimi, "config.toml");
    const first = readFileSync(path, "utf-8");
    expect(first).toContain('"default_model" = "binding_localhost_11434/main-model"');
    expect(first).toContain('["secondary_model"]');
    expect(first).toContain('["secondary_model"."models"]');
    expect(first).toContain('"binding_localhost_11434/sub-model" = "Fast delegated work"');
    expect(first).toContain('["loop_control"]\n"max_attempts_per_step" = 7');
    expect(first).toContain('"api_key_env" = "KIMI_MODEL_API_KEY"');
    expect(first).not.toContain(BASE.apiKey!);

    const secondReport = deploy({ harnesses: { kimi: { ...BASE, model: "next-model", models: ["sub-model"], nativeConfig } } }, p);
    expect(secondReport.results[0].warnings.some((warning) => warning.includes("dangling"))).toBe(false);
    const second = readFileSync(path, "utf-8");
    expect(second).toContain('"default_model" = "binding_localhost_11434/next-model"');
    expect(second).toContain('["secondary_model"]');
    expect(second).toContain('"max_context_size" = 262144');

    const beforeInvalidRouteChange = readFileSync(path, "utf-8");
    const invalidRoute = deploy({
      harnesses: {
        kimi: {
          ...BASE,
          model: "next-model",
          models: ["sub-model"],
          baseUrl: "http://new-host:8000",
          nativeConfig,
        },
      },
    }, p);
    expect(invalidRoute.results[0].warnings.some((warning) => warning.includes("secondary_model reference") && warning.includes("dangling"))).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(beforeInvalidRouteChange);

    const foreignHome = join(root, "foreign-home");
    const foreignPaths = paths(foreignHome);
    const foreignPath = join(foreignPaths.nativeHomes!.kimi, "config.toml");
    mkdirSync(foreignPaths.nativeHomes!.kimi, { recursive: true });
    writeFileSync(foreignPath, 'default_model = "operator/model"\n');
    const report = deploy({ harnesses: { kimi: { ...BASE, models: ["sub-model"], nativeConfig } } }, foreignPaths);
    expect(readFileSync(foreignPath, "utf-8")).toBe('default_model = "operator/model"\n');
    expect(report.results[0].warnings.some((warning) => warning.includes("operator-owned"))).toBe(true);
  });
});

describe("foreign managed-state ownership", () => {
  it("keeps both foreign OpenCode targets byte-idempotent while syncing providers and native overlays", () => {
    const p = paths();
    const targets = [
      join(p.acpxDir, "opencode-home", "opencode.jsonc"),
      join(p.opencodeGlobalDir, "opencode.jsonc"),
    ];
    const foreignProvider = { npm: "operator-provider", options: { baseURL: "http://operator.example/v1" } };
    for (const path of targets) writeJson(path, {
      model: "operator/op-choice",
      small_model: "operator/small-choice",
      theme: "operator-theme",
      provider: { foreign: foreignProvider },
    });
    const initial = {
      harnesses: {
        opencode: {
          ...BASE,
          smallModel: "generated-small",
          nativeConfig: { config: { compaction: { auto: true }, agent: { reviewer: { tools: { write: false } } } } },
        },
      },
    };
    deploy(initial, p);
    const providerA = deriveProviderId(BASE.baseUrl!);
    for (const path of targets) {
      const value = readJson(path);
      expect(value.model).toBe("operator/op-choice");
      expect(value.small_model).toBe("operator/small-choice");
      expect(value.provider.foreign).toEqual(foreignProvider);
      expect(value.provider[providerA]).toBeDefined();
      expect(value.compaction).toEqual({ auto: true });
      const state = readJson(`${path}.hcw-managed.json`);
      expect(state.ownership).toBe("augmented");
      expect(state.paths).not.toContainEqual(["model"]);
      expect(state.paths).not.toContainEqual(["small_model"]);
    }
    const firstBytes = targets.flatMap((path) => [path, `${path}.hcw-managed.json`]).map((path) => readFileSync(path, "utf-8"));
    const secondReport = deploy(initial, p);
    expect(secondReport.results[0].files.every((file) => file.action === "unchanged")).toBe(true);
    expect(targets.flatMap((path) => [path, `${path}.hcw-managed.json`]).map((path) => readFileSync(path, "utf-8"))).toEqual(firstBytes);

    for (const path of targets) {
      const statePath = `${path}.hcw-managed.json`;
      const legacy = readJson(statePath);
      delete legacy.ownership;
      writeJson(statePath, legacy);
    }
    const routeB = {
      harnesses: {
        opencode: {
          ...BASE,
          model: "next-model",
          smallModel: "next-small",
          baseUrl: "http://new-host:8000",
          nativeConfig: { config: { compaction: { auto: false }, agent: { reviewer: { tools: { write: true } } } } },
        },
      },
    };
    deploy(routeB, p);
    for (const path of targets) {
      const value = readJson(path);
      expect(value.model).toBe("operator/op-choice");
      expect(value.small_model).toBe("operator/small-choice");
      expect(value.provider[providerA]).toBeUndefined();
      expect(value.provider.binding_new_host_8000).toBeDefined();
      expect(value.provider.foreign).toEqual(foreignProvider);
      expect(value.compaction).toEqual({ auto: false });
      expect(value.agent.reviewer.tools.write).toBe(true);
    }
    deploy({ harnesses: { opencode: { ...BASE, model: "next-model", smallModel: "next-small", baseUrl: "http://new-host:8000" } } }, p);
    for (const path of targets) {
      const value = readJson(path);
      expect(value.model).toBe("operator/op-choice");
      expect(value.small_model).toBe("operator/small-choice");
      expect(value.provider[providerA]).toBeUndefined();
      expect(value.provider.binding_new_host_8000).toBeDefined();
      expect(value.provider.foreign).toEqual(foreignProvider);
      expect(value.compaction).toBeUndefined();
      expect(value.agent).toBeUndefined();
      expect(value.theme).toBe("operator-theme");
    }
  });

  it.each(["kilo", "kilocode"] as const)("keeps foreign %s operator models stable across identical runs and route A to B", (harnessId: "kilo" | "kilocode") => {
    const p = paths();
    const path = join(p.kiloGlobalDir!, "kilo.json");
    const foreignProvider = { npm: "operator-kilo", options: { baseURL: "http://operator.example/v1" } };
    writeJson(path, {
      model: "operator/kilo-choice",
      small_model: "operator/kilo-small",
      provider: { foreign: foreignProvider },
      operatorKeep: true,
    });
    const config = {
      harnesses: {
        [harnessId]: { ...BASE, smallModel: "generated-small", nativeConfig: { config: { compaction: { auto: true }, subagent_model: "native-role-a" } } },
      },
    };
    deploy(config, p);
    const providerA = deriveProviderId(BASE.baseUrl!);
    let value = readJson(path);
    expect(value.model).toBe("operator/kilo-choice");
    expect(value.small_model).toBe("operator/kilo-small");
    expect(value.provider[providerA]).toBeDefined();
    expect(value.provider.foreign).toEqual(foreignProvider);
    expect(value.subagent_model).toBe("native-role-a");
    const first = readFileSync(path, "utf-8");
    const firstState = readFileSync(`${path}.hcw-managed.json`, "utf-8");
    deploy(config, p);
    expect(readFileSync(path, "utf-8")).toBe(first);
    expect(readFileSync(`${path}.hcw-managed.json`, "utf-8")).toBe(firstState);

    const legacy = readJson(`${path}.hcw-managed.json`);
    delete legacy.ownership;
    writeJson(`${path}.hcw-managed.json`, legacy);
    deploy({ harnesses: { [harnessId]: {
      ...BASE,
      model: "next-model",
      baseUrl: "http://new-host:8000",
      nativeConfig: { config: { compaction: { auto: false }, subagent_model: "native-role-b" } },
    } } }, p);
    value = readJson(path);
    expect(value.model).toBe("operator/kilo-choice");
    expect(value.small_model).toBe("operator/kilo-small");
    expect(value.provider[providerA]).toBeUndefined();
    expect(value.provider.binding_new_host_8000).toBeDefined();
    expect(value.provider.foreign).toEqual(foreignProvider);
    expect(value.subagent_model).toBe("native-role-b");

    deploy({ harnesses: { [harnessId]: { ...BASE, model: "next-model", baseUrl: "http://new-host:8000" } } }, p);
    value = readJson(path);
    expect(value.model).toBe("operator/kilo-choice");
    expect(value.small_model).toBe("operator/kilo-small");
    expect(value.provider.foreign).toEqual(foreignProvider);
    expect(value.provider.binding_new_host_8000).toBeDefined();
    expect(value.subagent_model).toBeUndefined();
    expect(value.compaction).toBeUndefined();
    expect(value.operatorKeep).toBe(true);
  });

  it("keeps foreign Qwen model settings stable while reconciling providers and explicit native leaves", () => {
    const p = paths();
    const path = join(p.qwenHome!, "settings.json");
    const foreignModels = [{ id: "foreign-model", name: "Operator provider", envKey: "FOREIGN_KEY" }];
    writeJson(path, {
      model: {
        name: "operator-model",
        baseUrl: "http://operator.example/v1",
        chatCompression: { contextPercentageThreshold: 0.4, operatorKeep: true },
      },
      modelProviders: { foreign: foreignModels },
      providerProtocol: { foreign: "openai" },
      operatorKeep: true,
    });
    const initial = { harnesses: { qwen: { ...BASE, nativeConfig: { settings: {
      fastModel: "fast-a",
      model: { chatCompression: { contextPercentageThreshold: 0.8 } },
    } } } } };
    deploy(initial, p);
    const providerA = deriveProviderId(BASE.baseUrl!);
    let value = readJson(path);
    expect(value.model.name).toBe("operator-model");
    expect(value.model.baseUrl).toBe("http://operator.example/v1");
    expect(value.model.chatCompression).toEqual({ contextPercentageThreshold: 0.8, operatorKeep: true });
    expect(value.modelProviders.foreign).toEqual(foreignModels);
    expect(value.modelProviders[providerA]).toBeDefined();
    const first = readFileSync(path, "utf-8");
    const firstState = readFileSync(`${path}.hcw-managed.json`, "utf-8");
    deploy(initial, p);
    expect(readFileSync(path, "utf-8")).toBe(first);
    expect(readFileSync(`${path}.hcw-managed.json`, "utf-8")).toBe(firstState);

    const legacy = readJson(`${path}.hcw-managed.json`);
    delete legacy.ownership;
    writeJson(`${path}.hcw-managed.json`, legacy);
    deploy({ harnesses: { qwen: {
      ...BASE,
      model: "next-model",
      baseUrl: "http://new-host:8000",
      nativeConfig: { settings: { fastModel: "fast-b", model: { chatCompression: { contextPercentageThreshold: 0.9 } } } },
    } } }, p);
    value = readJson(path);
    expect(value.model.name).toBe("operator-model");
    expect(value.model.baseUrl).toBe("http://operator.example/v1");
    expect(value.model.chatCompression.contextPercentageThreshold).toBe(0.9);
    expect(value.modelProviders[providerA]).toBeUndefined();
    expect(value.modelProviders.binding_new_host_8000).toBeDefined();
    expect(value.modelProviders.foreign).toEqual(foreignModels);
    expect(value.providerProtocol).toEqual({ foreign: "openai", binding_new_host_8000: "openai" });

    deploy({ harnesses: { qwen: { ...BASE, model: "next-model", baseUrl: "http://new-host:8000" } } }, p);
    value = readJson(path);
    expect(value.model.name).toBe("operator-model");
    expect(value.model.chatCompression).toEqual({ operatorKeep: true });
    expect(value.fastModel).toBeUndefined();
    expect(value.modelProviders.foreign).toEqual(foreignModels);
    expect(value.modelProviders.binding_new_host_8000).toBeDefined();
    expect(value.operatorKeep).toBe(true);
  });

  it("keeps foreign Claude availableModels stable while native settings add, change and remove", () => {
    const p = paths();
    const path = join(p.claudeSourceHome, "settings.json");
    writeJson(path, {
      model: "operator-old",
      availableModels: ["operator-model"],
      permissions: { operator: true },
      env: { ANTHROPIC_BASE_URL: "http://operator.example", OTHER: "keep" },
    });
    const initial = { harnesses: { claude: { ...BASE, models: ["main-model", "review-model"], nativeConfig: { settings: {
      compaction: { enabled: true },
      env: { CLAUDE_NATIVE_FLAG: "enabled" },
    } } } } };
    deploy(initial, p);
    let value = readJson(path);
    expect(value.model).toBe("main-model");
    expect(value.availableModels).toEqual(["operator-model"]);
    expect(value.env.OTHER).toBe("keep");
    expect(value.env.CLAUDE_NATIVE_FLAG).toBe("enabled");
    expect(readJson(`${path}.hcw-managed.json`).paths).not.toContainEqual(["availableModels"]);
    const first = readFileSync(path, "utf-8");
    const firstState = readFileSync(`${path}.hcw-managed.json`, "utf-8");
    deploy(initial, p);
    expect(readFileSync(path, "utf-8")).toBe(first);
    expect(readFileSync(`${path}.hcw-managed.json`, "utf-8")).toBe(firstState);

    const legacy = readJson(`${path}.hcw-managed.json`);
    delete legacy.ownership;
    writeJson(`${path}.hcw-managed.json`, legacy);
    deploy({ harnesses: { claude: {
      ...BASE,
      model: "next-model",
      smallModel: "next-small",
      baseUrl: "http://new-host:8000",
      models: ["next-model", "next-review"],
      nativeConfig: { settings: { compaction: { enabled: false }, env: { CLAUDE_NATIVE_FLAG: "changed" } } },
    } } }, p);
    value = readJson(path);
    expect(value.model).toBe("next-model");
    expect(value.availableModels).toEqual(["operator-model"]);
    expect(value.env.ANTHROPIC_BASE_URL).toBe("http://new-host:8000");
    expect(value.env.ANTHROPIC_SMALL_FAST_MODEL).toBe("next-small");
    expect(value.env.CLAUDE_NATIVE_FLAG).toBe("changed");
    expect(value.compaction).toEqual({ enabled: false });

    deploy({ harnesses: { claude: { ...BASE, model: "next-model", baseUrl: "http://new-host:8000" } } }, p);
    value = readJson(path);
    expect(value.availableModels).toEqual(["operator-model"]);
    expect(value.compaction).toBeUndefined();
    expect(value.env.CLAUDE_NATIVE_FLAG).toBeUndefined();
    expect(value.env.OTHER).toBe("keep");
    expect(value.permissions).toEqual({ operator: true });
  });

  it("retains foreign Pi providers and enabledModels across identical runs and route A to B", () => {
    const p = paths();
    const modelsPath = join(p.piAgentDir, "models.json");
    const settingsPath = join(p.piAgentDir, "settings.json");
    writeJson(modelsPath, { providers: { foreign: { name: "Operator", models: [{ id: "foreign-model" }] } } });
    writeJson(settingsPath, { enabledModels: ["other/*"], theme: "operator" });
    deploy({ harnesses: { pi: { ...BASE, providerKey: "route-a" } } }, p);
    expect(readJson(settingsPath).enabledModels).toEqual(["other/*", "route-a/*"]);
    const firstModels = readFileSync(modelsPath, "utf-8");
    const firstSettings = readFileSync(settingsPath, "utf-8");
    deploy({ harnesses: { pi: { ...BASE, providerKey: "route-a" } } }, p);
    expect(readFileSync(modelsPath, "utf-8")).toBe(firstModels);
    expect(readFileSync(settingsPath, "utf-8")).toBe(firstSettings);
    deploy({ harnesses: { pi: { ...BASE, providerKey: "route-b" } } }, p);
    expect(readJson(settingsPath).enabledModels).toEqual(["other/*", "route-b/*"]);
    expect(readJson(settingsPath).theme).toBe("operator");
    const models = readJson(modelsPath);
    expect(models.providers["route-a"]).toBeUndefined();
    expect(models.providers["route-b"]).toBeDefined();
    expect(models.providers.foreign).toEqual({ name: "Operator", models: [{ id: "foreign-model" }] });
  });
});

describe("ambiguous legacy sidecar migration", () => {
  it("never promotes either generated-shaped OpenCode target to full ownership", () => {
    const p = paths();
    const targets = [
      join(p.acpxDir, "opencode-home", "opencode.jsonc"),
      join(p.opencodeGlobalDir, "opencode.jsonc"),
    ];
    const initialEntry: HarnessConfigEntry = {
      ...BASE,
      smallModel: "generated-small",
      nativeConfig: { config: { compaction: { auto: true } } },
    };
    for (const path of targets) writeJson(path, {
      $schema: "https://opencode.ai/config.json",
      model: "operator/op-choice",
      small_model: "operator/small-choice",
    });
    deploy({ harnesses: { opencode: initialEntry } }, p);
    for (const path of targets) writeLegacyState(path, "opencode", buildOpencodeConfigJsonc(initialEntry));

    deploy({ harnesses: { opencode: initialEntry } }, p);
    const providerA = deriveProviderId(BASE.baseUrl!);
    for (const path of targets) {
      const value = readJson(path);
      expect(value.model).toBe("operator/op-choice");
      expect(value.small_model).toBe("operator/small-choice");
      expect(value.provider[providerA]).toBeDefined();
      expect(value.compaction).toEqual({ auto: true });
      expect(readJson(`${path}.hcw-managed.json`).ownership).toBe("augmented");
    }
    const migratedBytes = targets.flatMap((path) => [path, `${path}.hcw-managed.json`]).map((path) => readFileSync(path, "utf-8"));
    const idempotent = deploy({ harnesses: { opencode: initialEntry } }, p);
    expect(idempotent.results[0].files.every((file) => file.action === "unchanged")).toBe(true);
    expect(targets.flatMap((path) => [path, `${path}.hcw-managed.json`]).map((path) => readFileSync(path, "utf-8"))).toEqual(migratedBytes);

    deploy({ harnesses: { opencode: {
      ...initialEntry,
      model: "next-model",
      baseUrl: "http://new-host:8000",
      nativeConfig: { config: { compaction: { auto: false }, agent: { reviewer: { tools: { write: false } } } } },
    } } }, p);
    for (const path of targets) {
      const value = readJson(path);
      expect(value.model).toBe("operator/op-choice");
      expect(value.small_model).toBe("operator/small-choice");
      expect(value.provider[providerA]).toBeUndefined();
      expect(value.provider.binding_new_host_8000).toBeDefined();
      expect(value.compaction).toEqual({ auto: false });
      expect(value.agent.reviewer.tools.write).toBe(false);
    }
    deploy({ harnesses: { opencode: { ...BASE, model: "next-model", smallModel: "generated-small", baseUrl: "http://new-host:8000" } } }, p);
    for (const path of targets) {
      const value = readJson(path);
      expect(value.model).toBe("operator/op-choice");
      expect(value.small_model).toBe("operator/small-choice");
      expect(value.provider[providerA]).toBeUndefined();
      expect(value.provider.binding_new_host_8000).toBeDefined();
      expect(value.compaction).toBeUndefined();
      expect(value.agent).toBeUndefined();
    }
  });

  it.each(["kilo", "kilocode"] as const)("never promotes generated-shaped foreign %s operator models to full ownership", (harnessId: "kilo" | "kilocode") => {
    const p = paths();
    const path = join(p.kiloGlobalDir!, "kilo.json");
    const initialEntry: HarnessConfigEntry = {
      ...BASE,
      smallModel: "generated-small",
      nativeConfig: { config: { subagent_model: "native-a" } },
    };
    writeJson(path, {
      $schema: "https://app.kilo.ai/config.json",
      model: "operator/kilo-choice",
      small_model: "operator/kilo-small",
    });
    deploy({ harnesses: { [harnessId]: initialEntry } }, p);
    writeLegacyState(path, "kilo", buildKiloConfigJson(initialEntry));

    deploy({ harnesses: { [harnessId]: initialEntry } }, p);
    const providerA = deriveProviderId(BASE.baseUrl!);
    let value = readJson(path);
    expect(value.model).toBe("operator/kilo-choice");
    expect(value.small_model).toBe("operator/kilo-small");
    expect(value.provider[providerA]).toBeDefined();
    expect(value.subagent_model).toBe("native-a");
    expect(readJson(`${path}.hcw-managed.json`).ownership).toBe("augmented");
    const migrated = readFileSync(path, "utf-8");
    const migratedState = readFileSync(`${path}.hcw-managed.json`, "utf-8");
    deploy({ harnesses: { [harnessId]: initialEntry } }, p);
    expect(readFileSync(path, "utf-8")).toBe(migrated);
    expect(readFileSync(`${path}.hcw-managed.json`, "utf-8")).toBe(migratedState);

    deploy({ harnesses: { [harnessId]: {
      ...initialEntry,
      model: "next-model",
      baseUrl: "http://new-host:8000",
      nativeConfig: { config: { subagent_model: "native-b", compaction: { auto: true } } },
    } } }, p);
    value = readJson(path);
    expect(value.model).toBe("operator/kilo-choice");
    expect(value.small_model).toBe("operator/kilo-small");
    expect(value.provider[providerA]).toBeUndefined();
    expect(value.provider.binding_new_host_8000).toBeDefined();
    expect(value.subagent_model).toBe("native-b");
    expect(value.compaction).toEqual({ auto: true });
    deploy({ harnesses: { [harnessId]: { ...BASE, model: "next-model", smallModel: "generated-small", baseUrl: "http://new-host:8000" } } }, p);
    value = readJson(path);
    expect(value.model).toBe("operator/kilo-choice");
    expect(value.small_model).toBe("operator/kilo-small");
    expect(value.provider[providerA]).toBeUndefined();
    expect(value.provider.binding_new_host_8000).toBeDefined();
    expect(value.subagent_model).toBeUndefined();
    expect(value.compaction).toBeUndefined();
  });

  it("preserves a foreign Qwen operator baseUrl even when its model name matches a generated model", () => {
    const p = paths();
    const path = join(p.qwenHome!, "settings.json");
    const initialEntry: HarnessConfigEntry = {
      ...BASE,
      nativeConfig: { settings: { model: { chatCompression: { contextPercentageThreshold: 0.8 } } } },
    };
    writeJson(path, {
      model: { name: "main-model", baseUrl: "http://operator.example/v1", operatorKeep: true },
    });
    deploy({ harnesses: { qwen: initialEntry } }, p);
    writeLegacyState(path, "qwen", buildQwenSettingsJson(initialEntry));

    deploy({ harnesses: { qwen: initialEntry } }, p);
    const providerA = deriveProviderId(BASE.baseUrl!);
    let value = readJson(path);
    expect(value.model).toEqual({
      name: "main-model",
      baseUrl: "http://operator.example/v1",
      operatorKeep: true,
      chatCompression: { contextPercentageThreshold: 0.8 },
    });
    expect(value.modelProviders[providerA]).toBeDefined();
    expect(readJson(`${path}.hcw-managed.json`).ownership).toBe("augmented");
    const migrated = readFileSync(path, "utf-8");
    const migratedState = readFileSync(`${path}.hcw-managed.json`, "utf-8");
    deploy({ harnesses: { qwen: initialEntry } }, p);
    expect(readFileSync(path, "utf-8")).toBe(migrated);
    expect(readFileSync(`${path}.hcw-managed.json`, "utf-8")).toBe(migratedState);

    deploy({ harnesses: { qwen: {
      ...initialEntry,
      model: "next-model",
      baseUrl: "http://new-host:8000",
      nativeConfig: { settings: { fastModel: "fast-b", model: { chatCompression: { contextPercentageThreshold: 0.9 } } } },
    } } }, p);
    value = readJson(path);
    expect(value.model.name).toBe("main-model");
    expect(value.model.baseUrl).toBe("http://operator.example/v1");
    expect(value.model.operatorKeep).toBe(true);
    expect(value.model.chatCompression.contextPercentageThreshold).toBe(0.9);
    expect(value.fastModel).toBe("fast-b");
    expect(value.modelProviders[providerA]).toBeUndefined();
    expect(value.modelProviders.binding_new_host_8000).toBeDefined();
    deploy({ harnesses: { qwen: { ...BASE, model: "next-model", baseUrl: "http://new-host:8000" } } }, p);
    value = readJson(path);
    expect(value.model).toEqual({ name: "main-model", baseUrl: "http://operator.example/v1", operatorKeep: true });
    expect(value.fastModel).toBeUndefined();
    expect(value.modelProviders[providerA]).toBeUndefined();
    expect(value.modelProviders.binding_new_host_8000).toBeDefined();
  });

  it("preserves a foreign Claude availableModels catalog even when it contains the active model", () => {
    const p = paths();
    const path = join(p.claudeSourceHome, "settings.json");
    const initialEntry: HarnessConfigEntry = {
      ...BASE,
      models: ["main-model", "review-model"],
      nativeConfig: { settings: { compaction: { enabled: true } } },
    };
    writeJson(path, {
      model: "operator-old",
      availableModels: ["main-model", "operator-only"],
      env: { OTHER: "keep" },
    });
    deploy({ harnesses: { claude: initialEntry } }, p);
    writeLegacyState(path, "claude", buildClaudeSettingsJson(initialEntry, []));

    deploy({ harnesses: { claude: initialEntry } }, p);
    let value = readJson(path);
    expect(value.model).toBe("main-model");
    expect(value.availableModels).toEqual(["main-model", "operator-only"]);
    expect(value.compaction).toEqual({ enabled: true });
    expect(value.env.OTHER).toBe("keep");
    expect(readJson(`${path}.hcw-managed.json`).ownership).toBe("augmented");
    const migrated = readFileSync(path, "utf-8");
    const migratedState = readFileSync(`${path}.hcw-managed.json`, "utf-8");
    deploy({ harnesses: { claude: initialEntry } }, p);
    expect(readFileSync(path, "utf-8")).toBe(migrated);
    expect(readFileSync(`${path}.hcw-managed.json`, "utf-8")).toBe(migratedState);

    deploy({ harnesses: { claude: {
      ...initialEntry,
      model: "next-model",
      baseUrl: "http://new-host:8000",
      nativeConfig: { settings: { compaction: { enabled: false }, env: { CLAUDE_NATIVE_FLAG: "changed" } } },
    } } }, p);
    value = readJson(path);
    expect(value.model).toBe("next-model");
    expect(value.availableModels).toEqual(["main-model", "operator-only"]);
    expect(value.compaction).toEqual({ enabled: false });
    expect(value.env.CLAUDE_NATIVE_FLAG).toBe("changed");
    expect(value.env.OTHER).toBe("keep");
    deploy({ harnesses: { claude: { ...BASE, model: "next-model", baseUrl: "http://new-host:8000" } } }, p);
    value = readJson(path);
    expect(value.model).toBe("next-model");
    expect(value.availableModels).toEqual(["main-model", "operator-only"]);
    expect(value.compaction).toBeUndefined();
    expect(value.env.CLAUDE_NATIVE_FLAG).toBeUndefined();
    expect(value.env.OTHER).toBe("keep");
  });
});

describe("review lifecycle regressions", () => {
  it("removes an OpenCode overlay while changing provider and preserving later operator keys", () => {
    const p = paths();
    const path = join(p.acpxDir, "opencode-home", "opencode.jsonc");
    deploy({
      harnesses: {
        opencode: { ...BASE, nativeConfig: { config: { compaction: { auto: true }, agents: { reviewer: { model: "review" } } } } },
      },
    }, p);
    const first = readJson(path);
    first.operatorTheme = "keep";
    writeFileSync(path, JSON.stringify(first, null, 2));
    deploy({ harnesses: { opencode: { ...BASE, model: "next-model", baseUrl: "http://new-host:8000" } } }, p);
    const second = readJson(path);
    expect(second.model).toBe("binding_new_host_8000/next-model");
    expect(second.compaction).toBeUndefined();
    expect(second.agents).toBeUndefined();
    expect(second.operatorTheme).toBe("keep");
    expect(Object.keys(second.provider)).toEqual(["binding_new_host_8000"]);
  });

  it("removes stale managed env routes and credentials while preserving foreign keys", () => {
    const p = paths();
    const ids = ["claude", "gemini", "droid", "qwen", "kimi", "kiro", "iflow", "copilot"];
    const firstHarnesses = Object.fromEntries(ids.map((id) => [id, {
      ...BASE,
      ...(id === "claude" ? { models: ["main-model"], nativeConfig: { config: { utilityModel: "utility" } } } : {}),
    }]));
    deploy({ harnesses: firstHarnesses }, p);
    for (const id of ids) {
      const path = join(p.acpxDir, "harness-env", `${id}.env`);
      writeFileSync(path, `${readFileSync(path, "utf-8")}CUSTOM_KEEP='yes'\n`);
    }
    deploy({ harnesses: Object.fromEntries(ids.map((id) => [id, { model: "main-model" }])) }, p);
    const removed: Record<string, string[]> = {
      claude: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_MODEL_CONFIG"],
      gemini: ["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"],
      droid: ["FACTORY_API_KEY"],
      qwen: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
      kimi: ["KIMI_MODEL_API_KEY", "KIMI_MODEL_BASE_URL", "KIMI_MODEL_NAME", "KIMI_MODEL_PROVIDER_TYPE"],
      kiro: ["KIRO_API_KEY"],
      iflow: ["IFLOW_API_KEY", "IFLOW_BASE_URL"],
      copilot: ["COPILOT_PROVIDER_BASE_URL", "COPILOT_PROVIDER_API_KEY", "COPILOT_PROVIDER_TYPE", "COPILOT_OFFLINE"],
    };
    for (const id of ids) {
      const env = readFileSync(join(p.acpxDir, "harness-env", `${id}.env`), "utf-8");
      expect(env).toContain("CUSTOM_KEEP='yes'");
      for (const key of removed[id]) expect(env).not.toMatch(new RegExp(`^${key}=`, "m"));
    }
  });

  it("removes generated native JSON state after BYOK and policy removal", () => {
    const p = paths();
    const catalog = buildModelCatalog({
      models: {
        providers: {
          test: {
            baseUrl: "http://localhost:11434",
            modelPolicy: { postTurnCompactThresholdPercent: 70 },
            models: [{ id: "main-model", contextWindow: 100000 }],
          },
        },
      },
    }, []);
    deployHarnessConfigs({
      harnesses: {
        gemini: BASE,
        iflow: BASE,
        droid: BASE,
        kiro: BASE,
      },
    }, p, SILENT, catalog);
    const geminiPath = join(p.nativeHomes!.gemini, "settings.json");
    const iflowPath = join(p.nativeHomes!.iflow, "settings.json");
    const droidPath = join(p.nativeHomes!.droid, "settings.json");
    const kiroPath = join(p.nativeHomes!.kiro, "settings", "cli.json");
    expect(readJson(geminiPath).model.compressionThreshold).toBe(0.7);
    expect(readJson(kiroPath)["compaction.autoCompactionThreshold"]).toBe(70);
    const droid = readJson(droidPath);
    droid.customModels.push({ model: "operator-model", displayName: "Operator", baseUrl: "http://operator.example" });
    droid.operatorKeep = true;
    writeFileSync(droidPath, JSON.stringify(droid, null, 2));
    for (const path of [geminiPath, iflowPath, kiroPath]) {
      const value = readJson(path);
      value.operatorKeep = true;
      writeFileSync(path, JSON.stringify(value, null, 2));
    }
    deploy({
      harnesses: {
        gemini: { model: "main-model" },
        iflow: { model: "main-model" },
        droid: { model: "main-model" },
        kiro: { model: "main-model" },
      },
    }, p);
    expect(readJson(geminiPath).model.compressionThreshold).toBeUndefined();
    expect(readJson(geminiPath).operatorKeep).toBe(true);
    expect(readJson(iflowPath).baseUrl).toBeUndefined();
    expect(readJson(iflowPath).apiKey).toBeUndefined();
    expect(readJson(iflowPath).operatorKeep).toBe(true);
    expect(readJson(kiroPath)["compaction.autoCompactionThreshold"]).toBeUndefined();
    expect(readJson(kiroPath).operatorKeep).toBe(true);
    const nextDroid = readJson(droidPath);
    expect(nextDroid.customModels).toEqual([{ model: "operator-model", displayName: "Operator", baseUrl: "http://operator.example" }]);
    expect(nextDroid.operatorKeep).toBe(true);
  });

  it("projects Anthropic and Responses routes consistently across native files and env", () => {
    const p = paths();
    const anthropicCatalog = buildModelCatalog({
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://anthropic.example/v1",
            api: "anthropic-messages",
            models: [{ id: "claude-custom", api: "anthropic-messages", contextWindow: 200000 }],
          },
        },
      },
    }, []);
    const entry: HarnessConfigEntry = {
      model: "claude-custom",
      baseUrl: "https://anthropic.example/v1",
      apiKey: "synthetic-anthropic-key",
    };
    deployHarnessConfigs({ harnesses: { qwen: { ...entry, baseUrl: "http://localhost:11434" } } }, p, SILENT);
    deployHarnessConfigs({ harnesses: { qwen: entry, copilot: entry, kimi: entry } }, p, SILENT, anthropicCatalog);
    const providerId = "anthropic";
    const qwen = JSON.parse(buildQwenSettingsJson(entry, anthropicCatalog, []));
    expect(qwen.providerProtocol[providerId]).toBe("anthropic");
    expect(qwen.modelProviders[providerId][0].envKey).toBe("ANTHROPIC_API_KEY");
    expect(qwen.modelProviders[providerId][0].baseUrl).toBe("https://anthropic.example/v1");
    const qwenEnv = readFileSync(join(p.acpxDir, "harness-env", "qwen.env"), "utf-8");
    expect(qwenEnv).toContain("ANTHROPIC_API_KEY=");
    expect(qwenEnv).not.toMatch(/^OPENAI_API_KEY=/m);
    expect(qwenEnv).not.toMatch(/^OPENAI_BASE_URL=/m);
    const copilotEnv = readFileSync(join(p.acpxDir, "harness-env", "copilot.env"), "utf-8");
    expect(copilotEnv).toContain("COPILOT_PROVIDER_TYPE='anthropic'");
    expect(copilotEnv).toContain("COPILOT_PROVIDER_BASE_URL='https://anthropic.example'");
    const droid = JSON.parse(buildHarnessNativeSettingsJson("droid", entry, anthropicCatalog, []));
    expect(droid.customModels[0].provider).toBe("anthropic");
    expect(droid.customModels[0].baseUrl).toBe("https://anthropic.example");
    const kimiToml = buildKimiConfigToml(entry, anthropicCatalog, []);
    expect(kimiToml).toContain('"type" = "anthropic"');
    expect(kimiToml).toContain('"base_url" = "https://anthropic.example"');
    expect(kimiToml).toContain('"max_context_size" = 200000');
    const kimiEnv = readFileSync(join(p.acpxDir, "harness-env", "kimi.env"), "utf-8");
    expect(kimiEnv).toContain("KIMI_MODEL_PROVIDER_TYPE='anthropic'");
    expect(kimiEnv).toContain("KIMI_MODEL_BASE_URL='https://anthropic.example'");
    expect(kimiEnv).toContain("KIMI_MODEL_MAX_CONTEXT_SIZE='200000'");

    const responsesCatalog = buildModelCatalog({
      models: {
        providers: {
          responses: {
            baseUrl: "http://localhost:11434",
            api: "openai-responses",
            models: [{ id: "response-model", api: "openai-responses", contextWindow: 128000 }],
          },
        },
      },
    }, []);
    const responseEntry = { ...BASE, model: "response-model" };
    deployHarnessConfigs({ harnesses: { kimi: responseEntry } }, paths(join(root, "responses")), SILENT, responsesCatalog);
    const responseEnv = readFileSync(join(paths(join(root, "responses")).acpxDir, "harness-env", "kimi.env"), "utf-8");
    expect(responseEnv).not.toMatch(/^KIMI_MODEL_NAME=/m);
    expect(buildKimiConfigToml(responseEntry, responsesCatalog, [])).toContain('"type" = "openai_responses"');
  });

  it("retains explicitly empty arrays in Codex and Kimi TOML", () => {
    const codex = buildCodexConfigToml({
      ...BASE,
      nativeConfig: { config: { mcp_servers: { docs: { args: [] } }, capabilities: [] } },
    });
    expect(codex).toContain('"args" = []');
    expect(codex).toContain('"capabilities" = []');
    const providerId = deriveProviderId(BASE.baseUrl!);
    const kimi = buildKimiConfigToml({
      ...BASE,
      nativeConfig: {
        config: {
          models: { [`${providerId}/main-model`]: { capabilities: [], support_efforts: [] } },
        },
      },
    });
    expect(kimi).toContain('"capabilities" = []');
    expect(kimi).toContain('"support_efforts" = []');
  });
});

describe("provider-key cleanup across duplicate base URLs", () => {
  it("selects stable gateway keys by harness wire API instead of URL-derived binding IDs", () => {
    const baseUrl = "http://192.0.2.34:11434";
    const model = { id: "main-model", contextWindow: 128000 };
    const catalog = buildModelCatalog({
      models: {
        providers: {
          ollama: { baseUrl, models: [model] },
          "ollama-openai": { baseUrl: `${baseUrl}/v1`, api: "openai-completions", models: [{ ...model, api: "openai-completions" }] },
          "ollama-openai-responses": { baseUrl: `${baseUrl}/v1`, api: "openai-responses", models: [{ ...model, api: "openai-responses" }] },
          anthropic: { baseUrl: `${baseUrl}/v1`, api: "anthropic-messages", models: [{ ...model, api: "anthropic-messages" }] },
        },
      },
    }, []);
    const p = paths();
    const entry = { ...BASE, baseUrl };
    const report = deployHarnessConfigs({
      harnesses: {
        codex: entry,
        opencode: entry,
        kilocode: entry,
        qwen: entry,
        kimi: entry,
        pi: entry,
      },
    }, p, SILENT, catalog);
    expect(report.results.flatMap((result) => result.warnings).some((warning) => warning.includes("ambiguous"))).toBe(false);

    const codex = readFileSync(join(p.codexSourceHome, "config.toml"), "utf-8");
    expect(codex).toContain('model_provider = "ollama-openai-responses"');
    const opencode = readJson(join(p.opencodeGlobalDir, "opencode.jsonc"));
    const kilo = readJson(join(p.kiloGlobalDir!, "kilo.json"));
    expect(opencode.model).toBe("ollama-openai/main-model");
    expect(kilo.model).toBe("ollama-openai/main-model");
    const qwen = readJson(join(p.qwenHome!, "settings.json"));
    expect(qwen.providerProtocol).toEqual({ "ollama-openai": "openai" });
    expect(qwen.modelProviders["ollama-openai"][0].envKey).toBe("OPENAI_API_KEY");
    const kimi = readFileSync(join(p.nativeHomes!.kimi, "config.toml"), "utf-8");
    expect(kimi).toContain('"default_model" = "ollama-openai/main-model"');
    const pi = readJson(join(p.piAgentDir, "models.json"));
    expect(pi.providers["ollama-openai"].api).toBe("openai-completions");
    for (const content of [codex, JSON.stringify(opencode), JSON.stringify(kilo), JSON.stringify(qwen), kimi, JSON.stringify(pi)]) {
      expect(content).not.toContain("binding_192_168_178_34_11434");
    }

    const explicit = JSON.parse(buildOpencodeConfigJsonc({ ...entry, providerKey: "operator-selected" }, catalog, []));
    expect(explicit.model).toBe("operator-selected/main-model");
    expect(Object.keys(explicit.provider)).toEqual(["operator-selected"]);
  });

  it("never borrows another provider's API and enforces Codex reserved-key handling even for explicit ollama", () => {
    const catalog = buildModelCatalog({
      models: {
        providers: {
          anthropic: { baseUrl: "http://localhost:11434/v1", api: "anthropic-messages", models: [{ id: "main-model", api: "anthropic-messages" }] },
          ollama: { baseUrl: "http://localhost:11434", models: [{ id: "main-model" }] },
        },
      },
    }, []);
    const explicit = { ...BASE, providerKey: "ollama" };
    const qwen = JSON.parse(buildQwenSettingsJson(explicit, catalog, []));
    expect(qwen.providerProtocol.ollama).toBe("openai");
    expect(qwen.modelProviders.ollama[0].envKey).toBe("OPENAI_API_KEY");
    const kimi = buildKimiConfigToml(explicit, catalog, []);
    expect(kimi).toContain('"type" = "openai"');

    const p = paths();
    deploy({ harnesses: { codex: explicit } }, p);
    const toml = readFileSync(join(p.codexSourceHome, "config.toml"), "utf-8");
    expect(toml).toContain('model_provider = "binding_localhost_11434"');
    expect(toml).not.toContain('model_provider = "ollama"');
  });

  it("rejects a sole incompatible model candidate and an API-only match without the model", () => {
    const catalog = buildModelCatalog({
      models: {
        providers: {
          completions: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [{ id: "main-model", api: "openai-completions" }] },
          responses: { baseUrl: "http://localhost:11434/v1", api: "openai-responses", models: [{ id: "other-model", api: "openai-responses" }] },
        },
      },
    }, []);
    for (const model of ["main-model", "missing-model"]) {
      const warnings: string[] = [];
      const toml = buildCodexConfigToml({ ...BASE, model }, undefined, 70, warnings, catalog);
      expect(toml).toContain('model_provider = "binding_localhost_11434"');
      expect(toml).not.toContain('model_provider = "completions"');
      expect(toml).not.toContain('model_provider = "responses"');
      expect(warnings.some((warning) => warning.includes("providerKey explicitly"))).toBe(true);
    }
  });

  it("removes a Pi generated wildcard on provider A to B while retaining operator entries", () => {
    const p = paths();
    deploy({ harnesses: { pi: { ...BASE, providerKey: "route-a" } } }, p);
    const settingsPath = join(p.piAgentDir, "settings.json");
    const settings = readJson(settingsPath);
    settings.enabledModels.push("other/*");
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    deploy({ harnesses: { pi: { ...BASE, providerKey: "route-b" } } }, p);
    expect(readJson(settingsPath).enabledModels).toEqual(["other/*", "route-b/*"]);
    const models = readJson(join(p.piAgentDir, "models.json"));
    expect(models.providers["route-a"]).toBeUndefined();
    expect(models.providers["route-b"]).toBeDefined();
  });

  it("quotes explicit dotted Codex provider keys without a wrapper TOML", () => {
    const p = paths();
    mkdirSync(p.codexSourceHome, { recursive: true });
    writeFileSync(join(p.codexSourceHome, "config.toml"), 'sandbox_mode = "read-only"\n');
    deploy({ harnesses: { codex: { ...BASE, providerKey: "acme.prod" } } }, p);
    const direct = readFileSync(join(p.codexSourceHome, "config.toml"), "utf-8");
    expect(direct).toContain('[model_providers."acme.prod"]');
  });
});

describe("remaining native JSON harnesses", () => {
  it("writes Gemini, Copilot, iFlow, Droid and Kiro native model and function settings", () => {
    const p = paths();
    deploy({
      harnesses: {
        gemini: {
          ...BASE,
          nativeConfig: { settings: { modelConfigs: { modelChains: { main: [{ model: "fallback-model" }] } } } },
        },
        copilot: {
          ...BASE,
          nativeConfig: { settings: { subagents: { agents: { reviewer: { model: "review-fast", effortLevel: "high" } } } } },
        },
        iflow: {
          ...BASE,
          nativeConfig: { settings: { compaction: { enabled: true }, tools: { shell: true } } },
        },
        droid: {
          ...BASE,
          nativeConfig: { settings: { sessionDefaultSettings: { specModeModel: "review-model" } } },
        },
        kiro: {
          ...BASE,
          nativeConfig: { settings: { "chat.modelDefaults": { "main-model": { effort: "high" } }, "compaction.excludeMessages": 2 } },
        },
      },
    }, p);

    const gemini = readJson(join(p.nativeHomes!.gemini, "settings.json"));
    expect(gemini.model).toEqual({ name: "main-model" });
    expect(gemini.modelConfigs.modelChains.main[0].model).toBe("fallback-model");
    const copilot = readJson(join(p.nativeHomes!.copilot, "settings.json"));
    expect(copilot.model).toBe("main-model");
    expect(copilot.subagents.agents.reviewer).toEqual({ model: "review-fast", effortLevel: "high" });
    const iflowText = readFileSync(join(p.nativeHomes!.iflow, "settings.json"), "utf-8");
    const iflow = JSON.parse(iflowText);
    expect(iflow.modelName).toBe("main-model");
    expect(iflow.apiKey).toBe("${IFLOW_API_KEY}");
    expect(iflowText).not.toContain(BASE.apiKey!);
    const droidText = readFileSync(join(p.nativeHomes!.droid, "settings.json"), "utf-8");
    const droid = JSON.parse(droidText);
    expect(droid.model).toBe("main-model");
    expect(droid.customModels[0].provider).toBe("generic-chat-completion-api");
    expect(droid.customModels[0].apiKey).toBe("${FACTORY_API_KEY}");
    expect(droid.sessionDefaultSettings.specModeModel).toBe("review-model");
    expect(droidText).not.toContain(BASE.apiKey!);
    const kiro = readJson(join(p.nativeHomes!.kiro, "settings", "cli.json"));
    expect(kiro["chat.defaultModel"]).toBe("main-model");
    expect(kiro["chat.modelDefaults"]["main-model"].effort).toBe("high");
    expect(kiro["compaction.excludeMessages"]).toBe(2);
  });

  it("preserves operator Droid models when writer-owned routes change", () => {
    const p = paths();
    const path = join(p.nativeHomes!.droid, "settings.json");
    deploy({ harnesses: { droid: BASE } }, p);
    const first = readJson(path);
    first.customModels.push({ model: "operator-model", displayName: "Operator model", baseUrl: "http://operator.example/v1" });
    writeFileSync(path, JSON.stringify(first, null, 2));
    deploy({ harnesses: { droid: { ...BASE, model: "next-model", baseUrl: "http://new-host:8000" } } }, p);
    const second = readJson(path);
    expect(second.model).toBe("next-model");
    expect(second.customModels.some((model: Record<string, unknown>) => model.model === "operator-model")).toBe(true);
    expect(second.customModels.some((model: Record<string, unknown>) => model.model === "main-model")).toBe(false);
    expect(second.customModels.some((model: Record<string, unknown>) => model.model === "next-model")).toBe(true);
  });
});
