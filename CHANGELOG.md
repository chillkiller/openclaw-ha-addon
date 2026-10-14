## 0.7.13.28 (2026-10-14) — Rollback auf den v0.7.13.25-Codebestand (Stabilitäts-Entschärfung)

- **Rollback (GaRoN 2026-10-14, GO „rollback"):** der Add-on-Codebestand ist exakt auf `v0.7.13.25` zurückgesetzt — den letzten Stand VOR dem .26/.27-Änderungsfenster. Begründung: seit 0.7.13.26 beobachtete Login-/Ingress- und Add-on-Stabilitätsregressionen.
- **Entfernt gegenüber 0.7.13.27:** `harness-config-writer` Multi-Model-γ (537 Z. Writer + Model-Catalog), `acp-dashboard-binding` V39-Clone-Guard + deferred γ re-archive + reply-claim/session-settle-Deltas, `run.sh` Claude-Model-Ladder (26 Z.), `oc_acpx_helper.py` claude-Ladder.
- **Nicht enthalten:** der Slow-Boot-Fix (Kaltstart ~120–150 s vs. 120 s Supervisor-Start-Timeout) — separat verfolgt; dieses Release ist ein isolierter Code-Rollback (kein Verhaltens-Mix).
- **Reproduzierbarkeit:** Code-Dateien per `git restore --source=v0.7.13.25` gesetzt; einzige Abweichung zu `.25` ist der Versions-Bump auf `0.7.13.28`.

## 0.7.13.25 (2026-10-13) — γ: Weg-B native dispatch + gateway lifecycle (latch, oc-gateway, ttyd supervision, boot gate)

- **Fixed (γ-v2, clone invisibility):** the archive-when-idle fix — idle harness clone nodes vanish from the user-visible surface without dispatch-path toxicity. Codex delta-audit **GO**.
- **Added (Weg-B, non-mirror dispatch):** plugin option `plugins.entries['acp-dashboard-binding'].config.dispatchMode: "claim" | "native"` (default `claim` = unchanged behavior). In `native` all binding records are emitted **generic** (ownership metadata stripped, informative fields intact) — the host's own dispatch gate then routes the webchat conversation **natively into the target ACP session**: no clone, no mirror, no claim; `/reset` is driven by the harness itself. Rollback = config flip. Docs: BRIDGE.md §21 (forensic anchors, design + rollback contract, four-stage verification incl. **deep host-parity 7/7 against the real dist**: real `registerSessionBindingAdapter`, real route-facts, real `resolveBoundAcpDispatchSessionKey`).
- **Added (gateway lifecycle):** maintenance latch (`/config/.openclaw/.gateway-maintenance`) — the gateway can now be taken down and held down intentionally (no respawn, no auto-doctor, survives addon restarts) so `openclaw doctor` / repairs finally have their conformant dead window. `oc-gateway` helper (installed to `/usr/local/bin` on boot): status/health/stop/resume/restart/update; `stop` touches the latch and calls `openclaw gateway stop --force` with pkill fallback + port-free wait; `restart` uses the Supervisor API. Because nginx + the terminal stay up, the HA watchdog (which can only see nginx) stays green during an intentional stop — no container bounce, no lost window.
- **Added (ttyd runtime supervisor):** the web terminal is loopback-only and invisible to the HA watchdog; if ttyd dies it is revived locally within ≤30 s (one-line respawn) instead of staying terminal-less until the next full addon restart.
- **Added (terminal-first boot gate):** the gateway start waits (bounded 30 s, 5 s steps) until the terminal actually listens before starting — the boot already started ttyd first, but nothing enforced it. Deliberately NOT a hostage gate: on permanent failure it warns loudly and continues, because a hard hold would take down the gateway (and the in-gateway agent with it) — leaving no repair-capable surface at all.
- Watchdog labor division (verified against the live supervisor source): HA watches the container surface (nginx, tcp://49200), run.sh watches the gateway (retrack/backoff/doctor-gate/latch), the reviver watches ttyd. A future `http://…/healthz` watchdog upgrade is possible (supervisor evaluates status < 300) but needs a latch grace first — backlog item.
- Tests: vitest binding 214/214 (incl. new Weg-B mode/record/gate suites), strict tsc 0, esbuild clean. Merge stack: `abddcd8` (γ-v2) + `feature/weg-b-native-dispatch` (`a705d0f`, `f5d606f`) + `feature/terminal-gateway-lifecycle` (`c19255e`, `9bd6b19`, `55e17e1`).

## 0.7.13.24 (2026-10-13) — boot sweep dispatched for real: api.on(gateway_start)

- **Fixed (live-boot evidence, v0.7.13.23 follow-up):** the .23 boot proved the §19c boot sweep registration inert — LIVE log: `hook event "gateway_start" is dispatched by the typed hook runner only; api.registerHook registrations for it are not invoked.` The registry-named `registerHook` call was contract-legal but never dispatched, so the stuck-session sweep (the §19 root of the Denken-Bug) would have run zero times. The sweep now registers via `api.on("gateway_start", …)` — the typed hook runner surface the claim hook already uses (dist-verified: `api.on` lands in `registerTypedHook`; `server-startup-post-attach` fires `runGatewayStart` from typed hooks). A reduced-registration api without `api.on` warns and skips (mirrors the claim hook guard).
- **Delta audit (acpx-codex, mandatory call-site inventory):** registerHook 2 remaining sites (projection forward + bridge inbound, both verbatim-named), `api.on` 3 sites (boot sweep NEW, inbound_claim, guard path) — **GO**. Report: `agents/coding-review/findings/2026-10-13-sweep-apion-delta-audit.md`.
- Verification: sandbox boot repro against compiled v0.7.13.22 sources (`before-throws=PASS`), fixed bundle (`after-inbound-named+typed-sweep=PASS`, `unhandled-empty=PASS`), tsc 0, vitest 8 files 195 passed.

## 0.7.13.23 (2026-10-13) — register-crash repair: full hook-name contract coverage

- **Fixed (post-deploy crash, v0.7.13.22 root):** every `api.registerHook` in the OpenClaw 2026.10.2 registry requires a non-empty `opts.name` (`registry-854ZO8XT.mjs:2937` — the plugin-api wrapper forwards opts verbatim, `:781`). Three violations shipped; the new boot-sweep one crashed every boot with `hook registration missing name` (sync throw inside `registerFull`, live-container log 00:40/00:41, watchdog Exit-137 restarts). The boot-sweep hook is now named `acp-dashboard-binding:boot-sweep`, the bridge inbound hook `acp-dashboard-binding:inbound`.
- **Fixed (silent, since the trust deploy):** the `dashboardBridgeApi` projection dropped the third hook-opts argument at the host boundary — bridge hook names never reached the host even when the bridge passed them. The projection now forwards `opts` verbatim.
- **Guard (the gap that let this ship green):** all pre-existing `registerHook` test mocks were silent. New `src/hook-contract.test.ts` runs `registerFull` against the verbatim host contract (throws on nameless registration — proven via a negative witness) and adds a static call-site tripwire: every `registerHook` call must pass non-undefined hook opts. A `vitest.config.ts` aliases the pinned gateway dist into the suite; the channel SDK module now loads for real in tests.
- **Verification beyond the suite:** a sandbox boot repro executes `registerFull` of both the deployed .22 bundle and the fixed bundle against the extracted real dist registry closure — .22 throws the live crash, the fixed bundle registers both hooks named with zero unhandled rejections (`agents/coding-review/findings/2026-10-13-register-crash-forensics.md` §9.2b/§10).
- Audited (acpx-codex re-audit with mandatory call-site inventory criterion: 3 `registerHook` sites + 1 `api.on` in the binding plugin, harness-config-writer has none; no regressions) — **GO**. Report: `agents/coding-review/findings/2026-10-13-register-fix-reaudit.md`.
- Note: the interim .23/.24 hotfix releases were rolled back after a premature double-fix chain (first fix addressed 1 of 3 call sites; the forensic report §6 documents the correction). This version re-lands the completed fix with the full verification chain.

## 0.7.13.22 (2026-10-13) — claim-path settle + reply persistence + hidden harness sub-session + thinking passthrough

- **Fixed (§19a, Denken-Bug root):** claimed ACP turns never settled the ORIGIN conversation node — it stayed `status:"running"` long after a clean claim turn (live-DB proof 99d8daf5; the boot recovery mark was only the consequence, the missing settlement the root). The plugin now writes the host-parity settle after every claim return with honest outcome mapping (ok→done / error→failed / timeout→timeout / pending→interrupted + abortedLastRun per host mark_interrupted parity) and clears the full 17-field host restart-recovery claim field set when the marked delivery run is our claim run. Wait-failure edge settled too.
- **Fixed (§20, "flüchtige Antworten" root):** the host transcribes a claim's terminal reply into the origin conversation only for agent-run finals — the plugin-bound claim path delivered the reply but never persisted it (live-DB proof: origin carried only session-start + user message, no assistant record), so re-renders lost every answer. The plugin now mirrors every delivered claim reply (answers + notices) into the origin transcript via the official `plugin-sdk/session-transcript-runtime` append (`appendAssistantMirrorMessageByIdentity`, host precedent: the Telegram channel) with `acp-claim-final:<runId>` idempotency; best-effort, never degrades the reply.
- **Fixed (§19b/§19c):** lost §17 terminal-write races at the direct acp_dispatch path no longer leave stuck `running` clone nodes forever (clone settle after terminal claim wait) + boot sweep at gateway_start settles orphaned `running` nodes of our key grammars (dashboard:*/acp:binding:* on roster harness agents) instead of feeding the host's restart-recovery debt.
- **Added (V39, "versteckte Sub-Session"):** harness clone sessions get a `spawnedBy` provenance stamp → ControlUI lists (excludeSubagents) no longer show them as separate sidebar entries. Idempotent, foreign provenance preserved, category entries untouched.
- **Added (d1):** `runtime.acp.thinking` passthrough on harness agents → ensure-spec → host runtimeOptions, reconciled into live ACP sessions (level must be in the backend choice list).
- **Added (V36.2):** add-on option `utility_model` → `agents.defaults.utilityModel` (model behind internal gateway utility callouts, incl. the session observer) — root fix for "session observer returned invalid JSON twice" events. Unset = no write (operator owns the value).
- Tests: vitest binding 192 passed + 1 skipped, strict tsc 0, helper 43/43. Audited by the acpx-codex harness (persistent session `agent:codex:acp:ac2ffbc2-…`): claim-settle package + V36.2 **GO** (after a first-audit NO-GO with 2 must-fixes, both committed), §20 mirror delta-audit **GO** (param-shape parity with the Telegram channel precedent re-verified against dist; live-DB root-cause re-confirmed). Report: `agents/coding-review/findings/2026-10-12-v0.7.13.22-claim-settle-audit.md`.

## 0.7.13.21 (2026-10-12) — activation fix + protection chain + OpenClaw 2026.10.2 pin bump

- **OpenClaw 2026.10.2:** pin bumped from 2026.9.9 (dist-verified 2026-10-12). Startup gate `shouldConsiderForGatewayStartup` unchanged (`manifest.activation.onStartup === true` criterion, line 649); `activation:{"onStartup":true}` added to the bundled dashboard-binding manifest so the host considers it for gateway startup. Manifest-loader path policy still allows `dist/extensions` and `/config` while rejecting `/share` network-share paths. Plugin SDK symbols unchanged; openai-http `agentId` forwarding fix verified (`dist/openai-http-BBp46gf8.mjs:353-375`); unicode guard intact; thread-bindings `supportsAutomaticThreadBindingSpawn` removed (not our path).
- **Fixed (bundled-channel activation):** `openclaw_ha_addon/plugins/acp-dashboard-binding/openclaw.plugin.json` adds `activation:{"onStartup":true}` (Audit 1 GO).
- **Fixed (protection chain / master switch):** `oc_acpx_helper.py` treats `acp_dashboard_binding_enabled` unset or true as ON (default core surface) and explicit false as a real opt-out. When OFF, the helper flips `plugins.entries['acp-dashboard-binding'].enabled=false` and strips the `channels['acp-dashboard-binding']` config block, preventing a boot refusal from an undeclared channel key. The never-flip invariant is superseded only for this plugin when the HA option is ON; the harness-config-writer keeps its opt-out protection (Audit 2 GO).
- **Configuration:** `acp_dashboard_binding_enabled` default changed from `false` to `true` so the binding is ON out of the box. The switch lives only in the Home Assistant add-on configuration menu; no new UI surface is added to the dashboard or Control UI.

## 0.7.13.20 (2026-10-12) — bundled-channel entry contract fix: restore gateway plugin loading (binding regression since .18)

- **Fixed (Punkt 1b, BRIDGE §18):** since the v0.7.13.18 bundled-root deploy the dashboard binding has been dead in the gateway — the host classifies a plugin at `dist/extensions/` with a `channel` manifest as a bundled channel and loads its entry through the bundled-channel contract (`resolveBundledChannelModuleEntry`: `kind === "bundled-channel-entry"` + `register` + `loadChannelPlugin`). Our `defineChannelPluginEntry` export has neither → live WARN `missing bundled-channel-entry contract; skipping` → `bundledChannelArtifactLoaders.plugin` = undefined → the plugin was never instantiated (boot `loadedPluginCount=14`, no `channels.acp-dashboard-binding.*` steps) → no adapter/claim hook/bridge → every dispatch consult null → embedded dispatch everywhere. Proven three ways with host code, incl. `getBundledChannelPlugin('acp-dashboard-binding')` → undefined while telegram loads.
- **Fix:** the default export is now a `defineBundledChannelCompatibleEntry` record (`src/entry.ts`): contract-conformant (`kind`, `loadChannelPlugin`) with the `register()` mode-branches mirrored 1:1 from both dist helpers, `channelPlugin`/`registerFull` compat surface retained for the legacy external path; `registerFull` body unchanged.
- **Smoke-check 6b extended:** `acp_smoke_check.sh` now also greps the contract-skip WARN — the old "failed to load bundled channel" pattern was blind to this exact failure (why the 18:01 boot reported ALL GREEN with binding already dead).
- Tests: vitest binding 171+1skip (new `entry.test.ts` replicates the host contract gate as a regression witness: legacy shape MUST fail, shim shape MUST pass, register branch semantics); strict tsc 0; E2E in-process with the esbuild bundle: contract passes, both adapter scopes register, full `resolveDispatchConversationBinding` binds main + old lane + the user's new "+"-session. Audited by the acpx-codex harness via the explicit `/acp spawn` chain (session `agent:codex:acp:fc99d140-dd1c-4b89-bbc7-8f1cd92a8e21`): **VERDICT GO** (non-blocking: unused `setChannelRuntime` omitted — lossless). Report: `agents/coding-review/findings/2026-10-12-bundled-channel-entry-contract-audit.md`.
- Deploy note: needs the add-on image rebuild; boot proof = contract WARN gone, `loadedPluginCount=15`, `channels.acp-dashboard-binding.*` present, next main turn logs `plugin-bound inbound routed`.

## 0.7.13.19 (2026-10-12) — binding claim fix: post-settle yield closes the terminal-write owner race

- **Fixed (Punkt 1, BACKLOG V34, BRIDGE §17):** claimed binding turns completed the host dispatch lifecycle but the run-terminal `session-entry.patch` threw `Terminal write owner changed before commit` (`assertCurrent`, dist `agent-run-terminal-writes-CZ5u4nvB.mjs:39`) — mirror/delivery writes rebind the write owner between capture and commit in the same completion tick. The failed terminal commit leaves `session_nodes` rows stuck `status:"running"` with a dangling `lifecycleRunId` despite `observerDigest: "Run completed"` (3/3 deterministic on claimed turns; healthy counter-example: main-clone session without the claim-mirror path). The plugin now yields 500 ms (option `postSettleYieldMs`, clamp 0..10000) after a terminal `waitForRun` result (ok/error-terminal) before returning the claim reply; timeout/pending/wait-failure paths skip the yield.
- **Corrected finding (no code change):** `harnessReplyWaitMs` IS wired — live config getter (`index.ts:189`), read path + clamp 1000..900000 (default 120000) verified; the live config simply had no key set. Earlier "not wired" note retracted.
- **New artifact:** strict tsc config for the binding plugin (`tsconfig.check.json`, source-only — vitest types not vendored, tests run via vitest).
- Tests: vitest binding file 28/28 (was 23), suite 166 passed + 1 skipped; strict tsc 0 errors; writer baseline unchanged. Audited by the acpx-codex harness via the explicit `/acp spawn` chain (session `agent:codex:acp:3115ba34-5018-4e04-ac27-5a5720db3de9`, harness config verified applied): **VERDICT GO**; INFO (timing-test CI flakiness) applied — tolerance windows 60→100 ms, re-run 28/28 green. Report: `agents/coding-review/findings/2026-10-12-punkt1-terminal-write-race-audit.md`.
- Evidence kernel for upstream #149801/#163078 documented in BRIDGE §17.4 (run-TERMINAL seam as supplement to their reply-DISPATCH seam). Live smoke outstanding: next claimed turn must show the terminal-patch error gone (acp_smoke_check guards stuck nodes).

## 0.7.13.18 (2026-10-11) — bundled-root trust deploy + startup trace + restart smoke check

- **Fixed (restart Kammerjäger):** path-deployed plugins ran UNTRUSTED — the gateway grants runtime keyed stores only to `origin: "bundled"` plugins, so the binding plugin's persisted bridge store threw `PluginTrustRefusalError` on every restart boot ("persisted bridge state unavailable; memory-only rows"). The helper now compiles both plugins (esbuild, externals `openclaw`/`openclaw/*`/`@openclaw/*`) into the gateway's own `dist/extensions` root (origin "bundled" = full trusted runtime) and removes the stale external copies (both candidates of an id → the config candidate wins and would shadow the trusted one).
- **Fail-soft:** no bundled root / no esbuild / failed compile → exact legacy external deploy (unchanged v0.7.13.17 semantics, WARN logged). Registration semantics (B3 opt-out invariant, `plugins.allow` union, atomic writes) unchanged — extracted into one shared path used by both deploy roots.
- **Bridge diagnosing:** the "persisted bridge state unavailable" WARN now carries the underlying cause text in the message (the gateway log serializes messages only, not error objects).
- **New diagnostic option `gateway_startup_trace`:** exports `OPENCLAW_GATEWAY_STARTUP_TRACE` — per-phase/per-plugin boot breakdown lines; instrumentation for the observed 64s `plugins.runtime-post-bind` block (proof lands with the next restart log).
- **New read-only post-restart smoke check (`acp_smoke_check.sh`):** gateway alive, bundled payload valid (index.mjs + `openclaw.extensions` package.json), stale-external shadowing absent, ACP session roster, stuck session nodes, boot-error extraction, harness env wiring — no writes, safe anytime.
- Tests: python 35/35 (new `BundledRootDeployTest` incl. real-esbuild integration probe) · vitest writer 34/34 · vitest binding 161+1. Audited by the acpx-codex harness (`kimi-k2.7-code:cloud`, acp-config verified applied): **GO**.

## 0.7.13.17 (2026-10-11) — repo-split: standalone harness-config-writer + backup-rewrite + add-on harness defaults

- **Two runtime plugins instead of one (Repo-Split A2, owner GO):** `harness-config-writer` is now a standalone feature plugin (own config surface `config.harnesses`, no channel code) — the writer and the dashboard/webchat binding channel plugin fail independently. Both are baked into the add-on image and deployed/registered per option.
- **Add-on-level harness defaults (request GaRoN):** new options `harness_base_url` (activator — empty = nothing generated), `harness_model` (shared), `harness_api_key` (shared), `harness_excluded_agents` (comma-separated). Operator hand-entries in `openclaw.json` always win; stale generated entries are cleaned up only when untouched. codex/opencode keep their `ollama_acp_*_model` defaults unless `harness_model` is set.
- **Backup-rewrite (request GaRoN):** first writer-enabled boot snapshots the pre-writer state of every managed harness config file; turning the option OFF restores the originals automatically and consumes the snapshot; re-enable snapshots fresh. Quarantined manifests veto re-snapshots.
- **Fixed (audit):** legacy `harnesses` migration never flips an operator `enabled:false` opt-out; the writer honors an ENV gate so an off-restore survives gateway boots; corrected v0.7.13.16's over-stated "22-harness catalog" claim (18 acpx adapters installed, 9 writer-configurable with docs-verified env/file surfaces; OAuth/non-verified/identity harnesses deliberately excluded).
- Tests: python 30/30 · vitest writer 34/34 · vitest binding 161+1 · strict tsc clean. Audited by the ACP-Codex coding-review harness (GO after one fix round).

# Changelog — OpenClaw Assistant (Home Assistant App)

Release-facing summary. Detailed per-release engineering notes: [openclaw_ha_addon/CHANGELOG.md](openclaw_ha_addon/CHANGELOG.md).

## 0.7.13.16 (2026-10-11) — generalized harness config (all acpx harnesses)

- **The plugin now configures ALL acpx harnesses** — not just the three flagship ones. A new writer module (`src/harness-config-writer.ts`) generates the per-harness provider config from a normalized plugin config (`plugins.entries['acp-dashboard-binding'].config.harnesses.<id>`: model, baseUrl?, apiKey?, thinking?, smallModel?, trustProjects?).
- **Three config mechanisms cover the full 22-harness catalog:** FILE (codex: `auth.json` + `/config/.codex/config.toml`; opencode: `opencode.jsonc`), ENV (claude ANTHROPIC_*, gemini, droid, qwen, kimi, kiro, iflow — env names web-verified), NONE (copilot/cursor — CLI-OAuth-owned, plugin writes nothing).
- **Additive guarantee:** absent `harnesses.<id>` entry ⇒ the plugin writes NOTHING for that harness and the bundled acpx default (vendor auth/config) runs unchanged — native subscriptions (Claude Pro, ChatGPT Plus, Copilot) stay intact.
- **Provider-agnostic:** baseUrl + apiKey + model is OpenAI-compatible — Ollama, vLLM, LocalAI, llama.cpp all work; no template-token files anymore.
- **Python helper retired:** `deploy_harness_configs`/`prepare_opencode_home` are no-ops (log marker); `deploy_plugin`/`install_acpx_npm_project` remain (add-on bootstrapping).
- **Thinking exposed:** `thinking` config field sets codex `model_reasoning_effort` when present.
- Tests: 186 vitest (5 files) + tsc strict + python helper tests 5/5.

## 0.7.13.15 (2026-10-11) — main-klon completion + bindMainSessions flag

- **Fixed — bindMainSessions flag enforced:** the phase-2.24b gate `isMainConversationEligible` ignored the `bindMainSessions` config flag (default TRUE worked, but explicit `false` had no effect) — the claude child run shipped the gate without the flag check. Now enforced **before** the shape match: flag-off ⇒ no main-klon binding, the agent keeps builtin dispatch.
- **MAIN-klon binding completed:** `agent:<harnessId>:main` (exact 3-part shape) of roster harness agents now binds to its own clone key (`agent:<id>:acp:binding:webchat:default:sha16("webchat:default:agent:<id>:main")`), with `bindMainSessions` (default TRUE) declared in the manifest configSchema per the reload-deadlock rule.
- Orchestrator test-session work (main-klon gate, manifest, binding-adapter routes, tests) landed: 162/162 vitest, tsc strict clean.

## 0.7.13.14 (2026-10-11) — session-key clone mode

- **Per-conversation ACP sessions (owner design, GaRoN 04:16 + GO 05:09):** every dashboard conversation gets its OWN persistent ACP session — the ACP key is a deterministic clone of the origin session key's conversation identity. New UI session ⇒ new ACP session (persistent until host retention); existing session ⇒ existing key. One acp-binding window per conversation, trivially debuggable.
- **Provisioned leg now answers the origin conversation directly** (the former synthetic grammar, now initialized by the ensure contract on exactly that key) — the `ACP_SESSION_INIT_FAILED` class from synthetic keys dies structurally.
- **Cwd flows only into the ensure spec** (spawn process), never into key identity — the origin-workspace reader stays as the cwd source; the phase-2.23 `:ws:` reverse-parse is gone entirely.
- Legacy helpers stay exported with `@deprecated` jsdoc; the binding gate (main/acp-class never bind) and `harnessSessions` overrides are untouched.
- Tests: 152/152 vitest, strict TypeScript clean.

## 0.7.13.13 (2026-10-11) — ensure/resolve key harmonization

- **Fixed — per-cwd binding keys now get real sessions:** the provisioner discarded the cascade's target-session key and passed a legacy `harness:<agent>` conversation id to the host ensure contract, so `acp_sessions` rows landed on the legacy per-agent key while resolves answered the cwd-scoped key — dashboard-bound turns perished with `ACP_SESSION_INIT_FAILED (metadata missing)`. The provisioner now carries the target key; the scoped conversation id (`harness:<agent>:ws:<hash>`) goes into the ensure spec, making ensure-key ≡ resolve-key bit-for-bit.
- Tests: 149/149 vitest, strict TypeScript clean, in-process E2E against the live copies.

## 0.7.13.12 (2026-10-11) — origin-workspace cwd derivation

- **Dashboard-bound harness sessions now inherit the origin session's working directory:** a new read-only `node:sqlite` reader derives the cwd from the origin dashboard conversation (`session_nodes.entry_json.sessionRoot` → `projects.repo_root` fallback). Sessions are spawned with `cwd = <repo>` instead of a fixed workspace, so harness agents (claude/codex/opencode) work inside the project folder they were opened from.
- **Per-cwd deterministic session keys:** `harness:<agent>:ws:<sha16(cwd)[0..12]>` — one persistent ACP session per agent × workspace, no close/reopen thrash on cwd change.
- **Config surface (all plugin-config):** `workspaces` (explicit cwd map by conversation id or project id), `deriveOriginWorkspace` (default on), `harnessReplyWaitMs` — declared in the plugin manifest `configSchema` (reload-deadlock-safe).
- **Binding eligibility gate:** only real dashboard-class conversations (`agent:<id>:dashboard:<uuid>`) bind to harness sessions; `agent:<id>:main`, `acp`-class and unknown keys keep their builtin dispatch (owner design rule). Explicit `harnessSessions` overrides still win.
- Tests: 149/149 vitest, strict TypeScript clean.

## 0.7.13.4 (2026-10-09) — audit hotfix: injection & data-loss hardening

- **Security — verified root command-execution via `gateway_remote_url` removed:** the remote-URL parser was `eval`'d shell code; shell metacharacters inside the user-controlled URL executed as root at boot. Replaced with plain-data hand-off (no `eval`), plus character-validated hostnames.
- **Security — repo-committed gateway token eliminated:** the ACPX helper bootstrapped a missing `openclaw.json` with the literal `PLACEHOLDER_ONBOARDING_TOKEN`, which the nginx proxy then injected as bearer auth pre-onboarding. The duplicate helper bootstrap was removed entirely (run.sh is the single bootstrap owner) and run.sh generates a random per-install token (existing behavior change: the pre-onboard token is no longer publicly known; onboarding still overwrites it).
- **Data loss — corrupt `openclaw.json` is quarantined, never overwritten:** parse failures previously fell back to an empty config, so a later write-back could replace the entire configuration with a minimal gateway stub. Corrupt configs are quarantined as `openclaw.json.corrupt` (timestamped when one already exists — the recovery copy is never clobbered), a boot with only a quarantined copy present fails closed instead of writing a fresh stub, and unreadable-file (`EIO`/`EACCES`) errors exit 1 WITHOUT renaming the possibly-good config. All JSON writes in helpers and the first-boot bootstrap are atomic now.
- **Fixed — watchdog restart loop in tailnet modes:** the plain-HTTP healthcheck always failed against the HTTPS-terminating gateway (`tailnet_serve`/`tailnet_funnel`); the probe now honors `gateway.tls.enabled`.
- **Fixed — `gateway_env_vars` may no longer override app-validated runtime variables** (`TERMINAL_PORT`, `GATEWAY_INTERNAL_PORT`, `HTTPS_PROXY_PORT`, `CERTS_DIR`, `ACCESS_MODE`, `INGRESS_PORT`, `TAILSCALE_MODE`, `GATEWAY_ADDITIONAL_ALLOWED_ORIGINS`, `MDNS_MODE`, …), closing an nginx/`node` config-injection bypass of the documented validation guard; `render_nginx.py` re-validates all ports (`GATEWAY_INTERNAL_PORT` mandatory, ASCII digits 1-65535 only — `isdigit()` also accepted Unicode digits), `CERTS_DIR` and the token charset as defense in depth.
- **Fixed — helper failures exit honestly (no more exit-0 crash-loops), stale ControlUI origins pruned deterministically, boot-killing cert pipeline falls back to base SANs and no longer fakes success after a failed generation**, plus minor boot fixes (`GW_IS_CHILD`, stale `GW_PID` on failed restarts no longer logs bogus "exit code 127", startup-lock fd leak, `umask` leak, `NODE_PATH` colon, ingress-port check, Docs-page network mode, `oc-cleanup` EOF handling, timezone fallback = option default). The ACPX helper now propagates real failures (npm install / config patch) in its exit code, so the run.sh error line "ACPX harness initialization failed" is actually reachable.
- **Docs:** `SECURITY.md` rewritten for the `network_mode` presets with a supported-versions section; `DEPLOYMENT.md` documents the RAM-adaptive heap; `Dockerfile` version label synced. The corrupt-copy boot guard points to host-level repair (Samba share `addon_configs` / SSH), since the app terminal is intentionally not started in that fail-closed state.
- **Fixed — follow-up audit (second review pass over the branch):** failed TLS regeneration no longer claims the new IP/SANs for a stale old certificate (previous cert + markers removed before generation); the ACPX helper re-installs when `node_modules` is missing even if `package.json` matches (a failed first install stayed broken forever); the last overridable runtime variables (`ENABLE_OPENAI_API`, `BLOCKED_HOSTNAMES`, `AUTO_CONFIGURE_MCP`, `TRACE_LOG_TO_CONSOLE`, `GATEWAY_LOG_TO_CONSOLE`) reserved; bootstrap falls back to the default port on a non-numeric value; the landing page uses the validated internal gateway port.
- **Hygiene:** an invisible BEL control character (U+0007) inside the ACPX helper's docstring was removed — the same invisible-Unicode class the add-on guards against upstream.

## 0.7.13.3
- **Hotfix (boot unbound-variable):** the 0.7.13.2 ACP ambient-env routing read `$ANTHROPIC_API_KEY` guarded only by `[ -z ... ]` — under `set -u` this is an unbound-variable kill whenever the key is not preset in the container environment (the default case: no real Anthropic key configured). Every start died at run.sh line 81 before nginx/gateway existed (watchdog restart loop 2026-10-09 21:34-21:45 after the 21:34 store rollout; supervisor actions ~8 cycles). Reads now use the POSIX-safe `${ANTHROPIC_API_KEY:-}` default-expansion form (unset/empty -> Ollama routing as intended, a set/non-empty key wins). Empirical proof: `bash -u` negative control (old form on unset var -> rc 127, byte-identical error line), fixed form 3/3 probes green (unset -> fallback, set -> keep-real, empty -> fallback); `bash -n` OK; repo-wide set -u sweep found no other unguarded conditional reads. Also repairs the 0.7.13.2 docs slips: the [0.7.13.2] changelog section was sorted between 0.7.10.21 and the 0.7.9.x wall (now ordered correctly at the top) and the 0.7.13.2 DEPLOYMENT matrix row was missing (added).

## 0.7.13.8
- **Fix (operator opt-out respected):** the ACPX helper re-registered `plugins.entries["acp-dashboard-binding"].enabled=true` on EVERY boot, silently overriding an operator who had disabled the plugin between restarts (proven 2026-10-10 ~08:42: a set `false` was flipped to `true` by the next boot, log line "Registered plugins.entries...enabled=true"). The register step now treats an explicit `enabled:false` as an immovable opt-out: the flag is never flipped back and the `plugins.load.paths` registration is skipped while disabled (plugin payload stays deployed, so re-enabling needs no rebuild). ACP/harnesses are unaffected — this is the single-plugin switch GaRoN asked for.

## 0.7.13.2
- **ACP harness modernization (B9):** removed all custom ACP wrappers — acpx passthrough wrappers + ambient env routing instead. Claude Code, Codex and OpenCode reach the local Ollama backend with zero wrapper files; role-differentiated model defaults (audit: `kimi-k2.7-code:cloud`, forge: `glm-5.3-flash:cloud`), env-overridable. New config templates deploy to the acpx inheritance source (fixes recurring codex config clobber). Proven by 4 live audit runs through the real gateway.

## 0.7.13.1
- **Hotfix (boot exit 3):** the two new safety-net option reads in `run.sh` used `|number`, which is not a jq builtin - jq failed compilation whenever `options.json` contained the key ("number/0 is not defined", exit 3), and `set -euo pipefail` killed every start before the gateway came up (restart loop 2026-10-09 05:26-05:31, container ExitCode=3). Reads now use `tonumber` with an explicit `!= null` guard (missing key/null -> default 3, string "5" -> 5, explicit 0 -> 0). Verified in the 0.7.13 image (jq 1.6): negative control (old program -> rc 3 on the real options.json) plus 6/6 positive probes; `bash -n` OK; no other `|number` in the tree.

## 0.7.13
- **OpenClaw 2026.9.9:** pin bumped from 2026.9.8 (delta analysis, dist-verified 2026-10-09). Zero blockers: exit-classifier and memory-threshold calibration token-/byte-identical to 2026.9.8, no schema retirements, no allowedOrigins/device-auth/CSP/health-endpoint changes, no Node engine bump. Upstream gains: failed-update recovery hardening, restart-recovery triage with retry (#160173), Docker upgrade-loop fix reusing verified rollback backups (#162305), doctor session-archive repairs (#164867), quarantined-DB respect (#161783), memory-checkpoint timeout fix. Both security patches re-verified against the 2026.9.9 dist: unicode-guard applies 8/8 anchors with 0 universality-sweep residues (9160 files); undefined-rejection shim registry present (upstream still ships no equivalent).
- **Safety net — pre-upgrade state backups (TechArtDev 0.5.94 parity):** before the first boot of a changed OpenClaw version, the app archives `openclaw.json` + `state/` + `agents/` (WAL-aware, generated bulk excluded) to `/config/.openclaw/upgrade-backups/` and refuses to start into the new version if archiving fails (`abort_on_upgrade_backup_failure`, default ON; retention `upgrade_backup_keep`, default 3). Upstream verified backups only engage while the gateway is already starting — a start that dies during its own migration previously left no honest rollback path (proven by the 2026-10-04/05 crash-loop saga).
- **Safety net — automatic doctor repair (restart-loop closer):** after 2 consecutive failed gateway starts the app now runs `openclaw doctor --fix --non-interactive --yes` (max `gateway_doctor_repair_max` = 3 per app start, openclaw.json snapshotted first, local modes only). Automates the previously manual repair that broke the crash-loop saga (§ session-marker surgery).
- **Safety net — exponential restart backoff:** the flat 2s restart loop is replaced by a doubling backoff (2s → 60s cap) with a 120s boot-health reset threshold measured at exit time (not after detection sleeps). Ends the 2-second restart-storm pattern on data-migration releases.
- **Retired-key hygiene:** the app no longer writes `gateway.controlUi.dangerouslyDisableDeviceAuth` on boot — the flag is retired + ignored upstream since 2026.9.8 (lint rule + doctor deletion, dist-verified); the legacy key is now removed from the gateway config instead of re-written every start. Option kept (marked deprecated); all six translation descriptions updated to describe the real pairing behavior.
- Open question deliberately NOT fixed by this release (upstream, still open in 2026.9.9): the undefined-rejection crash-loop root cause — mitigated by our shim + the three safety nets above.
## 0.7.12.7
- **Security — OWASP LLM01 Control #5, invisible-unicode guard:**
  - **Gap:** OpenClaw 2026.9.8's naive character-class strip broke valid ZWJ emoji, ignored isolated variation selectors (U+FE00–U+FE0F, a documented prompt-injection channel) and left web_search results completely unstripped.
  - **Fix:** build patch `unicode-guard/` splices the tested implementation into every naive copy in the dist tree (including minified worker bundles), anchor-exact with a loud build failure on upstream drift.
  - **Tests & details:** 15 tests; behavior + tradeoffs in `unicode-guard/README.md`.
- **Watchdog kill on clean Pi boot fixed:** HEALTHCHECK start-period 120s → 420s, retries 3 → 4. Evidence — Supervisor log 2026-10-07 19:41:39 ("unhealthy, restarting" + docker kill exit 137) despite a clean boot: Homebrew sync/skill copy/gateway init can take >4 minutes on the Pi; the old window expired before the first `/startupz` response. Fails within the start period do not count against the retries; genuine hangs are still detected quickly (4 consecutive fails at 30s each).
- **V21 — external WebUI button ("WebUI ↗") always targets the ingress URL:** instead of the statically rendered `__GATEWAY_PUBLIC_URL__` (boot-time LAN IP, unusable externally) it now sets client-side same-origin `./webui/#token=<token>` — exactly the path + autologin of the working inline tab. Since 0.7.12.1 the landing runs exclusively inside the HA ingress session (local + external via Nabu/DyndNS identical), so `./webui/` is always correct. LAN-18789 bypass deliberately dropped (functionally irrelevant); no Python/nginx touch.
- **`sshpass` baked into the image (apt zone 1):** was a runtime install only and vanished on every rebuild/container swap; verified on Debian bookworm/main arm64 (1.09-1).

## 0.7.12.6
- **Build fix after the failed first Supervisor build:** import check switched to `importlib.metadata` (crawl4ai's `__version__` is a submodule; the old masked check hid the same bug). Re-tag executed: `main`=`f8b1ca0`, tag `v0.7.12.6`→`032a5c5` (forced update), release object follows the tag.
- **Durable fix — browser links decay on every arm64 rebuild**:
  - **Failure:** Playwright 1.63 installs arm64 Chromium under `chromium-<rev>/chrome-linux-arm64/`; the old Dockerfile glob `chromium-*/chrome-linux/chrome` matched only the x64 layout → `ln -sf` silently produced dangling symlinks (masked by `|| echo 'version check failed'`) → green build, dead browser tool while the binary existed at `/opt/ms-playwright/chromium-1243/chrome-linux-arm64/chrome`.
  - **Fix:** `browser_links.sh` (in-image as `/usr/local/bin/link-playwright-chromium`) as the single source — layout-agnostic resolution (`chromium-*/chrome-linux*/chrome`, highest revision wins), links `/usr/bin/chromium` + `/usr/bin/chromium-browser`, fails the build hard when nothing is found; run.sh additionally repairs the link on every start (boot self-heal).
- **crawl4ai/patchright revision sync**: crawl4ai launches browsers through playwright AND patchright — both pin their own Chromium revision. The crawl4ai build layer reinstalls both (`playwright install chromium && patchright install chromium`, no-op at revision parity) so a future crawl4ai bump never leaves a missing revision in `/opt/ms-playwright`. Stale Dockerfile comment (a non-existent run.sh ms-playwright symlink promise) corrected.
- **Version pinning**: `crawl4ai==0.9.4`, `playwright==1.63.0`, `patchright==1.63.0` pinned (all three = PyPI latest at the 2026-10-07 survey) — reproducible builds; future updates go deliberately through the release flow (survey + audit + GO) instead of build-time chance.

## 0.7.12.5
- **Hotfix — gateway exit loop on chat start**:
  - **Trigger:** OpenClaw 2026.9.8 terminates the gateway on every unclassified unhandled rejection (`process.exit(1)`).
  - **Mechanism:** on the Pi, chat start blocks the event loop for 13–25 s (plugin-tools init, SQLite reclamation); each chat start rejects a silent promise with `reason === undefined` → immediate exit ("Unhandled promise rejection: undefined") and a restart loop.
  - **Fix:** new `undefined-rejection-shim.cjs` (via `NODE_OPTIONS=--require` ahead of all OpenClaw modules) registers a filter in the OpenClaw handler registry (`Symbol.for("openclaw.unhandledRejection.handlers")`) classifying only `reason === undefined` as handled; all other rejections continue through the 9.8 policy unchanged. Dockerfile: shim into `/app/undefined-rejection-shim.cjs`; run.sh: `--require` in both NODE_OPTIONS branches.

## 0.7.12.4
- **Performance — RAM-adaptive heap budget**: the static 4 GB Node heap kept OpenClaw's memory-pressure threshold below the gateway's normal working set on this host, stalling `sessions.list` for 5+ seconds; the heap now sizes from host RAM (≥12 GB → 6144 MB here).
- **P0 — server TLS certificate generation restored** (lost in the v0.7.10.0 refactor; fresh lan_https installs had no server cert) and hardened with X.509v3 extensions (basicConstraints/keyUsage/EKU) so strict clients accept it.
- **Fixed — boolean option trap**: explicit `false` options were silently reverted to defaults by jq's `//` operator on every start (6 reads fixed).
- **Fixed — 502 during startup** now shows the loading page (terminal hint included) instead of a raw error.
- **OpenClaw 2026.9.8** (no schema migrations, low-risk bump; agentId fix native, tarball-verified). **Added**: `openssh-client` (sandbox SSH), supervisor watchdog, `backup_exclude` (~12 GB smaller HA backups). **Removed**: dead `router_ssh_*` options; hardcoded `cron_skip_missed_jobs` and session-lock cleanup (always-on).

## 0.7.12.3
- **Terminology: Add-ons → Apps** — all user-facing texts follow the official "Apps" naming Home Assistant introduced with 2026.2 (README, DOCS, SECURITY, CONTRIBUTING, DEPLOYMENT, UI translations, landing page, runtime log messages). Technical identifiers stay untouched (slug `openclaw_ha_addon`, `addon_config` mount, Supervisor API, repo URL) — matching the upstream supervisor design. Also fixes the mDNS default in the es/bg/pl/pt-BR translations (claimed "openclaw-ha-addon", actual default "openclaw").

## 0.7.12.2
- **Ingress asset compression restored** (3.4× less transfer on ControlUI cold loads): static-asset locations pass `Accept-Encoding` through to the gateway (native brotli/gzip); HTML locations keep `identity` for `sub_filter`.
- **CSP synced with upstream 2026.9.6**: `frame-src` added (link previews were blocked), `img-src https:` added (remote avatars were blocked), `connect-src data:` added, `'unsafe-eval'` → `'wasm-unsafe-eval'` (bundle-verified, zero eval consumers).

## 0.7.12.1
- **Security — Ingress lockdown**: nginx `:49200` accepts only loopback + Supervisor network (`172.30.32.0/23`); the unauthenticated LAN root-shell (ttyd terminal/TUI) and the token-bearing landing page are now exclusively reachable through the authenticated HA Ingress session.
- **Security — token file permissions**: rendered `nginx.conf` (contains the gateway bearer token) is written with `0600` instead of `0644`.
- **Terminal-first boot**: nginx + web terminal start BEFORE the gateway — the Ingress panel is reachable during slow SQLite startup; Terminal is the default tab.
- **TUI removed** (superseded by the bash Terminal as fallback surface): tab, ttyd instance, `enable_tui`/`tui_port`/`tui_session` options.
- **Fix**: `cron_skip_missed_jobs` restored to the options schema (supervisor warning since 0.7.11.1); CRLF normalization for `oc_config_helper.py`; dead TUI/docs copy block removed; translations completed for all 6 languages (schema parity, stale keys removed); audit hardening — gateway-start failure keeps the container alive (terminal stays reachable), hardcoded `18790` replaced with the gateway-port placeholder.

## 0.7.12.0
- **OpenClaw 2026.9.6**: restart recovery for interrupted conversations and subagents, slow-startup detection (exit 2 = starting, not failed), `openclaw doctor --session-sqlite recover`, lossless history/storage compaction (schema 23/18 — one-way migration, backup taken), WebChat reconnect resilience with "Forget this browser", KillMode=mixed repair via Doctor.
- agentId patch remains native in 2026.9.6 (tarball-verified).
- All 0.7.11.15.x ingress fixes retained.


## 0.7.11.15.3

- **Fix "Gateway not reachable" through Nabu Casa/Ingress after reconnects (the real killer)**: the ControlUI stores the gateway URL without a trailing slash (`…/webui`), and nginx answered that exact path with a `301` redirect — WebSocket clients never follow redirects, so every reconnect after Supervisor idle kills died at the redirect. New explicit `location = /webui` proxies directly with WebSocket headers. Verified live: `GET /webui` → 200 (was 301), WS upgrade → 101; confirmed end-to-end via Nabu Casa from the iOS Companion App. (d037bd1)

## 0.7.11.15.2

- **Fix Ingress ControlUI asset 404s (local + Nabu Casa)**: HA Supervisor sends `X-Ingress-Path` without the `/webui` panel suffix; new `$ingress_path_norm` map normalizes all prefixes. (dbc00fe)
- **Fix stale cached gateway URLs**: the injected ControlUI cleanup script now removes any `gatewayUrl`/`bootRecord` localStorage entry that does not match the current ingress base path, forcing re-derivation on every load. (0d32951)
- nginx `sub_filter`/map changes only — no OpenClaw or startup changes.

## 0.7.11.15.1

- **Ingress WebSocket through HA/Nabu Casa**: force loopback `Host` header so OpenClaw 2026.9.5 treats Ingress traffic as local; unauthenticated nginx locations under `/webui/` for static assets so the Supervisor can fetch them without the add-on bearer token; remove duplicate `/webui` suffix from base-path maps.
- Conservative nginx-only fix release; no OpenClaw version or add-on startup changes. (Not tagged as a release; superseded by 0.7.11.15.2 within a day.)

## 0.7.11.11

- **Rollback**: revert the add-on code base to v0.7.11.3, the last release where HA Ingress (including Nabu Casa remote access) worked reliably. The nginx/Ingress changes from v0.7.11.4–v0.7.11.10 broke the ControlUI WebSocket through Nabu Casa and are intentionally excluded. (b681274)

## 0.7.11.3

- **Fix OpenClaw OpenAI-compatible endpoint for HA Assist pipeline** (OpenClaw 2026.9.4 regression):
  - The `/v1/chat/completions` endpoint was returning `500 internal error` because `buildAgentCommandInput` did not pass the resolved `agentId` to `agentCommandFromGatewayIngress`.
  - Patched `openai-http-CACctX8Y.mjs` at build time to preserve `agentId` through the request lifecycle.
  - This restores Assist Pipeline / conversation agent functionality for multi-agent (`agents.ownership: explicit`) setups.

## 0.7.11.2
- Fix the Docs/Info tab showing unrendered placeholders (`__OPENCLAW_VERSION__`, `Gateway: unreachable`, `Ingress: unknown`):
  - Convert `docs/index.html` into a rendered template (`docs/index.html.tpl`) so `render_nginx.py` can substitute version, access mode, and network mode at startup.
  - Update Dockerfile to copy the template into the image.
  - Correct the JS health probe path from `./api/health` to `../api/health` because the docs page is served under `/docs/`.
  - Remove the unrelated AI-Stack port table entries (Hermes, n8n, Ollama, etc.) from the add-on docs page to avoid confusion.

## 0.7.11.1
- Add `tui_session` configuration option (default `agent:main:main`) so the embedded OpenClaw TUI opens the correct default session after onboarding instead of hard-coded `agent:coding-main:main`.
- Update `DOCS.md`:
  - Correct Ingress port (49200) and service list (WebUI, Terminal, TUI, Docs).
  - Replace all outdated `access_mode` / `gateway_bind_mode` references with the current `network_mode` presets.
  - Add health-check documentation (`/api/health`, `/webui/healthz`, `/startupz`).
  - Document the new `tui_session` option.

## 0.7.11.0
- Improve Ingress / gateway health detection:
  - Dockerfile HEALTHCHECK now also verifies the OpenClaw gateway `/startupz` endpoint (read from persisted `openclaw.json` at check time), not just the nginx ingress port.
  - Landing page polls both ingress health and OpenClaw gateway `/healthz` for a deeper readiness indicator.
- Make CSP/X-Frame-Options stripping more precise:
  - Still replace OpenClaw's `frame-ancestors 'none'` to allow HA Ingress iframe embedding, but preserve the rest of the bundled CSP.
  - Document the upstream blocker (openclaw/openclaw#78577) so the override can be removed once a config knob exists.

## 0.7.10.32
- Fix OpenClaw ControlUI ingress WebSocket fallback to `127.0.0.1:18789`:
  - Remove duplicate `sub_filter` on `<html>` that produced an invalid double `data-openclaw-control-ui-base-path=""` attribute.
  - Inject a client-side script that derives the HA Ingress base path from `window.location.pathname`, removes any duplicate attribute, and deletes stale `localStorage` gateway/boot-record entries that still contain `127.0.0.1:18789`.

## 0.7.10.29
- Update OpenClaw to **2026.9.4**.
- No schema or Node changes required; NodeSource `node_24.x` (Node 24.20.0) continues to satisfy OpenClaw's minimum requirement.
- Highlights: safer rollback for compatible failed updates, unified Plugins workspace in Control UI, terminal question prompts, improved conversation-history recovery, read-only config mode via `OPENCLAW_CONFIG_READONLY=1`.

## 0.7.10.28
- Update OpenClaw to **2026.9.3**.
- Align add-on version, Dockerfile, and installed OpenClaw version (fixes prior 0.7.10.26/27 mismatch where the image still contained older OpenClaw releases).
- NodeSource `node_24.x` provides Node 24.20.0, satisfying OpenClaw 2026.9.3 minimum Node requirement (24.16.0+).

## 0.7.10.27
- Fix Dockerfile to actually install `openclaw@2026.9.2`; bump add-on version so HA rebuilds the image.

## 0.7.10.26
- Intended OpenClaw 2026.9.2 update (Dockerfile was not updated in this release; superseded by 0.7.10.27/28).
- Force uncompressed ControlUI HTML from the OpenClaw gateway by sending `Accept-Encoding: identity` for `/webui/` upstream requests. This allows nginx `sub_filter` to rewrite absolute asset links to the correct HA Ingress path and fixes the black screen / "Control UI did not start" error.
- Use relative asset prefixes (`./assets/`, `./themes/`, etc.) as fallback when `X-Ingress-Path` is missing.

## 0.7.10.25
- Update OpenClaw to **2026.9.1**.
- **Add-on schema**: add `cron_skip_missed_jobs` (default `true`) and `blocked_hostnames` options for OpenClaw 2026.9.1 configuration controls.
- **run.sh**: log detected OpenClaw version at startup for easier support diagnosis.
- **Note**: OpenClaw 2026.9.1 introduces `cron.skipMissedJobs` and `blockedHostnames`. Back up `/config/clawd` before the first start after updating.

## 0.7.10.23
- Fix OpenClaw ControlUI ingress loading: remove trailing slash from base path to avoid double slashes in dynamically constructed URLs (`/webui//themes/...`).
- Rewrite `/themes/` asset links inside the Ingress proxy (previously only `/assets/` was handled).
- Restrict nginx `sub_filter` to `text/html` responses to avoid corrupting JS/CSS bundles.

## 0.7.10.22
- Fix external HTTPS access (lan_https mode): remove X-Forwarded-* / X-Real-IP headers from the HTTPS proxy block so OpenClaw 2026.8.2 no longer rejects the request with proxy_attribution_required.

## 0.7.10.21
- Fix OpenClaw ControlUI asset loading inside HA Ingress when X-Ingress-Path header is missing by rewriting asset links to relative URLs (with absolute fallback when the header is present).
## [0.7.13.11] - 2026-10-10

### Fixed
- **Turn-1 binding race:** adapter delegation now always carries the live config roster (harnessSessions honored on the first turn).
## [0.7.13.10] - 2026-10-10

### Added
- **`harnessSessions` option (F3 fix):** dashboards bind to real spawned ACP sessions per harness; manifest configSchema declares all plugin config options; fourth discovery gate (`plugins.allow`) in deploy.
## [0.7.13.9] - 2026-10-10

### Changed
- **Binding selection ladder:** `boundAgents` > `excludedAgents` > safe-default exclusion — no ban without escape hatch; plugin deploy tests added.
## [0.7.13.7] - 2026-10-10

### Fixed
- **Plugin discovery:** `deploy_plugin()` ensures `plugins.load.paths` includes the user-plugins root — registration alone did not trigger loading (proven on 0.7.13.6).
## [0.7.13.6] - 2026-10-10

### Fixed
- **Plugin deployment missed its Dockerfile COPY** — acp-dashboard-binding now ships in the image and deploys at boot (fallback source resolution + orphan pruning).
## [0.7.13.5] - 2026-10-10

### Added
- **Custom ACP harness support (generic):** options for harness model overrides + additional allowed harness agents; new bundled plugin `acp-dashboard-binding` auto-binds Control-UI dashboard sessions at configured ACP harness agents (dynamic roster).
## [0.7.9.24] - 2026-08-23

### Changed
- **Landing page redesign**: Home Assistant Material Design 3 style with cards, chips and tile navigation.
- **Security**: `__GATEWAY_TOKEN__` is escaped with `html.escape()` in `render_nginx.py`.
- **Features restored**: CA cert download (only `lan_https`) and disk usage display in the footer.

## [0.7.9.23] - 2026-08-23

### Fixed
- **Ingress Gateway Health Sensor (HA iframe path)**: Changed health fetch from absolute `/api/health` to relative `./api/health` in landing page, TUI and docs, so requests resolve correctly inside the HA Ingress iframe context.

## [0.7.9.22] - 2026-08-23

### Fixed
- **Ingress Gateway Health Sensor**: `/api/health` now proxies to the actual OpenClaw Gateway `/health` endpoint instead of returning a static nginx 200 OK.
- landing, TUI and docs pages parse JSON response and check `data.ok`.

## [0.7.9.21] - 2026-08-23

### Fixed
- **Codex ACP Wrapper auth race**: `resolveProviderEnv()` is now called before checking/writing `auth.json`, ensuring the Ollama fallback key is correctly visible to the wrapper.

## [0.7.9.20] - 2026-08-23

### Fixed
- **Plugin API version compatibility**: `run.sh` now exports a plain semver string for `OPENCLAW_VERSION` so the plugin API compatibility check (`>=2026.7.1`) passes and ACPX loads.

## [0.7.9.19] - 2026-08-13

### Fixed
- Quote ACPX_ENABLED jq selector in run.sh.

## [0.7.9.18] - 2026-08-13

### Fixed
- Line-ending normalization in `run.sh` so HA picks up the file correctly.

## [0.7.9.4] - 2026-08-13

### Added
- Dedicated TUI terminal via ttyd running `openclaw tui`.

## [0.7.9.3] - 2026-08-13

### Added
- Ingress iframe auto-login, terminal fix, CSP override.

## [0.7.9.2] - 2026-08-13

### Changed
- Bump OpenClaw to 2026.7.1-2 and node-llama-cpp to 3.20.0.

## [0.7.9.1] - 2026-08-13

### Changed
- Ingress UI refactor fixes.
