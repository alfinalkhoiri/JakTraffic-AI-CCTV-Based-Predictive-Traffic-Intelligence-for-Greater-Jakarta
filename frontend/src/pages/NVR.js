import React, { useState, useEffect, useRef, useCallback } from "react";
import Hls from "hls.js";
import axios from "axios";
import { Link } from "react-router-dom";

const API        = process.env.REACT_APP_API_URL || "";
const WORKER_URL = process.env.REACT_APP_CCTV_PROXY || "";
const SNAP_INT   = 15000;

/* ─── Camera area groups ──────────────────────────────────────────── */
const AREAS = [
  { id:"all",     label:"🗺️ Semua" },
  { id:"pusat",   label:"🏛️ Jak. Pusat",   fn: c => !c.road_type?.includes("toll") && c.lat < -6.16 && c.lat > -6.24 && c.lng > 106.81 && c.lng < 106.87 },
  { id:"utara",   label:"⬆️ Jak. Utara",   fn: c => !c.road_type?.includes("toll") && c.lat > -6.17 && c.lng < 106.93 && c.lng > 106.77 },
  { id:"barat",   label:"⬅️ Jak. Barat",   fn: c => !c.road_type?.includes("toll") && c.lng < 106.80 && c.lat > -6.30 },
  { id:"timur",   label:"➡️ Jak. Timur",   fn: c => !c.road_type?.includes("toll") && c.lng > 106.87 && c.lat > -6.27 },
  { id:"selatan", label:"⬇️ Jak. Selatan", fn: c => !c.road_type?.includes("toll") && c.lat < -6.27 },
  { id:"bekasi",  label:"🏙️ Bekasi",        fn: c => c.lng > 106.96 },
  { id:"tol",     label:"🛣️ Tol",           fn: c => c.road_type === "toll" },
];

/* ─── Single Camera Cell ──────────────────────────────────────────── */
function CameraCell({ cam, height = 200 }) {
  const isSnap   = cam.preview_url?.startsWith("__snap__:");
  const snapPath = isSnap ? cam.preview_url.replace("__snap__:", "") : null;
  const v        = cam.vehicles ?? 0;
  const cond     = v > 40 ? { label:"PADAT", color:"#f43f5e" } : v > 20 ? { label:"RAMAI", color:"#f59e0b" } : { label:"LANCAR", color:"#22c55e" };

  if (snapPath) return <SnapCell snapPath={snapPath} cam={cam} height={height} cond={cond} />;
  if (!cam.preview_url) return <EmptyCell cam={cam} height={height} cond={cond} />;
  return <StreamCell previewUrl={cam.preview_url} cam={cam} height={height} cond={cond} />;
}

function SnapCell({ snapPath, cam, height, cond }) {
  const [src, setSrc] = useState(null);
  const [err, setErr] = useState(false);
  const timer = useRef(null);
  useEffect(() => {
    const url = () => `${API}/api/camera-snapshot/${snapPath}?_=${Date.now()}`;
    setSrc(url()); setErr(false);
    timer.current = setInterval(() => { setSrc(url()); setErr(false); }, SNAP_INT);
    return () => clearInterval(timer.current);
  }, [snapPath]);
  return (
    <div style={{ position:"relative", height, background:"#0c1a2e", overflow:"hidden" }}>
      {!err && src && <img src={src} alt={cam.name} onLoad={() => setErr(false)} onError={() => setErr(true)} style={{ width:"100%", height:"100%", objectFit:"cover" }} />}
      {err && <EmptyState cam={cam} cond={cond} />}
      <CellOverlay cam={cam} cond={cond} live={!err && !!src} badge="📸" />
    </div>
  );
}

function StreamCell({ previewUrl, cam, height, cond }) {
  const vidRef  = useRef(null);
  const hlsRef  = useRef(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const video = vidRef.current;
    if (!video || !previewUrl) return;
    const go = (src) => {
      if (previewUrl.includes(".mp4") || previewUrl.includes("videoclip")) {
        video.src = src; video.onloadedmetadata = () => { video.play().catch(() => {}); setLive(true); };
        video.onerror = () => setLive(false);
        return;
      }
      if (Hls.isSupported()) {
        const hls = new Hls({ maxBufferLength:8, manifestLoadingTimeOut:14000 });
        hlsRef.current = hls;
        hls.loadSource(src); hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); setLive(true); });
        hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { hls.destroy(); hlsRef.current = null; if (WORKER_URL) go(`${WORKER_URL}/?url=${encodeURIComponent(previewUrl)}`); } });
      }
    };
    go(previewUrl);
    return () => { if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; } if (vidRef.current) { vidRef.current.src = ""; } };
  }, [previewUrl]);

  return (
    <div style={{ position:"relative", height, background:"#0c1a2e", overflow:"hidden" }}>
      <video ref={vidRef} muted playsInline autoPlay crossOrigin="anonymous"
        style={{ width:"100%", height:"100%", objectFit:"cover", opacity: live ? 1 : 0, transition:"opacity .4s" }} />
      {!live && <EmptyState cam={cam} cond={cond} />}
      <CellOverlay cam={cam} cond={cond} live={live} badge="LIVE" />
    </div>
  );
}

function EmptyCell({ cam, height, cond }) {
  return (
    <div style={{ position:"relative", height, background:"#0c1a2e", overflow:"hidden" }}>
      <EmptyState cam={cam} cond={cond} />
      <CellOverlay cam={cam} cond={cond} live={false} />
    </div>
  );
}

function EmptyState({ cam, cond }) {
  return (
    <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:8, backgroundImage:"linear-gradient(rgba(56,189,248,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(56,189,248,.03) 1px,transparent 1px)", backgroundSize:"18px 18px" }}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1e3a5f" strokeWidth="1.2" strokeLinecap="round">
        <path d="M15 10l4.553-2.069A1 1 0 0121 8.87V15.13a1 1 0 01-1.447.899L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/>
      </svg>
      <span style={{ fontSize:9, color:"#1e3a5f" }}>Tidak ada stream</span>
    </div>
  );
}

function CellOverlay({ cam, cond, live, badge }) {
  return (
    <>
      {live && (
        <div style={{ position:"absolute", top:6, left:6, background:"rgba(239,68,68,.85)", borderRadius:999, padding:"2px 7px", display:"flex", alignItems:"center", gap:4 }}>
          <span style={{ width:5, height:5, borderRadius:"50%", background:"white", animation:"pulse 1.5s infinite" }} />
          <span style={{ fontSize:9, color:"white", fontWeight:700 }}>{badge || "LIVE"}</span>
        </div>
      )}
      <div style={{ position:"absolute", bottom:0, left:0, right:0, background:"linear-gradient(to top,rgba(2,11,24,.95),transparent)", padding:"24px 8px 6px" }}>
        <div style={{ fontSize:10, fontWeight:700, color:"#f0f9ff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{cam.name}</div>
        <div style={{ display:"flex", alignItems:"center", gap:4, marginTop:2 }}>
          <span style={{ width:5, height:5, borderRadius:"50%", background:cond.color }} />
          <span style={{ fontSize:9, color:cond.color, fontWeight:700 }}>{cond.label}</span>
          <span style={{ fontSize:9, color:"#475569", marginLeft:"auto" }}>{cam.vehicles ?? 0} kend</span>
        </div>
      </div>
    </>
  );
}

/* ─── NVR Page ─────────────────────────────────────────────────────── */
const GRIDS = [
  { id:"2x2", cols:2, rows:2, max:4,  label:"2×2" },
  { id:"2x3", cols:3, rows:2, max:6,  label:"2×3" },
  { id:"3x3", cols:3, rows:3, max:9,  label:"3×3" },
  { id:"1x4", cols:4, rows:1, max:4,  label:"1×4" },
];

export default function NVR() {
  const [cameras, setCameras]   = useState([]);
  const [selected, setSelected] = useState([]);
  const [search, setSearch]     = useState("");
  const [area, setArea]         = useState("all");
  const [grid, setGrid]         = useState(GRIDS[0]);

  useEffect(() => {
    axios.get(`${API}/api/cctv_status`).then(r => {
      setCameras(r.data.filter(c => c.lat != null));
    }).catch(() => {});
  }, []);

  const areaFn  = AREAS.find(a => a.id === area)?.fn;
  const visible = cameras.filter(c =>
    (area === "all" || areaFn?.(c)) &&
    (search === "" || c.name?.toLowerCase().includes(search.toLowerCase()))
  );

  const toggle = (id) => {
    setSelected(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= grid.max) return [...prev.slice(1), id];
      return [...prev, id];
    });
  };

  const slots = Array.from({ length: grid.max }, (_, i) => {
    const camId = selected[i];
    return cameras.find(c => c.id === camId) || null;
  });

  const cellH = Math.floor((window.innerHeight - 120) / grid.rows) - 8;

  return (
    <div style={{ minHeight:"100vh", background:"#020b18", fontFamily:"system-ui,sans-serif", color:"#f0f9ff", display:"flex", flexDirection:"column" }}>
      {/* Top bar */}
      <div style={{ background:"rgba(9,18,36,.97)", borderBottom:"1px solid rgba(56,189,248,.15)", padding:"10px 18px", display:"flex", alignItems:"center", gap:12, flexShrink:0, flexWrap:"wrap" }}>
        <Link to="/" style={{ fontSize:11, color:"#64748b", textDecoration:"none", fontWeight:600, flexShrink:0 }}>← Peta</Link>
        <div style={{ width:1, height:16, background:"rgba(255,255,255,.08)" }} />
        <div style={{ fontSize:13, fontWeight:800, color:"#38bdf8" }}>📹 Grid CCTV</div>
        <div style={{ fontSize:9, color:"#475569" }}>{selected.length}/{grid.max} aktif</div>

        {/* Grid selector */}
        <div style={{ display:"flex", gap:4, marginLeft:"auto" }}>
          {GRIDS.map(g => (
            <button key={g.id} onClick={() => { setGrid(g); setSelected(prev => prev.slice(0, g.max)); }}
              style={{ padding:"4px 10px", background: grid.id===g.id ? "rgba(56,189,248,.15)" : "rgba(255,255,255,.04)", border:`1px solid ${grid.id===g.id?"rgba(56,189,248,.4)":"rgba(255,255,255,.08)"}`, borderRadius:6, fontSize:10, color: grid.id===g.id?"#38bdf8":"#64748b", cursor:"pointer", fontWeight:700 }}>
              {g.label}
            </button>
          ))}
        </div>
        <button onClick={() => setSelected([])}
          style={{ fontSize:10, color:"#f43f5e", background:"rgba(244,63,94,.08)", border:"1px solid rgba(244,63,94,.2)", borderRadius:6, padding:"4px 10px", cursor:"pointer", fontWeight:700 }}>
          Reset
        </button>
      </div>

      <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
        {/* Sidebar */}
        <div style={{ width:220, background:"rgba(5,12,28,.97)", borderRight:"1px solid rgba(255,255,255,.06)", display:"flex", flexDirection:"column", flexShrink:0, overflow:"hidden" }}>
          {/* Search */}
          <div style={{ padding:"10px 10px 6px" }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Cari kamera..."
              style={{ width:"100%", boxSizing:"border-box", background:"rgba(255,255,255,.05)", border:"1px solid rgba(255,255,255,.09)", borderRadius:7, padding:"7px 10px", color:"#f0f9ff", fontSize:11, outline:"none" }} />
          </div>
          {/* Area filter */}
          <div style={{ padding:"0 10px 8px", display:"flex", flexWrap:"wrap", gap:4 }}>
            {AREAS.map(a => (
              <button key={a.id} onClick={() => setArea(a.id)}
                style={{ fontSize:9, padding:"2px 7px", background: area===a.id?"rgba(56,189,248,.15)":"rgba(255,255,255,.04)", border:`1px solid ${area===a.id?"rgba(56,189,248,.3)":"rgba(255,255,255,.07)"}`, borderRadius:4, color: area===a.id?"#38bdf8":"#64748b", cursor:"pointer", fontWeight:600 }}>
                {a.label}
              </button>
            ))}
          </div>
          <div style={{ fontSize:9, color:"#334155", padding:"0 10px 6px" }}>{visible.length} kamera • pilih maks {grid.max}</div>
          {/* Camera list */}
          <div style={{ flex:1, overflowY:"auto" }}>
            {visible.map(cam => {
              const active = selected.includes(cam.id);
              const v = cam.vehicles ?? 0;
              const c = v>40?"#f43f5e":v>20?"#f59e0b":"#22c55e";
              return (
                <div key={cam.id} onClick={() => toggle(cam.id)}
                  style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", cursor:"pointer", background: active?"rgba(56,189,248,.1)":"transparent", borderLeft:`2px solid ${active?"#38bdf8":"transparent"}`, transition:"background .1s" }}>
                  <span style={{ width:7, height:7, borderRadius:"50%", background:c, flexShrink:0 }} />
                  <span style={{ fontSize:10, fontWeight: active?700:400, color: active?"#e2e8f0":"#64748b", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{cam.name}</span>
                  {cam.road_type==="toll" && <span style={{ fontSize:8, color:"#f59e0b", background:"rgba(245,158,11,.1)", borderRadius:3, padding:"1px 4px", flexShrink:0 }}>TOL</span>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Grid */}
        <div style={{ flex:1, padding:6, display:"grid", gridTemplateColumns:`repeat(${grid.cols}, 1fr)`, gridTemplateRows:`repeat(${grid.rows}, 1fr)`, gap:6, overflow:"hidden" }}>
          {slots.map((cam, i) => (
            <div key={i} style={{ background:"rgba(5,12,28,.8)", borderRadius:8, overflow:"hidden", border:"1px solid rgba(255,255,255,.05)", position:"relative" }}>
              {cam
                ? <CameraCell cam={cam} height={cellH} />
                : (
                  <div style={{ height:cellH, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:6, backgroundImage:"linear-gradient(rgba(56,189,248,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(56,189,248,.02) 1px,transparent 1px)", backgroundSize:"20px 20px" }}>
                    <div style={{ width:28, height:28, borderRadius:7, border:"2px dashed rgba(56,189,248,.15)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, color:"#1e3a5f" }}>+</div>
                    <span style={{ fontSize:9, color:"#1e3a5f" }}>Pilih kamera dari daftar</span>
                  </div>
                )
              }
            </div>
          ))}
        </div>
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1}50%{opacity:.4} }
        @keyframes bounce { 0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)} }
        ::-webkit-scrollbar { width:4px } ::-webkit-scrollbar-track { background:transparent } ::-webkit-scrollbar-thumb { background:#1e3a5f; border-radius:2px }
      `}</style>
    </div>
  );
}
