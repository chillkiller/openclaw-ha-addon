/**
 * Phase 2.22 integration proof: the node:sqlite reader
 * (src/origin-workspace.ts) against REAL sqlite files that mirror the
 * verifizierten Host-Layout (session_nodes + projects), end-to-end through
 * agent-map's seam (setOriginWorkspaceReader → resolveOriginWorkspaceCwd →
 * resolveHarnessTargetOrigin).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// node:sqlite via builtin module (vitest's builtin list does not know the
// module; the plugin reader resolves it the same way).
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...params: unknown[]): unknown };
    close(): void;
  };
};

import {
  buildAcpBindingSessionKey,
  queryOriginWorkspace,
  resolveHarnessAgentSpec,
  resolveHarnessTargetOrigin,
  resetDashboardBindingProvisionerForTest,
  resetOriginWorkspaceReaderForTest,
  setDashboardBindingProvisioner,
  setOriginWorkspaceReader,
} from "./agent-map.js";
import { closeOriginWorkspaceDbHandlesForTest, readOriginWorkspaceRow } from "./origin-workspace.js";

const HARNESS_CFG = {
  agents: {
    entries: {
      claude: { runtime: { type: "acp", acp: { backend: "acpx", cwd: "/share/temp/acp-rebuild" } } }
    }
  }
} as const;

let stateDir: string;

beforeEach(() => {
  // Layout wie im Host: <stateDir>/agents/<id>/agent/openclaw-agent.sqlite
  //                       <stateDir>/state/openclaw.sqlite
  stateDir = mkdtempSync(join(tmpdir(), "acpdb-"));
  mkdirSync(join(stateDir, "agents", "claude", "agent"), { recursive: true });
  mkdirSync(join(stateDir, "state"), { recursive: true });
  const agentDb = new DatabaseSync(join(stateDir, "agents", "claude", "agent", "openclaw-agent.sqlite"));
  agentDb.exec("CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, project_id TEXT, entry_json TEXT)");
  // Der GaRoN-Befund (18:46): das Dashboard-Gespräch des Projektfensters.
  agentDb.prepare(
    "INSERT INTO session_nodes (session_key, project_id, entry_json) VALUES (?, ?, ?)"
  ).run(
    "agent:claude:dashboard:27eddc7c-7e52-44d7-93fd-014413870526",
    "openclaw-ha-addon",
    JSON.stringify({ sessionId: "07251efa", sessionRoot: "/share/projekte/github/openclaw-ha-addon", projectId: "openclaw-ha-addon" })
  );
  // Threaded-Segment-Variante: Basis-Node vorhanden, Ref trägt Suffix.
  agentDb.prepare(
    "INSERT INTO session_nodes (session_key, project_id, entry_json) VALUES (?, ?, ?)"
  ).run(
    "agent:claude:dashboard:aaadbeef-0000-1111-2222-333344445555",
    "other-project",
    JSON.stringify({ sessionRoot: "/share/projekte/other/repo" })
  );
  agentDb.prepare(
    "INSERT INTO session_nodes (session_key, project_id, entry_json) VALUES (?, ?, ?)"
  ).run("agent:claude:main", null, null);
  agentDb.close();

  const stateDb = new DatabaseSync(join(stateDir, "state", "openclaw.sqlite"));
  stateDb.exec(
    "CREATE TABLE projects (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, repo_root TEXT NOT NULL, source TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)"
  );
  // Beweis der Fallback-Reihenfolge: repo_root anders als der sessionRoot.
  stateDb.prepare(
    "INSERT INTO projects (id, display_name, repo_root, source, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("openclaw-ha-addon", "openclaw-ha-addon", "/share/projekte/github/openclaw-ha-addon-RepoRoot", "test", 0, 0);
  stateDb.close();

  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetOriginWorkspaceReaderForTest();
  resetDashboardBindingProvisionerForTest();
  closeOriginWorkspaceDbHandlesForTest();
  rmSync(stateDir, { recursive: true, force: true });
});

const CONV = { channel: "webchat", accountId: "default", conversationId: "agent:claude:dashboard:27eddc7c-7e52-44d7-93fd-014413870526" };
const THREADED_CONV = { channel: "webchat", accountId: "default", conversationId: "agent:claude:dashboard:aaadbeef-0000-1111-2222-333344445555:thread" };

describe("Phase 2.22 origin-workspace reader (echtes sqlite)", () => {
  it("liest sessionRoot + project_id aus der Agent-DB (read-only, fail-soft)", () => {
    expect(readOriginWorkspaceRow("claude", CONV.conversationId)).toEqual({
      projectId: "openclaw-ha-addon",
      sessionRoot: "/share/projekte/github/openclaw-ha-addon"
    });
    // Thread-Suffix fällt auf den Basis-Key zurück.
    expect(readOriginWorkspaceRow("claude", THREADED_CONV.conversationId)).toEqual({
      projectId: "other-project",
      sessionRoot: "/share/projekte/other/repo"
    });
    // Kein Node für main/pseudo-Keys → null (agent-default cwd bleibt).
    expect(readOriginWorkspaceRow("claude", "agent:claude:main")).toBeNull();
    expect(readOriginWorkspaceRow("claude", "harness:claude")).toBeNull();
    // Unbekannter Agent → DB fehlt → null.
    expect(readOriginWorkspaceRow("ghost-agent", CONV.conversationId)).toBeNull();
  });

  it("projektt-ID-Fallback: ohne sessionRoot liefert projects.repo_root", () => {
    const agentDb = new DatabaseSync(join(stateDir, "agents", "claude", "agent", "openclaw-agent.sqlite"));
    agentDb.prepare(
      "INSERT INTO session_nodes (session_key, project_id, entry_json) VALUES (?, ?, ?)"
    ).run(
      "agent:claude:dashboard:bbb1c0de-0000-0000-0000-000000000000",
      "openclaw-ha-addon",
      JSON.stringify({ sessionId: "x" }) // kein sessionRoot
    );
    agentDb.close();
    const info = readOriginWorkspaceRow("claude", "agent:claude:dashboard:bbb1c0de-0000-0000-0000-000000000000");
    expect(info).toEqual({
      projectId: "openclaw-ha-addon",
      repoRoot: "/share/projekte/github/openclaw-ha-addon-RepoRoot"
    });
  });

  it("End-to-End: Resolve/Ensure herleitet cwd aus dem ORIGIN-Kontext und klont den Origin-Key", () => {
    setOriginWorkspaceReader(readOriginWorkspaceRow);
    const kicks: Array<{ cwd?: string; targetSessionKey: string; conversationId?: string }> = [];
    setDashboardBindingProvisioner(async (params) => {
      kicks.push({ cwd: params.cwd ?? params.spec.cwd, targetSessionKey: params.targetSessionKey, conversationId: params.conversation.conversationId });
    });
    const spec = resolveHarnessAgentSpec(HARNESS_CFG, "claude")!;
    const resolved = resolveHarnessTargetOrigin(HARNESS_CFG, spec, CONV);
    // Der ORIGIN-cwd (/share/projekte/github/openclaw-ha-addon) ersetzt den
    // Beweislauf-cwd (/share/temp/acp-rebuild) — exakt der GaRoN-Defekt.
    expect(resolved.cwd).toBe("/share/projekte/github/openclaw-ha-addon");
    expect(resolved.cwdSource).toBe("origin-session-root");
    // Klon-Modus (Phase 2.24): der Key ist der Klon der ORIGIN-Konversation;
    // der cwd liegt NUR im Ensure-Spec, nicht in der Key-Identität.
    expect(resolved.targetKey).toBe(
      buildAcpBindingSessionKey({ channel: "webchat", accountId: "default", conversationId: CONV.conversationId, agentId: "claude" })
    );
    expect(kicks[0].cwd).toBe("/share/projekte/github/openclaw-ha-addon");
    expect(kicks[0].cwd).not.toBe("/share/temp/acp-rebuild");
    expect(kicks[0].conversationId).toBe(CONV.conversationId);

    // Stabilität: zweiter Consult identisch, kein zweiter Ensure.
    expect(resolveHarnessTargetOrigin(HARNESS_CFG, spec, CONV)).toEqual(resolved);
    expect(kicks).toHaveLength(1);

    // Memoized seam: queryOriginWorkspace hit, kein erneuter DB-Read nötig.
    expect(queryOriginWorkspace("claude", CONV.conversationId)?.sessionRoot)
      .toBe("/share/projekte/github/openclaw-ha-addon");
  });
});