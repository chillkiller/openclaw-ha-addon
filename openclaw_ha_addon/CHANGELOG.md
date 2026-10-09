## [0.7.13.4] - 2026-10-09

### Security
- **Verified root command-execution via `gateway_remote_url` removed (audit):** `start_openclaw_runtime` eval'd Python-printed shell assignments; `urlparse` preserves `$(...)`/backticks in hostnames, so `gateway_remote_url = "ws://a$(cmd)b"` executed `cmd` as root at boot. Fix: Python emits plain data (host/port/flag, one per line) consumed as quoted shell arguments — no `eval` anywhere in the parse path; hostname additionally restricted to shell-safe characters (`[A-Za-z0-9._:-]`). (`run.sh`)
- **Repo-committed gateway token eliminated (audit):** the ACPX helper bootstrapped `openclaw.json` with the literal `PLACEHOLDER_ONBOARDING_TOKEN` (public in the repo); the post-onboard render loop treated any non-empty token as real and injected it as bearer auth in nginx, authenticating every Ingress client with a publicly known string. Fix: the duplicate helper bootstrap was removed entirely — run.sh is the single bootstrap owner and uses a per-install random token plus the correct internal gateway port per network mode (e.g. 18790 in `lan_https`) instead of hardcoded 18789; the helper only patches the `acp` section when the file exists. (`run.sh`, `oc_acpx_helper.py`)
- **Quarantine copy never clobbered + boot guard (audit round 2):** if `openclaw.json.corrupt` already existed, a new corruption silently replaced the recovery copy. Fix: the second quarantine gets a timestamped name; and run.sh refuses to bootstrap a stub when only a quarantined copy exists (that stub would silently replace the real configuration and permanently undo the quarantine — the boot fails closed with host-level repair instructions, since web terminal/nginx are intentionally not started in this state). (`oc_config_helper.py`, `run.sh`)
- **Unreadable ≠ corrupt (audit round 2):** a transient `EIO`/`EACCES` read error renamed a possibly-good config to `.corrupt`, bricking the next boot behind the corrupt-copy guard. Fix: only corrupt CONTENT (JSON/UnicodeDecodeError) triggers quarantine + exit; unreadable files exit 1 fail-closed WITHOUT renaming. (`oc_config_helper.py`)

### Fixed
- **Corrupt `openclaw.json` no longer overwritten with a minimal stub (audit, data loss):** parse failures fell back to `read_config() or {}` and a later write-back replaced the whole config (provider keys, agents, plugins) by a gateway-only stub. Fix: a corrupt config is quarantined as `openclaw.json.corrupt` and the helper exits 1 — never overwritten. All JSON writes (`oc_config_helper.write_config`, `oc_acpx_helper.write_json`, the run.sh first-boot bootstrap) are now atomic (temp + rename). (`oc_config_helper.py`, `oc_acpx_helper.py`, `run.sh`)
- **HEALTHCHECK failed in `tailnet_serve`/`tailnet_funnel` (watchdog restart loop):** the probe used plain HTTP against the gateway port, which serves HTTPS in both tailnet modes; a healthy container was flipped `unhealthy` after 4 probes. Fix: the healthcheck reads `gateway.tls.enabled` from the persisted config and probes `https://` with `--no-check-certificate` in TLS modes. (`Dockerfile`)
- **`gateway_env_vars` could override app-validated runtime variables (audit H):** `is_reserved_gateway_env_var` did not reserve `TERMINAL_PORT`, `GATEWAY_INTERNAL_PORT`, `HTTPS_PROXY_PORT`, `CERTS_DIR`, `ACCESS_MODE`, `INGRESS_PORT` and the other runtime control variables — overriding them (schema-valid for `gateway_env_vars`) bypassed the run.sh port/`nginx`-injection guards. Fix: all runtime control variables are reserved (round 2 added the remaining app-derived ones: `TAILSCALE_MODE`, `GATEWAY_ADDITIONAL_ALLOWED_ORIGINS`, `MDNS_MODE`, `CONTROLUI_DISABLE_DEVICE_AUTH`, `ACPX_ENABLED`); `render_nginx.py` additionally validates every port (`GATEWAY_INTERNAL_PORT` mandatory — it fills 16 proxy_pass directives; ASCII digits 1-65535 only, `str.isdigit()` also accepted Unicode digits like `²`), `CERTS_DIR` and the token charset before rendering. (`run.sh`, `render_nginx.py`)
- **Helper failures logged "exit code 0" and exited 0 (audit):** `rc=$?` captured the exit status of the `if !` negation — real config-helper failures caused a silent exit-0 crash-loop before nginx/ttyd started. Fix: rc captured from the helper itself. (`run.sh`)
- **ACPX helper error line was unreachable (audit round 2):** the helper logged npm/patch failures but still exited 0, so run.sh's new `ACPX harness initialization failed (exit $?)` could never fire. Fix: `main()` now returns 1 on real failures (npm install failure, config unreadable/unwritable); run.sh logs and continues non-fatally. Also: `write_json` cleans up its `.tmp` file when a dump fails mid-write, and `patch_openclaw_config()`'s docstring no longer documents the removed bootstrap behavior (it would invite a maintainer to remove the actual run.sh bootstrap owner). (`oc_acpx_helper.py`)
- **Bogus "exit code 127" persisted on supervised restarts (audit round 2):** the fix only covered the initial start; when a loop-retry `start_openclaw_runtime` failed, the stale (already reaped) `GW_PID` stayed set with `GW_IS_CHILD=true` and the next iteration `wait`ed on it. Fix: a failed restart clears `GW_PID` / sets `GW_IS_CHILD=false`, mirroring the failed-initial-start state. (`run.sh`)
- **Failed TLS cert regeneration no longer fakes success (audit round 3):** with a stale `gateway.crt` from the previous boot still present, the `[ -f gateway.crt ]` success gate passed after BOTH openssl attempts failed and markers/INFO claimed the NEW IP/SANs for the OLD certificate (permanent hostname-mismatch TLS errors, never regenerated). Fix: the previous cert and its `.cert_*` markers are removed before generation — a failed run leaves no cert (loud nginx failure + regeneration next boot). (`run.sh`)
- **ACPX `node_modules` gap (audit round 3):** `need_install` compared only `package.json` strings; a failed first `npm install` left a matching `package.json` and every later boot took the "already up to date" path with `node_modules` absent — harnesses silently broken until a version pin changed. Fix: the managed node project also checks for `node_modules/@openclaw/acpx` (reinstalls when missing/failed). (`oc_acpx_helper.py`)
- **Remaining `gateway_env_vars` overridable closed (audit round 3):** the last option-derived runtime variables (`ENABLE_OPENAI_API`, `BLOCKED_HOSTNAMES`, `AUTO_CONFIGURE_MCP`, `TRACE_LOG_TO_CONSOLE` — whose override flipped `set -x` and echoed token/key exports into the log — `GATEWAY_LOG_TO_CONSOLE`) are now reserved. The bootstrap heredoc falls back to 18789 on a non-numeric `GATEWAY_INTERNAL_PORT` instead of dying on the first boot. (`run.sh`)
- **Stale ControlUI origins pruned (audit):** `allowedOrigins` was union-merged each boot, so origins from old LAN IPs survived DHCP changes forever. Fix: deterministic replace (config-derived defaults + `gateway_additional_allowed_origins` user extras); pruned entries are logged so hand-added origins can be re-added via the option. (`oc_config_helper.py`)
- **Boot-killing cert pipeline hardened (audit):** unsupported SAN hosts (IDN/IPv6/special chars) reached the unguarded `openssl x509 -extfile` step and aborted boot via `set -e`. Fix: SAN hosts are charset-validated, unsupported ones are skipped with a warning, and cert generation falls back to base SANs instead of killing boot. (`run.sh`)
- **Minor boot-logic fixes:** ingress-port-in-use check now actually runs (single-quoting bug); `GW_IS_CHILD` no longer forces `true` after a failed initial start (bogus "exit code 127" log); the post-onboard re-render subshell releases the startup lock (fd 9); `umask 077` no longer leaks past the HA-token write; `NODE_PATH` no longer gains a trailing colon (CWD in module resolution); timezone fallback aligned with the option default (`Europe/Berlin`); `oc-cleanup` no longer dies on EOF (`read ... || choice=q`); `NETWORK_MODE` now reaches the rendered Docs page. (`run.sh`, `oc-cleanup.sh`)

### Docs
- `SECURITY.md` rewritten for the 0.7.12.3+ `network_mode` presets (previously instructed `gateway_bind_mode`/`allow_insecure_auth`, which no longer exist), with a preset table and a Supported Versions section. `DEPLOYMENT.md` RAM section now documents the RAM-adaptive heap (8192/6144/4096/2048 MB by host RAM); duplicate 0.7.12.7 changelog bullet removed; `Dockerfile` `io.hass.version` label synced to the release version.

## [0.7.13.3] - 2026-10-09

### Fixed
- **Boot unbound-variable kill in the 0.7.13.2 ambient-env routing (day-zero, 2026-10-09):** `run.sh` line 81 read `$ANTHROPIC_API_KEY` under `set -euo pipefail`; the variable is not preset in the addon container (no real Anthropic key configured), so every start failed with `line 81: ANTHROPIC_API_KEY: unbound variable` and the watchdog cycled (21:34-21:45, supervisor stop/start actions, container never reached nginx/gateway stages). Fix: POSIX-safe default expansion `${ANTHROPIC_API_KEY:-}` — unset/empty still triggers the intended Ollama routing, a configured key is respected. Proven in `bash -u` (negative control: old form -> rc 127 with the byte-identical error; fixed: unset->fallback, set->keep-real, empty->fallback); `bash -n` OK; repo-wide `set -u` conditional-read sweep found no additional unguarded reads (`env_count`, `max_env_vars`, `HA_TOKEN` etc. are all assigned before use).

## [0.7.13.2] - 2026-10-09

### Changed
- **ACP harness modernization (B9):** removed all three custom ACP wrappers (`claude/codex/opencode-acp-wrapper.mjs`) plus `oc_provider_env.mjs` — the acpx plugin generates passthrough wrappers at gateway start and custom wrappers cannot survive that regeneration (they were repeatedly clobbered at 18:04/earlier). Provider routing now flows through ambient environment exports and config templates:
  - `run.sh` exports `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` (default `glm-5.3-flash:cloud`, override via `OLLAMA_ACP_MODEL`) when no real `ANTHROPIC_API_KEY` is present — Claude Code reaches the local Ollama backend with zero wrapper or key files (proven end-to-end: `end_turn` against Ollama, 17.4k tokens).
  - New template `acpx/.codex-source/config.toml`: codex provider routing to Ollama (`garon_ollama`, `wire_api = "responses"`, `requires_openai_auth = true` reading `auth.json`), `sandbox_mode = "workspace-write"`, trusted project entries. TOML model ids carry **no** `ollama/` prefix; opencode JSONC refs keep the prefix. Placeholders only — real endpoints live in runtime env, never committed.
  - New template `acpx/opencode.jsonc`: OpenCode provider via OpenAI-compatible `baseURL` with role model token.
  - `oc_acpx_helper.py`: role-differentiated model deployment (`__CODEX_MODEL__` for codex/audit, `__OPENCODE_MODEL__` for opencode/forge), env-overridable via `OLLAMA_CODEX_MODEL` / `OLLAMA_OPENCODE_MODEL`; harness config deploy now targets the acpx inheritance source (`/config/.codex`) instead of the regenerated `codex-home` (fixes recurring config-clobber root cause); dead code removed (`make_executable`, `find_installed_acp_binary`) per audit run.
  - Verified by 4 live audit runs through the real gateway (codex harness on `kimi-k2.7-code:cloud`): sandbox/trust gating fixed (sandbox_mode + trusted project entries are runtime gates in the operative codex config), one real defect found and fixed (dead code), template/placeholder consistency re-audited clean (run 4: zero findings).

## [0.7.13.1] - 2026-10-09

### Fixed
- **Boot exit-3 loop on real `options.json` (0.7.13 day-zero, 2026-10-09):** the safety-net option reads used the invented jq builtin `|number`. On any `options.json` that actually contained `upgrade_backup_keep` / `gateway_doctor_repair_max` (both present by default), jq refused to compile the program ("number/0 is not defined", exit 3) and `set -euo pipefail` ended the start before nginx/gateway could run - watchdog restart loop with ExitCode=3 (~10 cycles 05:26-05:31). Fix: real builtin `tonumber` + explicit `!= null` guard per the V7 has-guard pattern (missing key -> default 3, null -> default 3, string `"5"` -> 5, explicit `0` -> 0). Empirical proof in the 0.7.13 image (jq 1.6): old program -> exit 3 on the real options.json (negative control), new program 6/6 probes green, `bash -n` OK, repo-wide `|number` sweep negative.

## [0.7.13] - 2026-10-09

### Changed
- **OpenClaw pin 2026.9.8 → 2026.9.9** (v0.7.13 delta analysis, tarball-verified 2026-10-09):
  - **Verification before the bump:** `resolveThresholds` (memory threshold calibration) byte-identical between 2026.9.8 and 2026.9.9 dist tarballs — our RAM-adaptive heap ladder stays correct; exit-classifier token counts identical (AbortError×3, ECONN×2, fatal×5, network×1, sqlite×5, watch×10); npm engines unchanged (`>=24.16.0 <25 || >=26.1.0`, Node 24 compliant); no schema retirements, no option renames, no controlUi/allowedOrigins/device-auth/CSP/health-endpoint changes; openai-http agentId fix present natively (dist/openai-http-CQ7X8xZA.mjs).
  - **Patch anchors re-verified against the real 2026.9.9 dist:** unicode-guard applies 8/8 sites (4+4), 5/5 `node --check`, universality sweep 0 residues across 9160 dist files, exit 0; undefined-rejection shim registry symbol present in the new dist (upstream still ships no equivalent — the shim stays required).
  - **Upstream gains for our restart-heavy profile:** failed-update recovery hardening (#164497/#164724), restart-recovery triage retry (#160173), Docker upgrade-loop fix reusing verified rollback backups (#162305), doctor session-archive repair imports (#164867), quarantined-database respect + WAL-preservation guidance (#161783), long memory-checkpoint no longer stalls channel replies (#137359), scheduled-job isolation.
  - **Watch items (no action):** gateway token storage trend toward the secret store (#162372) — our helper still writes the bootstrap token directly; Telegram `/controlui` vs `/dashboard` split (irrelevant behind HA Ingress).

### Added
- **Pre-upgrade state backup gate (TechArtDev 0.5.94 parity):**
  - `backup_upgrade_state()` + `upgrade_backup_gate()` in `run.sh`: on any detected version change, archives `openclaw.json` + `state/` + `agents/` (WAL files included; SHM/locks/corrupt files excluded) to `/config/.openclaw/upgrade-backups/openclaw-state-<version>-<stamp>.tar.gz` (chmod 600) before the gateway starts.
  - Runs inside `start_openclaw_runtime()` so every attempt (initial + supervised restarts) is covered; skip-on-fail integrates with the hardened restart backoff.
  - **Options:** `abort_on_upgrade_backup_failure` (bool, default true — data fail-closed: no start into the new version without a complete archive; container stays up with nginx/terminal so the operator can free disk), `upgrade_backup_keep` (int, default 3, pruning keeps the newest).
  - **Rationale:** upstream verified backups engage only while the gateway starts; a boot that dies during its own migration (proven 2026-10-04/05 crash-loop: 130 restart cycles, corrupted state DB, manual SQLite surgery) previously had no honest rollback path.
- **Automatic doctor repair after consecutive start failures (TechArtDev 0.5.90 parity, BACKLOG V16/B4):**
  - After 2 consecutive failed starts, the repair runs in the restart path only — with openclaw.json snapshotted first — invoking `openclaw doctor --fix --non-interactive --yes`; budget `gateway_doctor_repair_max` (int, default 3, 0 disables) per app start; local modes only (remote mode never repairs a foreign gateway).
- **Three new schema options** (all with jq `has()` guards — explicit false/0 wins per the V7 lesson): `abort_on_upgrade_backup_failure`, `upgrade_backup_keep`, `gateway_doctor_repair_max`.

### Fixed
- **Restart storm hazard removed (TechArtDev 0.5.90 parity, BACKLOG V16/B8):**
  - Flat `sleep 2` replaced by exponential backoff `2^streak` capped at 60s; streak resets only when the previous boot survived ≥ 120s (measured at exit detection time, not after the ~20s self-restart detection sleeps — measuring after sleeps was the peer's pinned-at-2s bug).
  - Failure-streak telemetry in the log line (exit code + streak + backoff); loud diagnostic hint after 5+ consecutive failures.

### Changed (config hygiene)
- **Retired key no longer written (BACKLOG V8/B2):**
  - `oc_config_helper.py::set_control_ui_origins` now REMOVES `gateway.controlUi.dangerouslyDisableDeviceAuth` from the gateway config instead of writing it every boot (retired + ignored upstream since 2026.9.8: lint rule says "retired and ignored", doctor deletes it). Ends the boot-time fight with `openclaw doctor --fix`.
  - `controlui_disable_device_auth` option kept (config compatibility), marked deprecated in the comment; all six translation descriptions now describe the real behavior (device-flow pairing in every mode, no 1008 exception). Their earlier text promised a pairing-skip the gateway no longer honors.

### Security
- Both 0.7.12.7 security controls re-verified against the 2026.9.9 dist (unicode-guard patch green live against the actual tarball; shim registry present). No new ingest boundaries introduced in 2026.9.9.

### Deliberately open
- The undefined-rejection crash-loop root cause (§ REPAIR_STATUS 12.1 factor C) is NOT fixed upstream in 2026.9.9 (0 changelog hits); the shim + the three safety nets above remain the mitigation.

## [0.7.12.7] - 2026-10-08

### Security
- **OWASP LLM01:2026 Control #5 — context-sensitive invisible-unicode stripping at every external-content ingest boundary:**
  - **Gap in OpenClaw 2026.9.8:** `web_fetch` texts were stripped with a naive character-class strip (`INVISIBLE_UNICODE_RE`) that unconditionally removed U+200D (ZWJ) — breaking valid emoji sequences — and left isolated variation selectors (U+FE00–U+FE0F, a documented smuggling channel, Rehberger 2024/2025) untouched; `web_search` results (titles/snippets/answer/citations) were not stripped at all.
  - **Fix — build patch `unicode-guard/`** (runs in the Dockerfile after `npm install -g openclaw@2026.9.8`): `apply-unicode-guard-patch.mjs` splices the tested implementation from `strip-invisible-unicode.mjs` (single source of truth) into ALL naive copies in the dist tree — the unicode-visibility module, the gateway bundle AND the minified worker bundles `dist/worker/worker.mjs` + `dist/worker/sqlite-store.worker.mjs` (audit F1: independent copies of both targets, including Email/Webhook hook session logic; design decision: Option B over an exception list).
  - **Coverage:** also patches `sanitizeExternalContentText` — the funnel for wrapExternalContent/wrapWebContent and thereby web_search, web_fetch spill, Email/Webhook/Cron/Browser/Channel metadata — so every external-content boundary strips before prompt rendering.
  - **Context-sensitive stripping:** VS16 after an emoji base, keycaps and ZWJ sequences survive; the tag block U+E0000–U+E007F, isolated VS, ZWSP/ZWNJ/word joiner/FEFF and bidi controls are removed.
  - **Verification:** anchors byte-exact at top level plus whitespace-/parameter-tolerant regex anchors for the minified worker copies (captured parameter reused in the replacement); idempotent; every patched file secured with `node --check`; a post-patch universality sweep over the entire dist tree fails the build loudly on ANY naive remainder (audit N1b: silent exit 0, hence closed); when upstream fixes this natively, the sweep deliberately fails as the decision trigger for patch-block removal.
  - **Tests (15):** 8 spec vectors + edge cases + dist verification against patched modules, including real `web_fetch` extraction and worker-splice byte identity (vector 7: clean 56 KB ≈ 3 µs/call, polluted 59 KB ≈ 1.6–6 ms/call).
  - **Behavior + tradeoffs** (subdivision flags, ZWNJ orthography, CJK SVS): `unicode-guard/README.md`. Gateway config unchanged; long-term upstream path noted.

### Fixed
- **Healthcheck kill on clean Pi boot fixed (HEALTHCHECK start-period 120s → 420s, retries 3 → 4):**
  - **Evidence:** Supervisor log 2026-10-07 19:41:39 — "Watchdog found app OpenClaw Assistant is unhealthy, restarting…" + docker kill exit 137 despite a clean boot.
  - **Root cause:** Homebrew sync, skill copy and gateway init can take >4 minutes on the Pi; the old 120s window expired before the gateway answered `/startupz` — 3 consecutive fails marked the container unhealthy, the Supervisor watchdog killed it (ONE mechanism, no second kill path).
  - **Fix semantics:** fails within the Docker start-period grace window do not count against the retries — the kill ring for slow but clean boots is closed; genuine hangs stay quickly detected (4 consecutive fails at 30s intervals after the start period).
- **V21 — external WebUI button ("WebUI ↗") now always targets the same-origin ingress URL:**
  - **Old defect:** the button carried the statically rendered `__GATEWAY_PUBLIC_URL__` (render_nginx.py auto-constructed from `hostname -I` → a borrowed LAN IP while option `gateway_public_url` is empty) and was unusable from the internet (Nabu Casa/DyndNS).
  - **Why same-origin is always correct:** since the 0.7.12.1 ingress lockdown the landing runs exclusively inside the HA ingress session (local + external via Nabu/DyndNS identical — the inline tab is the proof path).
  - **Implementation** (GaRoN spec 2026-09-26 17:36): client-side on load, `btnWebuiExternal.href = './webui/#token=' + <token>` with autologin parity to the inline tab — same `GATEWAY_TOKEN` placeholder (render_nginx.py substitution), same `#token=` mechanism, same guard against unreplaced placeholders; static no-JS fallback `./webui/`.
  - **Deliberate drops:** LAN-18789 ingress bypass removed (functionally irrelevant); NO Python/nginx touch — render_nginx.py unchanged, its `__GATEWAY_PUBLIC_URL__` replace becomes a no-op; placeholder inventory confirmed.
  - **Companion item:** a DyndNS origin for `allowedOrigins` proceeds separately as an add-on option.


### Added
- **`sshpass` baked into the image (apt zone 1, next to openssh-client):** sshpass previously existed only as a runtime post-install inside the running container and was lost on every rebuild/container swap (password-based SSH to the host then dead again without `apt-get install sshpass`). Debian bookworm/main arm64: the package exists, verified live via `apt-cache policy` (sshpass 1.09-1); zone-1 syntax consistent with the openssh-client line.

## [0.7.12.6] - 2026-10-07

### Fixed
- **Import check switched to `importlib.metadata`:** crawl4ai 0.9.4 exports `__version__` as a submodule (not a string) — the first Supervisor build failed with `TypeError: can only concatenate str (not "module") to str` in the version-echo line. The 0.7.12.5 predecessor carried the same bug, hidden behind `2>/dev/null || echo "version check failed"`. `version("crawl4ai")` (stdlib) is stable within the package and verified live (0.9.4).
- **Dangling `/usr/bin/chromium` on every arm64 rebuild (P1)**:
  - **Failure mode:** Playwright ≥1.63 installs arm64 Chromium to `chromium-<rev>/chrome-linux-arm64/`; the Dockerfile symlink glob hardcoded the x64 layout (`chromium-*/chrome-linux/chrome`), matched nothing on arm64, and `ln -sf` silently produced dangling symlinks — masked by the trailing `|| echo 'version check failed'`.
  - **Effect:** every rebuild shipped green with a dead OpenClaw browser tool (`browser.executablePath not found: /usr/bin/chromium`) while the binary existed at `/opt/ms-playwright/chromium-1243/chrome-linux-arm64/chrome`.
  - **Fix:** shared resolver `browser_links.sh` → `/usr/local/bin/link-playwright-chromium` — layout-agnostic `find` (path `chromium-*/chrome-linux*/chrome`, highest revision wins via `sort -V`), re-links `/usr/bin/chromium` + `/usr/bin/chromium-browser`, and fails the build hard when no executable is found.
- **crawl4ai browser-revision drift**:
  - Crawl4ai 0.9.4 launches through both `playwright` and `patchright` (browser_manager.py, browser_adapter.py and install.py reference patchright); both pin Chromium revision 1243 today, but browsers were only downloaded in the playwright layer — a future crawl4ai bump upgrading playwright/patchright would resolve revisions never present in `PLAYWRIGHT_BROWSERS_PATH` (green build, broken crawls). The crawl4ai layer now re-runs `playwright install chromium` and `patchright install chromium` (idempotent no-ops at revision parity) and refreshes the links via the shared resolver.
- **Stale Dockerfile comment**: claimed `run.sh` symlinks `/config/.cache/ms-playwright -> /opt/ms-playwright` at runtime — no such code ever existed, and `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright` makes it unnecessary. The comment now describes the real mechanism.

### Added
- **Boot self-heal in run.sh**: before the browser-config ensure step, run.sh re-runs the linker whenever `/usr/bin/chromium` is missing or non-executable, so future layout changes or rebuilds self-repair at start; a loud WARN (carrying the resolver's own error) replaces silent failure.

### Changed
- **Version pins** (owner-approved 2026-10-07): `crawl4ai==0.9.4`, `playwright==1.63.0`, `patchright==1.63.0` — all three were the PyPI latest at survey time, so nothing is lost today; pins move updates from build-time chance to deliberate release steps (survey + audit + owner GO), giving reproducible images.

### Expectation map (the durable contract)
- OpenClaw consumes `/usr/bin/chromium` (`browser.executablePath` in `openclaw.json`; CDP transport, no Python involved).
- crawl4ai consumes revision-matched builds under `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright` via Python `playwright`/`patchright` (system packages; the persistent `/config/clawd/.venvs/crawl4ai` stays user-managed, currently the same revision).
- Under `/opt/ms-playwright` the revision directory is the single source of truth; `/usr/bin/chromium` is only an alias, maintained at build and boot — never by hardcoded globs.

## [0.7.12.4] - 2026-10-03

### Performance
- **RAM-adaptive Node.js heap budget:**
  - **Root cause (dist-verified):** OpenClaw derives its memory-pressure warning threshold from the heap limit (`rssWarningBytes = max(1536 MB, heapLimit * 0.5)`); the static 4096 MB budget on hosts with 12+ GB RAM kept the gateway's normal working set (~2.2–2.4 GiB, 13–14 workers) permanently above the 2048 MB threshold, so cooperative yields stalled `sessions.list` for 5+ seconds on every Control UI first load.
  - **Change:** the heap is now sized from host RAM at boot — ≥24 GB → 8192 MB, ≥12 GB → 6144 MB, ≥8 GB → 4096 MB, below → 2048 MB; on this host the threshold rises to 3 GiB, above the working set.

### Fixed
- **🩹 Server TLS certificate generation restored (P0)**:
  - **Defect:** the v0.7.10.0 network-mode refactor accidentally dropped the server-cert generation inherited from the original run.sh (only the local CA survived); nginx terminates TLS on :18789 with `/config/certs/gateway.crt` and `gateway.tls` is disabled, so **fresh lan_https installs had no server certificate at all** and DHCP IP changes never regenerated it.
  - **Restored:** SAN certificate covering LAN IP, loopback, homeassistant(.local) plus origins from `gateway_additional_allowed_origins`/`gateway_public_url`, regenerated on IP or SAN change, gated to the HTTPS-proxy modes.
  - **Hardened (X.509v3):** CA and server cert carry `basicConstraints`, `keyUsage` and `extendedKeyUsage` (serverAuth) so strict clients (Python `requests` with `verify=`, OpenSSL strict) accept them; pre-0.7.12.4 certificates regenerate once via a `.cert_ext` marker.
- **Boolean option reads (`jq // true` trap)**: `jq`'s `//` alternative fires for an explicit `false` just like for a missing key, so six boolean reads (`enable_terminal`, `enable_webui`, `enable_docs`, `controlui_disable_device_auth`, `force_ipv4_dns`, `acpx_enabled`) silently reverted the user's OFF choice to the default on every start. All reads now use `if has(...)` so an explicit `false` survives (same fix the peer add-on shipped in their 0.5.88).
- **502 during gateway startup**: the `/webui` locations now intercept 502/503/504 and serve the loading page, which explains that the terminal is already usable while the gateway finishes its multi-minute SQLite warmup (previously a raw 502 flooded the supervisor log and confused users).
- **nginx warning**: removed the duplicate `sub_filter_types text/html` declaration (the default is already text/html) that produced a "duplicate MIME type" warning on every config test.

### Changed
- **OpenClaw 2026.9.8** (from 2026.9.6; tarball-verified: the OpenAI `agentId` fix remains native in `dist/openai-http-E_fP_MwD.mjs` L386/400
  - Node requirement `>=24.16.0 <25 || >=26.1.0` satisfied by the image's Node 24; no schema migrations — upgrade is low-risk). Release highlights for this setup: GPT-6.1 Sol model, Codex catalog processes on demand (RAM reduction), delegated results tied to their conversation, container update hardening, Control UI tab retention across updates. Note for multi-agent teams: internal sessions can no longer end with `NO_REPLY` and automatic peer back-and-forth/announcement turns were removed — explicit `sessions_send` coordination (as used here) is unaffected.
- **`openssh-client` added to the image**: the official OpenClaw Dockerfile documents that the sandbox backend spawns `ssh` directly; the app image never shipped an `ssh` binary, so every SSH-based agent capability (SSH gateway connections, paired-node diagnostics, host access) failed with `command not found`. SSH-based tools now work out of the box.
- **Supervisor watchdog** (`tcp://[HOST]:49200`): the Supervisor restarts the app when the Ingress front door stops answering. The probe originates from the Supervisor network (172.30.32.0/23), which the 0.7.12.1 lockdown allowlist explicitly permits.
- **`backup_exclude`** (Home Assistant backup size reduction): regenerable caches and toolchains are excluded from HA backups — `.linuxbrew`, `.node_global`, `.npm`, `.cache`, `.node-compile-cache`, `__pycache__`, `*.jsonl.lock` (verified present on this install: ~12 GB combined). User state (openclaw.json, agent databases, skills, sessions, clawd workspace, keys, certificates) is always backed up.
- **Configuration diet (audited, 36 → 30 options)**: removed the dead `router_ssh_host`/`router_ssh_user`/`router_ssh_key_path` options (their only consumer was an info dump in `/config/CONNECTION_NOTES.txt`) and hardcoded `cron_skip_missed_jobs` (true is always right for an HA app that restarts frequently; also the live victim of the `jq` trap: an explicit `false` was being silently ignored) and `clean_session_locks_on_start/exit` (always-on is the only sane default) — no behavior change, fewer knobs.

### Upgrade notes
- After updating, open the app configuration once and save to drop the removed options from the supervisor store (clears the last schema warnings).
- A pre-upgrade database backup was taken and verified before this release (32/32 SQLite files, WAL-consistent copy + integrity check via node:sqlite; the system Python's SQLite 3.40.1 cannot check 2026.9.6+ schema-23 databases that use `octet_length()` — see the two-stage backup recipe).
- Verified pre-push: sandbox-rendered nginx config (`nginx -t` OK), `bash -n` on all scripts, YAML parity across all six translations against the cleaned schema, no remaining `jq // true` boolean reads, certificate regeneration marker in place.

## [0.7.12.3] - 2026-09-26

### Changed
- **Terminology: Add-ons → Apps** (HA 2026.2 renamed add-ons to apps; upstream keeps slugs, `addon_config` mounts, `/addons` Supervisor API endpoints and repo URLs as technical identifiers — see home-assistant/architecture discussion #1287): all user-facing strings in this project now say "app" — README/README.de, DOCS.md, SECURITY.md, CONTRIBUTING.md, DEPLOYMENT.md, config comments, all six UI translations, landing/docs pages, runtime log messages, oc-cleanup output.
- **Translation fix (es/bg/pl/pt-BR)**: `mdns_host_name` descriptions claimed the default hostname is "openclaw-ha-addon"; the actual default is `openclaw` (run.sh `jq … // "openclaw"`).

## [0.7.12.2] - 2026-09-26

### Performance
- **Ingress asset compression restored**: the static ControlUI locations (`/webui/assets/`, `/themes/`, `/favicon`, `/apple-touch-icon`, `/manifest.webmanifest`) now pass the client's `Accept-Encoding` through to the gateway instead of forcing `identity`. The gateway serves brotli/gzip natively (measured: 468 KB → 138 KB for the largest bundle, 3.4× less transfer per cold load; ~1 MB total). The `/webui/` HTML locations keep `identity` because `sub_filter` requires uncompressed responses; the `= /webui` WebSocket bridge is untouched.

### Fixed
- **CSP synced with upstream 2026.9.6** (`buildControlUiCspHeader`, dist-verified): added `frame-src 'self' http: https:` (link-preview iframes were blocked), `img-src https:` (remote agent avatars were blocked), `connect-src data:`; replaced the over-broad `script-src 'unsafe-eval'` with `'wasm-unsafe-eval'` (bundle-verified: zero `eval`/`new Function` across all 8 ControlUI bundles, one WebAssembly consumer). `frame-ancestors 'self'` intentionally kept for the HA Ingress iframe; `'unsafe-inline'` for scripts kept because the sub_filter base-path injection cannot be hash-covered.

## [0.7.12.1] - 2026-09-25

### Security
- **Ingress lockdown**: nginx `:49200` now only accepts loopback and the HA Supervisor network (`172.30.32.0/23`). Direct LAN access to the terminal (previously an unauthenticated root shell) and the token-bearing landing page is rejected with 403; Terminal/TUI surfaces are exclusively reachable through the authenticated HA Ingress session. (P0)
- **nginx.conf permissions**: the rendered config embeds the gateway bearer token and is now written with `0600` instead of the umask default `0644`. (P1)

### Changed
- **Boot order inverted**: nginx and the web terminal now start BEFORE the OpenClaw gateway. The Ingress panel (Terminal as fallback surface) is reachable during slow gateway startup (SQLite session validation can take minutes); the gateway starts after the ingress proxy is serving.
- **TUI removed**: the `openclaw tui` iframe tab, its ttyd instance, and the `enable_tui`/`tui_port`/`tui_session` options are gone — the bash Terminal is the only fallback surface. Terminal is the default active tab.

### Fixed
- **Schema drift**: `cron_skip_missed_jobs` is back in the `schema:` block (dropped in a06a272 while remaining in `options:`), fixing the recurring supervisor warning `Option 'cron_skip_missed_jobs' does not exist in the schema`.
- **CRLF pollution**: `oc_config_helper.py` had CRLF line endings in the worktree (Git index LF); renormalized so image builds copy the exact committed bytes.
- **Dead code removed**: the `docs/index.html` copy block in run.sh never executed (Dockerfile ships `docs/index.html.tpl`, rendered by render_nginx.py); TUI assets are no longer copied.

### Added
- **Translations**: schema parity for all 6 languages (en/de/es/bg/pl/pt-BR) — every schema option now has a name/description (`acpx_enabled`, `blocked_hostnames`, `cron_skip_missed_jobs`, `enable_docs`, `enable_webui`, `enable_openai_api`, `force_ipv4_dns`, `nginx_log_level`, `network_mode`, `ollama_base_url`); stale keys for options that no longer exist (`gateway_bind_mode`, `access_mode`, `gateway_auth_mode`, `mdns_service_port`, `mdns_interface_name`) removed from es/bg/pl/pt-BR.
- **Audit hardening** (coding-review NO-GO findings, fixed pre-merge): a failed gateway start no longer exits the container — nginx and the terminal stay up and the supervisor loop retries (P1); duplicate `__SHOW_TERMINAL_JS__` replacement removed (P1); hardcoded `127.0.0.1:18790` in the `location = /webui` WebSocket bridge replaced with `__GATEWAY_INTERNAL_PORT__` so `gateway_port` changes no longer break the no-slash reconnect path (P2).

> **Upgrade note**: stored add-on options from previous versions may still contain `enable_tui`, `tui_port` and `tui_session`. Until the next options save, the supervisor may log benign `Option ... does not exist in the schema` warnings for these keys. Open the add-on Configuration page once and save to prune them permanently.

## [0.7.12.0] - 2026-09-25

### Changed
- **OpenClaw**: Update to `2026.9.6` (from 2026.9.5). Major upstream improvements relevant to this add-on:
  - **Restart recovery**: unfinished conversations survive restarts with saved history, progress and tool results; interrupted subagents are continued by the leading agent instead of auto-relaunching (fixes the recurring boot-time "Cannot delete session while competing work is in flight" zombie sessions).
  - **Slow-startup detection**: health/restart checks now distinguish "still starting" from "failed" (exit code 2 = starting). Directly mitigates the SQLite session-reclamation startup timeout on high-usage SD-card installs.
  - **`openclaw doctor --session-sqlite recover`**: new repair tool for session databases.
  - **Storage compaction** (agent schema 23, shared-state schema 18): lossless history compression + compact memory vectors. Migration is one-way — downgrades require the pre-upgrade backup. A full WAL-consistent backup of all 31 agent/state DBs was taken before this release (integrity-verified).
  - **WebChat reconnect resilience**: chat stays usable during reconnects; "Forget this browser" in Settings → Connections resets stale browser sign-ins (the tool we were missing during the localStorage debugging).
  - **KillMode=mixed systemd policy repair** via Doctor (resolves the long-standing stale service-unit warning).
- **Dockerfile**: no agentId patch block needed — the openai-http agentId fix remains native in 2026.9.6 (tarball-verified).

### Notes
- Ingress fixes from 0.7.11.15.x (asset paths dbc00fe, localStorage cleanup 0d32951, /webui WS proxy d037bd1) are all retained and unaffected by the OpenClaw bump.
- Verified against the full 2026.9.6 changelog: no changes to loopback Host-header validation (proxy_attribution), controlUi.basePath, Ollama provider, or gateway auth model. Only breaking change is TypeScript-only code cells (not used by this setup).
- Disk usage at release time: 84% (37GB free). Old full backups under /share/backups (42GB) are cleanup candidates for future headroom.

## [0.7.11.15.3] - 2026-09-25

### Fixed
- **Nabu Casa / external "Gateway nicht erreichbar" after reconnects (the real killer)**:
  - **Root cause:** the ControlUI stores the gateway URL in its normalized localStorage form as `.../webui` *without* a trailing slash; after stripping the ingress prefix the Supervisor bridge forwards that exact path to nginx, whose config only had trailing-slash locations — so `/webui` fell through to an implicit 301 redirect to `/webui/`.
  - **Failure chain:** WebSocket clients never follow redirects — the supervisor completed the client-side 101 and then silently dropped the tunneled socket. First panel loads (via `/webui/`) worked; every reconnect after Nabu Casa idle disconnects (1006 every ~2 min) used the stored slash-less URL, died at the redirect, and landed in the "Gateway not reachable" connect dialog with an `ha-panel-app.ts:339 Uncaught (in promise) 3` crash.
  - **Fix:** explicit `location = /webui` proxies directly to the gateway (WebSocket headers included) instead of redirecting.
  - **Verified live:** GET `/webui` → 200 (was 301), WS upgrade `/webui` → 101, `/webui/` unchanged, panel load 200; confirmed end-to-end via Nabu Casa from the iOS Companion App. (d037bd1)

## [0.7.11.15.2] - 2026-09-24

### Fixed
- **Ingress ControlUI asset 404s (local + Nabu Casa)**:
  - HA Supervisor sends `X-Ingress-Path` *without* the `/webui` panel suffix. The previous maps built asset and base-path prefixes directly from that value, so the ControlUI bundle resolved assets as `/api/hassio_ingress/<token>/assets/...` — after the supervisor strips the ingress prefix those requests hit the nginx catch-all 404. New `$ingress_path_norm` map strips any trailing `/webui` (also defends against the 2026-09-22 double-`/webui` variant) and rebuilds **all** prefixes as `norm + "/webui/..."`. Direct nginx access without an ingress path keeps relative `./assets/` URLs. (dbc00fe);
- **Nabu Casa "Gateway nicht erreichbar" connect dialog**:
  - **Defect:** the injected cleanup script only removed localStorage `gatewayUrl`/`bootRecord` entries pointing at `127.0.0.1:18789`; browsers that cached a gateway URL with the bare Nabu host and no ingress path kept trying `wss://<slug>.ui.nabu.casa/` instead of the ingress route, so no WebSocket attempt ever reached the gateway.
  - **Fix:** the script now removes ANY entry whose value does not contain the current ingress base path, forcing the ControlUI to re-derive the WebSocket URL from the injected `data-openclaw-control-ui-base-path` attribute on every load. (0d32951)

### Notes
- Both fixes are nginx `sub_filter`/map changes only; no OpenClaw version, add-on startup, or gateway changes.
- Server-side verified live: ControlUI HTML + script tags resolve under `/api/hassio_ingress/<token>/webui/`, WebSocket upgrade with Nabu origin returns `101 Switching Protocols` + `connect.challenge`.

## [0.7.11.15.1] - 2026-09-23

### Fixed
- **Ingress WebSocket through HA/Nabu Casa**: Force loopback `Host` header in nginx `/webui/` proxy so OpenClaw 2026.9.5 treats HA Ingress traffic as local loopback.
- **Ingress asset loading**: Add unauthenticated nginx locations under `/webui/` for static assets, themes, favicon, apple-touch-icon and manifest, so HA Supervisor can fetch them without the add-on bearer token.
- **Ingress asset paths**: Remove duplicate `/webui` suffix from X-Ingress-Path base path maps so ControlUI builds correct asset URLs under `/api/hassio_ingress/<token>/webui`.

### Notes
- Conservative fix release based on 0.7.11.15. Only nginx configuration changed; no OpenClaw version or add-on startup changes.

## [0.7.10.25] - 2026-09-05

## [0.7.11.11] - 2026-09-23

### Changed
- **Rollback**: Revert add-on code base to v0.7.11.3, which was the last release where HA Ingress (including Nabu Casa remote access) worked reliably.
- **OpenClaw**: Stay on `2026.9.4` as included in v0.7.11.3.

### Notes
- This release intentionally does **not** include the nginx/Ingress changes from v0.7.11.4–v0.7.11.10, because those releases broke the ControlUI WebSocket connection through Nabu Casa Ingress.
- The OpenAI-compatible `agentId` patch for 2026.9.4 remains in place.
- If you are already on v0.7.11.10 and seeing “Gateway not reachable” through Ingress, install this update and reload the add-on store in HA (`Settings → Add-ons → Add-on Store → ⋮ → Reload`).


### Changed
- **OpenClaw**: Update to `2026.9.1`.
- **Add-on schema**: Add `cron_skip_missed_jobs` (default `true`) and `blocked_hostnames` options for OpenClaw 2026.9.1 configuration controls.
- **run.sh**: Log detected OpenClaw version at startup for easier support diagnosis.

### Fixed
- **Ingress WebUI asset loading**: `nginx.conf.tpl` already forces uncompressed upstream HTML and rewrites ControlUI asset paths; kept compatible with 2026.9.1. Verify after upgrade.

### Notes
- OpenClaw 2026.9.1 introduces `cron.skipMissedJobs` and `blockedHostnames`. Back up `/config/clawd` before first start after update.


## [0.7.10.17] - 2026-09-04

### Fixed
- **Ingress WebUI assets with OpenClaw 2026.8.2**: OpenClaw 2026.8.2 ships the Control UI with `<base href="/">`, which caused all assets to resolve against the Home Assistant origin and return 404 inside the Ingress iframe. nginx now rewrites `<base href="/">` to the HA Ingress base path and strips `Accept-Encoding` from the upstream request so `sub_filter` can operate on uncompressed HTML.

## [0.7.10.2] - 2026-09-04

### Fixed
- **Ingress WebUI with HTTPS gateway**: nginx now proxies `/webui/` to `https://127.0.0.1:18789/` when the gateway runs in `lan_https` / TLS mode, accepting the auto-generated self-signed certificate. Previously Ingress broke when `network_mode` was switched from `ingress_only` to `lan_https`.
- **TUI startup**: `openclaw tui` now starts with `--session agent:coding-main:main` for OpenClaw 2026.8.2 multi-agent requirement (0.7.10.1).
- **Ingress base-path injection**: nginx `sub_filter` now injects the HA Ingress base path for both `data-openclaw-terminal-enabled="false"` and `"true"` (0.7.10.1).

## [0.7.10.1] - 2026-09-04

### Fixed
- **TUI startup**: `openclaw tui` now starts with `--session agent:coding-main:main` to satisfy OpenClaw 2026.8.2 multi-agent requirement.
- **Ingress WebUI**: nginx `sub_filter` now injects the HA Ingress base path for both `data-openclaw-terminal-enabled="false"` and `"true"`, fixing WebUI inside HA Ingress.

## [0.7.9.28] - 2026-09-03

### Fixed
- **Homebrew install**: Robustified Homebrew installation path for Node 24 / OpenClaw 2026.8.2.

## [0.7.9.27] - 2026-09-02

### Changed
- **OpenClaw**: Update to `2026.8.2`.
- **Node.js**: Update from NodeSource `node_22.x` to `node_24.x`.
- **mcporter**: Add global install `mcporter@0.12.3` for MCP server auto-configuration.
- **node-llama-cpp**: Keep at `3.20.0` as requested.

### Notes
- This release follows the upstream 2026.8.x line. The 2026.8.x OpenClaw release migrates sessions/transcripts to SQLite; a full `/config` backup is required before first start after update.

## [0.7.9.26] - 2026-08-23

### Changed
- **Landing Page Titlebar Redesign**: Home Assistant Material Design 3 Stil mit korrigierten Farben. Alte Titlebar-Struktur mit Tabs oben beibehalten.
- **UX**: removed the HTTPS/secure-context warning banner inside the ingress.

### Fixed
- **Tab visibility**: tabs are shown/hidden correctly based on app configuration and iframe context.

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


## [0.7.10.29] - 2026-09-12

### Changed
- **OpenClaw**: Update to `2026.9.4`.
- **Add-on version**: Bump to `0.7.10.29`; Dockerfile and metadata aligned.

### Notes
- OpenClaw 2026.9.4 introduces safer rollback for compatible failed updates. Database migrations still require a verified pre-update backup; back up `/config/clawd` before first start after update.
- No new add-on schema options in this release.

## [0.7.10.28] - 2026-09-08

### Changed
- **OpenClaw**: Update to `2026.9.3`.
- **Node.js**: NodeSource `node_24.x` channel provides Node 24.20.0, satisfying the OpenClaw 2026.9.3 minimum requirement (Node 24.16.0+ on 24.x).

### Fixed
- **Release build correctness**: Previous 0.7.10.26/27 releases bumped the add-on version while the Dockerfile still installed OpenClaw 2026.9.1/2026.9.2. This release aligns add-on version, Dockerfile, and installed OpenClaw version.

### Notes
- OpenClaw 2026.9.3 requires Node 24.16.0+ or Node 26.1.0+. The add-on continues to use the NodeSource 24.x LTS channel.
- OpenClaw 2026.9.3 introduces breaking SDK changes for plugin authors (execution-policy SDK, approval SDK, SDK aliases, search/directory callbacks) and agent-owned Workshop skills. These do not affect the add-on image itself but may affect custom plugins/skills you develop.
- Back up `/config/clawd` before first start after update.

## [0.7.10.27] - 2026-09-08

### Fixed
- **Dockerfile alignment**: Actually install `openclaw@2026.9.2` (the 0.7.10.26 release only updated `config.yaml` version metadata). Bumped add-on version to 0.7.10.27 so Home Assistant rebuilds the image.

## [0.7.10.26] - 2026-09-08

### Changed
- **OpenClaw**: Intended update to `2026.9.2`.

### Notes
- This release did not update the Dockerfile install line, so the built image still contained OpenClaw 2026.9.1. Superseded by 0.7.10.27 and 0.7.10.28.
- Compatibility note: preserves active settings, enabled skills, and default-agent ownership across Gateway restarts triggered by HA add-on updates.

## 0.7.10.30
- fix(ingress): inject OpenClaw ControlUI base path on <html> tag for 2026.9.4.
  OpenClaw 2026.9.4 no longer ships the empty `data-openclaw-control-ui-base-path` attribute,
  so nginx now adds it explicitly when missing. This fixes "Gateway not reachable 127.0.0.1:18789"
  when loading the dashboard through the HA Ingress iframe.

## 0.7.10.31
- fix(ingress): inject a client-side base-path fallback for OpenClaw 2026.9.4
  when HA Supervisor does not pass X-Ingress-Path (e.g. Companion App iframe).
  The ControlUI now reads `data-openclaw-control-ui-base-path` from the actual
  browser URL instead of falling back to `127.0.0.1:18789`.
