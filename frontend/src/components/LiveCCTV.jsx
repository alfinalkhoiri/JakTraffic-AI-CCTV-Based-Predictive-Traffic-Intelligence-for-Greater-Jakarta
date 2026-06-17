import React, { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";
import axios from "axios";

const API = process.env.REACT_APP_API_URL || "";

/**
 * HLS live stream player + tombol YOLO detect dari frame browser.
 * Props:
 *   streamUrl  — URL HLS m3u8 dari preview_url
 *   onDetect   — callback(result) saat YOLO selesai; result = { vehicle_count, class_counts, annotated_image }
 */
export default function LiveCCTV({ streamUrl, onDetect }) {
  const videoRef  = useRef(null);
  const canvasRef = useRef(null);
  const hlsRef    = useRef(null);
  const intervalRef = useRef(null);

  const [status, setStatus]         = useState("loading"); // loading | live | error
  const [detecting, setDetecting]   = useState(false);     // auto-detect aktif
  const [yoloResult, setYoloResult] = useState(null);      // { annotated_image, vehicle_count, class_counts, ms }
  const [yoloError, setYoloError]   = useState(null);
  const [corsBlocked, setCorsBlocked] = useState(false);

  /* ── Mount: inisialisasi HLS player ── */
  useEffect(() => {
    if (!streamUrl || !videoRef.current) return;

    setStatus("loading");
    setYoloResult(null);
    setYoloError(null);
    setCorsBlocked(false);

    const video = videoRef.current;

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 0,
      });
      hlsRef.current = hls;
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        setStatus("live");
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) setStatus("error");
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS
      video.src = streamUrl;
      video.addEventListener("loadedmetadata", () => {
        video.play().catch(() => {});
        setStatus("live");
      });
      video.addEventListener("error", () => setStatus("error"));
    } else {
      setStatus("error");
    }

    return () => {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      video.src = "";
    };
  }, [streamUrl]);

  /* ── Ambil frame → kirim ke YOLO backend ── */
  const captureAndDetect = useCallback(async () => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;

    canvas.width  = video.videoWidth  || 640;
    canvas.height = video.videoHeight || 360;
    const ctx = canvas.getContext("2d");

    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch (err) {
      // Canvas tainted karena CORS tidak diizinkan server
      if (err.name === "SecurityError") {
        setCorsBlocked(true);
        setDetecting(false);
        clearInterval(intervalRef.current);
      }
      return;
    }

    const base64 = canvas.toDataURL("image/jpeg", 0.8);

    try {
      const res = await axios.post(`${API}/api/detect-frame`, { image: base64 }, { timeout: 30000 });
      if (res.data?.success) {
        const result = {
          vehicle_count: res.data.vehicle_count,
          class_counts:  res.data.class_counts,
          annotated_image: res.data.annotated_image,
          ms: res.data.processing_time_ms,
        };
        setYoloResult(result);
        setYoloError(null);
        if (onDetect) onDetect(result);
      }
    } catch {
      setYoloError("YOLO gagal — coba lagi");
    }
  }, [onDetect]);

  /* ── Toggle auto-detect tiap 5 detik ── */
  const toggleDetect = useCallback(() => {
    if (detecting) {
      clearInterval(intervalRef.current);
      setDetecting(false);
    } else {
      setDetecting(true);
      captureAndDetect();
      intervalRef.current = setInterval(captureAndDetect, 5000);
    }
  }, [detecting, captureAndDetect]);

  /* Bersihkan interval saat unmount */
  useEffect(() => () => clearInterval(intervalRef.current), []);

  if (!streamUrl) return null;

  return (
    <div className="mb-4 rounded-xl overflow-hidden border border-slate-800 bg-black">

      {/* ── Video player ── */}
      <div className="relative aspect-video bg-slate-950">
        <video
          ref={videoRef}
          className="w-full h-full object-cover"
          muted
          playsInline
          crossOrigin="anonymous"
        />

        {/* Overlay: annotated YOLO image */}
        {yoloResult?.annotated_image && (
          <img
            src={`data:image/jpeg;base64,${yoloResult.annotated_image}`}
            className="absolute inset-0 w-full h-full object-cover"
            alt="YOLO"
          />
        )}

        {/* Status badge */}
        {status === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-slate-500 border-t-white rounded-full animate-spin mx-auto mb-2" />
              <p className="text-xs text-slate-400">Memuat stream...</p>
            </div>
          </div>
        )}
        {status === "error" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <div className="text-center px-4">
              <p className="text-2xl mb-1">📡</p>
              <p className="text-xs text-slate-400">Stream tidak tersedia</p>
              <p className="text-[10px] text-slate-600 mt-1">Server CCTV mungkin offline</p>
            </div>
          </div>
        )}

        {/* LIVE badge */}
        {status === "live" && (
          <div className="absolute top-2 left-2 flex items-center gap-1.5 bg-black/60 px-2 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-[10px] font-bold text-white">LIVE</span>
          </div>
        )}

        {/* YOLO vehicle count badge */}
        {yoloResult && (
          <div className="absolute top-2 right-2 bg-emerald-600/90 px-2 py-0.5 rounded-full">
            <span className="text-[10px] font-bold text-white">
              {yoloResult.vehicle_count} kend · {yoloResult.ms}ms
            </span>
          </div>
        )}
      </div>

      {/* ── Canvas tersembunyi untuk capture ── */}
      <canvas ref={canvasRef} className="hidden" />

      {/* ── Kontrol bar ── */}
      <div className="px-3 py-2 bg-slate-900 flex items-center justify-between gap-2">
        <div className="flex-1 min-w-0">
          {corsBlocked && (
            <p className="text-[10px] text-yellow-400">
              ⚠️ CORS diblokir — frame capture tidak tersedia
            </p>
          )}
          {yoloError && !corsBlocked && (
            <p className="text-[10px] text-red-400">{yoloError}</p>
          )}
          {!corsBlocked && !yoloError && yoloResult && (
            <div className="flex gap-2 flex-wrap">
              {Object.entries(yoloResult.class_counts).map(([cls, n]) => (
                <span key={cls} className="text-[10px] text-slate-400">
                  {cls}: {n}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Tombol Analisis YOLO */}
        {!corsBlocked && status === "live" && (
          <button
            onClick={toggleDetect}
            className={`flex-shrink-0 text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-colors ${
              detecting
                ? "bg-red-600 hover:bg-red-700 text-white"
                : "bg-emerald-600 hover:bg-emerald-700 text-white"
            }`}
          >
            {detecting ? "⏹ Stop" : "🔍 Analisis YOLO"}
          </button>
        )}
        {/* Capture sekali */}
        {!corsBlocked && !detecting && status === "live" && (
          <button
            onClick={captureAndDetect}
            className="flex-shrink-0 text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white transition-colors"
          >
            📸 1x
          </button>
        )}
      </div>
    </div>
  );
}
