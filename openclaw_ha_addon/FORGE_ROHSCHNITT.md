# Forge-Rohschnitt: Hardware-Limits für eMMC/RAM-limitierte Systeme

## Zielumgebung
- Raspberry Pi 3/4/5 mit eMMC (kein SATA/NVMe)
- RAM: 2-4 GB limitiert
- HaOS auf eMMC/SD-Karte

## Empfohlene Limits

| Ressource | Aktuell (unsicher) | Empfohlen (Forge) | Begründung |
|----------|-------------------|------------------|------------|
| Node.js Heap | 6144 MB | **2048 MB** | OOM-Prävention; PI4 mit 4GB RAM kann nur ~2GB für Node bereitstellen |
| tmpfs npm_cache | 2048 MB | **512 MB** | Reicht für temporäre Packages; wird bei Restart geleert |
| tmpfs node_tmp | 2048 MB | **256 MB** | Kurzlebige Dateien; Yarn/Pnpm nutzen temp-Dateien |
| tmpfs chromium_cache | 2048 MB | **512 MB** | Reduzierte Cache-Größe; 500MB = 524288000 Bytes |
| tmpfs logs | 2048 MB | **128 MB** | Rolling Logs; altes Log wird archiviert/rotated |
| **Gesamt tmpfs** | ~10 GB | **1408 MB (≈1.4 GB)** | Kritische Reduktion für eMMC |

## Implementierungsvorschlag (run.sh Ergänzungen)

```bash
# === FORGE HARDWARE-LIMITS ===
# Auto-Detection für RAM-limitierte Umgebungen (Pi mit eMMC)

detect_available_ram() {
    # Freemem in MB
    local freemem
    freemem=$(free -m 2>/dev/null | awk '/Mem:/{print $7}' || echo "0")
    echo "${freemem:-0}"
}

detect_storage_speed() {
    # eMMC: ~50-100 MB/s sequential write
    # NVMe/SSD: ~500+ MB/s
    local write_speed
    if command -v dd >/dev/null 2>&1; then
        write_speed=$(dd if=/dev/zero of=/tmp/temp_benchmark bs=1M count=10 2>&1 | awk '/bytes/{print $(NF-1)/1024/1024*100}' || echo "50")
        # cleanup
        rm -f /tmp/temp_benchmark 2>/dev/null || true
    else
        echo "50"
    fi
    printf '%.0f' "$write_speed"
}

# Berechne sichere Heap/tmpfs Limits basierend auf verfügbarem RAM
FORGE_RAM_DETECT=$(detect_available_ram)
FORGE_STORAGE_SPEED=$(detect_storage_speed)

# Standard: Pi3/4 mit 2-4GB RAM
# Reserve 1GB für Host-System → Max 2GB (2048MB) für Container
MAX_HEAP=2048
MAX_TMPFS_TOTAL=1408  # 1.4GB Gesamt für alle tmpfs

if [ "$FORGE_RAM_DETECT" -lt 1536 ]; then
    # < 1.5GB RAM frei → Ultra-Low-Mode
    MAX_HEAP=1024
    MAX_TMPFS_TOTAL=512
    echo "WARN: Low RAM detected (${FORGE_RAM_DETECT}MB free) — using FORGE-ULTRA limits"
elif [ "$FORGE_RAM_DETECT" -lt 2560 ]; then
    # 1.5-2.5GB RAM frei → Low-Mode
    MAX_HEAP=1536
    MAX_TMPFS_TOTAL=768
    echo "INFO: Moderate RAM detected (${FORGE_RAM_DETECT}MB free) — using FORGE-LOW limits"
else
    # > 2.5GB RAM frei → Normal-Mode (Pi4 4GB/8GB)
    MAX_HEAP=2048
    MAX_TMPFS_TOTAL=1408
    echo "INFO: Sufficient RAM detected (${FORGE_RAM_DETECT}MB free) — using FORGE-NORMAL limits"
fi

# Erkennung für eMMC (langsam) vs NVMe/SSD (schnell)
if [ "$FORGE_STORAGE_SPEED" -lt 150 ]; then
    # < 150 MB/s → eMMC/SD-Karte detected
    echo "WARN: Slow storage detected (${FORGE_STORAGE_SPEED}MB/s) — eMMC mode enforced"
    # Reduziere tmpfs further für eMMC
    MAX_TMPFS_TOTAL=$((MAX_TMPFS_TOTAL / 2))
    echo "INFO: FORGE tmpfs reduced to ${MAX_TMPFS_TOTAL}MB for eMMC"
fi

# Export mit FORGE-Limits
if [ -z "${NODE_OPTIONS:-}" ]; then
    export NODE_OPTIONS="--max-old-space-size=${MAX_HEAP}"
else
    export NODE_OPTIONS="${NODE_OPTIONS} --max-old-space-size=${MAX_HEAP}"
fi

# tmpfs Mounts mit FORGE-Limits (dynamisch berechnet)
TMPFS_NPM_SIZE=$((MAX_TMPFS_TOTAL / 4))      # 25% für npm cache
TMPFS_NODE_SIZE=$((MAX_TMPFS_TOTAL / 8))      # 12.5% für node tmp
TMPFS_CHROMIUM_SIZE=$((MAX_TMPFS_TOTAL / 2)) # 50% für chromium
TMPFS_LOGS_SIZE=$((MAX_TMPFS_TOTAL / 8))     # 12.5% für logs

echo "INFO: FORGE memory limits: HEAP=${MAX_HEAP}MB, TMPFS_TOTAL=${MAX_TMPFS_TOTAL}MB"
```

## Risiko-Bewertung

| Szenario | Wahrscheinlichkeit | Auswirkung | Mitigation |
|----------|-----------------|-----------|------------|
| OOM-Killer auf Pi3 (1GB) | Hoch | Container-Crash | Heap auf 1GB reduziert |
| eMMC-I/O-Blockierung | Mittel | Gateway-Timeout | tmpfs auf 1.4GB reduziert |
| Bootzeit > 120s | Niedrig | Startup-Failure | sync nur bei Änderung |

## Empfohlene Tests

- [ ] Pi3 1GB RAM: Heap 1GB + tmpfs 512MB → Start ohne OOM
- [ ] Pi4 4GB RAM: Heap 2GB + tmpfs 1.4GB → Startup < 90s
- [ ] eMMC-Benchmark: Write-Speed > 50 MB/s → Gateway responsiv

---
*Forge-Rohschnitt v0.1 — Treasury Resource Agent*