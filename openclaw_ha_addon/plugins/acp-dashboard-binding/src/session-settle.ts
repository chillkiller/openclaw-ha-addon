/**
 * Claim-path conversation settlement + subagent-provenance stamping
 * (BRIDGE §19 — v0.7.13.22-Paket a/c + V39, 2026-10-12).
 *
 * Two live-proven defects (v0.7.13.21 evidence) share one mechanism gap: a
 * claimed turn's session-node entries are never terminal-settled.
 *
 *  - ORIGIN conversation node (`agent:<id>:dashboard:<uuid>`): a claimed
 *    dispatch completes via `finishPluginBindingDispatch` (dispatch-from-config
 *    :3340, recordProcessed "completed/plugin-bound-handled") but NO component
 *    writes the run-terminal entry the host writes for direct runs (status
 *    done + endedAt + runtimeMs). Live-DB proof: origin node 99d8daf5… stayed
 *    `status:"running"` with `lifecycleRunId/restartRecoveryDeliveryRunId =
 *    <claim runId>` AFTER its claim turn (9b4a2cf5…) completed cleanly. On the
 *    next gateway boot the host's startup orphan marking
 *    (markOrphanedMainSessionStore) then stamps the node for a
 *    restart-recovery DELIVERY claimed turns can never satisfy — the
 *    "Denken-Spinner" state. The mark is the consequence; the missing
 *    settlement is the root.
 *  - TARGET (harness-clone) node: the §17 terminal-write race still loses on
 *    the DIRECT dispatch path (reason=acp_dispatch; 4 live events through
 *    20:24 — runs 427c5075/e2a4d134/12fc5c04/76f1d871, all "terminal session
 *    persistence failed session=agent:claude:acp:binding:webchat:default:
 *    4fbefeb9…"). The post-settle yield (v0.7.13.19) only guards the claim
 *    path. When that host write loses, the clone node sticks `running` too.
 *
 * Both are fixed the SAME way here: after a TERMINAL claim wait — and at boot,
 * for entries a restart left stuck — we write the host's own settlement shape
 * (mirror of `clearPendingFinalDeliveryAfterSuccess`,
 * dist/dispatch-from-config.pending-final-DSL0QiVQ.mjs:29-58):
 *   `status:"done"` + `endedAt` (+ `runtimeMs` + `abortedLastRun:false`), and
 *   clear the restartRecoveryDelivery* claim fields ONLY when the marked
 *   delivery run is OUR claim run — that delivery is the
 *   `deliverBindingPayload(reply, "terminal")` our return triggers right
 *   after. A debt for a DIFFERENT run stays (host recovery may still owe it).
 *
 * SDK scope note: plugin-sdk `patchSessionEntry` strips the PRIVATE entry keys
 * (PRIVATE_SESSION_ENTRY_KEYS, session-accessor.sqlite-transcript-write:
 * activeWriterRunId/lastRunId/lifecycleRunId/mainRestartRecovery) and
 * preserveGenerationPrivateFields restores them for same-session patches — a
 * plugin CANNOT clear lifecycleRunId/activeWriterRunId/lastRunId via the SDK.
 * That residual stale lifecycleRunId is acceptable: the host's next-turn
 * session prepare clears it (agent-turn-service shouldClearTerminalState), and
 * the ControlUI spinner/side-list derives from `status`/run projection
 * (server-plugins: `run: "active"` gates on row.status === "running"), so the
 * settled `status:"done"` is what kills the spinner.
 *
 * V39 (Klon-Unsichtbarkeit): the derive record's target key
 * (`agent:<id>:acp:binding:webchat:default:<hash>`) classifies as `isSubagent`
 * exactly when the entry carries `spawnedBy` and NO `category` (leg 2,
 * session-list-target-C2rmz7hN.mjs:39). The host's clone metadata seed
 * (acpManager.initializeSession → writeSessionMeta) leaves spawnedBy NULL for
 * our ensured clones — that is why the clone shows up in ControlUI's "ANDERE"
 * sidebar. We stamp `spawnedBy = <origin session key>` (idempotent patch after
 * each claim dispatch + in the boot sweep) so ControlUI lists (they ALL send
 * `excludeSubagents: true` — ui-bundle-verified 2026-10-12) hide the clone:
 * the requested "versteckte Sub-Session". Deliberately NOT the
 * `subagent:`-key-prefix leg (would break `isAcpSessionKey` dispatch routing)
 * and NO category stamp (would defeat leg 2). Stamp side-effect audited
 * acceptable: queued-cancellation requester resolution
 * (manager-4esWnBgv.mjs) then resolves the origin key — semantically correct,
 * the origin conversation IS the requester.
 *
 * All patches are no-ops unless they are provably ours to make:
 *  - settle touches only `status === "running"` entries,
 *  - boot-sweep touches only entries with `updatedAt` before the sweep ran
 *    (no in-process run can predate gateway_start) AND keys this plugin owns
 *    (binding rows + their targets),
 *  - stamps only change a spawnedBy that differs from the expected value.
 */

import { parseAgentIdFromConversationId } from "./agent-map.js";
import type { HarnessReplyClaimLogger } from "./reply-claim.js";

/**
 * Fields the host marks a session with when its run was interrupted by a
 * gateway restart (restartRecoveryDelivery* claim fields). We clear the whole
 * claim set together — same fields `clearPendingFinalDeliveryAfterSuccess`
 * releases via buildRestartRecoveryClaimCleanupPatch + the
 * restartRecoveryBeforeAgentReply* trio it clears unconditionally.
 */
const RESTART_RECOVERY_CLAIM_FIELDS = [
  "restartRecoveryDeliveryRunId",
  "restartRecoveryDeliverySourceRunId",
  "restartRecoveryDeliveryRequestFingerprint",
  "restartRecoveryDeliveryContext",
  "restartRecoverySourceIngress",
  "restartRecoveryBeforeAgentReplyState",
  "restartRecoveryForceSafeTools",
] as const;

/** Structural public session-entry view (plugin-sdk projection). */
export type SettleSessionEntryLike = {
  status?: unknown;
  startedAt?: unknown;
  updatedAt?: unknown;
  spawnedBy?: unknown;
  lifecycleRunId?: unknown;
  restartRecoveryDeliveryRunId?: unknown;
  [key: string]: unknown;
};

export type SessionEntryPatch = Record<string, unknown>;

export type SettleSessionEntryRef = {
  sessionKey: string;
  /** Parsed from the key when omitted (agent:<id> grammar). */
  agentId?: string | null;
};

/**
 * Minimal `openclaw/plugin-sdk/session-store-runtime` surface the settle
 * helpers need. Injectable for tests (the live module is passed in from
 * index.ts, so vitest stubs never fight the host loader contract).
 */
export type SessionStoreApi = {
  getSessionEntry: (params: SettleSessionEntryRef) => SettleSessionEntryLike | undefined;
  patchSessionEntry: (params: {
    sessionKey: string;
    agentId?: string | null;
    update: (entry: SettleSessionEntryLike) => SessionEntryPatch | null;
    requireWriteSuccess?: boolean;
  }) => Promise<SettleSessionEntryLike | null>;
  /**
   * When set, patches run with requireWriteSuccess so a lost write surfaces
   * as a rejected promise instead of failing silently (null-entry case).
   */
  requireWriteSuccess?: boolean;
};

/** The settlement shape the host writes for a completed run (mirrored). */
export function buildClaimSettlePatch(
  entry: SettleSessionEntryLike | undefined,
  claimRunId: string,
  stoppedAt: number,
): SessionEntryPatch | null {
  if (!entry || entry.status !== "running") return null;
  const startedAt =
    typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt) && entry.startedAt > 0
      ? entry.startedAt
      : undefined;
  const patch: SessionEntryPatch = {
    status: "done",
    endedAt: stoppedAt,
    ...(startedAt !== undefined ? { runtimeMs: Math.max(0, stoppedAt - startedAt) } : {}),
    abortedLastRun: false,
  };
  const recoveryRunId =
    typeof entry.restartRecoveryDeliveryRunId === "string" ? entry.restartRecoveryDeliveryRunId.trim() : "";
  if (recoveryRunId && recoveryRunId === claimRunId) {
    for (const field of RESTART_RECOVERY_CLAIM_FIELDS) patch[field] = undefined;
  }
  return patch;
}

async function settleOne(params: {
  sessionStore: SessionStoreApi;
  ref: SettleSessionEntryRef;
  claimRunId: string;
  stoppedAt: number;
  label: string;
  logger?: HarnessReplyClaimLogger;
}): Promise<boolean> {
  try {
    const entry = params.sessionStore.getSessionEntry(params.ref);
    if (!entry || entry.status !== "running") return false;
    const patch = buildClaimSettlePatch(entry, params.claimRunId, params.stoppedAt);
    if (!patch) return false;
    await params.sessionStore.patchSessionEntry({
      ...params.ref,
      update: (current) => buildClaimSettlePatch(current, params.claimRunId, params.stoppedAt),
      ...(params.sessionStore.requireWriteSuccess ? { requireWriteSuccess: true } : {}),
    });
    params.logger?.debug?.(`[acp-dashboard-binding] settled stuck ${params.label} session ${params.ref.sessionKey} (run ${params.claimRunId})`);
    return true;
  } catch (error) {
    params.logger?.warn?.(
      `[acp-dashboard-binding] settle of ${params.label} session ${params.ref.sessionKey} failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/**
 * Settles the two session-node entries a claimed turn leaves behind. Origin:
 * always (the host ends the origin dispatch with our reply, but never writes
 * its run-terminal entry). Target: only after a TERMINAL wait — for
 * timeout/pending the harness run keeps going and MUST stay `running`.
 * Idempotent/no-op when the host already settled the entry itself (§17 yield
 * made its terminal commit win) — buildClaimSettlePatch returns null then.
 */
export async function settleClaimedTurnSessions(params: {
  sessionStore: SessionStoreApi;
  originSessionKey: string;
  targetSessionKey: string;
  claimRunId: string;
  agentId?: string | null;
  /** "terminal" → settle origin + target; "nonterminal" → origin only. */
  waitStatus: "terminal" | "nonterminal";
  logger?: HarnessReplyClaimLogger;
}): Promise<void> {
  const stoppedAt = Date.now();
  const agentId = params.agentId ?? parseAgentIdFromConversationId(params.originSessionKey);
  await settleOne({
    sessionStore: params.sessionStore,
    ref: { sessionKey: params.originSessionKey, agentId },
    claimRunId: params.claimRunId,
    stoppedAt,
    label: "claim-origin",
    logger: params.logger,
  });
  if (params.waitStatus === "terminal") {
    await settleOne({
      sessionStore: params.sessionStore,
      ref: { sessionKey: params.targetSessionKey, agentId },
      claimRunId: params.claimRunId,
      stoppedAt,
      label: "claim-target",
      logger: params.logger,
    });
  }
}

/**
 * V39: stamps `spawnedBy = <origin session key>` on a harness clone entry so
 * `readSessionListSelectionFacts` leg 2 classifies it as a subagent and
 * ControlUI lists (excludeSubagents: true) hide it. Idempotent; keeps an
 * already-correct stamp untouched and never touches entries that carry a
 * category (leg 2 requires none).
 */
export async function stampSubagentProvenance(params: {
  sessionStore: SessionStoreApi;
  targetSessionKey: string;
  originSessionKey: string;
  agentId?: string | null;
  logger?: HarnessReplyClaimLogger;
}): Promise<boolean> {
  try {
    const ref = {
      sessionKey: params.targetSessionKey,
      agentId: params.agentId ?? parseAgentIdFromConversationId(params.originSessionKey),
    };
    const entry = params.sessionStore.getSessionEntry(ref);
    if (!entry || entry.spawnedBy === params.originSessionKey) return false;
    if (entry.category != null) return false;
    if (typeof entry.spawnedBy === "string" && entry.spawnedBy.trim()) return false;
    await params.sessionStore.patchSessionEntry({
      ...ref,
      update: (current) =>
        current.spawnedBy === params.originSessionKey ||
        current.category != null ||
        (typeof current.spawnedBy === "string" && current.spawnedBy.trim())
          ? null
          : { spawnedBy: params.originSessionKey },
      ...(params.sessionStore.requireWriteSuccess ? { requireWriteSuccess: true } : {}),
    });
    params.logger?.debug?.(
      `[acp-dashboard-binding] stamped spawnedBy on ${params.targetSessionKey} → ${params.originSessionKey} (V39 clone hidden from ControlUI lists)`,
    );
    return true;
  } catch (error) {
    params.logger?.warn?.(
      `[acp-dashboard-binding] spawnedBy stamp of ${params.targetSessionKey} failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/**
 * §19c boot sweep: at gateway_start no in-process run can predate the process,
 * so owned entries still `running` with a PRE-SWEEP updatedAt are orphans the
 * host's main-session recovery does not cover (it restores sessions it can
 * recover; our claimed conversations + the direct-path §17 races it marks with
 * a restart-recovery delivery debt that claimed turns cannot satisfy — the
 * Denken-Spinner never clears on its own). We settle them with the same
 * host-parity patch, using the recovery run as the settle runId so the debt
 * (if it is the marked one) releases with its delivery evidence cleared.
 */
export async function sweepStuckHarnessSessions(params: {
  sessionStore: SessionStoreApi;
  /** Owned pairs: each plugin-bound origin conversation + its clone target. */
  targets: Array<SettleSessionEntryRef & { originSessionKey?: string }>;
  /** Boot time; entries updated after this mark are treated as live. */
  cutoffMs?: number;
  logger?: HarnessReplyClaimLogger;
}): Promise<{ settled: string[] }> {
  const stoppedAt = Date.now();
  const cutoff = params.cutoffMs ?? stoppedAt;
  const settled: string[] = [];
  for (const target of params.targets) {
    try {
      const entry = params.sessionStore.getSessionEntry(target);
      if (!entry || entry.status !== "running") continue;
      const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
      if (updatedAt > cutoff) {
        params.logger?.debug?.(
          `[acp-dashboard-binding] sweep: ${target.sessionKey} updated after boot — leaving it to its live run`,
        );
        continue;
      }
      // The run that stuck this entry predates this boot; settle against THAT
      // run so a marked delivery debt of the same run releases. A debt for any
      // other run stays (see buildClaimSettlePatch).
      const claimRunId =
        typeof entry.restartRecoveryDeliveryRunId === "string" && entry.restartRecoveryDeliveryRunId.trim()
          ? entry.restartRecoveryDeliveryRunId.trim()
          : typeof entry.lifecycleRunId === "string" && entry.lifecycleRunId.trim()
            ? entry.lifecycleRunId.trim()
            : "";
      const patched = await settleOne({
        sessionStore: params.sessionStore,
        ref: target,
        claimRunId,
        stoppedAt,
        label: "sweep",
        logger: params.logger,
      });
      if (patched) {
        settled.push(target.sessionKey);
        const originSessionKey = target.originSessionKey ?? "";
        if (originSessionKey && originSessionKey !== target.sessionKey) {
          // V39 sweep leg: keep clones stamped after boot too (the host's
          // metadata seed rewrites could have dropped the stamp mid-session).
          await stampSubagentProvenance({
            sessionStore: params.sessionStore,
            targetSessionKey: target.sessionKey,
            originSessionKey,
            agentId: target.agentId,
            logger: params.logger,
          });
        }
      }
    } catch (error) {
      params.logger?.warn?.(
        `[acp-dashboard-binding] sweep of ${target.sessionKey} failed — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { settled };
}
/**
 * §19c store-sweep variant: enumerates the agent store's own entries instead
 * of walking explicit binding rows (derived Turn-1 Synthesis persists NO row —
 * the adapter answers on the fly — so rows would miss exactly the sessions in
 * evidence). Scope is strictly our key grammar, per roster harness agent:
 *   - clone targets: rest `acp:binding:<channel>:<account>:<hash>`
 *   - dashboard-origin conversations: rest `dashboard:<uuid>`
 * Only entries still `running` with a pre-sweep updatedAt are settled.
 */
export type SweepSessionStoreApi = SessionStoreApi & {
  listSessionEntries: (params: {
    agentId: string;
    readOnly?: boolean;
  }) => Array<{ sessionKey: string; entry: SettleSessionEntryLike }>;
};

const CLONE_KEY_REST_RE = /^acp:binding:[^:]+:[^:]+:[0-9a-f]{8,}$/;
const DASHBOARD_KEY_REST_RE = /^dashboard:[^:]+$/;

export async function sweepOwnedStuckSessions(params: {
  sessionStore: SweepSessionStoreApi;
  agentIds: readonly string[];
  /** Boot reference; entries updated after this mark are treated as live. */
  cutoffMs?: number;
  logger?: HarnessReplyClaimLogger;
}): Promise<{ settled: string[] }> {
  const stoppedAt = Date.now();
  const cutoff = params.cutoffMs ?? stoppedAt;
  const settled: string[] = [];
  for (const agentId of params.agentIds) {
    let rows: Array<{ sessionKey: string; entry: SettleSessionEntryLike }>;
    try {
      rows = params.sessionStore.listSessionEntries({ agentId, readOnly: true });
    } catch (error) {
      params.logger?.warn?.(
        `[acp-dashboard-binding] sweep listing agent ${agentId} failed — ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    for (const { sessionKey, entry } of rows) {
      const rest = sessionKey
        .trim()
        .split(":")
        .slice(2)
        .join(":");
      const isOwned = CLONE_KEY_REST_RE.test(rest) || DASHBOARD_KEY_REST_RE.test(rest);
      if (!isOwned) continue;
      const status = typeof entry.status === "string" ? entry.status : "";
      if (status !== "running") continue;
      const updatedAt = typeof entry.updatedAt === "number" && entry.updatedAt > 0 ? entry.updatedAt : 0;
      if (updatedAt > cutoff) continue;
      const patched = await settleOne({
        sessionStore: params.sessionStore,
        ref: { sessionKey, agentId },
        claimRunId:
          typeof entry.restartRecoveryDeliveryRunId === "string" && entry.restartRecoveryDeliveryRunId.trim()
            ? entry.restartRecoveryDeliveryRunId.trim()
            : typeof entry.lifecycleRunId === "string" && entry.lifecycleRunId.trim()
              ? entry.lifecycleRunId.trim()
              : "",
        stoppedAt,
        label: "sweep",
        logger: params.logger,
      });
      if (patched) settled.push(sessionKey);
    }
  }
  return { settled };
}
