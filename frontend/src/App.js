import React, { useEffect, useState, useCallback, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { io } from "socket.io-client";

import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  Polygon,
  Circle,
  Tooltip as LeafletTooltip,
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

/* ─── Point-in-polygon (ray casting) untuk cek rute vs zona banjir ──────── */
function pointInPolygon(lat, lng, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > lng) !== (yj > lng) && lat < ((xj - xi) * (lng - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
function checkRouteFloodZones(coords) {
  const seen = new Set(), affected = [];
  for (const [lat, lng] of coords) {
    for (const z of FLOOD_ZONES) {
      if (!seen.has(z.name) && pointInPolygon(lat, lng, z.coords)) { affected.push(z); seen.add(z.name); }
    }
  }
  return affected.sort((a, b) => ({ HIGH:0, MEDIUM:1, LOW:2 }[a.risk] - { HIGH:0, MEDIUM:1, LOW:2 }[b.risk]));
}

/* ─── Zona Rawan Banjir (BPBD DKI Jakarta) ──────────────────────────────── */
const FLOOD_ZONES = [
  // HIGH RISK
  { name: 'Pluit – Penjaringan',        risk: 'HIGH',   coords: [[-6.108,106.790],[-6.108,106.825],[-6.133,106.825],[-6.133,106.790]] },
  { name: 'Cengkareng – Kalideres',     risk: 'HIGH',   coords: [[-6.109,106.706],[-6.109,106.748],[-6.154,106.748],[-6.154,106.706]] },
  { name: 'Kampung Melayu – Bukit Duri',risk: 'HIGH',   coords: [[-6.218,106.855],[-6.218,106.880],[-6.248,106.880],[-6.248,106.855]] },
  { name: 'Rawa Buaya – Cengkareng Barat', risk: 'HIGH', coords: [[-6.118,106.718],[-6.118,106.745],[-6.148,106.745],[-6.148,106.718]] },
  // MEDIUM RISK
  { name: 'Kelapa Gading',              risk: 'MEDIUM', coords: [[-6.138,106.880],[-6.138,106.922],[-6.170,106.922],[-6.170,106.880]] },
  { name: 'Grogol – Tanjung Duren',     risk: 'MEDIUM', coords: [[-6.158,106.773],[-6.158,106.802],[-6.190,106.802],[-6.190,106.773]] },
  { name: 'Jatinegara – Cakung',        risk: 'MEDIUM', coords: [[-6.188,106.888],[-6.188,106.942],[-6.218,106.942],[-6.218,106.888]] },
  { name: 'Manggarai – Tebet',          risk: 'MEDIUM', coords: [[-6.218,106.838],[-6.218,106.858],[-6.240,106.858],[-6.240,106.838]] },
  // LOW RISK
  { name: 'Cilincing',                  risk: 'LOW',    coords: [[-6.098,106.910],[-6.098,106.952],[-6.135,106.952],[-6.135,106.910]] },
  { name: 'Pasar Minggu – Pejaten',     risk: 'LOW',    coords: [[-6.278,106.835],[-6.278,106.870],[-6.312,106.870],[-6.312,106.835]] },
];
const FLOOD_RISK_COLOR = { HIGH: '#ef4444', MEDIUM: '#f97316', LOW: '#eab308' };
const FLOOD_RISK_LABEL = { HIGH: 'Risiko Tinggi', MEDIUM: 'Risiko Sedang', LOW: 'Risiko Rendah' };

/* ─── Koridor Tol & Tarif (Golongan I — sedan/jeep) ─────────────────────── */
/* ─── Koridor Tol & Tarif Resmi (Golongan I) ─────────────────────────────── */
const TOLL_CORRIDORS = [
  { id:'kg-pg',      name:'Tol KG–PG',           camIds:[29,30,31,32,33,34],                                          price:9000  },
  { id:'bckm-caw',   name:'Tol BCKM — Cawang',   camIds:[35],                                                        price:4500  },
  { id:'bckm-bks',   name:'Tol BCKM — Bks Barat',camIds:[36,37],                                                    price:7000  },
  { id:'bckm-seg',   name:'Tol BCKM Segmen',      camIds:[65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80],          price:6000  },
  { id:'bks-tmr',    name:'Tol Bekasi Timur',      camIds:[43],                                                        price:4500  },
  { id:'jorr-w2',    name:'Tol JORR W2',           camIds:[51,52,53,54,55,56,57,58,59,60,61,62,63,64],                price:8500  },
  { id:'jorr-e1',    name:'Tol JORR E1',           camIds:[81,82,83,84,85,86],                                         price:9500  },
  { id:'jorr-sel',   name:'Tol JORR Selatan',      camIds:[89,90,91,92,93,94,95,96,97,98,99,100],                     price:12000 },
  { id:'dalam-kota', name:'Tol Dalam Kota',        camIds:[87,88],                                                     price:9500  },
];

/* ─── Jenis Kendaraan & Konsumsi BBM (L/100km) ───────────────────────────── */
const VEHICLE_TYPES = [
  { id:'motor', label:'🏍️ Motor',   consumption:4,  tollFactor:0.5 },
  { id:'sedan', label:'🚗 Mobil',   consumption:11, tollFactor:1.0 },
  { id:'suv',   label:'🚙 SUV/MPV', consumption:14, tollFactor:1.0 },
  { id:'bus',   label:'🚌 Bus',     consumption:22, tollFactor:2.0 },
  { id:'truck', label:'🚚 Truk',    consumption:28, tollFactor:2.5 },
];
const FUEL_TYPES = [
  { id:'pertalite', label:'Pertalite', price:10000 },
  { id:'pertamax',  label:'Pertamax',  price:16250 },
  { id:'solar',     label:'Solar',     price:6800  },
];

/* ─── Flood risk helpers ─────────────────────────────────────────────────── */
const FLOOD_RISK_ORDER = { HIGH: 2, MEDIUM: 1, LOW: 0 };
const FLOOD_RISK_NAMES = ['LOW', 'MEDIUM', 'HIGH'];
const elevateRisk = (risk, steps) =>
  FLOOD_RISK_NAMES[Math.min(2, FLOOD_RISK_ORDER[risk] + steps)];

function floodScoreForRoute(coords, dynamicRisk) {
  const zones = checkRouteFloodZones(coords);
  return zones.reduce((s, z) => s + ({ HIGH: 3, MEDIUM: 2, LOW: 1 }[dynamicRisk[z.name] || z.risk] ?? 0), 0);
}

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
const INCIDENT_EMOJI = { 1: "💥", 6: "🐢", 7: "🚧", 8: "⛔", 9: "🔧", 11: "🌊", 14: "🚗" };

const incidentIcon = (category) => {
  const color = [1, 8].includes(category) ? "#ef4444" : [6].includes(category) ? "#f97316" : "#f59e0b";
  // Segitiga peringatan — tidak mirip kotak sinyal lalu lintas
  return L.divIcon({
    className: "",
    html: `<div style="width:0;height:0;border-left:9px solid transparent;border-right:9px solid transparent;border-bottom:16px solid ${color};filter:drop-shadow(0 1px 3px rgba(0,0,0,.6));position:relative;">
      <span style="position:absolute;top:3px;left:-4px;font-size:7px;font-weight:900;color:#fff;line-height:1;">!</span>
    </div>`,
    iconSize: [18, 16], iconAnchor: [9, 16],
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

/* ================= FIT BOUNDS HANDLER (route) ================= */
function FitBoundsHandler({ segments }) {
  const map = useMap();
  const prevKey = useRef(0);
  useEffect(() => {
    if (!segments || segments.length === 0) { prevKey.current = 0; return; }
    const key = segments.length;
    if (key === prevKey.current) return;
    prevKey.current = key;
    const allPoints = segments.flatMap(s => s.points);
    if (allPoints.length > 0) {
      map.fitBounds(allPoints, {
        paddingTopLeft:     [340, 70],
        paddingBottomRight: [30, 30],
        animate: true,
        duration: 1.0,
      });
    }
  }, [segments, map]);
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

  const [liveYolo, setLiveYolo] = useState(null);

  // ── Chatbot map control state ──────────────────────────────────────────────
  const [highlighted, setHighlighted]   = useState([]);   // array location_id — pin biru chatbot
  const [mapFlyTo,    setMapFlyTo]      = useState(null); // { lat, lng } — auto-zoom
  const [compareMode, setCompareMode]   = useState(null); // { ids:[1,5] } — sidebar compare
  const [compareData, setCompareData]   = useState({});
  const [showPanel, setShowPanel]        = useState(false);
  const [voiceEnabled, setVoiceEnabled]  = useState(false);
  const [altRoutes, setAltRoutes]         = useState([]);   // [{segments,eta,steps,condition,condColor,coords}]
  const [activeRouteIdx, setActiveRouteIdx] = useState(0);
  const notifConditionRef = useRef(null);
  const notifiedIncidentsRef = useRef(new Set());
  const [notifEnabled, setNotifEnabled]   = useState(false);

  // Overlay banjir
  const [showFlood, setShowFlood]         = useState(false);


  // Estimasi tarif tol + BBM + kendaraan (persistent via localStorage)
  const [tollEstimate, setTollEstimate]   = useState(null);
  const [fuelEstimate, setFuelEstimate]   = useState(null);
  const [vehicleType, setVehicleType]     = useState(() => localStorage.getItem('jak_vehicle') || 'sedan');
  const [fuelType, setFuelType]           = useState(() => localStorage.getItem('jak_fuel')    || 'pertalite');
  const [floodWarning, setFloodWarning]   = useState([]); // zona banjir di sepanjang rute
  const [weatherData, setWeatherData]     = useState(null); // BMKG via wttr.in
  const [dynamicFloodRisk, setDynamicFloodRisk] = useState({}); // zone.name → elevated risk
  const dynamicFloodRiskRef = useRef({});  // ref agar fetchRoute dapat nilai terbaru
  useEffect(() => { dynamicFloodRiskRef.current = dynamicFloodRisk; }, [dynamicFloodRisk]);
  const [showTripSummary, setShowTripSummary] = useState(false); // modal ringkasan
  const [tripSummaryData, setTripSummaryData] = useState(null);
  const routeCoordsRef                    = useRef([]);
  const [routeCameras, setRouteCameras]   = useState([]); // CCTV along active route

  // WebSocket
  const [wsConnected, setWsConnected]     = useState(false);
  const socketRef = useRef(null);

  // Geocoding search
  const [searchFrom, setSearchFrom]       = useState('');
  const [searchTo,   setSearchTo]         = useState('');
  const [searchHits, setSearchHits]       = useState([]);
  const [searchTarget, setSearchTarget]   = useState(null); // 'from' | 'to'
  const searchTimer = useRef(null);

  /* ================= VOICE (Web Speech API) ================= */
  const voiceEnabledRef = useRef(false);
  useEffect(() => { voiceEnabledRef.current = voiceEnabled; }, [voiceEnabled]);

  // Aktif/nonaktif voice — umumkan konfirmasi
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    if (voiceEnabled) {
      window.speechSynthesis.cancel();
      const utt = new SpeechSynthesisUtterance('Panduan suara diaktifkan.');
      utt.lang = 'id-ID'; utt.rate = 0.92;
      const doSpeak = () => {
        const v = window.speechSynthesis.getVoices();
        const id = v.find(x => x.lang === 'id-ID') || v.find(x => x.lang.startsWith('id'));
        if (id) utt.voice = id;
        window.speechSynthesis.speak(utt);
      };
      window.speechSynthesis.getVoices().length === 0
        ? window.speechSynthesis.addEventListener('voiceschanged', doSpeak, { once: true })
        : doSpeak();
    } else {
      window.speechSynthesis.cancel();
    }
  }, [voiceEnabled]);

  const speak = useCallback((text, interrupt = true) => {
    if (!voiceEnabledRef.current || !('speechSynthesis' in window)) return;
    if (interrupt) window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = 'id-ID'; utt.rate = 0.92; utt.pitch = 1.0;
    const doSpeak = () => {
      const voices = window.speechSynthesis.getVoices();
      const id = voices.find(v => v.lang === 'id-ID') || voices.find(v => v.lang.startsWith('id'));
      if (id) utt.voice = id;
      window.speechSynthesis.speak(utt);
    };
    window.speechSynthesis.getVoices().length === 0
      ? window.speechSynthesis.addEventListener('voiceschanged', doSpeak, { once: true })
      : doSpeak();
  }, []);

  const speakAllSteps = useCallback(() => {
    if (!('speechSynthesis' in window) || routeSteps.length === 0) return;
    window.speechSynthesis.cancel();
    routeSteps.forEach(step => {
      const utt = new SpeechSynthesisUtterance(
        `${maneuverLabel(step.type, step.modifier)}${step.name ? ' di ' + step.name : ''}, sejauh ${fmtDist(step.distance)}.`
      );
      utt.lang = 'id-ID'; utt.rate = 0.92;
      const doSpeak = () => {
        const voices = window.speechSynthesis.getVoices();
        const id = voices.find(v => v.lang === 'id-ID') || voices.find(v => v.lang.startsWith('id'));
        if (id) utt.voice = id;
        window.speechSynthesis.speak(utt);
      };
      window.speechSynthesis.getVoices().length === 0
        ? window.speechSynthesis.addEventListener('voiceschanged', doSpeak, { once: true })
        : doSpeak();
    });
  }, [routeSteps]);

  const toggleNotif = useCallback(async () => {
    if (notifEnabled) { setNotifEnabled(false); return; }
    if (!('Notification' in window)) { alert('Browser tidak mendukung notifikasi.'); return; }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      setNotifEnabled(true);
      new Notification('JakTraffic AI 🚦', { body: 'Notifikasi lalu lintas diaktifkan. Anda akan diberi tahu saat kondisi rute berubah.', icon: '/favicon.ico' });
    }
  }, [notifEnabled]);

  /* ================= GEOCODING (Nominatim) ================= */
  const geocodeSearch = useCallback(async (query, target) => {
    if (!query || query.length < 2) { setSearchHits([]); return; }
    try {
      const res = await axios.get('https://nominatim.openstreetmap.org/search', {
        params: {
          q: query,
          format: 'json',
          limit: 5,
          viewbox: '106.3,-5.85,107.35,-6.65',
          bounded: 0,
          countrycodes: 'id',
          addressdetails: 1,
          'accept-language': 'id',
        },
        headers: { 'User-Agent': 'JakTrafficAI/1.0' },
        timeout: 5000,
      });
      setSearchHits(res.data);
      setSearchTarget(target);
    } catch { setSearchHits([]); }
  }, []);

  const handleSearchInput = useCallback((value, target) => {
    if (target === 'from') setSearchFrom(value);
    else setSearchTo(value);
    setSearchTarget(target);
    clearTimeout(searchTimer.current);
    if (!value.trim()) { setSearchHits([]); return; }
    searchTimer.current = setTimeout(() => geocodeSearch(value, target), 400);
  }, [geocodeSearch]);

  const selectGeoResult = useCallback((result) => {
    const latlng = { lat: parseFloat(result.lat), lng: parseFloat(result.lon) };
    const shortName = result.display_name.split(',').slice(0, 2).join(',').trim();
    if (searchTarget === 'from') {
      setStartPoint(latlng);
      setSearchFrom(shortName);
      setRouteNames(prev => ({ from: shortName, to: prev?.to || '' }));
    } else {
      setEndPoint(latlng);
      setSearchTo(shortName);
      setRouteNames(prev => ({ from: prev?.from || '', to: shortName }));
    }
    setSearchHits([]);
    setMapFlyTo({ ...latlng, zoom: 15 });
    setTimeout(() => setMapFlyTo(null), 3500);
  }, [searchTarget]);

  // Sync search inputs saat routeNames diset oleh LLM
  useEffect(() => {
    if (routeNames?.from) setSearchFrom(routeNames.from);
    if (routeNames?.to)   setSearchTo(routeNames.to);
  }, [routeNames]);

  // Hapus search input saat point dihapus (reset rute)
  useEffect(() => { if (!startPoint) setSearchFrom(''); }, [startPoint]);
  useEffect(() => { if (!endPoint)   setSearchTo('');   }, [endPoint]);

  /* ================= WEBSOCKET ================= */
  useEffect(() => {
    const base = process.env.REACT_APP_API_URL || window.location.origin;
    const socket = io(base, {
      transports: ['websocket', 'polling'],
      reconnectionDelay: 3000,
      reconnectionAttempts: 15,
    });
    socketRef.current = socket;
    socket.on('connect',    ()     => setWsConnected(true));
    socket.on('disconnect', ()     => setWsConnected(false));
    socket.on('traffic_update', (data) => {
      if (Array.isArray(data)) {
        setCctv(data);
        cctvRef.current = data;
      }
    });
    return () => socket.disconnect();
  }, []);

  // Persistensi pilihan kendaraan & BBM
  useEffect(() => { localStorage.setItem('jak_vehicle', vehicleType); }, [vehicleType]);
  useEffect(() => { localStorage.setItem('jak_fuel',    fuelType);    }, [fuelType]);

  /* ================= CUACA JAKARTA (BMKG via wttr.in) ================= */
  useEffect(() => {
    const fetchWeather = () =>
      axios.get(`${API}/api/weather-jakarta`).then(r => setWeatherData(r.data)).catch(() => {});
    fetchWeather();
    const t = setInterval(fetchWeather, 30 * 60 * 1000); // refresh tiap 30 menit
    return () => clearInterval(t);
  }, []);

  /* ================= DYNAMIC FLOOD RISK (TomTom + cuaca) ================= */
  useEffect(() => {
    const dynamic = {};
    FLOOD_ZONES.forEach(zone => {
      const lats = zone.coords.map(c => c[0]);
      const lngs = zone.coords.map(c => c[1]);
      const cLat = (Math.max(...lats) + Math.min(...lats)) / 2;
      const cLng = (Math.max(...lngs) + Math.min(...lngs)) / 2;
      let risk = zone.risk;
      // Elevate jika ada TomTom incident banjir (cat 11) dalam radius 3km
      const hasFloodInc = tomtomIncidents.some(
        inc => inc.category === 11 && inc.lat && inc.lng &&
               haversineDistance(cLat, cLng, inc.lat, inc.lng) < 3000
      );
      if (hasFloodInc) risk = elevateRisk(risk, 1);
      // Elevate berdasarkan curah hujan BMKG
      if (weatherData?.heavy_rain)              risk = elevateRisk(risk, 1);
      else if (weatherData?.is_raining && risk === 'LOW') risk = 'MEDIUM';
      dynamic[zone.name] = risk;
    });
    setDynamicFloodRisk(dynamic);
  }, [tomtomIncidents, weatherData]);

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
    // Polling as fallback — WebSocket is primary source
    const i = setInterval(load, 90000);
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
      setAltRoutes([]); setActiveRouteIdx(0); setTollEstimate(null); setFuelEstimate(null); setRouteCameras([]); setFloodWarning([]); routeCoordsRef.current = [];
    }
  };

  const filteredCctv = (routeMode === "all" ? cctv : cctv.filter(c => (c.road_type || "city") === routeMode))
    .filter(c => c.lat != null && c.lng != null);

  /* ================= TOLL ROAD CORRIDOR OVERLAY ================= */
  useEffect(() => {
    if (!cctv.length) return;
    const tollCams = cctv.filter(c => c.road_type === "toll");
    if (!tollCams.length) return;

    const byName = (keyword) => tollCams
      .filter(c => c.name?.includes(keyword))
      .sort((a, b) => a.lng - b.lng);

    const fetchCorridor = async (cameras, color, name) => {
      if (cameras.length < 2) return null;
      // Batasi maksimal 10 waypoint agar OSRM tidak timeout
      const step  = Math.max(1, Math.floor(cameras.length / 10));
      const picks = cameras.filter((_, i) => i % step === 0 || i === cameras.length - 1);
      const wpStr = picks.map(c => `${c.lng},${c.lat}`).join(";");
      try {
        const res = await axios.get(
          `https://router.project-osrm.org/route/v1/driving/${wpStr}?overview=full&geometries=geojson`,
          { timeout: 8000 }
        );
        const coords = res.data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
        return { name, color, points: coords };
      } catch { return null; }
    };

    Promise.all([
      fetchCorridor(byName("KG-PG"),         "#f59e0b", "Tol KG-PG — Kelapa Gading–Pulo Gebang"),
      fetchCorridor(byName("BCKM - "),        "#fb923c", "Tol BCKM — Cawang–Bekasi"),
      fetchCorridor(byName("BCKM Segmen"),    "#f97316", "Tol BCKM Segmen — Duren Sawit–Bekasi Barat"),
      fetchCorridor(byName("JORR W2"),        "#a78bfa", "Tol JORR W2 — Cengkareng–Ulujami"),
      fetchCorridor(byName("JORR E1"),        "#34d399", "Tol JORR E1 — Cilincing–Cibitung"),
      fetchCorridor(byName("JORR Selatan"),   "#60a5fa", "Tol JORR Selatan — Pondok Pinang–Cikunir"),
      fetchCorridor(byName("Tol Dalam Kota"), "#f472b6", "Tol Dalam Kota"),
      fetchCorridor(byName("Tol Bekasi"),     "#22d3ee", "Tol Bekasi"),
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

        const excludeParam = routeMode === "city" ? "&exclude=motorway" : "";

        // ── Step 1: Fetch dengan alternatives ─────────────────────────
        const initUrl = `https://router.project-osrm.org/route/v1/driving/${startPoint.lng},${startPoint.lat};${endPoint.lng},${endPoint.lat}?overview=full&geometries=geojson&steps=true&alternatives=3${excludeParam}`;
        const initRes = await axios.get(initUrl);
        const osrmRoutes = initRes.data.routes;

        // ── Helper: bangun segmen berwarna ─────────────────────────────
        const ZONE_R = 400;
        const getSegStyle = (lat, lng) => {
          const inZone = filteredCctv.filter(c => haversineDistance(lat, lng, c.lat, c.lng) <= ZONE_R);
          if (inZone.length > 0) {
            const worst = inZone.reduce((a, b) => getVehiclesForCCTV(a) >= getVehiclesForCCTV(b) ? a : b);
            return { color: getTrafficColor(getVehiclesForCCTV(worst)), dashed: false };
          }
          const nearest = findNearestCCTV({ lat, lng }, filteredCctv);
          return { color: nearest ? getTrafficColor(getVehiclesForCCTV(nearest)) : "#94a3b8", dashed: true };
        };
        const buildSegments = (coords) => {
          const segs = [];
          let cur = getSegStyle(coords[0][0], coords[0][1]);
          let pts = [coords[0]];
          for (let i = 1; i < coords.length; i++) {
            const s = getSegStyle(coords[i][0], coords[i][1]);
            if (s.color !== cur.color || s.dashed !== cur.dashed) {
              pts.push(coords[i]);
              segs.push({ points: [...pts], color: cur.color, dashed: cur.dashed });
              pts = [coords[i]]; cur = s;
            } else { pts.push(coords[i]); }
          }
          if (pts.length) segs.push({ points: pts, color: cur.color, dashed: cur.dashed });
          return segs;
        };

        // ── Step 2: Proses semua alternatif (simplified) ──────────────
        const midLat = (startPoint.lat + endPoint.lat) / 2;
        const midLng = (startPoint.lng + endPoint.lng) / 2;
        const midCCTV0 = findNearestCCTV({ lat: midLat, lng: midLng }, filteredCctv);

        const processedAlts = osrmRoutes.map((r) => {
          const coords = r.geometry.coordinates.map(c => [c[1], c[0]]);
          const segs   = buildSegments(coords);
          const mult   = midCCTV0 ? trafficMult(midCCTV0) : 1;
          const tMin   = Math.round((r.duration / 60) * mult);
          const tKm    = (r.distance / 1000).toFixed(1);
          const hasRed = segs.some(s => s.color === "#ef4444");
          const hasOrg = segs.some(s => s.color === "#f97316");
          const cond   = hasRed ? 'padat' : hasOrg ? 'ramai' : 'lancar';
          const cColor = hasRed ? '#f43f5e' : hasOrg ? '#f59e0b' : '#10b981';
          const steps  = r.legs.flatMap(l => l.steps ?? []).map(s => ({
            type: s.maneuver.type, modifier: s.maneuver.modifier ?? "straight",
            name: s.name || "", distance: s.distance,
          }));
          return { segments: segs, eta: { time: tMin, distance: tKm }, condition: cond, condColor: cColor, steps, coords };
        });

        // ── Step 3: Full processing untuk primary route (waypoints + ETA per-leg) ──
        const initCoords = osrmRoutes[0].geometry.coordinates.map(c => [c[1], c[0]]);
        const intermediates = detectIntermediateCCTVs(initCoords, filteredCctv, startPoint, endPoint);

        let route = osrmRoutes[0];
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

        const fullSegments = buildSegments(coords);
        const legs = route.legs;
        const allWaypoints = [startPoint, ...intermediates, endPoint];
        let cumMin = 0, cumKm = 0;
        const newWaypointETAs = [];

        for (let i = 0; i < legs.length; i++) {
          const wpStart = allWaypoints[i];
          const wpEnd   = allWaypoints[i + 1];
          const mLat = (wpStart.lat + wpEnd.lat) / 2;
          const mLng = (wpStart.lng + wpEnd.lng) / 2;
          const mCCTV = findNearestCCTV({ lat: mLat, lng: mLng }, filteredCctv);
          const mult  = mCCTV ? trafficMult(mCCTV) : 1;
          const legMin = Math.round((legs[i].duration / 60) * mult);
          const legKm  = (legs[i].distance / 1000).toFixed(1);
          cumMin += legMin;
          cumKm  += legs[i].distance / 1000;
          if (i < intermediates.length) {
            newWaypointETAs.push({ cctv_id: intermediates[i].id, lat: intermediates[i].lat, lng: intermediates[i].lng, segment_min: legMin, segment_km: legKm });
          } else if (intermediates.length > 0) {
            newWaypointETAs.push({ cctv_id: "destination", lat: endPoint.lat, lng: endPoint.lng, segment_min: legMin, segment_km: legKm, isDestination: true });
          }
        }

        const allSteps = legs.flatMap(l => l.steps ?? []);
        const mappedSteps = allSteps.map(s => ({
          type: s.maneuver.type, modifier: s.maneuver.modifier ?? "straight",
          name: s.name || "", distance: s.distance,
        }));

        // Update primary route dengan full data
        processedAlts[0] = { ...processedAlts[0], segments: fullSegments, eta: { time: cumMin, distance: cumKm.toFixed(1) }, steps: mappedSteps };

        // ── Simpan coords untuk rekalkulasi saat vehicle/fuel berubah ────────
        routeCoordsRef.current = coords;

        // ── Kamera CCTV sepanjang rute (radius 500m, semua kamera) ────────
        const routeCams = cctv.filter(cam =>
          cam.lat != null && cam.lng != null &&
          coords.some(([lat, lng]) => haversineDistance(lat, lng, cam.lat, cam.lng) < 500)
        );
        setRouteCameras(routeCams);

        // ── Estimasi tarif tol + faktor kendaraan ─────────────────────────
        const veh0 = VEHICLE_TYPES.find(v => v.id === vehicleType) || VEHICLE_TYPES[1];
        const tolledCors = TOLL_CORRIDORS.filter(tc =>
          tc.camIds.some(cid => {
            const cam = cctv.find(c => c.id === cid);
            if (!cam || !cam.lat || !cam.lng) return false;
            return coords.some(([lat, lng]) => haversineDistance(lat, lng, cam.lat, cam.lng) < 700);
          })
        );
        const tollTotal = Math.round(tolledCors.reduce((s, t) => s + t.price, 0) * veh0.tollFactor);
        setTollEstimate(tolledCors.length ? { corridors: tolledCors, total: tollTotal } : null);

        // ── Estimasi konsumsi BBM ──────────────────────────────────────────
        const fuel0 = FUEL_TYPES.find(f => f.id === fuelType) || FUEL_TYPES[0];
        const fuelLiters0 = Math.round((cumKm * veh0.consumption / 100) * 10) / 10;
        setFuelEstimate({ liters: fuelLiters0, cost: Math.round(fuelLiters0 * fuel0.price), fuelLabel: fuel0.label });

        // ── Periksa zona banjir di sepanjang rute ─────────────────────────
        const dynRisk   = dynamicFloodRiskRef.current;
        const floodZones = checkRouteFloodZones(coords);
        setFloodWarning(floodZones);
        if (floodZones.length > 0 && notifEnabled) {
          new Notification('🌊 Peringatan Banjir — JakTraffic', {
            body: `Rute melewati ${floodZones.length} zona rawan banjir: ${floodZones.map(z => z.name).join(', ')}.`,
            icon: '/favicon.ico',
          });
        }

        // ── ETA adaptif berdasarkan risiko banjir aktual ──────────────
        let etaFloodMult = 1.0;
        let floodEtaNote = null;
        if (floodZones.length > 0) {
          const worstEffective = (dynRisk[floodZones[0].name] || floodZones[0].risk);
          if (worstEffective === 'HIGH')   { etaFloodMult = 1.35; floodEtaNote = '+35% dampak banjir'; }
          else if (worstEffective === 'MEDIUM') { etaFloodMult = 1.18; floodEtaNote = '+18% potensi kemacetan'; }
        }
        const adjustedCumMin = Math.round(cumMin * etaFloodMult);

        // ── Flood score per alternatif (badge di tab rute) ────────────
        const scoredAlts = processedAlts.map((r, idx) => {
          const rCoords  = r.coords || (idx === 0 ? coords : []);
          const fScore   = floodScoreForRoute(rCoords, dynRisk);
          const isSafest = fScore === 0;
          return { ...r, floodScore: fScore, floodSafe: isSafest };
        });

        setAltRoutes(scoredAlts);
        setActiveRouteIdx(0);
        setRouteSegments(fullSegments);
        setWaypointETAs(newWaypointETAs);
        setEta({ time: adjustedCumMin, distance: cumKm.toFixed(1), floodNote: floodEtaNote, baseTime: cumMin });
        setRouteSteps(mappedSteps);

        // ── Voice — informasi lengkap: rute + tol + BBM + banjir ─────────
        const fromName  = routeNames?.from || 'titik awal';
        const toName    = routeNames?.to   || 'tujuan';
        const altText   = processedAlts.length > 1 ? ` Ada ${processedAlts.length} pilihan rute.` : '';
        const tollText  = tolledCors.length ? ` Estimasi tarif tol Rp ${tollTotal.toLocaleString('id-ID')}.` : '';
        const fuelTxt   = ` Konsumsi bensin sekitar ${fuelLiters0} liter atau Rp ${Math.round(fuelLiters0 * fuel0.price).toLocaleString('id-ID')}.`;
        const floodTxt  = floodZones.length > 0 ? ` Perhatian! Rute melewati zona rawan banjir ${floodZones[0].name}${floodEtaNote ? ', ETA disesuaikan.' : '.'}` : '';
        const safeAlt   = scoredAlts.findIndex((r, i) => i > 0 && r.floodScore < (scoredAlts[0].floodScore || 99));
        const safeAltTxt = safeAlt > 0 ? ` Rute ${safeAlt + 1} lebih aman dari banjir.` : '';
        const firstStep = mappedSteps[0];
        const firstTxt  = firstStep ? ` ${maneuverLabel(firstStep.type, firstStep.modifier)}${firstStep.name ? ' di ' + firstStep.name : ''}.` : '';
        speak(`Rute dari ${fromName} ke ${toName}. Jarak ${cumKm.toFixed(1)} kilometer, perkiraan ${adjustedCumMin} menit.${altText}${tollText}${fuelTxt}${floodTxt}${safeAltTxt}${firstTxt}`);

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

  /* ================= NOTIFIKASI RUTE ================= */
  useEffect(() => {
    if (!notifEnabled || !routeSegments.length) return;
    const hasRed = routeSegments.some(s => s.color === '#ef4444');
    const hasOrg = routeSegments.some(s => s.color === '#f97316');
    const cond = hasRed ? 'padat' : hasOrg ? 'ramai' : 'lancar';
    if (notifConditionRef.current !== null && notifConditionRef.current !== cond) {
      const msgs = {
        padat:  ['⚠️ Rute Macet — JakTraffic', 'Rute Anda kini PADAT. Pertimbangkan rute alternatif.'],
        ramai:  ['🚦 Rute Mulai Ramai — JakTraffic', 'Kepadatan meningkat di sepanjang rute.'],
        lancar: ['✅ Rute Kembali Lancar — JakTraffic', 'Kondisi rute Anda sudah membaik.'],
      };
      const [title, body] = msgs[cond];
      new Notification(title, { body, icon: '/favicon.ico' });
    }
    notifConditionRef.current = cond;
  }, [routeSegments, notifEnabled]);

  useEffect(() => {
    if (!notifEnabled || !tomtomIncidents.length || !routeSegments.length) return;
    const routePoints = routeSegments.flatMap(s => s.points);
    tomtomIncidents.forEach(inc => {
      if (!inc.lat || !inc.lng) return;
      const key = `${inc.lat}-${inc.lng}-${inc.category}`;
      if (notifiedIncidentsRef.current.has(key)) return;
      const near = routePoints.some(([lat, lng]) => haversineDistance(lat, lng, inc.lat, inc.lng) < 800);
      if (near) {
        notifiedIncidentsRef.current.add(key);
        new Notification(`🚨 ${INCIDENT_LABELS[inc.category] || 'Insiden'} — JakTraffic`, {
          body: `${INCIDENT_LABELS[inc.category] || 'Insiden'} terdeteksi di dekat rute Anda.`,
          icon: '/favicon.ico',
        });
      }
    });
  }, [tomtomIncidents, notifEnabled, routeSegments]);

  /* ================= REKALKULASI Tول + BBM SAAT KENDARAAN/BBM BERUBAH ================= */
  useEffect(() => {
    const coords = routeCoordsRef.current;
    if (!coords.length || !eta) return;
    const veh  = VEHICLE_TYPES.find(v => v.id === vehicleType) || VEHICLE_TYPES[1];
    const fuel = FUEL_TYPES.find(f => f.id === fuelType) || FUEL_TYPES[0];
    // Toll
    const tolledCors = TOLL_CORRIDORS.filter(tc =>
      tc.camIds.some(cid => {
        const cam = cctv.find(c => c.id === cid);
        if (!cam?.lat || !cam?.lng) return false;
        return coords.some(([lat, lng]) => haversineDistance(lat, lng, cam.lat, cam.lng) < 700);
      })
    );
    const tollTotal = Math.round(tolledCors.reduce((s, t) => s + t.price, 0) * veh.tollFactor);
    setTollEstimate(tolledCors.length ? { corridors: tolledCors, total: tollTotal } : null);
    // BBM
    const dist = parseFloat(eta.distance);
    const liters = Math.round((dist * veh.consumption / 100) * 10) / 10;
    setFuelEstimate({ liters, cost: Math.round(liters * fuel.price), fuelLabel: fuel.label });
  }, [vehicleType, fuelType, eta, cctv]);

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
          setAltRoutes([]); setActiveRouteIdx(0);
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

  /* ── computed summary for nav bar ── */
  const cctvLancar = cctv.filter(c => (c.vehicles || 0) <= 20).length;
  const cctvRamai  = cctv.filter(c => (c.vehicles || 0) > 20 && (c.vehicles || 0) <= 40).length;
  const cctvPadat  = cctv.filter(c => (c.vehicles || 0) > 40).length;

  const S = {
    /* base */
    root:    { position:'relative', width:'100vw', height:'100vh', overflow:'hidden', background:'#020b18', fontFamily:'system-ui,-apple-system,sans-serif', color:'#f0f9ff' },
    /* top nav */
    nav:     { position:'absolute', top:0, left:0, right:0, zIndex:2000, height:52, background:'rgba(2,11,24,0.93)', backdropFilter:'blur(16px)', WebkitBackdropFilter:'blur(16px)', borderBottom:'1px solid rgba(56,189,248,0.1)', display:'flex', alignItems:'center', padding:'0 14px', gap:10 },
    /* left panel */
    panel:   { position:'absolute', top:60, left:12, bottom:12, zIndex:1000, width:316, background:'rgba(6,17,40,0.93)', backdropFilter:'blur(16px)', WebkitBackdropFilter:'blur(16px)', border:'1px solid rgba(56,189,248,0.1)', borderRadius:12, display:'flex', flexDirection:'column', overflow:'hidden' },
    panelHdr:{ padding:'14px 16px 10px', borderBottom:'1px solid rgba(255,255,255,0.06)', flexShrink:0 },
    panelBody:{ flex:1, overflowY:'auto', padding:'12px 14px' },
    panelFtr :{ padding:'10px 14px 14px', borderTop:'1px solid rgba(255,255,255,0.06)', flexShrink:0 },
    /* cards */
    card:    { background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:10, padding:'12px 14px', marginBottom:10 },
    /* traffic status colors */
    lancar:  { color:'#10b981' },
    ramai:   { color:'#f59e0b' },
    padat:   { color:'#f43f5e' },
    /* pill badge */
    pill:    (c,bg,bd) => ({ display:'inline-flex', alignItems:'center', gap:5, background:bg, border:`1px solid ${bd}`, borderRadius:6, padding:'3px 8px' }),
    /* button */
    btn:     (active) => ({ background: active?'rgba(56,189,248,0.15)':'rgba(255,255,255,0.05)', border:`1px solid ${active?'rgba(56,189,248,0.4)':'rgba(255,255,255,0.1)'}`, borderRadius:7, padding:'6px 12px', color: active?'#38bdf8':'#94a3b8', fontSize:11, fontWeight:700, cursor:'pointer', transition:'all .15s' }),
    btnSm:   (active,c='#38bdf8') => ({ flex:1, textAlign:'center', padding:'7px 0', borderRadius:8, fontSize:11, fontWeight:700, cursor:'pointer', border:'none', background:active?c:'rgba(255,255,255,0.06)', color:active?'#fff':'#64748b', transition:'all .15s' }),
    label:   { fontSize:9, fontWeight:700, letterSpacing:0.8, color:'#475569', textTransform:'uppercase', marginBottom:4 },
    big:     { fontSize:32, fontWeight:900, lineHeight:1, fontVariantNumeric:'tabular-nums' },
    sep:     { height:1, background:'rgba(255,255,255,0.06)', margin:'10px 0' },
  };

  return (
    <>
    <div style={S.root}>
      {/* ══ TOPNAV ══════════════════════════════════════════════════ */}
      <nav style={S.nav}>
        {/* Logo */}
        <div style={{ display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
          <div style={{ width:30, height:30, borderRadius:7, background:'linear-gradient(135deg,#0ea5e9,#2563eb)', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:900, fontSize:16, color:'#fff', boxShadow:'0 0 14px rgba(14,165,233,.45)', flexShrink:0 }}>J</div>
          <div>
            <div style={{ fontWeight:800, fontSize:13, letterSpacing:-.3 }}>JakTraffic</div>
            <div style={{ fontSize:9, color:'#475569', lineHeight:1, marginTop:1 }}>Jakarta AI Traffic</div>
          </div>
        </div>
        <div style={{ width:1, height:20, background:'#1e3a5f', margin:'0 2px', flexShrink:0 }} />
        {/* Traffic summary */}
        {cctv.length > 0 && (
          <div style={{ display:'flex', gap:5, flex:1 }}>
            {[
              { label:'LANCAR', n:cctvLancar, c:'#10b981', bg:'rgba(16,185,129,.1)',  bd:'rgba(16,185,129,.22)' },
              { label:'RAMAI',  n:cctvRamai,  c:'#f59e0b', bg:'rgba(245,158,11,.1)', bd:'rgba(245,158,11,.22)' },
              { label:'PADAT',  n:cctvPadat,  c:'#f43f5e', bg:'rgba(244,63,94,.1)',   bd:'rgba(244,63,94,.22)'  },
            ].map(s => (
              <div key={s.label} style={S.pill(s.c, s.bg, s.bd)}>
                <span style={{ width:6, height:6, borderRadius:'50%', background:s.c, boxShadow:`0 0 5px ${s.c}`, flexShrink:0 }} />
                <span style={{ fontSize:9, fontWeight:700, color:s.c, letterSpacing:.7 }}>{s.label}</span>
                <span style={{ fontSize:16, fontWeight:900, color:'#f0f9ff', fontVariantNumeric:'tabular-nums', lineHeight:1 }}>{s.n}</span>
              </div>
            ))}
          </div>
        )}
        {/* Right controls */}
        <div style={{ display:'flex', alignItems:'center', gap:7, marginLeft:'auto', flexShrink:0 }}>
          {predictionMode !== 'now' && (
            <span style={{ background:'rgba(59,130,246,.15)', border:'1px solid rgba(59,130,246,.3)', borderRadius:5, padding:'2px 7px', fontSize:9, color:'#60a5fa', fontWeight:700, letterSpacing:.6 }}>
              PREDIKSI {predictionMode}m
            </span>
          )}
          <span
            title={wsConnected ? 'Live WebSocket — data real-time' : 'WebSocket terputus — polling fallback aktif'}
            style={{ width:7, height:7, borderRadius:'50%', flexShrink:0, background: wsConnected ? '#22c55e' : '#f59e0b', boxShadow: wsConnected ? '0 0 7px #22c55e' : 'none', cursor:'default' }}
          />
          {weatherData && (
            <span
              title={`Jakarta: ${weatherData.description} | ${weatherData.temp_c}°C | Hujan: ${weatherData.rain_mm}mm/h`}
              style={{ fontSize:10, color: weatherData.heavy_rain ? '#60a5fa' : '#64748b', cursor:'default', userSelect:'none', fontWeight:600 }}
            >
              {weatherData.icon} {weatherData.temp_c}°C
            </span>
          )}
          <button
            onClick={() => setShowFlood(v => !v)}
            style={{ ...S.btn(showFlood), minWidth:32 }}
            title={showFlood ? 'Sembunyikan zona banjir' : 'Tampilkan zona rawan banjir'}
          >
            🌊
          </button>
          <button
            onClick={toggleNotif}
            style={{ ...S.btn(notifEnabled), minWidth:32 }}
            title={notifEnabled ? 'Matikan notifikasi rute' : 'Aktifkan notifikasi rute'}
          >
            {notifEnabled ? '🔔' : '🔕'}
          </button>
          <button
            onClick={() => setVoiceEnabled(v => !v)}
            style={{ ...S.btn(voiceEnabled), minWidth:32 }}
            title={voiceEnabled ? 'Matikan panduan suara' : 'Aktifkan panduan suara'}
          >
            {voiceEnabled ? '🔊' : '🔇'}
          </button>
          <button onClick={() => setShowChat(v => !v)} style={S.btn(showChat)}>🤖 AI Chat</button>
          <a href="/admin" style={{ fontSize:10, color:'#64748b', textDecoration:'none', padding:'5px 10px', background:'rgba(255,255,255,.04)', borderRadius:7, border:'1px solid rgba(255,255,255,.07)', fontWeight:600 }}>⚙ Operator</a>
        </div>
      </nav>

      {/* ══ MAP ════════════════════════════════════════════════════ */}
      <MapContainer center={[-6.2, 106.816]} zoom={12} style={{ position:'absolute', inset:0, zIndex:0 }} zoomControl={false}>
        <TileLayer attribution='&copy; <a href="https://carto.com">CARTO</a>' url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />
        <MapClickHandler onPick={handleMapPick} />
        <FlyToHandler target={mapFlyTo} />
        <FitBoundsHandler segments={routeSegments} />

        {/* Overlay zona rawan banjir (warna dinamis berdasarkan cuaca + TomTom) */}
        {showFlood && FLOOD_ZONES.map((z, i) => {
          const effRisk  = dynamicFloodRisk[z.name] || z.risk;
          const elevated = effRisk !== z.risk;
          return (
            <Polygon key={`flood-${i}`} positions={z.coords}
              pathOptions={{ color: FLOOD_RISK_COLOR[effRisk], fillColor: FLOOD_RISK_COLOR[effRisk], fillOpacity: elevated ? 0.28 : 0.18, weight: elevated ? 2 : 1.5, opacity: elevated ? 0.8 : 0.55, dashArray: elevated ? null : '5 3' }}
            >
              <LeafletTooltip sticky direction="top">
                🌊 {z.name} — {FLOOD_RISK_LABEL[effRisk]}{elevated ? ' ⬆ (ditingkatkan)' : ''}
              </LeafletTooltip>
            </Polygon>
          );
        })}

        {startPoint && (
          <Marker position={[startPoint.lat, startPoint.lng]} icon={startIcon} draggable eventHandlers={{ dragend: e => setStartPoint(e.target.getLatLng()) }}>
            <Popup>Titik Awal</Popup>
          </Marker>
        )}
        {endPoint && (
          <Marker position={[endPoint.lat, endPoint.lng]} icon={endIcon} draggable eventHandlers={{ dragend: e => setEndPoint(e.target.getLatLng()) }}>
            <Popup>Tujuan</Popup>
          </Marker>
        )}

        {tollRoadLines.filter(line => line.points?.length >= 2).map((line, idx) => (
          <React.Fragment key={`toll-road-${idx}`}>
            <Polyline positions={line.points} pathOptions={{ color: line.color, weight:12, opacity:.18, lineCap:'round', lineJoin:'round' }} interactive={false} />
            <Polyline positions={line.points} pathOptions={{ color: line.color, weight:5, opacity:.9, dashArray:'10 4', lineCap:'round' }}>
              <LeafletTooltip sticky direction="top" offset={[0,-4]}>🛣️ {line.name}</LeafletTooltip>
              <Popup><b style={{ color: line.color }}>🛣️ {line.name}</b></Popup>
            </Polyline>
          </React.Fragment>
        ))}

        {/* Rute alternatif (tidak aktif) */}
        {altRoutes.filter((_, idx) => idx !== activeRouteIdx).map((r, i) => (
          <Polyline key={`alt-bg-${i}`} positions={r.coords} pathOptions={{ color:'#475569', weight:3, opacity:0.3, dashArray:'7 5' }} interactive={false} />
        ))}

        {routeSegments.map((seg, idx) => (
          <Polyline key={idx} positions={seg.points} pathOptions={{ color:seg.color, weight:6, opacity:seg.dashed?.6:.85, dashArray:seg.dashed?'10 7':null }} />
        ))}

        {waypointETAs.filter(wp => wp.lat != null && wp.lng != null).map(wp => (
          <Marker key={`eta-${wp.cctv_id}`} position={[wp.lat, wp.lng]} icon={etaBadgeIcon(wp.segment_min, wp.segment_km, wp.isDestination)} interactive={false} />
        ))}

        {tomtomIncidents.filter(inc => inc.lat != null && inc.lng != null).map((inc, i) => (
          <Marker key={`inc-${i}`} position={[inc.lat, inc.lng]} icon={incidentIcon(inc.category)} zIndexOffset={500}>
            <Popup>
              <div style={{ color:'#0f172a', fontSize:12, maxWidth:200, lineHeight:1.4 }}>
                <b>{INCIDENT_LABELS[inc.category] || 'Insiden'}</b>
                {inc.description && <p style={{ margin:'3px 0 0' }}>{inc.description}</p>}
                {(inc.from || inc.to) && <p style={{ margin:'3px 0 0', color:'#64748b', fontSize:10 }}>{inc.from}{inc.to ? ` → ${inc.to}` : ''}</p>}
              </div>
            </Popup>
          </Marker>
        ))}

        {filteredCctv.map(c => {
          const ev = getEffectiveVehicles(c);
          const color = ev > 30 ? '#ef4444' : ev > 15 ? '#f97316' : '#22c55e';
          return <Circle key={`zone-${c.id}`} center={[c.lat, c.lng]} radius={c.road_type==='toll'?200:400} pathOptions={{ color, fillColor:color, fillOpacity:.07, weight:1, opacity:.2 }} />;
        })}

        {/* Ring aktif kamera sepanjang rute — rendered di atas zone circles */}
        {routeCameras.map(cam => (
          <Circle key={`rcam-${cam.id}`} center={[cam.lat, cam.lng]} radius={550}
            pathOptions={{ color:'#22d3ee', fillColor:'#22d3ee', fillOpacity:.08, weight:2.5, opacity:1, dashArray:'9 5' }} interactive={false} />
        ))}

        {filteredCctv.map(c => {
          const ev = getEffectiveVehicles(c);
          const dbStatus = (c.status||'').toUpperCase();
          const markerStatus = (dbStatus==='MERAH'||dbStatus==='PADAT') ? 'MERAH' : (dbStatus==='KUNING'||dbStatus==='RAMAI') ? 'KUNING' : undefined;
          const isHighlighted = highlighted.includes(c.id);
          return (
            <Marker key={c.id} position={[c.lat, c.lng]} icon={c.road_type==='toll'?tollIcon(markerStatus,isHighlighted):pulseIcon(markerStatus,isHighlighted)} eventHandlers={{ click: () => {
              setCompareMode(null); setHighlighted([]);
              const vv = getEffectiveVehicles(c);
              const lbl = vv > 40 ? 'padat' : vv > 20 ? 'ramai' : 'lancar';
              speak(`${c.name}. Kondisi ${lbl}, ${vv} kendaraan terdeteksi.`);
            } }}>
              <Popup className="cctv-popup" maxWidth={270} minWidth={270} autoPan>
                <MapPopup cam={c} effectiveVehicles={ev} onSelectDetail={() => { setSelected(c); setCompareMode(null); setHighlighted([]); }} />
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>

      {/* Flood legend */}
      {showFlood && (
        <div style={{ position:'absolute', bottom:32, right:14, zIndex:900, background:'rgba(2,11,24,.93)', border:'1px solid rgba(255,255,255,.1)', borderRadius:10, padding:'10px 13px', minWidth:168, pointerEvents:'none' }}>
          <div style={{ fontSize:9, fontWeight:800, color:'#64748b', letterSpacing:.8, textTransform:'uppercase', marginBottom:7 }}>🌊 Zona Rawan Banjir</div>
          {[['HIGH','#ef4444'],['MEDIUM','#f97316'],['LOW','#eab308']].map(([risk, c]) => (
            <div key={risk} style={{ display:'flex', alignItems:'center', gap:7, marginBottom:4 }}>
              <div style={{ width:12, height:12, borderRadius:3, background:c, opacity:.75, flexShrink:0 }} />
              <span style={{ fontSize:10, color:'#cbd5e1' }}>{FLOOD_RISK_LABEL[risk]}</span>
            </div>
          ))}
          <div style={{ fontSize:8, color:'#475569', marginTop:5, borderTop:'1px solid rgba(255,255,255,.06)', paddingTop:5 }}>Sumber: BPBD DKI Jakarta</div>
        </div>
      )}

      {/* ══ LEFT PANEL ═════════════════════════════════════════════ */}
      <aside style={{ ...S.panel, display: showPanel || window.innerWidth >= 768 ? 'flex' : 'none' }}>

        {/* ── PANEL HEADER ── */}
        <div style={S.panelHdr}>
          {selected ? (
            <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:8 }}>
              <div>
                <div style={{ fontSize:9, fontWeight:700, color:'#38bdf8', letterSpacing:.8, marginBottom:3 }}>
                  {selected.road_type==='toll' ? '🛣️ JALAN TOL' : '📍 KAMERA CCTV'}
                </div>
                <div style={{ fontSize:16, fontWeight:800, lineHeight:1.2 }}>{selected.name}</div>
              </div>
              <button onClick={() => setSelected(null)} style={{ background:'rgba(255,255,255,.07)', border:'1px solid rgba(255,255,255,.1)', borderRadius:7, padding:'4px 8px', color:'#64748b', fontSize:11, cursor:'pointer', flexShrink:0 }}>✕</button>
            </div>
          ) : isRoutingActive ? (
            <div>
              <div style={{ fontSize:9, fontWeight:700, color:'#38bdf8', letterSpacing:.8, marginBottom:3 }}>🗺️ RUTE AKTIF</div>
              <div style={{ fontSize:13, fontWeight:700 }}>
                {routeNames ? <>{routeNames.from} <span style={{ color:'#38bdf8' }}>→</span> {routeNames.to}</> : 'Menghitung rute...'}
              </div>
            </div>
          ) : compareMode ? (
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <div>
                <div style={{ fontSize:9, fontWeight:700, color:'#38bdf8', letterSpacing:.8, marginBottom:2 }}>⚖️ MODE PERBANDINGAN</div>
                <div style={{ fontSize:12, color:'#94a3b8' }}>Diaktifkan oleh AI</div>
              </div>
              <button onClick={() => { setCompareMode(null); setHighlighted([]); }} style={{ background:'rgba(255,255,255,.07)', border:'1px solid rgba(255,255,255,.1)', borderRadius:7, padding:'4px 8px', color:'#64748b', fontSize:11, cursor:'pointer' }}>✕ Tutup</button>
            </div>
          ) : (
            <div>
              <div style={{ fontSize:14, fontWeight:800, marginBottom:2 }}>Peta Lalu Lintas Jakarta</div>
              <div style={{ fontSize:11, color:'#64748b' }}>Klik peta untuk navigasi · Klik kamera untuk analisis</div>
            </div>
          )}
        </div>

        {/* ── PANEL BODY ── */}
        <div style={S.panelBody}>

          {/* ——— SEARCH LOKASI ——— */}
          {(() => {
            const inputStyle = {
              width:'100%', background:'rgba(255,255,255,.07)', border:'1px solid rgba(255,255,255,.1)',
              borderRadius:7, padding:'8px 8px 8px 28px', color:'#f0f9ff', fontSize:11,
              outline:'none', boxSizing:'border-box', transition:'border .15s',
            };
            const dropStyle = {
              position:'absolute', top:'calc(100% + 3px)', left:0, right:0, zIndex:9999,
              background:'#0b1929', border:'1px solid rgba(56,189,248,.25)', borderRadius:8,
              overflow:'hidden', boxShadow:'0 8px 24px rgba(0,0,0,.5)',
            };
            const SearchBox = ({ value, target, icon, placeholder }) => (
              <div style={{ position:'relative' }}>
                <span style={{ position:'absolute', left:8, top:'50%', transform:'translateY(-50%)', fontSize:11, lineHeight:1 }}>{icon}</span>
                <input
                  value={value}
                  onChange={e => handleSearchInput(e.target.value, target)}
                  onFocus={() => { setSearchTarget(target); if (value.length >= 2) geocodeSearch(value, target); }}
                  onBlur={() => setTimeout(() => setSearchHits([]), 180)}
                  placeholder={placeholder}
                  style={{ ...inputStyle, borderColor: searchTarget === target && searchHits.length > 0 ? 'rgba(56,189,248,.4)' : 'rgba(255,255,255,.1)' }}
                />
                {searchTarget === target && searchHits.length > 0 && (
                  <div style={dropStyle}>
                    {searchHits.map((r, i) => (
                      <div
                        key={i}
                        onMouseDown={() => selectGeoResult(r)}
                        style={{ padding:'9px 12px', cursor:'pointer', borderBottom: i < searchHits.length-1 ? '1px solid rgba(255,255,255,.05)' : 'none', transition:'background .1s' }}
                        onMouseEnter={e => e.currentTarget.style.background='rgba(56,189,248,.08)'}
                        onMouseLeave={e => e.currentTarget.style.background='transparent'}
                      >
                        <div style={{ fontSize:11, fontWeight:600, color:'#e2e8f0', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                          {r.display_name.split(',')[0]}
                        </div>
                        <div style={{ fontSize:9, color:'#64748b', marginTop:2, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                          {r.display_name.split(',').slice(1, 3).join(',')}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
            return (
              <div style={{ ...S.card, padding:'10px 12px' }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                  <div style={S.label}>Navigasi</div>
                  {(startPoint || endPoint) && (
                    <button
                      onClick={() => { setStartPoint(null); setEndPoint(null); setRouteSegments([]); setEta(null); setRouteNames(null); setRouteSteps([]); setWaypointETAs([]); setSearchFrom(''); setSearchTo(''); setAltRoutes([]); setActiveRouteIdx(0); }}
                      style={{ fontSize:9, color:'#f43f5e', background:'rgba(244,63,94,.1)', border:'1px solid rgba(244,63,94,.2)', borderRadius:5, padding:'2px 7px', cursor:'pointer', fontWeight:700 }}
                    >
                      ✕ Reset
                    </button>
                  )}
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  <SearchBox value={searchFrom} target="from" icon="🟢" placeholder="Dari mana?" />
                  <SearchBox value={searchTo}   target="to"   icon="🔴" placeholder="Ke mana?" />
                </div>
                {!startPoint && !endPoint && (
                  <div style={{ fontSize:9, color:'#475569', marginTop:7, textAlign:'center' }}>
                    Ketik nama jalan / tempat, atau klik langsung di peta
                  </div>
                )}
              </div>
            );
          })()}

          {/* ——— MODE WAKTU ——— */}
          <div style={S.card}>
            <div style={S.label}>Mode Tampilan</div>
            <div style={{ display:'flex', gap:5 }}>
              {[{l:'Sekarang', v:'now'},{l:'15 Mnt', v:'15'},{l:'30 Mnt', v:'30'}].map(o => (
                <button key={o.v} onClick={() => setPredictionMode(o.v)} style={S.btnSm(predictionMode===o.v)}>{o.l}</button>
              ))}
            </div>
            {predictionMode !== 'now' && (
              <div style={{ marginTop:6, fontSize:9, color:'#60a5fa', display:'flex', alignItems:'center', gap:4 }}>
                <TrendingUp size={9} /> Prediksi Transformer AI — {predictionMode} menit ke depan
              </div>
            )}
          </div>

          {/* ——— FILTER RUTE ——— */}
          <div style={S.card}>
            <div style={S.label}>Filter Kamera</div>
            <div style={{ display:'flex', gap:5 }}>
              {[{l:'🗺️ Semua', v:'all'},{l:'🏙️ Kota', v:'city'},{l:'🛣️ Tol', v:'toll'}].map(o => (
                <button key={o.v} onClick={() => setRouteMode(o.v)} style={S.btnSm(routeMode===o.v,'#f59e0b')}>{o.l}</button>
              ))}
            </div>
          </div>

          {/* ——— SELECTED CCTV DETAIL ——— */}
          {selected && (
            <>
              {/* Status + Vehicles */}
              <div style={S.card}>
                <div style={{ display:'flex', alignItems:'flex-end', justifyContent:'space-between', marginBottom:10 }}>
                  <div>
                    <div style={S.label}>Kendaraan Saat Ini</div>
                    <div style={{ ...S.big, color: selected.vehicles > 40 ? '#f43f5e' : selected.vehicles > 20 ? '#f59e0b' : '#10b981' }}>
                      {selected.vehicles}
                    </div>
                    <div style={{ fontSize:11, color:'#64748b', marginTop:2 }}>unit terdeteksi</div>
                  </div>
                  {nowVsUsual && (
                    <div style={{ textAlign:'right' }}>
                      <div style={S.label}>Biasanya</div>
                      <div style={{ fontSize:22, fontWeight:800, color:'#94a3b8', fontVariantNumeric:'tabular-nums' }}>{Math.round(nowVsUsual.usual)}</div>
                      {nowVsUsual.diff_percent != null && (
                        <div style={{ fontSize:10, fontWeight:700, color: nowVsUsual.diff_percent > 0 ? '#f43f5e' : '#10b981' }}>
                          {nowVsUsual.diff_percent > 0 ? '▲' : '▼'} {Math.abs(nowVsUsual.diff_percent)}%
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {/* Status badge */}
                {(() => {
                  const v = selected.vehicles;
                  const isUnusual = nowVsUsual?.status === 'UNUSUAL';
                  const label = v > 40 ? 'PADAT' : v > 20 ? 'RAMAI' : 'LANCAR';
                  const color = v > 40 ? '#f43f5e' : v > 20 ? '#f59e0b' : '#10b981';
                  const bg    = v > 40 ? 'rgba(244,63,94,.1)' : v > 20 ? 'rgba(245,158,11,.1)' : 'rgba(16,185,129,.1)';
                  return (
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <div style={{ ...S.pill(color,bg,'transparent'), borderRadius:8, padding:'5px 12px', gap:6 }}>
                        <span style={{ width:7, height:7, borderRadius:'50%', background:color, boxShadow:`0 0 6px ${color}` }} />
                        <span style={{ fontSize:11, fontWeight:800, color, letterSpacing:.5 }}>{label}</span>
                      </div>
                      {isUnusual && <span style={{ fontSize:10, color:'#f59e0b', fontWeight:700 }}>⚠ Di atas normal</span>}
                    </div>
                  );
                })()}
              </div>


              {/* TomTom Flow */}
              {tomtomFlow?.currentSpeed > 0 && (() => {
                const pct = Math.round((tomtomFlow.currentSpeed / Math.max(tomtomFlow.freeFlowSpeed, 1)) * 100);
                const sc  = tomtomFlow.currentSpeed < 20 ? '#f43f5e' : tomtomFlow.currentSpeed < 40 ? '#f59e0b' : '#10b981';
                const bc  = pct < 40 ? '#f43f5e' : pct < 70 ? '#f59e0b' : '#10b981';
                return (
                  <div style={S.card}>
                    <div style={S.label}>🛰️ Kecepatan Jalan (TomTom)</div>
                    <div style={{ display:'flex', gap:12, marginBottom:8 }}>
                      <div>
                        <div style={{ fontSize:9, color:'#475569' }}>Sekarang</div>
                        <div style={{ fontSize:24, fontWeight:900, color:sc, fontVariantNumeric:'tabular-nums' }}>{tomtomFlow.currentSpeed}<span style={{ fontSize:10, color:'#64748b', fontWeight:400 }}>km/j</span></div>
                      </div>
                      <div style={{ width:1, background:'rgba(255,255,255,.07)' }} />
                      <div>
                        <div style={{ fontSize:9, color:'#475569' }}>Bebas Hambatan</div>
                        <div style={{ fontSize:24, fontWeight:900, color:'#94a3b8', fontVariantNumeric:'tabular-nums' }}>{tomtomFlow.freeFlowSpeed}<span style={{ fontSize:10, color:'#64748b', fontWeight:400 }}>km/j</span></div>
                      </div>
                    </div>
                    <div style={{ display:'flex', justifyContent:'space-between', fontSize:9, color:'#475569', marginBottom:4 }}>
                      <span>Efisiensi Lajur</span><span>{pct}%</span>
                    </div>
                    <div style={{ height:4, background:'rgba(255,255,255,.08)', borderRadius:99, overflow:'hidden' }}>
                      <div style={{ width:`${Math.min(100,pct)}%`, height:'100%', background:bc, borderRadius:99, transition:'width .5s' }} />
                    </div>
                  </div>
                );
              })()}

              {/* Mini chart */}
              {history.length > 0 && (
                <div style={S.card}>
                  <div style={S.label}>Tren 1 Jam Terakhir</div>
                  <ResponsiveContainer width="100%" height={80}>
                    <AreaChart data={history} margin={{ top:2, right:0, left:-28, bottom:0 }}>
                      <CartesianGrid stroke="rgba(255,255,255,.05)" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize:8, fill:'#475569' }} stroke="transparent" />
                      <YAxis tick={{ fontSize:8, fill:'#475569' }} stroke="transparent" />
                      <Tooltip contentStyle={{ background:'#0b1e36', border:'none', fontSize:10, borderRadius:6 }} labelStyle={{ color:'#64748b' }} formatter={v => [`${v} kend.`]} />
                      <Area type="natural" dataKey="avg_vehicle" stroke="#38bdf8" fill="rgba(56,189,248,.15)" strokeWidth={2} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Next-hour prediction (routing) */}
              {nextHourPrediction && (
                <div style={{ ...S.card, borderColor:`${predictionStyle(nextHourPrediction.status).color.replace('text-','').includes('red')?'#f43f5e':predictionStyle(nextHourPrediction.status).color.includes('yellow')?'#f59e0b':'#10b981'}40` }}>
                  <div style={S.label}>Prediksi 1 Jam ke Depan</div>
                  <div style={{ fontSize:13, fontWeight:800, color: nextHourPrediction.status === 'POTENTIAL_JAM' ? '#f43f5e' : nextHourPrediction.status === 'UNSTABLE' ? '#f59e0b' : '#10b981' }}>
                    {predictionStyle(nextHourPrediction.status).icon} {nextHourPrediction.label}
                  </div>
                  <div style={{ fontSize:10, color:'#64748b', marginTop:4 }}>
                    {nextHourPrediction.now} → {nextHourPrediction.predicted} kend.{' '}
                    <span style={{ color: nextHourPrediction.change_percent < 0 ? '#10b981' : '#f43f5e', fontWeight:700 }}>
                      {nextHourPrediction.change_percent > 0 ? '+' : ''}{nextHourPrediction.change_percent}%
                    </span>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ——— ROUTING INFO ——— */}
          {!selected && isRoutingActive && eta && (
            <>
              <div style={{ ...S.card, borderColor: eta.floodNote ? 'rgba(96,165,250,.35)' : 'rgba(56,189,248,.2)' }}>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                  <div>
                    <div style={S.label}>ETA{eta.floodNote ? ' 🌊' : ''}</div>
                    <div style={{ fontSize:28, fontWeight:900, color: eta.floodNote ? '#60a5fa' : '#38bdf8', fontVariantNumeric:'tabular-nums' }}>
                      {eta.time}<span style={{ fontSize:11, color:'#64748b', fontWeight:400 }}> mnt</span>
                    </div>
                    {eta.baseTime && eta.baseTime !== eta.time && (
                      <div style={{ fontSize:9, color:'#94a3b8', marginTop:2 }}>Normal: {eta.baseTime} mnt</div>
                    )}
                  </div>
                  <div>
                    <div style={S.label}>Jarak</div>
                    <div style={{ fontSize:28, fontWeight:900, color:'#38bdf8', fontVariantNumeric:'tabular-nums' }}>{eta.distance}<span style={{ fontSize:11, color:'#64748b', fontWeight:400 }}> km</span></div>
                  </div>
                </div>
                {eta.floodNote && (
                  <div style={{ marginTop:6, fontSize:9, color:'#93c5fd', background:'rgba(96,165,250,.1)', border:'1px solid rgba(96,165,250,.2)', borderRadius:5, padding:'3px 8px' }}>
                    🌊 {eta.floodNote}
                  </div>
                )}
                {/* Route condition */}
                <div style={{ marginTop:8, display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ fontSize:9, fontWeight:700, letterSpacing:.6, color: routeDecisionColor.includes('emerald')?'#10b981':routeDecisionColor.includes('red')?'#f43f5e':'#f59e0b' }}>
                    ● {routeDecisionLabel.toUpperCase()}
                  </span>
                  <span style={{ fontSize:9, color:'#64748b' }}>{routeDecisionNote}</span>
                </div>
              </div>

              {/* Rute alternatif tabs */}
              {altRoutes.length > 1 && (
                <div style={S.card}>
                  <div style={S.label}>Pilihan Rute</div>
                  <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
                    {altRoutes.map((r, idx) => (
                      <button
                        key={idx}
                        onClick={() => { setActiveRouteIdx(idx); setRouteSegments(r.segments); setEta(r.eta); setRouteSteps(r.steps); }}
                        style={{ display:'flex', alignItems:'center', gap:8, background: idx===activeRouteIdx?'rgba(56,189,248,.12)':'rgba(255,255,255,.04)', border:`1px solid ${idx===activeRouteIdx?'rgba(56,189,248,.4)':'rgba(255,255,255,.08)'}`, borderRadius:8, padding:'8px 10px', cursor:'pointer', textAlign:'left', transition:'all .15s' }}
                      >
                        <span style={{ fontSize:10, fontWeight:800, color: idx===activeRouteIdx?'#38bdf8':'#64748b', flexShrink:0, minWidth:42 }}>Rute {idx+1}</span>
                        <span style={{ width:1, background:'rgba(255,255,255,.1)', height:12, flexShrink:0 }} />
                        <span style={{ fontSize:16, fontWeight:900, color:'#f0f9ff', fontVariantNumeric:'tabular-nums' }}>{r.eta.time}<span style={{ fontSize:9, color:'#64748b', fontWeight:400 }}>mnt</span></span>
                        <span style={{ fontSize:10, color:'#64748b' }}>· {r.eta.distance}km</span>
                        <span style={{ fontSize:9, fontWeight:700, color:r.condColor }}>● {r.condition.toUpperCase()}</span>
                        {r.floodSafe && <span style={{ fontSize:8, color:'#34d399', fontWeight:700, background:'rgba(52,211,153,.1)', borderRadius:3, padding:'1px 4px' }}>🌊 Aman</span>}
                        {r.floodScore > 0 && !r.floodSafe && <span style={{ fontSize:8, color:'#60a5fa', fontWeight:700 }}>🌊×{r.floodScore}</span>}
                        {idx===activeRouteIdx && <span style={{ fontSize:9, color:'#38bdf8', fontWeight:700, marginLeft:'auto' }}>✓</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Peringatan Zona Banjir di Rute ── */}
              {floodWarning.length > 0 && (
                <div style={{ ...S.card, borderColor:'rgba(239,68,68,.4)', background:'rgba(239,68,68,.06)' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                    <span style={{ fontSize:20 }}>🌊</span>
                    <div>
                      <div style={{ fontSize:11, fontWeight:800, color:'#f87171' }}>Peringatan: Zona Rawan Banjir</div>
                      <div style={{ fontSize:9, color:'#94a3b8', marginTop:1 }}>{floodWarning.length} zona terdeteksi di sepanjang rute</div>
                    </div>
                  </div>
                  {floodWarning.map((z, i) => (
                    <div key={i} style={{ display:'flex', alignItems:'center', gap:7, fontSize:10, padding:'3px 0', borderTop:'1px solid rgba(255,255,255,.06)' }}>
                      <span style={{ width:7,height:7,borderRadius:'50%',background:FLOOD_RISK_COLOR[z.risk],flexShrink:0 }} />
                      <span style={{ color:'#cbd5e1', flex:1 }}>{z.name}</span>
                      <span style={{ color:FLOOD_RISK_COLOR[z.risk], fontWeight:700, fontSize:9 }}>{FLOOD_RISK_LABEL[z.risk].toUpperCase()}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Selector kendaraan & BBM */}
              <div style={S.card}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                  <div style={S.label}>Kendaraan & BBM</div>
                </div>
                <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginBottom:6 }}>
                  {VEHICLE_TYPES.map(v => (
                    <button key={v.id} onClick={() => setVehicleType(v.id)}
                      style={{ ...S.btnSm(vehicleType===v.id,'#38bdf8'), fontSize:9 }}>{v.label}</button>
                  ))}
                </div>
                <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                  {FUEL_TYPES.map(f => (
                    <button key={f.id} onClick={() => setFuelType(f.id)}
                      style={{ ...S.btnSm(fuelType===f.id,'#22c55e'), fontSize:9 }}>{f.label}</button>
                  ))}
                </div>
              </div>

              {/* Estimasi tarif tol (semua koridor) */}
              {tollEstimate && (
                <div style={S.card}>
                  <div style={S.label}>🛣️ Estimasi Tarif Tol</div>
                  <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
                    {tollEstimate.corridors.map((cor, i) => (
                      <div key={cor.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:10, color:'#94a3b8', padding:'3px 0', borderBottom:i<tollEstimate.corridors.length-1?'1px solid rgba(255,255,255,.05)':'none' }}>
                        <span>{cor.name}</span>
                        <span style={{ color:'#e2e8f0', fontVariantNumeric:'tabular-nums', fontWeight:700 }}>Rp {Math.round(cor.price*(VEHICLE_TYPES.find(v=>v.id===vehicleType)?.tollFactor||1)).toLocaleString('id-ID')}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:7, paddingTop:6, borderTop:'1px solid rgba(255,255,255,.1)' }}>
                    <span style={{ fontSize:11, fontWeight:700, color:'#f0f9ff' }}>Total Tol</span>
                    <span style={{ fontSize:16, fontWeight:900, color:'#f59e0b', fontVariantNumeric:'tabular-nums' }}>Rp {tollEstimate.total.toLocaleString('id-ID')}</span>
                  </div>
                  <div style={{ fontSize:9, color:'#475569', marginTop:4 }}>*Tarif sesuai golongan kendaraan yang dipilih.</div>
                </div>
              )}

              {/* Estimasi konsumsi BBM — dari titik awal sampai tujuan */}
              {fuelEstimate && eta && (
                <div style={S.card}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                    <div style={S.label}>⛽ Estimasi Konsumsi BBM</div>
                    <span style={{ fontSize:9, color:'#64748b' }}>{eta.distance} km total</span>
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-end' }}>
                    <div>
                      <div style={{ fontSize:9, color:'#475569', marginBottom:2 }}>Pemakaian BBM</div>
                      <div style={{ fontSize:22, fontWeight:900, color:'#f0f9ff', fontVariantNumeric:'tabular-nums', lineHeight:1 }}>
                        {fuelEstimate.liters}<span style={{ fontSize:10, color:'#64748b', fontWeight:400 }}> L</span>
                      </div>
                      <div style={{ fontSize:9, color:'#475569', marginTop:3 }}>
                        {eta.distance} km × {VEHICLE_TYPES.find(v=>v.id===vehicleType)?.consumption ?? 11} L/100km
                      </div>
                    </div>
                    <div style={{ textAlign:'right' }}>
                      <div style={{ fontSize:9, color:'#475569', marginBottom:2 }}>{fuelEstimate.fuelLabel} · Rp {FUEL_TYPES.find(f=>f.id===fuelType)?.price.toLocaleString('id-ID')}/L</div>
                      <div style={{ fontSize:22, fontWeight:900, color:'#22c55e', fontVariantNumeric:'tabular-nums', lineHeight:1 }}>
                        Rp {fuelEstimate.cost.toLocaleString('id-ID')}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Kamera CCTV aktif di sepanjang rute */}
              {routeCameras.length > 0 && (
                <div style={S.card}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:7 }}>
                    <div style={S.label}>📹 Kamera CCTV di Rute</div>
                    <span style={{ fontSize:10, fontWeight:800, color:'#38bdf8', background:'rgba(56,189,248,.12)', borderRadius:10, padding:'1px 7px' }}>{routeCameras.length}</span>
                  </div>
                  <div style={{ maxHeight:140, overflowY:'auto', display:'flex', flexDirection:'column', gap:4 }}>
                    {routeCameras.map(cam => {
                      const v  = getEffectiveVehicles(cam);
                      const cc = v>40?'#f43f5e':v>20?'#f59e0b':'#10b981';
                      const cl = v>40?'PADAT':v>20?'RAMAI':'LANCAR';
                      return (
                        <button key={cam.id}
                          onClick={() => { setSelected(cam); setMapFlyTo({ lat:cam.lat, lng:cam.lng, zoom:16 }); setTimeout(()=>setMapFlyTo(null),2500); }}
                          style={{ display:'flex', alignItems:'center', gap:8, background:'rgba(255,255,255,.04)', border:'1px solid rgba(255,255,255,.07)', borderRadius:7, padding:'6px 9px', cursor:'pointer', textAlign:'left', transition:'background .1s' }}
                          onMouseEnter={e=>e.currentTarget.style.background='rgba(56,189,248,.08)'}
                          onMouseLeave={e=>e.currentTarget.style.background='rgba(255,255,255,.04)'}
                        >
                          <span style={{ width:7,height:7,borderRadius:'50%',background:cc,boxShadow:`0 0 5px ${cc}`,flexShrink:0 }} />
                          <span style={{ fontSize:10,fontWeight:600,color:'#e2e8f0',flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{cam.name}</span>
                          <span style={{ fontSize:9,fontWeight:700,color:cc,flexShrink:0 }}>{cl}</span>
                          <span style={{ fontSize:9,color:'#475569',flexShrink:0 }}>▶</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Turn-by-turn */}
              {routeSteps.length > 0 && (
                <div style={S.card}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                    <div style={S.label}>Petunjuk Arah</div>
                    <button
                      onClick={speakAllSteps}
                      title="Baca semua petunjuk arah"
                      style={{ background:'rgba(56,189,248,.12)', border:'1px solid rgba(56,189,248,.25)', borderRadius:6, padding:'3px 9px', fontSize:10, color:'#38bdf8', cursor:'pointer', fontWeight:700, display:'flex', alignItems:'center', gap:4 }}
                    >
                      🔊 <span>Baca</span>
                    </button>
                  </div>
                  <div style={{ maxHeight:180, overflowY:'auto' }}>
                    {routeSteps.map((step, i) => (
                      <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:8, padding:'6px 0', borderBottom: i<routeSteps.length-1?'1px solid rgba(255,255,255,.05)':'none' }}>
                        <span style={{ fontSize:16, flexShrink:0, lineHeight:1.3, minWidth:22, textAlign:'center' }}>{maneuverIcon(step.type, step.modifier)}</span>
                        <div style={{ flex:1 }}>
                          <div style={{ fontSize:11, fontWeight:600, color:'#e2e8f0' }}>{maneuverLabel(step.type, step.modifier)}</div>
                          {step.name && <div style={{ fontSize:9, color:'#64748b', marginTop:1 }}>{step.name}</div>}
                        </div>
                        {step.distance > 0 && <span style={{ fontSize:10, color:'#38bdf8', flexShrink:0, fontVariantNumeric:'tabular-nums', fontWeight:700 }}>{fmtDist(step.distance)}</span>}
                      </div>
                    ))}
                  </div>
                  <button onClick={() => {
                    // Simpan ringkasan sebelum reset
                    if (eta && (routeNames?.from || routeNames?.to)) {
                      setTripSummaryData({
                        from:     routeNames?.from || 'Titik Awal',
                        to:       routeNames?.to   || 'Tujuan',
                        distance: eta.distance,
                        time:     eta.time,
                        baseTime: eta.baseTime || eta.time,
                        toll:     tollEstimate?.total || 0,
                        tollCorridors: tollEstimate?.corridors?.map(c => c.name) || [],
                        fuel:     fuelEstimate,
                        total:    (tollEstimate?.total || 0) + (fuelEstimate?.cost || 0),
                        cameras:  routeCameras.length,
                        cameraNames: routeCameras.slice(0,5).map(c => c.name),
                        flood:    floodWarning.map(z => ({ name: z.name, risk: dynamicFloodRisk[z.name] || z.risk })),
                        vehicle:  VEHICLE_TYPES.find(v => v.id === vehicleType)?.label || 'Mobil',
                        fuelType: FUEL_TYPES.find(f => f.id === fuelType)?.label || 'Pertalite',
                      });
                      setShowTripSummary(true);
                    }
                    setRouteSegments([]); setEta(null); setStartPoint(null); setEndPoint(null);
                    setRouteNames(null); setRouteSteps([]); setWaypointETAs([]); setSearchFrom(''); setSearchTo('');
                    setAltRoutes([]); setActiveRouteIdx(0); setTollEstimate(null); setFuelEstimate(null);
                    setRouteCameras([]); setFloodWarning([]); routeCoordsRef.current = [];
                  }}
                    style={{ marginTop:8, width:'100%', background:'rgba(244,63,94,.1)', border:'1px solid rgba(244,63,94,.25)', borderRadius:7, padding:'6px 0', fontSize:11, color:'#f43f5e', fontWeight:700, cursor:'pointer' }}>
                    ✕ Selesai & Ringkasan Perjalanan
                  </button>
                </div>
              )}

              {/* 1-hour prediction for route */}
              {nextHourPrediction && (
                <div style={S.card}>
                  <div style={S.label}>Kondisi 1 Jam Lagi</div>
                  <div style={{ fontSize:12, fontWeight:800, color: nextHourPrediction.status === 'POTENTIAL_JAM' ? '#f43f5e' : nextHourPrediction.status === 'UNSTABLE' ? '#f59e0b' : '#10b981' }}>
                    {predictionStyle(nextHourPrediction.status).icon} {nextHourPrediction.label}
                  </div>
                  <div style={{ fontSize:10, color:'#64748b', marginTop:4 }}>
                    {nextHourPrediction.now} → {nextHourPrediction.predicted} kend.{' '}
                    <span style={{ color: nextHourPrediction.change_percent < 0 ? '#10b981' : '#f43f5e', fontWeight:700 }}>
                      {nextHourPrediction.change_percent > 0 ? '+' : ''}{nextHourPrediction.change_percent}%
                    </span>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ——— COMPARE MODE ——— */}
          {compareMode && !selected && !isRoutingActive && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              {compareMode.ids.map((locId, colIdx) => {
                const d = compareData[locId];
                const accentColor = colIdx === 0 ? '#38bdf8' : '#a78bfa';
                if (!d) return (
                  <div key={locId} style={{ ...S.card, display:'flex', alignItems:'center', justifyContent:'center', minHeight:80 }}>
                    <span style={{ color:'#475569', fontSize:11 }}>Memuat...</span>
                  </div>
                );
                const v = d.cctv?.vehicles ?? 0;
                const vc = v > 30 ? '#f43f5e' : v > 15 ? '#f59e0b' : '#10b981';
                const vl = v > 30 ? 'PADAT' : v > 15 ? 'RAMAI' : 'LANCAR';
                return (
                  <div key={locId} style={{ ...S.card, borderColor:`${accentColor}30`, marginBottom:0 }}>
                    <div style={{ fontSize:10, fontWeight:700, color:accentColor, marginBottom:4, lineHeight:1.2 }}>{d.cctv?.name ?? `Lokasi ${locId}`}</div>
                    <div style={{ fontSize:26, fontWeight:900, color:vc, fontVariantNumeric:'tabular-nums' }}>{v}</div>
                    <div style={{ fontSize:9, fontWeight:700, color:vc, marginBottom:6 }}>{vl}</div>
                    {d.history?.length > 0 && (
                      <ResponsiveContainer width="100%" height={50}>
                        <AreaChart data={d.history} margin={{ top:0, right:0, left:0, bottom:0 }}>
                          <Area type="monotone" dataKey="avg_vehicle" stroke={accentColor} fill={accentColor} fillOpacity={.15} strokeWidth={1.5} dot={false} />
                          <Tooltip contentStyle={{ display:'none' }} />
                        </AreaChart>
                      </ResponsiveContainer>
                    )}
                    <button onClick={() => { setSelected(d.cctv); setCompareMode(null); setHighlighted([]); }} style={{ marginTop:6, width:'100%', background:'rgba(255,255,255,.06)', border:'none', borderRadius:6, padding:'4px 0', fontSize:10, color:'#94a3b8', cursor:'pointer', fontWeight:700 }}>Detail →</button>
                  </div>
                );
              })}
              {/* Conclusion */}
              {compareMode.ids.length === 2 && compareData[compareMode.ids[0]] && compareData[compareMode.ids[1]] && (() => {
                const a = compareData[compareMode.ids[0]];
                const b = compareData[compareMode.ids[1]];
                const vA = a.cctv?.vehicles ?? 0, vB = b.cctv?.vehicles ?? 0;
                const isTie = vA === vB;
                const winner = vA < vB ? a.cctv?.name : b.cctv?.name;
                return (
                  <div style={{ gridColumn:'1/-1', ...S.card, background:'rgba(56,189,248,.07)', borderColor:'rgba(56,189,248,.2)' }}>
                    <div style={{ fontSize:9, color:'#64748b', marginBottom:3 }}>Kesimpulan AI</div>
                    <div style={{ fontSize:12, fontWeight:800, color: isTie?'#38bdf8':'#10b981' }}>
                      {isTie ? `Keduanya ${vA>30?'padat':vA>15?'ramai':'lancar'}` : `${winner} lebih lancar`}
                    </div>
                    <div style={{ fontSize:10, color:'#64748b', marginTop:2 }}>Selisih: {Math.abs(vA-vB)} kendaraan</div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* ——— PREDICTION TABLE ——— */}
          {!selected && !isRoutingActive && !compareMode && predictionData && predictionMode !== 'now' && (
            <div style={S.card}>
              <div style={S.label}>Prediksi {predictionData.horizon} Menit</div>
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                {predictionData.predictions?.map(p => (
                  <div key={p.location_id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'5px 0', borderBottom:'1px solid rgba(255,255,255,.04)' }}>
                    <div>
                      <div style={{ fontSize:11, fontWeight:700 }}>{p.name}</div>
                      <div style={{ fontSize:9, color:'#475569' }}>Saat ini: {p.current_vehicles}</div>
                    </div>
                    <div style={{ textAlign:'right' }}>
                      <div style={{ fontSize:16, fontWeight:900, color: p.status==='PADAT'?'#f43f5e':p.status==='RAMAI'?'#f59e0b':'#10b981', fontVariantNumeric:'tabular-nums' }}>{p.predicted_vehicles}</div>
                      <div style={{ fontSize:9, fontWeight:700, color: p.status==='PADAT'?'#f43f5e':p.status==='RAMAI'?'#f59e0b':'#10b981' }}>{p.status}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ——— DEFAULT GUIDE ——— */}
          {!selected && !isRoutingActive && !compareMode && (
            <div style={{ ...S.card, textAlign:'center', padding:'24px 16px' }}>
              <div style={{ fontSize:28, marginBottom:8, opacity:.5 }}>🗺️</div>
              <div style={{ fontSize:13, fontWeight:700, color:'#64748b', marginBottom:4 }}>Cara Menggunakan</div>
              <div style={{ fontSize:11, color:'#475569', lineHeight:1.6 }}>
                <b style={{ color:'#94a3b8' }}>Klik kamera</b> untuk melihat kondisi lalu lintas & video live.<br/>
                <b style={{ color:'#94a3b8' }}>Klik 2× peta</b> untuk menentukan titik awal & tujuan rute.<br/>
                <b style={{ color:'#94a3b8' }}>AI Chat</b> untuk bertanya dengan bahasa natural.
              </div>
            </div>
          )}

          {/* TomTom incidents info */}
          {tomtomIncidents.length > 0 && (
            <div style={{ ...S.card, display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ fontSize:14 }}>⚠️</span>
              <span style={{ fontSize:10, color:'#f59e0b', fontWeight:700 }}>{tomtomIncidents.length} insiden aktif dari TomTom</span>
            </div>
          )}
        </div>

        {/* ── PANEL FOOTER: link to operator ── */}
        <div style={S.panelFtr}>
          <a href="/admin" style={{ display:'block', textAlign:'center', background:'rgba(255,255,255,.05)', border:'1px solid rgba(255,255,255,.08)', borderRadius:8, padding:'8px 0', fontSize:11, color:'#64748b', fontWeight:600, textDecoration:'none' }}>
            ⚙ Panel Operator Dishub
          </a>
        </div>
      </aside>

      {/* ══ MOBILE TOGGLE ══════════════════════════════════════════ */}
      <button
        onClick={() => setShowPanel(p => !p)}
        style={{ position:'absolute', bottom:20, left:'50%', transform:'translateX(-50%)', zIndex:1500, display:'flex', alignItems:'center', gap:6, background:'rgba(6,17,40,0.92)', border:'1px solid rgba(56,189,248,.2)', borderRadius:99, padding:'10px 20px', color:'#f0f9ff', fontSize:12, fontWeight:700, cursor:'pointer', boxShadow:'0 4px 24px rgba(0,0,0,.5)' }}
        className="md:hidden"
      >
        {showPanel ? '✕ Tutup Panel' : '📊 Lihat Info'}
      </button>

      {/* Map legend (bottom right) */}
      <div style={{ position:'absolute', bottom:24, right:12, zIndex:1000, background:'rgba(6,17,40,0.9)', border:'1px solid rgba(56,189,248,.1)', borderRadius:10, padding:'8px 12px', fontSize:9, color:'#64748b', lineHeight:1.9 }}>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}><span style={{ width:8, height:8, borderRadius:'50%', background:'#22c55e', display:'inline-block' }} />Kamera Kota</div>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}><span style={{ width:8, height:8, borderRadius:2, background:'#f59e0b', display:'inline-block' }} />Kamera Tol</div>
        {tomtomIncidents.length > 0 && <div style={{ display:'flex', alignItems:'center', gap:6 }}><span style={{ fontSize:10 }}>⚠️</span>Insiden TomTom</div>}
      </div>

      <style>{`
        @keyframes bounce-dot { 0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)} }
        .cctv-popup .leaflet-popup-content-wrapper { padding:0; background:transparent; box-shadow:none; border:none; }
        .cctv-popup .leaflet-popup-content { margin:0; }
        .cctv-popup .leaflet-popup-tip-container { display:none; }
        @media (min-width:768px) { button.md\\:hidden { display:none !important; } aside { display:flex !important; } }
      `}</style>
    </div>
    {/* ══ TRIP SUMMARY MODAL ═════════════════════════════════════════════ */}
    {showTripSummary && tripSummaryData && (
      <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.75)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
        <div style={{ background:'rgba(9,18,36,.98)', border:'1px solid rgba(56,189,248,.25)', borderRadius:18, padding:28, maxWidth:380, width:'100%', fontFamily:'system-ui,sans-serif', color:'#f0f9ff', boxShadow:'0 32px 80px rgba(0,0,0,.8)' }}>
          {/* Header */}
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20 }}>
            <div style={{ width:44, height:44, borderRadius:12, background:'linear-gradient(135deg,#38bdf8,#0ea5e9)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:22, flexShrink:0 }}>📋</div>
            <div>
              <div style={{ fontSize:15, fontWeight:800 }}>Ringkasan Perjalanan</div>
              <div style={{ fontSize:10, color:'#64748b', marginTop:1 }}>{tripSummaryData.vehicle} · {tripSummaryData.fuelType}</div>
            </div>
          </div>
          {/* Route */}
          <div style={{ background:'rgba(56,189,248,.06)', border:'1px solid rgba(56,189,248,.15)', borderRadius:10, padding:'12px 14px', marginBottom:14 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ width:8, height:8, borderRadius:'50%', background:'#22c55e', flexShrink:0 }} />
              <span style={{ fontSize:11, color:'#94a3b8' }}>{tripSummaryData.from}</span>
            </div>
            <div style={{ width:1, height:10, background:'rgba(56,189,248,.2)', margin:'4px 0 4px 3.5px' }} />
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ width:8, height:8, borderRadius:'50%', background:'#ef4444', flexShrink:0 }} />
              <span style={{ fontSize:11, color:'#94a3b8' }}>{tripSummaryData.to}</span>
            </div>
          </div>
          {/* Stats grid */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:14 }}>
            {[
              { label:'Jarak', value:`${tripSummaryData.distance} km`, icon:'🛣️' },
              { label:'Waktu Tempuh', value:`${tripSummaryData.time} mnt${tripSummaryData.baseTime !== tripSummaryData.time ? ` (+banjir)` : ''}`, icon:'⏱️', note: tripSummaryData.baseTime !== tripSummaryData.time ? `Normal: ${tripSummaryData.baseTime} mnt` : null },
              ...(tripSummaryData.toll > 0 ? [{ label:'Tarif Tol', value:`Rp ${tripSummaryData.toll.toLocaleString('id-ID')}`, icon:'🛣️' }] : []),
              ...(tripSummaryData.fuel ? [{ label:'Konsumsi BBM', value:`${tripSummaryData.fuel.liters}L = Rp ${tripSummaryData.fuel.cost.toLocaleString('id-ID')}`, icon:'⛽' }] : []),
            ].map((s, i) => (
              <div key={i} style={{ background:'rgba(255,255,255,.04)', border:'1px solid rgba(255,255,255,.07)', borderRadius:8, padding:'10px 12px' }}>
                <div style={{ fontSize:9, color:'#64748b', marginBottom:3 }}>{s.icon} {s.label}</div>
                <div style={{ fontSize:13, fontWeight:800, color:'#f0f9ff', fontVariantNumeric:'tabular-nums' }}>{s.value}</div>
                {s.note && <div style={{ fontSize:8, color:'#475569', marginTop:2 }}>{s.note}</div>}
              </div>
            ))}
          </div>
          {/* Total */}
          {tripSummaryData.total > 0 && (
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', background:'rgba(56,189,248,.08)', border:'1px solid rgba(56,189,248,.2)', borderRadius:8, padding:'10px 14px', marginBottom:12 }}>
              <span style={{ fontSize:12, fontWeight:700 }}>Total Estimasi Biaya</span>
              <span style={{ fontSize:18, fontWeight:900, color:'#38bdf8', fontVariantNumeric:'tabular-nums' }}>Rp {tripSummaryData.total.toLocaleString('id-ID')}</span>
            </div>
          )}
          {/* Cameras + Flood */}
          {(tripSummaryData.cameras > 0 || tripSummaryData.flood.length > 0) && (
            <div style={{ display:'flex', gap:6, marginBottom:14, flexWrap:'wrap' }}>
              {tripSummaryData.cameras > 0 && (
                <span style={{ fontSize:9, color:'#22d3ee', background:'rgba(34,211,238,.1)', border:'1px solid rgba(34,211,238,.2)', borderRadius:5, padding:'3px 8px', fontWeight:700 }}>
                  📹 {tripSummaryData.cameras} kamera CCTV
                </span>
              )}
              {tripSummaryData.flood.map((z, i) => (
                <span key={i} style={{ fontSize:9, color: FLOOD_RISK_COLOR[z.risk], background:`${FLOOD_RISK_COLOR[z.risk]}18`, border:`1px solid ${FLOOD_RISK_COLOR[z.risk]}30`, borderRadius:5, padding:'3px 8px', fontWeight:700 }}>
                  🌊 {z.name}
                </span>
              ))}
            </div>
          )}
          <button
            onClick={() => { setShowTripSummary(false); setTripSummaryData(null); }}
            style={{ width:'100%', background:'linear-gradient(135deg,#38bdf8,#0ea5e9)', border:'none', borderRadius:9, padding:'11px 0', fontSize:13, fontWeight:700, color:'#020b18', cursor:'pointer' }}
          >
            Tutup
          </button>
        </div>
      </div>
    )}

    {/* Chat UI */}
    <ChatPopup
      visible={showChat}
      onClose={() => setShowChat(false)}
      onMapCommands={executeMapCommands}
      userContext={{
        vehicle:      VEHICLE_TYPES.find(v => v.id === vehicleType)?.label ?? 'Mobil',
        fuel:         FUEL_TYPES.find(f => f.id === fuelType)?.label ?? 'Pertalite',
        ...(eta ? { route: { from: routeNames?.from, to: routeNames?.to, distance: eta.distance, time: eta.time } } : {}),
        ...(tollEstimate ? { toll: { total: tollEstimate.total, corridors: tollEstimate.corridors.map(c => c.name) } } : {}),
        ...(fuelEstimate ? { fuel_cost: { liters: fuelEstimate.liters, cost: fuelEstimate.cost } } : {}),
        ...(floodWarning.length ? { flood_warning: floodWarning.map(z => ({ name: z.name, risk: z.risk })) } : {}),
        ...(routeCameras.length ? { route_cameras: routeCameras.slice(0,5).map(c => c.name) } : {}),
      }}
    />
    <ChatButton onOpen={() => setShowChat(true)} />
    </>
  );
}
