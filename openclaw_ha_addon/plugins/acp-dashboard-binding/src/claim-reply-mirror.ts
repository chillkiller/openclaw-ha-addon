/**
 * Claim-reply transcript mirror (the 20 design (claim-reply transcript mirror) — v0.7.13.22, 2026-10-13).
 *
 * Live-proven gap: the host delivers a claim's terminal reply to the UI
 * (`deliverBindingPayload(reply, "terminal", transcriptOwner)`,
 * dispatch-from-config-C7FQOe54.mjs:3397) but NO component on the plugin-bound
 * claim path ever writes it into the ORIGIN conversation transcript. The only
 * caller of `mirrorDeliveredReplyToTranscript` in the final path is the normal
 * agent-run finalization (dispatch-from-config:800/848);
 * `finishPluginBindingDispatch` (:3334) only bookkeeps the dispatch. Live-DB
 * proof: origin conversation 048d96d7… carries nothing but the session-start
 * event and the user message (seq=1) from `persistPluginBindingUserTurn`
 * (:2528) — the assistant reply the user watched stream in arrived via the
 * broadcast and vanished on re-render ("Flüchtigkeit" root). Upstream has the
 * same shape for Telegram — the channel that mirrors like a plugin — via
 * `mirrorTelegramAssistantReplyToTranscript` → `appendAssistantMirrorMessageByIdentity`
 * (bot-message-BSJK5l6G.mjs:2456): the plugin-visible primitive
 * `openclaw/plugin-sdk/session-transcript-runtime` exports exactly for
 * "persist a DELIVERED channel reply into the originating session transcript".
 *
 * So the plugin mirrors its own claim replies: after the terminal wait, for
 * every reply the claim hands back (real harness answers AND the status
 * notices — the user sees all of them in the origin conversation, so all of
 * them must survive a re-render). Dedupe/idempotence:
 * `acp-claim-final:<runId>` (unique per turn; the append's
 * deliveryMirror-lookup re-finds its own append on retries, and the host's
 * claim path has no competing writer — verified above, so no double record).
 * Best-effort by design: a failed mirror NEVER fails the claim/reply — it only
 * degrades re-render persistence to the pre-20 (claim-reply transcript mirror) behavior, and the append
 * returns ok:false with a reason (missing active session, session-rebound) we
 * log at debug.
 */

import type { HarnessReplyClaimLogger } from "./reply-claim.js";

/**
 * Structural mirror of the host's append params (see the Telegram channel's
 * call, bot-message-BSJK5l6G.mjs:2456). The live SDK export carries no types
 * (package.json: "types" key unset for ./plugin-sdk/session-transcript-runtime)
 * — the ambient declaration in src/host-transcript.d.ts mirrors this shape.
 */
export type AssistantMirrorAppendParams = {
  agentId?: string;
  config?: unknown;
  idempotencyKey?: string;
  deliveryMirror?: { kind: string; sourceMessageId?: string };
  sessionId?: string;
  sessionKey: string;
  storePath?: string;
  text: string;
};

export type AssistantMirrorAppendResult = {
  ok: boolean;
  reason?: string;
  code?: string;
  messageId?: string;
};

export type AssistantMirrorAppendFn = (
  params: AssistantMirrorAppendParams,
) => Promise<AssistantMirrorAppendResult>;

/** Minimal session-store read needed for the sessionId ownership guard. */
export type MirrorSessionLookup = {
  getSessionEntry: (params: {
    sessionKey: string;
    agentId?: string | null;
  }) => Record<string, unknown> | undefined;
};

export type ClaimReplyMirrorParams = {
  config: unknown;
  originSessionKey: string;
  claimRunId: string;
  replyText: string;
  agentId?: string | null;
  sessionStore?: MirrorSessionLookup | null;
  appendAssistantMirror?:
    | AssistantMirrorAppendFn
    | null;
  logger?: HarnessReplyClaimLogger;
};

/** The claim's terminal replies persist with this idempotency-key grammar. */
export const claimReplyMirrorIdempotencyKey = (claimRunId: string): string =>
  `acp-claim-final:${claimRunId}`;

/**
 * Mirrors a claim reply into the origin conversation transcript. Returns true
 * when the append reported ok (or was a dedupe hit), false when it skipped —
 * and NEVER throws: the mirror is strictly best-effort (20 (claim-reply transcript mirror) contract).
 */
export async function mirrorClaimReplyToOriginTranscript(
  params: ClaimReplyMirrorParams,
): Promise<boolean> {
  const log = params.logger ?? {};
  const text = params.replyText.trim();
  if (!text) return false;
  try {
    const append = params.appendAssistantMirror;
    if (typeof append !== "function") return false;
    const agentId = (params.agentId ?? "").trim() || undefined;
    const sessionIdEntry =
      params.agentId && params.sessionStore
        ? (params.sessionStore.getSessionEntry({
            sessionKey: params.originSessionKey,
            agentId: params.agentId,
          }) as { sessionId?: unknown } | undefined)
        : undefined;
    const sessionId =
      typeof sessionIdEntry?.sessionId === "string" && sessionIdEntry.sessionId.trim()
        ? sessionIdEntry.sessionId.trim()
        : undefined;
    if (!sessionId) {
      log.debug?.(
        `[acp-dashboard-binding] claim-reply mirror skipped: no active origin session for ${params.originSessionKey}`,
      );
      return false;
    }
    const idempotencyKey = claimReplyMirrorIdempotencyKey(params.claimRunId);
    const result = await append({
      agentId,
      config: params.config,
      idempotencyKey,
      deliveryMirror: { kind: "channel-final", sourceMessageId: idempotencyKey },
      sessionId,
      sessionKey: params.originSessionKey,
      text,
    });
    if (!result.ok && result.code !== "session-rebound") {
      log.debug?.(
        `[acp-dashboard-binding] claim-reply mirror skipped: ${result.reason ?? "unknown reason"}`,
      );
      return false;
    }
    log.debug?.(
      `[acp-dashboard-binding] claim-reply mirrored into origin transcript ${params.originSessionKey} (${idempotencyKey})`,
    );
    return true;
  } catch (error) {
    log.warn?.(
      `[acp-dashboard-binding] claim-reply mirror of ${params.originSessionKey} failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}