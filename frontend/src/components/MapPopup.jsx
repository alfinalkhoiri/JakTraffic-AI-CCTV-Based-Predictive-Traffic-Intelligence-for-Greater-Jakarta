import React, { useRef, useEffect, useCallback, useState } from "react";
import Hls from "hls.js";

const WORKER_URL = process.env.REACT_APP_CCTV_PROXY || "";
const API        = process.env.REACT_APP_API_URL || "";

/* ── Snapshot viewer — refresh setiap SNAP_INTERVAL detik ── */
const SNAP_INTERVAL = 15000;

function SnapshotPreview({ snapPath, onStatusChange }) {
  const [src, setSrc]       = useState(null);
  const [ts,  setTs]        = useState(Date.now());
  const [err, setErr]       = useState(false);
  const timerRef            = useRef(null);

  const buildUrl = () => `${API}/api/camera-snapshot/${snapPath}?_=${Date.now()}`;

  useEffect(() => {
    setSrc(buildUrl());
    setErr(false);
    onStatusChange?.("loading");
    timerRef.current = setInterval(() => { setSrc(buildUrl()); setErr(false); }, SNAP_INTERVAL);
    return () => clearInterval(timerRef.current);
  }, [snapPath]);

  return (
    <div style={{ position:"relative", height:155, background:"linear-gradient(135deg,#0c1a2e,#0f172a)", overflow:"hidden" }}>
      <div style={{ position:"absolute", inset:0, backgroundImage:"linear-gradient(rgba(56,189,248,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(56,189,248,.04) 1px,transparent 1px)", backgroundSize:"20px 20px" }} />
      {!err && src && (
        <img
          src={src}
          alt="CCTV"
          onLoad={() => { setErr(false); onStatusChange?.("live"); }}
          onError={() => { setErr(true); onStatusChange?.("offline"); }}
          style={{ position:"absolute", inset:0, width:"100%", height:"100%", objectFit:"cover" }}
        />
      )}
      {err && (
        <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:6 }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="1.2" strokeLinecap="round">
            <path d="M15 10l4.553-2.069A1 1 0 0121 8.87V15.13a1 1 0 01-1.447.899L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/>
            <line x1="3" y1="3" x2="21" y2="21" stroke="#475569" strokeWidth="1.2"/>
          </svg>
          <p style={{ fontSize:10, color:"#475569", margin:0 }}>Snapshot tidak tersedia</p>
        </div>
      )}
      {/* Live badge */}
      {!err && src && (
        <div style={{ position:"absolute", top:8, left:8, background:"rgba(16,185,129,.9)", borderRadius:999, padding:"2px 8px", display:"flex", alignItems:"center", gap:4 }}>
          <span style={{ width:5, height:5, borderRadius:"50%", background:"white", animation:"pulse 1.5s infinite" }} />
          <span style={{ fontSize:9, color:"white", fontWeight:700 }}>📸 LIVE</span>
        </div>
      )}
      <div style={{ position:"absolute", top:8, right:8, fontSize:8, color:"rgba(255,255,255,.35)", background:"rgba(0,0,0,.4)", borderRadius:3, padding:"1px 5px" }}>
        Refresh /{SNAP_INTERVAL/1000}s
      </div>
      <div style={{ position:"absolute", bottom:0, left:0, right:0, height:40, background:"linear-gradient(to top,rgba(15,23,42,.95),transparent)", pointerEvents:"none" }} />
    </div>
  );
}

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

  const startStream = useCallback((src, useProxy) => {
    const video = videoRef.current;
    if (!video || !src) { updateStatusAndDetect("offline"); return; }
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    const proxied = (useProxy && WORKER_URL) ? `${WORKER_URL}/?url=${encodeURIComponent(src)}` : src;

    // MP4 / direct video — gunakan video element langsung
    if (src.endsWith(".mp4") || src.includes("videoclip")) {
      video.src = proxied;
      video.onloadedmetadata = () => { video.play().catch(() => {}); updateStatusAndDetect("live"); };
      video.onerror = () => {
        if (!useProxy && WORKER_URL) setAttempt(1);
        else updateStatusAndDetect("offline");
      };
      return;
    }

    // HLS stream
    if (Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 10,
        liveSyncDurationCount: 2,
        enableWorker: false,
        manifestLoadingTimeOut: 14000,
        manifestLoadingMaxRetry: 2,
        fragLoadingMaxRetry: 2,
      });
      hlsRef.current = hls;
      hls.loadSource(proxied);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); updateStatusAndDetect("live"); });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal) {
          hls.destroy(); hlsRef.current = null;
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
    startStream(previewUrl, attempt === 1);
    return () => {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      clearInterval(intervalRef.current);
      const v = videoRef.current;
      if (v) { v.src = ""; v.load(); }
    };
  }, [previewUrl, attempt, startStream, updateStatus, updateStatusAndDetect]);

  const retry = () => { setAttempt(0); updateStatus("loading"); };

  return (
    <div style={{ position: "relative", height: 155, background: "linear-gradient(135deg,#0c1a2e 0%,#0f172a 100%)", overflow: "hidden" }}>
      {/* Grid pattern background */}
      <div style={{ position:"absolute", inset:0, backgroundImage:"linear-gradient(rgba(56,189,248,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(56,189,248,.04) 1px,transparent 1px)", backgroundSize:"20px 20px", pointerEvents:"none" }} />

      <video
        ref={videoRef}
        muted playsInline autoPlay
        crossOrigin="anonymous"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: (status === "live" && !yoloImage) ? 1 : 0, transition: "opacity .5s" }}
      />
      {status === "live" && yoloImage && (
        <img src={`data:image/jpeg;base64,${yoloImage}`} alt="YOLO"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
      )}
      <canvas ref={canvasRef} style={{ display: "none" }} />

      {status === "loading" && (
        <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:10 }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round" opacity=".5">
            <path d="M15 10l4.553-2.069A1 1 0 0121 8.87V15.13a1 1 0 01-1.447.899L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/>
          </svg>
          <p style={{ fontSize:10, color:"#334155", margin:0 }}>{attempt === 1 ? "Mencoba via proxy…" : "Menghubungkan…"}</p>
          <div style={{ display:"flex", gap:4 }}>
            {[0,1,2].map(i => <span key={i} style={{ width:5, height:5, borderRadius:"50%", background:"#38bdf8", animation:`bounce .9s ${i*.18}s infinite` }} />)}
          </div>
        </div>
      )}

      {status === "offline" && (
        <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:8 }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="1.2" strokeLinecap="round">
            <path d="M15 10l4.553-2.069A1 1 0 0121 8.87V15.13a1 1 0 01-1.447.899L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/>
            <line x1="3" y1="3" x2="21" y2="21" stroke="#475569" strokeWidth="1.2"/>
          </svg>
          <p style={{ fontSize:10, color:"#475569", margin:0 }}>
            {previewUrl ? "Stream tidak dapat dijangkau" : "Kamera belum dikonfigurasi"}
          </p>
          {previewUrl && (
            <div style={{ display:"flex", gap:5 }}>
              <button onClick={retry}
                style={{ fontSize:9, color:"#64748b", background:"rgba(255,255,255,.05)", border:"1px solid rgba(255,255,255,.1)", borderRadius:5, padding:"3px 9px", cursor:"pointer" }}>
                ↺ Coba Lagi
              </button>
              <a href={previewUrl} target="_blank" rel="noopener noreferrer"
                style={{ fontSize:9, color:"#64748b", background:"rgba(255,255,255,.05)", border:"1px solid rgba(255,255,255,.1)", borderRadius:5, padding:"3px 9px", textDecoration:"none" }}>
                ↗ Tab Baru
              </a>
            </div>
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

export default function MapPopup({ cam, effectiveVehicles, onSelectDetail, showSignalRec = false }) {
  const isSnapUrl     = cam.preview_url?.startsWith("__snap__:");
  const snapPath      = isSnapUrl ? cam.preview_url.replace("__snap__:", "") : null;
  // stream_url takes priority for live HLS; preview_url fallback (balitower etc.)
  const liveUrl       = cam.stream_url || (isSnapUrl ? null : cam.preview_url) || null;

  // "loading" → belum tahu, "live" → stream berhasil, "offline" → gagal
  const [streamStatus, setStreamStatus] = useState("loading");
  const [yoloLiveCount, setYoloLiveCount] = useState(null);

  // Speed estimation state
  const [speed, setSpeed]           = useState(null);   // km/h number | null
  const [speedLoading, setSpeedLoading] = useState(false);

  // Jika ada data kecepatan segar dari GPU scan (< 90 detik), pakai langsung
  useEffect(() => {
    if (cam.speed_kmh != null && cam.last_gpu_scan) {
      const age = (Date.now() - new Date(cam.last_gpu_scan).getTime()) / 1000;
      if (age < 90) { setSpeed(parseFloat(cam.speed_kmh)); return; }
    }
    // Auto-fetch hanya untuk kamera tol (stream_url ada) saat popup buka
    if (cam.stream_url && cam.road_type === 'toll') {
      setSpeedLoading(true);
      fetch(`${API}/api/camera-speed/${cam.id}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.speed_kmh != null) setSpeed(parseFloat(d.speed_kmh)); })
        .catch(() => {})
        .finally(() => setSpeedLoading(false));
    }
  }, [cam.id]); // cam.id adalah satu-satunya dep yang bermakna di sini

  // Sparkline — history 30 menit terakhir, dikelompokkan per menit
  const [sparkData, setSparkData] = useState(null);
  useEffect(() => {
    fetch(`${API}/api/traffic-history/${cam.id}?range=30m`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (Array.isArray(d) && d.length >= 2) setSparkData(d); })
      .catch(() => {});
  }, [cam.id]);

  const speedColor = speed === null ? null
    : speed < 15 ? '#ef4444'
    : speed < 35 ? '#f97316'
    : '#22c55e';
  const speedLabel = speed === null ? null
    : speed < 15 ? 'Macet Total'
    : speed < 35 ? 'Padat Merayap'
    : speed < 60 ? 'Ramai Lancar'
    : 'Lancar';

  const dbV  = effectiveVehicles ?? cam.vehicles ?? 0;
  // Saat stream live dan YOLO sudah berhasil → pakai hitungan YOLO; lainnya → DB
  const v    = (streamStatus === "live" && yoloLiveCount !== null) ? yoloLiveCount : dbV;
  const rec  = SIG(v);
  const { label: statusLabel, color: statusColor } = resolveStatus(
    streamStatus === "live" ? undefined : cam.status, // live → hitung dari YOLO count
    v
  );
  const isToll = cam.road_type === "toll";
  const hasStream    = !!(cam.preview_url || cam.stream_url);
  // SIMULASI hanya saat tidak ada URL kamera sama sekali
  // Kamera dengan URL yang sedang offline → "Tidak Tersedia" bukan "SIMULASI"
  const isSimulation = streamStatus === "offline" && !hasStream;
  const isOffline    = streamStatus === "offline" && hasStream;

  return (
    <div style={{ width: 270, fontFamily: "Inter, sans-serif", borderRadius: 12, overflow: "hidden", background: "#1e293b" }}>
      {/* Preview — snapshot atau HLS stream */}
      {snapPath
        ? <SnapshotPreview snapPath={snapPath} onStatusChange={setStreamStatus} />
        : <LivePreview previewUrl={liveUrl} onStatusChange={setStreamStatus} onYoloResult={setYoloLiveCount} />
      }

      {/* Status strip */}
      <div style={{ background: statusColor + "22", borderBottom: `1px solid ${statusColor}40`, padding: "5px 12px", display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: statusColor }}>{statusLabel}</span>
        {isSimulation && (
          <span style={{ fontSize: 9, color: "#64748b", background: "#0f172a", border: "1px solid #334155", borderRadius: 4, padding: "1px 5px", fontWeight: 600 }}>
            SIMULASI
          </span>
        )}
        {isOffline && (
          <span style={{ fontSize: 9, color: "#94a3b8", background: "#0f172a", border: "1px solid #334155", borderRadius: 4, padding: "1px 5px", fontWeight: 600 }}>
            📡 Offline
          </span>
        )}
        <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: "auto" }}>{v} kendaraan</span>
        {cam.last_gpu_scan && (() => {
          const age = (Date.now() - new Date(cam.last_gpu_scan).getTime()) / 1000;
          return age < 90 ? (
            <span title="Data dari GPU NVIDIA L40S (yolo11l)" style={{
              fontSize: 9, color: '#a5b4fc', background: '#1e1b4b',
              border: '1px solid #4f46e5', borderRadius: 4,
              padding: '1px 5px', fontWeight: 700, marginLeft: 4
            }}>⚡ GPU</span>
          ) : null;
        })()}
      </div>

      {/* Speed bar — hanya untuk kamera dengan stream_url */}
      {(cam.stream_url || speedLoading) && (
        <div style={{ padding: '6px 12px', background: '#0f172a', borderBottom: '1px solid #1e293b' }}>
          {speedLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: '#64748b', animation: 'pulse 1.2s infinite' }}>⏳</span>
              <span style={{ fontSize: 10, color: '#64748b' }}>Mengukur kecepatan lalu lintas...</span>
            </div>
          ) : speed !== null ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18, fontWeight: 900, color: speedColor, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
                {Math.round(speed)}
              </span>
              <div>
                <div style={{ fontSize: 9, color: '#64748b', lineHeight: 1 }}>km/h rata-rata</div>
                <div style={{ fontSize: 10, color: speedColor, fontWeight: 700, lineHeight: 1.4 }}>{speedLabel}</div>
              </div>
              {/* Progress bar */}
              <div style={{ flex: 1, height: 4, background: '#1e293b', borderRadius: 2, overflow: 'hidden', marginLeft: 4 }}>
                <div style={{
                  height: '100%', borderRadius: 2, background: speedColor,
                  width: `${Math.min(100, (speed / 80) * 100)}%`,
                  transition: 'width .6s ease'
                }} />
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* Info */}
      <div style={{ padding: "10px 12px" }}>
        {isToll && (
          <p style={{ fontSize: 9, color: "#f59e0b", fontWeight: 700, textTransform: "uppercase", margin: "0 0 3px" }}>🛣️ JALAN TOL</p>
        )}
        <p style={{ fontSize: 14, fontWeight: 700, color: "white", margin: "0 0 6px", lineHeight: 1.3 }}>{cam.name}</p>

        {/* Sparkline — tren 15 menit terakhir */}
        {sparkData && sparkData.length >= 2 && (() => {
          const vals = sparkData.map(d => Math.round(d.avg_vehicle ?? d.vehicles ?? 0));
          const W = 246, H = 36, PAD = 2;
          const maxV = Math.max(...vals, 1);
          const minV = Math.min(...vals);
          const pts = vals.map((v, i) => {
            const x = PAD + (i / (vals.length - 1)) * (W - PAD * 2);
            const y = PAD + (1 - (v - minV) / (maxV - minV || 1)) * (H - PAD * 2);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          });
          const areaPts = [`${PAD},${H}`, ...pts, `${(W - PAD).toFixed(1)},${H}`].join(' ');
          const last = vals[vals.length - 1];
          const prev = vals[vals.length - 2];
          const trend = last > prev + 2 ? '↑' : last < prev - 2 ? '↓' : '→';
          const trendColor = trend === '↑' ? '#ef4444' : trend === '↓' ? '#22c55e' : '#94a3b8';
          const sparkColor = last > 30 ? '#ef4444' : last > 15 ? '#f97316' : '#22c55e';
          return (
            <div style={{ background: '#0f172a', borderRadius: 8, padding: '6px 8px', marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                <span style={{ fontSize: 9, color: '#64748b', fontWeight: 600 }}>15 MENIT TERAKHIR</span>
                <span style={{ fontSize: 11, color: trendColor, fontWeight: 800 }}>
                  {trend} {last} kend
                </span>
              </div>
              <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
                <defs>
                  <linearGradient id={`sg${cam.id}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={sparkColor} stopOpacity="0.3" />
                    <stop offset="100%" stopColor={sparkColor} stopOpacity="0.03" />
                  </linearGradient>
                </defs>
                <polygon points={areaPts} fill={`url(#sg${cam.id})`} />
                <polyline points={pts.join(' ')} fill="none" stroke={sparkColor} strokeWidth="1.5" strokeLinejoin="round" />
                {/* Dot titik terakhir */}
                <circle cx={pts[pts.length-1].split(',')[0]} cy={pts[pts.length-1].split(',')[1]} r="3" fill={sparkColor} />
              </svg>
            </div>
          );
        })()}

        {/* Signal recommendation — hanya tampil untuk operator (showSignalRec=true) */}
        {showSignalRec && (cam.has_signal ? (
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
        ))}

        {/* Action buttons */}
        <div style={{ display:"flex", gap:6, marginTop:8 }}>
          <button
            onClick={onSelectDetail}
            style={{ flex:1, background:"#334155", border:"none", borderRadius:8, padding:"7px 0", color:"#cbd5e1", fontSize:11, fontWeight:700, cursor:"pointer" }}
            onMouseEnter={e => e.currentTarget.style.background="#475569"}
            onMouseLeave={e => e.currentTarget.style.background="#334155"}
          >
            Analitik Detail →
          </button>
          <button
            title="Ambil Snapshot"
            onClick={() => {
              const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
              const fname = `${cam.name.replace(/[^a-z0-9]/gi,'_')}_${ts}.jpg`;
              if (cam.preview_url?.startsWith('__snap__:')) {
                const url = `${API}/api/camera-snapshot/${cam.preview_url.replace('__snap__:','')}`;
                fetch(url).then(r => r.blob()).then(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = fname; a.click(); });
              } else {
                alert('Snapshot hanya tersedia untuk kamera dengan feed aktif.');
              }
            }}
            style={{ background:"rgba(56,189,248,.12)", border:"1px solid rgba(56,189,248,.2)", borderRadius:8, padding:"7px 10px", color:"#38bdf8", fontSize:13, cursor:"pointer" }}
            title="Unduh snapshot kamera"
          >
            📸
          </button>
        </div>
      </div>

      <style>{`
        @keyframes bounce { 0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)} }
        @keyframes pulse  { 0%,100%{opacity:1}50%{opacity:.4} }
      `}</style>
    </div>
  );
}
