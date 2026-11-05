/**
 * Schritt 4 (Weg A') Tests: HCW-eigener Codex-ACP-Wrapper.
 *
 * Die echte Live-Wirkung (Adapter-Start) wird vom Coordinator verifiziert;
 * hier testen wir die Wrapper-Logik als reine Funktion und die Command-Setzung.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("embeds the absolute catalog path only when a catalog is built", () => {
    const p = paths();
    const catalog = buildModelCatalog(
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
    const scriptNoCatalog = buildCodexHcwWrapperScript(OLLAMA, p);
    expect(scriptNoCatalog).toContain("const CATALOG_JSON = null");

    const script = buildCodexHcwWrapperScript({ ...OLLAMA, models: ["kimi-k2.7-code:cloud"] }, p, catalog);
    const expectedCatalogPath = resolveCodexHcwCatalogPath(p);
    expect(script).toContain(JSON.stringify(expectedCatalogPath));
    expect(script).toContain("const CATALOG_JSON =");
    expect(script).not.toContain("const CATALOG_JSON = null");
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

  it("tries the installed adapter bin first, then npm exec, then npx", () => {
    const script = buildCodexHcwWrapperScript(OLLAMA, paths());
    expect(script).toContain("node_modules/@agentclientprotocol/codex-acp/dist/index.js");
    expect(script).toContain('"exec", "--yes", "--package", "@agentclientprotocol/codex-acp@2.1.1"');
    expect(script).toContain('"--yes", "--package", "@agentclientprotocol/codex-acp@2.1.1", "--", "codex-acp"');
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
    const catalog = buildModelCatalog(
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

describe("setAcpxCodexCommand", () => {
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
