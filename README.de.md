# OpenClaw Assistant — Home Assistant Add-on

[![Letztes Release](https://img.shields.io/github/v/release/chillkiller/openclaw-ha-addon.svg?style=flat-square)](https://github.com/chillkiller/openclaw-ha-addon/releases)
[![Lizenz: MIT](https://img.shields.io/badge/Lizenz-MIT-yellow.svg?style=flat-square)](LICENSE)
[![Home Assistant](https://img.shields.io/badge/Home_Assistant-2024.12%2B-blue.svg?style=flat-square)](https://www.home-assistant.io/)
[![Plattform](https://img.shields.io/badge/Plattform-amd64%20%7C%20aarch64-green.svg?style=flat-square)](#-anforderungen)
[![Repository in Home Assistant öffnen](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fchillkiller%2Fopenclaw-ha-addon)

> **Sprache:** Deutsch · [English](README.md)

OpenClaw Assistant bringt [OpenClaw](https://github.com/openclaw/openclaw) — eine agentische KI-Laufzeitumgebung — als eigenständiges Add-on in deine Home-Assistant-Installation. Er plant, denkt voraus und führt aus: steuere dein Smart Home per Konversation, automatisiere Routineaufgaben und gib deinem Assistenten echte Werkzeuge — Web-Terminal, Browser-Automatisierung, geplante Jobs und ein wachsendes Skill-Ökosystem.

Alles läuft lokal auf deinem HAOS-Gerät. Kein externes Docker-Setup, keine Cloud-Abhängigkeit — das Add-on liefert die komplette OpenClaw-Runtime mit.

## 🤖 Wie dieses Projekt entsteht

Dieses Projekt ist ein **Vibe-Coding-Produkt**: der weitaus größte Teil von Code und Dokumentation wurde durch KI-gestützte Entwicklung generiert und iteriert (OpenClaw-Agenten — inklusive des Maintainer-Teams dieses Add-ons). Der Eigentümer prüft, testet auf echter Hardware und entscheidet, was ausgeliefert wird.

Wir sagen das offen aus zwei Gründen:

- **Ehrlichkeit** — du solltest wissen, was du installierst und wie es entstanden ist.
- **Beweis** — dieses Add-on ist die Referenz-Deployment seiner eigenen Werkzeugkette: der Code, der es betreibt, hat es geschrieben.

Jedes Release wird vor dem Tagging auf einer echten Home-Assistant-OS-Installation (aarch64) verifiziert.

## ✨ Funktionen

- **Ingress-Web-UI** — die komplette OpenClaw Control UI direkt in Home Assistant eingebettet, mit Web-Terminal und Offline-Dokumentation auf der Add-on-Landingpage
- **Sechs Netzwerkmodi** — vom abgeschotteten Ingress-only bis LAN-HTTPS (eingebautes selbstsigniertes TLS), Tailscale serve/funnel und Reverse-Proxy-Voreinstellungen
- **Tiefe Home-Assistant-Integration** — Assist-Pipeline als Konversationsagent über einen OpenAI-kompatiblen Endpoint, automatische MCP-Server-Registrierung und direkte Geräte-/Entitätssteuerung
- **Companion-Integration** — funktioniert mit der [OpenClaw-Integration für Home Assistant](https://github.com/techartdev/OpenClawHomeAssistantIntegration) für Auto-Discovery, Lovelace-Chat-Karte und Sprachmodus
- **ACPX-Coding-Agent-Harness** — optionale verwaltete Wrapper für Claude Code, Codex und OpenCode im Add-on
- **Lokale KI** — mitgeliefertes `node-llama-cpp` für Embeddings auf dem Gerät; Ollama-ready für lokale Modelle
- **Browser-Automatisierung** — headless Chromium enthalten
- **Persistente Skills & Konfiguration** — alles übersteht Updates durch das HA-Backup-System
- **Sechs Sprachen** — Englisch, Deutsch, Spanisch, Polnisch, Portugiesisch (Brasilien), Bulgarisch

## 📋 Anforderungen

- Home Assistant OS / Supervised **2024.12 oder neuer**
- Architektur: **amd64** oder **aarch64** (getestet auf Raspberry Pi 5)
- **RAM:** 8 GB+ empfohlen. Der Gateway läuft standardmäßig mit 4 GB Node.js-Heap; auf kleineren Systemen über das Add-on-Terminal reduzieren (`--max-old-space-size` in `NODE_OPTIONS`).
- Speicher: rechne mit einem Image im Multi-Gigabyte-Bereich (~1,8 GB eigene Layer, ~7 GB gesamt inkl. geteilter Basis-Layer)

## 🚀 Installation

**Ein Klick:**

[![Repository zu Home Assistant hinzufügen](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fchillkiller%2Fopenclaw-ha-addon)

**Oder manuell:**

1. **Einstellungen → Add-ons → Add-on Store** → ⋮ → **Repositorys**
2. Einfügen: `https://github.com/chillkiller/openclaw-ha-addon`
3. **OpenClaw Assistant** suchen → **Installieren**
4. Add-on **Starten**

## ⚡ Schnellstart

1. Add-on installieren und starten — die Standardeinstellungen funktionieren sofort (Netzwerkmodus `ingress_only`)
2. Add-on-Seite öffnen → **Web-UI öffnen**
3. OpenClaw-Onboarding abschließen — dann sprich damit, baue Automatisierungen, füge Skills hinzu

Alles jenseits der Defaults — Netzwerkmodi, Tokens, Assist, MCP — steht in der [vollständigen Dokumentation (Englisch)](DOCS.md).

## 🌐 Netzwerkmodi

| Modus | Beschreibung | Anwendungsfall |
|------|-------------|----------|
| `ingress_only` *(Standard)* | Nur Loopback, Token-Auth | Maximale Sicherheit; HA-Ingress + Terminal |
| `lan_http` | LAN, klares HTTP | Nur wenn TLS andernorts behandelt wird; kein Secure Context |
| `lan_https` | LAN mit eingebautem selbstsigniertem HTTPS | Handys/Tablets im Heimnetz |
| `tailnet_serve` | Tailscale-Interface, Token-Auth | Fernzugriff über dein Tailnet |
| `tailnet_funnel` | Tailscale-Funnel-HTTPS | Öffentliche Erreichbarkeit mit Passwort-Auth |
| `reverse_proxy` | Loopback + Trusted-Proxy-Auth | Nginx Proxy Manager, Traefik, Caddy davor |

Modus einstellen unter **Einstellungen → Add-ons → OpenClaw Assistant → Konfiguration**. Details: [DOCS.md (Englisch)](DOCS.md#4-accessing-the-gateway-web-ui).

## 🔌 Home-Assistant-Integration

- **Assist-Pipeline** — `enable_openai_api` aktivieren und den OpenAI-kompatiblen Endpoint (`/v1/chat/completions`, Gateway-Port `18789`) als Konversationsagenten nutzen. Schritt für Schritt: [DOCS.md § Assist](DOCS.md#6c-assist-pipeline-integration-openai-api)
- **Native Integration** — die Drittanbieter-[OpenClaw-Integration für Home Assistant](https://github.com/techartdev/OpenClawHomeAssistantIntegration) ergänzt Auto-Discovery, Chat-Karte und Sprachmodus. Sie ist ein eigenständiges Projekt; Installation über dessen eigenes Repository.
- **MCP** — mit einem langlebigen HA-Token aktiviert `auto_configure_mcp` die Registrierung von Home Assistant als MCP-Server und gibt OpenClaw direkte Entitätskontrolle

## 🔐 Sicherheit

Dieses Add-on betreibt eine mächtige KI mit Shell-Zugriff in deinem Heimnetz. Das ist sein Zweck — und sein Risiko. Lies [SECURITY.md](SECURITY.md) vor der Installation.

Wichtige Fakten:

- Der Standardmodus (`ingress_only`) hält den Gateway auf Loopback; ohne HA-Authentifizierung ist nichts erreichbar
- Seit v0.7.12.1 ausgeliefert mit Lockdown: der Ingress-Proxy akzeptiert nur Loopback- und Supervisor-Traffic
- Eine agentische KI kann durch Prompt-Injection manipuliert werden und destruktive Befehle ausführen; exponiere nur, was du verantworten kannst
- **Nutzung auf eigene Gefahr.** Die Autoren haften nicht für Schäden, Datenverlust oder Sicherheitsvorfälle.

## 📚 Dokumentation & Support

- [Vollständige Add-on-Dokumentation (Englisch)](DOCS.md) — Konfigurationsreferenz, Anleitungen, Fehlerbehebung
- [Deployment-Hinweise (Englisch)](DEPLOYMENT.md) — Versionsmatrix, Ressourcenplanung
- [Issues](https://github.com/chillkiller/openclaw-ha-addon/issues) — Fehlerberichte
- [Discussions](https://github.com/chillkiller/openclaw-ha-addon/discussions) — Fragen und Ideen
- [OpenClaw-Dokumentation](https://docs.openclaw.ai) — Upstream-Produktdoku
- Sicherheitsprobleme: [privates Vulnerability-Reporting](https://github.com/chillkiller/openclaw-ha-addon/security/advisories/new)

## 🤝 Beitragen & Lizenz

Beiträge willkommen — siehe [CONTRIBUTING.md](CONTRIBUTING.md). MIT-Lizenz: siehe [LICENSE](LICENSE).

## 🙏 Danksagung

- [OpenClaw](https://github.com/openclaw/openclaw) — die agentische KI-Runtime
- [Home Assistant](https://www.home-assistant.io/) — die Smart-Home-Plattform
- [OpenClaw-Integration für Home Assistant](https://github.com/techartdev/OpenClawHomeAssistantIntegration) von [@techartdev](https://github.com/techartdev)

---

**README-Sprachen:** [English](README.md) · Deutsch (diese Datei)