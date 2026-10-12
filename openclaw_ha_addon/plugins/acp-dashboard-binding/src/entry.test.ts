import { describe, expect, it, vi } from "vitest";

import { defineBundledChannelCompatibleEntry } from "./entry.js";

/**
 * Replicates the host's bundled-channel entry contract check — dist
 * bundled-CMChYPbG.mjs resolveBundledChannelModuleEntry (:129-141), the gate
 * whose live failure (WARN "missing bundled-channel-entry contract; skipping")
 * suppressed registerFull and killed all binding after the v0.7.13.18
 * bundled-root deploy. Kept in lock-step with the dist contract on purpose.
 */
function resolveBundledChannelModuleEntry(
  moduleExport: unknown,
  kind: "entry" | "setupEntry",
): Record<string, unknown> | null {
  const resolved =
    moduleExport && typeof moduleExport === "object" && "default" in moduleExport
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (!resolved || typeof resolved !== "object") return null;
  const record = resolved as Record<string, unknown>;
  const setup = kind === "setupEntry";
  if (record.kind !== (setup ? "bundled-channel-setup-entry" : "bundled-channel-entry")) return null;
  const stringFields = ["id", "name", "description"];
  const functionFields = setup ? ["loadSetupPlugin"] : ["register", "loadChannelPlugin"];
  if (
    stringFields.some((field) => typeof record[field] !== "string") ||
    functionFields.some((field) => typeof record[field] !== "function")
  )
    return null;
  return record;
}

const plugin = { id: "acp-dashboard-binding", fakeChannelPlugin: true };

describe("bundled-channel entry contract (Forensik 2026-10-12)", () => {
  it("the legacy defineChannelPluginEntry shape FAILS the contract (regression witness)", () => {
    // The v0.7.13.18/.19 deployed record: no `kind`, no `loadChannelPlugin`.
    const legacyRecord = {
      id: "acp-dashboard-binding",
      name: "ACP Dashboard Binding",
      description: "…",
      register: () => {},
      channelPlugin: plugin,
    };
    expect(resolveBundledChannelModuleEntry({ default: legacyRecord }, "entry")).toBeNull();
  });

  it("the shim's default-export shape passes the contract", () => {
    const registerFull = vi.fn();
    const entry = defineBundledChannelCompatibleEntry({
      id: "acp-dashboard-binding",
      name: "ACP Dashboard Binding",
      description: "…",
      plugin,
      registerFull,
    });
    const resolved = resolveBundledChannelModuleEntry({ default: entry }, "entry");
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe("acp-dashboard-binding");
    expect(resolved?.loadChannelPlugin).toBeTypeOf("function");
    expect((entry.loadChannelPlugin() as typeof plugin) === plugin).toBe(true);
  });

  it("register(full mode) → registerChannel then registerFull", () => {
    const registerFull = vi.fn();
    const registerChannel = vi.fn();
    const entry = defineBundledChannelCompatibleEntry({
      id: "acp-dashboard-binding",
      name: "n",
      description: "d",
      plugin,
      registerFull,
    });
    entry.register({ registrationMode: "full", registerChannel });
    expect(registerChannel).toHaveBeenCalledTimes(1);
    expect(registerChannel).toHaveBeenCalledWith({ plugin });
    expect(registerFull).toHaveBeenCalledTimes(1);
    expect(registerFull).toHaveBeenCalledWith(expect.anything());
  });

  it("register(tool-discovery) → registerFull, NO registerChannel", () => {
    const registerFull = vi.fn();
    const registerChannel = vi.fn();
    defineBundledChannelCompatibleEntry({
      id: "x",
      name: "n",
      description: "d",
      plugin,
      registerFull,
    }).register({ registrationMode: "tool-discovery", registerChannel });
    expect(registerChannel).not.toHaveBeenCalled();
    expect(registerFull).toHaveBeenCalledTimes(1);
  });

  it("register(cli-metadata / discovery / setup-only modes stay silent or channel-only)", () => {
    const registerFull = vi.fn();
    const registerChannel = vi.fn();
    const entry = defineBundledChannelCompatibleEntry({
      id: "x",
      name: "n",
      description: "d",
      plugin,
      registerFull,
    });
    entry.register({ registrationMode: "cli-metadata", registerChannel });
    entry.register({ registrationMode: "discovery", registerChannel });
    entry.register({ registrationMode: "setup-runtime", registerChannel });
    expect(registerFull).not.toHaveBeenCalled();
    expect(registerChannel).toHaveBeenCalledTimes(2); // discovery + setup-runtime branch
  });
});