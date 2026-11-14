/**
 * Schritt 4 (Weg A') Tests: HCW-eigener Codex-ACP-Wrapper.
 *
 * Die echte Live-Wirkung (Adapter-Start) wird vom Coordinator verifiziert;
 * hier testen wir die Wrapper-Logik als reine Funktion und die Command-Setzung.
 */

import {
  dirname,
  join,
  resolve,
} from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCodexHcwAuthJson,
  buildCodexHcwConfigToml,
  buildCodexHcwWrapperScript,
  deployCodexHcwWrapper,
  resolveCodexHcwAuthPath,
  resolveCodexHcwCatalogPath,
  resolveCodexHcwConfigPath,
  resolveCodexHcwWrapperPath,
  setAcpxCodexCommand,
} from "./codex-hcw-wrapper.js";
import { buildModelCatalog, type HarnessConfigEntry, type HarnessWriterPaths } from "./harness-config-writer.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hcw-wrapper-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function paths(): HarnessWriterPaths {
  return {
    acpxDir: join(root, "state", "acpx"),
    codexSourceHome: join(root, "config", ".codex"),
    opencodeGlobalDir: join(root, "config", "opencode"),
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

function buildSampleModelCatalog() {
  return buildModelCatalog(
    {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            models: [{ id: "kimi-k2.7-code:cloud", contextWindow: 128000 }],
          },
        },
      },
    },
    [],
  );
}

async function runGeneratedWrapper(
  entry: HarnessConfigEntry,
  p: HarnessWriterPaths,
  options: {
    modelCatalog?: ReturnType<typeof buildModelCatalog>;
    createCatalog?: boolean;
    createStableAdapter?: boolean;
    extraArgs?: string[];
  } = {},
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  wrapperPath: string;
  configPath: string;
  authPath: string;
  catalogPath: string;
}> {
  const wrapperPath = resolveCodexHcwWrapperPath(p);
  const configPath = resolveCodexHcwConfigPath(p);
  const authPath = resolveCodexHcwAuthPath(p);
  const catalogPath = resolveCodexHcwCatalogPath(p);

  const script = buildCodexHcwWrapperScript(entry, p, options.modelCatalog);
  mkdirSync(p.acpxDir, { recursive: true, mode: 0o700 });
  writeFileSync(wrapperPath, script, { mode: 0o700 });

  if (options.createCatalog) {
    mkdirSync(dirname(catalogPath), { recursive: true, mode: 0o700 });
    writeFileSync(catalogPath, JSON.stringify({ models: [] }), { mode: 0o600 });
  }

  if (options.createStableAdapter) {
    const stableAdapterPath = resolve(p.acpxDir, "../extensions/acpx/node_modules/@agentclientprotocol/codex-acp/dist/index.js");
    mkdirSync(dirname(stableAdapterPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      stableAdapterPath,
      `const fs = require("node:fs");\nconst marker = process.argv.find(a => a.startsWith("--marker="));\nif (marker) fs.writeFileSync(marker.slice(9), "spawned", "utf-8");\n`,
      { mode: 0o700 },
    );
  }

  return new Promise((res, rej) => {
    const child = spawn(
      process.execPath,
      [wrapperPath, ...(options.extraArgs ?? [])],
      { env: { ...process.env, CODEX_API_KEY: "test-key" } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    child.on("error", rej);
    child.on("close", (exitCode) => {
      res({ exitCode, stdout, stderr, wrapperPath, configPath, authPath, catalogPath });
    });
  });
}

describe("buildCodexHcwAuthJson", () => {
  it("emits the exact acpx-wrapper auth.json shape", () => {
    expect(JSON.parse(buildCodexHcwAuthJson("sk-123"))).toEqual({
      OPENAI_API_KEY: "sk-123",
      tokens: null,
      last_refresh: null,
    });
  });
});

describe("buildCodexHcwConfigToml", () => {
  it("places model_catalog_json before the first table and uses an absolute path", () => {
    const catalogPath = join(root, "state", "acpx", "codex-home-hcw", "model-catalog.json");
    const toml = buildCodexHcwConfigToml(OLLAMA, catalogPath, 70);
    expect(toml).toContain(`model_catalog_json = ${JSON.stringify(catalogPath)}`);
    const lines = toml.split("\n");
    const catalogLineIndex = lines.findIndex((l) => l.startsWith("model_catalog_json ="));
    const firstTableIndex = lines.findIndex((l) => /^\[/.test(l));
    expect(catalogLineIndex).toBeGreaterThanOrEqual(0);
    expect(firstTableIndex).toBeGreaterThan(0);
    expect(catalogLineIndex).toBeLessThan(firstTableIndex);
  });

  it("omits model_catalog_json when no catalog path is given", () => {
    const toml = buildCodexHcwConfigToml(OLLAMA);
    expect(toml).not.toMatch(/^model_catalog_json =/m);
  });

  it("keeps the same ordering as the isolated source config.toml", () => {
    const catalogPath = join(root, "catalog.json");
    const toml = buildCodexHcwConfigToml({ ...OLLAMA, thinking: "medium" }, catalogPath, 70);
    const expectedOrder = ["# harness-config-writer", "model =", "model_provider =", "model_reasoning_effort =", "model_catalog_json =", "sandbox_mode ="];
    for (const prefix of expectedOrder) {
      expect(toml).toContain(prefix);
    }
  });
});

describe("buildCodexHcwWrapperScript", () => {
  it("embeds the auth.json content and config.toml content", () => {
    const script = buildCodexHcwWrapperScript(OLLAMA, paths());
    expect(script).toContain("const AUTH_JSON =");
    expect(script).toContain("const CONFIG_TOML =");
    expect(script).toContain("OPENAI_API_KEY");
    expect(script).toContain("kimi-k2.7-code:cloud");
  });

  it("does not embed catalog content; keeps the absolute catalog path reference when a catalog is built", () => {
    const p = paths();
    const catalog = buildSampleModelCatalog();
    const scriptNoCatalog = buildCodexHcwWrapperScript(OLLAMA, p);
    expect(scriptNoCatalog).toContain("const CATALOG_PATH =");
    expect(scriptNoCatalog).not.toMatch(/const CATALOG_JSON\s*=/);

    const script = buildCodexHcwWrapperScript({ ...OLLAMA, models: ["kimi-k2.7-code:cloud"] }, p, catalog);
    const expectedCatalogPath = resolveCodexHcwCatalogPath(p);
    expect(script).toContain(JSON.stringify(expectedCatalogPath));
    expect(script).not.toMatch(/const CATALOG_JSON\s*=/);
  });

  it("is small (< 20 KB) and contains no model catalog base-prompt content", () => {
    const p = paths();
    const catalog = buildSampleModelCatalog();
    const script = buildCodexHcwWrapperScript({ ...OLLAMA, models: ["kimi-k2.7-code:cloud"] }, p, catalog);
    expect(script.length).toBeLessThan(20 * 1024);
    expect(script).not.toContain("base_instructions");
    expect(script).not.toContain("context_window");
  });

  it("passes received args through to the adapter unchanged", () => {
    const script = buildCodexHcwWrapperScript(OLLAMA, paths());
    expect(script).toContain("const passedArgs = process.argv.slice(2);");
    expect(script).toContain("const args = [...adapterArgs, ...passedArgs];");
  });

  it("sets CODEX_HOME to the HCW home for the adapter child", () => {
    const script = buildCodexHcwWrapperScript(OLLAMA, paths());
    expect(script).toContain("const env = { ...process.env, CODEX_HOME };");
  });

  it("checks the stable relative adapter path first at runtime, then capture, then npm exec, then npx", () => {
    const script = buildCodexHcwWrapperScript(OLLAMA, paths());
    expect(script).toContain("const stable = resolve(wrapperDir, STABLE_ADAPTER_REL_PATH);");
    expect(script).toContain("if (existsSync(stable))");
    expect(script).toContain("const capture =");
    expect(script).toContain('"exec", "--yes", "--package", "@agentclientprotocol/codex-acp@2.1.1"');
    expect(script).toContain('"--yes", "--package", "@agentclientprotocol/codex-acp@2.1.1", "--", "codex-acp"');
    expect(script).toMatch(/STABLE_ADAPTER_REL_PATH = "\.\.\/[^"]+"/);
  });
});

describe("deployCodexHcwWrapper", () => {
  it("writes wrapper, config.toml, and auth.json into the HCW home", () => {
    const p = paths();
    const result = deployCodexHcwWrapper(OLLAMA, p, SILENT);

    expect(existsSync(result.wrapperPath)).toBe(true);
    expect(existsSync(result.configPath)).toBe(true);
    expect(existsSync(result.authPath)).toBe(true);

    expect(readText(result.wrapperPath)).toContain("#!/usr/bin/env node");

    const auth = JSON.parse(readText(result.authPath));
    expect(auth).toEqual({ OPENAI_API_KEY: "ollama", tokens: null, last_refresh: null });
    expect(statSync(result.authPath).mode & 0o777).toBe(0o600);

    const toml = readText(result.configPath);
    expect(toml).toContain('model = "kimi-k2.7-code:cloud"');
    expect(toml.startsWith("# harness-config-writer (generated)")).toBe(true);
  });

  it("writes the model catalog when models with contextWindow are available", () => {
    const p = paths();
    const catalog = buildSampleModelCatalog();
    const result = deployCodexHcwWrapper({ ...OLLAMA, models: ["kimi-k2.7-code:cloud"] }, p, SILENT, catalog);
    expect(result.catalogPath).toBeDefined();
    expect(existsSync(result.catalogPath!)).toBe(true);
    const toml = readText(result.configPath);
    expect(toml).toContain(`model_catalog_json = ${JSON.stringify(result.catalogPath)}`);
  });

  it("is idempotent: second deploy leaves files unchanged", () => {
    const p = paths();
    deployCodexHcwWrapper(OLLAMA, p, SILENT);
    const firstWrapper = readText(resolveCodexHcwWrapperPath(p));
    const firstToml = readText(resolveCodexHcwConfigPath(p));
    deployCodexHcwWrapper(OLLAMA, p, SILENT);
    expect(readText(resolveCodexHcwWrapperPath(p))).toBe(firstWrapper);
    expect(readText(resolveCodexHcwConfigPath(p))).toBe(firstToml);
  });
});

describe("generated wrapper runtime behaviour", () => {
  it("keeps model_catalog_json when the catalog file exists", async () => {
    const p = paths();
    const catalog = buildSampleModelCatalog();
    const { exitCode, stderr, configPath } = await runGeneratedWrapper(
      { ...OLLAMA, models: ["kimi-k2.7-code:cloud"] },
      p,
      { modelCatalog: catalog, createCatalog: true, createStableAdapter: true },
    );
    expect(exitCode).toBe(0);
    const toml = readText(configPath);
    expect(stderr).not.toContain("missing; omitting model_catalog_json reference");
  });

  it("omits model_catalog_json when the catalog file is missing at runtime", async () => {
    const p = paths();
    const catalog = buildSampleModelCatalog();
    const { exitCode, configPath } = await runGeneratedWrapper(
      { ...OLLAMA, models: ["kimi-k2.7-code:cloud"] },
      p,
      { modelCatalog: catalog, createStableAdapter: true },
    );
    expect(exitCode).toBe(0);
    const toml = readText(configPath);
    expect(toml).not.toContain("model_catalog_json");
  });

  it("contains runtime stderr warning logic for a dangling catalog reference", () => {
    const p = paths();
    const catalog = buildSampleModelCatalog();
    const script = buildCodexHcwWrapperScript(
      { ...OLLAMA, models: ["kimi-k2.7-code:cloud"] },
      p,
      catalog,
    );
    expect(script).toContain("missing; omitting model_catalog_json reference");
    expect(script).toContain('process.stderr.write("[hcw-codex-wrapper] " + CATALOG_PATH + " missing');
    expect(script).toContain("if (hasReference && !existsSync(CATALOG_PATH))");
  });

  it("spawns the adapter via the stable relative adapter path", async () => {
    const p = paths();
    const markerPath = join(p.acpxDir, "adapter-marker.txt");
    const { exitCode } = await runGeneratedWrapper(OLLAMA, p, {
      createStableAdapter: true,
      extraArgs: [`--marker=${markerPath}`],
    });
    expect(exitCode).toBe(0);
    expect(existsSync(markerPath)).toBe(true);
    expect(readText(markerPath)).toBe("spawned");
  });
});

describe("setAcpxCodexCommand", () => {
  it("does not write when the runtime snapshot already points to the wrapper (production case)", async () => {
    // Produktionsfall 2026-11-14: `api.config` führt den acpx-Eintrag eines
    // ANDEREN Plugins nicht mit → der alte Vergleich auf api.config lieferte
    // undefined → Write bei JEDEM Plugin-Load → Config-Hot-Reload → Neustart
    // → Restart-Loop. Autoritative Quelle ist der Runtime-Snapshot.
    const p = paths();
    const wrapperPath = resolveCodexHcwWrapperPath(p);
    let calls = 0;
    const api = {
      config: {}, // Plugin-Sicht: enthält den acpx-Eintrag NICHT
      runtime: {
        config: {
          current: () => ({
            plugins: {
              entries: {
                acpx: { config: { agents: { codex: { command: wrapperPath } } } },
              },
            },
          }),
          mutateConfigFile: async () => {
            calls++;
            return { result: { changed: true } };
          },
        },
      },
    } as unknown as Parameters<typeof setAcpxCodexCommand>[0];

    const { changed } = await setAcpxCodexCommand(api, wrapperPath);

    expect(calls).toBe(0);
    expect(changed).toBe(false);
  });

  it("writes once when the acpx entry is missing entirely", async () => {
    const p = paths();
    const wrapperPath = resolveCodexHcwWrapperPath(p);
    const draft: Record<string, unknown> = {};
    let calls = 0;
    const api = {
      config: {},
      runtime: {
        config: {
          current: () => ({ plugins: { entries: {} } }),
          mutateConfigFile: async (
            { mutate }: { mutate: (d: Record<string, unknown>) => unknown },
          ) => {
            calls++;
            const result = mutate(draft);
            return { result };
          },
        },
      },
    } as unknown as Parameters<typeof setAcpxCodexCommand>[0];

    const { changed } = await setAcpxCodexCommand(api, wrapperPath);

    expect(calls).toBe(1);
    expect(changed).toBe(true);
    const plugins = draft.plugins as Record<string, unknown>;
    const entries = plugins.entries as Record<string, unknown>;
    const acpx = entries.acpx as Record<string, unknown>;
    const acpxConfig = acpx.config as Record<string, unknown>;
    const agents = acpxConfig.agents as Record<string, unknown>;
    const codex = agents.codex as Record<string, unknown>;
    expect(codex.command).toBe(wrapperPath);
  });

  it("corrects a differing command from the runtime snapshot", async () => {
    const p = paths();
    const wrapperPath = resolveCodexHcwWrapperPath(p);
    const draft: Record<string, unknown> = {};
    let calls = 0;
    const api = {
      config: {},
      runtime: {
        config: {
          current: () => ({
            plugins: {
              entries: {
                acpx: { config: { agents: { codex: { command: "/wrong/path" } } } },
              },
            },
          }),
          mutateConfigFile: async (
            { mutate }: { mutate: (d: Record<string, unknown>) => unknown },
          ) => {
            calls++;
            const result = mutate(draft);
            return { result };
          },
        },
      },
    } as unknown as Parameters<typeof setAcpxCodexCommand>[0];

    const { changed } = await setAcpxCodexCommand(api, wrapperPath);

    expect(calls).toBe(1);
    expect(changed).toBe(true);
    const plugins = draft.plugins as Record<string, unknown>;
    const entries = plugins.entries as Record<string, unknown>;
    const acpx = entries.acpx as Record<string, unknown>;
    const acpxConfig = acpx.config as Record<string, unknown>;
    const agents = acpxConfig.agents as Record<string, unknown>;
    const codex = agents.codex as Record<string, unknown>;
    expect(codex.command).toBe(wrapperPath);
  });

  it("sets command with a single auto-mode write when command differs", async () => {
    const p = paths();
    const wrapperPath = resolveCodexHcwWrapperPath(p);
    const draft: Record<string, unknown> = {};
    let calls = 0;
    let capturedAfterWrite: { mode: string } | undefined;
    const api = {
      config: {},
      runtime: {
        config: {
          mutateConfigFile: async (
            { mutate, afterWrite }: { mutate: (d: Record<string, unknown>) => unknown; afterWrite?: { mode: string } },
          ) => {
            calls++;
            capturedAfterWrite = afterWrite;
            mutate(draft);
            return { result: { changed: true } };
          },
        },
      },
    } as unknown as Parameters<typeof setAcpxCodexCommand>[0];

    const { changed } = await setAcpxCodexCommand(api, wrapperPath);

    expect(calls).toBe(1);
    expect(capturedAfterWrite?.mode).toBe("auto");
    expect(changed).toBe(true);
    const plugins = draft.plugins as Record<string, unknown> | undefined;
    const entries = plugins?.entries as Record<string, unknown> | undefined;
    const acpx = entries?.acpx as Record<string, unknown> | undefined;
    expect(acpx).toBeDefined();
    const acpxConfig = acpx!.config as Record<string, unknown>;
    const agents = acpxConfig.agents as Record<string, unknown>;
    const codex = agents.codex as Record<string, unknown>;
    expect(codex.command).toBe(wrapperPath);
  });

  it("does not call mutateConfigFile when command already points to the wrapper", async () => {
    const p = paths();
    const wrapperPath = resolveCodexHcwWrapperPath(p);
    let calls = 0;
    const api = {
      config: {
        plugins: {
          entries: {
            acpx: {
              config: {
                agents: {
                  codex: { command: wrapperPath },
                },
              },
            },
          },
        },
      },
      runtime: {
        config: {
          mutateConfigFile: async () => {
            calls++;
            return { result: { changed: false } };
          },
        },
      },
    } as unknown as Parameters<typeof setAcpxCodexCommand>[0];

    const warnings: string[] = [];
    const { changed } = await setAcpxCodexCommand(api, wrapperPath, {
      warn: (m: string) => warnings.push(m),
    });

    expect(calls).toBe(0);
    expect(changed).toBe(false);
    expect(warnings).toEqual([]);
  });
});

describe("codex-hcw wrapper adapter-path mirror", () => {
  // ESM: the mirrored adapter path is spawned as a module by the wrapper.
  const FAKE_ADAPTER = `import fs from "node:fs";
const marker = process.argv.find(a => a.startsWith("--marker="));
if (marker) fs.writeFileSync(marker.slice(9), import.meta.url, "utf-8");
`;

  function writeMirror(acpxDir: string, payload: unknown): void {
    mkdirSync(acpxDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(acpxDir, "adapter-paths.json"), JSON.stringify(payload));
  }

  it("prefers the mirrored adapter path over the relative fallback", async () => {
    const p = paths();
    const marker = join(root, "marker-mirror.txt");
    const mirrored = join(root, "mirror", "adapter.mjs");
    mkdirSync(dirname(mirrored), { recursive: true });
    writeFileSync(mirrored, FAKE_ADAPTER, { mode: 0o700 });
    writeMirror(p.acpxDir, { version: 1, adapterPaths: [mirrored], adapterGlobs: [] });

    const res = await runGeneratedWrapper(OLLAMA, p, { extraArgs: [`--marker=${marker}`] });
    expect(res.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(res.stderr).toContain("adapter source=mirror");
    expect(res.stderr).toContain(mirrored);
  });

  it("resolves a mirrored adapter glob (plugin capture layout)", async () => {
    const p = paths();
    const marker = join(root, "marker-glob.txt");
    const captured = join(root, "captures", "cap-1", "adapter.mjs");
    mkdirSync(dirname(captured), { recursive: true });
    writeFileSync(captured, FAKE_ADAPTER, { mode: 0o700 });
    writeMirror(p.acpxDir, {
      version: 1,
      adapterPaths: [],
      adapterGlobs: [join(root, "captures", "*", "adapter.mjs")],
    });

    const res = await runGeneratedWrapper(OLLAMA, p, { extraArgs: [`--marker=${marker}`] });
    expect(res.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it("picks the newest capture when several plugin captures exist", async () => {
    const p = paths();
    const marker = join(root, "marker-newest.txt");
    const older = join(root, "captures", "cap-old", "adapter.mjs");
    const newer = join(root, "captures", "cap-new", "adapter.mjs");
    mkdirSync(dirname(older), { recursive: true });
    mkdirSync(dirname(newer), { recursive: true });
    writeFileSync(older, FAKE_ADAPTER, { mode: 0o700 });
    writeFileSync(newer, FAKE_ADAPTER, { mode: 0o700 });
    utimesSync(older, new Date(1000), new Date(1000));
    utimesSync(newer, new Date(9000), new Date(9000));
    writeMirror(p.acpxDir, {
      version: 1,
      adapterPaths: [],
      adapterGlobs: [join(root, "captures", "*", "adapter.mjs")],
    });

    const res = await runGeneratedWrapper(OLLAMA, p, { extraArgs: [`--marker=${marker}`] });
    expect(res.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf-8")).toContain("cap-new");
  });

  it("keeps the stable relative adapter when no mirror exists", async () => {
    const p = paths();
    const marker = join(root, "marker-stable.txt");

    const res = await runGeneratedWrapper(OLLAMA, p, {
      createStableAdapter: true,
      extraArgs: [`--marker=${marker}`],
    });
    expect(res.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(res.stderr).toContain("adapter source=stable");
  });

  it("embeds the mirror contract in the generated script", () => {
    const script = buildCodexHcwWrapperScript(OLLAMA, paths());
    expect(script).toContain("adapter-paths.json");
    expect(script).toContain("adapterPaths");
    expect(script).toContain("adapterGlobs");
    const mirrorCall = script.indexOf("resolveMirroredAdapterPath(wrapperDir)");
    const stableCall = script.indexOf("resolve(wrapperDir, STABLE_ADAPTER_REL_PATH)");
    expect(mirrorCall).toBeGreaterThan(0);
    expect(stableCall).toBeGreaterThan(0);
    expect(mirrorCall).toBeLessThan(stableCall);
  });
});
