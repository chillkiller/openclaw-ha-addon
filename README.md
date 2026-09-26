# OpenClaw Assistant — Home Assistant App

[![Latest release](https://img.shields.io/github/v/release/chillkiller/openclaw-ha-addon.svg?style=flat-square)](https://github.com/chillkiller/openclaw-ha-addon/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![Home Assistant](https://img.shields.io/badge/Home_Assistant-2024.12%2B-blue.svg?style=flat-square)](https://www.home-assistant.io/)
[![Platform](https://img.shields.io/badge/Platform-amd64%20%7C%20aarch64-green.svg?style=flat-square)](#-requirements)
[![Open your Home Assistant instance and show the app store with this repository](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fchillkiller%2Fopenclaw-ha-addon)

OpenClaw Assistant brings [OpenClaw](https://github.com/openclaw/openclaw) — an agentic AI runtime — into your Home Assistant installation as a self-contained app. It plans, reasons, and executes: control your smart home through conversation, automate away routine tasks, and give your assistant real tools — a web terminal, browser automation, scheduled jobs, and a growing skill ecosystem.

Everything runs locally on your HAOS machine. No external Docker setup, no cloud dependency — the app ships the complete OpenClaw runtime.

## 🤖 How this project is built

This project is a **vibe-coding product**: the overwhelming majority of its code and documentation was generated and iterated through AI-assisted development (OpenClaw agents, including this app's own maintainer team). The owner reviews, tests on real hardware, and decides what ships.

We say this openly for two reasons:

- **Honesty** — you should know what you are installing and how it was made.
- **Proof** — this app is also the reference deployment of its own toolchain: the code that runs it, wrote it.

Every release is verified on a real Home Assistant OS installation (aarch64) before it is tagged.

## ✨ Features

- **Ingress Web UI** — the full OpenClaw Control UI embedded directly in Home Assistant, with web terminal and offline docs tabs on the app landing page
- **Six network modes** — from locked-down Ingress-only to LAN HTTPS (built-in self-signed TLS), Tailscale serve/funnel, and reverse-proxy presets
- **Home Assistant deep integration** — Assist pipeline conversation agent via an OpenAI-compatible endpoint, MCP server auto-registration, and native device/entity control
- **Companion integration** — works with the [OpenClaw Home Assistant integration](https://github.com/techartdev/OpenClawHomeAssistantIntegration) for auto-discovery, a Lovelace chat card, and voice mode
- **ACPX coding-agent harness** — optional managed wrappers for Claude Code, Codex, and OpenCode running inside the app
- **Local AI** — bundled `node-llama-cpp` for on-device embeddings; Ollama-ready for local models
- **Browser automation** — headless Chromium included
- **Persistent skills & config** — everything survives updates through HA's backup system
- **Six languages** — English, German, Spanish, Polish, Portuguese (Brazil), Bulgarian

## 📋 Requirements

- Home Assistant OS / Supervised **2024.12 or later**
- Architecture: **amd64** or **aarch64** (tested on Raspberry Pi 5)
- **RAM:** 8 GB+ recommended. The gateway runs with a 4 GB Node.js heap by default; on smaller systems reduce it via the app terminal (`--max-old-space-size` in `NODE_OPTIONS`).
- Disk: plan for a multi-gigabyte image (~1.8 GB unique layers, ~7 GB total on disk including shared base layers)

## 🚀 Installation

**One-click:**

[![Add repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fchillkiller%2Fopenclaw-ha-addon)

**Or manually:**

1. **Settings → Apps → Install app** → ⋮ → **Repositories**
2. Paste: `https://github.com/chillkiller/openclaw-ha-addon`
3. Find **OpenClaw Assistant** → **Install**
4. **Start** the app

> **Note:** Home Assistant renamed "add-ons" to "apps" as of 2026.2. On older releases, the menu entry is still called "Add-ons".

## ⚡ Quick Start

1. Install and start the app — default settings work out of the box (`ingress_only` network mode)
2. Open the app page → **Open Web UI**
3. Complete the OpenClaw onboarding — then talk to it, build automations, add skills

For everything beyond the defaults — network modes, tokens, Assist, MCP — read the [full documentation](DOCS.md).

## 🌐 Network Modes

| Mode | Description | Use case |
|------|-------------|----------|
| `ingress_only` *(default)* | Loopback only, token auth | Maximum security; HA Ingress + terminal |
| `lan_http` | LAN, plain HTTP | LANs where TLS is handled elsewhere; not a secure context |
| `lan_https` | LAN with built-in self-signed HTTPS | Phones/tablets on your home network |
| `tailnet_serve` | Tailscale interface, token auth | Remote access via your tailnet |
| `tailnet_funnel` | Tailscale funnel HTTPS | Public reachability with password auth |
| `reverse_proxy` | Loopback + trusted-proxy auth | Nginx Proxy Manager, Traefik, Caddy in front |

Set the mode under **Settings → Apps → OpenClaw Assistant → Configuration**. Details: [DOCS.md § Accessing the Gateway Web UI](DOCS.md#4-accessing-the-gateway-web-ui).

## 🔌 Home Assistant Integration

- **Assist pipeline** — enable `enable_openai_api` and use the OpenAI-compatible endpoint (`/v1/chat/completions`, gateway port `18789`) as a conversation agent. Step-by-step: [DOCS.md § Assist](DOCS.md#6c-assist-pipeline-integration-openai-api)
- **Native integration** — the third-party [OpenClaw Home Assistant integration](https://github.com/techartdev/OpenClawHomeAssistantIntegration) adds auto-discovery, a chat card, and voice mode. It is a separate project; install it from its own repository.
- **MCP** — with a long-lived HA token, set `auto_configure_mcp` to register Home Assistant as an MCP server, giving OpenClaw direct entity control

## 🔐 Security

This app runs a powerful AI agent with shell access on your home network. That is its purpose — and its risk. Read [SECURITY.md](SECURITY.md) before installing.

Key facts:

- Default mode (`ingress_only`) keeps the gateway on loopback; nothing is reachable without HA authentication
- The app ships locked down since v0.7.12.1: the Ingress proxy accepts only loopback and Supervisor traffic
- An agentic AI can be manipulated by prompt injection and can execute destructive commands; expose only what you are comfortable with
- **Use at your own risk.** The authors are not liable for damage, data loss, or security breaches.

## 📚 Documentation & Support

- [Full app documentation](DOCS.md) — configuration reference, use-case guides, troubleshooting
- [Deployment notes](DEPLOYMENT.md) — version matrix, resource planning
- [Issues](https://github.com/chillkiller/openclaw-ha-addon/issues) — bug reports
- [Discussions](https://github.com/chillkiller/openclaw-ha-addon/discussions) — questions and ideas
- [OpenClaw docs](https://docs.openclaw.ai) — upstream product documentation
- Security issues: [private vulnerability reporting](https://github.com/chillkiller/openclaw-ha-addon/security/advisories/new)

## 🤝 Contributing & License

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). MIT License: see [LICENSE](LICENSE).

## 🙏 Acknowledgments

- [OpenClaw](https://github.com/openclaw/openclaw) — the agentic AI runtime
- [Home Assistant](https://www.home-assistant.io/) — the smart home platform
- [OpenClaw Home Assistant integration](https://github.com/techartdev/OpenClawHomeAssistantIntegration) by [@techartdev](https://github.com/techartdev)

---

**README languages:** [English](README.md) · [Deutsch](README.de.md)