# Security Risks & Disclaimer

This document outlines the security risks associated with running the OpenClaw Assistant Home Assistant app and provides best practices for safe usage.

**By installing and using this app, you acknowledge and accept the risks described below.**

---

## Disclaimer

This app is provided **"AS IS"**, without warranty of any kind, under the [MIT License](LICENSE).

The authors and contributors of this app are **not responsible** for any damage, data loss, security breach, unauthorized access, financial loss, or any other harm that may occur as a result of installing, configuring, or using this app. This includes but is not limited to:

- Unintended actions performed by the AI agent
- Exposure of sensitive data (tokens, credentials, personal information)
- Unauthorized access to your Home Assistant instance or network
- Damage to smart home devices or connected systems
- Actions taken by third-party skills or integrations

**You use this app entirely at your own risk.**

---

## Understanding the Risks

### 1. Autonomous AI Agent

OpenClaw is an **agentic AI assistant** — it can plan, reason, and execute actions autonomously. Unlike a simple chatbot, it can:

- Execute shell commands on the app container
- Control smart home devices (if integrated with Assist pipeline or HA long-lived access token)
- Read and write files
- Make HTTP requests to external services
- Install and run third-party skills

**Risk**: If the agent is manipulated (e.g., via prompt injection from a malicious webpage or document), it could perform unintended actions within its permissions.

**Mitigation**: Review what entities you expose to the Assist pipeline. Only expose devices you're comfortable with the AI controlling.

### 2. Network Exposure

Exposure is controlled by the **`network_mode`** option. Presets (see also `config.yaml`):

| Preset | Gateway bind | TLS | Typical use |
|---|---|---|---|
| `ingress_only` | loopback | no | Default. Access only via the HA sidebar (Ingress) and the app terminal |
| `lan_http` | LAN | no | Direct LAN access over plain HTTP — token sent unencrypted |
| `lan_https` | loopback + local-CA HTTPS proxy | yes | Direct LAN access with a self-signed, local-CA-issued certificate |
| `tailnet_serve` | loopback | yes | Reachable only from your Tailscale network |
| `tailnet_funnel` | loopback | yes | Reachable from the public internet **through Tailscale's funnel** |
| `reverse_proxy` | loopback | your proxy | You terminate TLS/identity in your own reverse proxy |

**Risks**:
- Unauthorized users could interact with your AI agent
- With `lan_http`, tokens can be intercepted over plain HTTP
- With `tailnet_funnel`, anyone holding the URL can reach the gateway's token gate
- The gateway endpoint could be discovered by network scanners

**Mitigations**:
- Use HTTPS whenever possible (`lan_https`, a `tailnet_*` mode, or your own reverse proxy)
- Keep the default `ingress_only` mode if you only need local/sidebar access
- Keep your gateway auth token secret

### 3. Token Authentication

In most network modes the gateway authenticates via **token** (`gateway.auth.mode=token`). The app generates a random per-install token and injects it server-side into the Ingress proxy.

**Risks**:
- If your LAN is compromised (e.g. open Wi-Fi) while using `lan_http`, the token can be intercepted
- The token grants full access to the gateway

**Mitigations**:
- Only enable `lan_http` on trusted networks; prefer `lan_https` or `tailnet_*` modes
- Rotate your gateway token periodically: `openclaw config set gateway.auth.token <new-token>`

### 4. Home Assistant Token

The `homeassistant_token` option stores a **long-lived access token** that grants broad access to your Home Assistant instance. This is extremely powerful — it can control devices, read state, trigger automations, and more.

**Risks**:
- If the container is compromised, the attacker gains full HA access
- Skills or scripts running inside the app have access to this token
- The token does not expire unless manually revoked

**Mitigations**:
- Only provide this token if skills specifically require it
- Create a dedicated HA user with limited permissions for this token
- Revoke and regenerate the token if you suspect compromise
- Monitor your HA logs for unexpected API activity

### 5. Third-Party Skills & Supply Chain

OpenClaw supports installing skills from the community (ClawHub) and via npm. These are **third-party code** running inside the app container.

**Risks**:
- Malicious skills could exfiltrate data, install backdoors, or perform harmful actions
- Skills have access to the same permissions as the OpenClaw process
- Compromised npm packages could affect your installation
- [Security researchers have already found malicious skills](https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html) published to ClawHub

**Mitigations**:
- Only install skills from trusted sources
- Review skill code before installing when possible
- Monitor the app logs for unexpected activity
- Keep the app updated to get security patches

### 6. Browser Automation (Chromium)

The bundled Chromium runs with `noSandbox` (required in Docker). This reduces browser-level security isolation.

**Risks**:
- A malicious webpage could potentially escape the browser sandbox
- Automated browsing could expose session cookies or credentials
- Browser automation skills could visit unintended websites

**Mitigations**:
- Only use browser automation with trusted skills
- Do not use it to log into sensitive accounts
- The container itself provides some isolation from the host

### 7. Prompt Injection

AI agents that process external content (web pages, documents, emails) are vulnerable to **prompt injection** — hidden instructions that manipulate the agent's behavior.

**Risks**:
- A webpage or document could contain hidden instructions that cause the agent to perform unintended actions
- Data exfiltration through crafted prompts
- Actions performed on behalf of an attacker

**Mitigations**:
- Be cautious about what content you ask the agent to process
- Review agent actions in the logs
- Limit the entities and services exposed to the agent

---

## Best Practices Summary

| Practice | Priority |
|---|---|
| Use HTTPS for remote access (`lan_https`, `tailnet_*`, or your own reverse proxy) | High |
| Keep the default `network_mode: ingress_only` unless direct network access is needed | High |
| Prefer `tailnet_*` over `lan_http` for remote/private access | High |
| Only install skills from trusted sources | High |
| Review exposed entities in Assist pipeline | High |
| Keep the app updated | High |
| Use a dedicated HA user for the `homeassistant_token` | Medium |
| Monitor app logs regularly | Medium |
| Rotate gateway tokens periodically | Medium |
| Back up your configuration regularly | Low |

## Supported Versions

Security fixes are only published for the latest release. Earlier releases (including patch-level hotfixes of the same minor line) should be treated as unsupported.

| Version line | Supported |
|---|---|
| latest release (see `openclaw_ha_addon/config.yaml` / `CHANGELOG.md`) | ✅ |
| older releases | ❌ — update first |

---

## Reporting Security Issues

If you discover a security vulnerability in this app, please report it responsibly by opening a private security advisory on GitHub rather than a public issue.

---

*This document does not constitute legal advice. Consult a qualified professional for legal guidance specific to your situation.*