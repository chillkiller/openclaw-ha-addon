/**
 * Entry-Level-Tests (Audit B2, 2026-10-11): das ENV-Gate an der
 * register-Surface — beide Option-ENVs je Kombination, Write/No-Write hart
 * gegen das Dateisystem bewiesen (Gateway-Boot-Ebene: Helper-Restore muss
 * Writer-Boots überleben können, wenn die Option OFF ist).
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

function makeApi(harnesses?: Record<string, unknown>): {
  api: { config: Record<string, unknown>; logger: Logger };
  logs: string[];
} {
  const logs: string[] = [];
  const logger: Logger = {
    debug: (m) => logs.push(`debug: ${m}`),
    info: (m) => logs.push(`info: ${m}`),
    warn: (m) => logs.push(`warn: ${m}`),
    error: (m) => logs.push(`error: ${m}`),
  };
  const config: Record<string, unknown> = {};
  if (harnesses !== undefined) {
    config.harnesses = harnesses;
  }
  return { api: { config, logger }, logs };
}

const CODEX_ENTRY = { model: "audit-m", baseUrl: "http://b:1234" };

function codexTomlPath(root: string): string {
  return join(root, ".codex", "config.toml");
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
    const { api } = makeApi({ codex: CODEX_ENTRY });
    registerHarnessConfigDeployment(api as never);
    const toml = codexTomlPath(root);
    expect(existsSync(toml)).toBe(true);
    expect(readFileSync(toml, "utf-8")).toContain("[model_providers.");
  });

  it("gate OFF (writer=false, binding=true) → operator veto wins, NO write", () => {
    boot({ HARNESS_CONFIG_WRITER_ENABLED: "false", ACP_DASHBOARD_BINDING_ENABLED: "true" });
    const { api, logs } = makeApi({ codex: CODEX_ENTRY });
    registerHarnessConfigDeployment(api as never);
    expect(existsSync(codexTomlPath(root))).toBe(false);
    expect(logs.join("\n")).toContain("inactive by env gate");
  });

  it("writer empty (run.sh unset) + binding=on → follows binding, write", () => {
    boot({ HARNESS_CONFIG_WRITER_ENABLED: "", ACP_DASHBOARD_BINDING_ENABLED: "true" });
    const { api } = makeApi({ codex: CODEX_ENTRY });
    registerHarnessConfigDeployment(api as never);
    expect(existsSync(codexTomlPath(root))).toBe(true);
  });

  it("writer empty + binding empty/unset → off, NO write despite harnesses config", () => {
    boot({ HARNESS_CONFIG_WRITER_ENABLED: "" });
    const { api, logs } = makeApi({ codex: CODEX_ENTRY });
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