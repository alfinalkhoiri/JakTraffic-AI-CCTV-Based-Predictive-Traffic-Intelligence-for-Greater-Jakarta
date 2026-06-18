import React, { useRef, useEffect, useCallback, useState } from "react";
import Hls from "hls.js";

const WORKER_URL = process.env.REACT_APP_CCTV_PROXY || "";
const API = process.env.REACT_APP_API_URL || "";

const SIG = (v) => {
  if (v > 40) return { light: "green",  green: 90, red: 30,  label: "Perpanjang Hijau",   color: "#ef4444" };
  if (v > 20) return { light: "yellow", green: 60, red: 45,  label: "Siklus Normal",       color: "#f59e0b" };
  return            { light: "red",    green: 30, red: 60,  label: "Kurangi Hijau",       color: "#22c55e" };
};

function MiniLight({ active }) {
  const map = { red: "#ef4444", yellow: "#f59e0b", green: "#22c55e" };
  return (
    <div style={{ background: "#111", border: "1.5px solid #374151", borderRadius: 6, padding: "6px 7px", display: "flex", flexDirection: "column", gap: 5, alignItems: "center" }}>
      {["red","yellow","green"].map(k => (
        <div key={k} style={{
          width: 11, height: 11, borderRadius: "50%",
          background: k === active ? map[k] : "#1e293b",
          boxShadow: k === active ? `0 0 6px ${map[k]}, 0 0 12px ${map[k]}60` : "none",
          border: `1.5px solid ${k === active ? map[k] : "#374151"}`,
        }} />
      ))}
    </div>
  );
}

function LivePreview({ previewUrl, onStatusChange, onYoloResult }) {
  const videoRef    = useRef(null);
  const canvasRef   = useRef(null);
  const hlsRef      = useRef(null);
  const intervalRef = useRef(null);
  const detectingRef = useRef(false);

  const [status, setStatus]         = useState("loading");
  const [attempt, setAttempt]       = useState(0);
  const [yoloCount, setYoloCount]   = useState(null);
  const [yoloImage, setYoloImage]   = useState(null); // annotated image dari YOLO

  const updateStatus = useCallback((s) => {
    setStatus(s);
    if (onStatusChange) onStatusChange(s);
  }, [onStatusChange]);

  /* Auto-YOLO: capture frame → POST ke backend → update count */
  const captureAndDetect = useCallback(async () => {
    if (detectingRef.current) return; // cegah concurrent request
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;
    canvas.width  = video.videoWidth  || 640;
    canvas.height = video.videoHeight || 360;
    try {
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch { return; } // CORS tainted — skip silently
    detectingRef.current = true;
    try {
      const res = await fetch(`${API}/api/detect-frame`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: canvas.toDataURL("image/jpeg", 0.92) }),
      });
      const data = await res.json();
      if (data.success) {
        setYoloCount(data.vehicle_count);
        setYoloImage(data.annotated_image || null);
        if (onYoloResult) onYoloResult(data.vehicle_count);
      }
    } catch { /* backend tidak tersedia */ }
    finally { detectingRef.current = false; }
  }, [onYoloResult]);

  /* Mulai auto-detect tiap 6 detik saat stream live */
  const startAutoDetect = useCallback(() => {
    clearInterval(intervalRef.current);
    captureAndDetect();
    intervalRef.current = setInterval(captureAndDetect, 6000);
  }, [captureAndDetect]);

  /* Stop detect saat offline/unmount */
  useEffect(() => () => clearInterval(intervalRef.current), []);

  const updateStatusAndDetect = useCallback((s) => {
    updateStatus(s);
    if (s === "live") startAutoDetect();
    else clearInterval(intervalRef.current);
  }, [updateStatus, startAutoDetect]);

  const startHls = useCallback((src, useProxy) => {
    const video = videoRef.current;
    if (!video || !src) { updateStatusAndDetect("offline"); return; }
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    const target = (useProxy && WORKER_URL) ? `${WORKER_URL}/?url=${encodeURIComponent(src)}` : src;

    if (Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 8,
        liveSyncDurationCount: 2,
        enableWorker: false,
        manifestLoadingTimeOut: 12000,
        manifestLoadingMaxRetry: 1,
      });
      hlsRef.current = hls;
      hls.loadSource(target);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); updateStatusAndDetect("live"); });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal) {
          hls.destroy();
          hlsRef.current = null;
          if (!useProxy && WORKER_URL) setAttempt(1);
          else updateStatusAndDetect("offline");
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      video.onloadedmetadata = () => { video.play().catch(() => {}); updateStatusAndDetect("live"); };
      video.onerror = () => updateStatusAndDetect("offline");
    } else {
      updateStatusAndDetect("offline");
    }
  }, [updateStatusAndDetect]);

  useEffect(() => {
    if (!previewUrl) { updateStatusAndDetect("offline"); return; }
    updateStatus("loading");
    startHls(previewUrl, attempt === 1);
    return () => {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      clearInterval(intervalRef.current);
    };
  }, [previewUrl, attempt, startHls, updateStatus, updateStatusAndDetect]);

  const retry = () => { setAttempt(0); updateStatus("loading"); };

  return (
    <div style={{ position: "relative", height: 155, background: "#0f172a", overflow: "hidden" }}>
      <video
        ref={videoRef}
        muted playsInline autoPlay
        crossOrigin="anonymous"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: (status === "live" && !yoloImage) ? 1 : 0, transition: "opacity .4s" }}
      />
      {/* Annotated YOLO image overlay — tampil setelah deteksi */}
      {status === "live" && yoloImage && (
        <img
          src={`data:image/jpeg;base64,${yoloImage}`}
          alt="YOLO"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
      {/* Canvas tersembunyi untuk capture frame YOLO */}
      <canvas ref={canvasRef} style={{ display: "none" }} />

      {status !== "live" && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: "0 16px" }}>
          <div style={{ fontSize: 32, opacity: 0.2 }}>📡</div>
          {status === "loading" ? (
            <>
              <p style={{ fontSize: 11, color: "#475569", margin: 0 }}>
                {attempt === 1 ? "Mencoba via proxy..." : "Menghubungkan ke stream..."}
              </p>
              <div style={{ display: "flex", gap: 4 }}>
                {[0,1,2].map(i => (
                  <span key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#3b82f6", animation: `bounce 1s ${i*0.15}s infinite` }} />
                ))}
              </div>
            </>
          ) : (
            <>
              <p style={{ fontSize: 11, color: "#475569", margin: 0, textAlign: "center" }}>Stream tidak terjangkau</p>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={retry} style={{ fontSize: 10, color: "#94a3b8", background: "#1e293b", border: "1px solid #334155", borderRadius: 6, padding: "3px 8px", cursor: "pointer" }}>
                  ↺ Retry
                </button>
                {previewUrl && (
                  <a href={previewUrl} target="_blank" rel="noopener noreferrer"
                    style={{ fontSize: 10, color: "#94a3b8", background: "#1e293b", border: "1px solid #334155", borderRadius: 6, padding: "3px 8px", textDecoration: "none" }}>
                    ↗ Buka di Tab Baru
                  </a>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* LIVE badge */}
      {status === "live" && (
        <div style={{ position: "absolute", top: 8, left: 8, background: "rgba(239,68,68,0.9)", borderRadius: 999, padding: "2px 8px", display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "white", animation: "pulse 1.5s infinite" }} />
          <span style={{ fontSize: 10, color: "white", fontWeight: 700 }}>LIVE</span>
        </div>
      )}

      {/* YOLO vehicle count badge */}
      {status === "live" && yoloCount !== null && (
        <div style={{ position: "absolute", top: 8, right: 8, background: "rgba(16,185,129,0.9)", borderRadius: 999, padding: "2px 8px" }}>
          <span style={{ fontSize: 10, color: "white", fontWeight: 700 }}>🔍 {yoloCount} kend</span>
        </div>
      )}

      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 40, background: "linear-gradient(to top, rgba(15,23,42,0.95), transparent)", pointerEvents: "none" }} />
    </div>
  );
}

/* Konversi status DB → label + warna untuk popup */
function resolveStatus(camStatus, vehicles) {
  // Prioritaskan cam.status dari DB (lebih akurat dari simulasi kendaraan)
  const s = (camStatus || "").toUpperCase();
  if (s === "HIJAU"  || s === "LANCAR") return { label: "LANCAR", color: "#22c55e" };
  if (s === "KUNING" || s === "RAMAI")  return { label: "RAMAI",  color: "#f97316" };
  if (s === "MERAH"  || s === "PADAT")  return { label: "PADAT",  color: "#ef4444" };
  // Fallback ke hitungan kendaraan jika status DB tidak ada
  const v = vehicles ?? 0;
  if (v > 40) return { label: "PADAT",  color: "#ef4444" };
  if (v > 20) return { label: "RAMAI",  color: "#f97316" };
  return              { label: "LANCAR", color: "#22c55e" };
}

export default function MapPopup({ cam, effectiveVehicles, onSelectDetail }) {
  // "loading" → belum tahu, "live" → stream berhasil, "offline" → gagal
  const [streamStatus, setStreamStatus] = useState("loading");
  const [yoloLiveCount, setYoloLiveCount] = useState(null);

  const dbV  = effectiveVehicles ?? cam.vehicles ?? 0;
  // Saat stream live dan YOLO sudah berhasil → pakai hitungan YOLO; lainnya → DB
  const v    = (streamStatus === "live" && yoloLiveCount !== null) ? yoloLiveCount : dbV;
  const rec  = SIG(v);
  const { label: statusLabel, color: statusColor } = resolveStatus(
    streamStatus === "live" ? undefined : cam.status, // live → hitung dari YOLO count
    v
  );
  const isToll = cam.road_type === "toll";
  const isSimulation = streamStatus === "offline";

  return (
    <div style={{ width: 270, fontFamily: "Inter, sans-serif", borderRadius: 12, overflow: "hidden", background: "#1e293b" }}>
      {/* Preview */}
      <LivePreview
        previewUrl={cam.preview_url}
        onStatusChange={setStreamStatus}
        onYoloResult={setYoloLiveCount}
      />

      {/* Status strip */}
      <div style={{ background: statusColor + "22", borderBottom: `1px solid ${statusColor}40`, padding: "5px 12px", display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: statusColor }}>{statusLabel}</span>
        {isSimulation && (
          <span style={{ fontSize: 9, color: "#64748b", background: "#0f172a", border: "1px solid #334155", borderRadius: 4, padding: "1px 5px", fontWeight: 600 }}>
            SIMULASI
          </span>
        )}
        <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: "auto" }}>{v} kendaraan</span>
      </div>

      {/* Info */}
      <div style={{ padding: "10px 12px" }}>
        {isToll && (
          <p style={{ fontSize: 9, color: "#f59e0b", fontWeight: 700, textTransform: "uppercase", margin: "0 0 3px" }}>🛣️ JALAN TOL</p>
        )}
        <p style={{ fontSize: 14, fontWeight: 700, color: "white", margin: "0 0 8px", lineHeight: 1.3 }}>{cam.name}</p>

        {/* Signal recommendation — hanya untuk jalan dengan lampu merah */}
        {cam.has_signal ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#0f172a", borderRadius: 8, padding: "7px 10px" }}>
            <MiniLight active={rec.light} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 10, fontWeight: 700, color: rec.color, margin: "0 0 2px" }}>🚦 {rec.label}</p>
              <div style={{ display: "flex", gap: 10 }}>
                <span style={{ fontSize: 9, color: "#22c55e", fontWeight: 700 }}>Hijau {rec.green}s</span>
                <span style={{ fontSize: 9, color: "#ef4444", fontWeight: 700 }}>Merah {rec.red}s</span>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ background: "#0f172a", borderRadius: 8, padding: "7px 10px", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 14 }}>🛣️</span>
            <p style={{ fontSize: 10, color: "#64748b", margin: 0 }}>Jalan tol — tidak ada lampu merah</p>
          </div>
        )}

        {/* Detail button */}
        <button
          onClick={onSelectDetail}
          style={{ marginTop: 8, width: "100%", background: "#334155", border: "none", borderRadius: 8, padding: "7px 0", color: "#cbd5e1", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
          onMouseEnter={e => e.currentTarget.style.background = "#475569"}
          onMouseLeave={e => e.currentTarget.style.background = "#334155"}
        >
          Lihat Analitik Detail →
        </button>
      </div>

      <style>{`
        @keyframes bounce { 0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)} }
        @keyframes pulse  { 0%,100%{opacity:1}50%{opacity:.4} }
      `}</style>
    </div>
  );
}
