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

/**
 * Default max wait for the harness run (`subagent.waitForRun`). The wait does
 * NOT cancel the run — on timeout the turn keeps running in the target session.
 */
export const DEFAULT_HARNESS_REPLY_WAIT_MS = 120_000;
const MIN_HARNESS_REPLY_WAIT_MS = 1_000;
const MAX_HARNESS_REPLY_WAIT_MS = 15 * 60_000;

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
): { target: string; agentId: string } | null {
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
  const target = bridged?.targetSessionKey ?? deriveDashboardBindingRecord(ref, cfg)?.targetSessionKey ?? null;
  const trimmed = (target ?? "").trim();
  return trimmed && isAcpShapedSessionKey(trimmed) ? { target: trimmed, agentId } : null;
}

export function createHarnessReplyClaimHandler(options: HarnessReplyClaimOptions) {
  return async (
    event: InboundClaimEventLike,
    ctx: InboundClaimContextLike,
  ): Promise<InboundClaimResultLike> => {
    const log = options.logger ?? {};
    const cfg = options.getConfig?.();
    const binding = ctx.pluginBinding;
    try {
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
      const { target, agentId } = claimed;
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

      // Phase 2.21 barrier: when the target is the auto-provisioned per-agent
      // session, its initialization may still be in flight (the resolve hands
      // out the deterministic key fire-and-forget). Await it BEFORE starting
      // the turn — a not-yet-initialized key would dispatch into the host's
      // "stale" ACP error. Failure does not block the claim: the turn start in
      // the target surfaces the host's ACP init error (handled:true), so the
      // origin dispatch cannot process it twice.
      if (isHarnessProvisionedSessionKey(agentId, target)) {
        const provisioning = pendingDashboardHarnessProvisioning(agentId);
        if (provisioning) {
          const ok = await provisioning.catch(() => false);
          if (!ok) {
            log.warn?.(
              `[${CHANNEL_ID}] inbound_claim: auto-provisioning of ${target} failed; dispatching anyway (host ACP init error expected)`,
            );
          }
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
        return {
          handled: true,
          reply: {
            text:
              `Harness turn dispatched to \`${target}\` (run \`${runId}\`) but waiting for its reply failed: ${note} — the turn is still running there.`,
          },
        };
      }
      return harnessWaitReply(target, runId, settled.wait);
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