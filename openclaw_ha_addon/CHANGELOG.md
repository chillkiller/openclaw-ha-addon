# Changelog — OpenClaw Assistant (Home Assistant App)

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For a release-facing summary, see the root [CHANGELOG.md](../CHANGELOG.md).

---

## [0.7.13.35] — 2026-10-18

### Fixed

- **Helper never creates an empty `plugins.allow` list:** the plugin registration helper called `setdefault("allow", [])` on every boot. Once created, an allow-list acts as an exclusive gate and silently blocked every other plugin — including all provider plugins activated before onboarding. Fix: absence of `plugins.allow` now means nothing is blocked; the helper never creates the key. Union-into-existing only. 3 regression tests added.
- **harness-config-writer small-model fallback:** `ANTHROPIC_SMALL_FAST_MODEL` now falls back to `model` when `smallModel` is absent (no dangling reference). Copilot `WIRE_API="responses"` documented. BRIDGE.md §15.2 claude row completed with operator hint to pick a small non-thinking model. Stale dispatcher docstring corrected.

### Changed

- **Container shutdown escalation:** shutdown sequence improved: SIGTERM → 3 s poll → SIGKILL → re-check, so run.sh exits before Docker's stop budget with cleanup complete. `oc-gateway stop` and `oc-gateway doctor` now use port-owner aware SIGTERM/SIGKILL with orphan sweep.

---

## [0.7.13.34] — 2026-10-17

### Fixed

- **harness-config-writer hardening (audit-fix batch):**
  - Match key no longer contains the URL scheme (http↔https catalog providers now match — multi-model auto-match was silently dead for http-Ollama vs https-catalog entries).
  - `smallModel` is always included in the opencode `provider.models` map when it differs from `model` (no dangling `small_model` reference without a models list).
  - Per-harness fail-soft: one bad config file no longer collapses the entire deployment.
  - Bare-filename `OPENCLAW_CONFIG_PATH` resolves to `.` instead of falling through to XDG/HOME.
- **Augment/merge semantics for foreign operator configs:** codex `config.toml` — a foreign file without a writer signature gets a marker-framed provider section appended (operator content byte-preserved; operator edits after the END marker survive). Header collisions skip with a warning, never guess. opencode `opencode.jsonc` — foreign plain-JSON files are merged (operator keys preserved, only the provider block is inserted); shorthand `provider: "string"` and commented JSONC are left intact with a NOTE. Legacy `config.toml` with real operator content is no longer clobbered. New deploy action `augmented`.
- **Marker lifecycle hardened:** markers match only full lines (a marker inside an operator comment no longer truncates the file); BEGIN without END is treated as foreign content; empty refresh strips the dead marked section (converges); bare vs quoted TOML headers alias correctly; writer-owned detection is structure-based (positive) instead of key-subset — operator files like `{"model": …}` are never silently replaced.
- **Cursor harness stays unsupported:** standalone Ollama works via an undocumented package, but the `acp` subcommand does not wire the local-provider runtime in this build — re-evaluate when Cursor ships official ACP support.

### Added

- **copilot BYOK/Ollama support:** new environment variables — `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_API_KEY`, `COPILOT_PROVIDER_WIRE_API="responses"` (only when baseUrl is set), `COPILOT_MODEL`. Verified via Ollama integration docs and the `@github/copilot` 1.0.98 binary help text.

---

## [0.7.13.33] — 2026-10-16

### Fixed

- **Reset command in bound ACP sessions:** the second reset path (resetting the dashboard conversation, not just the work session) was using a plugin-RPC call that the gateway ownership gate blocks for conversations. Replaced with a direct call to the built-in ACP driver — host-side, without plugin identity, the same primitive as a normal `/reset` on unbound conversations. Codex-audited; 254 binding tests pass.

### Known issues

- **`plugins reload` does not reload plugin module code:** the require cache is process-wide and keyed by file path; new bundle bytes are only picked up on the next gateway process start. The fix ships in the image.

---

## [0.7.13.32] — 2026-10-16

### Fixed

- **Reset command missing for derived bindings:** the dual-reset driver from 0.7.13.31 only matched explicitly stored bindings. Derived/bridged bindings (computed on-the-fly, not stored) were not found by the reverse lookup, so the second reset path was skipped. Added a bounded reverse-lookup cache (512 entries) that records every resolved binding — derived or explicit — so the reset driver finds both. Binding suite 251/251.

---

## [0.7.13.31] — 2026-10-16

### Fixed

- **mDNS self-conflict rename storm:** the bundled ciao library keyed its IPv6 address records using raw OS interface strings, but decoded inbound DNS answers using RFC-compressed form. The two never matched, so the library treated its own address as a foreign conflict and renamed itself on every echo — generating ~1 rename per second. Fixed with a build-time patch that normalizes the map keys to the decoded form. Live verification: 0 conflicts after patch.
- **Boot heal timing on large stores:** the single-shot boot sweep ran before agents were fully admitted, so stuck sessions on large stores were not healed. Replaced with a bounded retry driver (0/15/30/60/120/240 s delays) that runs detached from the hook runner.

### Added

- **Dual-reset driver:** `/reset` in an ACP-bound session now resets both the work session and the dashboard conversation. Implemented as a stateful binding target driver registered alongside the built-in ACP driver. Best-effort: if the conversation reset fails, it logs a warning but never degrades the work result. Docs: BRIDGE.md §25.
- **OpenClaw 2026.10.4** (stability patch over 2026.10.3; relevant fixes: gateway shutdown/restart no longer hangs on transcript workers, no more writer-claim errors on plugin-launched turns, gateway stays responsive during long reply streams).

---

## [0.7.13.30] — 2026-10-14

### Fixed

- **mDNS advertisement inactive:** the native OpenClaw Bonjour plugin was silently disabled because the container-detection logic in OpenClaw was not recognizing the Home Assistant environment. Fixed by exporting `OPENCLAW_DISABLE_BONJOUR` from run.sh matching the `mdns_mode` option.
- **harness-config-writer was a silent no-op:** the plugin was reading from `api.config.harnesses` (always undefined — that's the full OpenClaw config, not the plugin config) instead of `api.pluginConfig`. Fixed. Legacy key under `acp-dashboard-binding` now logs a visible warning instead of failing silently.
- **Review-fix batch (5 fixes):** catalog key only written when a catalog is actually built (no dangling file reference); secret file modes written atomically before rename (no exposure window); `maxTokens` collection removed (no consuming surface); "SKIP → picker loss" documented; double-warning on invalid `models` fixed; `modelsSource:"optout"` correctly distinguished from an empty operator `models: []`.
- **Audit round 2 fixes:** target file mode is applied even when content is byte-identical (heals wrong modes on every boot); chmod failures surface in warning logs; catalog skip log now distinguishes "no models" from "no contextWindow metadata."

### Added

- **Multi-model support:** all models from the `openclaw.json` provider list are now distributed across all harness surfaces (codex profiles, opencode models map, claude `CLAUDE_MODEL_CONFIG`, environment variable comment lists). The add-on model remains the default. Generated configs are refreshable by signature.
- **codex model catalog:** `contextWindow` metadata from `openclaw.json` is written to `/config/.codex/model-catalog.json` so the codex CLI can resolve model metadata for direct users.
- **Binding pack merged:** native dispatch mode (archive stamps never written in native mode); boot heal clears `spawnedBy` over-hiding stamps on clone sessions (5 sessions were incorrectly hidden as subagents); init race bounded with a 10 s join on all async ingress boundaries.
- **Options UI restructured:** collapsible sections; `ha_integration` group moved first; `acpx_enabled` and `harness_config_writer_enabled` are now top-level standalone switches above the `harness` group. Provider keys are harness-scoped, not Ollama-scoped. `enable_terminal` retired — the web terminal is always on via Ingress; only `terminal_port` is configurable.

### Changed

- **`acpx_enabled` is the master gate:** with it off, no writer or binding deploy or config transfer happens, whatever their individual switches say. With it on, writer and binding act independently of each other.
- **Option renames:** `ollama_base_url` → `harness_base_url`, `ollama_acp_*_model` → `harness_*_model`, `acp_additional_allowed_agents` → `additional_agents`. Migration tool rebuilt.

---

## [0.7.13.29] — 2026-10-14

### Changed

- **Auto-archive disabled by default:** new option `cloneAutoArchive` (default `false`). When off, the binding plugin never writes archive stamps — archived sessions heal on next dispatch or stay archived. When on, the pre-0.7.13.29 behavior is restored. The re-archive race condition is structurally impossible in the default state.

---

## [0.7.13.28] — 2026-10-14

### Changed

- **Rollback to v0.7.13.25 code:** all code reverted to the 0.7.13.25 state. Reason: stability regressions in login, Ingress, and add-on reliability since 0.7.13.26. Slow-boot issue tracked separately.

---

## [0.7.13.25] — 2026-10-13

### Fixed

- **Clone invisibility:** idle harness clone sessions no longer appear in the user-visible session list. Archived state keeps the dispatch path clean.

### Added

- **Native dispatch mode:** new plugin option `dispatchMode: "claim" | "native"` (default `"claim"` — unchanged behavior until flipped). In `"native"` mode, binding records are emitted without ownership metadata so the host routes the webchat conversation directly into the ACP session — no clone, no mirror, no claim. Rollback is a config flip.
- **Gateway lifecycle operators:** new `oc-gateway` helper (installed to `/usr/local/bin`): `status`, `health`, `stop`, `resume`, `maintenance-status`, `restart`. Maintenance latch file `/config/.openclaw/.gateway-maintenance` survives addon restarts.
- **Terminal supervisor:** ttyd is revived within 30 s if it stops listening (port-based liveness check).
- **Terminal-first boot gate:** gateway start waits up to 30 s for the terminal to be listening before starting. Does not hard-fail on permanent timeout — nginx and Ingress remain available as escape hatches.

---

## [0.7.13.24] — 2026-10-13

### Fixed

- **Boot sweep hook now fires:** the session-settlement sweep that clears stuck sessions was registered via the wrong API and never dispatched. Moved to the typed hook runner (`api.on("gateway_start", …)`), which is the only surface that actually fires that event.

---

## [0.7.13.23] — 2026-10-13

### Fixed

- **Hook registration crash:** the gateway registry throws for every `api.registerHook` call without a name. The boot-sweep hook was nameless and crashed the gateway on every boot. All hooks are now named. Also fixed: the bridge projection was dropping the third argument when forwarding hook options, so bridge hook names never reached the host.
- **New contract test:** `src/hook-contract.test.ts` runs `registerFull` against the verbatim host contract and statically ensures every `registerHook` call passes named options.

---

## [0.7.13.22] — 2026-10-13

### Fixed

- **Claim-path conversation never settled:** the host never writes run-terminal entries for claimed turns, so the origin conversation node stayed `running` indefinitely. The plugin now writes the correct settle record after every claim return and clears the restart-recovery field set.
- **Claim replies not persisted:** the plugin delivered claim replies to the origin conversation but never wrote them to the transcript — re-renders lost every answer. The plugin now mirrors every delivered claim reply into the origin transcript via the official append API.
- **Stuck `running` clone nodes:** terminal-write races on the direct dispatch path no longer leave clone nodes stuck forever. Boot sweep at `gateway_start` clears orphaned `running` nodes of the binding key grammars.

### Added

- **Hidden harness sub-sessions:** harness clone sessions get a `spawnedBy` provenance stamp so the Control UI excludes them from subagent counts.
- **`utility_model` option:** sets `agents.defaults.utilityModel` (the model behind internal gateway utility callouts, e.g. the session observer). Fixes "session observer returned invalid JSON twice" events. Unset = no write (operator owns the value).

---

## [0.7.13.21] — 2026-10-12

### Changed

- **OpenClaw 2026.10.2** with dist verification. Startup gate unchanged.
- **Dashboard binding default changed to `true`:** the binding is now on out of the box. Explicit `false` is a real opt-out that disables the plugin entry and strips the channel block.
- **Activation manifest updated:** `openclaw.plugin.json` adds `activation:{"onStartup":true}` so the host considers the plugin for gateway startup.

---

## [0.7.13.20] — 2026-10-12

### Fixed

- **Plugin never instantiated after bundled-root deploy:** the plugin was deployed to `dist/extensions/` with a channel manifest, which made the gateway treat it as a bundled channel and enforce a contract (`kind`, `loadChannelPlugin` export) it didn't have. The host logged `missing bundled-channel-entry contract; skipping` 11 times per boot and the plugin never loaded. Fixed by switching to a contract-compliant entry shape. Boot proof: `loadedPluginCount=15`, `channels.acp-dashboard-binding.*` steps present.

---

## [0.7.13.19] — 2026-10-12

### Fixed

- **Terminal-write owner race on claimed turns:** the claimed reply turn completed but the session-entry patch threw `Terminal write owner changed before commit` — mirror/delivery writes rebind the owner between capture and commit in the same tick. Failed commits left `session_nodes` rows stuck `status:"running"` with a dangling `lifecycleRunId`. Fix: 500 ms yield after terminal `waitForRun` result before returning the claim reply (configurable via `postSettleYieldMs`).

---

## [0.7.13.18] — 2026-10-11

### Fixed

- **Plugin trust refusal on restart:** plugins deployed to `dist/extensions/` ran untrusted — the gateway grants keyed store access only to `origin: "bundled"` plugins. The binding plugin's persisted store threw `PluginTrustRefusalError` on every restart. Fixed by compiling both plugins into the gateway's own `dist/extensions` root (origin "bundled") and removing stale external copies.
- **Helper deploy switched to bundled root:** compiles with esbuild, writes to the bundled extensions directory, removes stale external copies, falls back to legacy external deploy on failure.

### Added

- **`gateway_startup_trace` option:** exports `OPENCLAW_GATEWAY_STARTUP_TRACE` for per-phase/per-plugin boot timing diagnostics.
- **`acp_smoke_check.sh`:** read-only post-restart smoke test (gateway alive, bundled payload valid, no stale external shadowing, ACP roster, stuck sessions, boot errors, harness env wiring). Zero writes.

---

## [0.7.13.17] — 2026-10-11

### Added

- **Standalone harness-config-writer:** split from the binding plugin into its own feature plugin. The two fail independently.
- **Add-on-level harness defaults:** new options — `harness_base_url` (activator, empty = nothing generated), `harness_model`, `harness_api_key`, `harness_excluded_agents`. Operator hand-entries in `openclaw.json` are never touched; stale generated entries are removed only when byte-identical to the generated value.
- **Backup rewrite:** first writer-enabled boot snapshots pre-writer state of all managed files; disabling restores originals and consumes the snapshot; re-enabling takes a fresh snapshot. Quarantined manifests block re-snapshots until resolved.

---

## [0.7.13.16] — 2026-10-11

### Added

- **Generalized harness config:** the plugin now configures all acpx harnesses (not just the three flagship ones). Three config mechanisms cover the full harness catalog: FILE (codex, opencode), ENV (claude, gemini, droid, qwen, kimi, kiro, iflow), NONE (copilot, cursor). Absent harness entry = plugin writes nothing; bundled acpx defaults run unchanged.

---

## [0.7.13.15] — 2026-10-11

### Fixed

- **`bindMainSessions` flag was ignored:** the flag controls whether `agent:<harnessId>:main` sessions bind to ACP sessions. With explicit `false`, binding was still attempted. Now enforced before the shape match.

### Added

- **Main clone binding completed:** `agent:<harnessId>:main` sessions now bind to their own clone key deterministically, with `bindMainSessions` (default `true`) declared in the manifest configSchema.

---

## [0.7.13.14] — 2026-10-11

### Added

- **Per-conversation ACP sessions:** every dashboard conversation gets its own persistent ACP session. The ACP key is a deterministic clone of the origin session key's conversation identity. New UI session → new ACP session; existing session → existing key.

---

## [0.7.13.13] — 2026-10-11

### Fixed

- **Per-workspace binding keys now get real sessions:** the provisioner was passing a legacy `harness:<agent>` conversation id to the ensure contract instead of the actual target session key. This caused ACP session rows to land on the wrong key while resolves answered the correct one — turns perished with `ACP_SESSION_INIT_FAILED`. Fixed by passing the target key to the ensure contract.

---

## [0.7.13.12] — 2026-10-11

### Added

- **Harness sessions inherit origin workspace:** dashboard-bound harness sessions now use the origin session's working directory (derived from `session_nodes.entry_json.sessionRoot` → `projects.repo_root`). Agents work inside the project folder they were opened from.
- **Per-workspace session keys:** `harness:<agent>:ws:<sha16(cwd)[0..12]>` — one persistent ACP session per agent × workspace.

---

## [0.7.13.11] — 2026-10-10

### Fixed

- **Turn-1 binding race:** the async bridge start left the config roster null on the first turn, so `harnessSessions` was ignored and chat send died with `ACP_TURN_FAILED`. Fix: both delegation calls now pass the config roster directly, race-free by construction.

---

## [0.7.13.10] — 2026-10-10

### Added

- **`harnessSessions` config option:** dashboard conversations bind to a real, explicitly spawned persistent ACP session per harness instead of synthetic binding keys that die with `ACP_SESSION_INIT_FAILED`. The manifest `configSchema` now declares `boundAgents`, `excludedAgents`, `harnessSessions`.

---

## [0.7.13.9] — 2026-10-10

### Changed

- **Binding selection priority:** replaced the hard orchestrator block with a prioritized gate — `boundAgents` (explicit allowlist) > `excludedAgents` (replacement for the default exclusion) > safe-default exclusion. No ban without an escape hatch.

---

## [0.7.13.8] — 2026-10-10

### Fixed

- **Plugin always re-enabled on boot:** the ACPX helper was overwriting an operator's explicit `enabled: false` with `true` on every boot. Now respects explicit opt-out; the flag is never flipped back and plugin registration is skipped while disabled.

---

## [0.7.13.7] — 2026-10-10

### Fixed

- **Plugin discovery path:** `deploy_plugin()` now also ensures `plugins.load.paths` contains the user-plugins root. Without this, the plugin was deployed and registered but never appeared in the gateway's boot list.

---

## [0.7.13.6] — 2026-10-10

### Fixed

- **Plugin never deployed:** the Dockerfile had no `COPY plugins` step — `deploy_plugin()` early-returned and the plugin was absent at boot. Fixed.

---

## [0.7.13.5] — 2026-10-10

### Added

- **Custom ACP harness support:** new options `ollama_acp_codex_model` / `ollama_acp_opencode_model` and `acp_additional_allowed_agents`. New bundled plugin `acp-dashboard-binding`: a webchat `SessionBindingAdapter` that routes Control UI dashboard sessions at configured ACP harness agents automatically.

---

## [0.7.13.4] — 2026-10-09

### Security

- **Removed shell injection in `gateway_remote_url`:** the remote-URL parser used `eval`'d shell code; shell metacharacters in user-controlled URLs executed as root at boot. Replaced with plain-data hand-off and character-validated hostnames.
- **Removed hardcoded gateway token:** the ACPX helper bootstrapped a missing `openclaw.json` with a known placeholder token. The duplicate bootstrap was removed; run.sh generates a random per-install token instead.
- **Corrupt `openclaw.json` is quarantined, never overwritten:** parse failures previously fell back to an empty config, so a later write-back could destroy the entire configuration. Corrupt files are now renamed to `openclaw.json.corrupt` and the boot fails closed. All JSON writes are atomic.
- **`gateway_env_vars` validation hardened:** may no longer override app-validated runtime variables. Port validation tightened.
- **Helper failures exit honestly:** the ACPX helper now propagates real failures in its exit code.

---

## [0.7.13.3] — 2026-10-09

### Fixed

- **Boot crash on unset API key:** ACP ambient-env routing read `$ANTHROPIC_API_KEY` guarded by `[ -z ... ]` which triggers an unbound-variable error under `set -u` when the key is not configured (the default case). Fixed with POSIX-safe `${ANTHROPIC_API_KEY:-}` expansion.

---

## [0.7.13.2] — 2026-10-09

### Changed

- **ACP harness modernization:** removed all custom ACP wrappers — acpx passthrough wrappers with ambient env routing instead. Claude Code, Codex and OpenCode reach the local Ollama backend with zero wrapper files.

---

## [0.7.13.1] — 2026-10-09

### Fixed

- **Boot exit-3 on safety-net options:** option reads used `|number` which is not a jq builtin, causing compilation failure on every start. Fixed with `tonumber` and explicit null guard.

---

## [0.7.13] — 2026-10-09

### Changed

- **OpenClaw 2026.9.9** (from 2026.9.8): upstream stability improvements for restart recovery, Docker upgrade-loop fix, doctor session-archive repairs, quarantined-database respect, memory-checkpoint timeout fix.

### Added

- **Pre-upgrade state backup gate:** on any detected version change, the app archives `openclaw.json` + `state/` + `agents/` to `/config/.openclaw/upgrade-backups/` before the gateway starts. Configurable via `abort_on_upgrade_backup_failure` (default true) and `upgrade_backup_keep` (default 3).
- **Automatic doctor repair:** after 2 consecutive failed starts, runs `openclaw doctor --fix --non-interactive --yes` automatically. Budget controlled via `gateway_doctor_repair_max` (default 3).
- **Exponential restart backoff:** replaces the flat 2-second restart loop with a doubling backoff (2s → 60s cap).

### Security

- **Both 0.7.12.7 security controls re-verified** against the 2026.9.9 dist. The undefined-rejection shim remains required (upstream has not shipped an equivalent).

---

## [0.7.12.7] — 2026-10-08

### Security

- **OWASP LLM01 Control #5 — invisible unicode stripping:** OpenClaw 2026.9.8's naive character-class strip broke valid ZWJ emoji and left variation selectors untouched. Fixed with a build-time patch (`unicode-guard/`) that applies context-sensitive stripping at every external-content ingest boundary.

### Fixed

- **Healthcheck kill on clean Pi boot:** HEALTHCHECK start-period extended from 120s to 420s, retries from 3 to 4. Homebrew sync and skill copy can take >4 minutes on the Pi; the old window expired before the gateway answered `/startupz`.
- **External WebUI button URL:** now uses a same-origin relative URL instead of a statically rendered LAN IP, so it works from both local and external access.

### Added

- **`sshpass` baked into the image:** previously a runtime install only, now part of the base image.

---

## [0.7.12.6] — 2026-10-07

### Fixed

- **Dangling Chromium symlinks on arm64:** Playwright installs arm64 Chromium in a different directory layout than x64. The symlink resolver is now layout-agnostic. Build self-heal added for every boot.
- **crawl4ai browser-revision drift:** both Playwright and Patchright Chromium revisions are now synced on every build.

---

## [0.7.12.4] — 2026-10-03

### Performance

- **RAM-adaptive Node.js heap:** the heap is now sized from host RAM at boot (≥24 GB → 8192 MB, ≥12 GB → 6144 MB, ≥8 GB → 4096 MB, below → 2048 MB). Fixes `sessions.list` stalling for 5+ seconds on high-RAM hosts.

### Fixed

- **Server TLS certificate generation restored:** the v0.7.10.0 refactor accidentally dropped server-cert generation. Fresh `lan_https` installs had no server certificate. Restored and hardened with X.509v3 extensions.
- **Boolean option reads:** explicit `false` options were silently reverted to defaults by jq's `//` operator. All boolean reads now use `if has(...)`.
- **502 during startup:** the landing page now intercepts 502 errors and shows a loading page with a terminal hint.

---

## [0.7.12.3] — 2026-09-26

### Changed

- **Terminology: Add-ons → Apps:** all user-facing strings updated to match Home Assistant 2026.2's official rename.

---

## [0.7.12.2] — 2026-09-26

### Performance

- **Ingress asset compression restored:** static ControlUI assets now serve brotli/gzip (measured: 468 KB → 138 KB for the largest bundle, 3.4× less transfer per cold load).

### Fixed

- **CSP synced with upstream 2026.9.6:** added `frame-src`, `img-src https:`, `connect-src data:`; replaced over-broad `script-src 'unsafe-eval'` with `'wasm-unsafe-eval'` (bundle-verified: zero eval across all ControlUI bundles).

---

## [0.7.12.1] — 2026-09-25

### Security

- **Ingress lockdown:** nginx now only accepts loopback and the HA Supervisor network. Direct LAN access to the terminal and landing page is rejected with 403.
- **nginx.conf permissions:** rendered config is written with `0600` instead of `0644`.

### Changed

- **Boot order inverted:** nginx and terminal start before the gateway. The Ingress panel is reachable during slow gateway startup.
- **TUI removed:** the `openclaw tui` iframe tab is gone — bash Terminal is the only fallback surface.

---

## [0.7.12.0] — 2026-09-25

### Changed

- **OpenClaw 2026.9.6:** restart recovery for unfinished conversations, slow-startup detection (exit 2 = starting, not failed), `openclaw doctor --session-sqlite recover`, lossless history/storage compaction, WebChat reconnect resilience.

---

## [0.7.11.15.3] — 2026-09-25

### Fixed

- **Nabu Casa reconnect failure:** WebSocket clients never follow HTTP redirects, so after idle disconnects the Control UI tried to reconnect to a redirect URL and died. Fixed by proxying `/webui` directly without redirect.

---

## [0.7.11.15.2] — 2026-09-24

### Fixed

- **Ingress ControlUI asset 404s:** HA Supervisor sends `X-Ingress-Path` without the `/webui` suffix, causing asset URLs to resolve incorrectly. Fixed with a normalization map.
- **Stale gateway URL in localStorage:** cleanup script now removes any stored URL that does not match the current ingress base path, forcing re-derivation.

---

## [0.7.11.15.1] — 2026-09-23

### Fixed

- **Ingress WebSocket through HA/Nabu Casa:** added unauthenticated nginx locations for static assets and forced loopback `Host` header so OpenClaw treats HA Ingress traffic as local.

---

## [0.7.11.11] — 2026-09-23

### Changed

- **Rollback to v0.7.11.3:** the nginx/Ingress changes from v0.7.11.4–v0.7.11.10 broke the ControlUI WebSocket through Nabu Casa. Reverted to the last working state.

---

## [0.7.11.3] — 2026-09-20

### Fixed

- **OpenAI-compatible endpoint for HA Assist pipeline:** the `/v1/chat/completions` endpoint was returning `500` because `buildAgentCommandInput` did not pass the resolved `agentId`. Patched at build time.

---

## [0.7.11.2] — 2026-09-20

### Fixed

- **Docs/Info tab showing placeholders:** version, gateway status, and ingress status were unrendered in the landing page. Fixed.

---

## [0.7.10.31] — 2026-09-12

### Fixed

- **Ingress base-path fallback for Companion App iframe:** when HA Supervisor does not pass `X-Ingress-Path`, the ControlUI now reads the base path from the browser URL instead of falling back to `127.0.0.1:18789`.

---

## [0.7.10.30] — 2026-09-12

### Fixed

- **Ingress base-path injection for OpenClaw 2026.9.4:** nginx now explicitly injects `data-openclaw-control-ui-base-path` on the `<html>` tag when missing. Fixes "Gateway not reachable" in the HA Ingress iframe.

---

## [0.7.10.29] — 2026-09-12

### Changed

- **OpenClaw 2026.9.4.**

---

## [0.7.10.28] — 2026-09-08

### Changed

- **OpenClaw 2026.9.3** and Node 24.20.0.

---

## [0.7.10.25] — 2026-09-05

- No changes; placeholder release.

---

## [0.7.10.17] — 2026-09-04

### Fixed

- **Ingress WebUI assets with OpenClaw 2026.8.2:** `<base href="/">` caused assets to resolve against the HA origin instead of the Ingress path. nginx now rewrites it to the Ingress base path.

---

## [0.7.10.2] — 2026-09-04

### Fixed

- **Ingress WebUI with HTTPS gateway:** nginx now proxies `/webui/` to `https://127.0.0.1:18789/` when the gateway runs in `lan_https` mode.
- **TUI startup:** `openclaw tui` now starts with `--session agent:coding-main:main` for OpenClaw 2026.8.2 multi-agent requirement.

---

## [0.7.10.1] — 2026-09-04

### Fixed

- **TUI startup:** `openclaw tui` now starts with `--session agent:coding-main:main` to satisfy OpenClaw 2026.8.2 multi-agent requirement.
- **Ingress base-path injection:** nginx `sub_filter` now injects the HA Ingress base path for both terminal enabled states.
