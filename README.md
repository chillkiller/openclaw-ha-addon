# OpenClaw Home Assistant Addon

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Home Assistant](https://img.shields.io/badge/Home_Assistant-2024.12+-blue.svg)](https://www.home-assistant.io/)
[![Platform](https://img.shields.io/badge/Platform-amd64%20%7C%20aarch64-green.svg)](https://www.home-assistant.io/)

A powerful Home Assistant add-on that brings OpenClaw's agentic AI capabilities to your smart home. OpenClaw can autonomously plan, reason, and execute actions to help you manage and automate your home.

## 🚀 Features

- **Agentic AI Assistant**: OpenClaw can plan, reason, and execute actions autonomously
- **Full-Stack Integration**: Complete OpenClaw runtime with all features enabled
- **Web UI**: Beautiful web interface accessible via Home Assistant Ingress
- **Web Terminal**: Built-in terminal for direct access (optional)
- **Network Flexibility**: Support for loopback, LAN, and Tailscale access modes
- **mDNS/Bonjour**: Automatic service discovery on your local network
- **OpenAI-Compatible API**: Integrate with Home Assistant's Assist pipeline
- **MCP Support**: Model Context Protocol for Home Assistant integration
- **Customizable**: Extensive configuration options for security and functionality

## 📋 Prerequisites

- Home Assistant 2024.12 or later
- Supported architecture: amd64 or aarch64
- At least 2GB RAM recommended (4GB+ for optimal performance)
- 5GB+ free disk space

## 🔧 Installation

### Method 1: Add Repository (Recommended)

1. Go to **Settings** → **Add-ons** → **Add-on Store** in Home Assistant
2. Click the three dots in the top right corner
3. Select **Add repository**
4. Enter: `https://github.com/chillkiller/openclaw-ha-addon`
5. Click **Add**
6. Find "OpenClaw Assistant" in the store and install it

### Method 2: Manual Installation

1. Clone this repository to your Home Assistant's `/addons` directory
2. Restart Home Assistant
3. Install the add-on from the local store

## ⚙️ Configuration

### Basic Setup

After installation, configure the add-on with these essential options:

```yaml
timezone: "Europe/Berlin"
enable_terminal: true
gateway_bind_mode: loopback
gateway_port: 18789
```

### Access Modes

Choose the access mode that fits your needs:

| Mode | Description | Use Case |
|------|-------------|----------|
| `local_only` | Loopback only, token auth | Maximum security, Ingress/terminal only |
| `lan_https` | LAN with built-in HTTPS proxy | Phones/tablets on home network |
| `lan_reverse_proxy` | LAN bind + trusted proxy | External reverse proxy (Nginx, Traefik) |
| `tailnet_https` | Tailscale interface + token auth | Remote access via Tailscale |
| `custom` | Manual configuration | Advanced users |

### Security Best Practices

1. **Use HTTPS for remote access**: Never expose the gateway port directly to the internet without TLS
2. **Limit network exposure**: Use `loopback` mode unless you need network access
3. **Protect your tokens**: Keep gateway and Home Assistant tokens secret
4. **Review permissions**: Only expose devices you're comfortable with the AI controlling
5. **Monitor logs**: Regularly check add-on logs for unexpected activity

### Advanced Configuration

For detailed configuration options, see [DOCS.md](openclaw_ha_addon/DOCS.md).

## 🌐 Accessing OpenClaw

### Via Home Assistant Ingress

1. Go to **Settings** → **Add-ons** → **OpenClaw Assistant (Dev)**
2. Click **Open Web UI**
3. The OpenClaw interface opens in a new tab

### Via Web Terminal

1. Enable `enable_terminal: true` in configuration
2. Go to **Settings** → **Add-ons** → **OpenClaw Assistant (Dev)**
3. Click **Open Terminal**
4. Access the command line directly

### Via Network

If `gateway_bind_mode` is set to `lan` or `tailnet`:

- **LAN**: `http://<home-assistant-ip>:18789`
- **Tailscale**: `http://<tailscale-ip>:18789`
- **HTTPS Proxy**: Use the URL configured in `gateway_public_url`

## 🔌 Integration with Home Assistant

### Assist Pipeline Integration

1. Enable `enable_openai_api: true` in configuration
2. Go to **Settings** → **Voice Assistants** → **Assist**
3. Create a new pipeline or edit an existing one
4. Add OpenClaw as a conversation agent
5. Configure the API endpoint: `http://<addon-ip>:48099/v1/chat/completions`

### MCP (Model Context Protocol)

1. Set `homeassistant_token` to a long-lived access token
2. Enable `auto_configure_mcp: true`
3. Restart the add-on
4. OpenClaw will automatically register Home Assistant as an MCP server

## 📚 Documentation

- [Full Documentation](openclaw_ha_addon/DOCS.md)
- [Security Guidelines](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## ⚠️ Security & Disclaimer

**Important**: OpenClaw is an agentic AI assistant that can execute actions autonomously. By installing this add-on, you acknowledge and accept the security risks described in [SECURITY.md](SECURITY.md).

**Key risks to understand**:
- The AI can execute shell commands and control devices
- Network exposure could allow unauthorized access
- Third-party skills may have security vulnerabilities
- Prompt injection could manipulate agent behavior

**Use at your own risk**. The authors are not responsible for any damage, data loss, or security breaches.

## 🐛 Troubleshooting

### Add-on won't start

- Check the add-on logs for error messages
- Ensure you have sufficient disk space and RAM
- Verify your configuration is valid
- Try restarting Home Assistant

### Can't access the web UI

- Verify `gateway_bind_mode` is set correctly
- Check if the port is already in use
- Ensure your firewall allows the connection
- Try accessing via Home Assistant Ingress instead

### Performance issues

- Increase available RAM if possible
- Disable unused features (terminal, browser automation)
- Check for resource-intensive skills
- Monitor CPU and memory usage in Home Assistant

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/chillkiller/openclaw-ha-addon/issues)
- **Discussions**: [GitHub Discussions](https://github.com/chillkiller/openclaw-ha-addon/discussions)
- **Security Issues**: Please report privately via GitHub Security Advisory

## 🙏 Acknowledgments

- [OpenClaw](https://github.com/openclaw/openclaw) - The core agentic AI platform
- [Home Assistant](https://www.home-assistant.io/) - The amazing smart home platform
- All contributors who help make this project better

---

**Note**: This is the production version of the add-on.

Made with ❤️ by the OpenClaw community