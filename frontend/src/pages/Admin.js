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
     🖥️ RENDER
  ====================================================== */
  return (
    <>
    <div className="flex h-screen bg-[#0f172a] text-slate-200 overflow-hidden">
      {/* ================= SIDEBAR ================= */}
      <aside className="w-80 border-r border-slate-800 p-4 flex flex-col">
        <div className="flex justify-between mb-6">
          <h2 className="text-xs uppercase text-slate-500 font-bold">
            Available Cameras
          </h2>
          <button onClick={openAddModal} className="bg-blue-600 p-1.5 rounded-lg">
            <Plus size={16} />
          </button>
        </div>

        <div className="space-y-3 flex-1 overflow-y-auto">
          {cctvList.map((cam) => (
            <div
              key={cam.id}
              onClick={() => setSelectedCam(cam)}
              className={`p-4 rounded-xl cursor-pointer border ${selectedCam?.id === cam.id
                  ? "bg-blue-600/10 border-blue-500"
                  : "bg-slate-800/40 border-slate-700"
                }`}
            >
              <h3 className="font-bold text-sm">{cam.name}</h3>
              <p className="text-xs text-slate-400">ID: {cam.id}</p>
            </div>
          ))}
        </div>

        <Link
          to="/"
          className="mt-4 text-xs text-center bg-slate-800 py-3 rounded-xl"
        >
          <MapIcon size={14} className="inline mr-1" />
          Back to Public Map
        </Link>
      </aside>

      {/* ================= MAIN ================= */}
      <main className="flex-1 p-8 overflow-y-auto">
        {/* HEADER */}
        <header className="flex justify-between mb-8">
          <div className="flex items-center gap-3">
            <Video size={26} className="text-blue-500" />
            <h1 className="text-2xl font-bold">
              {selectedCam?.name || "Select Camera"}
            </h1>
            {selectedCam && (
              <button
                onClick={openEditModal}
                className="p-1.5 bg-slate-800 rounded-lg"
              >
                <Pencil size={14} />
              </button>
            )}
          </div>

          <button
            onClick={() => setLiveMode((v) => !v)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg ${liveMode ? "bg-red-600" : "bg-slate-800"
              }`}
          >
            <Video size={16} />
            {liveMode ? "Stop Live" : "Live Monitor"}
          </button>
        </header>

        {/* STATS */}
        <section className="grid grid-cols-3 gap-6 mb-6">
          <StatCard
            title="Total Vehicles"
            value={selectedCam?.vehicles || 0}
            icon={<Activity />}
          />
          <StatCard
            title="Cars"
            value={Math.floor((selectedCam?.vehicles || 0) * 0.7)}
            icon={<Car />}
          />
          <StatCard
            title="Motorcycles"
            value={Math.floor((selectedCam?.vehicles || 0) * 0.3)}
            icon={<Bike />}
          />
        </section>

        {/* SIGNAL RECOMMENDATION CARD */}
        {selectedCam && (
          selectedCam.has_signal ? (() => {
            const rec = getSignalRec(selectedCam.vehicles);
            return (
              <section className={`mb-8 p-5 rounded-2xl border ${rec.bg} flex items-center gap-5`}>
                <TrafficLight active={rec.light} size={20} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] text-slate-500 uppercase font-bold">🚦 Rekomendasi Sinyal Adaptif</span>
                    <span className={`text-[10px] font-black px-2 py-0.5 rounded-full border ${rec.bg} ${rec.color}`}>
                      {rec.priority}
                    </span>
                  </div>
                  <p className={`text-lg font-bold ${rec.color}`}>{rec.label}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{rec.note}</p>
                </div>
                <div className="flex gap-4 text-center flex-shrink-0">
                  <div>
                    <p className="text-[9px] text-slate-500 uppercase mb-0.5">Hijau</p>
                    <p className="text-2xl font-black text-emerald-400">{rec.green}<span className="text-xs text-slate-500">s</span></p>
                  </div>
                  <div className="w-px bg-slate-700/50" />
                  <div>
                    <p className="text-[9px] text-slate-500 uppercase mb-0.5">Merah</p>
                    <p className="text-2xl font-black text-red-400">{rec.red}<span className="text-xs text-slate-500">s</span></p>
                  </div>
                </div>
              </section>
            );
          })() : (
            <section className="mb-8 p-5 rounded-2xl border border-slate-800 bg-slate-900/40 flex items-center gap-4">
              <span className="text-3xl">🛣️</span>
              <div>
                <p className="text-sm font-bold text-slate-400">Jalan Tol — Tidak Ada Lampu Merah</p>
                <p className="text-xs text-slate-500 mt-0.5">Rekomendasi sinyal adaptif tidak berlaku untuk ruas jalan tol.</p>
              </div>
            </section>
          )
        )}

        {/* CHART */}
        <section className="bg-[#1e293b]/40 border border-slate-800 p-8 rounded-3xl">
          <div className="flex justify-between mb-6">
            <h3 className="text-sm uppercase font-bold text-slate-400">
              Activity Trend
            </h3>
            <div className="flex gap-2">
              {["30m", "1h", "6h", "12h", "24h"].map((r) => (
                <button
                  key={r}
                  onClick={() => setTimeFilter(r)}
                  className={`px-3 py-1 rounded-md text-xs font-bold ${timeFilter === r ? "bg-blue-600" : "bg-slate-800"
                    }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <ResponsiveContainer width="100%" height={320}>
            <AreaChart data={historyData}>
              <CartesianGrid stroke="#1e293b" vertical={false} />
              <XAxis dataKey="label" stroke="#64748b" fontSize={11} />
              <YAxis stroke="#64748b" fontSize={11} />
              <Tooltip content={<TrafficTooltip />} />
              <Area
                type="natural"
                dataKey="avg_vehicle"
                stroke="#3b82f6"
                strokeWidth={3}
                fill="rgba(59,130,246,.3)"
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </section>

        {/* ANALYTICS SNAPSHOT */}
        {selectedCam && !liveMode && (
          <section className="mt-10 rounded-3xl overflow-hidden border border-slate-800">
            <div className="bg-slate-800/40 px-4 py-2 text-xs font-bold text-slate-400">
              ANALYTICS SNAPSHOT (YOLO)
            </div>

            <img
              src={`${API_BASE}/debug_views/${selectedCam.name.replace(/ /g, "_")}.jpg?t=${refreshKey}`}
              alt="YOLO Snapshot"
              className="w-full"
              onError={(e) => {
                e.currentTarget.src =
                  "https://via.placeholder.com/1280x720?text=Snapshot+Not+Available";
              }}
            />
          </section>
        )}

        {/* ======== YOLO 11 DETECTION ======== */}
        <section className="mt-10 rounded-3xl overflow-hidden border border-slate-800">
          <div className="bg-gradient-to-r from-yellow-900/40 to-orange-900/40 px-5 py-3 flex items-center gap-2">
            <Cpu size={18} className="text-yellow-400" />
            <span className="text-sm font-bold text-yellow-300">YOLO 11 — DETEKSI KENDARAAN</span>
            {selectedCam && (
              <span className="ml-auto text-[10px] text-slate-400">
                Kamera: <span className="text-yellow-400 font-bold">{selectedCam.name}</span>
              </span>
            )}
          </div>

          <div className="p-5 space-y-5">

            {/* Upload */}
            <div>
              <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">📁 Deteksi dari File (Gambar / Video)</p>
              <label
                className={`border-2 border-dashed rounded-xl p-6 flex flex-col items-center gap-2 cursor-pointer transition-colors ${
                  detectFile ? "border-yellow-600 bg-yellow-900/10" : "border-slate-700 hover:border-yellow-700"
                }`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const file = e.dataTransfer.files[0];
                  if (file) { setDetectFile(file); setDetectResult(null); setDetectError(""); }
                }}
              >
                <input
                  type="file"
                  className="hidden"
                  accept="image/*,video/mp4,video/avi,video/mov,video/mkv"
                  onChange={(e) => {
                    const file = e.target.files[0];
                    if (file) { setDetectFile(file); setDetectResult(null); setDetectError(""); }
                  }}
                />
                {detectFile ? (
                  <div className="text-center">
                    <p className="text-yellow-400 text-sm font-bold">{detectFile.name}</p>
                    <p className="text-slate-500 text-xs mt-1">{(detectFile.size / 1024 / 1024).toFixed(2)} MB</p>
                  </div>
                ) : (
                  <>
                    <span className="text-3xl">📸</span>
                    <span className="text-sm text-slate-400 font-medium">Drop gambar atau video di sini</span>
                    <span className="text-xs text-slate-500">JPG · PNG · MP4 · AVI · MOV</span>
                  </>
                )}
              </label>

              <button
                onClick={handleDetect}
                disabled={!detectFile || detecting}
                className={`w-full mt-2 py-3 rounded-xl text-sm font-bold transition-colors flex items-center justify-center gap-2 ${
                  !detectFile || detecting ? "bg-slate-700 text-slate-500 cursor-not-allowed" : "bg-yellow-600 hover:bg-yellow-500 text-white"
                }`}
              >
                {detecting
                  ? (<><span className="flex gap-1">{[0,1,2].map((i)=><span key={i} className="w-1.5 h-1.5 bg-yellow-300 rounded-full animate-bounce" style={{animationDelay:`${i*0.15}s`}}/>)}</span>Mendeteksi...</>)
                  : "⚡ Jalankan YOLO Deteksi"}
              </button>

              {detectError && <p className="mt-2 bg-red-900/30 border border-red-700 rounded-xl p-3 text-sm text-red-300">❌ {detectError}</p>}
              {detectResult && <div className="mt-3"><YoloResultCard result={detectResult} showTime /></div>}
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-slate-800" />
              <span className="text-[10px] text-slate-600 uppercase font-bold">atau</span>
              <div className="flex-1 h-px bg-slate-800" />
            </div>

            {/* Simulasi */}
            <div>
              <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">🎲 Mode Simulasi</p>
              <p className="text-[11px] text-slate-500 mb-3">
                Generate data kendaraan simulasi untuk kamera yang dipilih dan update peta secara langsung.
              </p>

              <button
                onClick={runSimulasi}
                disabled={simRunning || !selectedCam}
                className={`w-full py-3 rounded-xl text-sm font-bold transition-colors ${
                  simRunning || !selectedCam
                    ? "bg-slate-700 text-slate-500 cursor-not-allowed"
                    : "bg-blue-600 hover:bg-blue-500 text-white"
                }`}
              >
                {simRunning ? "Mensimulasikan..." : "🎲 Jalankan Simulasi"}
              </button>

              {simResult && (
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-2">
                  {[
                    { label: "Total", value: simResult.total, cls: "text-yellow-400" },
                    { label: "Mobil", value: simResult.car, cls: "text-blue-400" },
                    { label: "Motor", value: simResult.motorcycle, cls: "text-green-400" },
                    { label: "Bus", value: simResult.bus, cls: "text-purple-400" },
                    { label: "Truk", value: simResult.truck, cls: "text-red-400" },
                  ].map(({ label, value, cls }) => (
                    <div key={label} className="bg-slate-800/60 rounded-xl p-3 text-center">
                      <p className="text-[9px] text-slate-500 uppercase font-bold">{label}</p>
                      <p className={`text-2xl font-black ${cls}`}>{value}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        </section>

        {/* ======== SIGNAL OVERVIEW ======== */}
        <section className="mt-10 rounded-3xl overflow-hidden border border-slate-800">
          <div className="bg-gradient-to-r from-green-900/40 to-emerald-900/40 px-5 py-3 flex items-center gap-2">
            <TrafficCone size={18} className="text-emerald-400" />
            <span className="text-sm font-bold text-emerald-300">SINYAL ADAPTIF — SEMUA KAMERA</span>
            <span className="ml-auto text-[10px] text-slate-500">{cctvList.length} titik</span>
          </div>
          <div className="p-5">
            {/* Summary stats — hanya kamera dengan lampu merah */}
            {(() => {
              const sigCams = cctvList.filter(c => c.has_signal);
              const tolCams = cctvList.filter(c => !c.has_signal);
              const tinggi  = sigCams.filter(c => c.vehicles > 40).length;
              const normal  = sigCams.filter(c => c.vehicles > 20 && c.vehicles <= 40).length;
              const rendah  = sigCams.filter(c => c.vehicles <= 20).length;
              return (
                <>
                  <div className="grid grid-cols-3 gap-3 mb-3">
                    {[
                      { label: "Prioritas Tinggi", count: tinggi, color: "text-red-400",     bg: "bg-red-500/10 border-red-500/30",         icon: "🔴", desc: "> 40 kend — perpanjang hijau" },
                      { label: "Normal",            count: normal, color: "text-yellow-400",  bg: "bg-yellow-500/10 border-yellow-500/30",   icon: "🟡", desc: "20–40 kend — siklus standar" },
                      { label: "Prioritas Rendah",  count: rendah, color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/30", icon: "🟢", desc: "< 20 kend — kurangi hijau" },
                    ].map(s => (
                      <div key={s.label} className={`rounded-xl border p-4 text-center ${s.bg}`}>
                        <p className="text-2xl mb-0.5">{s.icon}</p>
                        <p className={`text-3xl font-black ${s.color}`}>{s.count}</p>
                        <p className={`text-[10px] font-bold ${s.color}`}>{s.label}</p>
                        <p className="text-[9px] text-slate-500 mt-0.5">{s.desc}</p>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-600 mb-4">
                    📊 {sigCams.length} titik dengan lampu merah · {tolCams.length} titik jalan tol (dikecualikan)
                  </p>
                </>
              );
            })()}

            {/* Table: kamera dengan lampu merah, diurutkan kepadatan */}
            <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Persimpangan — Butuh Perhatian Sinyal</p>
            <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
              {[...cctvList]
                .filter(c => c.has_signal)
                .sort((a, b) => b.vehicles - a.vehicles)
                .slice(0, 10)
                .map(cam => {
                  const rec = getSignalRec(cam.vehicles);
                  return (
                    <div
                      key={cam.id}
                      onClick={() => setSelectedCam(cam)}
                      className="flex items-center gap-3 bg-slate-800/60 hover:bg-slate-700/60 rounded-xl px-3 py-2.5 cursor-pointer transition-colors"
                    >
                      <TrafficLight active={rec.light} size={12} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold truncate">{cam.name}</p>
                        <p className={`text-[10px] ${rec.color}`}>{rec.label}</p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-sm font-black text-white">{cam.vehicles}</p>
                        <p className="text-[9px] text-slate-500">kendaraan</p>
                      </div>
                      <div className="flex gap-1.5 text-[10px] flex-shrink-0">
                        <span className="bg-emerald-900/50 text-emerald-400 rounded px-1.5 py-0.5 font-bold">🟢{rec.green}s</span>
                        <span className="bg-red-900/50 text-red-400 rounded px-1.5 py-0.5 font-bold">🔴{rec.red}s</span>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </section>

        {/* ======== TRANSFORMER MODEL INFO ======== */}
        <section className="mt-10 rounded-3xl overflow-hidden border border-slate-800">
          <div className="bg-gradient-to-r from-purple-900/40 to-blue-900/40 px-5 py-3 flex items-center gap-2">
            <Brain size={18} className="text-purple-400" />
            <span className="text-sm font-bold text-purple-300">TRANSFORMER MODEL</span>
            {modelInfo?.model_loaded ? (
              <span className="ml-auto flex items-center gap-1 text-[10px] text-emerald-400 font-bold">
                <CheckCircle size={12} /> LOADED
              </span>
            ) : (
              <span className="ml-auto flex items-center gap-1 text-[10px] text-red-400 font-bold">
                <XCircle size={12} /> NOT LOADED
              </span>
            )}
          </div>

          {modelInfo ? (
            <div className="p-5 space-y-4">
              {/* Architecture */}
              <div>
                <p className="text-[10px] uppercase text-slate-500 font-bold mb-2 flex items-center gap-1">
                  <Cpu size={10} /> Arsitektur
                </p>
                <div className="grid grid-cols-4 gap-2">
                  {modelInfo.architecture && Object.entries(modelInfo.architecture).map(([k, v]) => (
                    <div key={k} className="bg-slate-800/60 rounded-lg p-2">
                      <p className="text-[9px] text-slate-500 uppercase">{k.replace(/_/g, ' ')}</p>
                      <p className="text-sm font-bold text-slate-200">{v}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Training Stats */}
              <div>
                <p className="text-[10px] uppercase text-slate-500 font-bold mb-2 flex items-center gap-1">
                  <Zap size={10} /> Training Stats
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {modelInfo.training && Object.entries(modelInfo.training).map(([k, v]) => (
                    <div key={k} className="bg-slate-800/60 rounded-lg p-2">
                      <p className="text-[9px] text-slate-500 uppercase">{k.replace(/_/g, ' ')}</p>
                      <p className="text-sm font-bold text-slate-200">{v}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Parameters */}
              {modelInfo.parameters && (
                <div>
                  <p className="text-[10px] uppercase text-slate-500 font-bold mb-2 flex items-center gap-1">
                    <Database size={10} /> Parameters
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="bg-slate-800/60 rounded-lg p-2">
                      <p className="text-[9px] text-slate-500">TOTAL</p>
                      <p className="text-sm font-bold text-blue-400">{modelInfo.parameters.total?.toLocaleString()}</p>
                    </div>
                    <div className="bg-slate-800/60 rounded-lg p-2">
                      <p className="text-[9px] text-slate-500">TRAINABLE</p>
                      <p className="text-sm font-bold text-purple-400">{modelInfo.parameters.trainable?.toLocaleString()}</p>
                    </div>
                    <div className="bg-slate-800/60 rounded-lg p-2">
                      <p className="text-[9px] text-slate-500">FILE SIZE</p>
                      <p className="text-sm font-bold text-slate-200">{modelInfo.file_size_kb} KB</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Live Prediction Test */}
              {modelInfo.test_predictions?.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase text-slate-500 font-bold mb-2 flex items-center gap-1">
                    <Activity size={10} /> Live Prediction Test
                  </p>
                  <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
                    {modelInfo.test_predictions.map((t, i) => (
                      <div key={i} className="bg-slate-800/60 rounded-lg p-2 flex items-center justify-between">
                        <span className="text-xs font-bold">{t.name}</span>
                        <div className="flex items-center gap-3 text-xs">
                          <span className="text-slate-400">Now: <b className="text-white">{t.current}</b></span>
                          <span className="text-blue-400">15m: <b>{t.pred_15}</b></span>
                          <span className="text-purple-400">30m: <b>{t.pred_30}</b></span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="p-5 text-center text-slate-500 text-sm">Loading model info...</div>
          )}
        </section>

      </main>

      {/* ================= MODAL ================= */}
      {showModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <form
            onSubmit={handleSubmit}
            className="bg-slate-900 p-6 rounded-2xl w-96 space-y-4"
          >
            <h3 className="font-bold text-lg">
              {isEditing ? "Edit Camera" : "Add Camera"}
            </h3>

            {["name", "url", "lat", "lng"].map((f) => (
              <input
                key={f}
                required
                placeholder={f}
                value={formData[f]}
                onChange={(e) =>
                  setFormData({ ...formData, [f]: e.target.value })
                }
                className="w-full bg-slate-800 p-2 rounded-lg"
              />
            ))}

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="flex-1 bg-slate-800 p-2 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 bg-blue-600 p-2 rounded-lg"
              >
                Save
              </button>
            </div>
          </form>
        </div>
      )}
    </div>

      {/* ================= CHAT AI ================= */}
      <ChatPopup visible={showChat} onClose={() => setShowChat(false)} />
      <ChatButton onOpen={() => setShowChat(true)} />
    </>
  );
}
