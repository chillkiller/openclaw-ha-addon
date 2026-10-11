/**
 * Phase 2.22 (origin-workspace cwd, GaRoN Phase B): the node:sqlite-backed
 * implementation of agent-map's `OriginWorkspaceReader` seam.
 *
 * Data path (live-verified 2026-10-10; host's own stores, READ-ONLY):
 *   1. agent DB `<stateDir>/agents/<agentId>/agent/openclaw-agent.sqlite`
 *      (agent-database-path-discovery-B_nrhsNg.mjs:16): `session_nodes`
 *      row of the ORIGIN dashboard conversation → `project_id` +
 *      `entry_json` (`sessionRoot` = verbatim cwd, `projectId`);
 *   2. state DB `<stateDir>/state/openclaw.sqlite`: `projects`
 *      (id → repo_root) — only consulted when entry_json itself carries no
 *      sessionRoot.
 *
 * The plugin has NO official read surface for these stores (openKeyedStore is
 * plugin-scoped; the binding ref carries no projectId —
 * session-conversation-binding-ClcCbPHd.mjs:31-35). The host itself opens
 * these DBs with node:sqlite in WAL mode, so a concurrent read-only connection
 * is supported semantics; all reads are fail-soft (null) and connection
 * failures drop the cached handle (reopen on the next attempt — the TTL'd
 * miss memoization in agent-map retries on a later turn).
 *
 * Load contract: node:sqlite is resolved lazily and synchronously via
 * process.getBuiltinModule (no top-level await — the plugin module stays
 * loadable on hosts without the module; the reader then answers null and the
 * documented agent-default cwd ladder applies untouched).
 */

import {
  buildOriginWorkspaceDatabasePaths,
  parseOriginWorkspaceEntryJson,
  resolveOpenClawStateDir,
  trimOriginConversationKey,
  type OriginWorkspaceInfo,
} from "./agent-map.js";

type NodeSqliteDatabase = {
  prepare(sql: string): { get(...params: unknown[]): unknown };
  close(): void;
};

type NodeSqliteModule = {
  DatabaseSync?: new (
    path: string,
    options?: { open?: boolean; readOnly?: boolean },
  ) => NodeSqliteDatabase;
};

let cachedSqlite: NodeSqliteModule | null | undefined;

/** Sync, lazy node:sqlite resolution via process.getBuiltinModule (node ≥22.3;
 * the host runtime runs ≥26 — without it the reader degrades to null). */
function loadNodeSqlite(): NodeSqliteModule | null {
  if (cachedSqlite !== undefined) return cachedSqlite;
  try {
    const builtin = (process as unknown as { getBuiltinModule?: (id: string) => unknown })
      .getBuiltinModule?.("node:sqlite") as NodeSqliteModule | undefined;
    cachedSqlite = builtin ?? null;
  } catch {
    cachedSqlite = null;
  }
  return cachedSqlite;
}
/** DB handle caches keyed by absolute path; failures drop the entry (reopen next call). */
const readOnlyDbCache = new Map<string, NodeSqliteDatabase>();
let sqliteUnavailable = false;

function openReadOnlyDb(path: string): NodeSqliteDatabase | null {
  const cached = readOnlyDbCache.get(path);
  if (cached) return cached;
  if (sqliteUnavailable) return null;
  const sqlite = loadNodeSqlite();
  if (!sqlite?.DatabaseSync) {
    sqliteUnavailable = true;
    return null;
  }
  try {
    const db = new sqlite.DatabaseSync(path, { open: true, readOnly: true });
    readOnlyDbCache.set(path, db);
    return db;
  } catch {
    return null;
  }
}

function dropCachedDb(path: string): void {
  const db = readOnlyDbCache.get(path);
  readOnlyDbCache.delete(path);
  try {
    db?.close();
  } catch {
    /* already dead */
  }
}

/** Test seam: closes all cached read-only handles (next call reopens). */
export function closeOriginWorkspaceDbHandlesForTest(): void {
  for (const [path] of [...readOnlyDbCache]) dropCachedDb(path);
  sqliteUnavailable = false;
  cachedSqlite = undefined;
}

/**
 * The reader behind `setOriginWorkspaceReader` (index.ts wiring): reads ONE
 * origin conversation's workspace facts. Never throws; null on every
 * failure/miss — agent-map memoizes and falls back per the documented ladder.
 */
export function readOriginWorkspaceRow(agentId: string, conversationId: string): OriginWorkspaceInfo | null {
  const convId = typeof conversationId === "string" ? conversationId.trim() : "";
  const aid = typeof agentId === "string" ? agentId.trim() : "";
  if (!convId || !aid) return null;
  const stateDir = resolveOpenClawStateDir();
  if (!stateDir) return null;
  const paths = buildOriginWorkspaceDatabasePaths(stateDir, aid);
  if (!paths) return null;
  try {
    const db = openReadOnlyDb(paths.agentDb);
    if (!db) return null;
    const baseKey = trimOriginConversationKey(convId);
    const candidates = [...new Set([convId, ...(baseKey && baseKey !== convId ? [baseKey] : [])])];
    let projectId: string | undefined;
    let sessionRoot: string | undefined;
    for (const key of candidates) {
      let row: unknown = null;
      try {
        row = db.prepare("SELECT project_id, entry_json FROM session_nodes WHERE session_key = ?").get(key);
      } catch {
        dropCachedDb(paths.agentDb);
        return null;
      }
      if (!row || typeof row !== "object") continue;
      const record = row as { project_id?: unknown; entry_json?: unknown };
      const parsed = parseOriginWorkspaceEntryJson(record.entry_json);
      const columnProject =
        typeof record.project_id === "string" && record.project_id.trim() ? record.project_id.trim() : undefined;
      projectId = parsed?.projectId ?? columnProject ?? undefined;
      sessionRoot = parsed?.sessionRoot;
      break;
    }
    const info: OriginWorkspaceInfo = {
      ...(projectId ? { projectId } : {}),
      ...(sessionRoot ? { sessionRoot } : {})
    };
    if (sessionRoot || !projectId) return Object.keys(info).length > 0 ? info : null;
    // Fallback leg: project id → repo_root from the host state DB.
    const stateDb = openReadOnlyDb(paths.projectsDb);
    if (!stateDb) return Object.keys(info).length > 0 ? info : null;
    let repoRow: unknown = null;
    try {
      repoRow = stateDb.prepare("SELECT repo_root FROM projects WHERE id = ?").get(projectId);
    } catch {
      dropCachedDb(paths.projectsDb);
      return Object.keys(info).length > 0 ? info : null;
    }
    const repoRoot =
      typeof (repoRow as { repo_root?: unknown } | null)?.repo_root === "string"
        ? (repoRow as { repo_root: string }).repo_root.trim() || undefined
        : undefined;
    const full: OriginWorkspaceInfo = { ...info, ...(repoRoot ? { repoRoot } : {}) };
    return Object.keys(full).length > 0 ? full : null;
  } catch {
    return null;
  }
}

/**
 * Whether a state dir resolves from env (index.ts logs the degraded mode when
 * this returns false — the reader would answer null for every conversation).
 */
export function isOriginWorkspaceStateDirResolvable(): boolean {
  return resolveOpenClawStateDir() !== null;
}