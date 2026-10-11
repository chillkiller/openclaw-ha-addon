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
  buildOpencodeConfigJsonc,
  deployHarnessConfigs,
  deriveProviderId,
  OPENCODE_LEGACY_PLACEHOLDER,
  renderEnvFile,
  resolveHarnessWriterPaths,
  withV1Suffix,
  type HarnessConfigEntry,
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

const DEPLOY = (config: unknown, p = paths()) =>
  deployHarnessConfigs(config, p, {
    debug: () => {},
    info: () => {},
    warn: () => {},
  });

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
    // thinking NICHT gesetzt → model_reasoning_effort fehlt.
    expect(toml).not.toContain("model_reasoning_effort");
    expect(report.results[0].mechanism).toBe("file-codex");
    expect(report.results[0].files.map((f) => f.action)).toEqual(["created", "created"]);
  });

  it("thinking set → model_reasoning_effort; empty → absent", () => {
    const withThinking = buildCodexConfigToml({ ...OLLAMA, thinking: "medium" });
    expect(withThinking).toContain('model_reasoning_effort = "medium"');
    const blank = buildCodexConfigToml({ ...OLLAMA, thinking: "" });
    expect(blank).not.toContain("model_reasoning_effort");
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