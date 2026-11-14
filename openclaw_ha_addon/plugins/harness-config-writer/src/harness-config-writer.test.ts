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
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildClaudeSettingsJson,
  buildCodexConfigToml,
  buildCodexModelCatalogJson,
  buildModelCatalog,
  buildOpencodeConfigJsonc,
  buildPiModelsJson,
  buildPiSettingsJson,
  deployHarnessConfigs,
  derivePiProviderId,
  deriveProviderId,
  normalizeBaseUrlForMatch,
  OPENCODE_LEGACY_PLACEHOLDER,
  renderEnvFile,
  resolveEntryModels,
  resolveHarnessWriterPaths,
  resolveOpencodeGlobalDir,
  resolvePiProviderId,
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

function paths(home = root): HarnessWriterPaths {
  return {
    acpxDir: join(root, "state", "acpx"),
    codexSourceHome: join(root, "config", ".codex"),
    opencodeGlobalDir: resolveOpencodeGlobalDir({ HOME: home }) ?? join(home, ".config", "opencode"),
    claudeSourceHome: join(root, "config", ".claude"),
    piAgentDir: join(root, "config", ".pi", "agent"),
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

const DEPLOY = (config: unknown, p = paths(), catalog?: ReturnType<typeof buildModelCatalog>) => deployHarnessConfigs(config, p, SILENT, catalog);

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
    // Schritt 4: zusätzlich HCW-eigener Wrapper + Home (config.toml + auth.json).
    expect(report.results[0].files.map((f) => f.action)).toEqual([
      "created",
      "created",
      "created",
      "created",
      "created",
    ]);
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

  it("augment: foreign file WITHOUT [model_providers. block → marked provider section APPENDED, operator content preserved (GaRoN 2026-10-16)", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    const foreign = 'model = "gpt-5"\n';
    writeFileSync(tomlPath, foreign, "utf-8");
    const report = DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    // AUGMENT statt Replace: Operator-Content bleibt, markierter Abschnitt kommt dazu.
    expect(
      report.results[0].files.some((f) => f.path === tomlPath && f.action === "augmented"),
    ).toBe(true);
    const after = readText(tomlPath);
    expect(after.startsWith(foreign.replace(/\n$/, ""))).toBe(true);
    expect(after).toContain("--- BEGIN harness-config-writer (generated) ---");
    expect(after).toContain("--- END harness-config-writer (generated) ---");
    // KEIN Writer-Routing in fremden Dateien (Model-Wahl = Operator).
    expect(after).not.toMatch(/^model_provider = /m);
    expect(after).not.toMatch(/^model_catalog_json = /m);
    expect(after).toContain("[model_providers.binding_localhost_11434]");
    // Operator-Key model = "gpt-5" unverändert (kein Überschreiben).
    expect(after).toContain('model = "gpt-5"');
  });

  it("augment idempotent: re-deploy on already-augmented file → unchanged", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    writeFileSync(tomlPath, 'model = "gpt-5"\n', "utf-8");
    DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    const afterFirst = readText(tomlPath);
    const report = DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    expect(
      report.results[0].files.some((f) => f.path === tomlPath && f.action === "unchanged"),
    ).toBe(true);
    expect(readText(tomlPath)).toBe(afterFirst);
  });

  it("augment refresh: baseUrl change re-writes ONLY the marked section, operator content untouched", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    writeFileSync(tomlPath, 'model = "gpt-5"\n', "utf-8");
    DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    const report = DEPLOY(
      { harnesses: { codex: { ...OLLAMA, baseUrl: "http://elsewhere:9" } } },
      p,
    );
    expect(
      report.results[0].files.some((f) => f.path === tomlPath && f.action === "updated"),
    ).toBe(true);
    const after = readText(tomlPath);
    expect(after).toContain('model = "gpt-5"'); // Operator-Zeile unangetastet
    expect(after).not.toContain("[model_providers.binding_localhost_11434]"); // alte Section weg
    expect(after).toContain("[model_providers.binding_elsewhere_9]"); // neue Section da
  });

  // ---- Final-Audit r2 Regression: jede behobene Critical/High/Medium-Lücke ----

  it("r2 CRITICAL-1: marker substring in operator COMMENT does not truncate operator content", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    const foreign = '# managed blocks look like: # --- BEGIN harness-config-writer (generated) ---\nmodel = "gpt-5"\n';
    writeFileSync(tomlPath, foreign, "utf-8");
    const report = DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    const after = readText(tomlPath);
    // Operator-Zeile model = "gpt-5" muss vollständig bleiben (kein Mid-Line-Slice)
    expect(after).toContain('model = "gpt-5"');
    // Der Kommentar-Dokumentarion des Markers bleibt unangetastet
    expect(after).toContain("# managed blocks look like:");
  });

  it("r2 HIGH-1: BEGIN marker without END is treated as foreign — content after BEGIN preserved", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    const foreign =
      'model = "gpt-5"\n# --- BEGIN harness-config-writer (generated) ---\n[projects."/op-thing"]\ntrust_level = "trusted"\n';
    writeFileSync(tomlPath, foreign, "utf-8");
    const report = DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    const after = readText(tomlPath);
    // Operator-Content NACH dem unterminierten BEGIN bleibt erhalten
    expect(after).toContain('[projects."/op-thing"]');
    expect(after).toContain('model = "gpt-5"');
    // Warnung über den unterminierten Marker
    const codex = report.results.find((r) => r.harnessId === "codex");
    expect(codex?.warnings.join(" ")).toContain("unterminated writer marker");
  });

  it("r2 HIGH-2: refresh with total collision strips our dead managed block (converges, valid TOML)", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    writeFileSync(tomlPath, 'model = "gpt-5"\n', "utf-8");
    DEPLOY({ harnesses: { codex: { ...OLLAMA, models: ["m1"] } } }, p);
    // Operator adoptiert den Provider-Header oberhalb des Blocks (Total-Kollision)
    const before = readText(tomlPath);
    const withOperatorHeader = '[model_providers.binding_localhost_11434]\nbase_url = "x"\n\n' + before;
    writeFileSync(tomlPath, withOperatorHeader, "utf-8");
    const report = DEPLOY({ harnesses: { codex: { ...OLLAMA, models: [] } } }, p);
    const after = readText(tomlPath);
    // Unser alter toter Block ist RAUS (kein doppelter Header, Konvergenz)
    expect(after).not.toContain("--- BEGIN harness-config-writer");
    expect(after).not.toContain("[profiles.");
    // Operator-Header bleibt
    expect((after.match(/\[model_providers\.binding_localhost_11434\]/g) ?? []).length).toBe(1);
    expect(
      report.results[0].files.some((f) => f.path === tomlPath && f.action === "updated"),
    ).toBe(true);
  });

  it("r2 HIGH-3: bare operator header aliases our quoted header — no duplicate tables", () => {


    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    writeFileSync(tomlPath, 'model = "gpt-5"\n[profiles.m1]\nmodel = "m1"\n', "utf-8");
    const report = DEPLOY({ harnesses: { codex: { ...OLLAMA, models: ["m1"] } } }, p);
    const after = readText(tomlPath);
    // [profiles.m1] (bare) und [profiles."m1"] (quoted) sind dieselbe logische Table:
    // unser Writer MUSS kollidieren → der Profil-Header existiert genau EINMAL
    // (der Operator-Bare-Header; wir emittieren KEINEN zweiten quoted-Alias).
    expect((after.match(/\[profiles\.m1\]/g) ?? []).length).toBe(1);
    expect(after).not.toContain('[profiles."m1"]');
    const codex = report.results.find((r) => r.harnessId === "codex");
    expect(codex?.warnings.join(" ")).toContain("profiles.m1 (operator header collision)");
  });

  it("r2 Medium-2: operator edits AFTER the END marker survive refresh", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    writeFileSync(tomlPath, 'model = "gpt-5"\n', "utf-8");
    DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    // Operator fügt NACH unserem END-Marker eigenen Content hinzu
    const before = readText(tomlPath);
    writeFileSync(tomlPath, before + '\n[projects."/operator-after"]\ntrust_level = "trusted"\n', "utf-8");
    DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    const after = readText(tomlPath);
    expect(after).toContain('[projects."/operator-after"]');
  });

  it("r2 opencode HIGH-4: operator {model: …} file is NEVER fully replaced (merge, not overwrite)", () => {
    const p = paths();
    const target = join(p.acpxDir, "opencode-home", "opencode.jsonc");
    mkdirSync(join(p.acpxDir, "opencode-home"), { recursive: true });
    writeFileSync(target, '{\n  "model": "ollama/op-choice"\n}\n', "utf-8");
    const report = DEPLOY({ harnesses: { opencode: OLLAMA } }, p);
    const after = readText(target);
    // Operator-Model-Wahl bleibt (merge statt stiller Replace)
    expect(after).toContain('"model": "ollama/op-choice"');
    // Unser Provider-Block ist ergänzt
    expect(after).toContain("binding_localhost_11434");
    const opencode = report.results.find((r) => r.harnessId === "opencode");
    expect(opencode?.files.some((f) => f.path === target && f.action !== "updated")).toBe(true);
  });

  it("r2 opencode F2: provider string shorthand (operator decision) — NOTE, no corruption", () => {
    const p = paths();
    const target = join(p.acpxDir, "opencode-home", "opencode.jsonc");
    mkdirSync(join(p.acpxDir, "opencode-home"), { recursive: true });
    writeFileSync(target, '{\n  "theme": "dark",\n  "provider": "ollama"\n}\n', "utf-8");
    const report = DEPLOY({ harnesses: { opencode: OLLAMA } }, p);
    const after = readText(target);
    // Keine Index-Key-Korruption {"0":"o","1":"l",…}
    expect(after).not.toContain('"0"');
    expect(after).toContain('"provider": "ollama"');
    const opencode = report.results.find((r) => r.harnessId === "opencode");
    expect(opencode?.files.some((f) => f.path === target && f.action === "note (customized, left intact)")).toBe(true);
  });

  it("r2 branch: first-augment with total collision → NOTE, operator file untouched", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    // Operator hat bereits Provider+Profil unter unseren exakten Header-Namen
    const foreign =
      '[model_providers.binding_localhost_11434]\nbase_url = "x"\n[profiles."m1"]\nmodel = "m1"\n[profiles.m1b]\nmodel = "m1b"\n';
    writeFileSync(tomlPath, foreign, "utf-8");
    const report = DEPLOY({ harnesses: { codex: { ...OLLAMA, models: ["m1"] } } }, p);
    const after = readText(tomlPath);
    // Fremd-Datei (kein [model_providers.-freier Fall): NOTE-Zweig greift schon beim
    // providers-Vorkommen — dieser Fall testet die providers-freie Total-Kollision.
    expect(
      report.results[0].files.find((f) => f.path === tomlPath)?.action,
    ).toBe("note (customized, left intact)");
    expect(after).toBe(foreign); // byte-erhalten
  });

  it("r2 branch: opencode unreadable file → NOTE with warning, never crash", () => {
    const p = paths();
    const target = join(p.acpxDir, "opencode-home", "opencode.jsonc");
    mkdirSync(join(p.acpxDir, "opencode-home"), { recursive: true });
    writeFileSync(target, "garbage", "utf-8");
    chmodSync(target, 0o000); // unlesbar machen
    const report = DEPLOY({ harnesses: { opencode: OLLAMA } }, p);
    const opencode = report.results.find((r) => r.harnessId === "opencode");
    const homeFile = opencode?.files.find((f) => f.path === target);
    expect(homeFile?.action).toBe("note (customized, left intact)");
    expect(opencode?.warnings.join(" ")).toContain("unreadable");
    chmodSync(target, 0o600); // für afterEach-Cleanup
  });

  it("r2 branch: commented JSONC (operator formatting) → NOTE, never destroyed", () => {
    const p = paths();
    const target = join(p.acpxDir, "opencode-home", "opencode.jsonc");
    mkdirSync(join(p.acpxDir, "opencode-home"), { recursive: true });
    const commented = '{\n  // my curated provider setup\n  "model": "x"\n}\n';
    writeFileSync(target, commented, "utf-8");
    const report = DEPLOY({ harnesses: { opencode: OLLAMA } }, p);
    expect(readText(target)).toBe(commented); // Kommentar-Formatierung bleibt
    const opencode = report.results.find((r) => r.harnessId === "opencode");
    expect(opencode?.files.find((f) => f.path === target)?.action).toBe("note (customized, left intact)");
  });

  it("r2 Medium-1: augmented config.toml never references model_catalog_json — no orphan catalog file", () => {
    const p = paths();
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    writeFileSync(join(p.codexSourceHome, "config.toml"), 'model = "gpt-5"\n', "utf-8");
    const localCatalog = buildModelCatalog(
      { models: { providers: { ollama: { baseUrl: OLLAMA.baseUrl, models: [{ id: "gemma4", contextWindow: 128000 }] } } } },
      [],
    );
    const report = deployHarnessConfigs(
      { harnesses: { codex: { ...OLLAMA, models: ["gemma4"] } } },
      p,
      SILENT,
      localCatalog,
    );
    expect(
      report.results[0].files.find((f) => f.path.endsWith("config.toml"))?.action,
    ).toBe("augmented");
    expect(existsSync(join(p.codexSourceHome, "model-catalog.json"))).toBe(false);
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
    expect(report.results[0].files.map((f) => f.action)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
      "unchanged",
      "unchanged",
    ]);
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

  it("M3 (r2): UPDATE of a pre-existing 0644 opencode.jsonc → 0600 (exposé window closed on update path)", () => {
    const p = paths();
    const file = join(p.acpxDir, "opencode-home", "opencode.jsonc");
    mkdirSync(join(p.acpxDir, "opencode-home"), { recursive: true });
    writeFileSync(file, '{"stale":true}\n', { mode: 0o644 });
    expect(statSync(file).mode & 0o777).toBe(0o644); // Precondition
    DEPLOY({ harnesses: { opencode: { ...OLLAMA, apiKey: "secret-token" } } }, p);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("M3 (r2): BYTE-IDENTICAL 0644 opencode.jsonc → unchanged action BUT mode healed to 0600", () => {
    const p = paths();
    const dir = join(p.acpxDir, "opencode-home");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "opencode.jsonc");
    const desired = buildOpencodeConfigJsonc({ ...OLLAMA, apiKey: "secret-token" });
    writeFileSync(file, desired, { mode: 0o644 });
    const report = DEPLOY(
      { harnesses: { opencode: { ...OLLAMA, apiKey: "secret-token" } } },
      p,
    );
    expect(
      report.results[0].files.find((f) => f.path === file)?.action,
    ).toBe("unchanged");
    expect(statSync(file).mode & 0o777).toBe(0o600);
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

  it("gemini / droid / qwen / kimi / kiro / iflow / copilot map per-CLI (docs-verifiziert)", () => {
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
          copilot: { model: "cp", baseUrl: "http://cb:6", apiKey: "ck" },
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
    expect(env("copilot")).toContain("COPILOT_PROVIDER_BASE_URL='http://cb:6/v1'");
    expect(env("copilot")).toContain("COPILOT_PROVIDER_API_KEY='ck'");
    expect(env("copilot")).toContain("COPILOT_PROVIDER_WIRE_API='responses'");
    expect(env("copilot")).toContain("COPILOT_MODEL='cp'");
  });

  it("copilot without baseUrl: key+model only, no provider routing envs (GitHub-token route, not BYOK)", () => {
    const p = paths();
    const report = DEPLOY(
      { harnesses: { copilot: { model: "cp", apiKey: "ck" } } },
      p,
    );
    const result = report.results.find((r) => r.harnessId === "copilot");
    expect(result?.mechanism).toBe("env");
    const env = readText(join(p.acpxDir, "harness-env", "copilot.env"));
    expect(env).toContain("COPILOT_PROVIDER_API_KEY='ck'");
    expect(env).toContain("COPILOT_MODEL='cp'");
    expect(env).not.toContain("BASE_URL");
    expect(env).not.toContain("WIRE_API");
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
// Mechanismus A — claude settings.json (FILE, zusätzlich zum ENV)
// ---------------------------------------------------------------------------

describe("claude file writer", () => {
  it("fresh install writes ~/.claude/settings.json with model/effort/env", () => {
    const p = paths();
    const report = DEPLOY({
      harnesses: {
        claude: {
          model: "kimi-k2.7-code:cloud",
          baseUrl: "http://localhost:11434",
          apiKey: "tok",
          thinking: "high",
          smallModel: "glm-5.3-flash:cloud",
        },
      },
    }, p);
    const settingsPath = join(p.claudeSourceHome, "settings.json");
    const content = JSON.parse(readText(settingsPath));
    expect(content.model).toBe("kimi-k2.7-code:cloud");
    expect(content.effort).toBe("high");
    expect(content.env).toEqual({
      ANTHROPIC_BASE_URL: "http://localhost:11434",
      ANTHROPIC_AUTH_TOKEN: "tok",
      ANTHROPIC_SMALL_FAST_MODEL: "glm-5.3-flash:cloud",
    });
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    const claudeResult = report.results.find((r) => r.harnessId === "claude");
    expect(claudeResult?.files.some((f) => f.path === settingsPath && f.action === "created")).toBe(true);
  });

  it("claude settings: smallModel falls back to model", () => {
    const json = JSON.parse(buildClaudeSettingsJson({ model: "m", baseUrl: "http://b" }, []));
    expect(json.env.ANTHROPIC_SMALL_FAST_MODEL).toBe("m");
  });

  it("claude settings: thinking absent → effort omitted; invalid thinking → warning", () => {
    const p = paths();
    const report = DEPLOY({
      harnesses: {
        claude: { model: "m", baseUrl: "http://b", apiKey: "k", thinking: "invalid" },
      },
    }, p);
    const content = JSON.parse(readText(join(p.claudeSourceHome, "settings.json")));
    expect(content.effort).toBeUndefined();
    expect(report.results.find((r) => r.harnessId === "claude")?.warnings.join(" ")).toContain(
      'effort level "invalid" is not supported',
    );
  });

  it("claude settings: merge preserves foreign keys and other env vars", () => {
    const p = paths();
    mkdirSync(p.claudeSourceHome, { recursive: true });
    const existing = JSON.stringify(
      { model: "old", permissions: { x: true }, env: { ANTHROPIC_BASE_URL: "http://old", OTHER: "v" } },
      null,
      2,
    );
    writeFileSync(join(p.claudeSourceHome, "settings.json"), `${existing}\n`, "utf-8");
    DEPLOY({ harnesses: { claude: { model: "m", baseUrl: "http://b", apiKey: "k" } } }, p);
    const content = JSON.parse(readText(join(p.claudeSourceHome, "settings.json")));
    expect(content.model).toBe("m");
    expect(content.permissions).toEqual({ x: true });
    expect(content.env.ANTHROPIC_AUTH_TOKEN).toBe("k");
    expect(content.env.OTHER).toBe("v");
  });

  it("claude settings: idempotent", () => {
    const p = paths();
    DEPLOY({ harnesses: { claude: { model: "m", baseUrl: "http://b", apiKey: "k", thinking: "low" } } }, p);
    const first = readText(join(p.claudeSourceHome, "settings.json"));
    const report = DEPLOY({ harnesses: { claude: { model: "m", baseUrl: "http://b", apiKey: "k", thinking: "low" } } }, p);
    expect(readText(join(p.claudeSourceHome, "settings.json"))).toBe(first);
    expect(report.results.find((r) => r.harnessId === "claude")?.files.find((f) =>
      f.path.endsWith("settings.json"),
    )?.action).toBe("unchanged");
  });

  it("claude deploy creates both settings.json and the env file", () => {
    const p = paths();
    const report = DEPLOY({
      harnesses: {
        claude: { model: "m", baseUrl: "http://b", apiKey: "k" },
      },
    }, p);
    const claude = report.results.find((r) => r.harnessId === "claude");
    expect(claude?.files.map((f) => f.path).sort()).toEqual(
      [
        join(p.claudeSourceHome, "settings.json"),
        join(p.acpxDir, "harness-env", "claude.env"),
      ].sort(),
    );
  });

  it("claude absent → no settings.json is created", () => {
    const p = paths();
    DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    expect(existsSync(p.claudeSourceHome)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schritt 3 — copilot: belegbare Provider-Variablen + Merge
// ---------------------------------------------------------------------------

describe("copilot env extended provider variables", () => {
  it("writes TYPE, MODEL_ID, WIRE_MODEL, WIRE_API and MAX_PROMPT_TOKENS when derivable", () => {
    const p = paths();
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [{ id: "cp-model", contextWindow: 128000 }],
            },
          },
        },
      },
      [],
    );
    const report = DEPLOY(
      { harnesses: { copilot: { model: "cp-model", baseUrl: "http://localhost:11434", apiKey: "ck" } } },
      p,
      catalog,
    );
    const env = readText(join(p.acpxDir, "harness-env", "copilot.env"));
    expect(env).toContain("COPILOT_PROVIDER_TYPE='openai'");
    expect(env).toContain("COPILOT_PROVIDER_MODEL_ID='cp-model'");
    expect(env).toContain("COPILOT_PROVIDER_WIRE_MODEL='cp-model'");
    expect(env).toContain("COPILOT_PROVIDER_WIRE_API='responses'");
    expect(env).toContain("COPILOT_PROVIDER_MAX_PROMPT_TOKENS='128000'");
    expect(env).toContain("COPILOT_MODEL='cp-model'");
    expect(report.results.find((r) => r.harnessId === "copilot")?.warnings.join(" ")).toContain(
      "COPILOT_PROVIDER_AZURE_API_VERSION",
    );
  });

  it("copilot wireApi override via entry.wireApi", () => {
    const p = paths();
    DEPLOY({ harnesses: { copilot: { model: "m", baseUrl: "http://b", apiKey: "k", wireApi: "completions" } } }, p);
    const env = readText(join(p.acpxDir, "harness-env", "copilot.env"));
    expect(env).toContain("COPILOT_PROVIDER_WIRE_API='completions'");
  });

  it("copilot env merge preserves foreign keys", () => {
    const p = paths();
    mkdirSync(join(p.acpxDir, "harness-env"), { recursive: true });
    writeFileSync(
      join(p.acpxDir, "harness-env", "copilot.env"),
      "# h\nCOPILOT_PROVIDER_API_KEY='old'\nFOREIGN='keep'\n",
      "utf-8",
    );
    DEPLOY({ harnesses: { copilot: { model: "m", baseUrl: "http://b", apiKey: "new" } } }, p);
    const env = readText(join(p.acpxDir, "harness-env", "copilot.env"));
    expect(env).toContain("COPILOT_PROVIDER_API_KEY='new'");
    expect(env).toContain("FOREIGN='keep'");
  });

  it("copilot env is byte-identical on second deploy", () => {
    const p = paths();
    DEPLOY({ harnesses: { copilot: { model: "m", baseUrl: "http://b", apiKey: "k" } } }, p);
    const first = readText(join(p.acpxDir, "harness-env", "copilot.env"));
    const report = DEPLOY({ harnesses: { copilot: { model: "m", baseUrl: "http://b", apiKey: "k" } } }, p);
    expect(readText(join(p.acpxDir, "harness-env", "copilot.env"))).toBe(first);
    expect(report.results.find((r) => r.harnessId === "copilot")?.files[0]?.action).toBe("unchanged");
  });

  it("copilot without baseUrl: no provider routing vars, key+model only", () => {
    const p = paths();
    DEPLOY({ harnesses: { copilot: { model: "cp", apiKey: "ck" } } }, p);
    const env = readText(join(p.acpxDir, "harness-env", "copilot.env"));
    expect(env).toContain("COPILOT_PROVIDER_API_KEY='ck'");
    expect(env).toContain("COPILOT_MODEL='cp'");
    expect(env).not.toContain("COPILOT_PROVIDER_TYPE");
    expect(env).not.toContain("COPILOT_PROVIDER_BASE_URL");
  });
});

// ---------------------------------------------------------------------------
// Schritt 5 — pi file writer (models.json + settings.json)
// ---------------------------------------------------------------------------

describe("pi file writer", () => {
  it("fresh install writes models.json + settings.json with enabledModels", () => {
    const p = paths();
    const report = DEPLOY(
      { harnesses: { pi: { model: "kimi-k2.7-code:cloud", baseUrl: "http://localhost:11434", apiKey: "tok" } } },
      p,
    );
    const modelsPath = join(p.piAgentDir, "models.json");
    const settingsPath = join(p.piAgentDir, "settings.json");
    const models = JSON.parse(readText(modelsPath));
    const settings = JSON.parse(readText(settingsPath));
    expect(models.providers.binding_localhost_11434.baseUrl).toBe("http://localhost:11434/v1");
    expect(models.providers.binding_localhost_11434.api).toBe("openai-completions");
    expect(models.providers.binding_localhost_11434.apiKey).toBe("tok");
    expect(models.providers.binding_localhost_11434.models[0].id).toBe("kimi-k2.7-code:cloud");
    expect(settings.defaultProvider).toBe("binding_localhost_11434");
    expect(settings.defaultModel).toBe("binding_localhost_11434/kimi-k2.7-code:cloud");
    expect(settings.enabledModels).toEqual(["binding_localhost_11434/*"]);
    expect(statSync(modelsPath).mode & 0o777).toBe(0o600);
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    const piResult = report.results.find((r) => r.harnessId === "pi");
    expect(piResult?.mechanism).toBe("file-pi");
    expect(piResult?.files.map((f) => f.action)).toEqual(["created", "created"]);
  });

  it("pi models[0] ist das entry.model, auch wenn eine Modellliste mitkommt (pi nimmt models[0] als Default)", () => {
    const p = paths();
    DEPLOY(
      {
        harnesses: {
          pi: {
            model: "kimi-k2.7-code:cloud",
            models: ["glm-ocr:latest", "qwen2.5:3b"],
            baseUrl: "http://localhost:11434",
            apiKey: "tok",
          },
        },
      },
      p,
    );
    const models = JSON.parse(readText(join(p.piAgentDir, "models.json")));
    const provider = models.providers.binding_localhost_11434;
    // models.json ist ein ARRAY — pi nimmt models[0] als Default-Modell.
    expect(provider.models[0].id).toBe("kimi-k2.7-code:cloud");
    expect(provider.models.map((m: { id: string }) => m.id)).toEqual([
      "kimi-k2.7-code:cloud",
      "glm-ocr:latest",
      "qwen2.5:3b",
    ]);
  });

  it("pi settings: invalid thinking level → warning and key omitted", () => {
    const p = paths();
    const report = DEPLOY(
      { harnesses: { pi: { model: "m", baseUrl: "http://b", apiKey: "k", thinking: "mega" } } },
      p,
    );
    const settings = JSON.parse(readText(join(p.piAgentDir, "settings.json")));
    expect(settings.defaultThinkingLevel).toBeUndefined();
    expect(report.results.find((r) => r.harnessId === "pi")?.warnings.join(" ")).toContain(
      'defaultThinkingLevel "mega" is not supported',
    );
  });

  it("pi models.json merge preserves foreign providers", () => {
    const p = paths();
    mkdirSync(p.piAgentDir, { recursive: true });
    const existing = JSON.stringify(
      { $schema: "https://pi.dev/schemas/models.schema.json", providers: { foreign: { name: "f" } } },
      null,
      2,
    );
    writeFileSync(join(p.piAgentDir, "models.json"), `${existing}\n`, "utf-8");
    DEPLOY({ harnesses: { pi: { model: "m", baseUrl: "http://b", apiKey: "k" } } }, p);
    const models = JSON.parse(readText(join(p.piAgentDir, "models.json")));
    expect(models.providers.foreign).toEqual({ name: "f" });
    expect(models.providers.binding_b).toBeDefined();
  });

  it("pi: adopts an existing provider with the same baseUrl (Variante A)", () => {
    const p = paths();
    mkdirSync(p.piAgentDir, { recursive: true });
    // Bestehender, hand-gepflegter Provider "ollama" auf derselben baseUrl
    // (mit Bild-Input-Metadaten, die beim Mergie NICHT verloren gehen dürfen).
    const existing = JSON.stringify(
      {
        $schema: "https://pi.dev/schemas/models.schema.json",
        providers: {
          ollama: {
            name: "Ollama (lokal)",
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            apiKey: "ollama",
            models: [{ id: "legacy-model", reasoning: false, input: ["text", "image"] }],
          },
        },
      },
      null,
      2,
    );
    writeFileSync(join(p.piAgentDir, "models.json"), `${existing}\n`, "utf-8");
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: { baseUrl: "http://localhost:11434", models: [{ id: "m", contextWindow: 32000 }] },
          },
        },
      },
      [],
    );
    DEPLOY({ harnesses: { pi: { model: "m", baseUrl: "http://localhost:11434" } } }, p, catalog);
    const models = JSON.parse(readText(join(p.piAgentDir, "models.json")));
    // Genau EIN Provider auf dieser baseUrl — kein Duplikat-Key.
    expect(Object.keys(models.providers)).toEqual(["ollama"]);
    // Das neue Gateway-Modell ist da ...
    expect(models.providers.ollama.models.map((m: { id: string }) => m.id)).toContain("m");
    // ... und das hand-gepflegte Modell bleibt MIT seinen Metadaten erhalten.
    const legacy = models.providers.ollama.models.find((m: { id: string }) => m.id === "legacy-model");
    expect(legacy).toBeDefined();
    expect(legacy.input).toEqual(["text", "image"]);
    expect(legacy.reasoning).toBe(false);
  });

  it("pi: writer-owned provider block is updated, not treated as operator-owned", () => {
    const p = paths();
    mkdirSync(p.piAgentDir, { recursive: true });
    // Ein Block, den der WRITER selbst erzeugt hat (Namens-Präfix) — er
    // muss bei jedem Boot bytes-genau aktualisiert werden, sonst friert der
    // erste Boot mit einem Modell alle späteren Boots ein.
    const existing = JSON.stringify(
      {
        $schema: "https://pi.dev/schemas/models.schema.json",
        providers: {
          ollama: {
            name: "harness-config-writer (http://localhost:11434/v1)",
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            apiKey: "ollama",
            models: [{ id: "stale" }],
          },
        },
      },
      null,
      2,
    );
    writeFileSync(join(p.piAgentDir, "models.json"), `${existing}\n`, "utf-8");
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: { baseUrl: "http://localhost:11434", models: [{ id: "m", contextWindow: 32000 }] },
          },
        },
      },
      [],
    );
    DEPLOY({ harnesses: { pi: { model: "m", baseUrl: "http://localhost:11434" } } }, p, catalog);
    const models = JSON.parse(readText(join(p.piAgentDir, "models.json")));
    const ids = models.providers.ollama.models.map((m: { id: string }) => m.id);
    expect(ids).toContain("m");
    expect(ids).not.toContain("stale");
  });

  it("pi: contextWindow / reasoning / input / name / maxTokens come from the gateway catalog", () => {
    const p = paths();
    mkdirSync(p.piAgentDir, { recursive: true });
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [
                {
                  id: "ocr",
                  name: "GLM OCR",
                  reasoning: false,
                  input: ["text", "image"],
                  maxTokens: 8192,
                  contextWindow: 131072,
                },
              ],
            },
          },
        },
      },
      [],
    );
    DEPLOY({ harnesses: { pi: { model: "ocr", baseUrl: "http://localhost:11434" } } }, p, catalog);
    const models = JSON.parse(readText(join(p.piAgentDir, "models.json")));
    const rec = models.providers.ollama.models[0];
    expect(rec.reasoning).toBe(false);
    expect(rec.input).toEqual(["text", "image"]);
    expect(rec.name).toBe("GLM OCR");
    expect(rec.maxTokens).toBe(8192);
    expect(rec.contextWindow).toBe(131072);
  });

  it("pi settings.json merge preserves foreign keys", () => {
    const p = paths();
    mkdirSync(p.piAgentDir, { recursive: true });
    const existing = JSON.stringify({ theme: "dark", enabledModels: ["other/*"] }, null, 2);
    writeFileSync(join(p.piAgentDir, "settings.json"), `${existing}\n`, "utf-8");
    DEPLOY({ harnesses: { pi: { model: "m", baseUrl: "http://b", apiKey: "k" } } }, p);
    const settings = JSON.parse(readText(join(p.piAgentDir, "settings.json")));
    expect(settings.theme).toBe("dark");
    // enabledModels ist ADDIV: der vorhandene Operator-Eintrag bleibt und der
    // Writer-Provider kommt dazu. Vorher wurde die Liste überschrieben — das
    // schloss hand-gepflegte Provider (z. B. "ollama") aus dem pi-Picker aus,
    // obwohl models.json sie weiterhin enthielt.
    expect(settings.enabledModels).toEqual(["other/*", "binding_b/*"]);
  });

  it("pi files: idempotent", () => {
    const p = paths();
    DEPLOY({ harnesses: { pi: { model: "m", baseUrl: "http://b", apiKey: "k" } } }, p);
    const firstModels = readText(join(p.piAgentDir, "models.json"));
    const firstSettings = readText(join(p.piAgentDir, "settings.json"));
    const report = DEPLOY({ harnesses: { pi: { model: "m", baseUrl: "http://b", apiKey: "k" } } }, p);
    expect(readText(join(p.piAgentDir, "models.json"))).toBe(firstModels);
    expect(readText(join(p.piAgentDir, "settings.json"))).toBe(firstSettings);
    expect(report.results.find((r) => r.harnessId === "pi")?.files.every((f) => f.action === "unchanged")).toBe(true);
  });

  it("pi without baseUrl → skipped with warning, no files written", () => {
    const p = paths();
    const report = DEPLOY({ harnesses: { pi: { model: "m", apiKey: "k" } } }, p);
    expect(report.results.find((r) => r.harnessId === "pi")?.warnings.join(" ")).toContain("baseUrl");
    expect(existsSync(p.piAgentDir)).toBe(false);
  });

  it("pi absent → no .pi directory created", () => {
    const p = paths();
    DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    expect(existsSync(p.piAgentDir)).toBe(false);
  });

  it("pi: contextWindow from model catalog lands in models.json", () => {
    const p = paths();
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: { baseUrl: "http://localhost:11434", models: [{ id: "m", contextWindow: 32000 }] },
          },
        },
      },
      [],
    );
    DEPLOY({ harnesses: { pi: { model: "m", baseUrl: "http://localhost:11434" } } }, p, catalog);
    const models = JSON.parse(readText(join(p.piAgentDir, "models.json")));
    // Variante A: der Gateway-Provider-Key ("ollama") wird geerbt, weil die
    // baseUrl eindeutig im Gateway-Katalog steht. Vorher stand hier der
    // URL-abgeleitete Key "binding_localhost_11434", der bei jedem
    // IP-/Port-Wechsel bricht.
    expect(models.providers.ollama.models[0].contextWindow).toBe(32000);
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

  it("absent harness leaves sibling harnesses deployed — cursor/kilocode NEVER touched", () => {
    const p = paths();
    const report = DEPLOY(
      { harnesses: { codex: OLLAMA, cursor: { model: "x" }, kilocode: { model: "x" } } },
      p,
    );
    const none = report.results.filter((r) => r.mechanism === "none");
    expect(none.map((r) => r.harnessId)).toEqual(["cursor", "kilocode"]);
    expect(none.flatMap((r) => r.files)).toEqual([]);
    // Nur codex-Artefakte existieren — keine cursor/kilocode Files.
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
  it("strips trailing slashes + /v1 + PROTOCOL, lowercases host, preserves path", () => {
    expect(normalizeBaseUrlForMatch("http://localhost:11434")).toBe("localhost:11434");
    expect(normalizeBaseUrlForMatch("http://localhost:11434/")).toBe("localhost:11434");
    expect(normalizeBaseUrlForMatch("http://localhost:11434/v1")).toBe("localhost:11434");
    expect(normalizeBaseUrlForMatch("http://localhost:11434/v1/")).toBe("localhost:11434");
    expect(normalizeBaseUrlForMatch("HTTP://LOCALHOST:11434")).toBe("localhost:11434");
    expect(normalizeBaseUrlForMatch("http://h:1/v1/x")).toBe("h:1/v1/x");
    // Domain-4-Audit r3: http↔https müssen matchen — der Katalog schreibt
    // ggf. https://, die Entry http:// → gleicher host:port-Key.
    expect(normalizeBaseUrlForMatch("https://localhost:11434")).toBe(
      normalizeBaseUrlForMatch("http://localhost:11434"),
    );
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
    // Variante A: zwei Provider auf derselben baseUrl → der Provider-Key wird
    // NICHT geerbt (kein Raten) und der Operator wird gewarnt.
    expect(catalog.providerKeyByBaseUrl.has(key)).toBe(false);
    expect(warnings).toEqual([
      "model catalog (b:1234): 2 providers share this baseUrl (a, b) — provider key not inherited, URL-derived fallback used",
    ]);
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

  it("invalid models field → warning + fallback (entry stays alive, fail-soft); N1: NO duplicate fallback warning on non-array", () => {
    const r = resolveEntryModels(
      { model: "gemma4", baseUrl: "http://localhost:11434", models: "junk" as unknown as string[] },
      CATALOG,
    );
    expect(r.warnings.join(" ")).toContain("must be array of non-empty strings");
    expect(r.source).toBe("matched");
    expect(r.models[0]).toBe("gemma4");
    // N1 (r2-Audit, negativ): die "resolved to nothing"-Fallback-Warning darf
    // bei einem NICHT-Array NICHT zusätzlich kommen (kein Doppel-Satz).
    expect(r.warnings.join(" ")).not.toContain("resolved to nothing");
  });

  it("N1 (r2): non-empty array of ALL-invalid ids → BOTH warnings (fallback message justified here)", () => {
    const r = resolveEntryModels(
      { model: "gemma4", baseUrl: "http://localhost:11434", models: ["", "   "] },
      CATALOG,
    );
    expect(r.warnings.join(" ")).toContain("invalid ids dropped");
    expect(r.warnings.join(" ")).toContain("resolved to nothing");
    expect(r.source).toBe("matched");
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
    expect(kimi).toMatchObject({
      slug: "kimi-k2.7-code:cloud",
      display_name: "kimi-k2.7-code:cloud",
      description: "Ollama model",
      supported_reasoning_levels: [],
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      support_verbosity: false,
      default_reasoning_summary: "auto",
      web_search_tool_type: "text",
      truncation_policy: { mode: "tokens", limit: 10000 },
      supports_parallel_tool_calls: true,
      supports_search_tool: true,
      experimental_supported_tools: [],
      input_modalities: ["text"],
      context_window: 262144,
      max_context_window: 262144,
      effective_context_window_percent: 95,
      include_apps_usage_instructions: true,
      include_plugin_usage_instructions: true,
      include_skills_usage_instructions: true,
    });
    expect(typeof kimi.base_instructions).toBe("string");
    expect((kimi.base_instructions as string).length).toBeGreaterThan(15000);
    expect((kimi.base_instructions as string)).toContain("kimi-k2.7-code:cloud");
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
      "created",
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


describe("codex model metadata catalog (γ.2)", () => {
  it("modelPolicy factors compute context_window and auto_compact_token_limit from nominal", () => {
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              modelPolicy: { contextWindowFactor: 0.85, autoCompactFactor: 0.6 },
              models: [{ id: "llama3", contextWindow: 1000000 }],
            },
          },
        },
      },
      [],
    );
    const built = buildCodexModelCatalogJson(["llama3"], catalog.metaById);
    const model = JSON.parse(built!.content).models[0];
    expect(model.context_window).toBe(850000);
    expect(model.max_context_window).toBe(1000000);
    expect(model.auto_compact_token_limit).toBe(600000);
  });

  it("without factors context_window stays nominal and no auto_compact_token_limit", () => {
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [{ id: "llama3", contextWindow: 1000000 }],
            },
          },
        },
      },
      [],
    );
    const built = buildCodexModelCatalogJson(["llama3"], catalog.metaById);
    const model = JSON.parse(built!.content).models[0];
    expect(model.context_window).toBe(1000000);
    expect(model.max_context_window).toBe(1000000);
    expect(model.auto_compact_token_limit).toBeUndefined();
  });

  it("providerKind openai disables factors even when configured", () => {
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              modelPolicy: { contextWindowFactor: 0.85, autoCompactFactor: 0.6, providerKind: "openai" },
              models: [{ id: "gpt-5", contextWindow: 1000000 }],
            },
          },
        },
      },
      [],
    );
    const built = buildCodexModelCatalogJson(["gpt-5"], catalog.metaById);
    const model = JSON.parse(built!.content).models[0];
    expect(model.context_window).toBe(1000000);
    expect(model.max_context_window).toBe(1000000);
    expect(model.auto_compact_token_limit).toBeUndefined();
  });

  it("model-level factors override provider-level factors", () => {
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              modelPolicy: { contextWindowFactor: 0.85, autoCompactFactor: 0.6 },
              models: [{ id: "llama3", contextWindow: 1000000, contextWindowFactor: 0.9, autoCompactFactor: 0.5 }],
            },
          },
        },
      },
      [],
    );
    const built = buildCodexModelCatalogJson(["llama3"], catalog.metaById);
    const model = JSON.parse(built!.content).models[0];
    expect(model.context_window).toBe(900000);
    expect(model.max_context_window).toBe(1000000);
    expect(model.auto_compact_token_limit).toBe(500000);
  });

  it("baseInstructions default loads fixture template with model substitution", () => {
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [{ id: "llama3", contextWindow: 128000 }],
            },
          },
        },
      },
      [],
    );
    const warnings: string[] = [];
    const built = buildCodexModelCatalogJson(["llama3"], catalog.metaById, warnings);
    const model = JSON.parse(built!.content).models[0];
    expect(model.base_instructions).toContain("llama3");
    expect(model.base_instructions.length).toBeGreaterThan(15000);
    expect(warnings).toHaveLength(0);
  });

  it("fixture carries the Apache-2.0 attribution notice (section 4 compliance)", () => {
    const raw = readFileSync(
      new URL("./fixtures/codex-base-instructions.txt", import.meta.url),
      "utf-8",
    );
    expect(raw.startsWith("<!--")).toBe(true);
    expect(raw).toContain("ATTRIBUTION-END");
    expect(raw).toContain("Apache License");
    expect(raw).toContain("openai/codex");
  });

  it("attribution header is stripped from the prompt handed to codex", () => {
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [{ id: "llama3", contextWindow: 128000 }],
            },
          },
        },
      },
      [],
    );
    const warnings: string[] = [];
    const built = buildCodexModelCatalogJson(["llama3"], catalog.metaById, warnings);
    const model = JSON.parse(built!.content).models[0];
    expect(model.base_instructions.startsWith("You are Codex")).toBe(true);
    expect(model.base_instructions).not.toContain("ATTRIBUTION-END");
    expect(model.base_instructions).not.toContain("Apache License");
    expect(model.base_instructions).not.toContain("<!--");
    expect(model.base_instructions).toContain("llama3");
  });

  it("baseInstructions fixture loads template with model substitution", () => {
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [{ id: "llama3", contextWindow: 128000, baseInstructions: "fixture" }],
            },
          },
        },
      },
      [],
    );
    const warnings: string[] = [];
    const built = buildCodexModelCatalogJson(["llama3"], catalog.metaById, warnings);
    const model = JSON.parse(built!.content).models[0];
    expect(model.base_instructions).toContain("llama3");
    expect(warnings).toHaveLength(0);
  });

  it("baseInstructions explicit string is used verbatim", () => {
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [{ id: "llama3", contextWindow: 128000, baseInstructions: "operator override" }],
            },
          },
        },
      },
      [],
    );
    const warnings: string[] = [];
    const built = buildCodexModelCatalogJson(["llama3"], catalog.metaById, warnings);
    const model = JSON.parse(built!.content).models[0];
    expect(model.base_instructions).toBe("operator override");
    expect(warnings).toHaveLength(0);
  });

  it("baseInstructions none results in empty string", () => {
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [{ id: "llama3", contextWindow: 128000, baseInstructions: "none" }],
            },
          },
        },
      },
      [],
    );
    const warnings: string[] = [];
    const built = buildCodexModelCatalogJson(["llama3"], catalog.metaById, warnings);
    const model = JSON.parse(built!.content).models[0];
    expect(model.base_instructions).toBe("");
    expect(warnings).toHaveLength(0);
  });

  it("thinkingLevels and defaultReasoningLevel map to supported_reasoning_levels", () => {
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [
                { id: "llama3", contextWindow: 128000, thinkingLevels: ["low", "high"], defaultReasoningLevel: "high" },
              ],
            },
          },
        },
      },
      [],
    );
    const built = buildCodexModelCatalogJson(["llama3"], catalog.metaById);
    const model = JSON.parse(built!.content).models[0];
    expect(model.supported_reasoning_levels).toEqual([
      { effort: "low", description: "Faster, less capable reasoning" },
      { effort: "high", description: "Deeper reasoning for harder problems" },
    ]);
    expect(model.default_reasoning_level).toBe("high");
  });

  it("config.toml includes model_post_turn_compact_threshold_percent before first table", () => {
    const toml = buildCodexConfigToml({ model: "m", baseUrl: "http://localhost:11434" }, undefined, 70);
    const lines = toml.split("\n");
    const compactIdx = lines.findIndex((l) => l.startsWith("model_post_turn_compact_threshold_percent"));
    const firstTableIdx = lines.findIndex((l) => /^\s*\[/.test(l));
    expect(compactIdx).toBeGreaterThan(-1);
    expect(firstTableIdx).toBeGreaterThan(compactIdx);
  });

  it("inputModalities, priority, description, supportsParallelToolCalls, supportsSearchTool, includeUsageInstructions from meta", () => {
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [
                {
                  id: "llama3",
                  contextWindow: 128000,
                  inputModalities: ["text", "image"],
                  priority: -5,
                  description: "Ollama model",
                  supportsParallelToolCalls: true,
                  supportsSearchTool: true,
                  includeUsageInstructions: true,
                },
              ],
            },
          },
        },
      },
      [],
    );
    const built = buildCodexModelCatalogJson(["llama3"], catalog.metaById);
    const model = JSON.parse(built!.content).models[0];
    expect(model.input_modalities).toEqual(["text", "image"]);
    expect(model.priority).toBe(-5);
    expect(model.description).toBe("Ollama model");
    expect(model.supports_parallel_tool_calls).toBe(true);
    expect(model.supports_search_tool).toBe(true);
    expect(model.include_apps_usage_instructions).toBe(true);
    expect(model.include_plugin_usage_instructions).toBe(true);
    expect(model.include_skills_usage_instructions).toBe(true);
  });

  it("generated ModelInfo matches expected shape", () => {
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              modelPolicy: { contextWindowFactor: 0.85, autoCompactFactor: 0.6 },
              models: [
                {
                  id: "kimi-k2.7-code:cloud",
                  contextWindow: 1048576,
                  maxContextWindow: 1048576,
                  thinkingLevels: ["low", "high", "max"],
                  defaultReasoningLevel: "high",
                  inputModalities: ["text", "image"],
                  priority: -28,
                  description: "Ollama model",
                  supportsParallelToolCalls: true,
                  supportsSearchTool: true,
                  includeUsageInstructions: true,
                  baseInstructions: "fixture",
                },
              ],
            },
          },
        },
      },
      [],
    );
    const built = buildCodexModelCatalogJson(["kimi-k2.7-code:cloud"], catalog.metaById);
    const model = JSON.parse(built!.content).models[0];
    expect(model).toMatchObject({
      slug: "kimi-k2.7-code:cloud",
      display_name: "kimi-k2.7-code:cloud",
      description: "Ollama model",
      supported_reasoning_levels: [
        { effort: "low", description: "Faster, less capable reasoning" },
        { effort: "high", description: "Deeper reasoning for harder problems" },
        { effort: "max", description: "Maximum reasoning depth" },
      ],
      default_reasoning_level: "high",
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: -28,
      support_verbosity: false,
      default_reasoning_summary: "auto",
      web_search_tool_type: "text",
      truncation_policy: { mode: "tokens", limit: 10000 },
      supports_parallel_tool_calls: true,
      supports_search_tool: true,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
      context_window: 891290,
      max_context_window: 1048576,
      auto_compact_token_limit: 629146,
      effective_context_window_percent: 95,
      include_apps_usage_instructions: true,
      include_plugin_usage_instructions: true,
      include_skills_usage_instructions: true,
    });
    expect(model.base_instructions).toContain("kimi-k2.7-code:cloud");
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
  it("STATE /config/.openclaw → opencodeGlobalDir aus Prozess-HOME aufgelöst", () => {
    const p = resolveHarnessWriterPaths({
      OPENCLAW_STATE_DIR: "/config/.openclaw",
      HOME: "/home/testuser",
    });
    expect(p).toEqual({
      acpxDir: "/config/.openclaw/acpx",
      codexSourceHome: "/config/.codex",
      opencodeGlobalDir: "/home/testuser/.config/opencode",
      claudeSourceHome: "/config/.claude",
      piAgentDir: "/config/.pi/agent",
    });
  });

  it("honours XDG_CONFIG_HOME for opencodeGlobalDir", () => {
    const p = resolveHarnessWriterPaths({
      OPENCLAW_STATE_DIR: "/config/.openclaw",
      HOME: "/home/testuser",
      XDG_CONFIG_HOME: "/xdg/config",
    });
    expect(p?.opencodeGlobalDir).toBe("/xdg/config/opencode");
  });

  it("two different HOME values yield two different, correct opencodeGlobalDir paths", () => {
    const a = resolveHarnessWriterPaths({ OPENCLAW_STATE_DIR: "/config/.openclaw", HOME: "/home/alice" });
    const b = resolveHarnessWriterPaths({ OPENCLAW_STATE_DIR: "/config/.openclaw", HOME: "/home/bob" });
    expect(a?.opencodeGlobalDir).toBe("/home/alice/.config/opencode");
    expect(b?.opencodeGlobalDir).toBe("/home/bob/.config/opencode");
    expect(a?.opencodeGlobalDir).not.toBe(b?.opencodeGlobalDir);
  });

  it("unresolvable env → null (honest degrade)", () => {
    expect(resolveHarnessWriterPaths({})).toBe(null);
  });
});

// γ.2 Amendment-2 Regressionstests (BUG-1..4)
function countTopLevelKey(toml: string, key: string): number {
  let inTable = false;
  let count = 0;
  for (const raw of toml.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*\[/.test(line)) inTable = true;
    if (!inTable && new RegExp(`^\\s*${key}\\s*=`).test(line)) count++;
  }
  return count;
}

describe("γ.2 Amendment-2 BUG-1..4", () => {
  it("BUG-1: foreign file WITH existing provider table is left intact (no silent key pollution)", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    const foreign = 'model = "gpt-5"\n[model_providers.foo]\nbase_url = "http://x"\n';
    writeFileSync(tomlPath, foreign, "utf-8");
    const report = DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    expect(readText(tomlPath)).toBe(foreign);
    expect(
      report.results[0].files.some(
        (f) => f.path === tomlPath && f.action === "note (customized, left intact)",
      ),
    ).toBe(true);
  });

  it("BUG-1: augment foreign file with only top-level keys inserts compaction key before first managed table", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    writeFileSync(tomlPath, 'model = "gpt-5"\nlog_level = "info"\n', "utf-8");
    DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    const after = readText(tomlPath);
    expect(countTopLevelKey(after, "model_post_turn_compact_threshold_percent")).toBe(1);
    expect(after).toContain("model_post_turn_compact_threshold_percent = 70");
    expect(after.indexOf("model_post_turn_compact_threshold_percent")).toBeLessThan(
      after.indexOf("[model_providers."),
    );
  });

  it("BUG-1: augment foreign file WITHOUT table still inserts top-level key", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    writeFileSync(tomlPath, 'model = "gpt-5"\n', "utf-8");
    DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    const after = readText(tomlPath);
    expect(countTopLevelKey(after, "model_post_turn_compact_threshold_percent")).toBe(1);
  });

  it("BUG-1: signature file with stale compaction value is replaced", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    const stale = buildCodexConfigToml({ ...OLLAMA, model: "m" }, undefined, 60);
    writeFileSync(tomlPath, stale, "utf-8");
    DEPLOY({ harnesses: { codex: { ...OLLAMA, model: "m" } } }, p);
    const after = readText(tomlPath);
    expect(countTopLevelKey(after, "model_post_turn_compact_threshold_percent")).toBe(1);
    expect(after).toContain("model_post_turn_compact_threshold_percent = 70");
  });

  it("BUG-1: augment foreign file that already has compaction key is not duplicated", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    writeFileSync(
      tomlPath,
      'model = "gpt-5"\nmodel_post_turn_compact_threshold_percent = 50\n',
      "utf-8",
    );
    DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    const after = readText(tomlPath);
    expect(countTopLevelKey(after, "model_post_turn_compact_threshold_percent")).toBe(1);
    expect(after).toContain("model_post_turn_compact_threshold_percent = 50");
  });

  it("BUG-1: second deploy on augmented file is byte-identical", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    writeFileSync(tomlPath, 'model = "gpt-5"\n', "utf-8");
    DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    const first = readText(tomlPath);
    DEPLOY({ harnesses: { codex: OLLAMA } }, p);
    expect(readText(tomlPath)).toBe(first);
  });

  it("BUG-2: baseInstructions fixture loads real Codex template with model substitution", () => {
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [{ id: "llama3", contextWindow: 128000 }],
            },
          },
        },
      },
      [],
    );
    const warnings: string[] = [];
    const built = buildCodexModelCatalogJson(["llama3"], catalog.metaById, warnings);
    const model = JSON.parse(built!.content).models[0];
    expect(model.base_instructions).toContain("llama3");
    expect((model.base_instructions as string).length).toBeGreaterThan(15000);
    expect(warnings).toHaveLength(0);
  });

  it("BUG-3: default_reasoning_level is omitted when defaultReasoningLevel is not explicit", () => {
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [{ id: "llama3", contextWindow: 128000, thinkingLevels: ["low", "high"] }],
            },
          },
        },
      },
      [],
    );
    const built = buildCodexModelCatalogJson(["llama3"], catalog.metaById);
    const model = JSON.parse(built!.content).models[0];
    expect(model.supported_reasoning_levels).toHaveLength(2);
    expect(model.default_reasoning_level).toBeUndefined();
  });

  it("BUG-3: warning when entry.thinking is not in supported levels", () => {
    const p = paths();
    const tomlPath = join(p.codexSourceHome, "config.toml");
    mkdirSync(join(root, "config", ".codex"), { recursive: true });
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [
                {
                  id: "kimi-k2.7-code:cloud",
                  contextWindow: 128000,
                  thinkingLevels: ["low", "high"],
                },
              ],
            },
          },
        },
      },
      [],
    );
    const report = deployHarnessConfigs(
      {
        harnesses: {
          codex: { ...OLLAMA, model: "kimi-k2.7-code:cloud", thinking: "unknown" },
        },
      },
      p,
      SILENT,
      catalog,
    );
    expect(
      report.results[0].warnings.some((w) =>
        w.includes('model_reasoning_effort "unknown" is not in supported reasoning levels'),
      ),
    ).toBe(true);
  });

  it("BUG-4: gpt-oss id with providerKind ollama applies compaction factors", () => {
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              modelPolicy: { providerKind: "ollama", contextWindowFactor: 0.85, autoCompactFactor: 0.6 },
              models: [{ id: "gpt-oss:120b-cloud", contextWindow: 1048576 }],
            },
          },
        },
      },
      [],
    );
    const built = buildCodexModelCatalogJson(["gpt-oss:120b-cloud"], catalog.metaById);
    const model = JSON.parse(built!.content).models[0];
    expect(model.context_window).toBe(Math.round(1048576 * 0.85));
    expect(model.auto_compact_token_limit).toBe(Math.round(1048576 * 0.6));
  });

  it("BUG-4: providerKind openai disables factors even for gpt-prefixed id", () => {
    const catalog = buildModelCatalog(
      {
        models: {
          providers: {
            openai: {
              baseUrl: "http://localhost:11434",
              modelPolicy: { providerKind: "openai", contextWindowFactor: 0.85, autoCompactFactor: 0.6 },
              models: [{ id: "gpt-oss:120b-cloud", contextWindow: 1048576 }],
            },
          },
        },
      },
      [],
    );
    const built = buildCodexModelCatalogJson(["gpt-oss:120b-cloud"], catalog.metaById);
    const model = JSON.parse(built!.content).models[0];
    expect(model.context_window).toBe(1048576);
    expect(model.auto_compact_token_limit).toBeUndefined();
  });
});
