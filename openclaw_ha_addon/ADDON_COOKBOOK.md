# 📘 Project: Ultimate OpenClaw Home Assistant Addon (Sovereign Edition)

## 🎯 Vision
Ein Home Assistant Addon, das OpenClaw in seiner maximalen Leistungsfähigkeit bereitstellt. Es ist **Hardware-aware**, **lokal-fokussiert** und dient als Brücke zu einer lokalen AI-Infrastruktur innerhalb von Home Assistant.

## 🏗️ 1. Architektur-Konzept

### 🌍 Multi-Arch & Hardware-Strategie
- **AMD64 (Powerhouse):** 
  - Fokus auf Stabilität und Performance für lokale Orchestrierung.
  - Keine GPU-Bibliotheken im Container – GPU-Arbeit läuft in separaten Addons.
  - Unterstützt optionales ffmpeg-VAAPI-Encoding via `video: true`.
- **aarch64 (Admin/Light):** 
  - Fokus auf Stabilität und Management.
  - Reine CPU-Inferenz und -Orchestrierung.
  - Optimiert für Raspberry Pi / ARM-Server als Container-Host.
- **ARMv7:** Support vollständig entfernt.

### 📦 Dockerfile Layer-Structur (The Three Zones + Dev-Chain)

#### **Zone 1: Core-System (APT - Immutable)**
*Die fundamentale Basis für alle Architekturen.*
- **Media & Audio:** `ffmpeg`, `sox`, `libopus-dev`, `libvips-dev`, `espeak-ng` (Piper-Basis).
- **Audio Processing:** `libsndfile1`, `libsamplerate0-dev`, `portaudio19-dev`, `libpulse-dev`, `libasound2-dev`
- **GStreamer (STT):** `gstreamer1.0-plugins-base`, `gstreamer1.0-plugins-good`, `gstreamer1.0-tools`
- **Memory & Math:** `liblapack3`, `libopenblas-dev` (für lokale Embeddings und BLAS).
- **Knowledge-DB Client:** `libpq-dev`, `postgresql-client`, `python3-psycopg2` (Vorbereitung für pgvector).
- **Python Dev:** `python3-dev`, `python3-venv`, `build-essential`, `pkg-config`, `cmake`
- **QMD Runtime:** `bun` (für QMD Memory Engine als Option)
- **Tooling:** `tmux`, `ripgrep`, `jq`, `fd-find`, `curl`, `git`, `openssl`.

#### **Zone 2: Hardware-Acceleration (ENTFERNT)**
*OpenClaw selbst ist kein GPU-Worker – es orchestriert spezialisierte Addons.*
- Keine GPU-Bibliotheken im Dockerfile nötig.
- Optionales GPU-Feature: `video: true` in config.yaml für ffmpeg-VAAPI-Encoding (Nice-to-Have).

#### **Zone 3: Toolchain & ML-Runtimes**
*Werkzeuge zur Skill-Installation und Ausführung.*
- **Node.js 22 LTS:** Die Basis für OpenClaw.
- **Python 3.11+ & uv:** High-Performance Package Manager for ML-Skills.
- **Homebrew (Linuxbrew):** For CLI-Tools like `gh`, `openhye` etc.
- **Go-Compiler:** Integrated to build Go-based skills natively in the image.
- **Bun Runtime:** For QMD Memory Engine and other JS tooling.

## 🎙️ 2. Lokale Medien- & AI-Infrastruktur

The addon is not an "all-in-one" box, but an **orchestrator**. The heavy ML-runtimes run as separate HA-addons or containers, and the OpenClaw-addon provides the bridge:

| Feature | Local Service (Separate Addon) | Bridge in OpenClaw-Addon |
|---|---|---|
| **Text → Speech** | Piper / Kokoro Server | ✓ `espeak-ng` + `ffmpeg` |
| **Speech → Text** | faster-whisper / whisper.cpp | ✓ `gstreamer` + `ffmpeg` |
| **Image/Video Gen** | ComfyUI / Stable Diffusion | ✓ `libvips` (Sharp) |
| **Knowledge/Vector** | PostgreSQL + pgvector / Qdrant | ✓ `libpq` + `psql` Client |
| **LLM Inference** | Ollama Server | ✓ HTTP API (`http://host:11434`) |

## 🔐 3. Sicherheitskonzept

### **No Privileged Mode**
- OpenClaw uses **no** `privileged: true` in config.yaml.
- GPU access is only via optional `video: true` (for ffmpeg-VAAPI).
- Heavy ML workloads run in sandboxed, separate addons with their own security concepts.

### **Groups Instead of Privileges**
Instead of `privileged: true`, use specific groups for hardware access:
```yaml
groups:
  - video        # for libvips, ffmpeg, VAAPI
  - render       # for OpenGL/VAAPI
  - input        # for evdev (mouse/keyboard in skills)
  - tty          # for serial devices in some skills
```

## ⚙️ 4. config.yaml - OpenClaw-Spezifische Options

```yaml
options:
  # GPU (optional, only for ffmpeg-VAAPI)
  video: true                   # Enables /dev/dri access for VAAPI

  # Local ML Endpoints
  ollama_url: "http://host.homeassistant:11434"
  comfyui_url: "http://host.homeassistant:8188"
  
  # PostgreSQL Knowledge-Base
  postgres_host: "host.homeassistant"
  postgres_port: 5432
  postgres_database: "openclaw"
  postgres_username: "openclaw"
  postgres_password: ""         # Should be managed via HA Secrets
  
  # TTS Provider
  tts_provider: "kokoro"        # Options: kokoro | piper | espeak
  
  # OpenClaw Version
  openclaw_version: "latest"    # Options: latest, specific version, stable
  
  # mDNS Configuration (NEW)
  mDNS_mode: "minimal"          # Options: off, minimal, full
  mDNS_interface_name: ""       # Auto-detected if empty (e.g., homeassistant.local)
  mDNS_service_port: 18789      # PUBLIC port via HTTPS proxy, not internal gateway port
  mDNS_host_name: ""            # Auto-detected hostname (e.g., homeassistant.local)
  
  # HA Standard Options (keep these)
  timezone: "Europe/Berlin"
  # ... (other HA options as usual)
```

## 💾 5. Persistenzkonzeption (HA-konform)

- **`/config`**: Main configuration, API keys, user-defined models
  - Automatically mapped via HassIO Config Volume
  - Example: Ollama models, OpenClaw skills, configurations
- **`/data`**: Runtime data, cache, logs, databases
  - Persistent storage in the addon container
  - Example: Model caches, chat logs, log files
- **`/share`**: Shared, infrequently changing data
  - Example: Large pretrained models (if user-provided)

## 🚀 6. Implementierungs-Phasen (aktualisiert)

### **Phase 1: The Foundation (Hardware & Core)**
- [x] **Dockerfile 1.0:** Zone 1 with complete APT packages (including voice/media gaps and Bun)
- [x] **Zone 2 removed:** No GPU libs needed – `video: true` suffices
- [x] **HA Config:** config.yaml with `video: true` and ML-endpoint options
- [ ] **Disk Cleanup:** Free up space on SD card/host (if needed)

## 🚀 6. Implementierungs-Phasen (aktualisiert)

### **Phase 1: The Foundation (Hardware & Core)**
- [x] **Dockerfile 1.0:** Zone 1 with complete APT packages (including voice/media gaps and Bun)
- [x] **Zone 2 removed:** No GPU libs needed – `video: true` suffices
- [x] **HA Config:** config.yaml with `video: true` and ML-endpoint options
- [ ] **Disk Cleanup:** Free up space on SD card/host (if needed)

### **Phase 2: The Toolchain Power & Space Optimization**
- [ ] **Node/Brew Setup:** Stable base for skill management.
- [ ] **Multi-Stage Build Implementation:** 
  - Mandatory separation of `Build-Stage` and `Runtime-Stage`.
  - Heavy toolchains (gcc, cmake, build-headers) stay in Build-Stage.
  - Only final binaries and runtime libs are copied to the final image.
- [ ] **Layer Hygiene:** Strict requirement to combine `apt-get install` and `rm -rf /var/lib/apt/lists/*` in a single layer to prevent invisible bloat.
- [ ] **Sovereign Build-Flow:** Manage build cache to prevent "no space left on device" during layer extraction on SD cards.
- [ ] **Go Integration:** Compiler setup for native Go skills.
- [ ] **Python/uv Optimization:** Setup for fast installation of ML skills.
- [ ] **Bun Setup:** Installation and test of QMD.


### **Phase 3: The Knowledge-Base (Data Layer)**
- [ ] **Postgres Integration:** Client tools for pgvector connection
- [ ] **Vector Sourcing:** Optimization of `libopenblas` for local embeddings
- [ ] **Connectivity Test:** Connection to external DB containers test

### **Phase 4: Final Polish & Sovereign Config**
- [ ] **Template System:** Config templates for Ollama, ComfyUI, Postgres
- [ ] **Auto-Config:** Integration of `oc_config_helper.py`
- [ ] **The Sovereign Guide:** Final handbook for the user

## 📝 7. Kritische Notizen (aus allen Reviews)

- **Security:** No `privileged: true`. GPU only via optional `video: true`.
- **Model Persistence:** All ML models stored in `/config` or `/data` – **never** in the image.
- **Sovereignty:** Goal is full independence from cloud APIs. Cloud = optional fallback.
- **ARMv7:** Support removed – no longer supported by HA.
- **Base Image:** `ghcr.io/homeassistant/{arch}-base:latest` (Alpine-based like Sanctuary Addons).
- **QMD:** Available via `bun install -g @tobilu/qmd` (models land in `/config`).

## 🔮 Zukünftige Hardware-Integration (vorgebaut)

The following device mappings are **pre-wired** for future OpenClaw features (like Dreaming, Memory-Wiki, Active Memory Plugin, or extended camera integration). They are **disabled by default** – to enable, simply uncomment the corresponding lines in `config.yaml` and set `video: true`.

```yaml
# ============================================
# PREPARED DEVICE MAPPINGS (disabled by default)
# ============================================
# To enable: uncomment line and set video: true
#
# FOR VAAPI/VIDEO-ENCODING (ffmpeg Hardware Acceleration):
#   video: true                          # Sufficient for /dev/dri access
#
# FOR AMD ROCm (future GPU inference in container):
#   devices:
#     - /dev/dri:/dev/dri               # Universal GPU access
#     - /dev/kfd:/dev/kfd               # AMD ROCm Kernel Framework
#
# FOR NVIDIA CUDA (future GPU inference in container):
#   devices:
#     - /dev/nvidia0:/dev/nvidia0        # NVIDIA GPU
#     - /dev/nvidiactl:/dev/nvidiactl    # NVIDIA Control
#     - /dev/nvidia-uvm:/dev/nvidia-uvm  # NVIDIA Unified Virtual Memory
#     - /dev/nvidia-modeset:/dev/nvidia-modeset  # NVIDIA Modeset
#
# FOR CORAL TPU / HAIL AO (future Edge AI acceleration):
#   devices:
#     - /dev/apex_0:/dev/apex_0          # Google Coral Edge TPU
#     - /dev/apex_1:/dev/apex_1          # Second Coral TPU
#     - /dev/hailo0:/dev/hailo0          # Hailo-8 AI Accelerator (e.g., Raspberry Pi AI HAT+)
#     - /dev/hailo1:/dev/hailo1          # Second Hailo-8
#     - /dev/hailo2:/dev/hailo2          # Third Hailo-8 (if present)
#
# FOR VIDEO-CAPTURE (future camera integration):
#   devices:
#     - /dev/video0:/dev/video0          # USB Webcam
#     - /dev/video1:/dev/video1          # Second Camera
#     - /dev/vchiq:/dev/vchiq            # Raspberry Pi CSI Camera
#
# FOR AUDIO INPUT (future microphone arrays):
#   devices:
#     - /dev/snd:/dev/snd                # ALSA Sound Subsystem
#     - /dev/snd/controlC0:/dev/snd/controlC0  # First Soundcard Controller
```

> **Note:** The above mappings assume the corresponding drivers are present in the **Host Kernel** (Home Assistant OS) or via a HassOS-fork (e.g., Sanctuary Systems). OpenClaw itself requires no kernel drivers in the container – only userspace access via the devices.

This framework allows the addon to grow over time – without changing the base structure. Simply uncomment, rebuild, and the new hardware is ready.

## 📜 Update: 2026-04-10 15:21 — Sovereign Fix
Based on live diagnosis of mDNS hell, LLMs timeout, and proxy chain.

### 🔑 Key Fixes
1. **mDNS Must Advertise Correct Port**
   - Wrong: Advertising internal gateway port (18790) → unreachable
   - Right: Advertising external HTTPS port (18789) → reachable via nginx
   - Implementation: In `run.sh`, after nginx startup, use `oc_config_helper.py` to configure mDNS as:
     ```bash
     python3 /oc_config_helper.py apply-discovery-settings \
       --mdns-mode minimal \
       --mdns-service-port 18789 \
       --mdns-host-name "$(hostname -f)"  # e.g., homeassistant.local
     ```
2. **Base Image Upgrade to Debian Trixie (13)**
   - Why: Updated packages (Python 3.13, ffmpeg 7.x, Go 1.23), official HA support, longer lifecycle
   - Base Image: `ghcr.io/homeassistant/{arch}-base-debian:trixie`
   - Impact: Less need for custom builds (e.g., now can `apt install golang-go` for Go)
3. **Group-based Security Replaces Privilege**
   - Wrong: Discussing `privileged: true` (too risky)
   - Right: Grant only necessary groups
     ```yaml
     # In config.yaml
     groups:
       - video        # for libvips, ffmpeg, VAAPI
       - render       # for OpenGL/VAAPI
       - input        # for evdev (mouse/keyboard in skills)
       - tty          # for serial devices in some skills
     ```
4. **Debian-first Strategy for CLI Tools**
   - For tools like `gh`, `openhye`, `gog`:
     - First check if Debian package exists (e.g., `apt install gh`)
     - Only fall back to Homebrew if no Debian package exists
   - Why: Reduce dependency on Homebrew, which consumes ~800 MB persistent storage
5. **Health Check and Smoke Test**
   - Dockerfile: `HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \ CMD wget --no-verbose --tries=1 --spider http://localhost:48099/ || exit 1`
   - Ensures HA can detect if the proxy is truly ready (not just that the container started)

These fixes move us from "it works on my machine" to "it works in HA".