import React, { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";

// Set REACT_APP_CCTV_PROXY in .env after deploying cloudflare-worker.js
// Example: REACT_APP_CCTV_PROXY=https://jaktraffic-cctv.yourname.workers.dev
const WORKER_URL = process.env.REACT_APP_CCTV_PROXY || "";

function buildProxiedUrl(m3u8) {
  if (!m3u8) return null;
  if (WORKER_URL) return `${WORKER_URL}/?url=${encodeURIComponent(m3u8)}`;
  return m3u8; // fallback: direct (will CORS-fail, shows error state)
}

function toEmbedUrl(m3u8) {
  if (!m3u8) return null;
  if (m3u8.includes("balitower.co.id"))
    return m3u8.replace("/index.m3u8", "/embed.html");
  return m3u8;
}

function openPopup(url) {
  const w = 720, h = 460;
  const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
  const top  = Math.round(window.screenY + (window.outerHeight - h) / 2);
  window.open(url, "cctv_live", `width=${w},height=${h},left=${left},top=${top},resizable=yes`);
}

export default function CCTVPreview({ previewUrl, name }) {
  const videoRef = useRef(null);
  const hlsRef   = useRef(null);
  const [status, setStatus] = useState("loading");
  const embedUrl = toEmbedUrl(previewUrl);
  const proxyUrl = buildProxiedUrl(previewUrl);

  const startHls = useCallback((src) => {
    const video = videoRef.current;
    if (!video || !src) { setStatus("error"); return; }

    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    if (Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 10,
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 6,
        enableWorker: false,
        xhrSetup: (xhr) => { xhr.withCredentials = false; },
      });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        setStatus("playing");
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          hls.destroy();
          hlsRef.current = null;
          setStatus("error");
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS
      video.src = src;
      video.onloadedmetadata = () => { video.play().catch(() => {}); setStatus("playing"); };
      video.onerror = () => setStatus("error");
    } else {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    setStatus("loading");
    startHls(proxyUrl);
    return () => {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
  }, [previewUrl, proxyUrl, startHls]);

  if (!previewUrl) return null;

  return (
    <div className="mb-4 rounded-xl overflow-hidden border border-slate-700 bg-black">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-2 bg-slate-800 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
            status === "playing" ? "bg-emerald-400 animate-pulse" :
            status === "error"   ? "bg-red-500" :
            "bg-yellow-400 animate-pulse"
          }`} />
          <span className="text-xs font-bold text-white">
            {status === "playing" ? "Live CCTV" :
             status === "error"   ? "Stream Tidak Tersedia" :
             "Menghubungkan..."}
          </span>
        </div>
        {embedUrl && (
          <button
            onClick={() => openPopup(embedUrl)}
            className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
          >
            Buka Penuh ↗
          </button>
        )}
      </div>

      {/* Video area */}
      <div className="relative w-full bg-black" style={{ paddingBottom: "56.25%" }}>
        <video
          ref={videoRef}
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${
            status === "playing" ? "opacity-100" : "opacity-0"
          }`}
          muted playsInline autoPlay
        />

        {/* Loading state */}
        {status === "loading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900 gap-3">
            <div className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="w-2 h-2 bg-blue-400 rounded-full animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </div>
            <p className="text-xs text-slate-400">
              {WORKER_URL ? "Menghubungkan via proxy..." : "Mencoba stream langsung..."}
            </p>
          </div>
        )}

        {/* Error state */}
        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900 gap-3 p-4">
            {WORKER_URL ? (
              <>
                <span className="text-3xl opacity-40">📡</span>
                <p className="text-xs text-slate-400 text-center leading-relaxed">
                  Stream tidak dapat dimuat.<br />
                  <span className="text-slate-500">Server CCTV sedang tidak merespons.</span>
                </p>
              </>
            ) : (
              <>
                <span className="text-3xl opacity-40">⚙️</span>
                <p className="text-xs text-slate-400 text-center leading-relaxed">
                  Proxy belum dikonfigurasi.<br />
                  <span className="text-slate-500">Deploy Cloudflare Worker lalu set<br />
                  <code className="text-blue-400 text-[10px]">REACT_APP_CCTV_PROXY</code> di <code className="text-blue-400 text-[10px]">.env</code></span>
                </p>
              </>
            )}
            {embedUrl && (
              <button
                onClick={() => openPopup(embedUrl)}
                className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-5 py-2 rounded-lg transition-colors flex items-center gap-2"
              >
                🎥 Buka Preview CCTV
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
