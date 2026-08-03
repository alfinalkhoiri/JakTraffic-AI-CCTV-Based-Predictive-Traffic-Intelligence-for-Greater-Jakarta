import React, { useState, useEffect, useRef, useCallback } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import ChatPopup from "../components/ChatPopup";
import ChatButton from "../components/ChatButton";
import Hls from "hls.js";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

import {
  Video,
  Map as MapIcon,
  Car,
  Bike,
  Activity,
  Plus,
  Pencil,
  Brain,
  Cpu,
  Database,
  Zap,
  CheckCircle,
  XCircle,
  TrafficCone,
} from "lucide-react";

/* ──────────────────────────────────────────────
   Signal Recommendation Helper
────────────────────────────────────────────── */
const getSignalRec = (vehicles) => {
  if (vehicles > 40) return {
    light: "green", green: 90, red: 30,
    label: "Perpanjang Fase Hijau",
    note: "Volume tinggi — prioritaskan pergerakan",
    priority: "TINGGI",
    color: "text-red-400",
    bg: "bg-red-500/10 border-red-500/30",
  };
  if (vehicles > 20) return {
    light: "yellow", green: 60, red: 45,
    label: "Pertahankan Siklus Normal",
    note: "Volume sedang — siklus standar",
    priority: "NORMAL",
    color: "text-yellow-400",
    bg: "bg-yellow-500/10 border-yellow-500/30",
  };
  return {
    light: "red", green: 30, red: 60,
    label: "Kurangi Fase Hijau",
    note: "Volume rendah — alihkan ke jalur lain",
    priority: "RENDAH",
    color: "text-emerald-400",
    bg: "bg-emerald-500/10 border-emerald-500/30",
  };
};

function TrafficLight({ active, size = 18 }) {
  const lights = [
    { key: "red",    hex: "#ef4444" },
    { key: "yellow", hex: "#f59e0b" },
    { key: "green",  hex: "#22c55e" },
  ];
  return (
    <div style={{
      background: "#111827", border: "2px solid #374151",
      borderRadius: 8, padding: "8px 10px",
      display: "inline-flex", flexDirection: "column",
      gap: 6, alignItems: "center", flexShrink: 0,
    }}>
      {lights.map(l => (
        <div key={l.key} style={{
          width: size, height: size, borderRadius: "50%",
          background: l.key === active ? l.hex : "#1e293b",
          boxShadow: l.key === active ? `0 0 8px ${l.hex}, 0 0 16px ${l.hex}60` : "none",
          border: `2px solid ${l.key === active ? l.hex : "#374151"}`,
        }} />
      ))}
    </div>
  );
}

const API_BASE = process.env.REACT_APP_API_URL || "";

/* ======================================================
   🎯 CUSTOM TOOLTIP
====================================================== */
const TrafficTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;

  return (
    <div className="bg-[#020617]/90 border border-blue-500/30 rounded-xl px-4 py-3 shadow-xl">
      <p className="text-[10px] uppercase text-slate-400">Waktu</p>
      <p className="text-sm font-bold text-slate-200">{label}</p>

      <div className="h-px bg-slate-700 my-2" />

      <p className="text-[10px] uppercase text-blue-400">
        Rata-rata Kendaraan
      </p>
      <p className="text-2xl font-black text-blue-400">
        {payload[0].value}
        <span className="text-xs text-slate-400 ml-1">unit</span>
      </p>
    </div>
  );
};

/* ======================================================
   📊 STAT CARD
====================================================== */
const StatCard = ({ title, value, icon }) => (
  <div className="bg-[#1e293b]/50 border border-slate-800 p-6 rounded-2xl relative">
    <div className="absolute top-4 right-4 opacity-10">{icon}</div>
    <p className="text-xs uppercase text-slate-500 font-bold">{title}</p>
    <h2 className="text-4xl font-bold">{value}</h2>
  </div>
);

/* ======================================================
   🎯 YOLO RESULT CARD
====================================================== */
function YoloResultCard({ result, live = false, showTime = false }) {
  if (!result) return null;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="bg-yellow-900/30 border border-yellow-800/50 rounded-xl p-3 text-center">
          {live && <span className="inline-flex items-center gap-1 text-[9px] text-red-400 font-bold mb-0.5"><span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"/>LIVE</span>}
          <p className="text-[9px] text-yellow-500 uppercase font-bold">Total</p>
          <p className="text-3xl font-black text-yellow-400">{result.vehicle_count}</p>
        </div>
        {Object.entries(result.class_counts || {}).map(([k, v]) => (
          <div key={k} className="bg-slate-800/60 rounded-xl p-3 text-center">
            <p className="text-[9px] text-slate-500 uppercase font-bold">{k}</p>
            <p className="text-2xl font-black text-blue-400">{v}</p>
          </div>
        ))}
        {showTime && result.processing_time_ms != null && (
          <div className="bg-slate-800/60 rounded-xl p-3 text-center">
            <p className="text-[9px] text-slate-500 uppercase font-bold">Waktu</p>
            <p className="text-lg font-black text-slate-300">{result.processing_time_ms}ms</p>
          </div>
        )}
      </div>
      {result.annotated_image && (
        <div className="rounded-xl overflow-hidden border border-slate-700">
          <div className="bg-slate-800 px-3 py-1 text-[10px] text-slate-400 font-bold uppercase flex items-center gap-1.5">
            {live && <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"/>}
            Hasil Deteksi YOLO 11
          </div>
          <img src={`data:image/jpeg;base64,${result.annotated_image}`} alt="YOLO" className="w-full" />
        </div>
      )}
    </div>
  );
}

/* ======================================================
   📷 LIVE DETECT PANEL — stream + YOLO untuk operator
====================================================== */
const WORKER_URL = process.env.REACT_APP_CCTV_PROXY || "";
const CLASS_ID   = { car:'Mobil', motorcycle:'Motor', bus:'Bus', truck:'Truk', van:'Van', pickup:'Pickup', angkot:'Angkot', bajaj:'Bajaj', becak:'Becak', gerobak:'Gerobak', minibus:'Minibus' };

function LiveDetectPanel({ cam }) {
  const videoRef     = useRef(null);
  const canvasRef    = useRef(null);
  const hlsRef       = useRef(null);
  const intervalRef  = useRef(null);
  const detectingRef = useRef(false);

  const [status,   setStatus]   = useState("loading");
  const [result,   setResult]   = useState(null);
  const [detecting,setDetecting]= useState(false);
  const [attempt,  setAttempt]  = useState(0);
  const [snapSrc,  setSnapSrc]  = useState(null);

  const isSnapUrl = cam.preview_url?.startsWith("__snap__:");
  const snapPath  = isSnapUrl ? cam.preview_url.replace("__snap__:", "") : null;
  const liveUrl   = cam.stream_url || (isSnapUrl ? null : cam.preview_url) || null;

  const captureAndDetect = useCallback(async (imgData = null) => {
    if (detectingRef.current) return;
    detectingRef.current = true;
    setDetecting(true);
    try {
      let image = imgData;
      if (!image) {
        const video  = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas || video.readyState < 2) return;
        canvas.width  = video.videoWidth  || 640;
        canvas.height = video.videoHeight || 360;
        try { canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height); }
        catch { return; }
        image = canvas.toDataURL("image/jpeg", 0.92);
      }
      const res  = await fetch(`${API_BASE}/api/detect-frame`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ image }) });
      const data = await res.json();
      if (data.success) setResult(data);
    } catch {}
    finally { detectingRef.current = false; setDetecting(false); }
  }, []);

  // Snapshot cameras: load image → send to YOLO
  useEffect(() => {
    if (!snapPath) return;
    const load = async () => {
      const url = `${API_BASE}/api/camera-snapshot/${snapPath}?_=${Date.now()}`;
      setSnapSrc(url);
      try {
        const res = await fetch(url);
        if (!res.ok) { setStatus("offline"); return; }
        const blob   = await res.blob();
        const reader = new FileReader();
        reader.onload = () => { setStatus("live"); captureAndDetect(reader.result); };
        reader.readAsDataURL(blob);
      } catch { setStatus("offline"); }
    };
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [snapPath, captureAndDetect]);

  // URL yang butuh proxy dari awal (CORS blocked dari browser)
  const requiresProxy = !!(liveUrl && WORKER_URL && (
    liveUrl.includes('cctv.balitower.co.id')
  ));

  // HLS stream
  const startStream = useCallback(() => {
    const video = videoRef.current;
    if (!video || !liveUrl) { setStatus("offline"); return; }
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    // Balitower (dan domain yang perlu proxy): langsung pakai Worker, skip direct
    const useProxy = attempt === 1 || requiresProxy;
    const proxied = (useProxy && WORKER_URL) ? `${WORKER_URL}/?url=${encodeURIComponent(liveUrl)}` : liveUrl;

    if (liveUrl.endsWith(".mp4") || liveUrl.includes("videoclip")) {
      video.src = proxied;
      video.onloadedmetadata = () => { video.play().catch(()=>{}); setStatus("live"); };
      video.onerror = () => { if (!requiresProxy && !attempt && WORKER_URL) setAttempt(1); else setStatus("offline"); };
      return;
    }
    if (Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 10, liveSyncDurationCount: 2, enableWorker: false,
        manifestLoadingTimeOut: 6000, manifestLoadingMaxRetry: 1,
        fragLoadingMaxRetry: 2,
      });
      hlsRef.current = hls;
      hls.loadSource(proxied);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(()=>{}); setStatus("live"); });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal) {
          hls.destroy(); hlsRef.current = null;
          if (!requiresProxy && !attempt && WORKER_URL) setAttempt(1);
          else setStatus("offline");
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = proxied;
      video.onloadedmetadata = () => { video.play().catch(()=>{}); setStatus("live"); };
      video.onerror = () => setStatus("offline");
    } else { setStatus("offline"); }
  }, [liveUrl, attempt, requiresProxy]);

  useEffect(() => {
    if (snapPath) return;
    if (!liveUrl) { setStatus("offline"); return; }
    setStatus("loading");
    startStream();
    return () => {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      const v = videoRef.current;
      if (v) { v.src = ""; v.load(); }
    };
  }, [liveUrl, attempt, startStream, snapPath]);

  // Auto-detect setiap 8 detik saat live (HLS)
  useEffect(() => {
    if (status !== "live" || snapPath) return;
    clearInterval(intervalRef.current);
    captureAndDetect();
    intervalRef.current = setInterval(captureAndDetect, 8000);
    return () => clearInterval(intervalRef.current);
  }, [status, captureAndDetect, snapPath]);

  useEffect(() => () => { clearInterval(intervalRef.current); if (hlsRef.current) hlsRef.current.destroy(); }, []);

  return (
    <div style={{ background:'#0f172a', borderRadius:10, overflow:'hidden', border:'1px solid rgba(255,255,255,.06)' }}>
      {/* Stream + annotated overlay */}
      <div style={{ position:'relative', height:190, background:'linear-gradient(135deg,#0c1a2e,#0f172a)' }}>
        <div style={{ position:'absolute', inset:0, backgroundImage:'linear-gradient(rgba(56,189,248,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(56,189,248,.04) 1px,transparent 1px)', backgroundSize:'20px 20px' }} />
        {result?.annotated_image && (
          <img src={`data:image/jpeg;base64,${result.annotated_image}`} alt="YOLO" style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }} />
        )}
        {!snapPath && (
          <video ref={videoRef} muted playsInline autoPlay crossOrigin="anonymous"
            style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', opacity: result?.annotated_image ? 0 : 1, transition:'opacity .4s' }} />
        )}
        {snapPath && snapSrc && !result?.annotated_image && (
          <img src={snapSrc} alt="snapshot" onLoad={() => setStatus("live")} onError={() => setStatus("offline")}
            style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }} />
        )}
        <canvas ref={canvasRef} style={{ display:'none' }} />

        {status === "live" && <div style={{ position:'absolute', top:8, left:8, background:'rgba(16,185,129,.9)', borderRadius:99, padding:'2px 8px', display:'flex', alignItems:'center', gap:4 }}><span style={{ width:5, height:5, borderRadius:'50%', background:'#fff', animation:'pulse 1.5s infinite' }} /><span style={{ fontSize:9, color:'#fff', fontWeight:700 }}>▶ LIVE</span></div>}
        {status === "loading" && (
          <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:8 }}>
            <div style={{ display:'flex', gap:5 }}>
              {[0,1,2].map(i => <span key={i} style={{ width:5, height:5, borderRadius:'50%', background:'#38bdf8', animation:`bounce .9s ${i*.18}s infinite` }} />)}
            </div>
            <div style={{ fontSize:10, color:'#334155' }}>{requiresProxy ? 'Menghubungkan via proxy…' : 'Menghubungkan stream…'}</div>
            {cam.name && <div style={{ fontSize:9, color:'#1e3a5f', fontWeight:600 }}>{cam.name}</div>}
          </div>
        )}
        {status === "offline" && (
          <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:6 }}>
            <span style={{ fontSize:22, opacity:.25 }}>📷</span>
            <div style={{ fontSize:10, color:'#475569' }}>{liveUrl || snapPath ? 'Stream tidak tersedia' : 'Kamera belum dikonfigurasi'}</div>
            {(liveUrl || snapPath) && <button onClick={() => { setAttempt(0); setStatus("loading"); }} style={{ fontSize:9, color:'#64748b', background:'rgba(255,255,255,.05)', border:'1px solid rgba(255,255,255,.1)', borderRadius:5, padding:'3px 8px', cursor:'pointer' }}>↺ Coba Lagi</button>}
          </div>
        )}
        {detecting && <div style={{ position:'absolute', bottom:8, right:8, background:'rgba(99,102,241,.9)', borderRadius:99, padding:'2px 8px', fontSize:9, color:'#fff', fontWeight:700 }}>⚡ Mendeteksi...</div>}
        {status === "live" && !detecting && (
          <button onClick={() => captureAndDetect()}
            style={{ position:'absolute', bottom:8, right:8, background:'rgba(99,102,241,.85)', border:'none', borderRadius:7, padding:'4px 10px', fontSize:9, color:'#fff', fontWeight:700, cursor:'pointer' }}>
            🔍 Deteksi Sekarang
          </button>
        )}
        <div style={{ position:'absolute', bottom:0, left:0, right:0, height:28, background:'linear-gradient(to top,rgba(15,23,42,.95),transparent)', pointerEvents:'none' }} />
      </div>

      {/* Hasil deteksi per kelas */}
      {result && (
        <div style={{ padding:'10px 12px' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
            <span style={{ fontSize:10, fontWeight:700, color:'#a5b4fc' }}>🔍 Deteksi YOLO11 — Model Indonesia</span>
            {result.processing_time_ms != null && <span style={{ fontSize:9, color:'#334155' }}>{result.processing_time_ms}ms</span>}
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr', marginBottom:6 }}>
            <div style={{ background:'rgba(245,158,11,.1)', border:'1px solid rgba(245,158,11,.2)', borderRadius:8, padding:'6px 12px', textAlign:'center' }}>
              <div style={{ fontSize:8, color:'#64748b', fontWeight:700, letterSpacing:.6 }}>TOTAL KENDARAAN</div>
              <div style={{ fontSize:24, fontWeight:900, color:'#fbbf24', fontVariantNumeric:'tabular-nums' }}>{result.vehicle_count}</div>
            </div>
          </div>
          {Object.keys(result.class_counts || {}).length > 0 && (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(58px,1fr))', gap:4 }}>
              {Object.entries(result.class_counts).map(([k, v]) => (
                <div key={k} style={{ background:'rgba(255,255,255,.04)', borderRadius:7, padding:'5px 6px', textAlign:'center' }}>
                  <div style={{ fontSize:8, color:'#475569', fontWeight:600 }}>{CLASS_ID[k] || k}</div>
                  <div style={{ fontSize:15, fontWeight:800, color:'#60a5fa', fontVariantNumeric:'tabular-nums' }}>{v}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ======================================================
   🚀 MAIN ADMIN
====================================================== */
export default function Admin() {
  /* ---------- STATE ---------- */
  const [cctvList, setCctvList] = useState([]);
  const [selectedCam, setSelectedCam] = useState(null);
  // Ref untuk menghindari stale closure di setInterval
  const selectedCamRef = useRef(null);
  useEffect(() => { selectedCamRef.current = selectedCam; }, [selectedCam]);

  const [historyData, setHistoryData] = useState([]);
  const [timeFilter, setTimeFilter] = useState("30m");
  const [refreshKey, setRefreshKey] = useState(0);
  const [liveMode, setLiveMode] = useState(false);

  const [showModal, setShowModal] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editId, setEditId] = useState(null);

  const [formData, setFormData] = useState({
    name: "",
    url: "",
    lat: "",
    lng: "",
  });

  const [modelInfo, setModelInfo] = useState(null);
  const [showChat, setShowChat] = useState(false);

  // GPU Scanner state
  const [gpuStatus, setGpuStatus]         = useState(null);
  const [gpuScanLoading, setGpuScanLoading] = useState(false);
  const [trackerInfo, setTrackerInfo]     = useState(null);
  const [camHealth,   setCamHealth]       = useState(null);
  const [camHealthLoading, setCamHealthLoading] = useState(false);
  const [selectedHealthCam, setSelectedHealthCam] = useState(null);
  const [calibForm,  setCalibForm]        = useState({ pix_per_meter: 8.0, maintenance: false, maintenance_note: '' });
  const [healthSearch, setHealthSearch]   = useState('');
  const [healthFilter, setHealthFilter]   = useState('all');
  const [reports,    setReports]          = useState([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportFilter, setReportFilter]   = useState('all');
  const [reportNote, setReportNote]       = useState({});

  // Dashboard Komando
  const [cmdRefresh,  setCmdRefresh]      = useState(null);
  const [incidents,   setIncidents]       = useState([]);
  const [trainStatus, setTrainStatus]     = useState(null);
  const [trainCheck,  setTrainCheck]      = useState(null);

  // Dataset & Model state
  const [datasetStats, setDatasetStats]   = useState(null);
  const [idModel,      setIdModel]        = useState(null);
  const [modelBackupLoading, setModelBackupLoading] = useState(false);
  const [collectLoading, setCollectLoading] = useState(false);

  // Laporan Periodik
  const [periodicRange,   setPeriodicRange]  = useState('7d');
  const [periodicData,    setPeriodicData]   = useState(null);
  const [periodicLoading, setPeriodicLoading] = useState(false);

  // Prediksi
  const [predOverview,    setPredOverview]   = useState(null);
  const [predCamId,       setPredCamId]      = useState(null);
  const [predDetail,      setPredDetail]     = useState(null);
  const [predLoading,     setPredLoading]    = useState(false);

  // Tab navigation — harus dideklarasikan sebelum useEffect yang pakai [activeTab]
  const [activeTab, setActiveTab] = React.useState('komando');
  const [predSubTab,    setPredSubTab]    = useState('prediksi');
  const [laporanSubTab, setLaporanSubTab] = useState('user');
  const [manSubTab,     setManSubTab]     = useState('data');

  const fetchGpuStatus = () => {
    fetch('/api/gpu-status')
      .then(r => r.json())
      .then(d => setGpuStatus(d))
      .catch(() => {});
  };

  const fetchTrackerInfo = () => {
    const st = gpuStatus;
    if (!st?.url) return;
    fetch(`${st.url}/trackers`)
      .then(r => r.json())
      .then(d => setTrackerInfo(d))
      .catch(() => {});
  };

  const fetchCamHealth = () => {
    setCamHealthLoading(true);
    fetch('/api/cameras/health')
      .then(r => r.json())
      .then(d => { setCamHealth(d); setCamHealthLoading(false); })
      .catch(() => setCamHealthLoading(false));
  };

  const updateCamConfig = (camId, payload) =>
    fetch(`/api/cameras/${camId}/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json()).then(() => fetchCamHealth());

  const fetchReports = (all = false) => {
    setReportsLoading(true);
    fetch(`/api/reports${all ? '?all=1' : ''}`)
      .then(r => r.json())
      .then(d => { setReports(d.reports || []); setReportsLoading(false); })
      .catch(() => setReportsLoading(false));
  };

  const updateReport = (id, status, note) =>
    fetch(`/api/reports/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, operator_note: note }),
    }).then(() => fetchReports(true));

  const deleteReport = (id) =>
    fetch(`/api/reports/${id}`, { method: 'DELETE' })
      .then(() => fetchReports(true));

  const fetchIncidents = () =>
    fetch('/api/incidents')
      .then(r => r.json())
      .then(d => setIncidents(d.incidents || []))
      .catch(() => {});

  const fetchTrainStatus = () =>
    fetch('/api/gpu/train/status').then(r => r.json()).then(setTrainStatus).catch(() => {});
  const fetchTrainCheck = () =>
    fetch('/api/gpu/train/check').then(r => r.json()).then(setTrainCheck).catch(() => {});
  const startTraining = () =>
    fetch('/api/gpu/train/start', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' })
      .then(r => r.json()).then(() => { fetchTrainStatus(); fetchTrainCheck(); }).catch(() => {});
  const stopTraining = () =>
    fetch('/api/gpu/train/stop', { method:'POST' }).then(() => fetchTrainStatus()).catch(() => {});

  // Poll training status setiap 10 detik saat training berjalan
  React.useEffect(() => {
    if (trainStatus?.status !== 'running') return;
    const t = setInterval(fetchTrainStatus, 10000);
    return () => clearInterval(t);
  }, [trainStatus?.status]); // eslint-disable-line

  const fetchDatasetStats = () => {
    fetch('/api/dataset/stats').then(r=>r.json()).then(d=>setDatasetStats(d)).catch(()=>{});
  };
  const fetchIdModel = () => {
    fetch('/api/yolo-model/info').then(r=>r.json()).then(d=>setIdModel(d)).catch(()=>{});
  };

  // Auto-fetch saat tab berganti (menggantikan inline fetch di render)
  React.useEffect(() => {
    if (activeTab === 'komando') { fetchCCTV(); fetchGpuStatus(); fetchReports(true); fetchIncidents(); fetchTrainCheck(); fetchTrainStatus(); }
    if (activeTab === 'laporan') { fetchReports(true); }
    if (activeTab === 'prediksi'){ fetchPredOverview(); }
    if (activeTab === 'manajemen') { fetchCamHealth(); }
    if (activeTab === 'gpu') { fetchGpuStatus(); fetchDatasetStats(); fetchIdModel(); }
  }, [activeTab]); // eslint-disable-line

  React.useEffect(() => {
    if (activeTab === 'laporan') fetchPeriodicReport(periodicRange);
  }, [activeTab]); // eslint-disable-line

  const fetchPeriodicReport = (range) => {
    setPeriodicLoading(true);
    fetch(`/api/reports/periodic?range=${range}`)
      .then(r => r.json())
      .then(d => { setPeriodicData(d); setPeriodicLoading(false); })
      .catch(() => setPeriodicLoading(false));
  };

  const fetchPredOverview = () => {
    fetch('/api/predict/overview')
      .then(r => r.json())
      .then(d => setPredOverview(d))
      .catch(() => {});
  };

  const fetchPredDetail = (camId) => {
    setPredLoading(true);
    fetch(`/api/predict/corridor/${camId}?horizon=6`)
      .then(r => r.json())
      .then(d => { setPredDetail(d); setPredLoading(false); })
      .catch(() => setPredLoading(false));
  };

  // Filter kamera (persisted to localStorage for map page)
  const [routeFilter, setRouteFilter] = useState(() => localStorage.getItem('jak_routeMode')  || 'all');
  const [areaFilter,  setAreaFilter]  = useState(() => localStorage.getItem('jak_cameraArea') || 'all');
  const [filterSaved, setFilterSaved] = useState(false);

  const applyFilter = (newRoute, newArea) => {
    const r = newRoute ?? routeFilter;
    const a = newArea  ?? areaFilter;
    localStorage.setItem('jak_routeMode',  r);
    localStorage.setItem('jak_cameraArea', a);
    setFilterSaved(true);
    setTimeout(() => setFilterSaved(false), 2000);
  };

  // YOLO upload
  const [detectFile, setDetectFile] = useState(null);
  const [detectResult, setDetectResult] = useState(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState("");

  // Simulasi
  const [simResult, setSimResult] = useState(null);
  const [simRunning, setSimRunning] = useState(false);

  /* ======================================================
     📡 FETCH CCTV LIST
  ====================================================== */
  const fetchCCTV = async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/cctv_status`);
      setCctvList(res.data);
      // Gunakan ref (bukan state) untuk menghindari stale closure di setInterval
      const current = selectedCamRef.current;
      if (current) {
        const updated = res.data.find((c) => c.id === current.id);
        // Hanya update jika field yang ditampilkan berubah (hindari re-render yang reset HLS)
        if (updated && (
          updated.vehicles !== current.vehicles ||
          updated.status !== current.status ||
          updated.stream_url !== current.stream_url ||
          updated.preview_url !== current.preview_url ||
          updated.speed_kmh !== current.speed_kmh
        )) {
          setSelectedCam(updated);
        }
      }
      // Tidak ada auto-select — user yang pilih kamera dari daftar
    } catch (err) {
      console.error("Fetch CCTV gagal:", err);
    }
  };

  /* ======================================================
     📊 FETCH HISTORY
  ====================================================== */
  const fetchHistory = async () => {
    if (!selectedCam) return;
    try {
      const res = await axios.get(
        `${API_BASE}/api/traffic-history/${selectedCam.id}?range=${timeFilter}`
      );
      setHistoryData(res.data);
    } catch (err) {
      console.error("Fetch history gagal:", err);
      setHistoryData([]);
    }
  };

  /* ---------- EFFECT ---------- */
  // Auth check
  useEffect(() => {
    if (sessionStorage.getItem('admin_auth') !== '1') {
      window.location.replace('/admin-login');
    }
  }, []);

  useEffect(() => {
    fetchCCTV();
    axios.get(`${API_BASE}/api/model-info`)
      .then(res => setModelInfo(res.data))
      .catch(err => console.error("Model info fetch error:", err));
    const i = setInterval(fetchCCTV, 10000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    fetchHistory();
    setRefreshKey((k) => k + 1);
  }, [selectedCam, timeFilter]);

  /* ======================================================
     🧩 MODAL HANDLER
  ====================================================== */
  const handleDetect = async () => {
    if (!detectFile || detecting) return;
    setDetecting(true);
    setDetectError("");
    setDetectResult(null);
    const form = new FormData();
    form.append("file", detectFile);
    try {
      const res = await axios.post(`${API_BASE}/api/detect-upload`, form, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 120000,
      });
      setDetectResult(res.data);
    } catch (err) {
      setDetectError(err?.response?.data?.error || err.message || "Deteksi gagal");
    } finally {
      setDetecting(false);
    }
  };

  /* ---------- SIMULASI HANDLER ---------- */
  const runSimulasi = async () => {
    if (!selectedCam) return;
    setSimRunning(true);
    // Generate random realistic vehicle counts
    const total = Math.floor(Math.random() * 60) + 5;
    const car   = Math.floor(total * (0.4 + Math.random() * 0.2));
    const moto  = Math.floor(total * (0.2 + Math.random() * 0.2));
    const bus   = Math.floor(Math.random() * 4);
    const truck = total - car - moto - bus;

    // Update DB via API
    try {
      await axios.post(`${API_BASE}/api/simulate-count`, {
        camera_id: selectedCam.id,
        count: total,
      });
    } catch (_) { /* best-effort */ }

    setSimResult({ total, car: Math.max(0, car), motorcycle: Math.max(0, moto), bus, truck: Math.max(0, truck) });
    setSimRunning(false);
    fetchCCTV();
  };

  const openAddModal = () => {
    setIsEditing(false);
    setFormData({ name: "", url: "", lat: "", lng: "" });
    setShowModal(true);
  };

  const openEditModal = () => {
    if (!selectedCam) return;
    setIsEditing(true);
    setEditId(selectedCam.id);
    setFormData({
      name: selectedCam.name,
      url: selectedCam.stream_url,
      lat: selectedCam.lat,
      lng: selectedCam.lng,
    });
    setShowModal(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (isEditing) {
        await axios.put(
          `${API_BASE}/api/update-camera/${editId}`,
          formData
        );
      } else {
        await axios.post(`${API_BASE}/api/add-camera`, formData);
      }
      setShowModal(false);
      fetchCCTV();
    } catch {
      alert("Gagal menyimpan kamera");
    }
  };

  /* ======================================================
     🖥️ RENDER — OPERATOR DASHBOARD (Dishub)
  ====================================================== */
  const onlineCams  = cctvList.filter(c => c.preview_url || c.stream_url).length;
  const padatCount  = cctvList.filter(c => (c.vehicles||0) > 40).length;
  const avgVehicles = cctvList.length ? Math.round(cctvList.reduce((s,c)=>s+(c.vehicles||0),0)/cctvList.length) : 0;

  const A = {
    root:    { display:'flex', height:'100vh', overflow:'hidden', background:'#030811', color:'#e2e8f0', fontFamily:'system-ui,-apple-system,sans-serif' },
    sidebar: { width:220, background:'#040c1c', borderRight:'1px solid rgba(245,158,11,.1)', display:'flex', flexDirection:'column', flexShrink:0 },
    sideHdr: { padding:'18px 16px 14px', borderBottom:'1px solid rgba(245,158,11,.1)' },
    sideNav: { flex:1, overflowY:'auto', padding:'10px 8px' },
    navItem: (active) => ({ display:'flex', alignItems:'center', gap:10, padding:'9px 10px', borderRadius:8, cursor:'pointer', fontSize:12, fontWeight:active?700:500, color:active?'#f59e0b':'#64748b', background:active?'rgba(245,158,11,.1)':'transparent', border:active?'1px solid rgba(245,158,11,.2)':'1px solid transparent', marginBottom:2, transition:'all .15s' }),
    main:    { flex:1, display:'flex', flexDirection:'column', overflow:'hidden' },
    topbar:  { height:56, background:'#04091a', borderBottom:'1px solid rgba(245,158,11,.1)', display:'flex', alignItems:'center', padding:'0 20px', gap:16, flexShrink:0 },
    content: { flex:1, overflowY:'auto', padding:20 },
    card:    { background:'#060f22', border:'1px solid rgba(255,255,255,.07)', borderRadius:10, overflow:'hidden' },
    cardHdr: (color='#f59e0b') => ({ background:`linear-gradient(to right, rgba(${color==='#f59e0b'?'245,158,11':color==='#10b981'?'16,185,129':color==='#60a5fa'?'96,165,250':'168,85,247'},.12) 0%, transparent 100%)`, padding:'10px 16px', borderBottom:'1px solid rgba(255,255,255,.06)', display:'flex', alignItems:'center', gap:8 }),
    statCard:{ background:'#060f22', border:'1px solid rgba(255,255,255,.07)', borderRadius:10, padding:'16px 18px' },
    label:   { fontSize:9, fontWeight:700, letterSpacing:.9, color:'#475569', textTransform:'uppercase', marginBottom:3 },
    big:     { fontSize:34, fontWeight:900, lineHeight:1, fontVariantNumeric:'tabular-nums' },
    badge:   (c,bg) => ({ display:'inline-flex', alignItems:'center', gap:4, background:bg, borderRadius:5, padding:'2px 7px', fontSize:9, color:c, fontWeight:700, letterSpacing:.5 }),
    btn:     (c='#f59e0b') => ({ background:`rgba(${c==='#f59e0b'?'245,158,11':c==='#ef4444'?'239,68,68':'59,130,246'},.15)`, border:`1px solid rgba(${c==='#f59e0b'?'245,158,11':c==='#ef4444'?'239,68,68':'59,130,246'},.3)`, borderRadius:7, padding:'6px 14px', color:c, fontSize:11, fontWeight:700, cursor:'pointer' }),
    tableRow:(alt) => ({ display:'flex', alignItems:'center', gap:10, padding:'7px 14px', background:alt?'rgba(255,255,255,.02)':'transparent', cursor:'pointer', borderBottom:'1px solid rgba(255,255,255,.04)', transition:'background .1s' }),
  };

  const tabStyle = (t) => ({ padding:'8px 16px', fontSize:11, fontWeight:activeTab===t?700:500, color:activeTab===t?'#f59e0b':'#64748b', background:activeTab===t?'rgba(245,158,11,.1)':'transparent', border:'none', borderBottom:activeTab===t?'2px solid #f59e0b':'2px solid transparent', cursor:'pointer', transition:'all .15s', whiteSpace:'nowrap' });
  const subTabStyle = (t, active) => ({ padding:'6px 16px', fontSize:11, fontWeight:active===t?700:500, color:active===t?'#f59e0b':'#64748b', background:active===t?'rgba(245,158,11,.08)':'transparent', border:'none', borderBottom:active===t?'2px solid #f59e0b':'2px solid transparent', cursor:'pointer', transition:'all .15s', whiteSpace:'nowrap' });

  return (
    <>
    <div style={A.root}>

      {/* ══ SIDEBAR ════════════════════════════════════════════════ */}
      <aside style={A.sidebar}>
        {/* Brand */}
        <div style={A.sideHdr}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
            <div style={{ width:32, height:32, borderRadius:8, background:'linear-gradient(135deg,#f59e0b,#d97706)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, fontWeight:900, color:'#020811', boxShadow:'0 0 14px rgba(245,158,11,.4)' }}>D</div>
            <div>
              <div style={{ fontSize:12, fontWeight:800, color:'#fbbf24', lineHeight:1 }}>Dishub Jakarta</div>
              <div style={{ fontSize:9, color:'#475569', lineHeight:1, marginTop:2 }}>Operator Dashboard</div>
            </div>
          </div>
          <div style={{ background:'rgba(245,158,11,.1)', border:'1px solid rgba(245,158,11,.2)', borderRadius:6, padding:'4px 8px', display:'flex', alignItems:'center', gap:5 }}>
            <span style={{ width:6, height:6, borderRadius:'50%', background:'#10b981', boxShadow:'0 0 5px #10b981' }} />
            <span style={{ fontSize:9, color:'#10b981', fontWeight:700 }}>SISTEM AKTIF</span>
            <span style={{ marginLeft:'auto', fontSize:9, color:'#475569' }}>{cctvList.length} titik</span>
          </div>
          <div style={{ marginTop:6, background:'rgba(239,68,68,.08)', border:'1px solid rgba(239,68,68,.2)', borderRadius:5, padding:'3px 8px', display:'flex', alignItems:'center', gap:5 }}>
            <span style={{ fontSize:9, color:'#f87171', fontWeight:800, letterSpacing:.5 }}>🔐 OPERATOR ONLY</span>
          </div>
        </div>

        {/* Navigation */}
        <nav style={A.sideNav}>
          {[
            { id:'komando',   icon:'🖥️', label:'Komando',         desc:'Command center' },
            { id:'prediksi',  icon:'🔮', label:'Prediksi & Sinyal',desc:'Prediksi AI & sinyal' },
            { id:'laporan',   icon:'📋', label:'Laporan',          desc:'Laporan & export data' },
            { id:'manajemen', icon:'🗄️', label:'Manajemen',        desc:'Kamera, model & filter' },
            { id:'gpu',       icon:'⚡', label:'GPU & Dataset',    desc:'Model training & dataset' },
          ].map(item => (
            <div key={item.id} style={A.navItem(activeTab===item.id)} onClick={() => setActiveTab(item.id)}>
              <span style={{ fontSize:15 }}>{item.icon}</span>
              <div>
                <div>{item.label}</div>
                <div style={{ fontSize:9, color:'#475569', fontWeight:400 }}>{item.desc}</div>
              </div>
            </div>
          ))}
        </nav>

        {/* Footer links */}
        <div style={{ padding:'12px 8px', borderTop:'1px solid rgba(245,158,11,.1)' }}>
          <div style={{ display:'flex', gap:4, marginBottom:2 }}>
            <a href="/" target="_blank" rel="noreferrer" style={{ flex:1, display:'flex', alignItems:'center', gap:6, padding:'7px 8px', borderRadius:7, fontSize:10, color:'#475569', textDecoration:'none', fontWeight:600, border:'1px solid rgba(255,255,255,.06)', background:'rgba(255,255,255,.03)' }}>
              <MapIcon size={12} /> User ↗
            </a>
            <a href="/nvr" target="_blank" rel="noreferrer" style={{ flex:1, display:'flex', alignItems:'center', gap:6, padding:'7px 8px', borderRadius:7, fontSize:10, color:'#38bdf8', textDecoration:'none', fontWeight:600, border:'1px solid rgba(56,189,248,.15)', background:'rgba(56,189,248,.05)' }}>
              📹 NVR ↗
            </a>
          </div>
          <button onClick={() => setShowChat(v => !v)} style={{ width:'100%', display:'flex', alignItems:'center', gap:8, padding:'8px 10px', borderRadius:8, fontSize:11, color:showChat?'#f59e0b':'#64748b', background:showChat?'rgba(245,158,11,.1)':'transparent', border:'none', cursor:'pointer', fontWeight:600, marginTop:2 }}>
            🤖 <span>AI Assistant</span>
          </button>
          <button
            onClick={() => { sessionStorage.removeItem('admin_auth'); window.location.replace('/admin-login'); }}
            style={{ width:'100%', background:'rgba(239,68,68,.1)', border:'1px solid rgba(239,68,68,.2)', borderRadius:7, padding:'8px 0', fontSize:11, color:'#f87171', fontWeight:700, cursor:'pointer', marginTop:6 }}
          >
            🔓 Keluar
          </button>
        </div>
      </aside>

      {/* ══ MAIN AREA ══════════════════════════════════════════════ */}
      <div style={A.main}>

        {/* ── TOP BAR ── */}
        <header style={A.topbar}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ fontSize:14, fontWeight:800, color:'#fbbf24' }}>
              {[{id:'komando',title:'Dashboard Komando'},{id:'prediksi',title:'Prediksi AI & Sinyal Adaptif'},{id:'laporan',title:'Laporan'},{id:'manajemen',title:'Manajemen Kamera'},{id:'gpu',title:'GPU Scanner & Dataset Training'}].find(t=>t.id===activeTab)?.title || 'Dashboard Operator'}
            </div>
            <span style={{ fontSize:9, fontWeight:800, color:'#f87171', background:'rgba(239,68,68,.1)', border:'1px solid rgba(239,68,68,.2)', borderRadius:4, padding:'2px 6px', letterSpacing:.5 }}>
              OPERATOR
            </span>
          </div>

          {/* Stats strip */}
          <div style={{ display:'flex', gap:12, marginLeft:'auto', alignItems:'center' }}>
            {[
              { label:'Kamera Online', value:onlineCams, color:'#10b981' },
              { label:'Lokasi Padat', value:padatCount, color:'#f43f5e' },
              { label:'Rata-rata Kend.', value:avgVehicles, color:'#60a5fa' },
            ].map(s => (
              <div key={s.label} style={{ textAlign:'right' }}>
                <div style={{ fontSize:16, fontWeight:900, color:s.color, fontVariantNumeric:'tabular-nums', lineHeight:1 }}>{s.value}</div>
                <div style={{ fontSize:8, color:'#475569', fontWeight:600, letterSpacing:.5, marginTop:1 }}>{s.label.toUpperCase()}</div>
              </div>
            ))}
            <button onClick={() => { fetchCCTV(); fetchHistory(); }} style={A.btn('#60a5fa')}>↻ Refresh</button>
          </div>
        </header>


        {/* ── CONTENT ── */}
        <div style={A.content}>

          {/* ════════════ TAB: KOMANDO ════════════ */}
          {activeTab === 'komando' && (() => {
            const sorted     = [...cctvList].sort((a,b) => (b.vehicles||0) - (a.vehicles||0));
            const critical   = sorted.filter(c => (c.vehicles||0) > 40);
            const warning    = sorted.filter(c => (c.vehicles||0) > 20 && (c.vehicles||0) <= 40);
            const normal     = sorted.filter(c => (c.vehicles||0) <= 20);
            const totalVeh   = cctvList.reduce((s,c) => s+(c.vehicles||0), 0);
            const gpuOk      = gpuStatus?.healthy;
            const pendRep    = reports.filter(r => r.status === 'pending').length;
            const incCount   = incidents.length;

            return (
              <div style={{ display:'flex', flexDirection:'column', gap:12, height:'calc(100vh - 116px)' }}>

                {/* ── Metrik utama ── */}
                <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:10, flexShrink:0 }}>
                  {[
                    { label:'Total Kamera',  val:cctvList.length,  c:'#60a5fa', icon:'📹' },
                    { label:'Siaran Aktif',  val:onlineCams,        c:'#22c55e', icon:'📡' },
                    { label:'KRITIS',        val:critical.length,   c:'#f43f5e', icon:'🔴' },
                    { label:'WASPADA',       val:warning.length,    c:'#f59e0b', icon:'🟡' },
                    { label:'Insiden AI',    val:incCount,          c:incCount>0?'#f97316':'#475569', icon:'🚨' },
                    { label:'Laporan Baru',  val:pendRep,           c:pendRep>0?'#f43f5e':'#475569', icon:'📣' },
                    { label:'GPU',           val:gpuOk?'ONLINE':'OFFLINE', c:gpuOk?'#22c55e':'#f43f5e', icon:'⚡' },
                  ].map(m => (
                    <div key={m.label} style={{ background:'#0f172a', border:`1px solid ${m.c}22`, borderRadius:10, padding:'12px 14px', position:'relative', overflow:'hidden' }}>
                      <div style={{ position:'absolute', right:10, top:10, fontSize:18, opacity:.18 }}>{m.icon}</div>
                      <div style={{ fontSize:m.label==='GPU'?14:22, fontWeight:900, color:m.c, lineHeight:1, fontVariantNumeric:'tabular-nums' }}>{m.val}</div>
                      <div style={{ fontSize:9, color:'#475569', fontWeight:700, letterSpacing:.6, marginTop:4 }}>{m.label}</div>
                    </div>
                  ))}
                </div>

                {/* ── Body: Alert Feed | Daftar Kamera | Detail ── */}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 230px 1.45fr', gap:12, flex:1, minHeight:0 }}>

                  {/* ── ALERT FEED ── */}
                  <div style={{ background:'#0b1324', borderRadius:12, border:'1px solid rgba(255,255,255,.06)', overflow:'hidden', display:'flex', flexDirection:'column', height:'100%' }}>
                    <div style={{ padding:'12px 16px', borderBottom:'1px solid rgba(255,255,255,.06)', display:'flex', alignItems:'center', gap:10, background:'rgba(255,255,255,.02)' }}>
                      <div style={{ fontSize:12, fontWeight:800, color:'#e2e8f0' }}>🚨 Alert Feed Real-time</div>
                      <span style={{ fontSize:9, color:'#64748b' }}>Diurutkan berdasarkan kepadatan tertinggi</span>
                      <button onClick={() => { fetchCCTV(); setCmdRefresh(new Date().toLocaleTimeString('id-ID')); }} style={{ marginLeft:'auto', background:'rgba(255,255,255,.05)', border:'1px solid rgba(255,255,255,.08)', borderRadius:6, padding:'4px 10px', color:'#64748b', fontSize:10, cursor:'pointer', fontWeight:700 }}>↻ {cmdRefresh || 'Refresh'}</button>
                    </div>
                    <div style={{ overflowY:'auto', flex:1, minHeight:0 }}>
                      {/* ── Insiden AI ── */}
                      {incidents.length > 0 && (
                        <>
                          <div style={{ padding:'6px 16px', background:'rgba(249,115,22,.08)', borderBottom:'1px solid rgba(249,115,22,.15)', fontSize:9, fontWeight:800, color:'#fb923c', letterSpacing:.8, display:'flex', alignItems:'center', gap:8 }}>
                            🚨 INSIDEN TERDETEKSI AI — {incidents.length} LOKASI
                            <button onClick={fetchIncidents} style={{ marginLeft:'auto', background:'transparent', border:'none', color:'#64748b', fontSize:9, cursor:'pointer' }}>↻</button>
                          </div>
                          {incidents.map((inc, i) => (
                            <div key={inc.cam_id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 16px', borderBottom:'1px solid rgba(249,115,22,.08)', background:i%2===0?'rgba(249,115,22,.04)':'transparent' }}>
                              <div style={{ width:8, height:8, borderRadius:2, background:inc.color||'#f97316', flexShrink:0, animation:inc.severity==='critical'?'pulse-red 1.5s infinite':'none' }} />
                              <div style={{ flex:1, minWidth:0 }}>
                                <div style={{ fontSize:11, fontWeight:700, color:'#fed7aa', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{inc.cam_name}</div>
                                <div style={{ fontSize:9, color:'#64748b', marginTop:1 }}>{inc.label} · {inc.vehicle_count} kend{inc.speed_kmh!=null?` · ${inc.speed_kmh} km/h`:''}</div>
                              </div>
                              <span style={{ fontSize:8, fontWeight:800, color:inc.severity==='critical'?'#f43f5e':'#f97316', background:inc.severity==='critical'?'rgba(244,63,94,.1)':'rgba(249,115,22,.1)', border:`1px solid ${inc.severity==='critical'?'rgba(244,63,94,.2)':'rgba(249,115,22,.2)'}`, borderRadius:4, padding:'2px 6px', letterSpacing:.4 }}>
                                {inc.severity==='critical'?'KRITIS':'WASPADA'}
                              </span>
                            </div>
                          ))}
                        </>
                      )}
                      {/* Critical */}
                      {critical.length > 0 && (
                        <>
                          <div style={{ padding:'6px 16px', background:'rgba(244,63,94,.06)', borderBottom:'1px solid rgba(244,63,94,.12)', fontSize:9, fontWeight:800, color:'#f43f5e', letterSpacing:.8 }}>
                            🔴 KRITIS — {critical.length} LOKASI
                          </div>
                          {critical.map((c,i) => (
                            <div key={c.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 16px', borderBottom:'1px solid rgba(244,63,94,.06)', background:i%2===0?'rgba(244,63,94,.03)':'transparent' }}>
                              <div style={{ width:6, height:6, borderRadius:'50%', background:'#f43f5e', boxShadow:'0 0 8px #f43f5e', flexShrink:0, animation:'pulse-red 1.5s infinite' }} />
                              <div style={{ flex:1, minWidth:0 }}>
                                <div style={{ fontSize:11, fontWeight:700, color:'#fca5a5', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.name}</div>
                                <div style={{ fontSize:9, color:'#64748b', marginTop:1 }}>{c.road_type==='toll'?'Tol':'Kota'} · ID {c.id}</div>
                              </div>
                              <div style={{ textAlign:'right', flexShrink:0 }}>
                                <div style={{ fontSize:22, fontWeight:900, color:'#f43f5e', lineHeight:1, fontVariantNumeric:'tabular-nums' }}>{c.vehicles}</div>
                                <div style={{ fontSize:8, color:'#f43f5e', fontWeight:700 }}>PADAT</div>
                              </div>
                              {c.speed_kmh != null && <div style={{ fontSize:10, color:'#64748b', flexShrink:0, fontVariantNumeric:'tabular-nums' }}>{c.speed_kmh} km/h</div>}
                            </div>
                          ))}
                        </>
                      )}
                      {/* Warning */}
                      {warning.length > 0 && (
                        <>
                          <div style={{ padding:'6px 16px', background:'rgba(245,158,11,.06)', borderBottom:'1px solid rgba(245,158,11,.1)', fontSize:9, fontWeight:800, color:'#f59e0b', letterSpacing:.8 }}>
                            🟡 WASPADA — {warning.length} LOKASI
                          </div>
                          {warning.map((c,i) => (
                            <div key={c.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'9px 16px', borderBottom:'1px solid rgba(245,158,11,.04)', background:i%2===0?'rgba(245,158,11,.02)':'transparent' }}>
                              <div style={{ width:6, height:6, borderRadius:'50%', background:'#f59e0b', flexShrink:0 }} />
                              <div style={{ flex:1, minWidth:0 }}>
                                <div style={{ fontSize:11, fontWeight:600, color:'#fde68a', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.name}</div>
                                <div style={{ fontSize:9, color:'#64748b' }}>{c.road_type==='toll'?'Tol':'Kota'} · ID {c.id}</div>
                              </div>
                              <div style={{ fontSize:18, fontWeight:800, color:'#f59e0b', fontVariantNumeric:'tabular-nums' }}>{c.vehicles}</div>
                            </div>
                          ))}
                        </>
                      )}
                      {/* Normal summary */}
                      {normal.length > 0 && (
                        <div style={{ padding:'8px 16px', display:'flex', alignItems:'center', gap:8, borderBottom:'1px solid rgba(34,197,94,.06)' }}>
                          <div style={{ width:6, height:6, borderRadius:'50%', background:'#22c55e', flexShrink:0 }} />
                          <div style={{ fontSize:11, color:'#22c55e', fontWeight:700 }}>{normal.length} lokasi LANCAR</div>
                          <div style={{ flex:1, height:3, background:'rgba(34,197,94,.15)', borderRadius:99, overflow:'hidden' }}>
                            <div style={{ width:`${Math.round(normal.length/cctvList.length*100)}%`, height:'100%', background:'#22c55e', borderRadius:99 }} />
                          </div>
                          <div style={{ fontSize:10, color:'#475569' }}>{Math.round(normal.length/cctvList.length*100)}%</div>
                        </div>
                      )}
                      {/* Recent crowd reports */}
                      {reports.filter(r=>r.status==='pending').length > 0 && (
                        <>
                          <div style={{ padding:'6px 16px', background:'rgba(244,63,94,.04)', fontSize:9, fontWeight:800, color:'#f87171', letterSpacing:.8 }}>
                            📣 LAPORAN MASUK — {reports.filter(r=>r.status==='pending').length} MENUNGGU VERIFIKASI
                          </div>
                          {reports.filter(r=>r.status==='pending').slice(0,3).map(r => {
                            const RTYPE = {macet:'🚗 Macet',banjir:'🌊 Banjir',kecelakaan:'🚨 Kecelakaan',tutup:'🚧 Ditutup',galian:'⛏️ Galian',longsor:'⛰️ Longsor'};
                            const ago = (() => { const d=Math.floor((Date.now()-new Date(r.created_at))/60000); return d<60?`${d}m lalu`:`${Math.floor(d/60)}j lalu`; })();
                            return (
                              <div key={r.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 16px', borderBottom:'1px solid rgba(255,255,255,.03)' }}>
                                <div style={{ fontSize:18, flexShrink:0 }}>{RTYPE[r.report_type]?.split(' ')[0]}</div>
                                <div style={{ flex:1, minWidth:0 }}>
                                  <div style={{ fontSize:11, fontWeight:600, color:'#e2e8f0' }}>{RTYPE[r.report_type] || r.report_type}</div>
                                  {r.description && <div style={{ fontSize:9, color:'#64748b', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.description}</div>}
                                </div>
                                <div style={{ fontSize:9, color:'#475569', flexShrink:0 }}>{ago}</div>
                                <button onClick={() => updateReport(r.id,'verified',null)} style={{ background:'rgba(34,197,94,.1)', border:'1px solid rgba(34,197,94,.2)', borderRadius:5, padding:'3px 8px', color:'#22c55e', fontSize:9, cursor:'pointer', fontWeight:700, flexShrink:0 }}>✓</button>
                              </div>
                            );
                          })}
                        </>
                      )}
                    </div>
                  </div>

                  {/* ── KOLOM 2: DAFTAR KAMERA ── */}
                  <div style={{ background:'#0b1324', borderRadius:12, border:'1px solid rgba(255,255,255,.06)', overflow:'hidden', display:'flex', flexDirection:'column', height:'100%' }}>
                    <div style={{ padding:'10px 14px', borderBottom:'1px solid rgba(255,255,255,.06)', background:'rgba(255,255,255,.02)' }}>
                      <div style={{ fontSize:11, fontWeight:800, color:'#e2e8f0' }}>📹 Daftar Kamera</div>
                      <div style={{ fontSize:9, color:'#475569', marginTop:2 }}>{cctvList.length} titik · klik untuk detail</div>
                    </div>
                    <div style={{ overflowY:'auto', flex:1, minHeight:0 }}>
                      {[...cctvList].sort((a,b)=>(b.vehicles||0)-(a.vehicles||0)).map((cam, i) => {
                        const v = cam.vehicles || 0;
                        const col = v > 40 ? '#f43f5e' : v > 20 ? '#f59e0b' : '#10b981';
                        const lbl = v > 40 ? 'PADAT' : v > 20 ? 'RAMAI' : 'LANCAR';
                        const isAct = selectedCam?.id === cam.id;
                        return (
                          <div key={cam.id} onClick={() => setSelectedCam(cam)}
                            style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', cursor:'pointer', borderBottom:'1px solid rgba(255,255,255,.03)', background:isAct?'rgba(245,158,11,.08)':'transparent', borderLeft:isAct?'3px solid #f59e0b':'3px solid transparent', transition:'background .15s' }}>
                            <span style={{ width:6, height:6, borderRadius:'50%', background:col, boxShadow:`0 0 4px ${col}`, flexShrink:0 }} />
                            <div style={{ flex:1, minWidth:0 }}>
                              <div style={{ fontSize:10, fontWeight:isAct?700:500, color:isAct?'#fbbf24':'#e2e8f0', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{cam.name}</div>
                              <div style={{ fontSize:8, color:'#475569' }}>{cam.road_type==='toll'?'Tol':'Kota'}</div>
                            </div>
                            <div style={{ textAlign:'right', flexShrink:0 }}>
                              <div style={{ fontSize:13, fontWeight:800, color:col, fontVariantNumeric:'tabular-nums' }}>{v}</div>
                              <div style={{ fontSize:7, color:col, fontWeight:700 }}>{lbl}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* ── KOLOM 3: DETAIL KAMERA / STATUS ── */}
                  <div style={{ display:'flex', flexDirection:'column', gap:10, height:'100%', overflowY:'auto' }}>
                    {selectedCam ? (
                      <>
                        {/* Header detail kamera */}
                        <div style={A.card}>
                          <div style={A.cardHdr()}>
                            <span style={{ fontSize:12, fontWeight:700, color:'#fbbf24' }}>{selectedCam.name}</span>
                            <button onClick={openEditModal} style={{ marginLeft:'auto', ...A.btn(), fontSize:10, padding:'3px 8px' }}>✏ Edit</button>
                            <button onClick={() => setSelectedCam(null)} style={{ ...A.btn(), fontSize:12, padding:'2px 7px', marginLeft:4, background:'rgba(255,255,255,.05)', color:'#64748b', border:'1px solid rgba(255,255,255,.06)' }}>✕</button>
                          </div>
                          <div style={{ padding:'12px 14px' }}>
                            <LiveDetectPanel key={selectedCam.id} cam={selectedCam} />
                          </div>
                        </div>
                        {/* Grafik historis */}
                        <div style={A.card}>
                          <div style={A.cardHdr('#60a5fa')}>
                            <span style={{ fontSize:12, fontWeight:700, color:'#93c5fd' }}>📊 Tren Aktivitas</span>
                            <div style={{ marginLeft:'auto', display:'flex', gap:4 }}>
                              {['30m','1h','6h','12h','24h'].map(r => (
                                <button key={r} onClick={() => setTimeFilter(r)} style={{ padding:'3px 7px', borderRadius:5, fontSize:9, fontWeight:700, background:timeFilter===r?'#3b82f6':'rgba(255,255,255,.07)', color:timeFilter===r?'#fff':'#64748b', border:'none', cursor:'pointer' }}>{r}</button>
                              ))}
                            </div>
                          </div>
                          <div style={{ padding:'12px 14px' }}>
                            <ResponsiveContainer width="100%" height={160}>
                              <AreaChart data={historyData}>
                                <CartesianGrid stroke="rgba(255,255,255,.05)" vertical={false} />
                                <XAxis dataKey="label" stroke="#475569" fontSize={9} />
                                <YAxis stroke="#475569" fontSize={9} />
                                <Tooltip content={<TrafficTooltip />} />
                                <Area type="natural" dataKey="avg_vehicle" stroke="#3b82f6" strokeWidth={2} fill="rgba(59,130,246,.2)" dot={false} />
                              </AreaChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        {/* GPU Status */}
                        <div style={{ background:'#0f172a', borderRadius:10, border:'1px solid rgba(99,102,241,.15)', padding:14 }}>
                          <div style={{ fontSize:10, fontWeight:800, color:'#818cf8', letterSpacing:.6, marginBottom:10 }}>⚡ GPU INFERENCE SERVICE</div>
                          {gpuStatus ? (
                            <>
                              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                                <div style={{ width:8, height:8, borderRadius:'50%', background:gpuOk?'#22c55e':'#f43f5e', boxShadow:`0 0 6px ${gpuOk?'#22c55e':'#f43f5e'}` }} />
                                <span style={{ fontSize:11, fontWeight:700, color:gpuOk?'#4ade80':'#f87171' }}>{gpuOk?'ONLINE':'OFFLINE'}</span>
                                {gpuStatus.gpu_info?.version === 'v4' && <span style={{ fontSize:9, color:'#818cf8', background:'rgba(99,102,241,.1)', borderRadius:4, padding:'1px 6px' }}>v4 · Batch</span>}
                              </div>
                              {[['GPU',gpuStatus.gpu_info?.gpu||'L40S'],['Model',gpuStatus.gpu_info?.model||'—'],['Scan Terakhir',gpuStatus.scan_stats?.last_scan?.slice(11,19)||'—'],['Kamera Terakhir',`${gpuStatus.scan_stats?.cameras_scanned||0} kamera`]].map(([k,v]) => (
                                <div key={k} style={{ display:'flex', justifyContent:'space-between', fontSize:10, padding:'3px 0', borderBottom:'1px solid rgba(255,255,255,.04)' }}>
                                  <span style={{ color:'#475569' }}>{k}</span>
                                  <span style={{ color:'#94a3b8' }}>{v}</span>
                                </div>
                              ))}
                              <button onClick={() => { setGpuScanLoading(true); fetch('/api/gpu-scan-now',{method:'POST'}).then(()=>setTimeout(()=>{fetchGpuStatus();setGpuScanLoading(false);},20000)).catch(()=>setGpuScanLoading(false)); }}
                                disabled={gpuScanLoading||!gpuOk}
                                style={{ marginTop:10, width:'100%', background:gpuOk&&!gpuScanLoading?'rgba(99,102,241,.15)':'rgba(255,255,255,.03)', border:`1px solid ${gpuOk&&!gpuScanLoading?'rgba(99,102,241,.3)':'rgba(255,255,255,.07)'}`, borderRadius:7, padding:'9px 0', color:gpuOk&&!gpuScanLoading?'#818cf8':'#475569', fontSize:11, cursor:gpuOk&&!gpuScanLoading?'pointer':'not-allowed', fontWeight:700 }}>
                                {gpuScanLoading?'⏳ Scanning...':'⚡ Scan GPU Sekarang'}
                              </button>
                            </>
                          ) : <div style={{ fontSize:11, color:'#475569' }}>Memuat...</div>}
                        </div>
                        {/* Distribusi */}
                        <div style={{ background:'#0f172a', borderRadius:10, border:'1px solid rgba(255,255,255,.06)', padding:14 }}>
                          <div style={{ fontSize:10, fontWeight:800, color:'#94a3b8', letterSpacing:.6, marginBottom:10 }}>📊 DISTRIBUSI STATUS</div>
                          {[{label:'Kritis (>40)',cnt:critical.length,color:'#f43f5e'},{label:'Waspada',cnt:warning.length,color:'#f59e0b'},{label:'Lancar (≤20)',cnt:normal.length,color:'#22c55e'}].map(s => (
                            <div key={s.label} style={{ marginBottom:8 }}>
                              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3, fontSize:10 }}>
                                <span style={{ color:'#64748b' }}>{s.label}</span>
                                <span style={{ color:s.color, fontWeight:700, fontVariantNumeric:'tabular-nums' }}>{s.cnt}</span>
                              </div>
                              <div style={{ height:4, background:'rgba(255,255,255,.05)', borderRadius:99 }}>
                                <div style={{ width:cctvList.length?`${Math.round(s.cnt/cctvList.length*100)}%`:'0%', height:'100%', background:s.color, borderRadius:99, transition:'width .5s' }} />
                              </div>
                            </div>
                          ))}
                          <div style={{ marginTop:10, padding:'8px 10px', background:'rgba(255,255,255,.02)', borderRadius:7, display:'flex', justifyContent:'space-between', fontSize:11 }}>
                            <span style={{ color:'#64748b' }}>Total kendaraan</span>
                            <span style={{ color:'#fbbf24', fontWeight:800, fontVariantNumeric:'tabular-nums' }}>{totalVeh.toLocaleString('id-ID')}</span>
                          </div>
                        </div>
                        {/* Quick actions */}
                        <div style={{ background:'#0f172a', borderRadius:10, border:'1px solid rgba(255,255,255,.06)', padding:14 }}>
                          <div style={{ fontSize:10, fontWeight:800, color:'#94a3b8', letterSpacing:.6, marginBottom:10 }}>⚡ AKSI CEPAT</div>
                          <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
                            <button onClick={() => { setActiveTab('laporan'); }} style={{ background:'rgba(244,63,94,.1)', border:'1px solid rgba(244,63,94,.2)', borderRadius:7, padding:'9px 12px', color:'#f87171', fontSize:11, cursor:'pointer', fontWeight:700, textAlign:'left' }}>
                              📋 Kelola Laporan ({reports.filter(r=>r.status==='pending').length} pending)
                            </button>
                            <button onClick={() => setActiveTab('prediksi')} style={{ background:'rgba(167,139,250,.1)', border:'1px solid rgba(167,139,250,.2)', borderRadius:7, padding:'9px 12px', color:'#a78bfa', fontSize:11, cursor:'pointer', fontWeight:700, textAlign:'left' }}>
                              🔮 Lihat Prediksi 1 Jam ke Depan
                            </button>
                            <button onClick={() => { setActiveTab('laporan'); fetchPeriodicReport('7d'); }} style={{ background:'rgba(245,158,11,.1)', border:'1px solid rgba(245,158,11,.2)', borderRadius:7, padding:'9px 12px', color:'#fbbf24', fontSize:11, cursor:'pointer', fontWeight:700, textAlign:'left' }}>
                              📥 Export Laporan Periodik
                            </button>
                          </div>
                        </div>
                        <div style={{ padding:'10px 0', textAlign:'center', fontSize:10, color:'#334155' }}>← Klik kamera di kolom tengah untuk detail</div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* ════════════ TAB: PREDIKSI & SINYAL (GABUNGAN) ════════════ */}

          {/* ════════════ TAB: LAPORAN PERIODIK ════════════ */}
          {activeTab === 'laporan' && (() => {
            return (
              <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
                {/* Header + controls */}
                <div style={{ background:'#0f172a', borderRadius:10, border:'1px solid rgba(245,158,11,.15)', padding:14 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
                    <div style={{ fontSize:12, fontWeight:800, color:'#fbbf24' }}>📥 Export Laporan Periodik</div>
                    <div style={{ display:'flex', gap:6, marginLeft:'auto' }}>
                      {[['today','Hari Ini'],['7d','7 Hari'],['30d','30 Hari']].map(([v,l]) => (
                        <button key={v} onClick={() => { setPeriodicRange(v); fetchPeriodicReport(v); }}
                          style={{ background: periodicRange===v?'rgba(245,158,11,.2)':'#1e293b', border:`1px solid ${periodicRange===v?'rgba(245,158,11,.4)':'rgba(255,255,255,.08)'}`, borderRadius:7, padding:'7px 14px', color:periodicRange===v?'#fbbf24':'#64748b', fontSize:11, fontWeight:700, cursor:'pointer' }}>
                          {l}
                        </button>
                      ))}
                      <button onClick={() => fetchPeriodicReport(periodicRange)} style={{ background:'rgba(255,255,255,.05)', border:'1px solid rgba(255,255,255,.1)', borderRadius:7, padding:'7px 12px', color:'#94a3b8', fontSize:11, cursor:'pointer', fontWeight:700 }}>
                        {periodicLoading ? '⟳' : '↻ Load'}
                      </button>
                      {periodicData && (
                        <button onClick={() => {
                          const blob = new Blob([JSON.stringify(periodicData, null, 2)], {type:'application/json'});
                          const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
                          a.download = `jaktraffic_report_${periodicRange}_${new Date().toISOString().slice(0,10)}.json`; a.click();
                        }} style={{ background:'rgba(34,197,94,.15)', border:'1px solid rgba(34,197,94,.3)', borderRadius:7, padding:'7px 12px', color:'#4ade80', fontSize:11, cursor:'pointer', fontWeight:700 }}>
                          ⬇ JSON
                        </button>
                      )}
                      {periodicData && (
                        <button onClick={() => window.print()} style={{ background:'rgba(96,165,250,.15)', border:'1px solid rgba(96,165,250,.3)', borderRadius:7, padding:'7px 12px', color:'#60a5fa', fontSize:11, cursor:'pointer', fontWeight:700 }}>
                          🖨 Print / PDF
                        </button>
                      )}
                    </div>
                  </div>
                  {periodicData && <div style={{ fontSize:10, color:'#475569', marginTop:8 }}>Dibuat: {periodicData.generated_at} · Rentang: {periodicRange}</div>}
                </div>

                {periodicLoading && <div style={{ textAlign:'center', padding:'40px 0', color:'#475569' }}>Memuat laporan...</div>}

                {periodicData && !periodicLoading && (() => {
                  const s = periodicData.summary || {};
                  return (
                    <>
                      {/* Summary metrics */}
                      <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:10 }}>
                        {[
                          ['Total Scan',   s.total_records?.toLocaleString('id-ID') || '—', '#60a5fa'],
                          ['Rata-rata Kend.', s.global_avg?.toFixed(1) || '—', '#fbbf24'],
                          ['Puncak',        s.global_max || '—', '#f43f5e'],
                          ['Periode Dari',  s.from_ts?.slice(0,10) || '—', '#94a3b8'],
                          ['Sampai',        s.to_ts?.slice(0,10)   || '—', '#94a3b8'],
                        ].map(([k,v,c]) => (
                          <div key={k} style={{ background:'#0f172a', borderRadius:8, padding:'12px 14px', border:'1px solid rgba(255,255,255,.06)' }}>
                            <div style={{ fontSize:18, fontWeight:900, color:c, fontVariantNumeric:'tabular-nums' }}>{v}</div>
                            <div style={{ fontSize:9, color:'#475569', marginTop:3 }}>{k}</div>
                          </div>
                        ))}
                      </div>

                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
                        {/* Jam tersibuk */}
                        <div style={{ background:'#0f172a', borderRadius:10, border:'1px solid rgba(255,255,255,.06)', overflow:'hidden' }}>
                          <div style={{ padding:'10px 14px', background:'rgba(245,158,11,.05)', borderBottom:'1px solid rgba(245,158,11,.1)', fontSize:10, fontWeight:800, color:'#f59e0b', letterSpacing:.6 }}>🕐 JAM TERSIBUK</div>
                          {periodicData.peak_hours?.map((h,i) => (
                            <div key={h.hour} style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 14px', borderBottom:'1px solid rgba(255,255,255,.04)' }}>
                              <span style={{ fontSize:9, color:'#475569', width:16 }}>{i+1}</span>
                              <span style={{ fontSize:12, fontWeight:700, color:'#fbbf24', minWidth:40 }}>{String(h.hour).padStart(2,'0')}:00</span>
                              <div style={{ flex:1, height:4, background:'rgba(255,255,255,.06)', borderRadius:99 }}>
                                <div style={{ width:`${Math.min(100,(h.avg_v||0)/65*100)}%`, height:'100%', background:'#f59e0b', borderRadius:99 }} />
                              </div>
                              <span style={{ fontSize:11, color:'#fbbf24', fontWeight:700, fontVariantNumeric:'tabular-nums' }}>{(h.avg_v||0).toFixed(0)}</span>
                            </div>
                          ))}
                        </div>

                        {/* Hari tersibuk */}
                        <div style={{ background:'#0f172a', borderRadius:10, border:'1px solid rgba(255,255,255,.06)', overflow:'hidden' }}>
                          <div style={{ padding:'10px 14px', background:'rgba(96,165,250,.05)', borderBottom:'1px solid rgba(96,165,250,.1)', fontSize:10, fontWeight:800, color:'#60a5fa', letterSpacing:.6 }}>📅 HARI TERSIBUK</div>
                          {periodicData.peak_days?.map((d,i) => (
                            <div key={d.dow} style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 14px', borderBottom:'1px solid rgba(255,255,255,.04)' }}>
                              <span style={{ fontSize:9, color:'#475569', width:16 }}>{i+1}</span>
                              <span style={{ fontSize:11, fontWeight:700, color:'#93c5fd', minWidth:70 }}>{(d.day_name||'').trim()}</span>
                              <div style={{ flex:1, height:4, background:'rgba(255,255,255,.06)', borderRadius:99 }}>
                                <div style={{ width:`${Math.min(100,(d.avg_v||0)/65*100)}%`, height:'100%', background:'#60a5fa', borderRadius:99 }} />
                              </div>
                              <span style={{ fontSize:11, color:'#93c5fd', fontWeight:700, fontVariantNumeric:'tabular-nums' }}>{(d.avg_v||0).toFixed(0)}</span>
                            </div>
                          ))}
                        </div>

                        {/* Laporan masyarakat */}
                        <div style={{ background:'#0f172a', borderRadius:10, border:'1px solid rgba(255,255,255,.06)', overflow:'hidden' }}>
                          <div style={{ padding:'10px 14px', background:'rgba(244,63,94,.04)', borderBottom:'1px solid rgba(244,63,94,.1)', fontSize:10, fontWeight:800, color:'#f87171', letterSpacing:.6 }}>📣 LAPORAN MASYARAKAT</div>
                          {periodicData.crowd_summary?.length === 0 ? (
                            <div style={{ padding:'16px 14px', color:'#475569', fontSize:11 }}>Tidak ada laporan dalam periode ini</div>
                          ) : periodicData.crowd_summary?.map((r,i) => (
                            <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'7px 14px', borderBottom:'1px solid rgba(255,255,255,.04)', fontSize:11 }}>
                              <span style={{ color:'#94a3b8' }}>{r.report_type} · {r.status}</span>
                              <span style={{ color:'#fbbf24', fontWeight:700 }}>{r.cnt}x</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Top 10 Corridors */}
                      <div style={{ background:'#0f172a', borderRadius:10, border:'1px solid rgba(244,63,94,.1)', overflow:'hidden' }}>
                        <div style={{ padding:'10px 14px', background:'rgba(244,63,94,.05)', borderBottom:'1px solid rgba(244,63,94,.1)', fontSize:10, fontWeight:800, color:'#f43f5e', letterSpacing:.6 }}>
                          🔴 TOP 10 KORIDOR TERPADAT (rata-rata {periodicRange})
                        </div>
                        <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)' }}>
                          {periodicData.top_corridors?.map((c,i) => (
                            <div key={c.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 14px', borderBottom:'1px solid rgba(255,255,255,.03)', borderRight:i%2===0?'1px solid rgba(255,255,255,.04)':'none' }}>
                              <span style={{ fontSize:10, fontWeight:900, color:'#475569', width:20 }}>{i+1}</span>
                              <div style={{ flex:1, minWidth:0 }}>
                                <div style={{ fontSize:11, fontWeight:600, color:'#e2e8f0', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.name}</div>
                                <div style={{ fontSize:9, color:'#64748b' }}>{(c.samples||0).toLocaleString('id-ID')} sampel</div>
                              </div>
                              <div style={{ textAlign:'right', flexShrink:0 }}>
                                <div style={{ fontSize:14, fontWeight:900, color: c.avg_v>40?'#f43f5e':c.avg_v>20?'#f59e0b':'#22c55e', fontVariantNumeric:'tabular-nums' }}>{(c.avg_v||0).toFixed(0)}</div>
                                <div style={{ fontSize:8, color:'#475569' }}>avg · peak {c.peak_v}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Daily trend sparkline */}
                      {periodicData.daily_trend?.length > 0 && (
                        <div style={{ background:'#0f172a', borderRadius:10, border:'1px solid rgba(255,255,255,.06)', padding:14 }}>
                          <div style={{ fontSize:10, fontWeight:800, color:'#94a3b8', letterSpacing:.6, marginBottom:12 }}>📈 TREN HARIAN</div>
                          <ResponsiveContainer width="100%" height={140}>
                            <AreaChart data={periodicData.daily_trend}>
                              <CartesianGrid stroke="rgba(255,255,255,.04)" vertical={false} />
                              <XAxis dataKey="day" stroke="#334155" fontSize={9} tickFormatter={v=>v.slice(5)} />
                              <YAxis stroke="#334155" fontSize={9} />
                              <Tooltip content={({active,payload,label}) => active&&payload?.length?(
                                <div style={{background:'#0f172a',border:'1px solid rgba(245,158,11,.2)',borderRadius:8,padding:'8px 12px',fontSize:11}}>
                                  <div style={{color:'#fbbf24',fontWeight:700}}>{label}</div>
                                  <div style={{color:'#94a3b8'}}>Rata-rata: <b style={{color:'#fbbf24'}}>{payload[0]?.value?.toFixed(1)}</b></div>
                                  <div style={{color:'#94a3b8'}}>Puncak: <b style={{color:'#f43f5e'}}>{payload[1]?.value}</b></div>
                                </div>
                              ):null} />
                              <Area type="monotone" dataKey="avg_v" stroke="#f59e0b" strokeWidth={2} fill="rgba(245,158,11,.1)" dot={false} />
                              <Area type="monotone" dataKey="peak_v" stroke="#f43f5e" strokeWidth={1.5} fill="transparent" dot={false} strokeDasharray="4 3" />
                            </AreaChart>
                          </ResponsiveContainer>
                          <div style={{ display:'flex', gap:16, fontSize:9, color:'#475569', marginTop:4 }}>
                            <span style={{ display:'flex', alignItems:'center', gap:4 }}><span style={{ width:12, height:2, background:'#f59e0b', display:'inline-block' }} />Rata-rata</span>
                            <span style={{ display:'flex', alignItems:'center', gap:4 }}><span style={{ width:12, height:2, background:'#f43f5e', display:'inline-block', borderTop:'1px dashed #f43f5e' }} />Puncak</span>
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}

                {!periodicData && !periodicLoading && (
                  <div style={{ textAlign:'center', padding:'40px 0', color:'#475569', fontSize:12 }}>
                    Pilih rentang waktu dan klik "Load" untuk generate laporan
                  </div>
                )}
              </div>
            );
          })()}

          {/* ════════════ TAB: ANALITIK ════════════ */}
          {activeTab === 'analitik' && (
            <>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16 }}>
                {/* Top padded */}
                <div style={A.card}>
                  <div style={A.cardHdr('#f43f5e')}>
                    <span style={{ fontSize:12, fontWeight:700, color:'#fca5a5' }}>🔴 Lokasi Terpadat</span>
                  </div>
                  <div style={{ maxHeight:300, overflowY:'auto' }}>
                    {[...cctvList].sort((a,b)=>(b.vehicles||0)-(a.vehicles||0)).slice(0,10).map((cam,i) => {
                      const v = cam.vehicles||0;
                      const color = v>40?'#f43f5e':v>20?'#f59e0b':'#10b981';
                      return (
                        <div key={cam.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 14px', borderBottom:'1px solid rgba(255,255,255,.04)' }}>
                          <span style={{ fontSize:10, fontWeight:900, color:'#475569', width:16, textAlign:'center', flexShrink:0 }}>{i+1}</span>
                          <div style={{ flex:1, fontSize:11, fontWeight:600 }}>{cam.name}</div>
                          <div style={{ width:80, height:5, background:'rgba(255,255,255,.06)', borderRadius:99 }}>
                            <div style={{ height:'100%', width:`${Math.min(100,v/65*100)}%`, background:color, borderRadius:99 }} />
                          </div>
                          <span style={{ fontSize:13, fontWeight:900, color, fontVariantNumeric:'tabular-nums', flexShrink:0, width:28, textAlign:'right' }}>{v}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Distribution */}
                <div style={A.card}>
                  <div style={A.cardHdr('#10b981')}>
                    <span style={{ fontSize:12, fontWeight:700, color:'#6ee7b7' }}>📈 Distribusi Status</span>
                  </div>
                  <div style={{ padding:'16px' }}>
                    {[
                      { label:'LANCAR', count:cctvList.filter(c=>(c.vehicles||0)<=20).length, color:'#10b981', bg:'rgba(16,185,129,.1)', pct: cctvList.length?Math.round(cctvList.filter(c=>(c.vehicles||0)<=20).length/cctvList.length*100):0 },
                      { label:'RAMAI',  count:cctvList.filter(c=>(c.vehicles||0)>20&&(c.vehicles||0)<=40).length, color:'#f59e0b', bg:'rgba(245,158,11,.1)', pct: cctvList.length?Math.round(cctvList.filter(c=>(c.vehicles||0)>20&&(c.vehicles||0)<=40).length/cctvList.length*100):0 },
                      { label:'PADAT',  count:cctvList.filter(c=>(c.vehicles||0)>40).length, color:'#f43f5e', bg:'rgba(244,63,94,.1)', pct: cctvList.length?Math.round(cctvList.filter(c=>(c.vehicles||0)>40).length/cctvList.length*100):0 },
                    ].map(s => (
                      <div key={s.label} style={{ marginBottom:14 }}>
                        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:5 }}>
                          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                            <span style={{ width:8, height:8, borderRadius:'50%', background:s.color, boxShadow:`0 0 5px ${s.color}` }} />
                            <span style={{ fontSize:11, fontWeight:700 }}>{s.label}</span>
                          </div>
                          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                            <span style={{ fontSize:18, fontWeight:900, color:s.color, fontVariantNumeric:'tabular-nums' }}>{s.count}</span>
                            <span style={{ fontSize:10, color:'#475569' }}>{s.pct}%</span>
                          </div>
                        </div>
                        <div style={{ height:6, background:'rgba(255,255,255,.07)', borderRadius:99, overflow:'hidden' }}>
                          <div style={{ width:`${s.pct}%`, height:'100%', background:s.color, borderRadius:99, transition:'width .6s ease' }} />
                        </div>
                      </div>
                    ))}

                    <div style={{ marginTop:20, paddingTop:14, borderTop:'1px solid rgba(255,255,255,.06)' }}>
                      <div style={{ fontSize:9, color:'#475569', marginBottom:8, fontWeight:700, letterSpacing:.8 }}>BREAKDOWN PER TIPE JALAN</div>
                      {['toll','city'].map(type => {
                        const cams = cctvList.filter(c=>c.road_type===type);
                        const avg  = cams.length ? Math.round(cams.reduce((s,c)=>s+(c.vehicles||0),0)/cams.length) : 0;
                        return (
                          <div key={type} style={{ display:'flex', justifyContent:'space-between', fontSize:11, padding:'4px 0', borderBottom:'1px solid rgba(255,255,255,.04)' }}>
                            <span style={{ color:'#94a3b8' }}>{type==='toll'?'🛣️ Jalan Tol':'🏙️ Jalan Kota'}</span>
                            <span style={{ color:'#64748b' }}>{cams.length} kamera · <b style={{ color:'#e2e8f0' }}>{avg} kend. rata-rata</b></span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              {/* Full-width chart of selected camera */}
              <div style={A.card}>
                <div style={A.cardHdr('#60a5fa')}>
                  <span style={{ fontSize:12, fontWeight:700, color:'#93c5fd' }}>📊 Histori: {selectedCam?.name || 'Pilih kamera di tab Monitoring'}</span>
                  <div style={{ marginLeft:'auto', display:'flex', gap:4 }}>
                    {['30m','1h','6h','12h','24h'].map(r => (
                      <button key={r} onClick={() => setTimeFilter(r)} style={{ padding:'3px 7px', borderRadius:5, fontSize:9, fontWeight:700, background:timeFilter===r?'#3b82f6':'rgba(255,255,255,.07)', color:timeFilter===r?'#fff':'#64748b', border:'none', cursor:'pointer' }}>{r}</button>
                    ))}
                  </div>
                </div>
                <div style={{ padding:'16px' }}>
                  <ResponsiveContainer width="100%" height={240}>
                    <AreaChart data={historyData}>
                      <CartesianGrid stroke="rgba(255,255,255,.05)" vertical={false} />
                      <XAxis dataKey="label" stroke="#475569" fontSize={10} />
                      <YAxis stroke="#475569" fontSize={10} />
                      <Tooltip content={<TrafficTooltip />} />
                      <Area type="natural" dataKey="avg_vehicle" stroke="#3b82f6" strokeWidth={3} fill="rgba(59,130,246,.18)" dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                  {historyData.length === 0 && (
                    <div style={{ textAlign:'center', color:'#475569', fontSize:12, padding:'20px 0' }}>Pilih kamera di tab Monitoring untuk melihat histori data</div>
                  )}
                </div>
              </div>
            </>
          )}

          {activeTab === 'prediksi' && (() => {
            const predMap = {};
            (predOverview?.predictions || []).forEach(p => { predMap[p.id] = p; });
            const nextHourLabel = predOverview?.hour != null ? `${String(predOverview.hour).padStart(2,'0')}:00` : '…';

            // Gabungkan semua kamera: prediksi + sinyal dalam satu dataset
            const allCams = [...cctvList]
              .map(c => {
                const pr   = predMap[c.id];
                const cur  = c.vehicles || 0;
                const pred = pr?.pred || 0;
                const useV = Math.max(cur, pred);
                const trend = pr ? (pred > cur + 5 ? 'up' : pred < cur - 5 ? 'down' : 'flat') : null;
                const rec  = c.has_signal ? getSignalRec(useV) : null;
                return { ...c, cur, pred, useV, trend, rec, hasPred: !!pr };
              })
              .sort((a, b) => b.useV - a.useV);

            const nPadat    = allCams.filter(c => c.useV > 40).length;
            const nRamai    = allCams.filter(c => c.useV > 20 && c.useV <= 40).length;
            const nLancar   = allCams.filter(c => c.useV <= 20).length;
            const earlyWarn = allCams.filter(c => c.has_signal && c.pred > 40 && c.cur <= 40).length;
            const nSinyal   = allCams.filter(c => c.has_signal).length;

            return (
              <div style={{ display:'flex', gap:14 }}>

                {/* ── Kolom utama ── */}
                <div style={{ flex:1, display:'flex', flexDirection:'column', gap:10, minWidth:0 }}>

                  {/* Stat cards */}
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:8 }}>
                    {[
                      { icon:'🔴', label:'Prediksi Padat', val:nPadat,  c:'#f43f5e', bg:'rgba(244,63,94,.08)',   bd:'rgba(244,63,94,.2)'   },
                      { icon:'🟡', label:'Prediksi Ramai', val:nRamai,  c:'#f59e0b', bg:'rgba(245,158,11,.08)',  bd:'rgba(245,158,11,.2)'  },
                      { icon:'🟢', label:'Prediksi Lancar',val:nLancar, c:'#22c55e', bg:'rgba(34,197,94,.08)',   bd:'rgba(34,197,94,.2)'   },
                      { icon:'🚦', label:'Persimpangan',   val:nSinyal, c:'#60a5fa', bg:'rgba(96,165,250,.08)',  bd:'rgba(96,165,250,.2)'  },
                      { icon:'⚠️', label:'Akan Padat',     val:earlyWarn,c:earlyWarn?'#fb923c':'#475569', bg:earlyWarn?'rgba(249,115,22,.1)':'rgba(255,255,255,.02)', bd:earlyWarn?'rgba(249,115,22,.3)':'rgba(255,255,255,.07)' },
                    ].map(s => (
                      <div key={s.label} style={{ background:s.bg, border:`1px solid ${s.bd}`, borderRadius:10, padding:'12px 14px', position:'relative', overflow:'hidden' }}>
                        <div style={{ position:'absolute', right:10, top:8, fontSize:18, opacity:.2 }}>{s.icon}</div>
                        <div style={{ fontSize:28, fontWeight:900, color:s.c, fontVariantNumeric:'tabular-nums', lineHeight:1 }}>{s.val}</div>
                        <div style={{ fontSize:9, color:'#64748b', marginTop:5, fontWeight:600, letterSpacing:.5 }}>{s.label.toUpperCase()}</div>
                        {s.label==='Prediksi Padat' && <div style={{ fontSize:8, color:'#64748b', marginTop:2 }}>jam {nextHourLabel}</div>}
                      </div>
                    ))}
                  </div>

                  {/* Subheader info */}
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <div style={{ fontSize:10, color:'#475569' }}>
                      🔮 Prediksi jam <b style={{ color:'#a78bfa' }}>{nextHourLabel}</b> · Metode: 55% historis 14 hari + 45% kondisi saat ini · {allCams.filter(c=>c.hasPred).length} dari {allCams.length} kamera memiliki data
                    </div>
                    <button onClick={() => { fetchPredOverview(); fetchCCTV(); }}
                      style={{ marginLeft:'auto', flexShrink:0, background:'rgba(167,139,250,.1)', border:'1px solid rgba(167,139,250,.2)', borderRadius:7, padding:'6px 12px', color:'#a78bfa', fontSize:10, cursor:'pointer', fontWeight:700 }}>
                      ↻ Refresh
                    </button>
                  </div>

                  {/* Tabel gabungan */}
                  <div style={A.card}>
                    {/* Header tabel */}
                    <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr 0.5fr 1.4fr', padding:'7px 14px', borderBottom:'1px solid rgba(255,255,255,.08)', background:'rgba(255,255,255,.02)' }}>
                      {[['Lokasi','left'],['Saat Ini','center'],[`Prediksi ${nextHourLabel}`,'center'],['Trend','center'],['Sinyal Rekomendasi','center']].map(([h,ta]) => (
                        <div key={h} style={{ fontSize:8, fontWeight:700, color:'#475569', letterSpacing:.7, textAlign:ta }}>{h.toUpperCase()}</div>
                      ))}
                    </div>

                    <div style={{ maxHeight:'calc(100vh - 280px)', overflowY:'auto' }}>
                      {allCams.map((cam, i) => {
                        const curCol  = cam.cur>40?'#f43f5e':cam.cur>20?'#f59e0b':'#10b981';
                        const predCol = cam.pred>40?'#f43f5e':cam.pred>20?'#f59e0b':'#10b981';
                        const trendIcon  = cam.trend==='up'?'↑':cam.trend==='down'?'↓':'→';
                        const trendColor = cam.trend==='up'?'#f43f5e':cam.trend==='down'?'#22c55e':'#64748b';
                        const isWarn     = cam.has_signal && cam.pred > 40 && cam.cur <= 40;
                        const isSelected = predCamId === cam.id;
                        return (
                          <div key={cam.id}
                            onClick={() => { setPredCamId(cam.id); fetchPredDetail(cam.id); }}
                            style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr 0.5fr 1.4fr', alignItems:'center', padding:'7px 14px', borderBottom:'1px solid rgba(255,255,255,.04)', cursor:'pointer', borderLeft: isWarn?'3px solid #fb923c': isSelected?'3px solid #a78bfa':'3px solid transparent', background: isSelected?'rgba(167,139,250,.05)': isWarn?'rgba(249,115,22,.04)': i%2===0?'rgba(255,255,255,.015)':'transparent' }}>

                            {/* Lokasi */}
                            <div style={{ display:'flex', alignItems:'center', gap:7, minWidth:0 }}>
                              <span style={{ width:7, height:7, borderRadius:'50%', background:curCol, flexShrink:0, boxShadow:`0 0 4px ${curCol}` }} />
                              <div style={{ minWidth:0 }}>
                                <div style={{ fontSize:11, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{cam.name}</div>
                                <div style={{ fontSize:8, color:'#475569', display:'flex', gap:4 }}>
                                  {cam.has_signal && <span style={{ color:'#10b981' }}>🚦</span>}
                                  {isWarn && <span style={{ color:'#fb923c', fontWeight:700 }}>⚠ akan padat</span>}
                                </div>
                              </div>
                            </div>

                            {/* Saat ini */}
                            <div style={{ textAlign:'center' }}>
                              <div style={{ fontSize:14, fontWeight:900, color:curCol, fontVariantNumeric:'tabular-nums' }}>{cam.cur}</div>
                              <div style={{ fontSize:7, color:curCol, fontWeight:700 }}>{cam.cur>40?'PADAT':cam.cur>20?'RAMAI':'LANCAR'}</div>
                            </div>

                            {/* Prediksi */}
                            <div style={{ textAlign:'center' }}>
                              {cam.hasPred ? <>
                                <div style={{ fontSize:14, fontWeight:900, color:predCol, fontVariantNumeric:'tabular-nums' }}>{cam.pred}</div>
                                <div style={{ fontSize:7, color:predCol, fontWeight:700 }}>{cam.pred>40?'PADAT':cam.pred>20?'RAMAI':'LANCAR'}</div>
                              </> : <span style={{ fontSize:9, color:'#334155' }}>—</span>}
                            </div>

                            {/* Trend */}
                            <div style={{ textAlign:'center', fontSize:15, fontWeight:900, color:trendColor }}>{cam.hasPred ? trendIcon : '—'}</div>

                            {/* Sinyal rekomendasi */}
                            <div style={{ textAlign:'center' }}>
                              {cam.rec ? (
                                <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
                                  <span style={{ fontSize:10, fontWeight:700, color:cam.rec.dot }}>{cam.rec.label}</span>
                                  <span style={{ fontSize:9, color:'#22c55e', fontWeight:700 }}>{cam.rec.green}s</span>
                                  <span style={{ fontSize:9, color:'#ef4444', fontWeight:700 }}>{cam.rec.red}s</span>
                                </div>
                              ) : <span style={{ fontSize:9, color:'#334155' }}>—</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* ── Panel detail 6 jam (kanan) ── */}
                <div style={{ width:240, flexShrink:0 }}>
                  {predDetail ? (
                    <div style={{ background:'#0f172a', borderRadius:10, border:'1px solid rgba(167,139,250,.15)', overflow:'hidden' }}>
                      <div style={{ padding:'10px 12px', background:'rgba(167,139,250,.06)', borderBottom:'1px solid rgba(167,139,250,.1)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                        <div>
                          <div style={{ fontSize:10, fontWeight:800, color:'#c4b5fd' }}>🔮 {predDetail.name}</div>
                          <div style={{ fontSize:9, color:'#64748b', marginTop:1 }}>Sekarang: {predDetail.current} kend</div>
                        </div>
                        <button onClick={() => setPredCamId(null)} style={{ background:'none', border:'none', color:'#475569', fontSize:14, cursor:'pointer' }}>✕</button>
                      </div>
                      <div style={{ padding:10, display:'flex', flexDirection:'column', gap:5 }}>
                        {(predDetail.predictions || []).map(p => (
                          <div key={p.hour} style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 8px', background:'rgba(255,255,255,.02)', borderRadius:6, border:`1px solid ${p.color}18` }}>
                            <div style={{ fontSize:11, fontWeight:800, color:'#64748b', width:40, flexShrink:0 }}>{p.label}</div>
                            <div style={{ flex:1, height:4, background:'rgba(255,255,255,.06)', borderRadius:99 }}>
                              <div style={{ width:`${Math.min(100,p.vehicles/65*100)}%`, height:'100%', background:p.color, borderRadius:99 }} />
                            </div>
                            <div style={{ fontSize:12, fontWeight:900, color:p.color, fontVariantNumeric:'tabular-nums', flexShrink:0, width:28, textAlign:'right' }}>{p.vehicles}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div style={{ background:'#0f172a', borderRadius:10, border:'1px solid rgba(255,255,255,.06)', padding:20, textAlign:'center', color:'#475569', fontSize:11 }}>
                      ← Klik baris untuk prediksi 6 jam
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* ════════════ TAB: AI DETEKSI ════════════ */}
          {activeTab === 'ai' && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>

              {/* YOLO Upload */}
              <div style={A.card}>
                <div style={A.cardHdr('#f59e0b')}>
                  <Cpu size={14} style={{ color:'#fbbf24' }} />
                  <span style={{ fontSize:12, fontWeight:700, color:'#fbbf24' }}>YOLO 11 — Deteksi dari File</span>
                </div>
                <div style={{ padding:'16px' }}>
                  <label style={{ display:'block', border:`2px dashed ${detectFile?'#f59e0b':'rgba(255,255,255,.12)'}`, borderRadius:10, padding:'24px 16px', textAlign:'center', cursor:'pointer', background:detectFile?'rgba(245,158,11,.06)':'rgba(255,255,255,.02)', transition:'all .2s', marginBottom:12 }}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => { e.preventDefault(); const f=e.dataTransfer.files[0]; if(f){setDetectFile(f);setDetectResult(null);setDetectError('');} }}>
                    <input type="file" className="hidden" accept="image/*,video/mp4,video/avi,video/mov,video/mkv" onChange={e => { const f=e.target.files[0]; if(f){setDetectFile(f);setDetectResult(null);setDetectError('');} }} style={{ display:'none' }} />
                    {detectFile ? (
                      <>
                        <div style={{ fontSize:28, marginBottom:6 }}>📁</div>
                        <div style={{ fontSize:12, fontWeight:700, color:'#fbbf24' }}>{detectFile.name}</div>
                        <div style={{ fontSize:10, color:'#64748b', marginTop:2 }}>{(detectFile.size/1024/1024).toFixed(2)} MB</div>
                      </>
                    ) : (
                      <>
                        <div style={{ fontSize:28, marginBottom:6, opacity:.4 }}>📸</div>
                        <div style={{ fontSize:12, color:'#64748b', fontWeight:600 }}>Drop gambar atau video di sini</div>
                        <div style={{ fontSize:10, color:'#475569', marginTop:3 }}>JPG · PNG · MP4 · AVI · MOV</div>
                      </>
                    )}
                  </label>

                  <button onClick={handleDetect} disabled={!detectFile||detecting} style={{ width:'100%', padding:'10px 0', borderRadius:9, fontSize:12, fontWeight:700, background:!detectFile||detecting?'rgba(255,255,255,.06)':'rgba(245,158,11,.2)', border:`1px solid ${!detectFile||detecting?'rgba(255,255,255,.08)':'rgba(245,158,11,.4)'}`, color:!detectFile||detecting?'#475569':'#fbbf24', cursor:!detectFile||detecting?'not-allowed':'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
                    {detecting ? (<><span style={{ display:'flex', gap:3 }}>{[0,1,2].map(i=><span key={i} style={{ width:5, height:5, borderRadius:'50%', background:'#f59e0b', animation:`bounce-dot 1s ${i*.15}s infinite` }} />)}</span>Mendeteksi...</>) : '⚡ Jalankan Deteksi'}
                  </button>

                  {detectError && <div style={{ marginTop:10, background:'rgba(239,68,68,.1)', border:'1px solid rgba(239,68,68,.3)', borderRadius:8, padding:'8px 12px', fontSize:11, color:'#fca5a5' }}>❌ {detectError}</div>}

                  {detectResult && (
                    <div style={{ marginTop:12 }}>
                      <YoloResultCard result={detectResult} showTime />
                    </div>
                  )}
                </div>
              </div>

              {/* Simulasi + Model Info */}
              <div style={{ display:'flex', flexDirection:'column', gap:12 }}>

                {/* Simulasi */}
                <div style={A.card}>
                  <div style={A.cardHdr('#60a5fa')}>
                    <span style={{ fontSize:12, fontWeight:700, color:'#93c5fd' }}>🎲 Simulasi Data Kendaraan</span>
                  </div>
                  <div style={{ padding:'14px 16px' }}>
                    <div style={{ fontSize:11, color:'#64748b', marginBottom:12, lineHeight:1.6 }}>
                      Generate data kendaraan simulasi untuk kamera yang dipilih dan update peta secara langsung.
                      Kamera aktif: <b style={{ color:'#fbbf24' }}>{selectedCam?.name || 'Belum dipilih'}</b>
                    </div>
                    <button onClick={runSimulasi} disabled={simRunning||!selectedCam} style={{ width:'100%', padding:'9px 0', borderRadius:9, fontSize:12, fontWeight:700, background:simRunning||!selectedCam?'rgba(255,255,255,.06)':'rgba(96,165,250,.15)', border:`1px solid ${simRunning||!selectedCam?'rgba(255,255,255,.08)':'rgba(96,165,250,.3)'}`, color:simRunning||!selectedCam?'#475569':'#93c5fd', cursor:simRunning||!selectedCam?'not-allowed':'pointer' }}>
                      {simRunning ? 'Mensimulasikan...' : '🎲 Jalankan Simulasi'}
                    </button>
                    {simResult && (
                      <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:6, marginTop:10 }}>
                        {[{l:'Total',v:simResult.total,c:'#fbbf24'},{l:'Mobil',v:simResult.car,c:'#60a5fa'},{l:'Motor',v:simResult.motorcycle,c:'#10b981'},{l:'Bus',v:simResult.bus,c:'#a78bfa'},{l:'Truk',v:simResult.truck,c:'#f43f5e'}].map(s=>(
                          <div key={s.l} style={{ background:'rgba(255,255,255,.05)', borderRadius:7, padding:'8px 4px', textAlign:'center' }}>
                            <div style={{ fontSize:8, color:'#475569', fontWeight:700, letterSpacing:.5 }}>{s.l.toUpperCase()}</div>
                            <div style={{ fontSize:18, fontWeight:900, color:s.c, fontVariantNumeric:'tabular-nums' }}>{s.v}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Transformer model info */}
                <div style={A.card}>
                  <div style={A.cardHdr('#a78bfa')}>
                    <Brain size={14} style={{ color:'#c4b5fd' }} />
                    <span style={{ fontSize:12, fontWeight:700, color:'#c4b5fd' }}>Transformer Model</span>
                    <span style={{ marginLeft:'auto' }}>
                      {modelInfo?.model_loaded
                        ? <span style={{ display:'flex', alignItems:'center', gap:4, fontSize:9, color:'#10b981', fontWeight:700 }}><CheckCircle size={10} /> LOADED</span>
                        : <span style={{ display:'flex', alignItems:'center', gap:4, fontSize:9, color:'#f43f5e', fontWeight:700 }}><XCircle size={10} /> BELUM SIAP</span>}
                    </span>
                  </div>
                  {modelInfo ? (
                    <div style={{ padding:'12px 14px' }}>
                      {modelInfo.architecture && (
                        <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:6, marginBottom:10 }}>
                          {Object.entries(modelInfo.architecture).map(([k,v]) => (
                            <div key={k} style={{ background:'rgba(255,255,255,.04)', borderRadius:7, padding:'6px 8px' }}>
                              <div style={{ fontSize:8, color:'#475569', fontWeight:700 }}>{k.replace(/_/g,' ').toUpperCase()}</div>
                              <div style={{ fontSize:12, fontWeight:700, color:'#e2e8f0' }}>{v}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      {modelInfo.test_predictions?.length > 0 && (
                        <div>
                          <div style={{ fontSize:8, color:'#475569', fontWeight:700, letterSpacing:.7, marginBottom:5 }}>LIVE PREDICTION TEST</div>
                          <div style={{ maxHeight:120, overflowY:'auto' }}>
                            {modelInfo.test_predictions.map((t,i) => (
                              <div key={i} style={{ display:'flex', justifyContent:'space-between', fontSize:10, padding:'3px 0', borderBottom:'1px solid rgba(255,255,255,.04)' }}>
                                <span style={{ fontWeight:600 }}>{t.name}</span>
                                <div style={{ display:'flex', gap:10 }}>
                                  <span style={{ color:'#94a3b8' }}>Now: <b style={{ color:'#fff' }}>{t.current}</b></span>
                                  <span style={{ color:'#60a5fa' }}>15m: <b>{t.pred_15}</b></span>
                                  <span style={{ color:'#a78bfa' }}>30m: <b>{t.pred_30}</b></span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ padding:'16px', textAlign:'center', color:'#475569', fontSize:11 }}>Memuat info model...</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ════════════ TAB: GPU SCANNER ════════════ */}
          {activeTab === 'gpu' && (() => {
            const st      = gpuStatus;
            const healthy = st?.healthy;
            const hbAge   = st?.heartbeat_age_s;
            const stats   = st?.scan_stats || {};
            const info    = st?.gpu_info   || {};
            const isV4    = info.batch_capable || info.version === 'v4';
            const vramPct = info.vram_used_gb && info.vram_gb
              ? Math.round((info.vram_used_gb / info.vram_gb) * 100) : null;

            return (
              <div style={{ display:'flex', flexDirection:'column', gap:12 }}>

                {/* ── Status + GPU Info ── */}
                <div style={A.card}>
                  <div style={A.cardHdr('#6366f1')}>
                    <span>⚡ GPU Inference Service {isV4 && <span style={{ fontSize:10, background:'rgba(99,102,241,.3)', borderRadius:4, padding:'1px 6px', marginLeft:6 }}>v4 · ByteTrack · Batch</span>}</span>
                    <button onClick={() => { fetchGpuStatus(); fetchTrackerInfo(); }}
                      style={{ background:'rgba(255,255,255,.15)', border:'none', color:'#fff', padding:'4px 12px', borderRadius:6, cursor:'pointer', fontSize:12 }}>
                      Refresh
                    </button>
                  </div>
                  <div style={{ padding:16, display:'flex', flexDirection:'column', gap:12 }}>
                    {!st ? (
                      <div style={{ color:'#94a3b8', textAlign:'center', padding:'20px 0' }}>Memuat status GPU...</div>
                    ) : (
                      <>
                        <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
                          <span style={{ background: healthy?'#065f46':'#7f1d1d', color: healthy?'#6ee7b7':'#fca5a5', padding:'6px 16px', borderRadius:20, fontSize:13, fontWeight:700 }}>
                            {healthy ? '● ONLINE' : '● OFFLINE'}
                          </span>
                          {isV4 && <span style={{ fontSize:11, color:'#818cf8', background:'rgba(99,102,241,.1)', borderRadius:8, padding:'4px 10px', fontWeight:700 }}>⚡ Batch Mode Aktif</span>}
                          {stats.batch_mode && <span style={{ fontSize:11, color:'#4ade80', background:'rgba(74,222,128,.1)', borderRadius:8, padding:'4px 10px', fontWeight:700 }}>✓ Batch Verified</span>}
                          {hbAge !== null && <span style={{ color:'#94a3b8', fontSize:12 }}>Heartbeat {hbAge < 60 ? `${hbAge}s` : `${Math.round(hbAge/60)}m`} lalu</span>}
                        </div>

                        {/* GPU Specs */}
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                          {[
                            ['GPU',    info.gpu   || 'NVIDIA L40S'],
                            ['Model',  info.model  || 'yolo11l.pt'],
                            ['VRAM Total', info.vram_gb ? `${info.vram_gb} GB` : '48.3 GB'],
                            ['VRAM Used',  info.vram_used_gb ? `${info.vram_used_gb} GB` : '—'],
                          ].map(([k,v]) => (
                            <div key={k} style={{ background:'#1e293b', borderRadius:8, padding:'8px 12px' }}>
                              <div style={{ color:'#64748b', fontSize:10, marginBottom:2 }}>{k}</div>
                              <div style={{ color:'#e2e8f0', fontSize:12 }}>{v}</div>
                            </div>
                          ))}
                        </div>

                        {/* VRAM utilization bar */}
                        {vramPct !== null && (
                          <div>
                            <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'#64748b', marginBottom:4 }}>
                              <span>VRAM Utilization</span>
                              <span style={{ color: vramPct>80?'#f43f5e':vramPct>50?'#f59e0b':'#22c55e', fontWeight:700 }}>{vramPct}%</span>
                            </div>
                            <div style={{ height:6, background:'#1e293b', borderRadius:3 }}>
                              <div style={{ width:`${vramPct}%`, height:'100%', borderRadius:3, background: vramPct>80?'#f43f5e':vramPct>50?'#f59e0b':'#22c55e', transition:'width .5s' }} />
                            </div>
                          </div>
                        )}

                        {/* Tunnel URL */}
                        {st.url && (
                          <div style={{ background:'#0f172a', borderRadius:8, padding:'8px 12px', fontSize:10, color:'#475569', wordBreak:'break-all' }}>
                            🔗 {st.url}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* ── Scan Stats ── */}
                <div style={A.card}>
                  <div style={A.cardHdr('#0891b2')}>
                    <span>📊 Statistik Scan Batch</span>
                    {isV4 && <span style={{ fontSize:10, color:'#67e8f9' }}>1 forward pass untuk semua kamera</span>}
                  </div>
                  <div style={{ padding:16, display:'flex', flexDirection:'column', gap:12 }}>
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8 }}>
                      {[
                        ['Kamera', stats.cameras_scanned ?? '—', '#38bdf8'],
                        ['Avg Kend.', stats.avg_count ? Number(stats.avg_count).toFixed(1) : '—', '#4ade80'],
                        ['Batch', stats.batch_mode ? '✓ ON' : '✗ OFF', stats.batch_mode ? '#a78bfa' : '#64748b'],
                        ['Error', stats.errors ?? '—', (stats.errors||0)>0 ? '#f87171' : '#64748b'],
                      ].map(([k,v,c]) => (
                        <div key={k} style={{ background:'#1e293b', borderRadius:8, padding:'12px 8px', textAlign:'center' }}>
                          <div style={{ color:c, fontSize:20, fontWeight:800, fontVariantNumeric:'tabular-nums', lineHeight:1 }}>{v}</div>
                          <div style={{ color:'#64748b', fontSize:10, marginTop:3 }}>{k}</div>
                        </div>
                      ))}
                    </div>
                    {stats.last_scan && <div style={{ color:'#64748b', fontSize:11, textAlign:'center' }}>Scan terakhir: {stats.last_scan}</div>}
                    <button
                      disabled={gpuScanLoading || !healthy}
                      onClick={() => {
                        setGpuScanLoading(true);
                        fetch('/api/gpu-scan-now', { method:'POST' })
                          .then(() => setTimeout(() => { fetchGpuStatus(); setGpuScanLoading(false); }, 20000))
                          .catch(() => setGpuScanLoading(false));
                      }}
                      style={{ background: healthy?(gpuScanLoading?'#1e293b':'#4f46e5'):'#374151', color: healthy?'#fff':'#6b7280', border:'none', borderRadius:8, padding:'10px 0', fontWeight:700, cursor: healthy&&!gpuScanLoading?'pointer':'not-allowed', fontSize:13, width:'100%' }}>
                      {gpuScanLoading ? '⏳ Batch Scanning... (~15 detik)' : '⚡ Scan Batch Sekarang'}
                    </button>
                    <p style={{ color:'#475569', fontSize:11, textAlign:'center', margin:0 }}>
                      Auto-scan setiap 60 detik · Semua kamera diproses dalam 1 GPU forward pass
                    </p>
                  </div>
                </div>

                {/* ── ByteTrack Stats ── */}
                <div style={A.card}>
                  <div style={A.cardHdr('#0f766e')}>
                    <span>🎯 ByteTrack — Multi-Object Tracking</span>
                    <button onClick={fetchTrackerInfo} style={{ background:'rgba(255,255,255,.15)', border:'none', color:'#fff', padding:'4px 10px', borderRadius:6, cursor:'pointer', fontSize:11 }}>
                      Refresh Tracker
                    </button>
                  </div>
                  <div style={{ padding:16 }}>
                    {!isV4 ? (
                      <div style={{ background:'rgba(245,158,11,.08)', border:'1px solid rgba(245,158,11,.2)', borderRadius:8, padding:'12px 16px' }}>
                        <div style={{ color:'#fbbf24', fontWeight:700, fontSize:12, marginBottom:4 }}>⚠️ GPU Service v3 terdeteksi</div>
                        <div style={{ color:'#94a3b8', fontSize:11, lineHeight:1.6 }}>
                          ByteTrack membutuhkan GPU Service v4. Deploy dengan:<br/>
                          <code style={{ color:'#67e8f9', fontSize:10 }}>wget jaktrafficai.f-mc.my.id/api/gpu-service/v4 -O /tmp/gpu_service_v4.py && python3 /tmp/gpu_service_v4.py</code>
                        </div>
                      </div>
                    ) : trackerInfo ? (
                      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:4 }}>
                          <div style={{ background:'#1e293b', borderRadius:8, padding:'10px 14px' }}>
                            <div style={{ color:'#4ade80', fontSize:22, fontWeight:800 }}>{trackerInfo.count}</div>
                            <div style={{ color:'#64748b', fontSize:10 }}>Kamera Ditrack</div>
                          </div>
                          <div style={{ background:'#1e293b', borderRadius:8, padding:'10px 14px' }}>
                            <div style={{ color:'#a78bfa', fontSize:22, fontWeight:800 }}>
                              {Object.values(trackerInfo.trackers||{}).reduce((s,t)=>s+(t.active_tracks||0),0)}
                            </div>
                            <div style={{ color:'#64748b', fontSize:10 }}>Total Active Tracks</div>
                          </div>
                        </div>
                        {Object.entries(trackerInfo.trackers||{}).slice(0,6).map(([camId, t]) => (
                          <div key={camId} style={{ display:'flex', alignItems:'center', gap:10, background:'#0f172a', borderRadius:6, padding:'6px 12px' }}>
                            <span style={{ fontSize:10, color:'#64748b', minWidth:60 }}>Kamera {camId}</span>
                            <div style={{ flex:1, height:4, background:'#1e293b', borderRadius:2 }}>
                              <div style={{ width:`${Math.min((t.active_tracks||0)*10,100)}%`, height:'100%', background:'#4ade80', borderRadius:2 }} />
                            </div>
                            <span style={{ fontSize:10, color:'#4ade80', fontWeight:700, minWidth:30, textAlign:'right' }}>{t.active_tracks}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ color:'#64748b', fontSize:12, textAlign:'center', padding:'16px 0' }}>
                        {isV4 ? 'Klik "Refresh Tracker" untuk melihat status ByteTrack' : 'Tracker info tidak tersedia'}
                      </div>
                    )}
                  </div>
                </div>

                {/* ── Deploy v4 Guide ── */}
                {!isV4 && (
                  <div style={{ ...A.card, border:'1px solid rgba(99,102,241,.3)' }}>
                    <div style={A.cardHdr('#4f46e5')}>
                      <span>🚀 Deploy GPU Service v4</span>
                    </div>
                    <div style={{ padding:16, fontSize:12, color:'#94a3b8', lineHeight:1.8 }}>
                      <div style={{ marginBottom:8 }}>Buka Terminal di Jupyter GPU server, jalankan:</div>
                      {[
                        'pkill -f gpu_service && sleep 2',
                        'pip install -q "supervision>=0.21.0"',
                        'wget jaktrafficai.f-mc.my.id/api/gpu-service/v4 -O /tmp/gpu_service_v4.py',
                        'nohup python3 /tmp/gpu_service_v4.py > /tmp/gpu_v4.log 2>&1 &',
                      ].map((cmd, i) => (
                        <div key={i} style={{ background:'#0f172a', borderRadius:6, padding:'6px 10px', marginBottom:4, fontFamily:'monospace', fontSize:11, color:'#67e8f9' }}>
                          {cmd}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Indonesia Model Info ── */}
                {idModel && (
                  <div style={{ ...A.card, border:'1px solid rgba(99,102,241,.3)' }}>
                    <div style={A.cardHdr('#4338ca')}>
                      <span>🇮🇩 Model Indonesia — {idModel.filename}</span>
                      <button onClick={() => {
                        setModelBackupLoading(true);
                        fetch('/api/gpu/model/backup', { method:'POST' })
                          .then(r=>r.json())
                          .then(d=>{ alert(d.ok ? '✅ Backup OK' : '❌ '+d.error); setModelBackupLoading(false); })
                          .catch(()=>{ alert('GPU offline'); setModelBackupLoading(false); });
                      }} style={{ background:'rgba(255,255,255,.15)', border:'none', color:'#fff', padding:'4px 12px', borderRadius:6, cursor:'pointer', fontSize:11 }}>
                        {modelBackupLoading ? '⏳...' : '☁️ Backup dari GPU'}
                      </button>
                    </div>
                    <div style={{ padding:16, display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                      {[
                        ['Ukuran',    `${idModel.size_mb} MB`],
                        ['mAP50',     idModel.map50 || '—'],
                        ['Kelas',     `${(idModel.classes||'').split(',').length} kelas`],
                        ['Upload',    idModel.uploaded_at?.slice(0,10) || '—'],
                      ].map(([k,v]) => (
                        <div key={k} style={{ background:'#1e293b', borderRadius:8, padding:'8px 12px' }}>
                          <div style={{ color:'#64748b', fontSize:10, marginBottom:2 }}>{k}</div>
                          <div style={{ color:'#e2e8f0', fontSize:12 }}>{v}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ padding:'0 16px 12px', fontSize:11, color:'#64748b' }}>
                      Kelas: {idModel.classes || '—'}
                    </div>
                  </div>
                )}

                {/* ── Dataset Collector ── */}
                <div style={{ ...A.card, border:'1px solid rgba(16,185,129,.2)' }}>
                  <div style={A.cardHdr('#065f46')}>
                    <span>📦 Dataset Auto-Collector</span>
                    <div style={{ display:'flex', gap:8 }}>
                      <button onClick={() => { fetchDatasetStats(); }} style={{ background:'rgba(255,255,255,.15)', border:'none', color:'#fff', padding:'4px 12px', borderRadius:6, cursor:'pointer', fontSize:11 }}>
                        Refresh
                      </button>
                      <button onClick={() => {
                        setCollectLoading(true);
                        fetch('/api/dataset/collect-now', { method:'POST' })
                          .then(r=>r.json())
                          .then(()=>{ setTimeout(fetchDatasetStats, 3000); setCollectLoading(false); })
                          .catch(()=>setCollectLoading(false));
                      }} style={{ background:'rgba(255,255,255,.2)', border:'none', color:'#fff', padding:'4px 12px', borderRadius:6, cursor:'pointer', fontSize:11, fontWeight:700 }}>
                        {collectLoading ? '⏳ Mengumpulkan...' : '▶ Kumpulkan Sekarang'}
                      </button>
                    </div>
                  </div>
                  <div style={{ padding:16 }}>
                    {!datasetStats ? (
                      <div style={{ color:'#94a3b8', fontSize:12 }}>Memuat statistik dataset...</div>
                    ) : (
                      <>
                        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:12 }}>
                          {[
                            ['Total Frame',  datasetStats.total_images, '#60a5fa'],
                            ['Train',        datasetStats.train_images,  '#4ade80'],
                            ['Validasi',     datasetStats.val_images,    '#a78bfa'],
                            ['Ukuran (MB)',  datasetStats.size_mb,       '#f59e0b'],
                            ['Avg Box/Frame',datasetStats.avg_boxes_per_frame, '#fb923c'],
                            ['Siap Training',datasetStats.ready_for_training ? 'YA ✓' : `Butuh ${500-datasetStats.train_images} lagi`, datasetStats.ready_for_training?'#22c55e':'#f43f5e'],
                          ].map(([k,v,c]) => (
                            <div key={k} style={{ background:'#1e293b', borderRadius:8, padding:'8px 12px', textAlign:'center' }}>
                              <div style={{ color:c, fontSize:15, fontWeight:700, fontVariantNumeric:'tabular-nums' }}>{v}</div>
                              <div style={{ color:'#64748b', fontSize:9, marginTop:2 }}>{k}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize:10, color:'#475569' }}>
                          Koleksi terakhir: {datasetStats.last_collection || 'Belum ada'} · Otomatis setiap 30 menit dari 127 kamera
                        </div>
                        {datasetStats.ready_for_training && (
                          <div style={{ marginTop:10, background:'rgba(34,197,94,.08)', border:'1px solid rgba(34,197,94,.2)', borderRadius:8, padding:'8px 12px', fontSize:11, color:'#4ade80' }}>
                            ✅ Dataset cukup untuk training! Download dan jalankan training di GPU server.
                            <div style={{ marginTop:6, display:'flex', gap:8 }}>
                              <a href="/api/dataset/download" style={{ color:'#67e8f9', textDecoration:'none', fontSize:11 }}>⬇ Download Dataset ZIP</a>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* ── Training YOLO11x (terbaru) ── */}
                <div style={{ ...A.card, border:'1px solid rgba(139,92,246,.3)' }}>
                  <div style={A.cardHdr('#4c1d95')}>
                    <span>🚀 Training YOLO11x Indonesia (Tier 2 — Tertinggi)</span>
                    <span style={{ fontSize:10, color:'#c4b5fd' }}>+7.7% vs yolo11s · 54.7% mAP50-95</span>
                  </div>
                  <div style={{ padding:16, display:'flex', flexDirection:'column', gap:8 }}>
                    {[
                      { label:'Base Model', val:'yolo11x.pt (56.9M param)', c:'#c4b5fd' },
                      { label:'Batch Size', val:'8 (VRAM ~22 GB)', c:'#94a3b8' },
                      { label:'Epochs',     val:'80 epoch · lr=0.0005 · AMP', c:'#94a3b8' },
                    ].map(({label,val,c}) => (
                      <div key={label} style={{ display:'flex', gap:8, fontSize:11 }}>
                        <span style={{ color:'#64748b', minWidth:90 }}>{label}</span>
                        <span style={{ color:c }}>{val}</span>
                      </div>
                    ))}
                    <div style={{ background:'#0f172a', borderRadius:6, padding:'8px 10px', marginTop:4, fontFamily:'monospace', fontSize:11, color:'#67e8f9' }}>
                      wget jaktrafficai.f-mc.my.id/api/training/yolo11x -O /tmp/02_train_yolo11x.py && python3 /tmp/02_train_yolo11x.py
                    </div>
                  </div>
                </div>

                {/* ── Training YOLO11l ── */}
                <div style={{ ...A.card, border:'1px solid rgba(234,179,8,.2)' }}>
                  <div style={A.cardHdr('#854d0e')}>
                    <span>🧠 Training YOLO11l Indonesia (Tier 1)</span>
                    <span style={{ fontSize:10, color:'#fbbf24' }}>Estimasi +8-10% mAP vs YOLO11s</span>
                  </div>
                  <div style={{ padding:16, display:'flex', flexDirection:'column', gap:8 }}>
                    {[
                      { label:'Base Model', val:'yolo11l.pt (25.3M param)', c:'#fbbf24' },
                      { label:'Dataset', val:'Indonesian vehicles (angkot, bajaj, becak, gerobak)', c:'#94a3b8' },
                      { label:'Epochs', val:'80 epoch · batch 16 · AMP', c:'#94a3b8' },
                      { label:'VRAM est.', val:'~18 GB dari 48.3 GB tersedia', c:'#4ade80' },
                    ].map(({label,val,c}) => (
                      <div key={label} style={{ display:'flex', gap:8, fontSize:11 }}>
                        <span style={{ color:'#64748b', minWidth:90 }}>{label}</span>
                        <span style={{ color:c }}>{val}</span>
                      </div>
                    ))}
                    <div style={{ background:'#0f172a', borderRadius:6, padding:'8px 12px', marginTop:4, fontFamily:'monospace', fontSize:11, color:'#67e8f9' }}>
                      python3 /tmp/02_train_yolo11l.py
                    </div>
                    <div style={{ fontSize:10, color:'#475569' }}>
                      Download script: wget jaktrafficai.f-mc.my.id/api/training/yolo11l -O /tmp/02_train_yolo11l.py
                    </div>
                  </div>
                </div>

              </div>
            );
          })()}

          {/* ════════════ TAB: MANAJEMEN ════════════ */}
          {/* ════════════ TAB: HEALTH MONITORING ════════════ */}
          {activeTab === 'manajemen' && (() => {
            const summary = camHealth?.summary || {};
            const cameras = camHealth?.cameras || [];

            const STATUS_META = {
              online:      { label:'Online',       color:'#22c55e', bg:'rgba(34,197,94,.1)',   icon:'●' },
              stale:       { label:'Lambat',        color:'#f59e0b', bg:'rgba(245,158,11,.1)',  icon:'◉' },
              offline:     { label:'Offline',       color:'#f43f5e', bg:'rgba(244,63,94,.1)',   icon:'○' },
              maintenance: { label:'Pemeliharaan',  color:'#a78bfa', bg:'rgba(167,139,250,.1)', icon:'🔧' },
              no_stream:   { label:'Tanpa Stream',  color:'#475569', bg:'rgba(71,85,105,.1)',   icon:'—' },
              unknown:     { label:'Belum Scan',    color:'#64748b', bg:'rgba(100,116,139,.1)', icon:'?' },
            };

            const filtered = cameras.filter(c => {
              const matchSearch = !healthSearch || c.name?.toLowerCase().includes(healthSearch.toLowerCase()) || String(c.id).includes(healthSearch);
              const matchFilter = healthFilter === 'all' || c.status === healthFilter;
              return matchSearch && matchFilter;
            });

            const formatAge = (s) => {
              if (s === null || s === undefined) return '—';
              if (s < 60)   return `${s}d`;
              if (s < 3600) return `${Math.floor(s/60)}m`;
              return `${Math.floor(s/3600)}j`;
            };

            return (
              <div style={{ display:'flex', gap:12 }}>
                {/* ── Left: Camera List ── */}
                <div style={{ flex:1, display:'flex', flexDirection:'column', gap:10, minWidth:0 }}>

                  {/* Summary Bar */}
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:8 }}>
                    {[
                      ['Total',    summary.total,       '#e2e8f0'],
                      ['Online',   summary.online,      '#22c55e'],
                      ['Offline',  summary.offline,     '#f43f5e'],
                      ['Maint.',   summary.maintenance, '#a78bfa'],
                      ['No Stream',summary.no_stream,   '#475569'],
                    ].map(([k,v,c]) => (
                      <div key={k} style={{ background:'#0f172a', border:`1px solid ${c}22`, borderRadius:8, padding:'10px 8px', textAlign:'center' }}>
                        <div style={{ color:c, fontSize:20, fontWeight:800, lineHeight:1 }}>{v ?? '—'}</div>
                        <div style={{ color:'#64748b', fontSize:9, marginTop:2 }}>{k}</div>
                      </div>
                    ))}
                  </div>

                  {/* Search + Filter */}
                  <div style={{ display:'flex', gap:8 }}>
                    <input value={healthSearch} onChange={e=>setHealthSearch(e.target.value)} placeholder="Cari nama / ID kamera..."
                      style={{ flex:1, background:'#0f172a', border:'1px solid rgba(255,255,255,.08)', borderRadius:8, padding:'8px 12px', color:'#e2e8f0', fontSize:12, outline:'none' }} />
                    <select value={healthFilter} onChange={e=>setHealthFilter(e.target.value)}
                      style={{ background:'#0f172a', border:'1px solid rgba(255,255,255,.08)', borderRadius:8, padding:'8px 10px', color:'#94a3b8', fontSize:11, cursor:'pointer' }}>
                      <option value="all">Semua Status</option>
                      <option value="online">Online</option>
                      <option value="stale">Lambat</option>
                      <option value="offline">Offline</option>
                      <option value="maintenance">Pemeliharaan</option>
                      <option value="no_stream">Tanpa Stream</option>
                      <option value="unknown">Belum Scan</option>
                    </select>
                    <button onClick={fetchCamHealth} style={{ background:'#1e293b', border:'1px solid rgba(255,255,255,.08)', borderRadius:8, padding:'8px 12px', color:'#94a3b8', cursor:'pointer', fontSize:11, fontWeight:700 }}>
                      {camHealthLoading ? '⟳' : '↻ Refresh'}
                    </button>
                  </div>

                  {/* Camera List */}
                  <div style={{ background:'#0f172a', borderRadius:10, border:'1px solid rgba(255,255,255,.06)', overflow:'hidden' }}>
                    {/* Header row */}
                    <div style={{ display:'grid', gridTemplateColumns:'44px 1fr 90px 60px 60px 60px 70px', padding:'8px 12px', borderBottom:'1px solid rgba(255,255,255,.06)', background:'rgba(255,255,255,.02)' }}>
                      {['ID','Nama','Status','Last Seen','Count','Speed','Errors'].map(h => (
                        <div key={h} style={{ fontSize:9, fontWeight:700, color:'#475569', letterSpacing:.6 }}>{h.toUpperCase()}</div>
                      ))}
                    </div>
                    <div style={{ maxHeight:'calc(100vh - 340px)', overflowY:'auto' }}>
                      {camHealthLoading && cameras.length === 0 ? (
                        <div style={{ textAlign:'center', padding:'32px 0', color:'#475569', fontSize:12 }}>Memuat data health kamera...</div>
                      ) : filtered.length === 0 ? (
                        <div style={{ textAlign:'center', padding:'24px 0', color:'#475569', fontSize:12 }}>Tidak ada kamera yang cocok</div>
                      ) : filtered.map((c, i) => {
                        const meta = STATUS_META[c.status] || STATUS_META.unknown;
                        const isSelected = selectedHealthCam?.id === c.id;
                        return (
                          <div key={c.id}
                            onClick={() => { setSelectedHealthCam(c); setCalibForm({ pix_per_meter: c.pix_per_meter || 8.0, maintenance: c.maintenance || false, maintenance_note: c.maintenance_note || '' }); }}
                            style={{ display:'grid', gridTemplateColumns:'44px 1fr 90px 60px 60px 60px 70px', alignItems:'center', padding:'8px 12px', cursor:'pointer', borderBottom:'1px solid rgba(255,255,255,.03)', background: isSelected ? 'rgba(245,158,11,.06)' : i%2===0?'transparent':'rgba(255,255,255,.01)', transition:'background .15s' }}>
                            <div style={{ fontSize:10, color:'#475569', fontWeight:700, fontVariantNumeric:'tabular-nums' }}>{c.id}</div>
                            <div style={{ fontSize:11, fontWeight:600, color:'#e2e8f0', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', paddingRight:8 }}>
                              {c.maintenance && <span style={{ fontSize:9, color:'#a78bfa', marginRight:4 }}>🔧</span>}
                              {c.name}
                            </div>
                            <div>
                              <span style={{ fontSize:9, fontWeight:700, color:meta.color, background:meta.bg, borderRadius:10, padding:'2px 7px', whiteSpace:'nowrap' }}>
                                {meta.icon} {meta.label}
                              </span>
                            </div>
                            <div style={{ fontSize:10, color:'#64748b', fontVariantNumeric:'tabular-nums' }}>{formatAge(c.last_seen_age_s)}</div>
                            <div style={{ fontSize:10, color: (c.last_count||0)>40?'#f43f5e':(c.last_count||0)>20?'#f59e0b':'#94a3b8', fontWeight:700, fontVariantNumeric:'tabular-nums' }}>{c.last_count ?? '—'}</div>
                            <div style={{ fontSize:10, color:'#60a5fa', fontVariantNumeric:'tabular-nums' }}>{c.speed_kmh != null ? `${c.speed_kmh}` : '—'}</div>
                            <div style={{ fontSize:10, fontVariantNumeric:'tabular-nums', color: (c.error_count||0)>5?'#f43f5e':(c.error_count||0)>0?'#f59e0b':'#475569' }}>
                              {c.error_count || 0} err
                              {(c.consecutive_errors||0) > 0 && <span style={{ color:'#f43f5e', fontSize:9, marginLeft:3 }}>({c.consecutive_errors}x)</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div style={{ fontSize:10, color:'#475569', textAlign:'right' }}>
                    Menampilkan {filtered.length} dari {cameras.length} kamera · Last seen = usia sejak scan terakhir
                  </div>
                </div>

                {/* ── Right: Camera Config Panel ── */}
                {selectedHealthCam && (
                  <div style={{ width:280, flexShrink:0, display:'flex', flexDirection:'column', gap:10 }}>
                    <div style={{ background:'#0f172a', borderRadius:10, border:'1px solid rgba(245,158,11,.15)', overflow:'hidden' }}>
                      <div style={{ background:'linear-gradient(135deg,rgba(245,158,11,.15),rgba(245,158,11,.05))', padding:'12px 16px', borderBottom:'1px solid rgba(245,158,11,.1)' }}>
                        <div style={{ fontSize:11, fontWeight:800, color:'#fbbf24', marginBottom:2 }}>📹 Kamera #{selectedHealthCam.id}</div>
                        <div style={{ fontSize:12, fontWeight:600, color:'#e2e8f0' }}>{selectedHealthCam.name}</div>
                        <div style={{ fontSize:10, color:'#64748b', marginTop:2 }}>{selectedHealthCam.road_type === 'toll' ? '🛣️ Tol' : '🏙️ Kota'} · {selectedHealthCam.lat?.toFixed(4)}, {selectedHealthCam.lng?.toFixed(4)}</div>
                      </div>

                      <div style={{ padding:14, display:'flex', flexDirection:'column', gap:10 }}>
                        {/* Status info */}
                        {(() => { const meta = STATUS_META[selectedHealthCam.status] || STATUS_META.unknown; return (
                          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', background:'rgba(255,255,255,.03)', borderRadius:7, padding:'8px 12px' }}>
                            <span style={{ fontSize:11, color:'#64748b' }}>Status</span>
                            <span style={{ fontSize:11, fontWeight:700, color:meta.color }}>{meta.icon} {meta.label}</span>
                          </div>
                        ); })()}

                        {[
                          ['Scan Sukses',  `${selectedHealthCam.success_count || 0}x`],
                          ['Scan Error',   `${selectedHealthCam.error_count || 0}x`],
                          ['Error Berturut', `${selectedHealthCam.consecutive_errors || 0}x`],
                          ['Last Seen',    selectedHealthCam.last_seen || '—'],
                          ['Kendaraan',    selectedHealthCam.last_count ?? '—'],
                          ['Kecepatan',    selectedHealthCam.speed_kmh != null ? `${selectedHealthCam.speed_kmh} km/h` : '—'],
                        ].map(([k,v]) => (
                          <div key={k} style={{ display:'flex', justifyContent:'space-between', fontSize:10, padding:'4px 0', borderBottom:'1px solid rgba(255,255,255,.04)' }}>
                            <span style={{ color:'#64748b' }}>{k}</span>
                            <span style={{ color:'#94a3b8', fontVariantNumeric:'tabular-nums' }}>{v}</span>
                          </div>
                        ))}

                        {/* Kalibrasi pix_per_meter */}
                        <div style={{ marginTop:6 }}>
                          <div style={{ fontSize:9, fontWeight:700, color:'#64748b', letterSpacing:.8, marginBottom:6 }}>KALIBRASI PERSPEKTIF</div>
                          <div style={{ fontSize:10, color:'#475569', marginBottom:8, lineHeight:1.5 }}>
                            Pixel per meter — lebih akurat = estimasi kecepatan ByteTrack lebih presisi. Ukur jarak jalan nyata vs jumlah pixel.
                          </div>
                          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                            <span style={{ fontSize:10, color:'#94a3b8' }}>pix/meter</span>
                            <span style={{ fontSize:12, fontWeight:800, color:'#38bdf8', fontVariantNumeric:'tabular-nums' }}>{calibForm.pix_per_meter}</span>
                          </div>
                          <input type="range" min="2" max="30" step="0.5" value={calibForm.pix_per_meter}
                            onChange={e => setCalibForm(f => ({...f, pix_per_meter: parseFloat(e.target.value)}))}
                            style={{ width:'100%', accentColor:'#38bdf8', cursor:'pointer' }} />
                          <div style={{ display:'flex', justifyContent:'space-between', fontSize:9, color:'#334155' }}>
                            <span>2 (kamera jauh)</span><span>8 (default)</span><span>30 (kamera dekat)</span>
                          </div>
                        </div>

                        {/* Maintenance toggle */}
                        <div style={{ background: calibForm.maintenance?'rgba(167,139,250,.08)':'rgba(255,255,255,.02)', border:`1px solid ${calibForm.maintenance?'rgba(167,139,250,.2)':'rgba(255,255,255,.06)'}`, borderRadius:8, padding:'10px 12px' }}>
                          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: calibForm.maintenance?8:0 }}>
                            <span style={{ fontSize:11, fontWeight:700, color: calibForm.maintenance?'#a78bfa':'#64748b' }}>🔧 Mode Pemeliharaan</span>
                            <div onClick={() => setCalibForm(f => ({...f, maintenance: !f.maintenance}))}
                              style={{ width:36, height:20, borderRadius:10, background: calibForm.maintenance?'#7c3aed':'#334155', cursor:'pointer', position:'relative', transition:'background .2s' }}>
                              <div style={{ position:'absolute', top:2, left: calibForm.maintenance?16:2, width:16, height:16, borderRadius:'50%', background:'#fff', transition:'left .2s' }} />
                            </div>
                          </div>
                          {calibForm.maintenance && (
                            <textarea placeholder="Catatan pemeliharaan (opsional)..." value={calibForm.maintenance_note}
                              onChange={e => setCalibForm(f => ({...f, maintenance_note: e.target.value}))}
                              style={{ width:'100%', background:'rgba(255,255,255,.05)', border:'1px solid rgba(167,139,250,.2)', borderRadius:6, padding:'6px 8px', color:'#e2e8f0', fontSize:10, resize:'none', outline:'none', boxSizing:'border-box', marginTop:2 }}
                              rows={2} />
                          )}
                        </div>

                        <button onClick={() => updateCamConfig(selectedHealthCam.id, calibForm).then(() => {
                            setSelectedHealthCam(c => ({...c, ...calibForm}));
                          })}
                          style={{ background:'linear-gradient(135deg,#f59e0b,#d97706)', border:'none', borderRadius:8, padding:'10px 0', color:'#020811', fontWeight:800, fontSize:12, cursor:'pointer', width:'100%', marginTop:4 }}>
                          Simpan Konfigurasi
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* ════════════ TAB: LAPORAN MASYARAKAT ════════════ */}
          {activeTab === 'laporan' && (() => {
            const TYPE_META = {
              macet:      { label:'Kemacetan',         icon:'🚗', color:'#f59e0b', bg:'rgba(245,158,11,.1)' },
              banjir:     { label:'Banjir',             icon:'🌊', color:'#38bdf8', bg:'rgba(56,189,248,.1)' },
              kecelakaan: { label:'Kecelakaan',         icon:'🚨', color:'#f43f5e', bg:'rgba(244,63,94,.1)'  },
              tutup:      { label:'Jalan Ditutup',      icon:'🚧', color:'#fb923c', bg:'rgba(251,146,60,.1)' },
              galian:     { label:'Pekerjaan Jalan',    icon:'⛏️', color:'#a78bfa', bg:'rgba(167,139,250,.1)'},
              longsor:    { label:'Tanah Longsor',      icon:'⛰️', color:'#d97706', bg:'rgba(217,119,6,.1)'  },
            };
            const STATUS_META = {
              pending:   { label:'Menunggu',    color:'#f59e0b', bg:'rgba(245,158,11,.1)' },
              verified:  { label:'Diverifikasi',color:'#22c55e', bg:'rgba(34,197,94,.1)'  },
              dismissed: { label:'Diabaikan',   color:'#64748b', bg:'rgba(100,116,139,.1)'},
              resolved:  { label:'Selesai',     color:'#60a5fa', bg:'rgba(96,165,250,.1)' },
            };
            const filtered = reports.filter(r =>
              reportFilter === 'all' || r.status === reportFilter
            );
            const counts = reports.reduce((acc, r) => { acc[r.status] = (acc[r.status]||0)+1; return acc; }, {});

            return (
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>

                {/* Summary + Filter row */}
                <div style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'center' }}>
                  <div style={{ display:'flex', gap:8 }}>
                    {Object.entries(STATUS_META).map(([k,m]) => (
                      <button key={k} onClick={() => setReportFilter(reportFilter===k?'all':k)}
                        style={{ background: reportFilter===k?m.bg:'#0f172a', border:`1px solid ${reportFilter===k?m.color:'rgba(255,255,255,.08)'}`, borderRadius:8, padding:'6px 12px', color: reportFilter===k?m.color:'#64748b', fontSize:10, fontWeight:700, cursor:'pointer', display:'flex', gap:5, alignItems:'center' }}>
                        <span>{m.label}</span>
                        {(counts[k]||0) > 0 && <span style={{ background:m.bg, color:m.color, borderRadius:10, padding:'1px 6px', fontSize:9 }}>{counts[k]}</span>}
                      </button>
                    ))}
                  </div>
                  <div style={{ marginLeft:'auto', display:'flex', gap:6 }}>
                    <button onClick={() => fetchReports(true)} style={{ background:'#1e293b', border:'1px solid rgba(255,255,255,.08)', borderRadius:8, padding:'6px 12px', color:'#94a3b8', fontSize:11, cursor:'pointer', fontWeight:700 }}>
                      {reportsLoading ? '⟳' : '↻'} Refresh
                    </button>
                  </div>
                </div>

                {/* Report list */}
                {reportsLoading && filtered.length === 0 ? (
                  <div style={{ textAlign:'center', padding:'40px 0', color:'#475569' }}>Memuat laporan...</div>
                ) : filtered.length === 0 ? (
                  <div style={{ textAlign:'center', padding:'40px 0', color:'#475569', fontSize:12 }}>
                    Tidak ada laporan {reportFilter !== 'all' ? `dengan status "${STATUS_META[reportFilter]?.label}"` : ''}
                  </div>
                ) : (
                  <div style={{ display:'flex', flexDirection:'column', gap:8, maxHeight:'calc(100vh - 240px)', overflowY:'auto' }}>
                    {filtered.map(r => {
                      const tm  = TYPE_META[r.report_type]   || { label:r.report_type, icon:'📍', color:'#94a3b8', bg:'rgba(148,163,184,.1)' };
                      const sm  = STATUS_META[r.status]      || STATUS_META.pending;
                      const ago = (() => {
                        if (!r.created_at) return '';
                        const diff = Math.floor((Date.now() - new Date(r.created_at)) / 1000);
                        if (diff < 60)   return `${diff} detik lalu`;
                        if (diff < 3600) return `${Math.floor(diff/60)} menit lalu`;
                        return `${Math.floor(diff/3600)} jam lalu`;
                      })();
                      return (
                        <div key={r.id} style={{ background:'#0f172a', borderRadius:10, border:`1px solid ${r.status==='verified'?'rgba(34,197,94,.15)':r.status==='dismissed'?'rgba(100,116,139,.08)':'rgba(255,255,255,.06)'}`, padding:14, display:'flex', gap:12 }}>
                          {/* Icon */}
                          <div style={{ width:40, height:40, borderRadius:10, background:tm.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, flexShrink:0 }}>
                            {tm.icon}
                          </div>
                          {/* Info */}
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4, flexWrap:'wrap' }}>
                              <span style={{ fontSize:12, fontWeight:700, color:tm.color }}>{tm.label}</span>
                              <span style={{ fontSize:9, fontWeight:700, color:sm.color, background:sm.bg, borderRadius:10, padding:'2px 8px' }}>{sm.label}</span>
                              <span style={{ fontSize:10, color:'#475569', marginLeft:'auto' }}>#{r.id} · {ago}</span>
                            </div>
                            {r.description && <div style={{ fontSize:11, color:'#94a3b8', marginBottom:4, lineHeight:1.4 }}>{r.description}</div>}
                            <div style={{ display:'flex', gap:12, fontSize:10, color:'#475569' }}>
                              <span>📍 {r.lat?.toFixed(5)}, {r.lng?.toFixed(5)}</span>
                              {r.operator_note && <span style={{ color:'#64748b' }}>Catatan: {r.operator_note}</span>}
                            </div>
                          </div>
                          {/* Actions */}
                          <div style={{ display:'flex', flexDirection:'column', gap:5, flexShrink:0 }}>
                            {r.status === 'pending' && (
                              <button onClick={() => updateReport(r.id, 'verified', null)}
                                style={{ background:'rgba(34,197,94,.1)', border:'1px solid rgba(34,197,94,.25)', borderRadius:7, padding:'5px 10px', color:'#22c55e', fontSize:10, fontWeight:700, cursor:'pointer' }}>
                                ✓ Verifikasi
                              </button>
                            )}
                            {r.status === 'verified' && (
                              <button onClick={() => updateReport(r.id, 'resolved', null)}
                                style={{ background:'rgba(96,165,250,.1)', border:'1px solid rgba(96,165,250,.25)', borderRadius:7, padding:'5px 10px', color:'#60a5fa', fontSize:10, fontWeight:700, cursor:'pointer' }}>
                                ✓ Selesai
                              </button>
                            )}
                            {r.status !== 'dismissed' && (
                              <button onClick={() => updateReport(r.id, 'dismissed', null)}
                                style={{ background:'rgba(100,116,139,.08)', border:'1px solid rgba(100,116,139,.15)', borderRadius:7, padding:'5px 10px', color:'#64748b', fontSize:10, fontWeight:700, cursor:'pointer' }}>
                                Abaikan
                              </button>
                            )}
                            <button onClick={() => { if(window.confirm('Hapus laporan ini?')) deleteReport(r.id); }}
                              style={{ background:'rgba(244,63,94,.08)', border:'1px solid rgba(244,63,94,.15)', borderRadius:7, padding:'5px 10px', color:'#f43f5e', fontSize:10, fontWeight:700, cursor:'pointer' }}>
                              Hapus
                            </button>
                            <a href={`https://maps.google.com/?q=${r.lat},${r.lng}`} target="_blank" rel="noreferrer"
                              style={{ background:'rgba(99,102,241,.08)', border:'1px solid rgba(99,102,241,.15)', borderRadius:7, padding:'5px 10px', color:'#818cf8', fontSize:10, fontWeight:700, textDecoration:'none', textAlign:'center' }}>
                              🗺 Maps
                            </a>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div style={{ fontSize:10, color:'#334155', textAlign:'right' }}>
                  {reports.length} laporan total · Klik "Verifikasi" untuk tampilkan di peta user
                </div>
              </div>
            );
          })()}

          {activeTab === 'manajemen' && (
            <div style={A.card}>
              <div style={A.cardHdr('#f59e0b')}>
                <span style={{ fontSize:12, fontWeight:700, color:'#fbbf24' }}>🗄️ Manajemen Data Kamera</span>
                <button onClick={openAddModal} style={{ ...A.btn(), marginLeft:'auto', fontSize:10 }}>+ Tambah Kamera</button>
              </div>

              {/* Table header */}
              <div style={{ display:'flex', padding:'8px 16px', borderBottom:'1px solid rgba(255,255,255,.08)', background:'rgba(255,255,255,.03)' }}>
                {['ID','Nama Lokasi','Tipe Jalan','Lat','Lng','Stream URL','Status','Aksi'].map(h => (
                  <div key={h} style={{ fontSize:8, fontWeight:700, color:'#475569', letterSpacing:.7, flex:h==='Nama Lokasi'||h==='Stream URL'?2:h==='Aksi'?0.7:1, textAlign:'left' }}>{h.toUpperCase()}</div>
                ))}
              </div>

              <div style={{ maxHeight:'calc(100vh - 260px)', overflowY:'auto' }}>
                {cctvList.map((cam,i) => {
                  const v = cam.vehicles||0;
                  const color = v>40?'#f43f5e':v>20?'#f59e0b':'#10b981';
                  const label = v>40?'PADAT':v>20?'RAMAI':'LANCAR';
                  const hasStream = !!(cam.stream_url||cam.preview_url);
                  return (
                    <div key={cam.id} style={{ display:'flex', alignItems:'center', padding:'7px 16px', borderBottom:'1px solid rgba(255,255,255,.04)', background:i%2===0?'rgba(255,255,255,.015)':'transparent' }}>
                      <div style={{ flex:1, fontSize:10, color:'#475569', fontVariantNumeric:'tabular-nums', fontWeight:700 }}>{cam.id}</div>
                      <div style={{ flex:2, fontSize:11, fontWeight:600 }}>{cam.name}</div>
                      <div style={{ flex:1 }}><span style={{ fontSize:9, fontWeight:700, color:cam.road_type==='toll'?'#f59e0b':'#60a5fa' }}>{cam.road_type==='toll'?'TOL':'KOTA'}</span></div>
                      <div style={{ flex:1, fontSize:9, color:'#64748b', fontVariantNumeric:'tabular-nums' }}>{cam.lat?.toFixed(4)}</div>
                      <div style={{ flex:1, fontSize:9, color:'#64748b', fontVariantNumeric:'tabular-nums' }}>{cam.lng?.toFixed(4)}</div>
                      <div style={{ flex:2, fontSize:9, color:hasStream?'#10b981':'#475569', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {hasStream ? '✓ Tersedia' : '— Tidak ada'}
                      </div>
                      <div style={{ flex:1 }}><span style={A.badge(color, color==='#f43f5e'?'rgba(244,63,94,.1)':color==='#f59e0b'?'rgba(245,158,11,.1)':'rgba(16,185,129,.1)')}>{label}</span></div>
                      <div style={{ flex:0.7 }}>
                        <button onClick={() => { setSelectedCam(cam); openEditModal(); }} style={{ fontSize:9, padding:'3px 7px', background:'rgba(245,158,11,.1)', border:'1px solid rgba(245,158,11,.25)', borderRadius:5, color:'#f59e0b', cursor:'pointer', fontWeight:700 }}>Edit</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ══ TAB: FILTER KAMERA (sub-tab Manajemen) ════════════ */}
          {activeTab === 'manajemen' && (() => {
            const ROUTE_OPTS = [
              { v:'all',  l:'🗺️ Semua',       desc:'Tampilkan semua kamera kota & tol' },
              { v:'city', l:'🏙️ Kota saja',   desc:'Filter hanya kamera jalan perkotaan' },
              { v:'toll', l:'🛣️ Tol saja',    desc:'Filter hanya kamera ruas tol' },
            ];
            const AREA_OPTS = [
              { id:'all',     l:'Semua Wilayah', color:'#f59e0b' },
              { id:'pusat',   l:'Jakarta Pusat', color:'#60a5fa' },
              { id:'utara',   l:'Jakarta Utara', color:'#34d399' },
              { id:'barat',   l:'Jakarta Barat', color:'#a78bfa' },
              { id:'timur',   l:'Jakarta Timur', color:'#fb923c' },
              { id:'selatan', l:'Jakarta Selatan',color:'#f472b6' },
              { id:'bekasi',  l:'Bekasi',         color:'#22d3ee' },
            ];

            const AREA_FNS = {
              pusat:   c => c.lat < -6.16 && c.lat > -6.24 && c.lng > 106.81 && c.lng < 106.87 && c.road_type !== 'toll',
              utara:   c => c.lat > -6.17 && c.lng < 106.93 && c.road_type !== 'toll',
              barat:   c => c.lng < 106.80 && c.lat > -6.30 && c.road_type !== 'toll',
              timur:   c => c.lng > 106.87 && c.lat > -6.27 && c.lat < -6.16 && c.road_type !== 'toll',
              selatan: c => c.lat < -6.27 && c.road_type !== 'toll',
              bekasi:  c => c.lng > 106.96,
            };

            const countForArea = (id) => {
              if (id === 'all') return cctvList.length;
              const fn = AREA_FNS[id];
              return fn ? cctvList.filter(fn).length : 0;
            };
            const countForRoute = (v) => {
              if (v === 'all') return cctvList.length;
              return cctvList.filter(c => (c.road_type||'city') === v).length;
            };

            return (
              <div style={{ display:'flex', flexDirection:'column', gap:16, maxWidth:700 }}>
                {/* Header card */}
                <div style={A.card}>
                  <div style={A.cardHdr('#38bdf8')}>
                    <span style={{ fontSize:12, fontWeight:700, color:'#7dd3fc' }}>📹 Filter Kamera — Tampilan Peta</span>
                    <a href="/" target="_blank" rel="noreferrer"
                      style={{ marginLeft:'auto', fontSize:10, color:'#38bdf8', textDecoration:'none', background:'rgba(56,189,248,.1)', border:'1px solid rgba(56,189,248,.25)', borderRadius:6, padding:'4px 10px', fontWeight:700 }}>
                      Buka Peta →
                    </a>
                  </div>
                  <div style={{ padding:'12px 16px', fontSize:11, color:'#64748b', lineHeight:1.6 }}>
                    Filter ini mengatur kamera CCTV yang tampil di peta pada browser ini.
                    Pengaturan disimpan di browser lokal — gunakan halaman peta yang sama untuk melihat efeknya.
                  </div>
                </div>

                {/* Jenis Jalan */}
                <div style={A.card}>
                  <div style={A.cardHdr('#f59e0b')}>
                    <span style={{ fontSize:11, fontWeight:700, color:'#fbbf24' }}>🛣️ Filter Jenis Jalan</span>
                    <span style={{ marginLeft:'auto', fontSize:9, color:'#64748b' }}>Aktif: <b style={{ color:'#fbbf24' }}>{ROUTE_OPTS.find(o=>o.v===routeFilter)?.l}</b></span>
                  </div>
                  <div style={{ padding:16, display:'flex', flexDirection:'column', gap:8 }}>
                    {ROUTE_OPTS.map(o => (
                      <div key={o.v}
                        onClick={() => { setRouteFilter(o.v); applyFilter(o.v, null); }}
                        style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px', borderRadius:8, cursor:'pointer', border: routeFilter===o.v ? '1px solid rgba(245,158,11,.5)' : '1px solid rgba(255,255,255,.06)', background: routeFilter===o.v ? 'rgba(245,158,11,.1)' : 'rgba(255,255,255,.02)', transition:'all .15s' }}>
                        <div style={{ width:16, height:16, borderRadius:'50%', border: routeFilter===o.v ? '5px solid #f59e0b' : '2px solid #374151', transition:'all .15s', flexShrink:0 }} />
                        <div>
                          <div style={{ fontSize:12, fontWeight:700, color: routeFilter===o.v ? '#fbbf24' : '#94a3b8' }}>{o.l}</div>
                          <div style={{ fontSize:10, color:'#475569' }}>{o.desc} — <b style={{ color:'#64748b' }}>{countForRoute(o.v)} kamera</b></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Wilayah */}
                <div style={A.card}>
                  <div style={A.cardHdr('#22d3ee')}>
                    <span style={{ fontSize:11, fontWeight:700, color:'#67e8f9' }}>🗺️ Filter Wilayah</span>
                    <span style={{ marginLeft:'auto', fontSize:9, color:'#64748b' }}>Aktif: <b style={{ color:'#22d3ee' }}>{AREA_OPTS.find(o=>o.id===areaFilter)?.l}</b></span>
                  </div>
                  <div style={{ padding:16, display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                    {AREA_OPTS.map(o => (
                      <div key={o.id}
                        onClick={() => { setAreaFilter(o.id); applyFilter(null, o.id); }}
                        style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 14px', borderRadius:8, cursor:'pointer', border: areaFilter===o.id ? `1px solid ${o.color}55` : '1px solid rgba(255,255,255,.06)', background: areaFilter===o.id ? `${o.color}18` : 'rgba(255,255,255,.02)', transition:'all .15s' }}>
                        <div>
                          <div style={{ fontSize:11, fontWeight:700, color: areaFilter===o.id ? o.color : '#94a3b8' }}>{o.l}</div>
                          <div style={{ fontSize:9, color:'#475569', marginTop:2 }}>{countForArea(o.id)} kamera</div>
                        </div>
                        {areaFilter===o.id && <span style={{ fontSize:14 }}>✓</span>}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Status + links */}
                <div style={{ display:'flex', gap:10, alignItems:'center' }}>
                  <div style={{ flex:1, padding:'10px 16px', borderRadius:9, background: filterSaved ? 'rgba(16,185,129,.1)' : 'rgba(255,255,255,.04)', border: filterSaved ? '1px solid rgba(16,185,129,.3)' : '1px solid rgba(255,255,255,.06)', fontSize:11, color: filterSaved ? '#10b981' : '#475569', fontWeight:600, transition:'all .3s', textAlign:'center' }}>
                    {filterSaved ? '✅ Filter berhasil disimpan ke peta!' : 'Klik opsi di atas untuk mengubah filter'}
                  </div>
                  <a href="/nvr" target="_blank" rel="noreferrer"
                    style={{ padding:'10px 18px', borderRadius:9, background:'rgba(56,189,248,.1)', border:'1px solid rgba(56,189,248,.25)', color:'#38bdf8', fontSize:11, fontWeight:700, textDecoration:'none', flexShrink:0 }}>
                    📹 Buka NVR Grid
                  </a>
                </div>

                {/* ── Training Model AI ── */}
                <div style={{ ...A.card, marginTop:16 }}>
                  <div style={A.cardHdr('#34d399')}>
                    <span style={{ fontSize:13 }}>🧠</span>
                    <span style={{ fontSize:12, fontWeight:700, color:'#34d399' }}>Training Model YOLO11l</span>
                    <button onClick={() => { fetchTrainCheck(); fetchTrainStatus(); }} style={{ marginLeft:'auto', background:'transparent', border:'none', color:'#64748b', fontSize:10, cursor:'pointer' }}>↻ Refresh</button>
                  </div>
                  <div style={{ padding:16 }}>
                    {trainCheck && (
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:12 }}>
                        <div style={{ background:'#0f172a', borderRadius:8, padding:'8px 12px' }}>
                          <div style={{ fontSize:9, color:'#64748b', marginBottom:2 }}>Dataset</div>
                          <div style={{ fontSize:11, fontWeight:700, color: trainCheck.dataset_found ? '#22c55e' : '#ef4444' }}>{trainCheck.dataset_found ? '✓ Tersedia' : '✗ Tidak ada'}</div>
                        </div>
                        <div style={{ background:'#0f172a', borderRadius:8, padding:'8px 12px' }}>
                          <div style={{ fontSize:9, color:'#64748b', marginBottom:2 }}>VRAM Bebas</div>
                          <div style={{ fontSize:11, fontWeight:700, color:'#60a5fa' }}>{trainCheck.vram_free_gb} GB</div>
                        </div>
                      </div>
                    )}
                    {trainStatus && trainStatus.status !== 'idle' && (
                      <div style={{ marginBottom:12 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:6 }}>
                          <div style={{ width:7, height:7, borderRadius:'50%', background: trainStatus.status==='running'?'#22c55e':trainStatus.status==='done'?'#60a5fa':'#f43f5e', animation:trainStatus.status==='running'?'pulse-red 1.5s infinite':'none' }} />
                          <span style={{ fontSize:11, fontWeight:700, color: trainStatus.status==='running'?'#34d399':trainStatus.status==='done'?'#60a5fa':'#f87171' }}>
                            {trainStatus.status==='running' ? `Training berjalan... ${trainStatus.elapsed ? Math.floor(trainStatus.elapsed/60)+'m' : ''}` : trainStatus.status==='done' ? 'Selesai ✓' : 'Error'}
                          </span>
                        </div>
                        {trainStatus.progress && <div style={{ fontSize:9, color:'#64748b', marginBottom:6 }}>{trainStatus.progress}</div>}
                        {trainStatus.log_tail && (
                          <pre style={{ fontSize:8, color:'#475569', background:'#020810', borderRadius:6, padding:'8px 10px', margin:0, maxHeight:100, overflowY:'auto', whiteSpace:'pre-wrap', wordBreak:'break-all' }}>
                            {trainStatus.log_tail.slice(-600)}
                          </pre>
                        )}
                      </div>
                    )}
                    <div style={{ display:'flex', gap:8 }}>
                      <button
                        onClick={startTraining}
                        disabled={trainStatus?.status==='running' || !trainCheck?.dataset_found}
                        style={{ flex:1, background: trainStatus?.status==='running'||!trainCheck?.dataset_found?'rgba(255,255,255,.03)':'rgba(16,185,129,.15)', border:`1px solid ${trainStatus?.status==='running'||!trainCheck?.dataset_found?'rgba(255,255,255,.07)':'rgba(16,185,129,.3)'}`, borderRadius:8, padding:'10px 0', color:trainStatus?.status==='running'||!trainCheck?.dataset_found?'#475569':'#34d399', fontSize:11, cursor:trainStatus?.status==='running'||!trainCheck?.dataset_found?'not-allowed':'pointer', fontWeight:700 }}>
                        {trainStatus?.status==='running' ? '⏳ Training berjalan...' : '🚀 Mulai Training'}
                      </button>
                      {trainStatus?.status==='running' && (
                        <button onClick={stopTraining} style={{ background:'rgba(239,68,68,.1)', border:'1px solid rgba(239,68,68,.25)', borderRadius:8, padding:'10px 14px', color:'#f87171', fontSize:11, cursor:'pointer', fontWeight:700 }}>■ Stop</button>
                      )}
                    </div>
                    {!trainCheck?.dataset_found && (
                      <div style={{ marginTop:8, fontSize:9, color:'#64748b', lineHeight:1.6 }}>
                        Dataset belum ada. Upload ke GPU server: <code style={{ color:'#60a5fa' }}>~/jaktraffic/dataset_merged/</code>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

        </div> {/* end content */}
      </div> {/* end main */}

      {/* ══ MODAL ══════════════════════════════════════════════════ */}

      {showModal && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.75)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999 }}>
          <form onSubmit={handleSubmit} style={{ background:'#060f22', border:'1px solid rgba(245,158,11,.25)', borderRadius:14, padding:24, width:400, boxShadow:'0 20px 60px rgba(0,0,0,.7)' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
              <h3 style={{ fontSize:16, fontWeight:800, color:'#fbbf24' }}>{isEditing ? '✏ Edit Kamera' : '+ Tambah Kamera'}</h3>
              <button type="button" onClick={() => setShowModal(false)} style={{ background:'rgba(255,255,255,.07)', border:'1px solid rgba(255,255,255,.1)', borderRadius:7, padding:'4px 9px', color:'#64748b', cursor:'pointer', fontSize:12 }}>✕</button>
            </div>
            {[{k:'name',l:'Nama Lokasi',p:'contoh: Bundaran HI'},{k:'url',l:'URL Stream',p:'https://camera.../index.m3u8'},{k:'lat',l:'Latitude',p:'-6.1234'},{k:'lng',l:'Longitude',p:'106.8234'}].map(f => (
              <div key={f.k} style={{ marginBottom:12 }}>
                <div style={{ fontSize:9, fontWeight:700, color:'#64748b', letterSpacing:.8, marginBottom:4 }}>{f.l.toUpperCase()}</div>
                <input required placeholder={f.p} value={formData[f.k]} onChange={e => setFormData({...formData,[f.k]:e.target.value})}
                  style={{ width:'100%', background:'rgba(255,255,255,.06)', border:'1px solid rgba(255,255,255,.1)', borderRadius:8, padding:'9px 12px', color:'#e2e8f0', fontSize:12, outline:'none', boxSizing:'border-box' }} />
              </div>
            ))}
            <div style={{ display:'flex', gap:8, marginTop:20 }}>
              <button type="button" onClick={() => setShowModal(false)} style={{ flex:1, padding:'9px 0', background:'rgba(255,255,255,.06)', border:'1px solid rgba(255,255,255,.1)', borderRadius:9, color:'#64748b', fontSize:12, fontWeight:700, cursor:'pointer' }}>Batal</button>
              <button type="submit" style={{ flex:1, padding:'9px 0', background:'rgba(245,158,11,.2)', border:'1px solid rgba(245,158,11,.4)', borderRadius:9, color:'#fbbf24', fontSize:12, fontWeight:700, cursor:'pointer' }}>Simpan</button>
            </div>
          </form>
        </div>
      )}
    </div>

      <ChatPopup visible={showChat} onClose={() => setShowChat(false)} showEditMode />
      <ChatButton onOpen={() => setShowChat(true)} />
      <style>{`
        @keyframes bounce-dot{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
        @keyframes pulse-red{0%,100%{box-shadow:0 0 5px #f43f5e}50%{box-shadow:0 0 14px #f43f5e,0 0 24px rgba(244,63,94,.4)}}
      `}</style>
    </>
  );
}
