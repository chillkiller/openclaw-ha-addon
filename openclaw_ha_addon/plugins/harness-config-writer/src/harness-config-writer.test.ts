/**
 * Phase 3 tests (generalisierte Harness-Config, 2026-10-11): Writer-Semantik
 * gegen REAL files in tmpdirs — mirrors the oc_acpx_helper.py deploy semantics
 * (install-if-missing / upgrade-only-no-providers / custom NEVER overwritten).
 * ABSENCE = no-op (Additiv-Garantie) is asserted byte-hart: no file, no dir.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCodexConfigToml,
  buildCodexModelCatalogJson,
  buildModelCatalog,
  buildOpencodeConfigJsonc,
  deployHarnessConfigs,
  deriveProviderId,
  normalizeBaseUrlForMatch,
  OPENCODE_LEGACY_PLACEHOLDER,
  renderEnvFile,
  resolveEntryModels,
  resolveHarnessWriterPaths,
  withV1Suffix,
  type HarnessConfigEntry,
  type HarnessWriterPaths,
} from "./harness-config-writer.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harness-writer-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function paths(): HarnessWriterPaths {
  return {
    acpxDir: join(root, "state", "acpx"),
    codexSourceHome: join(root, "config", ".codex"),
    opencodeGlobalDir: join(root, "config", "opencode"),
  };
}

function readText(path: string): string {
  return readFileSync(path, "utf-8");
}

const OLLAMA: HarnessConfigEntry = {
  model: "kimi-k2.7-code:cloud",
  baseUrl: "http://localhost:11434",
  apiKey: "ollama",
};

const SILENT = { debug: () => {}, info: () => {}, warn: () => {} };

const DEPLOY = (config: unknown, p = paths()) => deployHarnessConfigs(config, p, SILENT);

// ---------------------------------------------------------------------------
// String-Helper
// ---------------------------------------------------------------------------

describe("withV1Suffix / deriveProviderId", () => {
  it("appends /v1 exactly once (no double suffix, trailing slashes neutral)", () => {
    expect(withV1Suffix("http://localhost:11434")).toBe("http://localhost:11434/v1");
    expect(withV1Suffix("http://localhost:11434/")).toBe("http://localhost:11434/v1");
    expect(withV1Suffix("https://vllm.lan:8000/v1")).toBe("https://vllm.lan:8000/v1");
    expect(withV1Suffix("https://vllm.lan:8000/v1/")).toBe("https://vllm.lan:8000/v1");
    expect(withV1Suffix("http://localai.lan:8080/api/v1")).toBe("http://localai.lan:8080/api/v1");
  });

  it("derives deterministic provider names that are NEVER 'ollama'", () => {
    expect(deriveProviderId("http://localhost:11434")).toBe("binding_localhost_11434");
    expect(deriveProviderId("https://vllm.lan:8000")).toBe("binding_vllm_lan_8000");
    expect(deriveProviderId("http://localhost:11434")).toBe(
      deriveProviderId("http://localhost:11434/"),
    );
    // Reservierte id "ollama" (codex model_provider) ist ausgeschlossen.
    expect(deriveProviderId("http://ollama:11434")).not.toBe("ollama");
    expect(deriveProviderId("!!!")).toBe("binding_backend");
  });
});

// ---------------------------------------------------------------------------
// Mechanismus A — codex (Semantik VERBATIM aus oc_acpx_helper.py)
// ---------------------------------------------------------------------------

describe("codex writer", () => {
  it("fresh install: writes auth.json (chmod 0600) + inheritance config.toml", () => {
    const p = paths();
    const report = DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    expect(report.skipped).toBe(false);

    const auth = join(p.acpxDir, "codex-home", "auth.json");
    expect(JSON.parse(readText(auth))).toEqual({
      OPENAI_API_KEY: "ollama",
      tokens: null,
      last_refresh: null,
    });
    expect(statSync(auth).mode & 0o777).toBe(0o600);

    const toml = readText(join(p.codexSourceHome, "config.toml"));
    expect(toml).toContain('model = "kimi-k2.7-code:cloud"');
    expect(toml).toContain('model_provider = "binding_localhost_11434"');
    expect(toml).toContain('base_url = "http://localhost:11434/v1"');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain("requires_openai_auth = true");
    expect(toml).toContain('sandbox_mode = "workspace-write"');
    // thinking NICHT gesetzt → model_reasoning_effort-Var fehlt (der Header-
    // Kommentar NENNT den Key im Inheritance-Caveat — nur Var-Zeilen zählen).
    expect(toml).not.toMatch(/^model_reasoning_effort =/m);
    // Self-Recognition-Signatur (γ) immer erste Zeile.
    expect(toml.startsWith("# harness-config-writer (generated)")).toBe(true);
    expect(report.results[0].mechanism).toBe("file-codex");
    expect(report.results[0].files.map((f) => f.action)).toEqual(["created", "created"]);
  });

  it("thinking set → model_reasoning_effort; empty → absent", () => {
    const withThinking = buildCodexConfigToml({ ...OLLAMA, thinking: "medium" });
    expect(withThinking).toContain('model_reasoning_effort = "medium"');
    const blank = buildCodexConfigToml({ ...OLLAMA, thinking: "" });
    expect(blank).not.toMatch(/^model_reasoning_effort =/m);
  });

  it("trustProjects: dedupe + sort, no duplicate table headers", () => {
    const toml = buildCodexConfigToml({
      ...OLLAMA,
      trustProjects: ["/share/b", "/share/a", "/share/a", "/share/b/"],
    });
    const headers = toml.split("\n").filter((l) => l.startsWith("[projects."));
    expect(headers).toEqual(['[projects."/share/a"]', '[projects."/share/b"]']);
    expect((toml.match(/trust_level = "trusted"/g) ?? []).length).toBe(2);
  });

  it("upgrade: existing file WITHOUT [model_providers. block is upgraded", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    writeFileSync(tomlPath, 'model = "gpt-5"\n', "utf-8");
    const report = DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    expect(report.results[0].files.some((f) => f.path === tomlPath && f.action === "updated")).toBe(
      true,
    );
    expect(readText(tomlPath)).toContain('model = "kimi-k2.7-code:cloud"');
  });

  it("customized file WITH [model_providers. block is NEVER overwritten (NOTE)", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    const custom = '# my own provider routing\n[model_providers.garon_ollama]\nbase_url = "x"\n';
    writeFileSync(tomlPath, custom, "utf-8");
    const report = DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    expect(
      report.results[0].files.some(
        (f) => f.path === tomlPath && f.action === "note (customized, left intact)",
      ),
    ).toBe(true);
    expect(readText(tomlPath)).toBe(custom);
  });

  it("existing identical config.toml → unchanged (idempotent)", () => {
    const p = paths();
    DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    const report = DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    expect(report.results[0].files.map((f) => f.action)).toEqual(["unchanged", "unchanged"]);
  });

  it("existing auth.json is NEVER touched — even different content (helper semantics)", () => {
    const p = paths();
    const auth = join(p.acpxDir, "codex-home", "auth.json");
    mkdirSync(join(p.acpxDir, "codex-home"), { recursive: true });
    writeFileSync(auth, '{"OPENAI_API_KEY": "native-oauth"}', "utf-8");
    const report = DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    expect(readText(auth)).toBe('{"OPENAI_API_KEY": "native-oauth"}');
    expect(report.results[0].files.find((f) => f.path === auth)?.action).toBe("unchanged");
  });

  it("vLLM baseUrl carrying /v1 → no double /v1 in generated TOML", () => {
    const toml = buildCodexConfigToml({
      model: "Qwen3-Coder",
      baseUrl: "https://vllm.lan:8000/v1",
    });
    expect(toml).toContain('base_url = "https://vllm.lan:8000/v1"');
    expect(toml).not.toContain("/v1/v1");
    expect(toml).toContain('model_provider = "binding_vllm_lan_8000"');
  });

  it("codex without baseUrl → skipped with warning, NO file written", () => {
    const p = paths();
    const report = DEPLOY({ harnesses: { codex: { model: "m" } } }, p);
    expect(report.results[0].warnings.join(" ")).toContain("baseUrl");
    expect(existsSync(p.acpxDir)).toBe(false);
    expect(existsSync(join(p.codexSourceHome, "config.toml"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mechanismus A — opencode
// ---------------------------------------------------------------------------

describe("opencode writer", () => {
  it("M3: opencode.jsonc carries the apiKey in cleartext → written 0600 in BOTH dirs", () => {
    const p = paths();
    DEPLOY({ harnesses: { opencode: { ...OLLAMA, apiKey: "secret-token" } } }, p);
    for (const dir of [join(p.acpxDir, "opencode-home"), p.opencodeGlobalDir]) {
      const mode = statSync(join(dir, "opencode.jsonc")).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
  it("depplies opencode.jsonc to BOTH dirs + neutralizes legacy config.toml", () => {
    const p = paths();
    const report = DEPLOY({ harnesses: { opencode: OLLAMA } }, p);
    expect(report.skipped).toBe(false);
    const home = readText(join(p.acpxDir, "opencode-home", "opencode.jsonc"));
    const global = readText(join(p.opencodeGlobalDir, "opencode.jsonc"));
    const legacy = readText(join(p.acpxDir, "opencode-home", "config.toml"));

    for (const jsonc of [home, global]) {
      const cfg = JSON.parse(jsonc) as {
        provider: Record<string, { npm: string; options: { baseURL: string; apiKey: string } }>;
        model: string;
        small_model: string;
      };
      const provider = Object.keys(cfg.provider)[0];
      expect(provider).toBe("binding_localhost_11434");
      expect(cfg.provider[provider].npm).toBe("@ai-sdk/openai-compatible");
      expect(cfg.provider[provider].options.baseURL).toBe("http://localhost:11434/v1");
      expect(cfg.provider[provider].options.apiKey).toBe("ollama");
      expect(cfg.model).toBe("binding_localhost_11434/kimi-k2.7-code:cloud");
      expect(cfg.small_model).toBe("binding_localhost_11434/kimi-k2.7-code:cloud");
    }
    expect(legacy).toBe(OPENCODE_LEGACY_PLACEHOLDER);
    expect(report.results[0].mechanism).toBe("file-opencode");
    expect(report.results[0].files.map((f) => f.action)).toEqual([
      "created",
      "created",
      "created",
    ]);
  });

  it("smallModel rides into small_model; syncs on diff (updated, not stale)", () => {
    const p = paths();
    DEPLOY({ harnesses: { opencode: OLLAMA } }, p);
    const report = DEPLOY(
      {
        harnesses: {
          opencode: { ...OLLAMA, model: "glm-5.3-flash:cloud", smallModel: "qwen3-smol:cloud" },
        },
      },
      p,
    );
    expect(report.results[0].files.map((f) => f.action)).toEqual([
      "updated",
      "updated",
      "unchanged",
    ]);
    const cfg = JSON.parse(readText(join(p.acpxDir, "opencode-home", "opencode.jsonc"))) as {
      small_model: string;
    };
    expect(cfg.small_model).toBe("binding_localhost_11434/qwen3-smol:cloud");
  });

  it("vLLM/LocalAI baseUrl variants: no double /v1 in JSONC", () => {
    const jsonc = buildOpencodeConfigJsonc({
      model: "Qwen3-Coder",
      baseUrl: "http://localai.lan:8080/api/v1",
    }) as string;
    const cfg = JSON.parse(jsonc) as {
      provider: Record<string, { options: { baseURL: string } }>;
      model: string;
    };
    const providerId = Object.keys(cfg.provider)[0];
    expect(cfg.provider[providerId].options.baseURL).toBe("http://localai.lan:8080/api/v1");
    expect(jsonc).not.toContain("/v1/v1");
  });
});

// ---------------------------------------------------------------------------
// Mechanismus B — ENV
// ---------------------------------------------------------------------------

describe("env writer", () => {
  it("claude: ANTHROPIC_* verbatim (BASE_URL WITHOUT /v1), small → SMALL_FAST_MODEL", () => {
    const report = DEPLOY({
      harnesses: {
        claude: {
          model: "kimi-k2.7-code:cloud",
          baseUrl: "http://localhost:11434",
          apiKey: "tok",
          smallModel: "glm-5.3-flash:cloud",
        },
      },
    });
    const env = readText(join(paths().acpxDir, "harness-env", "claude.env"));
    expect(env).toContain("ANTHROPIC_MODEL='kimi-k2.7-code:cloud'");
    expect(env).toContain("ANTHROPIC_BASE_URL='http://localhost:11434'");
    expect(env).not.toContain("ANTHROPIC_BASE_URL='http://localhost:11434/v1'");
    expect(env).toContain("ANTHROPIC_AUTH_TOKEN='tok'");
    expect(env).toContain("ANTHROPIC_SMALL_FAST_MODEL='glm-5.3-flash:cloud'");
    expect(report.results[0].mechanism).toBe("env");
    // Secrets → 0600.
    expect(statSync(join(paths().acpxDir, "harness-env", "claude.env")).mode & 0o777).toBe(0o600);
  });

  it("gemini / droid / qwen / kimi / kiro / iflow map per-CLI (docs-verifiziert)", () => {
    const p = paths();
    DEPLOY(
      {
        harnesses: {
          gemini: { model: "g", baseUrl: "http://gb:1", apiKey: "gk" },
          droid: { model: "d", apiKey: "fk" },
          qwen: { model: "q", baseUrl: "http://qb:2", apiKey: "qk" },
          kimi: { model: "k", baseUrl: "http://kb:3", apiKey: "kk" },
          kiro: { model: "r", baseUrl: "http://rb:4", apiKey: "rk" },
          iflow: { model: "i", baseUrl: "http://ib:5", apiKey: "ik" },
        },
      },
      p,
    );
    const env = (id: string) => readText(join(p.acpxDir, "harness-env", `${id}.env`));
    expect(env("gemini")).toContain("GEMINI_API_KEY='gk'");
    expect(env("gemini")).toContain("GEMINI_MODEL='g'");
    expect(env("gemini")).toContain("GOOGLE_GEMINI_BASE_URL='http://gb:1'");
    expect(env("droid")).toContain("FACTORY_API_KEY='fk'");
    expect(env("qwen")).toContain("OPENAI_BASE_URL='http://qb:2/v1'");
    expect(env("kimi")).toContain("KIMI_MODEL_BASE_URL='http://kb:3/v1'");
    expect(env("kimi")).toContain("KIMI_MODEL_API_KEY='kk'");
    expect(env("kimi")).toContain("KIMI_MODEL_NAME='k'");
    expect(env("kiro")).toContain("KIRO_API_KEY='rk'");
    expect(env("kiro")).not.toContain("BASE_URL");
    expect(env("iflow")).toContain("IFLOW_API_KEY='ik'");
    expect(env("iflow")).toContain("IFLOW_BASE_URL='http://ib:5/v1'");
    expect(env("iflow")).toContain("IFLOW_modelName='i'");
  });

  it("droid/kiro warn (no Base-URL env surface) but still deploy the key", () => {
    const report = DEPLOY({
      harnesses: {
        droid: { model: "d", baseUrl: "http://fb:1", apiKey: "fk" },
        kiro: { model: "r", baseUrl: "http://rb:2", apiKey: "rk" },
      },
    });
    const droid = report.results.find((r) => r.harnessId === "droid");
    const kiro = report.results.find((r) => r.harnessId === "kiro");
    expect(droid?.warnings.join(" ")).toContain("droid");
    expect(kiro?.warnings.join(" ")).toContain("kiro");
    expect(existsSync(join(paths().acpxDir, "harness-env", "droid.env"))).toBe(true);
    expect(existsSync(join(paths().acpxDir, "harness-env", "kiro.env"))).toBe(true);
  });

  it("sh-safe quoting: values with apostrophes survive sourcing", () => {
    const rendered = renderEnvFile({ ANTHROPIC_MODEL: "it's a 'model'" }, ["h"]);
    expect(rendered).toContain("ANTHROPIC_MODEL='it'\"'\"'s a '\"'\"'model'\"'\"''");
  });
});

// ---------------------------------------------------------------------------
// ABSENCE = no-op (Additiv-Garantie) + Mechanismus C
// ---------------------------------------------------------------------------

describe("additive guarantee", () => {
  it("no harnesses section → skipped, NOTHING touched (no dirs created)", () => {
    const p = paths();
    const report = DEPLOY({ boundAgents: ["claude"] }, p);
    expect(report.skipped).toBe(true);
    expect(existsSync(p.acpxDir)).toBe(false);
    expect(existsSync(p.codexSourceHome)).toBe(false);
    expect(existsSync(p.opencodeGlobalDir)).toBe(false);
  });

  it("empty harnesses section → skipped, NOTHING touched", () => {
    const p = paths();
    const report = DEPLOY({ harnesses: {} }, p);
    expect(report.skipped).toBe(true);
    expect(existsSync(p.acpxDir)).toBe(false);
  });

  it("absent harness leaves sibling harnesses deployed — copilot/cursor NEVER touched", () => {
    const p = paths();
    const report = DEPLOY(
      { harnesses: { codex: OLLAMA, copilot: { model: "x" }, cursor: { model: "x" }, kilocode: { model: "x" } } },
      p,
    );
    const none = report.results.filter((r) => r.mechanism === "none");
    expect(none.map((r) => r.harnessId)).toEqual(["copilot", "cursor", "kilocode"]);
    expect(none.flatMap((r) => r.files)).toEqual([]);
    // Nur codex-Artefakte existieren — keine copilot/cursor Files.
    expect(existsSync(join(p.codexSourceHome, "config.toml"))).toBe(true);
    expect(existsSync(join(p.acpxDir, "harness-env"))).toBe(false);
  });

  it("invalid entry (no model) → skipped with warning, no write", () => {
    const p = paths();
    const report = DEPLOY({ harnesses: { claude: { apiKey: "tok" }, codex: null } }, p);
    expect(report.results.every((r) => r.files.length === 0)).toBe(true);
    expect(report.results.every((r) => r.warnings.length > 0)).toBe(true);
    expect(existsSync(p.acpxDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Multi-Model γ (2026-10-13) — Katalog, Entry-Auflösung, Surfaces je Mechanismus
// ---------------------------------------------------------------------------

const CATALOG = buildModelCatalog(
  {
    models: {
      providers: {
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          models: [{ id: "gemma4" }, { id: "kimi-k2.7-code:cloud" }, { id: "glm-5.3-flash:cloud" }],
        },
        broken: { models: [{ id: "z" }] },
      },
    },
  },
  [],
);

describe("normalizeBaseUrlForMatch", () => {
  it("strips trailing slashes + /v1, lowercases host, preserves path", () => {
    expect(normalizeBaseUrlForMatch("http://localhost:11434")).toBe("http://localhost:11434");
    expect(normalizeBaseUrlForMatch("http://localhost:11434/")).toBe("http://localhost:11434");
    expect(normalizeBaseUrlForMatch("http://localhost:11434/v1")).toBe("http://localhost:11434");
    expect(normalizeBaseUrlForMatch("http://localhost:11434/v1/")).toBe("http://localhost:11434");
    expect(normalizeBaseUrlForMatch("HTTP://LOCALHOST:11434")).toBe("http://localhost:11434");
    expect(normalizeBaseUrlForMatch("http://h:1/v1/x")).toBe("http://h:1/v1/x");
  });
});

describe("buildModelCatalog", () => {
  it("collects provider ids by normalized baseUrl (dedupe, sorted keys)", () => {
    const warnings: string[] = [];
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            a: {
              baseUrl: "http://b:1234/v1",
              models: [{ id: "x" }, { id: "y" }, { id: "x" }],
            },
            b: { baseUrl: "http://b:1234", models: [{ id: "z" }] },
          },
        },
      },
      warnings,
    );
    // Beide Provider matchen dieselbe normalisierte baseUrl → union, deduped.
    const key = normalizeBaseUrlForMatch("http://b:1234");
    expect(catalog.byBaseUrl.get(key)).toEqual(["x", "y", "z"]);
    expect(warnings).toEqual([]);
  });

  it("fail-soft: malformed provider/models entries → warning, others survive", () => {
    const warnings: string[] = [];
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: { baseUrl: "http://b:1234", models: [{ id: "x" }] },
            bad1: { models: [{ id: "z" }] },
            bad2: { baseUrl: 42 },
          },
        },
      },
      warnings,
    );
    expect(catalog.byBaseUrl.get(normalizeBaseUrlForMatch("http://b:1234"))).toEqual(["x"]);
    expect(warnings.some((w) => w.includes("skipped 2 malformed"))).toBe(true);
  });

  it("garbage top shape → empty catalog + warning (never a crash)", () => {
    const warnings: string[] = [];
    const catalog = buildModelCatalog({ models: { providers: "junk" } }, warnings);
    expect(catalog.byBaseUrl.size).toBe(0);
    expect(warnings.some((w) => w.includes("unexpected shape"))).toBe(true);
  });

  it("no models section → empty catalog, no warning (default additive case)", () => {
    const warnings: string[] = [];
    const catalog = buildModelCatalog({}, warnings);
    expect(catalog.byBaseUrl.size).toBe(0);
    expect(warnings).toEqual([]);
  });
});

describe("resolveEntryModels", () => {
  const CATALOG_URL = normalizeBaseUrlForMatch("http://localhost:11434");

  it("explicit non-empty wins over the catalog; default prepended at 0", () => {
    const r = resolveEntryModels(
      { model: "glm-5.3-flash:cloud", baseUrl: "http://localhost:11434", models: ["m2", "m3"] },
      CATALOG,
    );
    expect(r.source).toBe("explicit");
    expect(r.models).toEqual(["glm-5.3-flash:cloud", "m2", "m3"]);
  });

  it("models: [] is an explicit OPT-OUT — source 'optout' (N2: getrennt von 'none'), even with a catalog match", () => {
    const r = resolveEntryModels(
      { model: "d", baseUrl: "http://localhost:11434", models: [] },
      CATALOG,
    );
    expect(r.source).toBe("optout");
    expect(r.models).toEqual([]);
  });

  it("absent models → auto-match via normalized baseUrl (with or without /v1)", () => {
    for (const baseUrl of ["http://localhost:11434", "http://localhost:11434/v1/"]) {
      const r = resolveEntryModels({ model: "gemma4", baseUrl }, CATALOG);
      expect(r.source).toBe("matched");
      expect(r.models).toEqual([
        "gemma4",
        "kimi-k2.7-code:cloud",
        "glm-5.3-flash:cloud",
      ]);
    }
  });

  it("absent models + no baseUrl match → none (no surface, no regression)", () => {
    const r = resolveEntryModels({ model: "d", baseUrl: "http://elsewhere:9" }, CATALOG);
    expect(r.source).toBe("none");
    expect(r.models).toEqual([]);
  });

  it("invalid models field → warning + fallback (entry stays alive, fail-soft)", () => {
    const r = resolveEntryModels(
      { model: "gemma4", baseUrl: "http://localhost:11434", models: "junk" as unknown as string[] },
      CATALOG,
    );
    expect(r.warnings.join(" ")).toContain("must be array of non-empty strings");
    expect(r.source).toBe("matched");
    expect(r.models[0]).toBe("gemma4");
  });

  it("invalid ids are dropped with a warning, rest survives", () => {
    const r = resolveEntryModels(
      {
        model: "d",
        models: ["x", "  ", 5, "", "x"] as unknown as string[],
      },
      null,
    );
    expect(r.source).toBe("explicit");
    expect(r.models).toEqual(["d", "x"]);
    expect(r.warnings.join(" ")).toContain("invalid ids dropped");
  });

  it("model lists are capped at MAX_MODELS (default prepended inside the cap)", () => {
    const huge = Array.from({ length: 250 }, (_, i) => `m${i}`);
    const r = resolveEntryModels({ model: "d", models: huge }, null);
    expect(r.models.length).toBe(200);
    expect(r.models[0]).toBe("d");
    expect(r.warnings.join(" ")).toContain("capped at 200");
  });
});

describe("codex writer multi-model", () => {
  it("profiles per model id (quoted keys, ':'-safe), default stays top-level", () => {
    const toml = buildCodexConfigToml({
      model: "kimi-k2.7-code:cloud",
      baseUrl: "http://localhost:11434",
      thinking: "high",
      models: ["kimi-k2.7-code:cloud", "glm-5.3-flash:cloud", "kimi-k2.7-code:cloud"],
    });
    const headers = toml.split("\n").filter((l) => l.startsWith("[profiles."));
    expect(headers).toEqual(['[profiles."kimi-k2.7-code:cloud"]', '[profiles."glm-5.3-flash:cloud"]']);
    expect(toml.startsWith("# harness-config-writer (generated)")).toBe(true);
    expect(toml).toContain("inherited by acpx");
    expect(toml).toMatch(/^model = "kimi-k2\.7-code:cloud"$/m);
    // Profile-Blöcke: model + reasoning effort + gleicher provider.
    expect(toml).toMatch(
      /\[profiles\."glm-5\.3-flash:cloud"\]\nmodel = "glm-5\.3-flash:cloud"\nmodel_reasoning_effort = "high"\nmodel_provider = "binding_localhost_11434"/,
    );
  });

  it("no models → NO profile table (byte-compatible surface, only header grows)", () => {
    const toml = buildCodexConfigToml({ ...OLLAMA });
    expect(toml).not.toMatch(/^\[profiles\./m);
  });

  it("thinking NOT set → profiles carry no reasoning effort line", () => {
    const toml = buildCodexConfigToml({
      ...OLLAMA,
      models: ["a", "b"],
    });
    expect(toml).toMatch(/\[profiles\."a"\]\nmodel = "a"\nmodel_provider = /);
    expect(toml).not.toMatch(/^model_reasoning_effort =/m);
  });

  it("e2e: catalog enrichment drives the profiles via deploy (models: matched)", () => {
    const p = paths();
    const report = deployHarnessConfigs(
      { harnesses: { codex: OLLAMA } },
      p,
      { warn: () => {}, info: () => {}, debug: () => {} },
      CATALOG,
    );
    expect(report.results[0].modelsSource).toBe("matched");
    const toml = readText(join(p.codexSourceHome, "config.toml"));
    expect(toml).toContain('[profiles."glm-5.3-flash:cloud"]');
    expect(report.results[0].warnings).toEqual([]);
  });

  it("self-recognition: signature-line file is bytes-synced (model list refresh works)", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    writeFileSync(
      tomlPath,
      '# harness-config-writer (generated)\nmodel = "old-m"\n[model_providers.binding_localhost_11434]\nbase_url = "old"\n',
      "utf-8",
    );
    const report = DEPLOY(
      { harnesses: { codex: { ...OLLAMA, models: ["a", "b"] } } },
      p,
    );
    expect(
      report.results[0].files.find((f) => f.path === tomlPath)?.action,
    ).toBe("updated");
    const toml = readText(tomlPath);
    expect(toml).toContain('model = "kimi-k2.7-code:cloud"');
    expect(toml).toContain('[profiles."a"]');
  });
});

describe("codex model metadata catalog (γ.1)", () => {
  const META_CATALOG = buildModelCatalog(
    {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            models: [
              { id: "kimi-k2.7-code:cloud", contextWindow: 262144, maxTokens: 8192 },
              { id: "gemma4", contextWindow: 128000 },
              { id: "no-meta" },
              { id: "bad", contextWindow: 0 },
              { id: "bad", contextWindow: -5 },
              { id: "bad", contextWindow: "junk" },
            ],
          },
        },
      },
    },
    [],
  );

  it("buildModelCatalog collects operator metadata (first-occurrence, positive numbers only, M4: maxTokens has no surface and is NOT collected)", () => {
    expect(META_CATALOG.metaById.get("kimi-k2.7-code:cloud")).toEqual({
      contextWindow: 262144,
    });
    expect(META_CATALOG.metaById.get("gemma4")).toEqual({ contextWindow: 128000 });
    expect(META_CATALOG.metaById.has("no-meta")).toBe(false);
    expect(META_CATALOG.metaById.has("bad")).toBe(false);
  });

  it("buildCodexModelCatalogJson emits only models with contextWindow (never guesses)", () => {
    const built = buildCodexModelCatalogJson(
      ["kimi-k2.7-code:cloud", "gemma4", "no-meta", "kimi-k2.7-code:cloud"],
      META_CATALOG.metaById,
    );
    expect(built).not.toBeNull();
    expect(built!.included).toBe(2);
    expect(built!.skipped).toEqual(["no-meta"]);
    const parsed = JSON.parse(built!.content) as { models: Record<string, unknown>[] };
    expect(parsed.models).toHaveLength(2);
    const kimi = parsed.models[0];
    // Binary-verified (2026-10-13, deployed binary via `codex debug models`):
    // genau DIESE Pflicht-/Metadaten-Felder — Optionals entfallen.
    expect(kimi).toEqual({
      slug: "kimi-k2.7-code:cloud",
      display_name: "kimi-k2.7-code:cloud",
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
      truncation_policy: { mode: "bytes", limit: 10000 },
      supports_parallel_tool_calls: false,
      experimental_supported_tools: [],
      input_modalities: ["text"],
      context_window: 262144,
      max_context_window: 262144,
      effective_context_window_percent: 95,
    });
  });

  it("no model has metadata → null (no catalog file, no config key)", () => {
    expect(buildCodexModelCatalogJson(["no-meta"], new Map())).toBeNull();
  });

  it("buildCodexConfigToml references model_catalog_json only when a path is given", () => {
    const withPath = buildCodexConfigToml({ ...OLLAMA }, "/config/.codex/model-catalog.json");
    expect(withPath).toMatch(
      /^model_catalog_json = "\/config\/\.codex\/model-catalog\.json"$/m,
    );
    const without = buildCodexConfigToml({ ...OLLAMA });
    expect(without).not.toMatch(/^model_catalog_json =/m);
  });

  it("e2e: writer toml + model-catalog.json bytes-synced, idempotent (2nd deploy unchanged)", () => {
    const p = paths();
    const catalogReport = deployHarnessConfigs(
      { harnesses: { codex: { ...OLLAMA, models: ["gemma4", "no-meta"] } } },
      p,
      SILENT,
      META_CATALOG,
    );
    const toml = readText(join(p.codexSourceHome, "config.toml"));
    expect(toml).toMatch(/^model_catalog_json = /m);
    const catalogPath = join(p.codexSourceHome, "model-catalog.json");
    const first = readText(catalogPath);
    const parsed = JSON.parse(first) as { models: Record<string, unknown>[] };
    // prependDefaultModel: entry.model (kimi, HAT Metadaten) an Pos. 0 —
    // no-meta bleibt draußen (never guess).
    expect(parsed.models).toHaveLength(2);
    expect(parsed.models.map((m) => m.slug)).toEqual(["kimi-k2.7-code:cloud", "gemma4"]);
    expect(
      catalogReport.results[0].files.find((f) => f.path === catalogPath)?.action,
    ).toBe("created");
    // 2. Deploy → beide Dateien unchanged (bytes-idempotent).
    const again = deployHarnessConfigs(
      { harnesses: { codex: { ...OLLAMA, models: ["gemma4", "no-meta"] } } },
      p,
      SILENT,
      META_CATALOG,
    );
    expect(
      again.results[0].files.find((f) => f.path === catalogPath)?.action,
    ).toBe("unchanged");
    expect(
      again.results[0].files.find((f) => f.path === join(p.codexSourceHome, "config.toml"))
        ?.action,
    ).toBe("unchanged");
    expect(readText(catalogPath)).toBe(first);
  });

  it("customized config.toml (NOTE) → NO orphan catalog file", () => {
    const p = paths();
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    writeFileSync(
      join(p.codexSourceHome, "config.toml"),
      "# custom\ngaron = true\n[model_providers.garon_ollama]\nbase_url = \"x\"\n",
      "utf-8",
    );
    const report = deployHarnessConfigs(
      { harnesses: { codex: { ...OLLAMA, models: ["gemma4"] } } },
      p,
      SILENT,
      META_CATALOG,
    );
    expect(
      report.results[0].files.find((f) => f.path.endsWith("config.toml"))?.action,
    ).toBe("note (customized, left intact)");
    expect(existsSync(join(p.codexSourceHome, "model-catalog.json"))).toBe(false);
  });

  it("M1 (iii): models resolved to NONE (absent + no baseUrl match) → NO model_catalog_json key, NO catalog file", () => {
    const p = paths();
    // baseUrl matcht META_CATALOG NICHT → resolveEntryModels = "none", die
    // models-Surface bleibt ABWESEND — ein Ein-Modell-Default-Katalog wird
    // bewusst NICHT gebaut (kein Dangling-Key-/Orphan-Risiko).
    const report = deployHarnessConfigs(
      { harnesses: { codex: { ...OLLAMA, baseUrl: "http://elsewhere:9" } } },
      p,
      SILENT,
      META_CATALOG,
    );
    expect(report.results[0].files.map((f) => f.action)).toEqual([
      "created",
      "created",
    ]);
    expect(readText(join(p.codexSourceHome, "config.toml"))).not.toMatch(
      /^model_catalog_json =/m,
    );
    expect(existsSync(join(p.codexSourceHome, "model-catalog.json"))).toBe(false);
  });

  it("M1 (iv): explicit list whose ids + default ALL lack contextWindow → toml written WITHOUT the key (no dangling reference)", () => {
    const p = paths();
    const report = deployHarnessConfigs(
      {
        harnesses: {
          codex: {
            model: "glm-5.3-flash:cloud",
            baseUrl: "http://localhost:11434",
            models: ["metaless-1", "metaless-2"],
          },
        },
      },
      p,
      SILENT,
      META_CATALOG,
    );
    expect(readText(join(p.codexSourceHome, "config.toml"))).not.toMatch(
      /^model_catalog_json =/m,
    );
    expect(existsSync(join(p.codexSourceHome, "model-catalog.json"))).toBe(false);
    // toml selbst ist trotzdem normal geschrieben (created) — nur ohne Key.
    expect(
      report.results[0].files.find((f) => f.path.endsWith("config.toml"))?.action,
    ).toBe("created");
  });

  it("M1 (v): opt-out (models: []) → toml WITHOUT key; existing stale catalog file is deliberately NOT deleted (never guess)", () => {
    const p = paths();
    const staleCatalog = join(p.codexSourceHome, "model-catalog.json");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    writeFileSync(staleCatalog, '{"models":[]}\n', "utf-8");
    const report = deployHarnessConfigs(
      { harnesses: { codex: { ...OLLAMA, models: [] } } },
      p,
      SILENT,
      META_CATALOG,
    );
    const toml = readText(join(p.codexSourceHome, "config.toml"));
    expect(toml).not.toMatch(/^model_catalog_json =/m);
    expect(readText(staleCatalog)).toBe('{"models":[]}\n');
    expect(report.results.map((r) => r.files.find((f) => f.path === staleCatalog))).toEqual([
      undefined,
    ]);
  });
});

describe("opencode writer multi-model", () => {
  it("models map carries default first + all ids + smallModel when differing", () => {
    const cfg = JSON.parse(
      buildOpencodeConfigJsonc({
        model: "gemma4",
        baseUrl: "http://localhost:11434",
        smallModel: "nomic-embed-text:latest",
        models: ["kimi-k2.7-code:cloud", "glm-5.3-flash:cloud"],
      }),
    ) as { provider: Record<string, { models: Record<string, unknown> }>; model: string; small_model: string };
    const provider = Object.keys(cfg.provider)[0];
    const ids = Object.keys(cfg.provider[provider].models);
    expect(ids).toEqual([
      "gemma4",
      "kimi-k2.7-code:cloud",
      "glm-5.3-flash:cloud",
      "nomic-embed-text:latest",
    ]);
    expect(cfg.model).toBe("binding_localhost_11434/gemma4");
    expect(cfg.small_model).toBe("binding_localhost_11434/nomic-embed-text:latest");
  });

  it("no models → byte-identical single-entry map (pre-γ parity)", () => {
    const cfg = JSON.parse(buildOpencodeConfigJsonc({ ...OLLAMA })) as {
      provider: Record<string, { models: Record<string, unknown> }>;
    };
    const provider = Object.keys(cfg.provider)[0];
    expect(Object.keys(cfg.provider[provider].models)).toEqual(["kimi-k2.7-code:cloud"]);
  });

  it("e2e: sync-on-diff when the model list changes (updated)", () => {
    const p = paths();
    DEPLOY({ harnesses: { opencode: OLLAMA } }, p);
    const target = join(p.acpxDir, "opencode-home", "opencode.jsonc");
    const report = DEPLOY(
      { harnesses: { opencode: { ...OLLAMA, models: ["gemma4", "glm-5.3-flash:cloud"] } } },
      p,
    );
    const updated = report.results[0].files.find((f) => f.path === target)?.action;
    expect(updated).toBe("updated");
    const cfg = JSON.parse(readText(target)) as {
      provider: Record<string, { models: Record<string, unknown> }>;
    };
    expect(Object.keys(cfg.provider[Object.keys(cfg.provider)[0]].models)).toEqual([
      "kimi-k2.7-code:cloud",
      "gemma4",
      "glm-5.3-flash:cloud",
    ]);
  });
});

describe("claude env multi-model", () => {
  it("catalog match → CLAUDE_MODEL_CONFIG with availableModels (default is member)", () => {
    const p = paths();
    deployHarnessConfigs(
      { harnesses: { claude: { model: "gemma4", baseUrl: "http://localhost:11434", apiKey: "ollama" } } },
      p,
      SILENT,
      CATALOG,
    );
    const env = readText(join(p.acpxDir, "harness-env", "claude.env"));
    expect(env).toContain(
      `CLAUDE_MODEL_CONFIG='{"availableModels":["gemma4","kimi-k2.7-code:cloud","glm-5.3-flash:cloud"]}'`,
    );
    expect(env).toContain(`ANTHROPIC_MODEL='gemma4'`);
    // claude hat die echte Surface → KEIN informational-Kommentar.
    expect(env).not.toContain("# available models");
  });

  it("no models surface → CLAUDE_MODEL_CONFIG ABSENT (pre-γ parity)", () => {
    const p = paths();
    DEPLOY({ harnesses: { claude: { model: "gemma4", baseUrl: "http://localhost:11434" } } }, p);
    const env = readText(join(p.acpxDir, "harness-env", "claude.env"));
    expect(env).not.toContain("CLAUDE_MODEL_CONFIG");
    expect(env).toContain(`ANTHROPIC_MODEL='gemma4'`);
  });
});

describe("env models comment (no multi-model env surface)", () => {
  it("gemini.env lists available models as informational comment, capped at 25", () => {
    const p = paths();
    const many = Array.from({ length: 30 }, (_, i) => `m${i}`);
    deployHarnessConfigs(
      { harnesses: { gemini: { model: "m0", baseUrl: "http://localhost:11434" } } },
      p,
  SILENT,
      buildModelCatalog(
        {
          models: {
            providers: {
              ollama: {
                baseUrl: "http://localhost:11434",
                models: many.map((id) => ({ id })),
              },
            },
          },
        },
        [],
      ),
    );
    const env = readText(join(p.acpxDir, "harness-env", "gemini.env"));
    expect(env).toContain("# available models (informational — gemini exposes no multi-model env surface):");
    const listed = env.split("\n").filter((l) => l.startsWith("# - "));
    expect(listed.length).toBe(25);
    expect(env).toContain("(+5 more)");
  });

  it("no match → no comment block", () => {
    const p = paths();
    deployHarnessConfigs(
      { harnesses: { gemini: { model: "m0", baseUrl: "http://elsewhere:9" } } },
      p,
      SILENT,
      CATALOG,
    );
    const env = readText(join(p.acpxDir, "harness-env", "gemini.env"));
    expect(env).not.toContain("# available models");
  });
});

// ---------------------------------------------------------------------------
// Pfadauflösung (ENV-Ladder wie agent-map.resolveOpenClawStateDir)
// ---------------------------------------------------------------------------

describe("resolveHarnessWriterPaths", () => {
  it("STATE /config/.openclaw → helper-equivalent constant layout", () => {
    const p = resolveHarnessWriterPaths({ OPENCLAW_STATE_DIR: "/config/.openclaw" });
    expect(p).toEqual({
      acpxDir: "/config/.openclaw/acpx",
      codexSourceHome: "/config/.codex",
      opencodeGlobalDir: "/config/opencode",
    });
  });

  it("unresolvable env → null (honest degrade)", () => {
    expect(resolveHarnessWriterPaths({})).toBe(null);
  });
});