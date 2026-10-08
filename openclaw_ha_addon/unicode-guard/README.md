# unicode-guard — Context-sensitive invisible-unicode stripping

**OWASP LLM01:2026 Control #5** · Prompt-injection/smuggling defense on the OpenClaw gateway's external-content path · Add-on build patch since 2026-10-08 (spec: `agents/prompt-engineer/findings/2026-10-08-owasp-a-unicode-stripping-spec.md` · audit: `agents/coding-review/findings/2026-10-08-owasp-a-audit.md`)

## Threat model (why this exists)

Invisible Unicode characters carry instructions and exfiltration payloads across rendering boundaries: models read tag characters (U+E0000–U+E007F), isolated variation selectors (U+FE00–U+FE0F), zero-width spaces and word joiner — while humans and UIs see nothing. Documented attacks (Rehberger 2024/2025, M365 Copilot PoCs) exfiltrate data purely through rendering prepared content, e.g. via crafted page titles in search results. The affected surface here is the external-content ingest path: `web_fetch`/`web_search` outputs, Email/Webhook/Cron/Browser and channel metadata, rendered as tool results into prompts — in the gateway process **and** in the worker processes spawned by the gateway (audit F1: `dist/worker/worker.mjs` contains, among others, Email/Webhook hook session logic, `wrapExternalContent`, `buildSafeExternalPrompt`).

OpenClaw 2026.9.8 already stripped at `web_fetch` extraction — but with a naive character-class strip (`INVISIBLE_UNICODE_RE`) that (a) always removed U+200D (ZWJ), destroying valid emoji sequences like 👨👩👧, and (b) completely ignored isolated variation selectors U+FE00–U+FE0F (a smuggling gap). `web_search` results were not stripped at all. The naive copies exist **four times** in the dist tree: top-level module, gateway bundle, and independent copies in both large worker bundles (audit evidence).

## Selected mechanism

Add-on build patch (Dockerfile, heredoc pattern like the node-llama-cpp patch) against the OpenClaw dist; the patch replaces **every** naive copy and extends application to **every** external-content ingest boundary — gateway process and worker processes:

1. **Patch site A — `stripInvisibleUnicode`, ALL 4 copies:** the top-level module (`unicode-visibility-*.mjs`), inline in the gateway bundle **and** the minified independent copies in `dist/worker/worker.mjs` + `dist/worker/sqlite-store.worker.mjs` are replaced by the context-sensitive implementation from [`strip-invisible-unicode.mjs`](strip-invisible-unicode.mjs) (single source of truth; the patch splices the `//#region` byte-identically — including into the workers, which import no top-level modules). Effective at all call sites: `web_fetch` extraction (text/title), progress-card input, worker-side hook session/transcript projections.
2. **Patch site B — `sanitizeExternalContentText`, ALL 4 copies:** additionally calls `stripInvisibleUnicode()`. This function is the funnel for ALL wrapExternalContent/wrapWebContent consumers: `web_search` results (titles, snippets, site names, answer content, citations, error messages — every branch), `web_fetch` content/spill, Email/Webhook/Cron/Browser/Channel metadata including metadata fields (sender/subject/taskName) — in the gateway bundle as in the worker copies.

**Design decision (audit F1):** Option "actively patch the worker bundles" over a "known-exceptions list". Rationale: `worker.mjs` contains demonstrably reachable external-content boundary code (hook:gmail/webhook session logic, CRON_DIRECT_DELIVERY) — a documented gap would be a real gap; the inventory is finite (4+4 sites, name-verified); the minify-tolerant regex anchors capture arbitrary parameter names; the porting risk lands loudly, never silently.

**Universality sweep (audit F1, the verification axiom):** after patching, a recursive sweep runs over the **entire** dist tree (`.mjs`+`.js`, all subdirs). It fails the build **loudly** (exit 1 with a file list) if ANY naive remainder of either target survives — including shape-drifted copies no patch anchor recognizes anymore: strip-call markers (`.replace(INVISIBLE_UNICODE_RE,…)`), strip-definition-≠-impl counters, naive-sanitize form, and sanitize-definition-≠-patched-call counters. Coverage is a universal quantifier, not an existential one: a control never disappears silently.

`apply-unicode-guard-patch.mjs` is idempotent, asserts exact anchors (byte-exact with tab semantics for top-level; whitespace/parameter-tolerant for minified copies) and verifies every patched file with `node --check`. Gateway config (`openclaw.json`) is not required by this mechanism.

## Stripped ranges (always — no legitimate rendering-relevant context)

| Codepoints | Name | Rationale |
|---|---|---|
| U+200B | Zero width space | Classic smuggling carrier; invisible separator |
| U+200C | ZWNJ (zero width non-joiner) | Smuggling carrier — see tradeoffs below |
| U+200E, U+200F | LRM / RLM | Invisible direction controls |
| U+202A–U+202E | LRE/LRE/RLE/RLO/PDF | Bidi overrides — spoofing/exfiltration enablers |
| U+2066–U+2069 | LRI/RLI/FSI/PDI | Isolate direction controls |
| U+FE00–U+FE0F (isolated) | Variation selectors | Documented smuggling channel (Rehberger) |
| U+E0000–U+E007F | Tags | Model-readable rendering instructions (title/cowbell attacks) |
| U+2060 | Word joiner | Invisible separator/stego carrier |
| U+FEFF | Zero width no-break space / BOM-in-text | Invisible separator; signature carrier |

Context-sensitive exceptions: VS16 directly after an emoji base (❤️, 🗑️), keycaps (1️⃣), and ZWJ sequences (👨‍👩‍👧, ❤️‍🔥, 👨🏻‍⚕️) survive. ZWNJ keeps legitimate orthography in languages that require it (Persian, Kurdish) and is therefore stripped **only** in isolated form; see tradeoffs.

## Tradeoffs (documented, deliberate)

- **Subdivision flags (tags + keycap/tag combos)** are intentionally destroyed: a rendering channel into model contexts is more valuable than emoji detail.
- **ZWNJ orthography** (Persian/Kurdish): kept when a ZWJ/letter context marks legitimate use, otherwise stripped — conservative default with a documented false-positive surface.
- **CJK SVG variation** (VS15/VS16 preferences): kept in emoji contexts, stripped in isolation.

## Tests (15 vectors)

8 spec vectors plus edge cases and dist verification against the patched modules, including real `web_fetch` extraction and worker-splice byte identity. Vector 7 documents the performance delta: clean input 56 KB ≈ 3 µs/call, polluted 59 KB ≈ 1.6–6 ms/call (worst case: pathological repetition). Run with the project's test runner against `strip-invisible-unicode.test.mjs`.

## Upstream path

Reported upstream as a candidate native fix (context-sensitive strip + search-result coverage + worker bundles). When OpenClaw ships a native fix with equal or better coverage, the sweep deliberately fails its build as the decision trigger to remove this patch block.