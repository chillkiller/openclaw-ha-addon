/**
 * Ambient types for the plugin-sdk transcript-runtime export the 20 (claim-reply transcript mirror)
 * claim-reply mirror uses (the 20 design (claim-reply transcript mirror), v0.7.13.22). The host's
 * `./plugin-sdk/session-transcript-runtime` package export ships no "types"
 * entry (openclaw package.json:1228 — "default" only), so the strict check
 * would not resolve it; this declaration mirrors the shapes the host's
 * implementation actually consumes (session-transcript-runtime-DISkgwtr.mjs
 * appendAssistantMirrorMessageByIdentity; call-shape precedent: the Telegram
 * channel's mirrorTelegramAssistantReplyToTranscript,
 * bot-message-BSJK5l6G.mjs:2456).
 *
 * Deliberately narrow: only the 20 (claim-reply transcript mirror) append function is declared (the module
 * exports more — reader/catalog helpers — the plugin must not reach for
 * those unless it re-declares them too).
 */
declare module "openclaw/plugin-sdk/session-transcript-runtime" {
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

  export function appendAssistantMirrorMessageByIdentity(
    params: AssistantMirrorAppendParams,
  ): Promise<AssistantMirrorAppendResult>;
}