import React, { useRef, useEffect, useCallback, useState } from "react";
import Hls from "hls.js";

const WORKER_URL = process.env.REACT_APP_CCTV_PROXY || "";

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

function LivePreview({ previewUrl }) {
  const videoRef = useRef(null);
  const hlsRef   = useRef(null);
  const [status, setStatus] = useState("loading");

  const startHls = useCallback((src) => {
    const video = videoRef.current;
    if (!video || !src) { setStatus("offline"); return; }
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    const proxied = WORKER_URL ? `${WORKER_URL}/?url=${encodeURIComponent(src)}` : src;

    if (Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 8, liveSyncDurationCount: 2, enableWorker: false });
      hlsRef.current = hls;
      hls.loadSource(proxied);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); setStatus("live"); });
      hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { hls.destroy(); setStatus("offline"); } });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = proxied;
      video.onloadedmetadata = () => { video.play().catch(() => {}); setStatus("live"); };
      video.onerror = () => setStatus("offline");
    } else {
      setStatus("offline");
    }
  }, []);

  useEffect(() => {
    if (previewUrl) { setStatus("loading"); startHls(previewUrl); }
    else setStatus("offline");
    return () => { if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; } };
  }, [previewUrl, startHls]);

  return (
    <div style={{ position: "relative", height: 155, background: "#0f172a", overflow: "hidden" }}>
      <video
        ref={videoRef}
        muted playsInline autoPlay
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: status === "live" ? 1 : 0, transition: "opacity .4s" }}
      />

      {/* Offline / Loading placeholder */}
      {status !== "live" && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <div style={{ fontSize: 36, opacity: 0.2 }}>📷</div>
          <p style={{ fontSize: 11, color: "#475569", margin: 0 }}>
            {status === "loading" ? "Menghubungkan..." : "Preview tidak tersedia"}
          </p>
          {status === "loading" && (
            <div style={{ display: "flex", gap: 4 }}>
              {[0,1,2].map(i => (
                <span key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: "#3b82f6", animation: `bounce 1s ${i*0.15}s infinite` }} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Live badge */}
      {status === "live" && (
        <div style={{ position: "absolute", top: 8, left: 8, background: "rgba(239,68,68,0.9)", borderRadius: 999, padding: "2px 8px", display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "white", animation: "pulse 1.5s infinite" }} />
          <span style={{ fontSize: 10, color: "white", fontWeight: 700 }}>LIVE</span>
        </div>
      )}

      {/* Bottom gradient */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 40, background: "linear-gradient(to top, rgba(15,23,42,0.95), transparent)", pointerEvents: "none" }} />
    </div>
  );
}

export default function MapPopup({ cam, effectiveVehicles, onSelectDetail }) {
  const v   = effectiveVehicles ?? cam.vehicles ?? 0;
  const rec = SIG(v);
  const statusLabel = v > 30 ? "PADAT" : v > 15 ? "RAMAI" : "LANCAR";
  const statusColor = v > 30 ? "#ef4444" : v > 15 ? "#f97316" : "#22c55e";
  const isToll = cam.road_type === "toll";

  return (
    <div style={{ width: 270, fontFamily: "Inter, sans-serif", borderRadius: 12, overflow: "hidden", background: "#1e293b" }}>
      {/* Preview */}
      <LivePreview previewUrl={cam.preview_url} />

      {/* Status strip */}
      <div style={{ background: statusColor + "22", borderBottom: `1px solid ${statusColor}40`, padding: "5px 12px", display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: statusColor }}>{statusLabel}</span>
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
