#!/bin/bash
# start_gpu.sh — Start GPU service + cloudflared, auto-register ke backend
# Jalankan: bash ~/jaktraffic_pseudo/start_gpu.sh
#
# Flags:
#   --tunnel-only   Hanya restart cloudflared (GPU service tetap jalan)
#   --force         Kill GPU service juga, start ulang semuanya

BACKEND="https://jaktrafficai.f-mc.my.id"
CF_BIN="/tmp/cloudflared"
GPU_DIR="$HOME/jaktraffic_pseudo"
GPU_PORT=8765
CF_LOG="/tmp/cf.log"
TUNNEL_ONLY=0

for arg in "$@"; do
    [ "$arg" = "--tunnel-only" ] && TUNNEL_ONLY=1
    [ "$arg" = "--force" ]       && TUNNEL_ONLY=0
done

echo "============================================"
echo "  JakTraffic GPU Service Launcher"
echo "============================================"

# ── Pastikan cloudflared tersedia ────────────────────
if [ ! -f "$CF_BIN" ]; then
    echo "[!] Mengunduh cloudflared..."
    curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
         -o "$CF_BIN" && chmod +x "$CF_BIN"
fi

# ── GPU service ───────────────────────────────────────
if [ "$TUNNEL_ONLY" = "0" ]; then
    # Cek apakah GPU service sudah jalan
    GPU_PID=$(pgrep -f gpu_service_v4 | head -1)
    if [ -n "$GPU_PID" ]; then
        echo "[GPU] Sudah jalan (PID $GPU_PID) — skip restart"
    else
        echo "[1/2] Menjalankan GPU service..."
        pkill -f gpu_service_v4 2>/dev/null; sleep 1
        cd "$GPU_DIR" || { echo "ERROR: $GPU_DIR tidak ditemukan"; exit 1; }
        nohup python gpu_service_v4.py > gpu_service.log 2>&1 &
        GPU_PID=$!
        echo "      GPU service PID: $GPU_PID"
        echo -n "      Menunggu model load"
        for i in $(seq 1 15); do
            sleep 2
            if grep -q "FastAPI on" "$GPU_DIR/gpu_service.log" 2>/dev/null; then
                echo " OK"
                break
            fi
            echo -n "."
        done
    fi
else
    echo "[GPU] --tunnel-only: GPU service tidak disentuh"
fi

# ── Restart cloudflared ───────────────────────────────
echo "[2/2] Restart cloudflared tunnel..."
pkill -f "cloudflared tunnel" 2>/dev/null; sleep 2
> "$CF_LOG"
nohup "$CF_BIN" tunnel --url "http://localhost:$GPU_PORT" --no-autoupdate > "$CF_LOG" 2>&1 &
echo "      cloudflared PID: $!"

# Tunggu URL (max 60 detik)
echo -n "      Menunggu tunnel URL"
TUNNEL_URL=""
for i in $(seq 1 30); do
    sleep 2
    TUNNEL_URL=$(grep -oP 'https://\S+\.trycloudflare\.com' "$CF_LOG" | head -1)
    [ -n "$TUNNEL_URL" ] && break
    echo -n "."
done
echo ""

if [ -z "$TUNNEL_URL" ]; then
    echo "ERROR: Tunnel URL tidak muncul. Cek: $CF_LOG"
    exit 1
fi
echo "      Tunnel: $TUNNEL_URL"

# ── Auto-register ke backend (pakai Python, curl tidak tersedia di pod) ───────
RESPONSE=$(python3 - <<PYEOF
import urllib.request, json, sys
payload = json.dumps({
    "url": "$TUNNEL_URL",
    "info": {
        "gpu": "NVIDIA L40S", "vram_gb": 48.3,
        "model": "jaktraffic_yolo11x.pt", "indonesia_model": True,
        "version": "v4", "batch_capable": True, "batch_size_max": 24
    }
}).encode()
req = urllib.request.Request(
    "$BACKEND/api/gpu-register",
    data=payload,
    headers={"Content-Type": "application/json"},
    method="POST"
)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        print(r.read().decode())
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
PYEOF
)

OK=$(echo "$RESPONSE" | grep -o '"ok":true')
if [ -n "$OK" ]; then
    echo "      Backend: registered ✓"
else
    echo "      Backend: $RESPONSE"
fi

echo ""
echo "============================================"
echo "  SELESAI"
echo "  Tunnel : $TUNNEL_URL"
echo "  Monitor: tail -f $GPU_DIR/gpu_service.log"
echo "  Usage  :"
echo "    bash start_gpu.sh              # full start"
echo "    bash start_gpu.sh --tunnel-only # ganti tunnel saja"
echo "============================================"
