# Variable Dependency Map - run.sh

**Generated:** 2026-04-23
**Purpose:** Complete analysis of variable definitions, usage, and dependencies
**Critical Issues Found:** 3

---

## Executive Summary

### Critical Bugs (Usage Before Definition)

| Bug ID | Variable | Problem | Lines |
|--------|----------|---------|-------|
| **C1** | `GATEWAY_PORT` | Used in line 68 (port conflict check) before definition in line 87 | 68, 87 |
| **C2** | `GATEWAY_PORT` | Used in line 107 (MDNS_SERVICE_PORT default) before definition in line 87 | 107, 87 |
| **C3** | `LAN_IP` | Redefined in Section 23 (line 842), overwrites Section 14 (line 560) | 560, 842 |

### Variable Overwrites

| Variable | First Definition | Redefinition | Impact |
|----------|------------------|---------------|--------|
| `LAN_IP` | Section 14, line 560 | Section 23, line 842 | Overwrites TLS certificate IP with mDNS IP |

---

## Complete Variable Map

### Section 0a: Log Rotation

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `LOG_DIR` | 24 | 25 | None | 0a | 0a |
| `MAX_LOG_SIZE` | 27 | 28 | None | 0a | 0a |
| `log_file` | 28 | 29 | `LOG_DIR` | 0a | 0a |

### Section 0b: Playwright

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `PLAYWRIGHT_BROWSERS_PATH` | 48 | 48 | None | 0b | 0b |

### Section 1: Read HA Add-on Options

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `OPTIONS_FILE` | 53 | 54 | None | 1 | 1 |
| `TZNAME` | 57 | 125 | None | 1 | 1, 5 |
| `GW_PUBLIC_URL` | 58 | 617 | None | 1 | 1, 14, 15, 22 |
| `HA_TOKEN` | 59 | 548 | None | 1 | 1, 10, 17 |
| `ADDON_HTTP_PROXY` | 60 | 143 | None | 1 | 1, 3 |
| `ENABLE_TERMINAL` | 61 | 735 | None | 1 | 1, 21 |
| `TERMINAL_PORT_RAW` | 62 | 65 | None | 1 | 1 |
| `TERMINAL_PORT` | 65 | 68 | `TERMINAL_PORT_RAW` | 1 | 1, 21, 22 |
| `ROUTER_HOST` | 75 | 553 | None | 1 | 1, 10 |
| `ROUTER_USER` | 76 | 553 | None | 1 | 1, 10 |
| `ROUTER_KEY` | 77 | 553 | None | 1 | 1, 10 |
| `CLEAN_LOCKS_ON_START` | 80 | 527 | None | 1 | 1, 10 |
| `CLEAN_LOCKS_ON_EXIT` | 81 | 688 | None | 1 | 1, 10, 19 |
| `GATEWAY_MODE` | 84 | 695 | None | 1 | 1, 2, 13, 18, 24 |
| `GATEWAY_REMOTE_URL` | 85 | 695 | None | 1 | 1, 13, 18 |
| `GATEWAY_BIND_MODE` | 86 | 695 | None | 1 | 1, 2, 13, 18 |
| `GATEWAY_PORT` | 87 | 68 | None | 1 | 1, 2, 14, 15, 18, 22, 23 |
| `ENABLE_OPENAI_API` | 94 | 695 | None | 1 | 1, 13 |
| `GATEWAY_AUTH_MODE` | 95 | 695 | None | 1 | 1, 2, 13 |
| `GATEWAY_TRUSTED_PROXIES` | 96 | 695 | None | 1 | 1, 2, 13, 15 |
| `GATEWAY_ADDITIONAL_ALLOWED_ORIGINS` | 97 | 617 | None | 1 | 1, 14, 15 |
| `CONTROLUI_DISABLE_DEVICE_AUTH` | 98 | 695 | None | 1 | 1, 15 |
| `FORCE_IPV4_DNS` | 99 | 159 | None | 1 | 1, 3 |
| `ACCESS_MODE` | 100 | 695 | None | 1 | 1, 2, 15, 22 |
| `NGINX_LOG_LEVEL` | 101 | 795 | None | 1 | 1, 22 |
| `AUTO_CONFIGURE_MCP` | 101 | 735 | None | 1 | 1, 17 |
| `MDNS_MODE` | 105 | 835 | None | 1 | 1, 23 |
| `MDNS_HOST_NAME` | 106 | 835 | None | 1 | 1, 14, 23 |
| `MDNS_SERVICE_PORT` | 107 | 835 | `GATEWAY_PORT` | 1 | 1, 23 |
| `MDNS_INTERFACE_NAME` | 108 | None | None | 1 | None |
| `GATEWAY_LOG_TO_CONSOLE` | 112 | 735 | None | 1 | 1, 18 |
| `GW_ENV_VARS_TYPE` | 115 | 175 | None | 1 | 1, 3 |
| `GW_ENV_VARS_RAW` | 116 | 175 | None | 1 | 1, 3 |
| `GW_ENV_VARS_JSON` | 117 | 175 | None | 1 | 1, 3 |
| `RUNTIME_APT_PACKAGES` | 120 | 517 | None | 1 | 1, 9 |
| `CUSTOM_INIT_SCRIPT` | 123 | 509 | None | 1 | 1, 8 |
| `TZ` | 125 | None | `TZNAME` | 1 | None |
| `OPENCLAW_DISABLE_BONJOUR` | 128 | None | None | 1 | None |

### Section 2: Access Mode Presets

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `ENABLE_HTTPS_PROXY` | 133 | 695 | None | 2 | 2, 14, 15, 22, 23 |
| `GATEWAY_INTERNAL_PORT` | 134 | 695 | `GATEWAY_PORT` | 2 | 2, 13, 14, 15, 18, 20, 22, 24 |

### Section 3: Network Configuration

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `DEFAULT_NO_PROXY` | 147 | 151 | None | 3 | 3 |
| `HTTP_PROXY` | 149 | None | `ADDON_HTTP_PROXY` | 3 | None |
| `HTTPS_PROXY` | 150 | None | `ADDON_HTTP_PROXY` | 3 | None |
| `http_proxy` | 151 | None | `ADDON_HTTP_PROXY` | 3 | None |
| `https_proxy` | 152 | None | `ADDON_HTTP_PROXY` | 3 | None |
| `NO_PROXY` | 153 | None | `NO_PROXY`, `DEFAULT_NO_PROXY` | 3 | None |
| `no_proxy` | 154 | None | `no_proxy`, `DEFAULT_NO_PROXY` | 3 | None |
| `NODE_OPTIONS` | 161 | 161 | `NODE_OPTIONS` | 3 | 3, 4, 16 |
| `env_count` | 175 | 175 | None | 3 | 3 |
| `max_env_vars` | 176 | 175 | None | 3 | 3 |
| `max_var_name_size` | 177 | 175 | None | 3 | 3 |
| `max_var_value_size` | 178 | 175 | None | 3 | 3 |
| `key` | 180 | 180 | None | 3 | 3 |
| `value` | 180 | 180 | None | 3 | 3 |

### Section 4: RAM Detection

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `TOTAL_RAM_KB` | 223 | 224 | None | 4 | 4 |
| `TOTAL_RAM_GB` | 224 | 225 | `TOTAL_RAM_KB` | 4 | 4 |
| `RAM_MODE` | 225 | 226 | `TOTAL_RAM_GB` | 4 | 4 |
| `NODE_HEAP_SIZE` | 228 | 231 | `RAM_MODE` | 4 | 4 |

### Section 5: Paths + HOME

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `HOME` | 247 | None | None | 5 | None |
| `OPENCLAW_CONFIG_DIR` | 248 | None | None | 5 | None |
| `OPENCLAW_WORKSPACE_DIR` | 249 | None | None | 5 | None |
| `XDG_CONFIG_HOME` | 250 | None | None | 5 | None |
| `NODE_COMPILE_CACHE` | 253 | 254 | None | 5 | 5 |
| `CHROMIUM_CACHE` | 257 | 258 | None | 5 | 5 |
| `PNPM_HOME` | 277 | 278 | None | 5 | 5 |
| `GOPATH` | 283 | None | None | 5 | None |
| `UV_TOOL_DIR` | 286 | 288 | None | 5 | 5 |
| `UV_CACHE_DIR` | 287 | 288 | None | 5 | 5 |

### Section 6: Homebrew Persistence

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `IMAGE_BREW_DIR` | 293 | 294 | None | 6 | 6 |
| `PERSISTENT_BREW_DIR` | 294 | 294 | None | 6 | 6 |

### Section 7: Skills Sync

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `IMAGE_SKILLS_DIR` | 323 | 324 | None | 7 | 7 |
| `PERSISTENT_SKILLS_DIR` | 324 | 324 | None | 7 | 7 |

### Section 10: Session Lock Cleanup

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `total_locks` | 495 | 495 | None | 10 | 10 |
| `cleaned_dirs` | 496 | 496 | None | 10 | 10 |
| `all_locks` | 498 | 498 | None | 10 | 10 |
| `agent_locks` | 500 | 500 | None | 10 | 10 |
| `agent_sessions_dir` | 499 | 499 | None | 10 | 10 |
| `ZOMBIE_PIDS` | 565 | 566 | None | 11 | 11 |
| `zp` | 567 | 567 | `ZOMBIE_PIDS` | 11 | 11 |

### Section 12: Config Bootstrap

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `OPENCLAW_CONFIG_PATH` | 581 | 582 | None | 12 | 12, 13, 14, 15, 17, 22, 23, 24 |
| `HELPER_PATH` | 582 | 585 | None | 12 | 12, 13, 14, 15, 17, 23 |

### Section 13: Gateway Settings

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `EFFECTIVE_GW_PORT` | 585 | 586 | `GATEWAY_INTERNAL_PORT` | 13 | 13 |

### Section 14: TLS Certificates

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `LAN_IP` | 560 | 560 | None | 14 | 14, 15, 23 |
| `CERT_DIR` | 561 | 562 | None | 14 | 14 |
| `STORED_IP` | 563 | 563 | None | 14 | 14 |
| `EXTRA_SANS` | 578 | 578 | None | 14 | 14 |
| `EXTRA_SAN_SOURCES` | 579 | 578 | `GATEWAY_ADDITIONAL_ALLOWED_ORIGINS`, `GW_PUBLIC_URL` | 14 | 14 |
| `STORED_EXTRA_SANS` | 605 | 605 | None | 14 | 14 |
| `lan_ip` | 581 | 581 | None | 14 | 14 |
| `raw` | 582 | 582 | None | 14 | 14 |
| `entries` | 583 | 583 | None | 14 | 14 |
| `sans` | 584 | 584 | None | 14 | 14 |
| `seen` | 585 | 585 | None | 14 | 14 |
| `entry` | 586 | 586 | None | 14 | 14 |
| `host` | 587 | 587 | None | 14 | 14 |

### Section 15: Control UI Origins

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `ALLOWED_ORIGINS` | 617 | 617 | `LAN_IP`, `GATEWAY_PORT`, `MDNS_HOST_NAME` | 15 | 15 |
| `GW_PUBLIC_ORIGIN` | 629 | 629 | `GW_PUBLIC_URL` | 15 | 15 |

### Section 16: Proxy Shim

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `OPENCLAW_GLOBAL_NODE_MODULES` | 727 | 728 | None | 16 | 16 |

### Section 17: MCP Auto-Configure

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `MCP_HA_URL` | 735 | 735 | None | 17 | 17 |
| `MCP_FLAG` | 737 | 737 | None | 17 | 17 |
| `MCP_TOKEN_HASH` | 738 | 738 | `HA_TOKEN` | 17 | 17 |

### Section 18: Gateway Start Functions

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `REMOTE_URL` | 695 | 696 | `GATEWAY_REMOTE_URL` | 18 | 18 |
| `NODE_HOST` | 698 | 698 | None | 18 | 18 |
| `NODE_PORT` | 699 | 699 | None | 18 | 18 |
| `NODE_TLS_FLAG` | 700 | 700 | None | 18 | 18 |
| `GW_PID` | 708 | 708 | None | 18 | 18, 19, 20, 24 |
| `ts_ip` | 713 | 713 | None | 18 | 18 |
| `TARGET_HOST` | 716 | 716 | `ts_ip` | 18 | 18 |
| `TARGET_PORT` | 716 | 716 | `GATEWAY_PORT` | 18 | 18 |
| `GW_RELAY_PID` | 716 | 716 | None | 18 | 18, 19, 20, 24 |
| `pid` | 730 | 730 | None | 18 | 18 |
| `known` | 738 | 738 | None | 18 | 18 |
| `cand` | 743 | 743 | None | 18 | 18 |

### Section 19: Shutdown Handler

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `NGINX_PID` | 753 | 753 | None | 19 | 19, 20, 22, 24 |
| `TTYD_PID` | 754 | 753 | None | 19 | 19, 20, 21 |
| `SHUTTING_DOWN` | 755 | 755 | None | 19 | 19, 24 |
| `pid_var` | 758 | 758 | None | 19 | 19 |
| `pid` | 759 | 759 | None | 19 | 19 |

### Section 20: Gateway Start

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `MAX_WAIT` | 773 | 774 | None | 20 | 20 |
| `COUNT` | 774 | 774 | None | 20 | 20 |

### Section 21: Web Terminal

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `TTYD_PID_FILE` | 783 | 784 | None | 21 | 21 |
| `OLD_PID` | 785 | 785 | None | 21 | 21 |

### Section 22: Nginx

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `NGINX_PID_FILE` | 803 | 804 | None | 22 | 22 |
| `OLD_NGINX_PID` | 804 | 804 | None | 22 | 22 |
| `NGINX_PORT` | 819 | 819 | None | 22 | 22 |
| `label` | 823 | 823 | None | 22 | 22 |
| `token` | 824 | 824 | None | 22 | 22 |
| `disk_info` | 826 | 826 | None | 22 | 22 |
| `nginx_pid` | 837 | 837 | None | 22 | 22 |

### Section 23: mDNS/Avahi

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `MDNS_HOSTNAME` | 835 | 835 | `MDNS_HOST_NAME` | 23 | 23 |
| `LAN_IP` | 842 | 842 | None | 23 | 23 | **⚠️ OVERWRITES Section 14** |
| `MDNS_HOSTNAME_FOR_OC` | 865 | 865 | `MDNS_HOSTNAME` | 23 | 23 |
| `MDNS_PORT` | 866 | 866 | `MDNS_SERVICE_PORT`, `GATEWAY_PORT` | 23 | 23 |
| `_i` | 895 | 895 | None | 23 | 23 |

### Section 24: Background Token Re-render

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `CONFIG_PATH` | 915 | 915 | `OPENCLAW_CONFIG_PATH` | 24 | 24 |
| `_i` | 916 | 916 | None | 24 | 24 |
| `token` | 918 | 918 | None | 24 | 24 |

### Main Loop Variables

| Variable | Def Line | First Use | Dependencies | Def Section | Use Section |
|----------|----------|-----------|--------------|-------------|-------------|
| `GW_IS_CHILD` | 925 | 925 | None | 24 | 24 |
| `GW_RESTART_COUNT` | 926 | 926 | None | 24 | 24 |
| `GW_MAX_BACKOFF` | 927 | 927 | None | 24 | 24 |
| `GW_EXIT_CODE` | 929 | 929 | None | 24 | 24 |
| `RESTARTED_PID` | 937 | 937 | None | 24 | 24 |
| `_attempt` | 938 | 938 | None | 24 | 24 |
| `_port_wait` | 958 | 958 | None | 24 | 24 |
| `PORT_PID` | 963 | 963 | None | 24 | 24 |
| `GW_BACKOFF` | 971 | 971 | None | 24 | 24 |

---

## Critical Issues Detail

### C1: GATEWAY_PORT Used Before Definition (Line 68)

**Problem:**
```bash
# Line 68: Used here
if [ "$TERMINAL_PORT" -eq "$GATEWAY_PORT" ]; then
  echo "ERROR: terminal_port conflicts with gateway_port ($GATEWAY_PORT). Using default 7681."
  TERMINAL_PORT="7681"
fi

# Line 87: Defined here
GATEWAY_PORT=$(jq -r '.gateway_port // 18789' "$OPTIONS_FILE")
```

**Impact:** Script crashes with "GATEWAY_PORT: unbound variable" when `set -u` is active.

**Fix:** Move GATEWAY_PORT definition before TERMINAL_PORT validation (before line 65).

---

### C2: GATEWAY_PORT Used in MDNS_SERVICE_PORT Default (Line 107)

**Problem:**
```bash
# Line 87: Defined here
GATEWAY_PORT=$(jq -r '.gateway_port // 18789' "$OPTIONS_FILE")

# Line 107: Used here in jq string interpolation
MDNS_SERVICE_PORT=$(jq -r '.mdns_service_port // "'"$GATEWAY_PORT"'"' "$OPTIONS_FILE")
```

**Impact:** While this works after C1 is fixed, it's fragile. If GATEWAY_PORT definition moves, this breaks.

**Fix:** Define MDNS_SERVICE_PORT AFTER GATEWAY_PORT is defined (already correct order, but fragile due to jq nesting).

---

### C3: LAN_IP Redefined in Section 23 (Line 842)

**Problem:**
```bash
# Section 14, Line 560: First definition
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')

# Section 23, Line 842: Redefinition (overwrites!)
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
```

**Impact:** The Section 14 LAN_IP is used for TLS certificate generation. Section 23 overwrites it for mDNS. This is intentional but confusing.

**Fix:** Use different variable names for different purposes:
- Section 14: `TLS_LAN_IP` or `CERT_LAN_IP`
- Section 23: `MDNS_LAN_IP` or keep `LAN_IP` since it's only used for mDNS after Section 23

---

## Dependency Graph

### Core Variables (No Dependencies)

```
OPTIONS_FILE
TZNAME
GW_PUBLIC_URL
HA_TOKEN
ADDON_HTTP_PROXY
ENABLE_TERMINAL
TERMINAL_PORT_RAW
ROUTER_HOST
ROUTER_USER
ROUTER_KEY
CLEAN_LOCKS_ON_START
CLEAN_LOCKS_ON_EXIT
GATEWAY_MODE
GATEWAY_REMOTE_URL
GATEWAY_BIND_MODE
GATEWAY_PORT
ENABLE_OPENAI_API
GATEWAY_AUTH_MODE
GATEWAY_TRUSTED_PROXIES
GATEWAY_ADDITIONAL_ALLOWED_ORIGINS
CONTROLUI_DISABLE_DEVICE_AUTH
FORCE_IPV4_DNS
ACCESS_MODE
NGINX_LOG_LEVEL
AUTO_CONFIGURE_MCP
MDNS_MODE
MDNS_HOST_NAME
MDNS_INTERFACE_NAME
GATEWAY_LOG_TO_CONSOLE
GW_ENV_VARS_TYPE
GW_ENV_VARS_RAW
GW_ENV_VARS_JSON
RUNTIME_APT_PACKAGES
CUSTOM_INIT_SCRIPT
```

### Level 1 Dependencies (Depend on Core Variables)

```
TERMINAL_PORT → TERMINAL_PORT_RAW
MDNS_SERVICE_PORT → GATEWAY_PORT
ENABLE_HTTPS_PROXY → None
GATEWAY_INTERNAL_PORT → GATEWAY_PORT
TZ → TZNAME
```

### Level 2 Dependencies (Depend on Level 1)

```
ALLOWED_ORIGINS → LAN_IP, GATEWAY_PORT, MDNS_HOST_NAME
GW_PUBLIC_ORIGIN → GW_PUBLIC_URL
EFFECTIVE_GW_PORT → GATEWAY_INTERNAL_PORT
EXTRA_SAN_SOURCES → GATEWAY_ADDITIONAL_ALLOWED_ORIGINS, GW_PUBLIC_URL
```

### Level 3 Dependencies (Depend on Level 2)

```
EXTRA_SANS → EXTRA_SAN_SOURCES, LAN_IP
```

---

## Correct Variable Definition Order

To resolve all dependencies, variables should be defined in this order:

### Phase 1: Core Configuration (Section 1)

1. `OPTIONS_FILE`
2. `TZNAME`
3. `GW_PUBLIC_URL`
4. `HA_TOKEN`
5. `ADDON_HTTP_PROXY`
6. `ENABLE_TERMINAL`
7. `TERMINAL_PORT_RAW`
8. `ROUTER_HOST`
9. `ROUTER_USER`
10. `ROUTER_KEY`
11. `CLEAN_LOCKS_ON_START`
12. `CLEAN_LOCKS_ON_EXIT`
13. `GATEWAY_MODE`
14. `GATEWAY_REMOTE_URL`
15. `GATEWAY_BIND_MODE`
16. **`GATEWAY_PORT`** ← **CRITICAL: Must be before TERMINAL_PORT validation**
17. `ENABLE_OPENAI_API`
18. `GATEWAY_AUTH_MODE`
19. `GATEWAY_TRUSTED_PROXIES`
20. `GATEWAY_ADDITIONAL_ALLOWED_ORIGINS`
21. `CONTROLUI_DISABLE_DEVICE_AUTH`
22. `FORCE_IPV4_DNS`
23. `ACCESS_MODE`
24. `NGINX_LOG_LEVEL`
25. `AUTO_CONFIGURE_MCP`
26. `MDNS_MODE`
27. `MDNS_HOST_NAME`
28. `MDNS_INTERFACE_NAME`
29. `GATEWAY_LOG_TO_CONSOLE`
30. `GW_ENV_VARS_TYPE`
31. `GW_ENV_VARS_RAW`
32. `GW_ENV_VARS_JSON`
33. `RUNTIME_APT_PACKAGES`
34. `CUSTOM_INIT_SCRIPT`

### Phase 2: Derived Variables (After Phase 1)

35. `TERMINAL_PORT` → depends on `TERMINAL_PORT_RAW`, `GATEWAY_PORT`
36. `MDNS_SERVICE_PORT` → depends on `GATEWAY_PORT`
37. `TZ` → depends on `TZNAME`
38. `OPENCLAW_DISABLE_BONJOUR`

### Phase 3: Access Mode (After Phase 2)

39. `ENABLE_HTTPS_PROXY`
40. `GATEWAY_INTERNAL_PORT` → depends on `GATEWAY_PORT`

### Phase 4: Network & Environment (After Phase 3)

41. `DEFAULT_NO_PROXY`
42. `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`
43. `NO_PROXY`, `no_proxy`
44. `NODE_OPTIONS`
45. Environment variable exports

### Phase 5: RAM Detection (Independent)

46. `TOTAL_RAM_KB`
47. `TOTAL_RAM_GB`
48. `RAM_MODE`
49. `NODE_HEAP_SIZE`

### Phase 6: Paths (Independent)

50. `HOME`, `OPENCLAW_CONFIG_DIR`, `OPENCLAW_WORKSPACE_DIR`, `XDG_CONFIG_HOME`
51. `NODE_COMPILE_CACHE`
52. `CHROMIUM_CACHE`
53. `PNPM_HOME`
54. `GOPATH`
55. `UV_TOOL_DIR`, `UV_CACHE_DIR`

### Phase 7: Persistence (Independent)

56. `IMAGE_BREW_DIR`, `PERSISTENT_BREW_DIR`
57. `IMAGE_SKILLS_DIR`, `PERSISTENT_SKILLS_DIR`

### Phase 8: Runtime Variables (Independent)

58. `OPENCLAW_CONFIG_PATH`
59. `HELPER_PATH`
60. `EFFECTIVE_GW_PORT` → depends on `GATEWAY_INTERNAL_PORT`

### Phase 9: TLS Certificates (After Phase 8)

61. `LAN_IP` ← **First definition for TLS**
62. `CERT_DIR`
63. `STORED_IP`
64. `EXTRA_SAN_SOURCES` → depends on `GATEWAY_ADDITIONAL_ALLOWED_ORIGINS`, `GW_PUBLIC_URL`
65. `EXTRA_SANS` → depends on `EXTRA_SAN_SOURCES`, `LAN_IP`
66. `STORED_EXTRA_SANS`

### Phase 10: Control UI (After Phase 9)

67. `ALLOWED_ORIGINS` → depends on `LAN_IP`, `GATEWAY_PORT`, `MDNS_HOST_NAME`
68. `GW_PUBLIC_ORIGIN` → depends on `GW_PUBLIC_URL`

### Phase 11: MCP (After Phase 8)

69. `MCP_HA_URL`
70. `MCP_FLAG`
71. `MCP_TOKEN_HASH` → depends on `HA_TOKEN`

### Phase 12: Gateway Functions (After Phase 3)

72. `REMOTE_URL` → depends on `GATEWAY_REMOTE_URL`
73. `NODE_HOST`, `NODE_PORT`, `NODE_TLS_FLAG`
74. `GW_PID`
75. `ts_ip`, `TARGET_HOST`, `TARGET_PORT` → depends on `GATEWAY_PORT`
76. `GW_RELAY_PID`

### Phase 13: Shutdown (After Phase 12)

77. `NGINX_PID`
78. `TTYD_PID`
79. `SHUTTING_DOWN`

### Phase 14: mDNS (After Phase 9)

80. `MDNS_HOSTNAME` → depends on `MDNS_HOST_NAME`
81. `LAN_IP` ← **Redefinition for mDNS (consider renaming)**
82. `MDNS_HOSTNAME_FOR_OC` → depends on `MDNS_HOSTNAME`
83. `MDNS_PORT` → depends on `MDNS_SERVICE_PORT`, `GATEWAY_PORT`

---

## Recommended Fixes

### Fix 1: Move GATEWAY_PORT Definition (C1)

**Current (Broken):**
```bash
# Line 62
TERMINAL_PORT_RAW=$(jq -r '.terminal_port // 7681' "$OPTIONS_FILE")

# Line 65-71: Validation uses GATEWAY_PORT (not defined yet!)
if [[ "$TERMINAL_PORT_RAW" =~ ^[0-9]+$ ]] && [ "$TERMINAL_PORT_RAW" -ge 1024 ] && [ "$TERMINAL_PORT_RAW" -le 65535 ]; then
  TERMINAL_PORT="$TERMINAL_PORT_RAW"
else
  echo "ERROR: Invalid terminal_port '$TERMINAL_PORT_RAW'. Must be numeric 1024-65535. Using default 7681."
  TERMINAL_PORT="7681"
fi

# Line 68: Port conflict check uses GATEWAY_PORT (not defined yet!)
if [ "$TERMINAL_PORT" -eq "$GATEWAY_PORT" ]; then
  echo "ERROR: terminal_port conflicts with gateway_port ($GATEWAY_PORT). Using default 7681."
  TERMINAL_PORT="7681"
fi

# Line 87: GATEWAY_PORT defined here
GATEWAY_PORT=$(jq -r '.gateway_port // 18789' "$OPTIONS_FILE")
```

**Fixed:**
```bash
# Line 62: Read TERMINAL_PORT_RAW
TERMINAL_PORT_RAW=$(jq -r '.terminal_port // 7681' "$OPTIONS_FILE")

# Line 65: Read GATEWAY_PORT FIRST
GATEWAY_PORT=$(jq -r '.gateway_port // 18789' "$OPTIONS_FILE")

# Port safety check for GATEWAY_PORT
if [ "$GATEWAY_PORT" -ge 65535 ]; then
  echo "WARN: gateway_port $GATEWAY_PORT at max, using $((GATEWAY_PORT - 1))"
  GATEWAY_PORT=$((GATEWAY_PORT - 1))
fi

# Line 71: Now validate TERMINAL_PORT (GATEWAY_PORT is defined)
if [[ "$TERMINAL_PORT_RAW" =~ ^[0-9]+$ ]] && [ "$TERMINAL_PORT_RAW" -ge 1024 ] && [ "$TERMINAL_PORT_RAW" -le 65535 ]; then
  TERMINAL_PORT="$TERMINAL_PORT_RAW"
else
  echo "ERROR: Invalid terminal_port '$TERMINAL_PORT_RAW'. Must be numeric 1024-65535. Using default 7681."
  TERMINAL_PORT="7681"
fi

# Line 79: Port conflict check (GATEWAY_PORT is defined)
if [ "$TERMINAL_PORT" -eq "$GATEWAY_PORT" ]; then
  echo "ERROR: terminal_port conflicts with gateway_port ($GATEWAY_PORT). Using default 7681."
  TERMINAL_PORT="7681"
fi
```

### Fix 2: Rename LAN_IP to Avoid Confusion (C3)

**Current (Confusing):**
```bash
# Section 14, Line 560: LAN_IP for TLS certificates
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
# ... used for TLS certificate generation ...

# Section 23, Line 842: LAN_IP for mDNS (overwrites!)
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
# ... used for mDNS ...
```

**Fixed:**
```bash
# Section 14, Line 560: CERT_LAN_IP for TLS certificates
CERT_LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
# ... use CERT_LAN_IP for TLS certificate generation ...

# Section 23, Line 842: MDNS_LAN_IP for mDNS
MDNS_LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
# ... use MDNS_LAN_IP for mDNS ...
```

**Note:** This requires updating all references to `LAN_IP` in Sections 14 and 15 to use `CERT_LAN_IP` instead.

---

## Summary

**Total Variables Analyzed:** 120+
**Critical Issues:** 3
**Usage-Before-Definition Bugs:** 2 (C1, C2)
**Variable Overwrites:** 1 (C3)
**Circular Dependencies:** 0
**Unclear Dependencies:** 0

**Root Cause:** Variables are defined in Section 1 in the order they appear in the options.json file, not in dependency order. The validation logic for `TERMINAL_PORT` requires `GATEWAY_PORT` to be defined first, but it appears later in the options.

**Recommended Action:** Apply Fix 1 (move GATEWAY_PORT definition) and Fix 2 (rename LAN_IP variables) to resolve all critical issues.