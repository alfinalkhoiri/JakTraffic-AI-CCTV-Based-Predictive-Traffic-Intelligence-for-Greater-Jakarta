import React, { useState, useEffect } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import ChatPopup from "../components/ChatPopup";
import ChatButton from "../components/ChatButton";

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
   🚀 MAIN ADMIN
====================================================== */
export default function Admin() {
  /* ---------- STATE ---------- */
  const [cctvList, setCctvList] = useState([]);
  const [selectedCam, setSelectedCam] = useState(null);

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

      if (!selectedCam && res.data.length) {
        setSelectedCam(res.data[0]);
      } else if (selectedCam) {
        const updated = res.data.find((c) => c.id === selectedCam.id);
        if (updated) setSelectedCam(updated);
      }
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

  const [activeTab, setActiveTab] = React.useState('monitor');
  const tabStyle = (t) => ({ padding:'8px 16px', fontSize:11, fontWeight:activeTab===t?700:500, color:activeTab===t?'#f59e0b':'#64748b', background:activeTab===t?'rgba(245,158,11,.1)':'transparent', border:'none', borderBottom:activeTab===t?'2px solid #f59e0b':'2px solid transparent', cursor:'pointer', transition:'all .15s', whiteSpace:'nowrap' });

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
        </div>

        {/* Navigation */}
        <nav style={A.sideNav}>
          {[
            { id:'monitor', icon:'📡', label:'Monitoring', desc:'Status real-time' },
            { id:'analitik', icon:'📊', label:'Analitik', desc:'Tren & histori' },
            { id:'sinyal', icon:'🚦', label:'Sinyal Adaptif', desc:'Rekomendasi' },
            { id:'ai', icon:'🤖', label:'AI Deteksi', desc:'YOLO & model' },
            { id:'manajemen', icon:'🗄️', label:'Manajemen', desc:'Data kamera' },
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
          <Link to="/" style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', borderRadius:8, fontSize:11, color:'#64748b', textDecoration:'none', fontWeight:600 }}>
            <MapIcon size={14} /> Kembali ke Peta
          </Link>
          <button onClick={() => setShowChat(v => !v)} style={{ width:'100%', display:'flex', alignItems:'center', gap:8, padding:'8px 10px', borderRadius:8, fontSize:11, color:showChat?'#f59e0b':'#64748b', background:showChat?'rgba(245,158,11,.1)':'transparent', border:'none', cursor:'pointer', fontWeight:600, marginTop:2 }}>
            🤖 <span>AI Assistant</span>
          </button>
        </div>
      </aside>

      {/* ══ MAIN AREA ══════════════════════════════════════════════ */}
      <div style={A.main}>

        {/* ── TOP BAR ── */}
        <header style={A.topbar}>
          <div style={{ fontSize:14, fontWeight:800, color:'#fbbf24' }}>{['monitor','analitik','sinyal','ai','manajemen'].indexOf(activeTab)>=0&&[{id:'monitor',title:'Monitoring Real-time'},{id:'analitik',title:'Analitik Lalu Lintas'},{id:'sinyal',title:'Sinyal Adaptif'},{id:'ai',title:'AI Deteksi YOLO 11'},{id:'manajemen',title:'Manajemen Kamera'}].find(t=>t.id===activeTab)?.title}</div>

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

        {/* ── TABS NAV ── */}
        <div style={{ display:'flex', borderBottom:'1px solid rgba(255,255,255,.07)', padding:'0 20px', background:'#04091a', flexShrink:0, overflowX:'auto' }}>
          {[
            {id:'monitor',label:'📡 Monitoring'},
            {id:'analitik',label:'📊 Analitik'},
            {id:'sinyal',label:'🚦 Sinyal'},
            {id:'ai',label:'🤖 AI Deteksi'},
            {id:'manajemen',label:'🗄️ Manajemen'},
          ].map(t => <button key={t.id} style={tabStyle(t.id)} onClick={() => setActiveTab(t.id)}>{t.label}</button>)}
        </div>

        {/* ── CONTENT ── */}
        <div style={A.content}>

          {/* ════════════ TAB: MONITORING ════════════ */}
          {activeTab === 'monitor' && (
            <>
              {/* Stat row */}
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:20 }}>
                {[
                  { label:'Total Kamera', value:cctvList.length, icon:'📹', c:'#60a5fa' },
                  { label:'Online / Siaran',  value:`${onlineCams}/${cctvList.length}`, icon:'📡', c:'#10b981' },
                  { label:'Lokasi Padat', value:padatCount, icon:'🔴', c:'#f43f5e' },
                  { label:'Rata-rata Kend.', value:avgVehicles, icon:'🚗', c:'#f59e0b' },
                ].map(s => (
                  <div key={s.label} style={A.statCard}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                      <div>
                        <div style={A.label}>{s.label}</div>
                        <div style={{ ...A.big, color:s.c }}>{s.value}</div>
                      </div>
                      <span style={{ fontSize:20, opacity:.4 }}>{s.icon}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Two-column: cam list + detail */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1.4fr', gap:16 }}>

                {/* Camera list */}
                <div style={A.card}>
                  <div style={A.cardHdr()}>
                    <span style={{ fontSize:13 }}>📹</span>
                    <span style={{ fontSize:12, fontWeight:700, color:'#fbbf24' }}>Daftar Kamera</span>
                    <span style={{ marginLeft:'auto', fontSize:10, color:'#64748b' }}>{cctvList.length} titik terpantau</span>
                    <button onClick={openAddModal} style={{ ...A.btn(), fontSize:10, padding:'3px 8px' }}>+ Tambah</button>
                  </div>
                  <div style={{ maxHeight:'calc(100vh - 310px)', overflowY:'auto' }}>
                    {/* Sort: padat first */}
                    {[...cctvList].sort((a,b)=>(b.vehicles||0)-(a.vehicles||0)).map((cam, i) => {
                      const v = cam.vehicles||0;
                      const color = v > 40 ? '#f43f5e' : v > 20 ? '#f59e0b' : '#10b981';
                      const label = v > 40 ? 'PADAT' : v > 20 ? 'RAMAI' : 'LANCAR';
                      const isActive = selectedCam?.id === cam.id;
                      return (
                        <div key={cam.id} onClick={() => setSelectedCam(cam)}
                          style={{ ...A.tableRow(i%2===0), background:isActive?'rgba(245,158,11,.08)':i%2===0?'rgba(255,255,255,.02)':'transparent', borderLeft:isActive?'3px solid #f59e0b':'3px solid transparent' }}>
                          <span style={{ width:8, height:8, borderRadius:'50%', background:color, boxShadow:`0 0 5px ${color}`, flexShrink:0 }} />
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:11, fontWeight:isActive?700:500, color:isActive?'#fbbf24':'#e2e8f0', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{cam.name}</div>
                            <div style={{ fontSize:9, color:'#475569' }}>ID {cam.id} · {cam.road_type==='toll'?'Tol':'Kota'}</div>
                          </div>
                          <div style={{ textAlign:'right', flexShrink:0 }}>
                            <div style={{ fontSize:14, fontWeight:900, color, fontVariantNumeric:'tabular-nums' }}>{v}</div>
                            <div style={{ fontSize:8, color, fontWeight:700 }}>{label}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Detail panel */}
                {selectedCam ? (
                  <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
                    {/* Header */}
                    <div style={A.card}>
                      <div style={A.cardHdr()}>
                        <span style={{ fontSize:12, fontWeight:700, color:'#fbbf24' }}>{selectedCam.name}</span>
                        <button onClick={openEditModal} style={{ marginLeft:'auto', ...A.btn(), fontSize:10, padding:'3px 8px' }}>✏ Edit</button>
                      </div>
                      <div style={{ padding:'14px 16px' }}>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10, marginBottom:12 }}>
                          {[
                            { label:'Kendaraan', value:selectedCam.vehicles||0, c:'#fbbf24' },
                            { label:'Mobil (est.)', value:Math.floor((selectedCam.vehicles||0)*.65), c:'#60a5fa' },
                            { label:'Motor (est.)', value:Math.floor((selectedCam.vehicles||0)*.35), c:'#a78bfa' },
                          ].map(s => (
                            <div key={s.label} style={{ background:'rgba(255,255,255,.04)', borderRadius:8, padding:'10px 12px' }}>
                              <div style={{ fontSize:8, color:'#475569', fontWeight:700, letterSpacing:.6, marginBottom:2 }}>{s.label.toUpperCase()}</div>
                              <div style={{ fontSize:22, fontWeight:900, color:s.c, fontVariantNumeric:'tabular-nums' }}>{s.value}</div>
                            </div>
                          ))}
                        </div>

                        {/* Status & Signal */}
                        {selectedCam.has_signal ? (() => {
                          const rec = getSignalRec(selectedCam.vehicles);
                          return (
                            <div style={{ background:'rgba(255,255,255,.04)', borderRadius:8, padding:'12px', display:'flex', alignItems:'center', gap:12 }}>
                              <TrafficLight active={rec.light} size={16} />
                              <div style={{ flex:1 }}>
                                <div style={{ fontSize:11, fontWeight:800, color:rec.dot, marginBottom:2 }}>{rec.label}</div>
                                <div style={{ fontSize:10, color:'#64748b', marginBottom:6 }}>{rec.note}</div>
                                <div style={{ display:'flex', gap:8 }}>
                                  <span style={{ ...A.badge('#22c55e','rgba(34,197,94,.1)') }}>🟢 Hijau {rec.green}s</span>
                                  <span style={{ ...A.badge('#ef4444','rgba(239,68,68,.1)') }}>🔴 Merah {rec.red}s</span>
                                  <span style={{ ...A.badge(rec.dot,'rgba(0,0,0,.2)'), marginLeft:'auto' }}>{rec.priority}</span>
                                </div>
                              </div>
                            </div>
                          );
                        })() : (
                          <div style={{ background:'rgba(255,255,255,.04)', borderRadius:8, padding:'10px 12px', display:'flex', alignItems:'center', gap:8 }}>
                            <span style={{ fontSize:18 }}>🛣️</span>
                            <div>
                              <div style={{ fontSize:11, fontWeight:700, color:'#64748b' }}>Jalan Tol</div>
                              <div style={{ fontSize:10, color:'#475569' }}>Rekomendasi sinyal tidak berlaku</div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Chart */}
                    <div style={A.card}>
                      <div style={A.cardHdr('#60a5fa')}>
                        <span style={{ fontSize:12, fontWeight:700, color:'#93c5fd' }}>📊 Tren Aktivitas</span>
                        <div style={{ marginLeft:'auto', display:'flex', gap:4 }}>
                          {['30m','1h','6h','12h','24h'].map(r => (
                            <button key={r} onClick={() => setTimeFilter(r)} style={{ padding:'3px 7px', borderRadius:5, fontSize:9, fontWeight:700, background:timeFilter===r?'#3b82f6':'rgba(255,255,255,.07)', color:timeFilter===r?'#fff':'#64748b', border:'none', cursor:'pointer' }}>{r}</button>
                          ))}
                        </div>
                      </div>
                      <div style={{ padding:'14px 16px' }}>
                        <ResponsiveContainer width="100%" height={180}>
                          <AreaChart data={historyData}>
                            <CartesianGrid stroke="rgba(255,255,255,.05)" vertical={false} />
                            <XAxis dataKey="label" stroke="#475569" fontSize={9} />
                            <YAxis stroke="#475569" fontSize={9} />
                            <Tooltip content={<TrafficTooltip />} />
                            <Area type="natural" dataKey="avg_vehicle" stroke="#3b82f6" strokeWidth={2.5} fill="rgba(59,130,246,.2)" dot={false} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ ...A.card, display:'flex', alignItems:'center', justifyContent:'center', color:'#475569', fontSize:13 }}>
                    ← Pilih kamera untuk melihat detail
                  </div>
                )}
              </div>
            </>
          )}

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

          {/* ════════════ TAB: SINYAL ADAPTIF ════════════ */}
          {activeTab === 'sinyal' && (
            <>
              {/* Summary */}
              {(() => {
                const sigCams = cctvList.filter(c=>c.has_signal);
                const tinggi = sigCams.filter(c=>(c.vehicles||0)>40).length;
                const normal = sigCams.filter(c=>(c.vehicles||0)>20&&(c.vehicles||0)<=40).length;
                const rendah = sigCams.filter(c=>(c.vehicles||0)<=20).length;
                return (
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12, marginBottom:16 }}>
                    {[
                      { label:'Prioritas Tinggi', count:tinggi, c:'#f43f5e', bg:'rgba(244,63,94,.1)', bd:'rgba(244,63,94,.2)', icon:'🔴', desc:'> 40 kend — perpanjang hijau' },
                      { label:'Siklus Normal',    count:normal, c:'#f59e0b', bg:'rgba(245,158,11,.1)', bd:'rgba(245,158,11,.2)', icon:'🟡', desc:'20–40 kend — pertahankan' },
                      { label:'Prioritas Rendah', count:rendah, c:'#10b981', bg:'rgba(16,185,129,.1)', bd:'rgba(16,185,129,.2)', icon:'🟢', desc:'< 20 kend — kurangi hijau' },
                    ].map(s => (
                      <div key={s.label} style={{ ...A.statCard, borderColor:s.bd, background:s.bg }}>
                        <div style={{ fontSize:24, marginBottom:4 }}>{s.icon}</div>
                        <div style={{ fontSize:32, fontWeight:900, color:s.c, fontVariantNumeric:'tabular-nums', lineHeight:1 }}>{s.count}</div>
                        <div style={{ fontSize:11, fontWeight:700, color:s.c, marginTop:2 }}>{s.label}</div>
                        <div style={{ fontSize:9, color:'#475569', marginTop:3 }}>{s.desc}</div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Signal table */}
              <div style={A.card}>
                <div style={A.cardHdr('#10b981')}>
                  <span style={{ fontSize:12, fontWeight:700, color:'#6ee7b7' }}>🚦 Rekomendasi Sinyal — Semua Persimpangan</span>
                  <span style={{ marginLeft:'auto', fontSize:10, color:'#475569' }}>{cctvList.filter(c=>c.has_signal).length} titik dengan lampu merah</span>
                </div>

                {/* Table header */}
                <div style={{ display:'flex', padding:'6px 14px', borderBottom:'1px solid rgba(255,255,255,.08)', background:'rgba(255,255,255,.03)' }}>
                  {['Lokasi','Status','Kendaraan','Rekomendasi','Fase Hijau','Fase Merah','Prioritas'].map(h => (
                    <div key={h} style={{ fontSize:8, fontWeight:700, color:'#475569', letterSpacing:.7, flex:h==='Lokasi'?2:1, textAlign:h==='Lokasi'?'left':'center' }}>{h.toUpperCase()}</div>
                  ))}
                </div>

                <div style={{ maxHeight:'calc(100vh - 360px)', overflowY:'auto' }}>
                  {[...cctvList].filter(c=>c.has_signal).sort((a,b)=>(b.vehicles||0)-(a.vehicles||0)).map((cam,i) => {
                    const rec = getSignalRec(cam.vehicles);
                    const v   = cam.vehicles||0;
                    const color = v>40?'#f43f5e':v>20?'#f59e0b':'#10b981';
                    return (
                      <div key={cam.id} onClick={() => { setSelectedCam(cam); setActiveTab('monitor'); }} style={{ display:'flex', alignItems:'center', padding:'8px 14px', borderBottom:'1px solid rgba(255,255,255,.04)', background:i%2===0?'rgba(255,255,255,.02)':'transparent', cursor:'pointer' }}>
                        <div style={{ flex:2, display:'flex', alignItems:'center', gap:8 }}>
                          <div style={{ width:7, height:7, borderRadius:'50%', background:color, boxShadow:`0 0 5px ${color}`, flexShrink:0 }} />
                          <span style={{ fontSize:11, fontWeight:600 }}>{cam.name}</span>
                        </div>
                        <div style={{ flex:1, textAlign:'center', fontSize:9, fontWeight:700, color }}>
                          {v>40?'PADAT':v>20?'RAMAI':'LANCAR'}
                        </div>
                        <div style={{ flex:1, textAlign:'center', fontSize:13, fontWeight:900, color, fontVariantNumeric:'tabular-nums' }}>{v}</div>
                        <div style={{ flex:1, textAlign:'center', fontSize:10, fontWeight:700, color:rec.dot }}>{rec.label}</div>
                        <div style={{ flex:1, textAlign:'center', fontSize:12, fontWeight:900, color:'#22c55e', fontVariantNumeric:'tabular-nums' }}>{rec.green}s</div>
                        <div style={{ flex:1, textAlign:'center', fontSize:12, fontWeight:900, color:'#ef4444', fontVariantNumeric:'tabular-nums' }}>{rec.red}s</div>
                        <div style={{ flex:1, textAlign:'center' }}>
                          <span style={A.badge(rec.dot, rec.dot==='#ef4444'?'rgba(239,68,68,.1)':rec.dot==='#f59e0b'?'rgba(245,158,11,.1)':'rgba(34,197,94,.1)')}>{rec.priority}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

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

          {/* ════════════ TAB: MANAJEMEN ════════════ */}
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
      <style>{`@keyframes bounce-dot{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}`}</style>
    </>
  );
}
