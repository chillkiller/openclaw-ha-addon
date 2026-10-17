# OpenClaw HA App Deployment

## Version Matrix

| App Version | OpenClaw Version | Release Date |
|--------------|------------------|---------------|
| 0.7.13.35 | 2026.10.2 | 2026-10-18 |
| 0.7.13.34 | 2026.10.2 | 2026-10-17 |
| 0.7.13.33 | 2026.10.2 | 2026-10-16 |
| 0.7.13.32 | 2026.10.2 | 2026-10-16 |
| 0.7.13.31 | 2026.10.2 | 2026-10-15 |
| 0.7.13.30 | 2026.10.2 | 2026-10-15 |
| 0.7.13.29 | 2026.10.2 | 2026-10-14 |
| 0.7.13.28 | 2026.10.2 | 2026-10-14 |
> **Hinweis (0.7.13.28):** isolierter Rollback auf den `v0.7.13.25`-Codebestand (GaRoN-GO). Image-Rebuild nötig.
| 0.7.13.27 | 2026.10.2 | 2026-10-13 |
| 0.7.13.26 | 2026.10.2 | 2026-10-13 |
| 0.7.13.25 | 2026.10.2 | 2026-10-13 |
| 0.7.13.24 | 2026.10.2 | 2026-10-13 |
> **Note (0.7.13.24):** live-boot follow-up on 0.7.13.23 — the boot sweep must ride `api.on("gateway_start", …)` (typed hook runner); a registry-named `registerHook` for that event is legal but never dispatched. Image rebuild required as usual.
| 0.7.13.23 | 2026.10.2 | 2026-10-13 |
> **Note (0.7.13.23):** roll-forward repair of the 0.7.13.22 register crash ("hook registration missing name", forensics §1-§10). The interim .23/.24 hotfix chain was rolled back and re-landed as this fully audited fix; requires an add-on image rebuild to reach the container.
| 0.7.13.22 | 2026.10.2 | 2026-10-13 |
| 0.7.13.21 | 2026.10.2 | 2026-10-12 |
| 0.7.13.8 | 2026.9.9 | 2026-10-10 |
> **Note (0.7.13.8):** the helper's plugin registration respects an explicit operator opt-out: with `plugins.entries["acp-dashboard-binding"].enabled=false`, the flag is never flipped back across boots, the plugin payload stays deployed (re-enable needs no rebuild), and no `plugins.load.paths` entry is written while disabled.
| 0.7.13.7 | 2026.9.9 | 2026-10-10 |
| 0.7.13.6 | 2026.9.9 | 2026-10-10 |
| 0.7.13.5 | 2026.9.9 | 2026-10-10 |
| 0.7.13.4 | 2026.9.9 | 2026-10-10 |

| 0.7.13.3 | 2026.9.9 | 2026-10-09 |
| 0.7.13.2 | 2026.9.9 | 2026-10-09 |
| 0.7.13.1 | 2026.9.9 | 2026-10-09 |
| 0.7.13 | 2026.9.9 | 2026-10-09 |
| 0.7.12.7 | 2026.9.8 | 2026-10-08 |
| 0.7.12.6 | 2026.9.8 | 2026-10-07 |
| 0.7.12.5 | 2026.9.8 | 2026-10-05 |
| 0.7.12.4 | 2026.9.8 | 2026-10-03 |
| 0.7.12.3 | 2026.9.6 | 2026-09-26 |
| 0.7.12.2 | 2026.9.6 | 2026-09-26 |
| 0.7.12.1 | 2026.9.6 | 2026-09-25 |
| 0.7.12.0 | 2026.9.6 | 2026-09-25 |
| 0.7.11.15.3 | 2026.9.5 | 2026-09-25 |
| 0.7.11.15.2 | 2026.9.5 | 2026-09-24 |
| 0.7.11.3 | 2026.9.4 | 2026-09-19 |
| 0.7.10.2 | 2026.8.2 | 2026-09-04 |
| 0.7.10.1 | 2026.8.2 | 2026-09-04 |
| 0.7.9.28 | 2026.8.2 | 2026-09-03 |
| 0.7.9.11 | 2026.7.1 | 2026-08-23 |
| 0.7.5.3 | 2026.4.21 | 2026-04-24 |
| 0.7.5.2 | 2026.4.21 | 2026-04-23 |
| 0.7.5.1 | 2026.4.15 | 2026-04-20 |

## RAM Configuration

The Node.js heap is **RAM-adaptive** since v0.7.12.4 (`--max-old-space-size` set from host RAM in `run.sh`):

| System RAM | Heap |
|---|---|
| ≥ 24 GB | 8192 MB |
| ≥ 12 GB | 6144 MB |
| ≥ 8 GB | 4096 MB |
| < 8 GB | 2048 MB |

- **8 GB+ system RAM**: works with defaults
- **Less than 8 GB**: the app already selects a 2048 MB heap automatically; reduce further only for special cases — e.g. `docker exec` into the container or use the app terminal to set `NODE_OPTIONS=--max-old-space-size=2048` for testing, and for persistence use the `gateway_env_vars` mechanism with care (Node options are reserved keys; the supported path is editing `run.sh` for custom builds)

## Port Safety

- Gateway port defaults to `18789` (configurable via `gateway_port`, range 1–65535; the internal gateway loopback port is derived at runtime)
- Ingress proxy: fixed port `49200` (`ingress_port` in `config.yaml`)
- Web terminal: configurable, default `7681`

## Image Size

Measured on the released aarch64 build (v0.7.12.1):

- **Unique image size: ~1.8 GB** (layers not shared with the HA base image)
- **Total size on disk: ~7.3 GB** (uncompressed, including layers shared with the Home Assistant base image and other apps)

Main contributors: OpenClaw runtime + npm packages, Playwright Chromium, Python tooling (`node-llama-cpp`, crawl4ai basis), Homebrew (installed under `/config`, persisted outside the image), CUPS/scanner stack.

> Plan disk space for the uncompressed image plus HA backups. On a Raspberry Pi booting from SD card, an SSD is strongly recommended.

## Options sections migration (one-time, required for the collapsible config UI)

Since the config schema groups options into sections (see DOCS.md §5), the
Supervisor **validates the stored options against the installed schema and
rewrites `options.json` from its own stored copy on every app start**
(`apps/app.py: write_options()` inside `App.start()`). Two consequences,
both verified against the Supervisor source of the running system:

- A **premature migration is destructive**: `POST /options` is validated
  against the CURRENTLY INSTALLED (flat) schema. A sectioned payload posted
  before the update has every group key dropped (`unknown option ...` warning)
  and the stripped result is persisted.
- A flat stored file against the new sectioned schema **fails start**
  (`Missing option 'terminal_ui' in root` on pre-0.7.13.29 installs; on the
  0.7.13.30 schema a stored v1-sectioned file fails with
  `Missing option 'harness' in root` → `AppConfigurationInvalidError`).
  This is recoverable and harmless as long as no values were lost: the
  validation runs BEFORE the write, so the old flat `options.json` file stays
  intact and the migration helper can read it.

Verified sequence (no destructive window, one controlled stop):

1. Snapshot current options (flat, via API):
   `curl -s -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/addons/45b315ab_openclaw_ha_addon/info | jq .data.options > options-backup.json`
2. `POST /addons/<slug>/stop` (brief downtime; this keeps the update from
   auto-starting into the validation error).
3. Deploy the new version (store pull + Supervisor restart + `POST /update`).
   Because the app was stopped, the update installs the new schema and does
   **not** start the app (start-after-update only happens for apps that were
   running).
4. Build the sectioned payload from the stored backup. Since 0.7.13.30 the
   migration helper ALSO renames keys (v2 mapping) and accepts both input
   shapes (flat pre-0.7.13.29 and v1-sectioned 0.7.13.29). New groups:
   `ha_integration` (first), `harness` (renamed provider keys:
   `harness_base_url` merged from old `harness_base_url`/`ollama_base_url`,
   `harness_codex_model` ← `ollama_acp_codex_model`,
   `harness_opencode_model` ← `ollama_acp_opencode_model`,
   `harness_claude_model` ← `ollama_acp_claude_model`,
   `additional_agents` ← `acp_additional_allowed_agents`), plus unchanged
   `gateway_ext`, `logging_diag`, `safety_nets`, `runtime`, `legacy`. Top
   level: `timezone`, `network_mode`, `gateway_port`, `gateway_mode`,
   `gateway_env_vars`, `terminal_port`, `enable_webui`, `enable_docs`,
   `acpx_enabled`, `harness_config_writer_enabled`. `enable_terminal` is
   retired and dropped (INFO note on stderr). Helper:
   `/config/pushbug-tools/options_migrate_sections.py` (host-persistent, not
   in repo). Validation gotcha: the API expects the payload wrapped as
   `{"options": <payload>}`.
   The API validates against the now-installed sectioned schema — group keys
   now match, values validate 1:1.
5. `curl -s -X POST -H "Authorization: Bearer $SUPERVISOR_TOKEN" -H "Content-Type: application/json" -d "$(jq -nc "{options: input}" options-migrated.json)" http://supervisor/addons/45b315ab_openclaw_ha_addon/options`
6. `POST /addons/<slug>/start` and verify the boot log line
   `DEBUG: options layout: sectioned -> flattening for reads` shows reads
   worked and all env-derived behavior matches (spot-check `gateway_port`,
   `network_mode`).

Fallback if the update already auto-started and failed validation: the
flat `options.json` on disk is untouched (write aborted before write);
migrate from step 4 using a fresh snapshot of that file, POST the sectioned
payload (now validated against the new schema), then `POST /start`.

**Do NOT** rely on Settings → Apps → Configuration → Save as the migration
path: the UI renders the new sectioned defaults and the stored flat key
values do not map into the grouped fields — saving can silently reset
operator-set values (e.g. `homeassistant_token`) to defaults. Treat it only
as an emergency path with full manual re-entry.

The `run.sh` normalization keeps **reads** compatible with both layouts —
the migration above exists so the Supervisor schema validation accepts the
stored options on start.
