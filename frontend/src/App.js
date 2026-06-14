import React, { useEffect, useState, useCallback, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  Circle,
  useMapEvents,
  useMap,
} from "react-leaflet";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Line,
} from "recharts";

import axios from "axios";
import { Link } from "react-router-dom";
import { Route, AlertTriangle, Clock, TrendingUp } from "lucide-react";
import ChatButton from "./components/ChatButton";
import ChatPopup from "./components/ChatPopup";
import MapPopup from "./components/MapPopup";

const API = process.env.REACT_APP_API_URL || "";

/* =============== Helper 1 Jam Predik ================= */
const predictionStyle = (status) => {
  switch (status) {
    case "POTENTIAL_JAM":
      return {
        color: "text-red-400",
        bg: "bg-red-500/10 border-red-500/30",
        icon: "🔴"
      };
    case "UNSTABLE":
      return {
        color: "text-yellow-400",
        bg: "bg-yellow-500/10 border-yellow-500/30",
        icon: "🟡"
      };
    default:
      return {
        color: "text-emerald-400",
        bg: "bg-emerald-500/10 border-emerald-500/30",
        icon: "🟢"
      };
  }
};


const haversineDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const detectIntermediateCCTVs = (coords, cctvList, startPt, endPt) => {
  const THRESHOLD   = 200; // max distance from route line (meters)
  const EXCL_RADIUS = 120; // ignore CCTVs too close to start/end

  const candidates = [];
  for (const c of cctvList) {
    if (haversineDistance(c.lat, c.lng, startPt.lat, startPt.lng) < EXCL_RADIUS) continue;
    if (haversineDistance(c.lat, c.lng, endPt.lat,   endPt.lng)   < EXCL_RADIUS) continue;
    let minDist = Infinity;
    let minIdx  = 0;
    for (let i = 0; i < coords.length; i++) {
      const d = haversineDistance(c.lat, c.lng, coords[i][0], coords[i][1]);
      if (d < minDist) { minDist = d; minIdx = i; }
    }
    if (minDist < THRESHOLD) candidates.push({ ...c, _routeIdx: minIdx });
  }
  return candidates.sort((a, b) => a._routeIdx - b._routeIdx);
};

const findNearestCCTV = (point, cctvList) => {
  if (!point || !cctvList.length) return null;

  let nearest = null;
  let minDist = Infinity;

  cctvList.forEach(c => {
    const d =
      Math.pow(point.lat - c.lat, 2) +
      Math.pow(point.lng - c.lng, 2);

    if (d < minDist) {
      minDist = d;
      nearest = c;
    }
  });

  return nearest;
};

/* =============== Traffic Color Helper ================= */
const getTrafficColor = (vehicles) => {
  if (vehicles > 30) return "#ef4444"; // merah - padat
  if (vehicles > 15) return "#f97316"; // oranye - ramai
  return "#22c55e"; // hijau - lancar
};

/* =============== Signal Recommendation ================= */
const getSignalRec = (vehicles) => {
  if (vehicles > 40) return {
    light: "green",
    green: 90, red: 30,
    label: "Perpanjang Fase Hijau",
    note: "Volume tinggi — prioritaskan pergerakan kendaraan",
    priority: "TINGGI",
    color: "text-red-400",
    bg: "bg-red-500/10 border-red-500/30",
    dot: "#ef4444",
  };
  if (vehicles > 20) return {
    light: "yellow",
    green: 60, red: 45,
    label: "Pertahankan Siklus Normal",
    note: "Volume sedang — pertahankan siklus standar",
    priority: "NORMAL",
    color: "text-yellow-400",
    bg: "bg-yellow-500/10 border-yellow-500/30",
    dot: "#f59e0b",
  };
  return {
    light: "red",
    green: 30, red: 60,
    label: "Kurangi Fase Hijau",
    note: "Volume rendah — alihkan waktu ke jalur persimpangan",
    priority: "RENDAH",
    color: "text-emerald-400",
    bg: "bg-emerald-500/10 border-emerald-500/30",
    dot: "#22c55e",
  };
};

/* =============== Traffic Light Component ================= */
function TrafficLight({ active }) {
  const lights = [
    { key: "red",    hex: "#ef4444" },
    { key: "yellow", hex: "#f59e0b" },
    { key: "green",  hex: "#22c55e" },
  ];
  return (
    <div style={{
      background: "#111827", border: "2px solid #374151",
      borderRadius: 10, padding: "10px 12px",
      display: "inline-flex", flexDirection: "column",
      gap: 7, alignItems: "center", flexShrink: 0,
    }}>
      {lights.map(l => (
        <div key={l.key} style={{
          width: 22, height: 22, borderRadius: "50%",
          background: l.key === active ? l.hex : "#1e293b",
          boxShadow: l.key === active ? `0 0 10px ${l.hex}, 0 0 20px ${l.hex}60` : "none",
          border: `2px solid ${l.key === active ? l.hex : "#374151"}`,
          transition: "all 0.4s ease",
        }} />
      ))}
    </div>
  );
}

/* =============== Route Step Helpers ================= */
const MANEUVER_ICON = {
  depart:           "🚦",
  arrive:           "📍",
  roundabout:       "🔄",
  rotary:           "🔄",
  "exit roundabout":"↗",
  "exit rotary":    "↗",
  "end of road":    "⬆",
};
const MODIFIER_ICON = {
  "sharp right": "↱",
  right:         "↱",
  "slight right":"↗",
  straight:      "⬆",
  "slight left": "↖",
  left:          "↰",
  "sharp left":  "↰",
  uturn:         "↩",
};
const MODIFIER_LABEL = {
  "sharp right": "Belok tajam kanan",
  right:         "Belok kanan",
  "slight right":"Agak kanan",
  straight:      "Lurus",
  "slight left": "Agak kiri",
  left:          "Belok kiri",
  "sharp left":  "Belok tajam kiri",
  uturn:         "Putar balik",
};
const maneuverIcon  = (type, mod) => MANEUVER_ICON[type] ?? MODIFIER_ICON[mod] ?? "⬆";
const maneuverLabel = (type, mod) => {
  if (type === "depart") return "Mulai perjalanan";
  if (type === "arrive") return "Tiba di tujuan";
  if (type === "roundabout" || type === "rotary") return "Masuk bundaran";
  if (type === "exit roundabout" || type === "exit rotary") return "Keluar bundaran";
  return MODIFIER_LABEL[mod] ?? "Lanjutkan";
};
const fmtDist = (m) => m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;

/* ================= FIX LEAFLET ICON ================= */
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: require("leaflet/dist/images/marker-icon-2x.png"),
  iconUrl: require("leaflet/dist/images/marker-icon.png"),
  shadowUrl: require("leaflet/dist/images/marker-shadow.png"),
});

/* ================= CCTV ICON ================= */
const pulseIcon = (status, isHighlighted = false) => {
  const color = status === "MERAH" ? "#ef4444" : status === "KUNING" ? "#f97316" : "#22c55e";
  const pulseRgb = status === "MERAH" ? "239,68,68" : status === "KUNING" ? "249,115,22" : "34,197,94";
  const size  = isHighlighted ? 32 : 28;
  const dot   = isHighlighted ? 22 : 20;
  const off   = (size - dot) / 2;
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:${size}px;height:${size}px;">
      ${isHighlighted ? `<span style="
        position:absolute;inset:-5px;border-radius:50%;
        border:2px solid #3b82f6;
        box-shadow:0 0 10px rgba(59,130,246,.7),0 0 20px rgba(59,130,246,.3);
        animation:chatHL 1.4s ease-in-out infinite;
      "></span>` : ""}
      <span style="
        position:absolute;inset:0;border-radius:50%;
        background:rgba(${pulseRgb},.35);
        animation:cctvPulse 1.8s ease-out infinite;
      "></span>
      <span style="
        position:absolute;top:${off}px;left:${off}px;
        width:${dot}px;height:${dot}px;border-radius:50%;
        background:${color};border:2px solid white;
        box-shadow:0 1px 4px rgba(0,0,0,.35);
      "></span>
    </div>
    <style>
      @keyframes cctvPulse {
        0%   { transform:scale(1);   opacity:.9; }
        70%  { transform:scale(2.2); opacity:0;  }
        100% { opacity:0; }
      }
      @keyframes chatHL {
        0%,100% { opacity:1;  transform:scale(1);    }
        50%     { opacity:.5; transform:scale(1.12); }
      }
    </style>`,
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

/* ================= TOLL ICON (diamond) ================= */
const tollIcon = (status, isHighlighted = false) => {
  const color = status === "MERAH" ? "#ef4444" : status === "KUNING" ? "#f97316" : "#22c55e";
  const pulseRgb = status === "MERAH" ? "239,68,68" : status === "KUNING" ? "249,115,22" : "34,197,94";
  const size = isHighlighted ? 30 : 26;
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:${size}px;height:${size}px;">
      ${isHighlighted ? `<span style="
        position:absolute;inset:-5px;border-radius:3px;
        border:2px solid #3b82f6;
        box-shadow:0 0 10px rgba(59,130,246,.7);
        transform:rotate(45deg);
      "></span>` : ""}
      <span style="
        position:absolute;inset:3px;
        background:rgba(${pulseRgb},.3);
        transform:rotate(45deg);border-radius:3px;
        animation:cctvPulse 1.8s ease-out infinite;
      "></span>
      <span style="
        position:absolute;inset:6px;
        background:${color};border:2px solid white;
        transform:rotate(45deg);border-radius:3px;
        box-shadow:0 1px 4px rgba(0,0,0,.4);
      "></span>
      <span style="
        position:absolute;bottom:-1px;right:-1px;
        font-size:8px;line-height:1;
        background:#0f172a;color:#94a3b8;
        border-radius:2px;padding:0 1px;
        font-weight:700;pointer-events:none;
      ">TOL</span>
    </div>`,
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

  /* ================= ROUTE ICON ================= */
const startIcon = L.divIcon({
  html: `
    <div style="
      width:20px;height:20px;
      background:#22c55e;
      border:3px solid white;
      border-radius:50%;
      box-shadow:0 0 12px rgba(34,197,94,.9);
    "></div>
  `,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

const endIcon = L.divIcon({
  html: `
    <div style="
      width:20px;height:20px;
      background:#ef4444;
      border:3px solid white;
      border-radius:50%;
      box-shadow:0 0 12px rgba(239,68,68,.9);
    "></div>
  `,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});


const etaBadgeIcon = (minutes, km, isDestination = false) => L.divIcon({
  className: "",
  html: `<div style="
    display:inline-block;
    transform:translate(-50%, calc(-100% - 14px));
    background:${isDestination ? "rgba(59,130,246,0.92)" : "rgba(15,23,42,0.92)"};
    border:1px solid ${isDestination ? "#3b82f6" : "#475569"};
    color:white;
    font-size:10px;
    font-weight:700;
    padding:2px 8px;
    border-radius:999px;
    white-space:nowrap;
    pointer-events:none;
    box-shadow:0 2px 6px rgba(0,0,0,.5);
  ">${isDestination ? `📍 ${minutes}mnt · ${km}km` : `+${minutes}mnt · ${km}km`}</div>`,
  iconSize: [0, 0],
  iconAnchor: [0, 0],
});

/* ================= TOMTOM INCIDENT ICON ================= */
const INCIDENT_LABELS = {
  1: "Kecelakaan", 2: "Kabut", 3: "Kondisi Berbahaya", 4: "Hujan",
  5: "Es di Jalan", 6: "Kemacetan", 7: "Lajur Ditutup",
  8: "Jalan Ditutup", 9: "Perbaikan Jalan", 11: "Banjir", 14: "Kendaraan Mogok",
};
const INCIDENT_EMOJI = { 1: "🚗", 6: "🚦", 7: "🚧", 8: "⛔", 9: "🔧", 11: "🌊", 14: "🚗" };

const incidentIcon = (category) => {
  const color = [1, 8].includes(category) ? "#ef4444" : [6].includes(category) ? "#f97316" : "#f59e0b";
  const emoji = INCIDENT_EMOJI[category] || "⚠";
  return L.divIcon({
    className: "",
    html: `<div style="width:26px;height:26px;background:${color};border:2px solid rgba(255,255,255,.85);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.5);">${emoji}</div>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  });
};

/* ================= MAP CLICK ================= */
function MapClickHandler({ onPick }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng);
    },
  });
  return null;
}

/* ================= FLY TO HANDLER (chatbot) ================= */
function FlyToHandler({ target }) {
  const map = useMap();
  useEffect(() => {
    if (target) {
      map.flyTo([target.lat, target.lng], target.zoom ?? 16, { duration: 1.2 });
    }
  }, [target, map]);
  return null;
}

/* ================= MAIN APP ================= */
export default function App() {
  const [cctv, setCctv] = useState([]);
  const cctvRef = useRef([]);           // ← ref agar executeMapCommands selalu dapat cctv terbaru
  const [selected, setSelected] = useState(null);

  const [startPoint, setStartPoint] = useState(null);
  const [endPoint, setEndPoint] = useState(null);

  const [routeSegments, setRouteSegments] = useState([]);
  const [eta, setEta] = useState(null);
  const [routeNames, setRouteNames] = useState(null); // { from, to }
  const [routeSteps, setRouteSteps] = useState([]);   // turn-by-turn steps
  const [waypointETAs, setWaypointETAs] = useState([]); // intermediate CCTV ETAs

  const [history, setHistory] = useState([]);
  const [nowVsUsual, setNowVsUsual] = useState(null);
  const [nextHourPrediction, setNextHourPrediction] = useState(null);

  // Prediction mode: "now" | "15" | "30"
  const [predictionMode, setPredictionMode] = useState("now");
  const [predictionData, setPredictionData] = useState(null);
  const [showChat, setShowChat] = useState(false);

  // Route/CCTV filter mode: "all" | "city" | "toll"
  const [routeMode, setRouteMode] = useState("all");

  // Toll road corridor polylines: [{points:[[lat,lng],...], name, color}]
  const [tollRoadLines, setTollRoadLines] = useState([]);

  // TomTom traffic data
  const [tomtomIncidents, setTomtomIncidents] = useState([]);
  const [tomtomFlow,      setTomtomFlow]      = useState(null);

  // ── Chatbot map control state ──────────────────────────────────────────────
  const [highlighted, setHighlighted]   = useState([]);   // array location_id — pin biru chatbot
  const [mapFlyTo,    setMapFlyTo]      = useState(null); // { lat, lng } — auto-zoom
  const [compareMode, setCompareMode]   = useState(null); // { ids:[1,5] } — sidebar compare
  const [compareData, setCompareData]   = useState({});
  const [showPanel, setShowPanel]        = useState(false);   // { [id]: { cctv, history, nowVsUsual } }

  /* ================= LOAD CCTV ================= */
  useEffect(() => {
    const load = async () => {
      const res = await axios.get(`${API}/api/cctv_status`);
      // If in prediction mode, also fetch predictions
      if (predictionMode !== "now") {
        try {
          const predRes = await axios.get(`${API}/api/predict-traffic?horizon=${predictionMode}`);
          setPredictionData(predRes.data);
        } catch (e) {
          console.error("Prediction fetch error:", e);
        }
      } else {
        setPredictionData(null);
      }
      setCctv(res.data);
      cctvRef.current = res.data;  // ← sync ref
    };
    load();
    const i = setInterval(load, 30000);
    return () => clearInterval(i);
  }, [predictionMode]);

  /* ================= MAP CLICK (ROUTING) ================= */
  const handleMapPick = (latlng) => {
    setSelected(null);

    if (!startPoint) setStartPoint(latlng);
    else if (!endPoint) setEndPoint(latlng);
    else {
      setStartPoint(latlng);
      setEndPoint(null);
      setRouteSegments([]);
      setEta(null);
      setRouteNames(null);
      setRouteSteps([]);
      setWaypointETAs([]);
    }
  };

  const filteredCctv = routeMode === "all" ? cctv
    : cctv.filter(c => (c.road_type || "city") === routeMode);

  /* ================= TOLL ROAD CORRIDOR OVERLAY ================= */
  useEffect(() => {
    if (!cctv.length) return;
    const tollCams = cctv.filter(c => c.road_type === "toll");
    if (!tollCams.length) return;

    // Group by toll road name
    const kgpg  = tollCams.filter(c => c.name?.includes("KG-PG"))
                          .sort((a, b) => a.lng - b.lng); // west→east
    const bckm  = tollCams.filter(c => c.name?.includes("BCKM"))
                          .sort((a, b) => a.lng - b.lng);

    const fetchCorridor = async (cameras, color, name) => {
      if (cameras.length < 2) return null;
      const wpStr = cameras.map(c => `${c.lng},${c.lat}`).join(";");
      try {
        const res = await axios.get(
          `https://router.project-osrm.org/route/v1/driving/${wpStr}?overview=full&geometries=geojson`
        );
        const coords = res.data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
        return { name, color, points: coords };
      } catch { return null; }
    };

    Promise.all([
      fetchCorridor(kgpg, "#f59e0b", "Tol Dalam Kota — Kelapa Gading–Pulo Gebang"),
      fetchCorridor(bckm, "#fb923c", "Tol BCKM — Bekasi–Cawang–Kamp. Melayu"),
    ]).then(lines => setTollRoadLines(lines.filter(Boolean)));
  }, [cctv]);

  /* ================= OSRM ROUTING (FREE) ================= */
  useEffect(() => {
    if (!startPoint || !endPoint) return;

    const fetchRoute = async () => {
      try {
        const getVehiclesForCCTV = (cctvItem) => {
          if (predictionMode !== "now" && predictionData) {
            const pred = predictionData.predictions?.find(p => p.location_id === cctvItem.id);
            return pred ? pred.predicted_vehicles : cctvItem.vehicles;
          }
          return cctvItem.vehicles;
        };

        const trafficMult = (cctvItem) => {
          const v = getVehiclesForCCTV(cctvItem);
          return v > 30 ? 1.5 : v > 15 ? 1.25 : 1;
        };

        // ── Step 1: Initial A→D fetch to get geometry ─────────────
        // city mode → exclude motorway (avoid toll); toll/all → normal routing
        const excludeParam = routeMode === "city" ? "&exclude=motorway" : "";
        const initUrl = `https://router.project-osrm.org/route/v1/driving/${startPoint.lng},${startPoint.lat};${endPoint.lng},${endPoint.lat}?overview=full&geometries=geojson&steps=true${excludeParam}`;
        const initRes = await axios.get(initUrl);
        const initCoords = initRes.data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);

        // ── Step 2: Detect intermediate CCTVs ─────────────────────
        const intermediates = detectIntermediateCCTVs(initCoords, filteredCctv, startPoint, endPoint);

        // ── Step 3: Re-fetch with waypoints if intermediates exist ─
        let route = initRes.data.routes[0];
        let coords = initCoords;
        if (intermediates.length > 0) {
          const allWps = [startPoint, ...intermediates, endPoint];
          const wpStr  = allWps.map(w => `${w.lng},${w.lat}`).join(';');
          const wpRes  = await axios.get(
            `https://router.project-osrm.org/route/v1/driving/${wpStr}?overview=full&geometries=geojson&steps=true${excludeParam}`
          );
          route  = wpRes.data.routes[0];
          coords = route.geometry.coordinates.map(c => [c[1], c[0]]);
        }

        // ── Step 4: Traffic-coloured polyline segments ─────────────
        // Dalam zone (≤400m) → solid + warna zone terpadat
        // Luar zone         → dashed + warna CCTV terdekat (estimasi)
        const ZONE_R = 400;
        const getSegmentStyle = (lat, lng) => {
          const inZone = filteredCctv.filter(c =>
            haversineDistance(lat, lng, c.lat, c.lng) <= ZONE_R
          );
          if (inZone.length > 0) {
            const worst = inZone.reduce((a, b) =>
              getVehiclesForCCTV(a) >= getVehiclesForCCTV(b) ? a : b
            );
            return { color: getTrafficColor(getVehiclesForCCTV(worst)), dashed: false };
          }
          // Luar zone: pakai CCTV terdekat sebagai estimasi
          const nearest = findNearestCCTV({ lat, lng }, filteredCctv);
          return {
            color:  nearest ? getTrafficColor(getVehiclesForCCTV(nearest)) : "#94a3b8",
            dashed: true,
          };
        };

        const segments = [];
        let cur       = getSegmentStyle(coords[0][0], coords[0][1]);
        let curPoints = [coords[0]];
        for (let i = 1; i < coords.length; i++) {
          const s = getSegmentStyle(coords[i][0], coords[i][1]);
          if (s.color !== cur.color || s.dashed !== cur.dashed) {
            curPoints.push(coords[i]);
            segments.push({ points: [...curPoints], color: cur.color, dashed: cur.dashed });
            curPoints = [coords[i]];
            cur       = s;
          } else {
            curPoints.push(coords[i]);
          }
        }
        if (curPoints.length > 0) segments.push({ points: curPoints, color: cur.color, dashed: cur.dashed });
        setRouteSegments(segments);

        // ── Step 5: Per-leg cumulative ETA ─────────────────────────
        const legs        = route.legs;
        const allWaypoints = [startPoint, ...intermediates, endPoint];
        let cumMin = 0;
        let cumKm  = 0;
        const newWaypointETAs = [];

        for (let i = 0; i < legs.length; i++) {
          const wpStart  = allWaypoints[i];
          const wpEnd    = allWaypoints[i + 1];
          const midLat   = (wpStart.lat + wpEnd.lat) / 2;
          const midLng   = (wpStart.lng + wpEnd.lng) / 2;
          const midCCTV  = findNearestCCTV({ lat: midLat, lng: midLng }, filteredCctv);
          const mult     = midCCTV ? trafficMult(midCCTV) : 1;
          const legMin   = Math.round((legs[i].duration / 60) * mult);
          const legKm    = (legs[i].distance / 1000).toFixed(1);
          cumMin += legMin;
          cumKm  += legs[i].distance / 1000;

          if (i < intermediates.length) {
            // Badge di CCTV intermediate: tampilkan waktu segmen A→sini
            newWaypointETAs.push({
              cctv_id:     intermediates[i].id,
              lat:         intermediates[i].lat,
              lng:         intermediates[i].lng,
              segment_min: legMin,
              segment_km:  legKm,
            });
          } else if (intermediates.length > 0) {
            // Badge di tujuan akhir: tampilkan waktu segmen dari waypoint sebelumnya
            newWaypointETAs.push({
              cctv_id:      "destination",
              lat:          endPoint.lat,
              lng:          endPoint.lng,
              segment_min:  legMin,
              segment_km:   legKm,
              isDestination: true,
            });
          }
        }

        setWaypointETAs(newWaypointETAs);
        setEta({ time: cumMin, distance: cumKm.toFixed(1) });

        // ── Step 6: Turn-by-turn steps (flatten all legs) ──────────
        const allSteps = legs.flatMap(l => l.steps ?? []);
        setRouteSteps(allSteps.map(s => ({
          type:     s.maneuver.type,
          modifier: s.maneuver.modifier ?? "straight",
          name:     s.name || "",
          distance: s.distance,
        })));

      } catch (err) {
        console.error("Routing error:", err);
      }
    };

    fetchRoute();
  }, [startPoint, endPoint, predictionMode, predictionData, routeMode, cctv]);


  /* ================= 1 JAM PREDIKISI ================= */
  useEffect(() => {
    if (!startPoint || !endPoint || !cctv.length) {
      setNextHourPrediction(null);
      return;
    }
  
    const nearest = findNearestCCTV(startPoint, cctv);
    if (!nearest) return;
  
    axios
      .get(`${API}/api/predict-next-hour/${nearest.id}`)
      .then(res => setNextHourPrediction(res.data))
      .catch(() => setNextHourPrediction(null));
  
  }, [startPoint, endPoint, cctv]);
  /* ================= CCTV DETAIL ================= */
  useEffect(() => {
    if (!selected) return;

    axios
      .get(`${API}/api/traffic-history/${selected.id}?range=1h`)
      .then(res => {
        const d = res.data.map((v, i, arr) => ({
          ...v,
          volatility: i === 0 ? 0 : v.avg_vehicle - arr[i - 1].avg_vehicle,
        }));
        setHistory(d);
      });

    axios
      .get(`${API}/api/now-vs-usual/${selected.id}`)
      .then(res => setNowVsUsual(res.data));
  }, [selected]);

  /* ================= TOMTOM: incidents (area Jakarta–Bekasi) ================= */
  useEffect(() => {
    const fetchInc = () => {
      axios.get(`${API}/api/tomtom-incidents`)
        .then(res => { if (Array.isArray(res.data)) setTomtomIncidents(res.data); })
        .catch(() => {});
    };
    fetchInc();
    const t = setInterval(fetchInc, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  /* ================= TOMTOM: flow data untuk kamera terpilih ================= */
  useEffect(() => {
    if (!selected?.lat || !selected?.lng) { setTomtomFlow(null); return; }
    axios.get(`${API}/api/tomtom-flow`, { params: { lat: selected.lat, lng: selected.lng } })
      .then(res => setTomtomFlow(res.data?.currentSpeed ? res.data : null))
      .catch(() => setTomtomFlow(null));
  }, [selected]);

  /* ================= COMPARE MODE DATA FETCH ================= */
  useEffect(() => {
    if (!compareMode?.ids?.length) {
      setCompareData({});
      return;
    }
    const fetchCompare = async () => {
      const results = {};
      for (const id of compareMode.ids) {
        try {
          const cctvItem = cctv.find(c => c.id === id);
          const [histRes, nvuRes] = await Promise.all([
            axios.get(`${API}/api/traffic-history/${id}?range=1h`),
            axios.get(`${API}/api/now-vs-usual/${id}`),
          ]);
          results[id] = {
            cctv:       cctvItem,
            history:    histRes.data,
            nowVsUsual: nvuRes.data,
          };
        } catch (e) {
          console.error(`Compare fetch failed for loc ${id}:`, e);
        }
      }
      setCompareData(results);
    };
    fetchCompare();
  }, [compareMode, cctv]);

  const isRoutingActive = startPoint && endPoint;

  /* ================= CHATBOT MAP COMMANDS ================= */
  const executeMapCommands = useCallback((actions) => {
    actions.forEach(action => {
      switch (action.type) {

        case "select_pin": {
          // Gunakan cctvRef.current agar tidak stale closure
          const target = cctvRef.current.find(c => c.id === action.location_id);
          if (target) {
            setSelected(target);
            setStartPoint(null);
            setEndPoint(null);
            setRouteSegments([]);
            setEta(null);
            setCompareMode(null);
            setHighlighted([]);
          }
          break;
        }

        case "highlight_pins": {
          setHighlighted(action.location_ids || []);
          // Jika 2 lokasi untuk compare: aktifkan compare mode dan bersihkan rute aktif
          if (action.location_ids?.length >= 2) {
            setCompareMode({ ids: action.location_ids.slice(0, 2) });
            setSelected(null);
            setStartPoint(null);
            setEndPoint(null);
            setRouteSegments([]);
            setEta(null);
          }
          break;
        }

        case "fly_to": {
          setMapFlyTo({ lat: action.lat, lng: action.lng, zoom: action.zoom });
          // Clear setelah animasi flyTo selesai (duration 1.2s + buffer)
          setTimeout(() => setMapFlyTo(null), 3500);
          break;
        }

        case "set_route": {
          if (action.start_lat && action.end_lat) {
            setSelected(null);
            setCompareMode(null);
            setHighlighted([]);
            setStartPoint({ lat: action.start_lat, lng: action.start_lng });
            setEndPoint({   lat: action.end_lat,   lng: action.end_lng   });
            const fromCCTV = cctvRef.current.find(c => c.id === action.start_id);
            const toCCTV   = cctvRef.current.find(c => c.id === action.end_id);
            setRouteNames({
              from: fromCCTV?.name || "Titik Awal",
              to:   toCCTV?.name   || "Titik Akhir",
            });
          }
          break;
        }

        case "clear_selection": {
          setSelected(null);
          setHighlighted([]);
          setCompareMode(null);
          setStartPoint(null);
          setEndPoint(null);
          setRouteSegments([]);
          setEta(null);
          setRouteNames(null);
          setRouteSteps([]);
          setWaypointETAs([]);
          break;
        }

        default:
          break;
      }
    });
  }, []);


  // Get effective CCTV data (real or predicted)
  const getEffectiveVehicles = (cctvItem) => {
    if (predictionMode === "now" || !predictionData) return cctvItem.vehicles;
    const pred = predictionData.predictions?.find(p => p.location_id === cctvItem.id);
    return pred ? pred.predicted_vehicles : cctvItem.vehicles;
  };

  /* ================= CCTV DECISION ================= */
  let decisionLabel = "Lancar / Normal";
  let decisionColor = "text-emerald-400";
  let decisionNote = "Aktivitas lalu lintas dalam pola normal.";

  if (nowVsUsual?.status === "UNUSUAL") {
    decisionLabel = "Waspada";
    decisionColor = "text-yellow-400";
    decisionNote = "Aktivitas lalu lintas di atas pola normal.";
  }

  /* ================= ROUTE DECISION ================= */
  let routeDecisionLabel = "Direkomendasikan";
  let routeDecisionColor = "text-emerald-400";
  let routeDecisionBg = "bg-emerald-500/10 border-emerald-500/30";
  let routeDecisionNote = "Rute relatif lancar dan stabil.";

  if (routeSegments.length > 0) {
    const hasRed = routeSegments.some(s => s.color === "#ef4444");
    const hasOrange = routeSegments.some(s => s.color === "#f97316");
    if (hasRed) {
      routeDecisionLabel = "Tidak Disarankan";
      routeDecisionColor = "text-red-400";
      routeDecisionBg = "bg-red-500/10 border-red-500/30";
      routeDecisionNote = "Terdapat kemacetan signifikan di sepanjang rute.";
    } else if (hasOrange) {
      routeDecisionLabel = "Perlu Pertimbangan";
      routeDecisionColor = "text-yellow-400";
      routeDecisionBg = "bg-yellow-500/10 border-yellow-500/30";
      routeDecisionNote = "Terdapat kepadatan di beberapa segmen jalan.";
    }
  }

  return (
    <>
    <div className="flex h-screen bg-slate-950 text-white overflow-hidden">
      {/* ================= MAP ================= */}
      <div className="flex-1 relative">
        {eta && (
          <div className="absolute top-4 right-4 z-[1000] bg-slate-900/95 backdrop-blur-sm rounded-xl shadow-2xl border border-slate-700 w-56">
            {/* Header: Asal → Tujuan + Tombol tutup */}
            <div className="flex items-start justify-between gap-1 px-3 pt-3 pb-2 border-b border-slate-700/60">
              <div className="text-[11px] leading-snug">
                {routeNames ? (
                  <>
                    <span className="text-white font-semibold">{routeNames.from}</span>
                    <span className="text-slate-400 mx-1">→</span>
                    <span className="text-white font-semibold">{routeNames.to}</span>
                  </>
                ) : (
                  <span className="text-slate-400">Rute Aktif</span>
                )}
              </div>
              <button
                onClick={() => {
                  setRouteSegments([]);
                  setEta(null);
                  setStartPoint(null);
                  setEndPoint(null);
                  setRouteNames(null);
                  setRouteSteps([]);
                  setWaypointETAs([]);
                }}
                className="text-slate-500 hover:text-white text-xs leading-none flex-shrink-0 mt-0.5"
              >
                ✕
              </button>
            </div>

            {/* ETA & Jarak */}
            <div className="flex gap-3 px-3 py-2 border-b border-slate-700/60">
              <div>
                <p className="text-[9px] text-slate-400 uppercase tracking-wide">ETA</p>
                <p className="text-lg font-bold leading-tight">{eta.time} <span className="text-xs font-normal text-slate-400">mnt</span></p>
              </div>
              <div className="w-px bg-slate-700" />
              <div>
                <p className="text-[9px] text-slate-400 uppercase tracking-wide">Jarak</p>
                <p className="text-lg font-bold leading-tight">{eta.distance} <span className="text-xs font-normal text-slate-400">km</span></p>
              </div>
            </div>

            {/* Status Rute */}
            <div className={`text-[11px] font-bold px-3 py-1.5 border-b border-slate-700/60 ${routeDecisionColor}`}>
              {routeDecisionLabel}
            </div>

            {/* Petunjuk Arah */}
            {routeSteps.length > 0 && (
              <>
                <p className="text-[9px] text-slate-500 uppercase tracking-wide px-3 pt-2 pb-0.5">
                  Petunjuk Arah
                </p>
                <div className="overflow-y-auto max-h-28">
                  {routeSteps.map((step, i) => (
                    <div
                      key={i}
                      className={`flex items-start gap-2 px-3 py-1.5 ${i < routeSteps.length - 1 ? "border-b border-slate-800/50" : ""}`}
                    >
                      <span className="text-sm leading-none mt-0.5 w-4 text-center flex-shrink-0">
                        {maneuverIcon(step.type, step.modifier)}
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-medium leading-tight">
                          {maneuverLabel(step.type, step.modifier)}
                        </p>
                        {step.name && (
                          <p className="text-[10px] text-slate-400 truncate">{step.name}</p>
                        )}
                        {step.distance > 0 && (
                          <p className="text-[10px] text-slate-500">{fmtDist(step.distance)}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <MapContainer center={[-6.22, 106.833]} zoom={11} className="h-full">
          <TileLayer url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" />
          <MapClickHandler onPick={handleMapPick} />
          {/* Chatbot fly-to handler */}
          {mapFlyTo && <FlyToHandler target={mapFlyTo} />}

          {startPoint && (
            <Marker
            position={startPoint}
            icon={startIcon}
            draggable
            eventHandlers={{
              dragend: e => setStartPoint(e.target.getLatLng())
            }}
          >
            <Popup>Start</Popup>
          </Marker>
        )}
        
        {endPoint && (
          <Marker
            position={endPoint}
            icon={endIcon}
            draggable
            eventHandlers={{
              dragend: e => setEndPoint(e.target.getLatLng())
            }}
          >
            <Popup>Destination</Popup>
          </Marker>
          )}

          {/* ── Toll road corridor overlay ── */}
          {tollRoadLines.map((line, idx) => (
            <React.Fragment key={`toll-road-${idx}`}>
              {/* Glow border (lebih tebal, lebih transparan) */}
              <Polyline
                positions={line.points}
                pathOptions={{ color: line.color, weight: 10, opacity: 0.25, lineCap: "round", lineJoin: "round" }}
                interactive={false}
              />
              {/* Main line */}
              <Polyline
                positions={line.points}
                pathOptions={{ color: line.color, weight: 4, opacity: 0.85, dashArray: "12 5", lineCap: "round" }}
              >
                <Popup>
                  <b style={{color: line.color}}>🛣️ {line.name}</b>
                </Popup>
              </Polyline>
            </React.Fragment>
          ))}

          {routeSegments.map((seg, idx) => (
            <Polyline
              key={idx}
              positions={seg.points}
              pathOptions={{
                color:     seg.color,
                weight:    6,
                opacity:   seg.dashed ? 0.6 : 0.85,
                dashArray: seg.dashed ? "10 7" : null,
              }}
            />
          ))}

          {waypointETAs.map(wp => (
            <Marker
              key={`eta-${wp.cctv_id}`}
              position={[wp.lat, wp.lng]}
              icon={etaBadgeIcon(wp.segment_min, wp.segment_km, wp.isDestination)}
              interactive={false}
            />
          ))}

          {/* ── TomTom Incidents ── */}
          {tomtomIncidents.map((inc, i) => (
            <Marker
              key={`inc-${i}`}
              position={[inc.lat, inc.lng]}
              icon={incidentIcon(inc.category)}
              zIndexOffset={500}
            >
              <Popup>
                <div style={{ color: "#0f172a", fontSize: 12, maxWidth: 200, lineHeight: 1.4 }}>
                  <b>{INCIDENT_LABELS[inc.category] || "Insiden"}</b>
                  {inc.description && <p style={{ margin: "3px 0 0" }}>{inc.description}</p>}
                  {(inc.from || inc.to) && (
                    <p style={{ margin: "3px 0 0", color: "#64748b", fontSize: 10 }}>
                      {inc.from}{inc.to ? ` → ${inc.to}` : ""}
                    </p>
                  )}
                </div>
              </Popup>
            </Marker>
          ))}

          {filteredCctv.map(c => {
            const ev    = getEffectiveVehicles(c);
            const color = ev > 30 ? "#ef4444" : ev > 15 ? "#f97316" : "#22c55e";
            return (
              <Circle
                key={`zone-${c.id}`}
                center={[c.lat, c.lng]}
                radius={c.road_type === "toll" ? 200 : 400}
                pathOptions={{
                  color:       color,
                  fillColor:   color,
                  fillOpacity: 0.07,
                  weight:      1,
                  opacity:     0.2,
                }}
              />
            );
          })}

          {filteredCctv.map(c => {
            const ev = getEffectiveVehicles(c);
            const markerStatus = ev > 30 ? "MERAH" : ev > 15 ? "KUNING" : undefined;
            const isHighlighted = highlighted.includes(c.id);
            const isToll = c.road_type === "toll";
            return (
              <Marker
                key={c.id}
                position={[c.lat, c.lng]}
                icon={isToll ? tollIcon(markerStatus, isHighlighted) : pulseIcon(markerStatus, isHighlighted)}
                eventHandlers={{ click: () => {
                  setCompareMode(null);
                  setHighlighted([]);
                }}}
              >
                <Popup className="cctv-popup" maxWidth={270} minWidth={270} autoPan>
                  <MapPopup
                    cam={c}
                    effectiveVehicles={ev}
                    onSelectDetail={() => {
                      setSelected(c);
                      setCompareMode(null);
                      setHighlighted([]);
                    }}
                  />
                </Popup>
              </Marker>
            );
          })}
        </MapContainer>

        {/* Map legend */}
        <div className="absolute bottom-6 left-4 z-[1000] bg-slate-900/90 backdrop-blur-sm rounded-lg border border-slate-700 px-3 py-2 text-[10px] text-slate-300 space-y-1 pointer-events-none">
          <div className="flex items-center gap-2">
            <span style={{display:"inline-block",width:12,height:12,borderRadius:"50%",background:"#22c55e",border:"1.5px solid white"}}></span>
            <span>CCTV Jalan Biasa</span>
          </div>
          <div className="flex items-center gap-2">
            <span style={{display:"inline-block",width:11,height:11,transform:"rotate(45deg)",background:"#22c55e",border:"1.5px solid white",borderRadius:"2px"}}></span>
            <span>CCTV Jalan Tol</span>
          </div>
          {tomtomIncidents.length > 0 && (
            <div className="flex items-center gap-2">
              <span style={{display:"inline-block",width:12,height:12,background:"#f97316",border:"1.5px solid white",borderRadius:"2px",fontSize:8,lineHeight:"12px",textAlign:"center"}}>⚠</span>
              <span>Insiden TomTom ({tomtomIncidents.length})</span>
            </div>
          )}
        </div>

        {/* Mobile backdrop */}
        {showPanel && (
          <div
            className="md:hidden absolute inset-0 bg-black/30 z-[1400]"
            onClick={() => setShowPanel(false)}
          />
        )}
        {/* Mobile panel toggle */}
        <button
          onClick={() => setShowPanel(p => !p)}
          className="md:hidden absolute bottom-6 left-1/2 -translate-x-1/2 z-[1100] bg-slate-900/90 backdrop-blur-sm border border-slate-700 text-white text-xs font-bold px-5 py-2.5 rounded-full shadow-xl flex items-center gap-2"
        >
          {showPanel ? "✕ Tutup" : "📊 Info"}
        </button>
      </div>

      {/* ================= SIDEBAR ================= */}
      <div className={`fixed bottom-0 left-0 right-0 h-[78vh] z-[1500] bg-slate-950 border-t border-slate-700 rounded-t-2xl overflow-y-auto px-4 pt-2 pb-4 transition-transform duration-300 ease-in-out md:static md:w-[36%] md:h-auto md:overflow-y-auto md:p-6 md:border-t-0 md:border-l md:border-slate-800 md:rounded-none md:translate-y-0 md:flex-none ${showPanel ? "translate-y-0" : "translate-y-full"}`}>
        {/* Mobile drag handle */}
        <div className="md:hidden flex justify-center mb-3 pt-1">
          <div className="w-10 h-1 bg-slate-700 rounded-full" />
        </div>
        {/* PREDICTION TIME SELECTOR */}
        <div className="mb-5 bg-slate-900 p-3 rounded-xl border border-slate-800">
          <div className="flex items-center gap-2 mb-2">
            <Clock size={14} className="text-blue-400" />
            <p className="text-xs font-bold text-slate-400 uppercase">Mode Waktu</p>
          </div>
          <div className="flex gap-2">
            {[{label: "Sekarang", val: "now"}, {label: "15 Menit", val: "15"}, {label: "30 Menit", val: "30"}].map(opt => (
              <button
                key={opt.val}
                onClick={() => setPredictionMode(opt.val)}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-all ${
                  predictionMode === opt.val
                    ? "bg-blue-600 text-white shadow-lg shadow-blue-600/30"
                    : "bg-slate-800 text-slate-400 hover:bg-slate-700"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {predictionMode !== "now" && (
            <p className="text-[10px] text-blue-400 mt-2 flex items-center gap-1">
              <TrendingUp size={10} /> Prediksi {predictionMode} menit ke depan (Transformer AI)
            </p>
          )}
        </div>

        {/* ROUTE MODE SELECTOR */}
        <div className="mb-5 bg-slate-900 p-3 rounded-xl border border-slate-800">
          <div className="flex items-center gap-2 mb-2">
            <Route size={14} className="text-amber-400" />
            <p className="text-xs font-bold text-slate-400 uppercase">Mode Rute</p>
          </div>
          <div className="flex gap-2">
            {[
              { label: "Semua",    val: "all",  icon: "🗺️" },
              { label: "Non-Tol", val: "city", icon: "🏙️" },
              { label: "Tol",     val: "toll", icon: "🛣️" },
            ].map(opt => (
              <button
                key={opt.val}
                onClick={() => setRouteMode(opt.val)}
                className={`flex-1 px-2 py-2 rounded-lg text-xs font-bold transition-all flex flex-col items-center gap-0.5 ${
                  routeMode === opt.val
                    ? "bg-amber-600 text-white shadow-lg shadow-amber-600/30"
                    : "bg-slate-800 text-slate-400 hover:bg-slate-700"
                }`}
              >
                <span>{opt.icon}</span>
                <span>{opt.label}</span>
              </button>
            ))}
          </div>
          <p className="text-[10px] text-slate-500 mt-2">
            {routeMode === "city" && "🏙️ Rute jalan biasa — menghindari jalan tol"}
            {routeMode === "toll" && "🛣️ Menampilkan CCTV tol dalam kota Jakarta"}
            {routeMode === "all"  && "🗺️ Tampilkan semua CCTV & rute terbaik"}
          </p>
        </div>

        {/* PREDICTION RESULTS TABLE */}
        {predictionData && predictionMode !== "now" && !selected && !isRoutingActive && (
          <div className="mb-5">
            <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
              <TrendingUp size={18} className="text-blue-400" />
              Prediksi {predictionData.horizon} Menit
            </h2>
            <div className="space-y-2">
              {predictionData.predictions?.map(p => (
                <div key={p.location_id} className="bg-slate-900 p-3 rounded-xl border border-slate-800 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-bold">{p.name}</p>
                    <p className="text-xs text-slate-400">Saat ini: {p.current_vehicles} kendaraan</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-lg font-bold ${
                      p.status === "PADAT" ? "text-red-400" : p.status === "RAMAI" ? "text-yellow-400" : "text-emerald-400"
                    }`}>{p.predicted_vehicles}</p>
                    <p className={`text-[10px] font-bold ${
                      p.status === "PADAT" ? "text-red-400" : p.status === "RAMAI" ? "text-yellow-400" : "text-emerald-400"
                    }`}>{p.status}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* COMPARE MODE ─ sidebar ditampilkan saat chatbot trigger perbandingan */}
        {compareMode && !selected && !isRoutingActive && (
          <div className="mb-4">
            {/* Header compare */}
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <span className="text-blue-400">⚖️</span> Perbandingan Lokasi
              </h2>
              <button
                onClick={() => { setCompareMode(null); setHighlighted([]); }}
                className="text-xs text-slate-400 hover:text-white bg-slate-800 px-2 py-1 rounded-lg transition-colors"
              >
                ✕ Tutup
              </button>
            </div>

            {/* Label chatbot */}
            <p className="text-[10px] text-blue-400 mb-3 flex items-center gap-1">
              <span>🤖</span> Diaktifkan oleh AI Assistant
            </p>

            {/* 2 kolom per lokasi */}
            <div className="grid grid-cols-2 gap-3">
              {compareMode.ids.map((locId, colIdx) => {
                const d = compareData[locId];
                const colColor  = colIdx === 0 ? "#3b82f6" : "#8b5cf6"; // biru vs ungu
                const bgClass   = colIdx === 0
                  ? "border-blue-500/40 bg-blue-500/5"
                  : "border-violet-500/40 bg-violet-500/5";
                const nameColor = colIdx === 0 ? "text-blue-400" : "text-violet-400";

                if (!d) return (
                  <div key={locId} className={`rounded-xl border p-3 ${bgClass} flex items-center justify-center`}>
                    <span className="text-slate-500 text-xs">Memuat...</span>
                  </div>
                );

                const vehicles   = d.cctv?.vehicles ?? 0;
                const statusDot  = vehicles > 30 ? "🔴" : vehicles > 15 ? "🟡" : "🟢";
                const statusTxt  = vehicles > 30 ? "PADAT" : vehicles > 15 ? "RAMAI" : "LANCAR";
                const statusCls  = vehicles > 30 ? "text-red-400" : vehicles > 15 ? "text-yellow-400" : "text-emerald-400";
                const usual      = d.nowVsUsual ? Math.round(d.nowVsUsual.usual) : "—";
                const diffPct    = d.nowVsUsual?.diff_percent ?? null;

                return (
                  <div key={locId} className={`rounded-xl border p-3 ${bgClass}`}>
                    {/* Nama lokasi */}
                    <p className={`text-xs font-bold leading-tight mb-2 ${nameColor}`}>
                      {d.cctv?.name ?? `Lokasi ${locId}`}
                    </p>

                    {/* Kendaraan sekarang */}
                    <div className="flex items-end gap-1 mb-1">
                      <span className="text-2xl font-bold">{vehicles}</span>
                      <span className="text-xs text-slate-400 mb-0.5">kend.</span>
                    </div>

                    {/* Status badge */}
                    <p className={`text-[10px] font-bold mb-1 ${statusCls}`}>
                      {statusDot} {statusTxt}
                    </p>

                    {/* Biasanya */}
                    <p className="text-[10px] text-slate-400">
                      Biasanya: <span className="font-semibold text-slate-200">{usual}</span>
                      {diffPct !== null && (
                        <span className={diffPct > 0 ? " text-red-400" : " text-emerald-400"}>
                          {" "}{diffPct > 0 ? "▲" : "▼"}{Math.abs(diffPct)}%
                        </span>
                      )}
                    </p>

                    {/* Mini chart */}
                    {d.history?.length > 0 && (
                      <div className="mt-2">
                        <ResponsiveContainer width="100%" height={70}>
                          <AreaChart data={d.history} margin={{ top:2, right:0, left:0, bottom:0 }}>
                            <Area
                              type="monotone"
                              dataKey="avg_vehicle"
                              stroke={colColor}
                              fill={colColor}
                              fillOpacity={0.2}
                              strokeWidth={2}
                              dot={false}
                            />
                            <Tooltip
                              contentStyle={{ background:"#0f172a", border:"none", fontSize:"10px" }}
                              labelStyle={{ display:"none" }}
                              formatter={(v) => [`${v} kend.`]}
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                        <p className="text-[9px] text-slate-500 text-center mt-0.5">1 Jam Terakhir</p>
                      </div>
                    )}

                    {/* Klik untuk detail */}
                    <button
                      onClick={() => {
                        setSelected(d.cctv);
                        setCompareMode(null);
                        setHighlighted([]);
                      }}
                      className="mt-2 w-full text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded-lg transition-colors"
                    >
                      Detail →
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Kesimpulan singkat */}
            {compareMode.ids.length === 2 && compareData[compareMode.ids[0]] && compareData[compareMode.ids[1]] && (() => {
              const a = compareData[compareMode.ids[0]];
              const b = compareData[compareMode.ids[1]];
              const vA = a.cctv?.vehicles ?? 0;
              const vB = b.cctv?.vehicles ?? 0;
              const isTie = vA === vB;
              const winner = vA < vB ? a.cctv?.name : b.cctv?.name;
              return (
                <div className="mt-3 p-3 bg-slate-900 rounded-xl border border-slate-800">
                  <p className="text-xs text-slate-400">Kesimpulan AI</p>
                  {isTie ? (
                    <p className="text-sm font-bold text-blue-400 mt-0.5">
                      Keduanya sama-sama {vA > 30 ? "padat" : vA > 15 ? "ramai" : "lancar"}
                    </p>
                  ) : (
                    <p className="text-sm font-bold text-emerald-400 mt-0.5">
                      {winner} lebih lancar saat ini
                    </p>
                  )}
                  <p className="text-[10px] text-slate-400 mt-1">
                    Selisih: {Math.abs(vA - vB)} kendaraan
                  </p>
                </div>
              );
            })()}
          </div>
        )}

        {selected ? (
          <>
            <h2 className="text-2xl font-bold mb-1">{selected.name}</h2>
            <p className="text-slate-400 mb-4">{selected.vehicles} kendaraan saat ini</p>

            {nowVsUsual && (
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="bg-slate-900 p-4 rounded-xl">
                  <p className="text-xs text-slate-400">Sekarang</p>
                  <p className="text-2xl font-bold">{nowVsUsual.now}</p>
                </div>
                <div className="bg-slate-900 p-4 rounded-xl">
                  <p className="text-xs text-slate-400">Biasanya</p>
                  <p className="text-2xl font-bold">{Math.round(nowVsUsual.usual)}</p>
                </div>
              </div>
            )}
            

            <div className="mb-4 bg-slate-900 p-4 rounded-xl border border-slate-800">
              <div className="flex items-center gap-2">
                <AlertTriangle size={18} />
                <p className={`font-bold ${decisionColor}`}>{decisionLabel}</p>
              </div>
              <p className="text-xs text-slate-400 mt-1">{decisionNote}</p>
            </div>

            {/* ── REKOMENDASI SINYAL ADAPTIF — hanya jika ada lampu merah ── */}
            {selected.has_signal ? (() => {
              const rec = getSignalRec(selected.vehicles);
              return (
                <div className={`mb-4 p-4 rounded-xl border ${rec.bg}`}>
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-3">
                    🚦 Rekomendasi Sinyal Adaptif
                  </p>
                  <div className="flex items-center gap-4">
                    <TrafficLight active={rec.light} />
                    <div className="flex-1 min-w-0">
                      <p className={`font-bold text-sm ${rec.color}`}>{rec.label}</p>
                      <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">{rec.note}</p>
                      <div className="flex gap-3 mt-2">
                        <div className="text-center">
                          <p className="text-[9px] text-slate-500 uppercase">Hijau</p>
                          <p className="text-lg font-black text-emerald-400">{rec.green}<span className="text-xs font-normal text-slate-500">s</span></p>
                        </div>
                        <div className="w-px bg-slate-700" />
                        <div className="text-center">
                          <p className="text-[9px] text-slate-500 uppercase">Merah</p>
                          <p className="text-lg font-black text-red-400">{rec.red}<span className="text-xs font-normal text-slate-500">s</span></p>
                        </div>
                        <div className="w-px bg-slate-700" />
                        <div className="text-center">
                          <p className="text-[9px] text-slate-500 uppercase">Prioritas</p>
                          <p className={`text-sm font-black ${rec.color}`}>{rec.priority}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })() : (
              <div className="mb-4 p-4 rounded-xl border border-slate-800 bg-slate-900/50 flex items-center gap-3">
                <span className="text-2xl">🛣️</span>
                <div>
                  <p className="text-sm font-bold text-slate-400">Jalan Tol</p>
                  <p className="text-xs text-slate-500 mt-0.5">Tidak ada lampu merah — rekomendasi sinyal tidak berlaku di ruas tol.</p>
                </div>
              </div>
            )}

            {/* ── TomTom Kecepatan Jalan ── */}
            {tomtomFlow?.currentSpeed > 0 && (() => {
              const pct = Math.round((tomtomFlow.currentSpeed / Math.max(tomtomFlow.freeFlowSpeed, 1)) * 100);
              const speedColor = tomtomFlow.currentSpeed < 20 ? "text-red-400" : tomtomFlow.currentSpeed < 40 ? "text-yellow-400" : "text-emerald-400";
              const barColor   = pct < 40 ? "bg-red-500" : pct < 70 ? "bg-yellow-500" : "bg-emerald-500";
              return (
                <div className="mb-4 bg-slate-900 p-4 rounded-xl border border-slate-800">
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-3">
                    🛰️ Kecepatan Jalan (TomTom)
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-[9px] text-slate-500 uppercase">Sekarang</p>
                      <p className={`text-2xl font-black ${speedColor}`}>
                        {tomtomFlow.currentSpeed}<span className="text-xs font-normal text-slate-500"> km/j</span>
                      </p>
                    </div>
                    <div>
                      <p className="text-[9px] text-slate-500 uppercase">Bebas Hambatan</p>
                      <p className="text-2xl font-black text-slate-300">
                        {tomtomFlow.freeFlowSpeed}<span className="text-xs font-normal text-slate-500"> km/j</span>
                      </p>
                    </div>
                  </div>
                  <div className="mt-2">
                    <div className="flex justify-between text-[9px] text-slate-500 mb-1">
                      <span>Efisiensi Lajur</span>
                      <span>{pct}%</span>
                    </div>
                    <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                  </div>
                  <p className="text-[9px] text-slate-600 mt-2">Sumber: TomTom Traffic Flow API</p>
                </div>
              );
            })()}

            <div className="bg-slate-900 rounded-xl p-4">
              <p className="text-xs text-slate-400 mb-2">
                Traffic Stability & Volatility (1 Jam Terakhir)
              </p>
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={history}>
                  <CartesianGrid stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="#64748b" />
                  <YAxis stroke="#64748b" />
                  <Tooltip />
                  <Area type="natural" dataKey="avg_vehicle" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.25} strokeWidth={3} />
                  <Line type="monotone" dataKey="volatility" stroke="#ef4444" strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <Link to="/admin" className="mt-6 block text-center bg-slate-800 py-3 rounded-xl font-bold">
              Admin Dashboard
            </Link>
          </>
        ) : isRoutingActive ? (
          <>
            <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
              <Route size={20} /> Informasi Rute
            </h2>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="bg-slate-900 p-4 rounded-xl">
                <p className="text-xs text-slate-400">ETA</p>
                <p className="text-2xl font-bold">{eta?.time} menit</p>
              </div>
              <div className="bg-slate-900 p-4 rounded-xl">
                <p className="text-xs text-slate-400">Jarak</p>
                <p className="text-2xl font-bold">{eta?.distance} km</p>
              </div>
            </div>

            {/* ── Kondisi Rute: Sekarang → 1 Jam Lagi (unified) ── */}
            <div className="mb-4 bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
              <p className="text-[10px] text-slate-500 uppercase font-bold px-4 pt-3 pb-2">
                Kondisi Rute
              </p>
              <div className="flex divide-x divide-slate-800">
                {/* Sekarang */}
                <div className="flex-1 px-4 pb-4">
                  <p className="text-[9px] text-slate-500 uppercase mb-1">Sekarang</p>
                  <p className={`font-bold text-sm ${routeDecisionColor}`}>{routeDecisionLabel}</p>
                  <p className="text-[10px] text-slate-400 mt-1 leading-snug">{routeDecisionNote}</p>
                </div>

                {/* Arrow */}
                <div className="flex items-center px-3 text-slate-600 text-lg select-none">→</div>

                {/* 1 Jam Lagi */}
                <div className="flex-1 px-4 pb-4">
                  <p className="text-[9px] text-slate-500 uppercase mb-1">1 Jam Lagi</p>
                  {nextHourPrediction ? (
                    <>
                      <p className={`font-bold text-sm ${predictionStyle(nextHourPrediction.status).color}`}>
                        {predictionStyle(nextHourPrediction.status).icon} {nextHourPrediction.label}
                      </p>
                      <p className="text-[10px] text-slate-400 mt-1">
                        {nextHourPrediction.now} → {nextHourPrediction.predicted} kend.{" "}
                        <span className={nextHourPrediction.change_percent < 0 ? "text-emerald-400 font-bold" : "text-red-400 font-bold"}>
                          {nextHourPrediction.change_percent > 0 ? "+" : ""}{nextHourPrediction.change_percent}%
                        </span>
                      </p>
                    </>
                  ) : (
                    <p className="text-[10px] text-slate-500">Memuat...</p>
                  )}
                </div>
              </div>

              {/* Footer */}
              {nextHourPrediction && (
                <div className="px-4 py-2 border-t border-slate-800 flex justify-between items-center">
                  <p className="text-[9px] text-slate-500 italic">{nextHourPrediction.note}</p>
                  <span className="text-[9px] text-slate-600">Confidence: {nextHourPrediction.confidence}</span>
                </div>
              )}
            </div>

          </>
        ) : (
          <div className="h-full flex items-center justify-center text-slate-500 text-center">
            Klik peta untuk routing<br />
            atau klik CCTV untuk analisis lalu lintas
          </div>
        )}
      </div>
    </div>
    {/* Chat UI */}
    <ChatPopup
      visible={showChat}
      onClose={() => setShowChat(false)}
      onMapCommands={executeMapCommands}
    />
    <ChatButton onOpen={() => setShowChat(true)} />
    </>
  );
}

/* Chat UI injected at root */
// Render chat button and popup via portal-like placement inside App's JSX tree
