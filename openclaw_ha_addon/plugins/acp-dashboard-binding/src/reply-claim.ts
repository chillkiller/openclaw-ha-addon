/**
 * Phase 3.1 (F4-fix 2.0, Weg A): the `inbound_claim` typed-hook handler.
 *
 * Root cause this closes: the host's plugin-bound dispatch path
 * (dist/dispatch-from-config-BG9rT_X3.mjs ~3436-3530) is the ONLY designed way
 * a binding-target session's reply reaches the ORIGIN dashboard conversation —
 * a `{handled: true, reply}` claim result is handed to
 * `deliverBindingPayload(reply, "terminal", transcriptOwner)`, whose
 * `sourceReplyTranscriptMirror` + turnLedger fallback run the webchat projected
 * dispatcher → `finalizeChatSendDispatchedReplies` → transcript append +
 * `broadcastChatTerminal` (live UI delivery). Retargeted dispatches (the old
 * synthetic-row path) never re-route the replay back, so the harness reply died
 * in the target session.
 *
 * Turn-start seam (Weg A, replacing Phase 2.20's gateway.request seam): the
 * Phase 2.20 handler dispatched the harness turn via
 * `api.runtime.gateway.request("sessions.send"/"agent.wait")`, but that seam is
 * Trust-Klasse-gesichert — `dispatchTrustedPluginGatewayMethod`
 * (dist/server-plugins-CzOpf53P.mjs:369) requires
 * `canTrustedOfficialPluginRequestScopes` (official catalog provenance +
 * integrity; a source-path plugin can never pass it, no config flag), which
 * failed LIVE: "Gateway requests are only available to bundled or trusted
 * official plugins."
 *
 * The agent-based spawn path is NOT gated: `api.runtime.subagent`
 * (src/agents/plugin-runtime-subagent types; dist/server-plugins-CzOpf53P.mjs
 * `createGatewaySubagentRuntime`, attached unconditionally next to
 * `gateway` in `createGatewayPluginRuntimeBindings`
 * dist/package-update-activation-recovery.mjs:1308663) dispatches the underlying
 * `agent`/`agent.wait` gateway methods straight in-process
 * (`dispatchGatewayMethodInProcess`) with `agentRunTracking: "plugin_subagent"`
 * and a synthetic system operator client — no trusted-official check anywhere on
 * that path, and it is the documented general-plugin surface
 * (docs/plugins/sdk-runtime/background-work.md#api-runtime-subagent):
 *   `subagent.run({sessionKey, message})` → `{runId, sessionKey?}` starts a full
 *   agent turn in an EXISTING session; `subagent.waitForRun({runId, timeoutMs})`
 *   blocks until run settle and returns the canonical wait result incl.
 *   `terminalReply` (AgentWaitResult in run-wait.types.d.ts). NOTE:
 *   `api.runtime.hooks.dispatchHookAgentTurn` is explicitly trust-gated
 *   ("available only to bundled plugins and trusted official plugin
 *   installations") and `hook:`-key-bound — NOT usable, hence Weg A is subagent.
 *
 * Delivery stays exactly the Phase 2.20 design — the claim RESULT is the
 * delivery: `{handled: true, reply: {text}}` → host `deliverBindingPayload` →
 * origin webchat UI. No out-of-band session write is needed (and none is
 * allowed to us without the gateway trust gate).
 *
 * Phase 3.5 (transcript-mirror forensics, 2026-10-10, GaRoN finding: the turn
 * runs in the target but the origin chat keeps no answer after reload):
 *  - Verified mechanics: `deliverBindingPayload` (dispatch-from-config-BG9rT_X3.mjs
 *    :3077-3094) stamps `sourceReplyTranscriptMirror: transcriptOwner` from
 *    `persistPluginBindingUserTurn` (:2603-2645), whose owner is ALWAYS the
 *    binding TARGET (`pluginBindingSessionKey = record.targetSessionKey`,
 *    :2601). The turnLedger fallback runs the webchat projected dispatcher →
 *    `finalizeChatSendDispatchedReplies` (chat-send-handler-CxoF4cDR.mjs:2297)
 *    → assistant append to the MIRROR OWNER (=target, kind "owner") or SKIP
 *    (kind "blocked", recorder already persisted) + LIVE
 *    `broadcastChatTerminal({sessionKey: ORIGIN})` (:2491). The ORIGIN
 *    transcript NEVER receives the assistant row in the claimed path.
 *  - Our binding row cannot change this: the host derives the mirror owner
 *    from `record.targetSessionKey` and ignores any row metadata for it (user
 *    options (a)/(b)/(c) all void — see BRIDGE.md Phase 3.5 §). Live
 *    visibility of the answer in GaRoN's chat is therefore broadcast-only;
 *    the full turn history (user+assistant) persists in the TARGET/harness
 *    session — the designed acpx-thread layout (the control-ui reads the
 *    bound target transcript for 🤖-threads, and plugin-owned records are
 *    excluded from the get-reply/history retarget path).
 *  - Race hardening added here: `subagent.run` ack returns runId BEFORE the
 *    gateway registers the run (observed ~200 ms live; both Phase 3.5 live
 *    tests hit it) — an immediate `waitForRun` used to throw and degrade to
 *    the "waiting failed" notice. Now a thrown wait is retried with short
 *    backoff while the failures stay FAST (registration lag), bounded by the
 *    retry budget; only genuine wait failures after the budget reach the
 *    notice reply.
 *
 * Design (host-design-faithful, no host patching):
 *  1. Binding records carry plugin-owned ownership metadata (agent-map
 *     `buildPluginOwnedBindingMetadata`) → the host SKIPS retargeting for them
 *     and claims the turn through `runInboundClaimForPluginOutcome(pluginId,
 *     event, ctx)` → THIS handler.
 *  2. The handler runs the harness turn itself via `api.runtime.subagent`
 *     (Weg A above; ownership asserts accept unlocked `agent:<id>:acp:…`
 *     entries — same as Phase 2.20 verified for the sessions.send seam).
 *  3. `{handled: true, reply: {text}}` → host delivery (see 1). Anything that
 *     fails BEFORE a turn was started returns `{handled: false}` — the host
 *     then shows its plugin-binding-unavailable notice and falls through to
 *     normal origin processing (the pre-F4 behavior). Once a turn WAS started
 *     in the target session we always return `handled: true` (a status/notice
 *     reply at worst) so the origin dispatch cannot run the turn a second time.
 */

import {
  CHANNEL_ID,
  isHarnessProvisionedSessionKey,
  isNativeDispatchModeEnabled,
  parseAgentIdFromConversationId,
  pendingDashboardHarnessProvisioning,
  isAcpShapedSessionKey,
} from "./agent-map.js";
import {
  createConfigHarnessRoster,
  resolveDashboardBinding,
  type ConversationRefLike,
} from "./dashboard-bridge.js";
import { deriveDashboardBindingRecord } from "./binding-adapter.js";
import {
  settleClaimedTurnSessions,
  stampCloneHidden,
  stampSubagentProvenance,
  unarchiveHiddenClone,
  type SessionStoreApi,
} from "./session-settle.js";

/**
 * Default max wait for the harness run (`subagent.waitForRun`). The wait does
 * NOT cancel the run — on timeout the turn keeps running in the target session.
 */
export const DEFAULT_HARNESS_REPLY_WAIT_MS = 120_000;
const MIN_HARNESS_REPLY_WAIT_MS = 1_000;
const MAX_HARNESS_REPLY_WAIT_MS = 15 * 60_000;

/**
 * Post-settle yield (Punkt 1 / BRIDGE §17, 2026-10-11): the host's run-terminal
 * session-entry persistence (`session-entry.patch` via
 * `captureAgentRunTerminalWriteContext`) races with the binding mirror writes
 * our claim reply triggers (`deliverBindingPayload` fires immediately after we
 * return). Every claimed turn in the §17 live window failed its terminal commit
 * with "Terminal write owner changed before commit", leaving the binding
 * session entry `status:"running"` with a dangling lifecycleRunId; the counter-
 * example (main-klon Session without the claim mirror) committed cleanly.
 * Yielding before we return gives the terminal persistence a head start so its
 * commit precedes the mirror writes. Applied ONLY after a TERMINAL wait result
 * (ok / error) — timeout/pending mean the run is still going and no terminal
 * write is scheduled. Pure scheduling change: delivery semantics unchanged.
 */
export const DEFAULT_POST_SETTLE_YIELD_MS = 500;
const MAX_POST_SETTLE_YIELD_MS = 10_000;

/**
 * Phase 3.5: the `subagent.run` ack can return a runId BEFORE the gateway
 * registers/starts the run (observed ~200 ms live; audit_events
 * agent.run.started lags the ack). An immediate `waitForRun` then throws
 * fast — retry with short backoff, but ONLY while the failures stay fast:
 * a slow throw is a genuine API failure and goes straight to the notice.
 */
const RUN_REGISTRATION_RETRY_DELAYS_MS = [100, 250, 500, 750];
/** A thrown wait that consumed more than this budget is NOT the ack race. */
const REGISTER_LAG_CALL_BUDGET_MS = 5_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settleRunWait(
  subagent: HarnessSubagentApi,
  runId: string,
  waitMs: number,
  retryDelaysMs: number[],
  callBudgetMs: number,
  log: HarnessReplyClaimLogger,
): Promise<{ wait?: HarnessSubagentWaitResultLike; errorMessage?: string }> {
  let attempt = 0;
  let lastMessage = "";
  for (;;) {
    const startedAt = Date.now();
    try {
      return { wait: await subagent.waitForRun({ runId, timeoutMs: waitMs }) };
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
    }
    const elapsed = Date.now() - startedAt;
    // Retry only a FAST failure — the ack-precedes-registration race. A throw
    // after a long (near-full-wait) call is a genuine API failure; notice.
    const delay = elapsed <= callBudgetMs ? retryDelaysMs[attempt] : undefined;
    if (delay === undefined || Number.isNaN(delay)) break;
    attempt += 1;
    log.debug?.(`[${CHANNEL_ID}] wait ${runId}: registration-lag retry in ${delay}ms — ${lastMessage}`);
    await sleep(delay);
  }
  return { errorMessage: lastMessage };
}

function clampWaitMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_HARNESS_REPLY_WAIT_MS;
  }
  return Math.min(
    MAX_HARNESS_REPLY_WAIT_MS,
    Math.max(MIN_HARNESS_REPLY_WAIT_MS, Math.floor(value)),
  );
}

/** Clamps the §17 yield (non-finite/negative → disabled; bounded above). */
function clampYieldMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(MAX_POST_SETTLE_YIELD_MS, Math.floor(value));
}

/** Plugin config (`plugins.entries['<CHANNEL_ID>'].config`) view we read here. */
type DashboardPluginReplyConfig = {
  harnessReplyWaitMs?: unknown;
};

function readWaitMs(cfg: unknown): number {
  const entry = (cfg as { plugins?: { entries?: Record<string, { config?: DashboardPluginReplyConfig }> } } | undefined)
    ?.plugins?.entries?.[CHANNEL_ID]?.config;
  return clampWaitMs(entry?.harnessReplyWaitMs);
}

/** Structural host event/ctx shapes (plugin-sdk plugin-entry types). */
export type InboundClaimEventLike = {
  content?: string;
  body?: string;
  bodyForAgent?: string;
};

export type InboundClaimContextLike = {
  pluginBinding?: ConversationRefLike & {
    pluginId?: string;
    bindingId?: string;
  };
};

/** Inbound claim result the host expects (PluginHookInboundClaimResult). */
export type InboundClaimResultLike = {
  handled: boolean;
  reply?: { text?: string; isError?: boolean };
};

/**
 * Structural mirror of the `api.runtime.subagent` agent-turn surface
 * (SubagentRunParams/SubagentRunResult/AgentWaitResult,
 * plugin-sdk agent-harness-runtime d.ts). Deliberately NOT
 * `api.runtime.gateway` — `gateway.request` is Trust-Klasse-gesichert
 * (dispatchTrustedPluginGatewayMethod, server-plugins-CzOpf53P.mjs:369); the
 * subagent surface dispatches `agent`/`agent.wait` in-process WITHOUT that gate.
 */
export type HarnessSubagentRunParamsLike = {
  sessionKey: string;
  message: string;
};

export type HarnessSubagentRunResultLike = {
  runId?: unknown;
  sessionKey?: unknown;
};

export type HarnessSubagentWaitResultLike = {
  status?: unknown;
  error?: unknown;
  terminalReply?: {
    disposition?: unknown;
    text?: unknown;
  } | null;
};

export type HarnessSubagentApi = {
  run: (
    params: HarnessSubagentRunParamsLike,
  ) => Promise<HarnessSubagentRunResultLike>;
  waitForRun: (params: {
    runId: string;
    timeoutMs?: number;
  }) => Promise<HarnessSubagentWaitResultLike>;
};

export type HarnessReplyClaimLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type HarnessReplyClaimOptions = {
  /** Live OpenClaw config (roster + harnessSessions + plugin entry config). */
  getConfig?: () => unknown;
  /** `api.runtime.subagent` — the un-gated agent-turn surface (Weg A). */
  subagent?: HarnessSubagentApi;
  /**
   * Optional gateway-binding preflight (`api.runtime.gateway.isAvailable` —
   * itself NOT trust-gated); a missing gateway context fails the run anyway,
   * this just short-circuits it with a clearer log line.
   */
  isGatewayAvailable?: () => Promise<boolean>;
  /** Override for the waitForRun registration-lag retry backoff (tests). */
  waitRetryDelaysMs?: number[];
  /** Override for the "fast failure" call budget of that retry (tests). */
  waitRetryCallBudgetMs?: number;
  /**
   * Post-settle yield before returning a TERMINAL reply (default
   * DEFAULT_POST_SETTLE_YIELD_MS; 0 disables). §17 terminal-write race window —
   * see the constant's comment. Tests override to keep them fast.
   */
  postSettleYieldMs?: number;
  /**
   * BRIDGE §19 (v0.7.13.22-Paket a/c): the plugin-sdk session-store surface
   * (patchSessionEntry/getSessionEntry). When present, the claim settles the
   * origin conversation node after EVERY return and the clone node after a
   * TERMINAL wait — the host never writes those run-terminal entries for
   * claimed turns (99d8daf5… live-DB proof), which is the root of the
   * "Denken-Spinner" stuck-state. Optional: without it the claim behaves
   * exactly as in v0.7.13.21.
   */
  sessionStore?: SessionStoreApi | null;
  /**
   * BRIDGE §20 (v0.7.13.22): mirrors the claim's terminal reply into the ORIGIN
   * conversation transcript (appendAssistantMirrorMessageByIdentity — the host
   * delivers the reply to the origin conversation but never transcribes it
   * there, so re-renders lost it: the "Flüchtigkeit" root). Best-effort
   * contract: never throws, never blocks the reply. Injected from index.ts
   * (live: dynamic import of the types-less
   * `openclaw/plugin-sdk/session-transcript-runtime` host export). Absent →
   * re-render persistence stays the pre-§20 behavior.
   */
  mirrorClaimReply?: (params: {
    originSessionKey: string;
    agentId: string;
    claimRunId: string;
    replyText: string;
  }) => Promise<void>;
  logger?: HarnessReplyClaimLogger;
};

/** Body text the claim should forward; null when there is nothing to send. */
function readClaimMessage(event: InboundClaimEventLike): string | null {
  const text = (event.bodyForAgent ?? event.body ?? event.content ?? "").trim();
  return text ? text : null;
}

/**
 * Same target cascade the binding adapter answers with (§4.2 bridge resolver →
 * adapter derive). Keeping the identical deterministic target ensures the
 * host's resolve → touch → re-resolve stability comparison and this claim see
 * one consistent session key per conversation.
 */
function resolveClaimTarget(
  binding: InboundClaimContextLike["pluginBinding"],
  cfg: unknown,
): { target: string; agentId: string; provisioned: boolean } | null {
  const conversationId = (binding?.conversationId ?? "").trim();
  const agentId = parseAgentIdFromConversationId(conversationId);
  if (!agentId) return null;
  const ref: ConversationRefLike = {
    channel: (binding?.channel ?? "").trim().toLowerCase(),
    accountId: (binding?.accountId ?? "").trim().toLowerCase(),
    conversationId,
    ...(binding?.parentConversationId ? { parentConversationId: binding.parentConversationId.toLowerCase() } : {}),
  };
  // Same cascade the adapter answers with — the roster gate inside both
  // resolvers keeps a de-rostered agent from claiming (handled:false →
  // fallback), and both derivation paths share agent-map's target derivation.
  const bridged = resolveDashboardBinding(ref, { roster: createConfigHarnessRoster(cfg) });
  const record = bridged ?? deriveDashboardBindingRecord(ref, cfg);
  const target = record?.targetSessionKey ?? null;
  const trimmed = (target ?? "").trim();
  if (!trimmed || !isAcpShapedSessionKey(trimmed)) return null;
  // Phase 2.22: the barrier needs the PROVISIONED marker (records carry it on
  // the provisioned cascade leg) because with origin-workspace cwds the target
  // may be a cwd-scoped key — not derivable from the agent id alone, so the
  // barrier below waits on the key, not the agent.
  const provisioned = record?.metadata?.provisioned === true;
  return { target: trimmed, agentId, provisioned };
}

export function createHarnessReplyClaimHandler(options: HarnessReplyClaimOptions) {
  return async (
    event: InboundClaimEventLike,
    ctx: InboundClaimContextLike,
  ): Promise<InboundClaimResultLike> => {
    // BRIDGE §20: mirrors a handled claim's terminal reply into the origin
    // transcript before the result leaves the handler. Same origin-key guard as
    // §19; a broken/unset mirror never affects the reply itself.
    const finishReply = async (
      result: InboundClaimResultLike,
      originSessionKey: string,
      agentId: string,
      claimRunId: string,
    ): Promise<InboundClaimResultLike> => {
      const replyText = (result.reply?.text ?? "").trim();
      const mirror = options.mirrorClaimReply;
      if (replyText && mirror && parseAgentIdFromConversationId(originSessionKey)) {
        try {
          await mirror({ originSessionKey, agentId, claimRunId, replyText });
        } catch {
          // The mirror contract is best-effort; the reply must not degrade.
        }
      }
      return result;
    };
    const log = options.logger ?? {};
    const cfg = options.getConfig?.();
    const binding = ctx.pluginBinding;
    try {
      // Weg-B native mode (BRIDGE.md §21): generic records never reach this hook
      // host-side (dispatch-from-config only claims plugin-owned records); this
      // gate is the second line of defense for a mode flip mid-flight (live
      // config reload before a stale plugin-owned row was re-resolved). The
      // host falls through to native dispatch; the claim machinery stays
      // unreachable until the mode returns to "claim".
      if (isNativeDispatchModeEnabled()) {
        log.debug?.(`[${CHANNEL_ID}] inbound_claim: native dispatch mode; not claiming`);
        return { handled: false };
      }
      // Only claim conversations our plugin owns (the host targets this hook at
      // resolved plugin-owned bindings of OUR pluginId; guard defensively).
      if (binding?.pluginId !== CHANNEL_ID) return { handled: false };
      const message = readClaimMessage(event);
      if (!message) {
        log.debug?.(`[${CHANNEL_ID}] inbound_claim: empty inbound body; not claiming`);
        return { handled: false };
      }
      const claimed = resolveClaimTarget(binding, cfg);
      if (!claimed) {
        log.debug?.(
          `[${CHANNEL_ID}] inbound_claim: no harness target for conversation ${binding?.conversationId ?? "(none)"}; not claiming`,
        );
        return { handled: false };
      }
      const { target, agentId, provisioned } = claimed;
      if (typeof options.isGatewayAvailable === "function") {
        const available = await options.isGatewayAvailable();
        if (!available) {
          log.warn?.(`[${CHANNEL_ID}] inbound_claim: gateway unavailable; not claiming`);
          return { handled: false };
        }
      }
      if (!options.subagent) {
        log.warn?.(`[${CHANNEL_ID}] inbound_claim: no runtime.subagent surface (turn start unavailable); not claiming`);
        return { handled: false };
      }
      const waitMs = readWaitMs(cfg);
      log.debug?.(`[${CHANNEL_ID}] inbound_claim: dispatching harness turn to ${target}`);

      // Phase 2.21 barrier: when the target is an auto-provisioned session, its
      // initialization may still be in flight (the resolve hands out the
      // deterministic key fire-and-forget). Await it BEFORE starting the turn —
      // a not-yet-initialized key would dispatch into the host's "stale" ACP
      // error. Phase 2.24 (Klon-Modus): clone keys fire via the record's
      // `metadata.provisioned` flag (binding-adapter/bridge set it on the
      // provisioned leg); `isHarnessProvisionedSessionKey` stays as the legacy
      // fallback for pre-2.24 keys. Failure does not block the claim: the turn
      // start in the target surfaces the host's ACP init error (handled:true),
      // so the origin dispatch cannot process it twice.
      if (provisioned || isHarnessProvisionedSessionKey(agentId, target)) {
        // Phase 2.22: barrier keyed by the TARGET session key (cwd-scoped
        // provisioned keys are not derivable from the agent id).
        const provisioning = pendingDashboardHarnessProvisioning(target);
        if (provisioning) {
          const ok = await provisioning.catch(() => false);
          if (!ok) {
            log.warn?.(
              `[${CHANNEL_ID}] inbound_claim: auto-provisioning of ${target} failed; dispatching anyway (host ACP init error expected)`,
            );
          }
        }
      }

      // BRIDGE §19 (V39) + γ archive-when-idle: before the turn starts, stamp
      // the clone's spawnedBy provenance (requester resolution — the host's
      // metadata seed leaves it NULL) and clear OUR previous archive stamp —
      // the `agent` gateway method this dispatch rides REFUSES work on
      // archived entries ("Session … is archived. Restore it before starting
      // new work.", lifecycle resolveSessionWorkStartError; reached by the
      // agent-turn service gates agent-turn-service-Bypy4dbg.mjs:1676/:877/
      // :1037/:3886). unarchiveHiddenClone only ever clears OUR archivedBy-id
      // marker (acp-dashboard-binding; a host archive — archiveReason or a
      // human archivedBy — stays). The γ hide itself is stamped on SETTLE
      // (stampCloneHidden) and by the boot sweep — an archive-while-runnable
      // would break the NEXT turn on this conversation-deterministic clone key
      // (agent-map acpBindingHash: sha256(channel:account:conversationId)).
      // §19a: with the session store wired we also settle the conversation
      // nodes after the turn — see the terminal branch below.
      if (options.sessionStore) {
        const originSessionKey = (binding?.conversationId ?? "").trim();
        if (parseAgentIdFromConversationId(originSessionKey)) {
          await unarchiveHiddenClone({
            sessionStore: options.sessionStore,
            targetSessionKey: target,
            agentId,
            logger: log,
          });
          await stampSubagentProvenance({
            sessionStore: options.sessionStore,
            targetSessionKey: target,
            originSessionKey,
            agentId,
            logger: log,
          });
        }
      }

      // 1. Start the turn in the target session (Weg A: subagent.run dispatches
      //    the `agent` gateway method in-process — no trusted-official gate).
      const ack = await options.subagent.run({ sessionKey: target, message });
      const runId = typeof ack?.runId === "string" && ack.runId ? ack.runId : "";
      if (!runId) {
        log.warn?.(`[${CHANNEL_ID}] inbound_claim: subagent.run carried no runId; not claiming`);
        return { handled: false };
      }

      // 2. Block until the run settles; waitForRun returns the canonical wait
      //    state incl. terminalReply {disposition, text}. In-process wait — the
      //    gateway.client timeout grace from Phase 2.20 no longer applies, and
      //    the timeout does NOT cancel the run. Fast wait failures are retried
      //    with short backoff (Phase 3.5: ack precedes run registration).
      const settled = await settleRunWait(
        options.subagent,
        runId,
        waitMs,
        options.waitRetryDelaysMs ?? RUN_REGISTRATION_RETRY_DELAYS_MS,
        options.waitRetryCallBudgetMs ?? REGISTER_LAG_CALL_BUDGET_MS,
        log,
      );
      if (settled.errorMessage !== undefined) {
        const note = settled.errorMessage;
        log.warn?.(`[${CHANNEL_ID}] inbound_claim: waitForRun failed for run ${runId} — ${note}`);
        // §19a: the fallback reply ENDS the origin dispatch from the user's
        // view (terminal delivery) — settle the origin node now (nonterminal:
        // the clone run may genuinely still be going) or the Denken-Spinner
        // resurfaces on this error edge.
        if (options.sessionStore) {
          const errorOriginKey = (binding?.conversationId ?? "").trim();
          if (parseAgentIdFromConversationId(errorOriginKey)) {
            await settleClaimedTurnSessions({
              sessionStore: options.sessionStore,
              originSessionKey: errorOriginKey,
              targetSessionKey: target,
              claimRunId: runId,
              agentId,
              waitStatus: "nonterminal",
              logger: log,
            });
          }
        }
        return await finishReply(
          {
            handled: true,
            reply: {
              text:
                `Harness turn dispatched to \`${target}\` (run \`${runId}\`) but waiting for its reply failed: ${note} — the turn is still running there.`,
            },
          },
          (binding?.conversationId ?? "").trim(),
          agentId,
          runId,
        );
      }
      // §17 (Punkt 1): only a TERMINAL wait result schedules the host's
      // run-terminal entry persistence — yield before replying so that commit
      // precedes the binding mirror writes our reply triggers.
      const wait = settled.wait;
      const status = typeof wait?.status === "string" ? wait.status : "error";
      if (wait != null && status !== "timeout" && status !== "pending") {
        const yieldMs = clampYieldMs(options.postSettleYieldMs ?? DEFAULT_POST_SETTLE_YIELD_MS);
        if (yieldMs > 0) {
          log.debug?.(`[${CHANNEL_ID}] inbound_claim: post-settle yield ${yieldMs}ms before reply delivery (terminal-write window)`);
          await sleep(yieldMs);
        }
      }
      // BRIDGE §19a: settle the session-node entries the claimed turn leaves
      // behind. The host completes the dispatch but never writes the ORIGIN
      // conversation node's run-terminal entry (live-DB proof: 99d8daf5… stuck
      // `running` with the claim's lifecycleRunId even after a CLEAN completed
      // claim turn) — that stuck status is the Denken-Spinner root. The TARGET
      // node is settled only on a terminal wait: for timeout/pending the
      // harness run is genuinely still going. Idempotent — no-ops when the
      // host's own terminal write already won the §17 window.
      if (options.sessionStore) {
        const originSessionKey = (binding?.conversationId ?? "").trim();
        if (parseAgentIdFromConversationId(originSessionKey)) {
          // Wait-disposition mapping (v0.7.13.22 audit must-fix 2): the settle
          // status reflects the ACTUAL wait outcome instead of forcing
          // "done" — ok→done, error→failed, timeout→timeout, pending→
          // interrupted (SessionRunStatusSchema union, agent-scope .d.ts).
          await settleClaimedTurnSessions({
            sessionStore: options.sessionStore,
            originSessionKey,
            targetSessionKey: target,
            claimRunId: runId,
            agentId,
            waitStatus:
              wait != null && status !== "timeout" && status !== "pending" ? "terminal" : "nonterminal",
            outcome:
              status === "ok" ? "success" : status === "error" ? "failed" : status === "timeout" ? "timeout" : "interrupted",
            logger: log,
          });
          // γ archive-when-idle: a TERMINAL turn retires the clone back out of
          // the standard listings (host archive filter, see session-settle.ts
          // module doc — the earlier "excludeSubagents everywhere" claim was
          // disproven live 2026-10-13). The clone stays dispatchable: the next
          // turn un-archives it right before its run (above). stampCloneHidden
          // never touches user-curated or foreign-archived entries.
          if (wait != null && status !== "timeout" && status !== "pending") {
            await stampCloneHidden({
              sessionStore: options.sessionStore,
              targetSessionKey: target,
              agentId,
              logger: log,
            });
          }
        }
      }
      // §20: mirror the terminal reply (answer or notice) into the origin
      // transcript before the host delivers it — the agent-run finalization
      // never transcribes claim replies (live-DB proof 048d96d7…: no assistant
      // record), which is why re-renders lost them.
      return await finishReply(
        harnessWaitReply(target, runId, settled.wait),
        (binding?.conversationId ?? "").trim(),
        agentId,
        runId,
      );
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      log.warn?.(`[${CHANNEL_ID}] inbound_claim: claim error — ${note}`);
      return { handled: false };
    }
  };
}

/**
 * Maps a `subagent.waitForRun` (canonical `agent.wait`) result to the claim
 * reply. Always handled once the turn started in the target session
 * (dup-processing guard — see module head). `pending` is a normal
 * nonterminal observation (run-wait.types.d.ts AgentWaitResult) — reported like
 * a timeout: the turn keeps running, no double processing.
 */
function harnessWaitReply(
  target: string,
  runId: string,
  wait: HarnessSubagentWaitResultLike | null | undefined,
): InboundClaimResultLike {
  const status = typeof wait?.status === "string" ? wait.status : "error";
  if (status === "ok") {
    const terminalReply = wait?.terminalReply;
    const text =
      typeof terminalReply?.text === "string" &&
      terminalReply.disposition === "visible" &&
      terminalReply.text.trim()
        ? terminalReply.text
        : "";
    if (text) return { handled: true, reply: { text } };
    return {
      handled: true,
      reply: {
        text:
          `Harness turn finished in \`${target}\` without a visible reply (run \`${runId}\`).`,
      },
    };
  }
  const errorText = typeof wait?.error === "string" && wait.error.trim() ? wait.error.trim() : status;
  if (status === "timeout" || status === "pending") {
    return {
      handled: true,
      reply: {
        text:
          `Harness turn in \`${target}\` is still running after the wait window (run \`${runId}\`); the reply will appear in the harness session.`,
      },
    };
  }
  return { handled: true, reply: { text: `Harness turn failed in \`${target}\`: ${errorText}`, isError: true } };
}