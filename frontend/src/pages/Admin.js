import React, { useState, useEffect, useRef, useCallback } from "react";
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
  LayoutDashboard,
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
} from "lucide-react";

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

  // YOLO section tab: 'upload' | 'webcam' | 'stream'
  const [yoloTab, setYoloTab] = useState("upload");

  // Upload tab
  const [detectFile, setDetectFile] = useState(null);
  const [detectResult, setDetectResult] = useState(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState("");

  // Webcam tab
  const [webcamRunning, setWebcamRunning] = useState(false);
  const [webcamResult, setWebcamResult] = useState(null);
  const [webcamError, setWebcamError] = useState("");
  const videoRef        = useRef(null);
  const canvasRef       = useRef(null);
  const captureInterval = useRef(null);
  const webcamStream    = useRef(null);

  // Stream URL tab
  const [streamUrl, setStreamUrl]         = useState("");
  const [ytInput, setYtInput]             = useState("");
  const [extracting, setExtracting]       = useState(false);
  const [streamRunning, setStreamRunning] = useState(false);
  const [streamResult, setStreamResult]   = useState(null);
  const [streamError, setStreamError]     = useState("");
  const streamSse = useRef(null);

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

  /* ---------- WEBCAM HANDLERS ---------- */
  const startWebcam = useCallback(async () => {
    setWebcamError("");
    setWebcamResult(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      webcamStream.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setWebcamRunning(true);

      captureInterval.current = setInterval(async () => {
        if (!videoRef.current || !canvasRef.current) return;
        const canvas = canvasRef.current;
        canvas.width  = videoRef.current.videoWidth  || 640;
        canvas.height = videoRef.current.videoHeight || 480;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(async (blob) => {
          if (!blob) return;
          const form = new FormData();
          form.append("frame", blob, "frame.jpg");
          if (selectedCam?.id) form.append("camera_id", selectedCam.id);
          try {
            const res = await axios.post(`${API_BASE}/api/detect-frame`, form, {
              headers: { "Content-Type": "multipart/form-data" },
              timeout: 10000,
            });
            setWebcamResult(res.data);
          } catch (e) {
            setWebcamError(e?.response?.data?.error || e.message);
          }
        }, "image/jpeg", 0.85);
      }, 1000);
    } catch (e) {
      setWebcamError(e.message || "Kamera tidak bisa diakses");
    }
  }, [selectedCam]);

  const stopWebcam = useCallback(() => {
    clearInterval(captureInterval.current);
    captureInterval.current = null;
    if (webcamStream.current) {
      webcamStream.current.getTracks().forEach((t) => t.stop());
      webcamStream.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setWebcamRunning(false);
  }, []);

  /* ---------- YOUTUBE EXTRACTOR ---------- */
  const extractYouTube = useCallback(async () => {
    if (!ytInput.trim()) return;
    setExtracting(true);
    setStreamError("");
    try {
      const res = await axios.post(`${API_BASE}/api/youtube-url`, { url: ytInput.trim() });
      setStreamUrl(res.data.url);
    } catch (e) {
      setStreamError(e?.response?.data?.error || "Gagal ekstrak URL dari YouTube");
    } finally {
      setExtracting(false);
    }
  }, [ytInput]);

  /* ---------- STREAM URL HANDLERS ---------- */
  const startStream = useCallback(() => {
    if (!streamUrl.trim()) return;
    setStreamError("");
    setStreamResult(null);

    const camParam = selectedCam?.id ? `&camera_id=${selectedCam.id}` : "";
    const url = `${API_BASE}/api/live-detect?url=${encodeURIComponent(streamUrl)}${camParam}`;
    const es = new EventSource(url);

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.error) { setStreamError(data.error); es.close(); setStreamRunning(false); }
        else setStreamResult(data);
      } catch { /* ignore */ }
    };
    es.onerror = () => { setStreamError("Koneksi SSE terputus"); es.close(); setStreamRunning(false); };
    streamSse.current = es;
    setStreamRunning(true);
  }, [streamUrl, selectedCam]);

  const stopStream = useCallback(() => {
    if (streamSse.current) { streamSse.current.close(); streamSse.current = null; }
    setStreamRunning(false);
  }, []);

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
        <section className="grid grid-cols-3 gap-6 mb-10">
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

        {/* ======== YOLO 11 DETECTION (tabbed) ======== */}
        <section className="mt-10 rounded-3xl overflow-hidden border border-slate-800">
          {/* Header */}
          <div className="bg-gradient-to-r from-yellow-900/40 to-orange-900/40 px-5 py-3 flex items-center gap-2">
            <Cpu size={18} className="text-yellow-400" />
            <span className="text-sm font-bold text-yellow-300">YOLO 11 — DETEKSI KENDARAAN</span>
            {selectedCam && (
              <span className="ml-auto text-[10px] text-slate-400">
                Update ke: <span className="text-yellow-400 font-bold">{selectedCam.name}</span>
              </span>
            )}
          </div>

          {/* Tabs */}
          <div className="flex border-b border-slate-800 bg-slate-900/40">
            {[
              { id: "upload", label: "📁 Upload" },
              { id: "webcam", label: "📷 Webcam Live" },
              { id: "stream", label: "📡 Stream URL" },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setYoloTab(t.id);
                  if (webcamRunning) stopWebcam();
                  if (streamRunning) stopStream();
                }}
                className={`px-5 py-2.5 text-xs font-bold transition-colors border-b-2 ${
                  yoloTab === t.id
                    ? "border-yellow-500 text-yellow-400"
                    : "border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="p-5 space-y-3">

            {/* ── TAB: UPLOAD ────────────────────────────────────── */}
            {yoloTab === "upload" && (
              <>
                <label
                  className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center gap-2 cursor-pointer transition-colors ${
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
                      <span className="text-4xl">📸</span>
                      <span className="text-sm text-slate-400 font-medium">Drop gambar atau video di sini</span>
                      <span className="text-xs text-slate-500">JPG · PNG · MP4 · AVI · MOV</span>
                    </>
                  )}
                </label>

                <button
                  onClick={handleDetect}
                  disabled={!detectFile || detecting}
                  className={`w-full py-3 rounded-xl text-sm font-bold transition-colors flex items-center justify-center gap-2 ${
                    !detectFile || detecting ? "bg-slate-700 text-slate-500 cursor-not-allowed" : "bg-yellow-600 hover:bg-yellow-500 text-white"
                  }`}
                >
                  {detecting ? (<><span className="flex gap-1">{[0,1,2].map((i)=><span key={i} className="w-1.5 h-1.5 bg-yellow-300 rounded-full animate-bounce" style={{animationDelay:`${i*0.15}s`}}/>)}</span>Mendeteksi...</>) : "⚡ Jalankan YOLO Deteksi"}
                </button>

                {detectError && <p className="bg-red-900/30 border border-red-700 rounded-xl p-3 text-sm text-red-300">❌ {detectError}</p>}
                {detectResult && <YoloResultCard result={detectResult} showTime />}
              </>
            )}

            {/* ── TAB: WEBCAM ────────────────────────────────────── */}
            {yoloTab === "webcam" && (
              <>
                <p className="text-xs text-slate-400">
                  Browser menangkap frame dari webcam setiap 1 detik → YOLO hitung kendaraan di VPS
                  {selectedCam ? ` → update jumlah kendaraan di <b>${selectedCam.name}</b> pada peta.` : "."}
                </p>

                {/* Hidden canvas for capture */}
                <canvas ref={canvasRef} className="hidden" />

                {/* Video preview */}
                <div className="relative rounded-xl overflow-hidden bg-black border border-slate-700" style={{ minHeight: 200 }}>
                  <video
                    ref={videoRef}
                    muted
                    playsInline
                    className={`w-full rounded-xl transition-opacity duration-300 ${webcamRunning ? "opacity-100" : "opacity-0 absolute"}`}
                  />
                  {!webcamRunning && (
                    <div className="flex flex-col items-center justify-center py-12 text-slate-500 gap-2">
                      <span className="text-4xl">📷</span>
                      <span className="text-sm">Webcam belum aktif</span>
                    </div>
                  )}
                  {/* Live count overlay */}
                  {webcamRunning && webcamResult && (
                    <div className="absolute top-2 left-2 bg-black/70 rounded-lg px-3 py-1.5 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                      <span className="text-white text-sm font-black">{webcamResult.vehicle_count}</span>
                      <span className="text-slate-400 text-xs">kendaraan</span>
                    </div>
                  )}
                </div>

                <button
                  onClick={webcamRunning ? stopWebcam : startWebcam}
                  className={`w-full py-3 rounded-xl text-sm font-bold transition-colors ${
                    webcamRunning ? "bg-red-600 hover:bg-red-500 text-white" : "bg-yellow-600 hover:bg-yellow-500 text-white"
                  }`}
                >
                  {webcamRunning ? "⏹ Stop Webcam" : "▶ Mulai Webcam Live Detection"}
                </button>

                {webcamError && <p className="bg-red-900/30 border border-red-700 rounded-xl p-3 text-sm text-red-300">❌ {webcamError}</p>}
                {webcamResult && <YoloResultCard result={webcamResult} live />}
              </>
            )}

            {/* ── TAB: STREAM URL ─────────────────────────────────── */}
            {yoloTab === "stream" && (
              <>
                {/* YouTube extractor */}
                <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 space-y-2">
                  <p className="text-[10px] text-yellow-400 font-bold uppercase">📺 Ekstrak dari YouTube Live</p>
                  <p className="text-[10px] text-slate-500">Paste URL YouTube (live stream) → otomatis ekstrak URL video untuk YOLO</p>

                  {/* Known streams */}
                  <div className="flex flex-wrap gap-1 mb-1">
                    {[
                      { label: "Bundaran HI", url: "https://www.youtube.com/live/xC8WIFbE1MU" },
                    ].map((s) => (
                      <button
                        key={s.url}
                        onClick={() => setYtInput(s.url)}
                        className="text-[10px] bg-slate-700 hover:bg-yellow-900/50 border border-slate-600 hover:border-yellow-700 text-slate-300 px-2 py-0.5 rounded-full transition-colors"
                      >
                        {s.label}
                      </button>
                    ))}
                    <span className="text-[10px] text-slate-600 self-center">atau paste URL sendiri →</span>
                  </div>

                  <div className="flex gap-2">
                    <input
                      value={ytInput}
                      onChange={(e) => setYtInput(e.target.value)}
                      placeholder="https://www.youtube.com/live/..."
                      className="flex-1 bg-slate-900 border border-slate-600 px-3 py-2 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-yellow-600"
                    />
                    <button
                      onClick={extractYouTube}
                      disabled={!ytInput.trim() || extracting}
                      className={`px-3 py-2 rounded-lg text-xs font-bold transition-colors whitespace-nowrap ${
                        extracting || !ytInput.trim() ? "bg-slate-700 text-slate-500" : "bg-yellow-600 hover:bg-yellow-500 text-white"
                      }`}
                    >
                      {extracting ? "..." : "Ekstrak URL"}
                    </button>
                  </div>
                </div>

                {/* Direct stream URL */}
                <div>
                  <p className="text-[10px] text-slate-500 mb-1 uppercase font-bold">Atau masukkan URL langsung (HLS/RTSP/MP4)</p>
                  <input
                    value={streamUrl}
                    onChange={(e) => setStreamUrl(e.target.value)}
                    disabled={streamRunning}
                    placeholder="https://example.com/stream.m3u8  atau  rtsp://..."
                    className="w-full bg-slate-800 border border-slate-700 px-3 py-2.5 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-yellow-600 disabled:opacity-50"
                  />
                </div>

                <button
                  onClick={streamRunning ? stopStream : startStream}
                  disabled={!streamUrl.trim() && !streamRunning}
                  className={`w-full py-3 rounded-xl text-sm font-bold transition-colors flex items-center justify-center gap-2 ${
                    streamRunning
                      ? "bg-red-600 hover:bg-red-500 text-white"
                      : !streamUrl.trim()
                        ? "bg-slate-700 text-slate-500 cursor-not-allowed"
                        : "bg-yellow-600 hover:bg-yellow-500 text-white"
                  }`}
                >
                  {streamRunning ? (
                    <><span className="w-2 h-2 rounded-full bg-red-300 animate-pulse" />Live · ⏹ Stop</>
                  ) : "▶ Mulai Live Detection"}
                </button>

                {streamError && <p className="bg-red-900/30 border border-red-700 rounded-xl p-3 text-sm text-red-300">❌ {streamError}</p>}
                {streamResult && <YoloResultCard result={{ vehicle_count: streamResult.count, class_counts: streamResult.class_counts, annotated_image: streamResult.frame }} live />}
              </>
            )}

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
