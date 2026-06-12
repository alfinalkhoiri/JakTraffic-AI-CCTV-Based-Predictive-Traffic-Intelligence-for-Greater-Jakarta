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

const API_BASE = "http://localhost:5000";

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
