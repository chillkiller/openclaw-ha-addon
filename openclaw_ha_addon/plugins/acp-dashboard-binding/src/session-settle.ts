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
 * V39→γ (Klon-Unsichtbarkeit, re-audited live 2026-10-13): the spawnedBy
 * stamp ALONE does NOT hide the clone — the user's live challenge proved the
 * V39 assumption ("all ControlUI lists send excludeSubagents") WRONG for the
 * 2026.10.2 UI build: only the activity page, command palette and session
 * counts send `excludeSubagents:true` (asset grep: activity-page-D0Znqhfw.js,
 * command-palette-DQRbBHii.js, control-ui-boot-shared-CP6HFINY.js); the ACTIVE
 * chat chain (index.html → boot-chat-DWc-tgnY.js → boot-shared-5tr2Rgvy.js)
 * queries the rail WITHOUT the flag, has no client-side spawnedBy filter, and
 * the chat child view even uses `spawnedBy` as its JOIN key
 * (boot-shared: `{spawnedBy: parentKey, limit, includeGlobal:!1,…}`) — a
 * spawnedBy stamp can never hide anything there. The host-parity hiding
 * mechanism is the ARCHIVE filter instead: createSessionCandidateFilter drops
 * every entry with `archivedAt !== void 0` from all standard listings unless
 * the caller opts into `archived:"all"` (session-utils-list-C5iF7qnc.mjs:200 +
 * :208), and the chat child query sends no archived param, so the server-side
 * default (opts.archived !== "all") excludes archived rows there too.
 *
 * BUT an `archivedAt` stamp is DISPATCH-TOXIC for the clone: its session key
 * is deterministic per conversation (agent-map acpBindingHash =
 * sha256(channel:account:conversationId)), the `agent` gateway method the
 * claim dispatch rides REFUSES work on archived entries (lifecycle
 * resolveSessionWorkStartError: "Session … is archived. Restore it before
 * starting new work." — reached from the agent-turn service gates
 * agent-turn-service-Bypy4dbg.mjs:1676/:877/:1037/:3886), and the host
 * maintenance itself archives-and-restores on that contract
 * (store-maintenance-CGOlSbiV.mjs: `archiveReason` "age-retention" /
 * "stale-dashboard"). So the hide rides the host's own archive/restore
 * lifecycle — ARCHIVE-WHEN-IDLE: `stampCloneHidden` (marked with OUR
 * archiveReason) runs at claim-target SETTLE and in the boot sweep;
 * `unarchiveHiddenClone` clears only OUR marker right before dispatch, so the
 * work-start gate passes again and a foreign (host/user) archive is never
 * undone. The clone is therefore visible only while one of its turns is
 * actually running (useful feedback), and hidden whenever it is idle.
 *
 * γ AUTO-ARCHIVE GATE OFF BY DEFAULT (GaRoN directive 2026-10-14): clone
 * archives hid the REPLY transcript while the origin conversation carried no
 * mirrored text yet — the user could read neither. `cloneAutoArchive` now
 * defaults to `false` (getDashboardBindingCloneAutoArchive): every
 * buildCloneHiddenPatch is a no-op, no new archive stamps are written, and
 * clones stay readable (listings show them unless the stampedBy leg applies
 * — that leg is spawnedBy-only and never archives). Legacy archival returns
 * by setting the option `cloneAutoArchive: true`; OUR existing stamps keep
 * healing via the pre-dispatch un-archive. This also removes the γ-v2
 * re-archive race surface ("Terminal write owner changed before commit") in
 * the default configuration because no stamp can race the host commit.
 * Deliberately NOT the `subagent:`-key-prefix leg (would break
 * `isAcpSessionKey` dispatch routing) and NO category stamp (would defeat the
 * spawnedBy leg).
 *
 * All patches are no-ops unless they are provably ours to make:
 *  - settle touches only `status === "running"` entries,
 *  - boot-sweep touches only entries with `updatedAt` before the sweep ran
 *    (no in-process run can predate gateway_start) AND keys this plugin owns
 *    (binding rows + their targets),
 *  - stamps only change a spawnedBy that differs from the expected value,
 *  - the γ archive stamp only ADDS archivedAt+archivedBy where no archive
 *    exists (never un-archives, never clobbers a foreign archive), and the
 *    pre-dispatch un-archive deletes only OUR stamped archive (archivedBy
 *    id marker, no archiveReason).
 */

import {
  getDashboardBindingCloneAutoArchive,
  isNativeDispatchModeEnabled,
  parseAgentIdFromConversationId,
} from "./agent-map.js";
import type { HarnessReplyClaimLogger } from "./reply-claim.js";

/**
 * Fields the host's `buildRestartRecoveryClaimCleanupPatch`
 * (restart-recovery-state-puFilrVu.mjs:239) clears when the terminal source
 * run matches the entry's marked delivery run — the full claim set, mirrored
 * 1:1 (audit 2026-10-12 must-fix: a subset left residual delivery metadata on
 * settled entries). The terminal-evidence MERGES
 * (`restartRecoveryTerminalRunIds` / `…TerminalDeliveryEvidence`) are NOT
 * mirrored — they are record-side evidence the host accumulates, not claim
 * fields we would drop; leaving them untouched is the conservative choice.
 */
const RESTART_RECOVERY_CLAIM_FIELDS = [
  "restartRecoveryDeliveryRunId",
  "restartRecoveryDeliverySourceRunId",
  "restartRecoveryDeliveryRequestFingerprint",
  "restartRecoveryDeliveryContext",
  "restartRecoveryDeliveryReceiptState",
  "restartRecoveryDeliveryToolCallId",
  "restartRecoveryDeliveryMediaUrls",
  "restartRecoveryDisableMessageTool",
  "restartRecoverySuppressTextDelivery",
  "restartRecoveryHarnessCompletion",
  "restartRecoveryRequesterAccountId",
  "restartRecoveryRequesterSenderId",
  "restartRecoverySameChannelThreadRequired",
  "restartRecoverySourceIngress",
  "restartRecoverySourceReplyDeliveryMode",
  "restartRecoveryBeforeAgentReplyState",
  "restartRecoveryForceSafeTools",
] as const;

/**
 * Terminal outcome of the settle source (SessionRunStatusSchema union:
 * queued|running|done|failed|interrupted|killed|timeout — agent-scope .d.ts):
 * success → `done` (host run-terminal success shape), failed → `failed`
 * (error wait), timeout → `timeout`, interrupted → `interrupted` +
 * abortedLastRun:true (host mark_interrupted semantics,
 * main-session-recovery-state-DP4mDU12.mjs:147 — the boot sweep settles runs
 * the restart genuinely interrupted, and a PENDING wait was cut short).
 */
export type ClaimSettleOutcome = "success" | "failed" | "interrupted" | "timeout";

/** Structural public session-entry view (plugin-sdk projection). */
export type SettleSessionEntryLike = {
  status?: unknown;
  startedAt?: unknown;
  updatedAt?: unknown;
  spawnedBy?: unknown;
  archivedAt?: unknown;
  archivedBy?: unknown;
  archiveReason?: unknown;
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
  outcome: ClaimSettleOutcome = "success",
): SessionEntryPatch | null {
  if (!entry || entry.status !== "running") return null;
  const startedAt =
    typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt) && entry.startedAt > 0
      ? entry.startedAt
      : undefined;
  const patch: SessionEntryPatch = {
    status: outcome === "success" ? "done" : outcome,
    endedAt: stoppedAt,
    ...(startedAt !== undefined ? { runtimeMs: Math.max(0, stoppedAt - startedAt) } : {}),
    // Host mark_interrupted parity: a restart-interrupted run reports
    // abortedLastRun:true (main-session-recovery-state-DP4mDU12.mjs:158);
    // clean/failed/timeout-terminal runs report it false.
    abortedLastRun: outcome === "interrupted",
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
  outcome?: ClaimSettleOutcome;
  label: string;
  logger?: HarnessReplyClaimLogger;
}): Promise<boolean> {
  try {
    const entry = params.sessionStore.getSessionEntry(params.ref);
    if (!entry || entry.status !== "running") return false;
    const patch = buildClaimSettlePatch(entry, params.claimRunId, params.stoppedAt, params.outcome);
    if (!patch) return false;
    await params.sessionStore.patchSessionEntry({
      ...params.ref,
      update: (current) =>
        buildClaimSettlePatch(current, params.claimRunId, params.stoppedAt, params.outcome),
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
  /**
   * Wait disposition mapped onto the settle outcome (v0.7.13.22 audit
   * must-fix): "success" (wait ok) → `done`, "failed" (wait error) →
   * `failed`, "timeout" → `timeout`, "pending"-like cut-short waits →
   * `interrupted`. Only meaningful for the nodes that actually settle.
   */
  outcome?: "success" | "failed" | "interrupted" | "timeout";
  logger?: HarnessReplyClaimLogger;
}): Promise<void> {
  const stoppedAt = Date.now();
  const agentId = params.agentId ?? parseAgentIdFromConversationId(params.originSessionKey);
  const outcome: ClaimSettleOutcome = params.outcome ?? (params.waitStatus === "nonterminal" ? "interrupted" : "success");
  await settleOne({
    sessionStore: params.sessionStore,
    ref: { sessionKey: params.originSessionKey, agentId },
    claimRunId: params.claimRunId,
    stoppedAt,
    outcome,
    label: "claim-origin",
    logger: params.logger,
  });
  if (params.waitStatus === "terminal") {
    await settleOne({
      sessionStore: params.sessionStore,
      ref: { sessionKey: params.targetSessionKey, agentId },
      claimRunId: params.claimRunId,
      stoppedAt,
      outcome,
      label: "claim-target",
      logger: params.logger,
    });
  }
}

/**
 * V39: stamps `spawnedBy = <origin session key>` on a harness clone entry —
 * provenance/requester-resolution semantics (see the module doc for why this
 * ALONE does not hide the clone in the 2026.10.2 UI build). Idempotent; keeps
 * an already-correct stamp untouched and never touches entries that carry a
 * category (provenance leg requires none).
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
      `[acp-dashboard-binding] stamped spawnedBy on ${params.targetSessionKey} → ${params.originSessionKey} (V39 clone provenance leg)`,
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
 * γ archive marker. The hide rides the host's OWN archive filter
 * (createSessionCandidateFilter drops `archivedAt !== void 0` entries from
 * every standard listing — rail, chat child view, sessions page, palette,
 * counts; live dist refs in the module doc) — NOT excludeSubagents, which the
 * active UI chain does not send. The clone's session key is DETERMINISTIC per
 * conversation (agent-map acpBindingHash), and the `agent` gateway method
 * refuses work on archived entries ("Session … is archived. Restore it before
 * starting new work." — lifecycle resolveSessionWorkStartError, reached from
 * the agent-turn service gates agent-turn-service-Bypy4dbg.mjs:877/:1037/:
 * :3886 via respondUnavailableAgentSessionForKey:1676). So the archive can
 * NEVER be set while the clone must accept dispatch — it is stamped ONLY when
 * the clone is idle (at claim-target settle + boot sweep) and cleared right
 * before each dispatch (unarchiveHiddenClone, matching the host's own
 * archive/restore contract: its maintenance archives with archiveReason,
 * dispatch refuses until restored).
 *
 * The stamp is marked as OURS via `archivedBy`: {type:"system",
 * id:"acp-dashboard-binding"}. `archiveReason` is a CLOSED enum
 * (normalizeSessionEntryArchiveReason — store-entry-shape-NsPEyzA2.mjs:57 —
 * keeps only manual|active-session-cap|age-retention|stale-dashboard|
 * restart-recovery and DROPS custom values), so a custom reason cannot mark
 * the stamp. Every host archive annotates itself (maintenance writes
 * archiveReason and even deletes archivedBy — cleanup-service-nArszI9j.mjs;
 * UI/manual writes archivedBy + "manual"), so the unarchive identifies OUR
 * stamp exactly by `archivedAt set + NO archiveReason + our archivedBy id` —
 * user restore semantics are never undone.
 */
export const CLONE_ARCHIVE_ACTOR = { type: "system", id: "acp-dashboard-binding" } as const;

/** True exactly when the entry carries OUR γ archive stamp (see doc). */
export function isOursCloneArchive(entry: SettleSessionEntryLike | undefined): boolean {
  if (!entry || entry.archivedAt === undefined || entry.archiveReason !== undefined) return false;
  const by = entry.archivedBy as { id?: unknown } | undefined;
  return typeof by === "object" && by !== null && by.id === CLONE_ARCHIVE_ACTOR.id;
}

/**
 * Archives an idle harness clone with our marker archivedBy. Guards: never
 * touches user-curated entries (category set) and never overwrites a FOREIGN
 * archive (someone else owns that lifecycle — user archived it in the UI).
 * Idempotent: already-ours-archived entries are left untouched.
 *
 * γ auto-archive gate (GaRoN directive 2026-10-14): default OFF — clone
 * archives split the reply transcript off the visible conversation (readable
 * nowhere while archived). Returns null unless `cloneAutoArchive: true` is
 * configured. In NATIVE dispatch mode this stays null UNCONDITIONALLY: the
 * claim path's pre-dispatch un-archive (unarchiveHiddenClone) never fires
 * there (LIVE evidence 2026-10-14: `inbound_claim: 0 lines` with
 * dispatchMode=native), so an archived clone target would permanently refuse
 * dispatch — /reset surfaced exactly this with "Session … is archived.
 * Restore it before starting new work." (commands.runtime-GrTblwEH.mjs:102).
 * Native stamps are therefore never created, and legacy stamps are healed at
 * boot (unarchiveOwnedLegacyStamps).
 */
export function buildCloneHiddenPatch(entry: SettleSessionEntryLike | undefined): SessionEntryPatch | null {
  if (isNativeDispatchModeEnabled()) return null;
  if (!getDashboardBindingCloneAutoArchive()) return null;
  if (!entry || entry.category != null) return null;
  if (entry.archivedAt !== void 0) return null; // any archive — ours or foreign — stays
  return { archivedAt: Date.now(), archivedBy: CLONE_ARCHIVE_ACTOR };
}

export async function stampCloneHidden(params: {
  sessionStore: SessionStoreApi;
  targetSessionKey: string;
  agentId?: string | null;
  logger?: HarnessReplyClaimLogger;
}): Promise<boolean> {
  try {
    const ref = {
      sessionKey: params.targetSessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
    };
    const entry = params.sessionStore.getSessionEntry(ref);
    if (!buildCloneHiddenPatch(entry)) return false;
    await params.sessionStore.patchSessionEntry({
      ...ref,
      update: (current) => buildCloneHiddenPatch(current),
      ...(params.sessionStore.requireWriteSuccess ? { requireWriteSuccess: true } : {}),
    });
    params.logger?.debug?.(
      `[acp-dashboard-binding] archived idle clone ${params.targetSessionKey} (γ hidden from standard listings)`,
    );
    return true;
  } catch (error) {
    params.logger?.warn?.(
      `[acp-dashboard-binding] clone archival of ${params.targetSessionKey} failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/**
 * Clears OUR γ archive stamp (and only ours — see isOursCloneArchive) from a
 * clone entry just before dispatch, matching the host's restore contract —
 * the `agent` gateway method refuses work on archived entries, so an archived
 * clone cannot accept its next turn without this. An explicit-`undefined`
 * patch deletes the fields (mergeSessionEntry is `{...existing, ...patch}` —
 * types-BZlUzQZy.mjs:65).
 */
export async function unarchiveHiddenClone(params: {
  sessionStore: SessionStoreApi;
  targetSessionKey: string;
  agentId?: string | null;
  logger?: HarnessReplyClaimLogger;
}): Promise<boolean> {
  try {
    const ref = {
      sessionKey: params.targetSessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
    };
    const entry = params.sessionStore.getSessionEntry(ref);
    if (!isOursCloneArchive(entry)) return false;
    await params.sessionStore.patchSessionEntry({
      ...ref,
      update: (current) =>
        isOursCloneArchive(current)
          ? ({ archivedAt: undefined, archivedBy: undefined } as SessionEntryPatch)
          : null,
      ...(params.sessionStore.requireWriteSuccess ? { requireWriteSuccess: true } : {}),
    });
    params.logger?.debug?.(
      `[acp-dashboard-binding] un-archived clone ${params.targetSessionKey} for dispatch (γ archive-when-idle)`,
    );
    return true;
  } catch (error) {
    params.logger?.warn?.(
      `[acp-dashboard-binding] clone un-archive of ${params.targetSessionKey} failed — ${error instanceof Error ? error.message : String(error)}`,
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
        outcome: "interrupted",
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
}): Promise<{ settled: string[]; archived: string[] }> {
  const stoppedAt = Date.now();
  const cutoff = params.cutoffMs ?? stoppedAt;
  const settled: string[] = [];
  const archived: string[] = [];
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
      const updatedAt = typeof entry.updatedAt === "number" && entry.updatedAt > 0 ? entry.updatedAt : 0;
      const updatedAtIsLive = updatedAt > cutoff;
      // γ archival leg (clones only): archive every provably-ours idle clone —
      // the key grammar (CLONE_KEY_REST_RE) is produced exclusively by this
      // plugin's dispatch, so it is proof enough of ownership even when a
      // pre-γ clone carries no spawnedBy yet. stampCloneHidden guards
      // categories and foreign archives (buildCloneHiddenPatch).
      if (CLONE_KEY_REST_RE.test(rest) && !updatedAtIsLive) {
        const hidden = await stampCloneHidden({
          sessionStore: params.sessionStore,
          targetSessionKey: sessionKey,
          agentId,
          logger: params.logger,
        });
        if (hidden) archived.push(sessionKey);
      }
      // §19c orphan-settle leg (clones + dashboard-origin conversations).
      const isOwned = CLONE_KEY_REST_RE.test(rest) || DASHBOARD_KEY_REST_RE.test(rest);
      if (!isOwned) continue;
      const status = typeof entry.status === "string" ? entry.status : "";
      if (status !== "running") continue;
      if (updatedAtIsLive) continue;
      const patched = await settleOne({
        sessionStore: params.sessionStore,
        ref: { sessionKey, agentId },
        outcome: "interrupted",
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
  return { settled, archived };
}

/**
 * Native-mode boot heal (§23 reset-bug, GaRoN directive 2026-10-14): clears
 * OUR γ archive stamps from OUR owned key shapes at gateway_start so the host
 * never refuses dispatch on an archived binding target again. The claim path
 * heals per dispatch (unarchiveHiddenClone), but in native dispatch mode
 * `inbound_claim` never fires (LIVE evidence 2026-10-14: zero claim lines all
 * day) and the host's /reset + first dispatch both hit the archived entry —
 * "Session … is archived. Restore it before starting new work." failed 2/2 on
 * the main binding until an out-of-band reset cleared the stamp. Native mode
 * creates NO new stamps (buildCloneHiddenPatch refuses), so boot is the one
 * moment where the heal can run without racing a live turn: gateway_start has
 * no in-process dispatch either.
 *
 * Ownership is proven twice over: the key must be OUR grammar (clone or
 * dashboard rest, same regexes as the boot sweep) AND the stamp must be OURS
 * (isOursCloneArchive — our archivedBy id, no archiveReason). Foreign archives
 * (host maintenance, user archives in the UI) carry archiveReason or a
 * different archivedBy and are never touched.
 */
export async function unarchiveOwnedLegacyStamps(params: {
  sessionStore: SweepSessionStoreApi;
  agentIds: readonly string[];
  logger?: HarnessReplyClaimLogger;
}): Promise<{ restored: string[] }> {
  // Native-mode-only heal (self-gated, defense in depth vs call-site drift).
  // Claim mode must keep γ hiding semantics: there, archived clones come back
  // per dispatch via unarchiveHiddenClone — a boot-wide reveal would change
  // claim behavior.
  if (!isNativeDispatchModeEnabled()) return { restored: [] };
  const restored: string[] = [];
  for (const agentId of params.agentIds) {
    let rows: Array<{ sessionKey: string; entry: SettleSessionEntryLike }>;
    try {
      rows = params.sessionStore.listSessionEntries({ agentId, readOnly: true });
    } catch (error) {
      params.logger?.warn?.(
        `[acp-dashboard-binding] un-archive sweep listing agent ${agentId} failed — ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    for (const { sessionKey, entry } of rows) {
      const rest = sessionKey
        .trim()
        .split(":")
        .slice(2)
        .join(":");
      if (!(CLONE_KEY_REST_RE.test(rest) || DASHBOARD_KEY_REST_RE.test(rest))) continue;
      if (!isOursCloneArchive(entry)) continue;
      try {
        await params.sessionStore.patchSessionEntry({
          sessionKey,
          agentId,
          update: (current) =>
            isOursCloneArchive(current)
              ? ({ archivedAt: undefined, archivedBy: undefined } as SessionEntryPatch)
              : null,
          ...(params.sessionStore.requireWriteSuccess ? { requireWriteSuccess: true } : {}),
        });
        restored.push(sessionKey);
        params.logger?.debug?.(
          `[acp-dashboard-binding] un-archived legacy γ stamp on ${sessionKey} (native dispatch: archived targets refuse work)`,
        );
      } catch (error) {
        params.logger?.warn?.(
          `[acp-dashboard-binding] un-archive of ${sessionKey} failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return { restored };
}

/**
 * V39 over-hiding boot heal (§23.2 dry-run finding 2026-10-15: the host's
 * listing predicate — readSessionListSelectionFacts, session-list-target-
 * C2rmz7hN.mjs:39 — treats ANY set spawnedBy outside a `dashboard:` rest as
 * isSubagent, so provenance-stamped clone rows drop out of every standard
 * listing while remaining fully live, binding-reachable work sessions).
 *
 * The stamps on OUR clone grammar are OUR legacy provenance writes
 * (stampSubagentProvenance, spawnedBy = the origin parent key — LIVE 5/5
 * values confirmed parent keys). In NATIVE dispatch mode the clone row IS the
 * real conversation session; a parent-stamp there is pure over-hiding noise
 * with a
 * real cost (hidden rail/palette/counts). The .27 V39 guard (2dd81d9, not in
 * the .28 baseline) prevents future stamps; this leg un-hides existing ones.
 * Claim mode keeps γ semantics and is untouched (self-gate like the archive
 * heal). DASHBOARD rows proved clean (isSubagent=false by the predicate) —
 * clear runs on clone grammar only.
 */
export async function unhideOverstampedCloneSessions(params: {
  sessionStore: SweepSessionStoreApi;
  agentIds: readonly string[];
  logger?: HarnessReplyClaimLogger;
}): Promise<{ unhidden: string[] }> {
  if (!isNativeDispatchModeEnabled()) return { unhidden: [] };
  const unhidden: string[] = [];
  for (const agentId of params.agentIds) {
    let rows: Array<{ sessionKey: string; entry: SettleSessionEntryLike }>;
    try {
      rows = params.sessionStore.listSessionEntries({ agentId, readOnly: true });
    } catch (error) {
      params.logger?.warn?.(
        `[acp-dashboard-binding] V39 heal listing agent ${agentId} failed — ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    for (const { sessionKey, entry } of rows) {
      const rest = sessionKey
        .trim()
        .split(":")
        .slice(2)
        .join(":");
      if (!CLONE_KEY_REST_RE.test(rest)) continue;
      const stamped = typeof entry.spawnedBy === "string" && entry.spawnedBy.trim() !== "";
      if (!stamped) continue;
      try {
        await params.sessionStore.patchSessionEntry({
          sessionKey,
          agentId,
          update: (current) =>
            typeof current.spawnedBy === "string" && current.spawnedBy.trim()
              ? ({ spawnedBy: undefined } as SessionEntryPatch)
              : null,
          ...(params.sessionStore.requireWriteSuccess ? { requireWriteSuccess: true } : {}),
        });
        unhidden.push(sessionKey);
        params.logger?.debug?.(
          `[acp-dashboard-binding] cleared legacy spawnedBy stamp on ${sessionKey} (V39 over-hiding: real work session listed as subagent)`,
        );
      } catch (error) {
        params.logger?.warn?.(
          `[acp-dashboard-binding] spawnedBy clear of ${sessionKey} failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return { unhidden };
}
