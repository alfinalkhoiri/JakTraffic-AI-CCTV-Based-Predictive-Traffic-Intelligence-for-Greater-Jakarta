import React, { useEffect, useRef, useState, useCallback } from "react";
import axios from "axios";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import chatService from "../services/chat";

const apiBase = process.env.REACT_APP_API_URL || "";

// ─── Komponen renderer markdown untuk pesan assistant ─────────────────────────
function MarkdownMessage({ text }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Paragraf
        p: ({ children }) => (
          <p className="mb-1.5 last:mb-0 leading-relaxed">{children}</p>
        ),
        // Bold
        strong: ({ children }) => (
          <strong className="font-semibold text-white">{children}</strong>
        ),
        // Italic
        em: ({ children }) => (
          <em className="italic text-slate-300">{children}</em>
        ),
        // Unordered list
        ul: ({ children }) => (
          <ul className="mt-1 mb-1.5 ml-3 space-y-0.5 list-none">{children}</ul>
        ),
        // Ordered list
        ol: ({ children }) => (
          <ol className="mt-1 mb-1.5 ml-4 space-y-0.5 list-decimal">{children}</ol>
        ),
        // List item
        li: ({ children }) => (
          <li className="flex items-start gap-1.5 text-slate-200">
            <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
            <span>{children}</span>
          </li>
        ),
        // Heading h3 (AI jarang pakai h1/h2)
        h3: ({ children }) => (
          <h3 className="font-bold text-white text-sm mt-2 mb-1">{children}</h3>
        ),
        h4: ({ children }) => (
          <h4 className="font-semibold text-slate-200 text-xs mt-1.5 mb-0.5 uppercase tracking-wide">{children}</h4>
        ),
        // Inline code
        code: ({ inline, children }) =>
          inline ? (
            <code className="bg-slate-700 text-emerald-300 px-1 py-0.5 rounded text-xs font-mono">
              {children}
            </code>
          ) : (
            <pre className="bg-slate-900 border border-slate-700 rounded-lg p-2 mt-1 mb-1.5 overflow-x-auto">
              <code className="text-xs font-mono text-emerald-300">{children}</code>
            </pre>
          ),
        // Blockquote
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-blue-500 pl-2 my-1 text-slate-400 italic">
            {children}
          </blockquote>
        ),
        // Horizontal rule
        hr: () => <hr className="border-slate-700 my-2" />,
        // Link
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 underline hover:text-blue-300"
          >
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

// ─── Cursor berkedip untuk typewriter effect ──────────────────────────────────
function BlinkingCursor() {
  return (
    <span
      className="inline-block w-0.5 h-3.5 bg-blue-400 ml-0.5 align-middle animate-pulse"
      style={{ animationDuration: "0.7s" }}
    />
  );
}

// ─── LLM Status Dot ──────────────────────────────────────────────────────────
// status: 'checking' | 'online' | 'offline'
function LlmStatusDot({ status, model, error }) {
  const cfg = {
    checking: {
      dot: "bg-slate-500 animate-pulse",
      label: "Memeriksa LLM...",
      text: "text-slate-400",
    },
    online: {
      dot: "bg-emerald-400",
      label: `Online · ${model}`,
      text: "text-emerald-400",
    },
    offline: {
      dot: "bg-red-500",
      label: error || "LLM offline",
      text: "text-red-400",
    },
  }[status] ?? { dot: "bg-slate-500", label: "", text: "text-slate-400" };

  return (
    <div className="group relative flex items-center gap-1.5 cursor-default">
      {/* dot */}
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot}`} />
      {/* label teks di samping dot */}
      <span className={`text-[10px] font-medium ${cfg.text} hidden sm:inline`}>
        {status === "online" ? "Online" : status === "offline" ? "Offline" : "..."}
      </span>
      {/* Tooltip hover */}
      <div
        className="pointer-events-none absolute bottom-full right-0 mb-2 w-max max-w-[220px]
                   bg-slate-800 border border-slate-600 text-slate-200 text-[11px]
                   rounded-lg px-2.5 py-1.5 shadow-xl
                   opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50"
      >
        <div className="font-semibold mb-0.5">{status === "online" ? "🟢 LLM Online" : status === "offline" ? "🔴 LLM Offline" : "⏳ Memeriksa..."}</div>
        <div className="text-slate-400">{cfg.label}</div>
      </div>
    </div>
  );
}

// ─── Komponen utama ChatPopup ─────────────────────────────────────────────────
export default function ChatPopup({ visible, onClose, onMapCommands }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState("chat");
  const [isLoading, setIsLoading] = useState(false);
  // LLM status
  const [llmStatus, setLlmStatus] = useState("checking"); // 'checking' | 'online' | 'offline'
  const [llmModel, setLlmModel] = useState("");
  const [llmError, setLlmError] = useState("");
  const [listening, setListening]   = useState(false);
  const [voiceReply, setVoiceReply] = useState(false);
  const listRef = useRef(null);
  const abortRef = useRef(null);
  const recognitionRef = useRef(null);
  const sendRef = useRef(null);   // ref agar STT bisa panggil send() terbaru

  // ── Cek status LLM ──────────────────────────────────────────────────────────
  const checkLlmStatus = useCallback(async () => {
    try {
      const resp = await fetch(`${apiBase}/api/llm-status`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.online) {
        setLlmStatus("online");
        setLlmModel(data.model || "");
        setLlmError("");
      } else {
        setLlmStatus("offline");
        setLlmModel(data.model || "");
        setLlmError(data.error || "LLM tidak tersedia");
      }
    } catch (e) {
      setLlmStatus("offline");
      setLlmError(e.message || "Tidak dapat menghubungi backend");
    }
  }, []);

  // Cek saat pertama kali popup dibuka, lalu polling setiap 30 detik
  useEffect(() => {
    if (!visible) return;
    checkLlmStatus();
    const interval = setInterval(checkLlmStatus, 30_000);
    return () => clearInterval(interval);
  }, [visible, checkLlmStatus]);

  // Greet on first open
  useEffect(() => {
    if (!visible) return;
    if (messages.length === 0) {
      setMessages([{
        role: "assistant",
        text: "Halo! Saya **AI Assistant** Smart Traffic DKI Jakarta 🚦\n\n• **Mode Chat** — tanya apa saja tentang kondisi lalu lintas\n• **Mode Edit** — ketik perintah perubahan UI, saya langsung edit source code 🚀",
        streaming: false,
      }]);
    }
  }, [visible]);

  // Auto-scroll setiap ada pesan baru / teks berubah
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  // Batalkan streaming kalau popup ditutup
  useEffect(() => {
    if (!visible && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, [visible]);

  const pushMsg = (msg) => setMessages((prev) => [...prev, msg]);

  const replacePending = (newMsg) =>
    setMessages((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].pending) { copy[i] = newMsg; break; }
      }
      return copy;
    });

  // Append teks ke pesan streaming terakhir (index diketahui)
  const appendToStreaming = useCallback((idx, chunk) => {
    setMessages((prev) => {
      const copy = [...prev];
      if (copy[idx]) {
        copy[idx] = { ...copy[idx], text: (copy[idx].text || "") + chunk };
      }
      return copy;
    });
  }, []);

  // Tandai pesan streaming selesai
  const finalizeStreaming = useCallback((idx) => {
    setMessages((prev) => {
      const copy = [...prev];
      if (copy[idx]) {
        copy[idx] = { ...copy[idx], streaming: false };
      }
      return copy;
    });
  }, []);

  // ── TTS: baca respons LLM ─────────────────────────────────────────────────
  const speakResponse = useCallback((text) => {
    if (!voiceReply || !('speechSynthesis' in window)) return;
    const plain = text
      .replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1')
      .replace(/`{1,3}[\s\S]*?`{1,3}/g, '').replace(/#{1,6}\s+/g, '')
      .replace(/\[(.+?)\]\(.+?\)/g, '$1').replace(/>\s+/g, '')
      .replace(/---+/g, '').replace(/\n{2,}/g, '. ').replace(/\n/g, ' ')
      .trim().slice(0, 600);
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(plain);
    utt.lang = 'id-ID'; utt.rate = 1.0; utt.pitch = 1.0;
    const doSpeak = () => {
      const voices = window.speechSynthesis.getVoices();
      const id = voices.find(v => v.lang === 'id-ID') || voices.find(v => v.lang.startsWith('id'));
      if (id) utt.voice = id;
      window.speechSynthesis.speak(utt);
    };
    window.speechSynthesis.getVoices().length === 0
      ? window.speechSynthesis.addEventListener('voiceschanged', doSpeak, { once: true })
      : doSpeak();
  }, [voiceReply]);

  // ── STT: input suara dari mic ─────────────────────────────────────────────
  const toggleMic = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('Browser tidak mendukung pengenalan suara (gunakan Chrome).'); return; }

    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    const recognition = new SR();
    recognition.lang = 'id-ID';
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onresult = (e) => {
      let interim = '';
      for (const result of e.results) {
        if (result.isFinal) {
          const t = result[0].transcript.trim();
          if (t) {
            setInput(t);
            recognitionRef.current?.stop();
            // Auto-kirim setelah suara selesai
            setTimeout(() => sendRef.current?.(t), 100);
          }
        } else {
          interim += result[0].transcript;
          setInput(interim);
        }
      }
    };

    recognition.onend  = () => setListening(false);
    recognition.onerror = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [listening]);

  // ── SEND ───────────────────────────────────────────────────────────────────
  const send = async (textOverride) => {
    const text = (textOverride !== undefined ? textOverride : input).trim();
    if (!text || isLoading) return;
    setInput("");
    sendRef.current = send; // keep ref fresh
    pushMsg({ role: "user", text });
    setIsLoading(true);

    // ── Deteksi perintah simulasi waktu ──────────────────────────────────────
    // Helper: konversi nama bulan Indonesia ke angka
    const BULAN = {
      januari:"01", februari:"02", maret:"03", april:"04",
      mei:"05", juni:"06", juli:"07", agustus:"08",
      september:"09", oktober:"10", november:"11", desember:"12",
    };

    // Coba deteksi format tanggal Indonesia: "23 april 2026 pukul 17:00"
    const indoDateMatch = text.match(
      /(\d{1,2})\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+(\d{4})[\s,]*(?:pukul|jam|at)?\s*(\d{1,2}[:\.]\d{2})/i
    );
    if (indoDateMatch) {
      const [, day, bulan, year, waktu] = indoDateMatch;
      const mm  = BULAN[bulan.toLowerCase()];
      const isoTs = `${year}-${mm}-${day.padStart(2, "0")} ${waktu.replace(".", ":")}`;
      await sendSimTime(isoTs);
      setIsLoading(false);
      return;
    }

    // Pola: "atur/set/ubah waktu simulasi ke/menjadi HH:MM" atau "mundurkan/majukan waktu ke XX:XX"
    const simTimeMatch = text.match(
      /(?:atur|set|ubah|ganti|change|move|mundur|maju|set\s*time|atur\s*waktu|simulasi).*?(?:ke|to|menjadi|jadi|=|:)?\s*(\d{1,2}[:\.]\d{2}(?::\d{2})?|\d{4}-\d{2}-\d{2}[\sT]\d{1,2}:\d{2}(?::\d{2})?)/i
    );

    if (simTimeMatch) {
      await sendSimTime(simTimeMatch[1]);
      setIsLoading(false);
      return;
    }

    if (mode === "edit") {
      await sendEdit(text);
    } else {
      await sendChat(text);
    }

    setIsLoading(false);
  };

  // ── SIM TIME HANDLER ───────────────────────────────────────────────────────
  const sendSimTime = async (timeStr) => {
    pushMsg({ role: "assistant", text: `⏳ Mengatur waktu simulasi ke **${timeStr}**...`, pending: true, streaming: false });
    try {
      // Ambil dulu range yang tersedia
      const rangeRes = await fetch(`${apiBase}/api/sim-time-range`);
      const range = await rangeRes.json();

      const res = await fetch(`${apiBase}/api/set-sim-time`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timestamp: timeStr }),
      });
      const data = await res.json();

      if (res.ok && data.success) {
        replacePending({
          role: "assistant",
          streaming: false,
          text: [
            `✅ **Waktu simulasi berhasil diubah!**`,
            ``,
            `🕐 **Waktu sekarang:** \`${data.sim_time}\``,
            `📍 **Lokasi disync:** ${data.synced_locations} lokasi`,
            ``,
            `Data traffic di peta dan grafik otomatis diperbarui. Browser akan refresh data dalam beberapa detik.`,
            ``,
            `> 💡 **Range data tersedia:** \`${range.min_timestamp}\` s/d \`${range.max_timestamp}\``,
          ].join("\n"),
        });
      } else {
        replacePending({
          role: "assistant",
          streaming: false,
          text: [
            `❌ **Gagal mengubah waktu simulasi**`,
            ``,
            `**Error:** ${data.error || "Unknown error"}`,
            ``,
            `**Range data tersedia:**`,
            `- Dari: \`${range.min_timestamp || "?"}\``,
            `- Sampai: \`${range.max_timestamp || "?"}\``,
            ``,
            `Coba format: \`atur waktu ke 18:00\` atau \`atur waktu ke 2026-04-30 18:00\``,
          ].join("\n"),
        });
      }
    } catch (e) {
      replacePending({
        role: "assistant",
        streaming: false,
        text: `❌ **Error:** Tidak dapat menghubungi backend. Pastikan server berjalan.\n\n\`${e.message}\``,
      });
    }
  };

  // ── CHAT MODE — streaming SSE ──────────────────────────────────────────────
  const sendChat = (text) => {
    return new Promise((resolve) => {
      let accText = ''; // akumulasi teks untuk TTS

      // Ambil max 10 pesan terakhir sebagai konteks
      const history = messages
        .filter((m) => !m.pending && !m.editResult && (m.role === "user" || m.role === "assistant"))
        .slice(-10)
        .map((m) => ({ role: m.role, content: m.text }));

      // Tambah placeholder pesan streaming
      const streamingIdx = messages.length + 1; // +1 karena user message sudah push
      setMessages((prev) => {
        const copy = [...prev];
        copy.push({ role: "assistant", text: "", streaming: true });
        return copy;
      });

      const ctrl = chatService.streamMessage(
        text,
        history,
        // onChunk — append teks baru
        (chunk) => {
          accText += chunk;
          setMessages((prev) => {
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].streaming) {
                copy[i] = { ...copy[i], text: copy[i].text + chunk };
                break;
              }
            }
            return copy;
          });
        },
        // onDone — selesai streaming
        () => {
          setMessages((prev) => {
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].streaming) {
                copy[i] = { ...copy[i], streaming: false };
                break;
              }
            }
            return copy;
          });
          speakResponse(accText); // baca respons jika voice reply aktif
          abortRef.current = null;
          resolve();
        },
        // onError
        (errMsg) => {
          setMessages((prev) => {
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].streaming) {
                copy[i] = {
                  ...copy[i],
                  text: `❌ Gagal terhubung ke server chat: ${errMsg}`,
                  streaming: false,
                };
                break;
              }
            }
            return copy;
          });
          abortRef.current = null;
          resolve();
        },
        // onActions — eksekusi map commands dari backend
        (actions) => {
          if (onMapCommands && actions?.length) {
            onMapCommands(actions);
            // Simpan actions ke pesan streaming terakhir untuk feedback chips
            setMessages((prev) => {
              const copy = [...prev];
              for (let i = copy.length - 1; i >= 0; i--) {
                if (copy[i].streaming && copy[i].role === "assistant") {
                  copy[i] = { ...copy[i], mapActions: actions };
                  break;
                }
              }
              return copy;
            });
          }
        }
      );

      abortRef.current = ctrl;
    });
  };

  // ── EDIT MODE ─────────────────────────────────────────────────────────────
  const sendEdit = async (text) => {
    pushMsg({ role: "assistant", text: "🤖 AI sedang menganalisis dan mengubah kode...", pending: true });
    try {
      const resp = await axios.post(`${apiBase}/api/chat-edit`, { message: text });
      const r = resp.data;

      if (r.success) {
        const fileList = r.applied.map((f) => `  • ${f}`).join("\n");
        replacePending({
          role: "assistant",
          text: `✅ ${r.summary}\n\nFile diubah:\n${fileList}\n\n💡 Browser akan auto-refresh (React hot-reload).`,
          editResult: r,
        });
      } else {
        const errList = r.errors?.map((e) => `  • ${e.path}: ${e.error}`).join("\n") || "";
        const rawInfo = r.raw ? `\n\n🔍 Raw AI output:\n${r.raw.slice(0, 400)}` : "";
        replacePending({
          role: "assistant",
          text: `❌ ${r.error || "Gagal menerapkan perubahan."}\n${errList}${rawInfo}`,
          editResult: r,
        });
      }
    } catch (e) {
      const msg = e?.response?.data?.error || e?.response?.data?.raw || e.message || String(e);
      replacePending({ role: "assistant", text: `❌ Error: ${msg}` });
    }
  };

  // ── UNDO ──────────────────────────────────────────────────────────────────
  const handleUndo = async (backups, msgIndex) => {
    try {
      const resp = await axios.post(`${apiBase}/api/undo-edit`, { backups });
      const r = resp.data;
      const restoredList = r.restored?.map((f) => `  • ${f}`).join("\n") || "";
      setMessages((prev) => {
        const copy = [...prev];
        copy[msgIndex] = {
          ...copy[msgIndex],
          text: r.success
            ? `↩️ Undo berhasil!\n\nFile dipulihkan:\n${restoredList}`
            : `❌ Undo gagal: ${(r.errors || []).map((e) => e.error).join(", ")}`,
          editResult: null,
        };
        return copy;
      });
    } catch (e) {
      alert("Undo gagal: " + (e.message || String(e)));
    }
  };

  if (!visible) return null;

  // ── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div className="fixed z-[2000] flex flex-col overflow-hidden bg-slate-900 border border-slate-700 shadow-2xl bottom-0 left-0 right-0 rounded-t-2xl h-[85vh] sm:bottom-20 sm:right-6 sm:left-auto sm:w-[400px] sm:h-[560px] sm:rounded-xl sm:border">

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900">
        <div>
          <div className="font-bold text-white text-sm flex items-center gap-1.5">
            🤖 AI Assistant
            {isLoading && (
              <span className="flex gap-0.5 ml-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-1 h-1 bg-blue-400 rounded-full animate-bounce"
                    style={{ animationDelay: `${i * 0.15}s` }}
                  />
                ))}
              </span>
            )}
          </div>
          <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-2">
            <span>
              Mode:{" "}
              <span className={mode === "edit" ? "text-violet-400 font-bold" : "text-blue-400"}>
                {mode === "edit" ? "Edit (Auto-Apply)" : "Chat"}
              </span>
            </span>
            <span className="text-slate-700">·</span>
            <LlmStatusDot status={llmStatus} model={llmModel} error={llmError} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Voice reply toggle */}
          <button
            onClick={() => { setVoiceReply(v => !v); if (voiceReply) window.speechSynthesis?.cancel(); }}
            title={voiceReply ? 'Matikan balas suara' : 'Aktifkan balas suara AI'}
            className={`text-base px-2 py-1 rounded-lg border transition-colors ${voiceReply ? 'bg-blue-900/50 border-blue-600 text-blue-300' : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300'}`}
          >
            {voiceReply ? '🔊' : '🔇'}
          </button>
          {/* Mode toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <div
              onClick={() => setMode((m) => (m === "chat" ? "edit" : "chat"))}
              className={`w-10 h-5 rounded-full transition-colors relative ${mode === "edit" ? "bg-violet-600" : "bg-slate-600"}`}
            >
              <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all ${mode === "edit" ? "left-5" : "left-0.5"}`} />
            </div>
            <span className="text-xs text-slate-400">Edit</span>
          </label>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none">✕</button>
        </div>
      </div>

      {/* Edit mode banner */}
      {mode === "edit" && (
        <div className="px-3 py-1.5 bg-violet-900/40 border-b border-violet-800 text-xs text-violet-300">
          ✏️ Ketik perintah perubahan UI — AI akan langsung edit source code
        </div>
      )}

      {/* Message list */}
      <div ref={listRef} className="flex-1 p-3 overflow-y-auto space-y-3">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[92%] px-3 py-2.5 rounded-xl text-sm ${
                m.role === "user"
                  ? "bg-blue-600 text-white rounded-br-none"
                  : m.pending
                    ? "bg-slate-800 text-slate-400 italic"
                    : m.editResult?.success
                      ? "bg-emerald-900/60 border border-emerald-700 text-emerald-100"
                      : m.editResult && !m.editResult.success
                        ? "bg-red-900/60 border border-red-700 text-red-100"
                        : "bg-slate-800 text-slate-200"
              } rounded-bl-none`}
            >
              {/* Pesan user atau edit — tampil plain */}
              {m.role === "user" || m.editResult || m.pending ? (
                <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
              ) : (
                /* Pesan assistant — render markdown */
                <div className="prose-chat">
                  <MarkdownMessage text={m.text || ""} />
                  {/* Cursor berkedip saat streaming */}
                  {m.streaming && <BlinkingCursor />}
                </div>
              )}

              {/* Undo button — hanya muncul jika edit berhasil dan ada backup */}
              {m.editResult?.success && m.editResult?.backups?.length > 0 && (
                <button
                  onClick={() => handleUndo(m.editResult.backups, i)}
                  className="mt-2 text-xs bg-slate-700 hover:bg-slate-600 text-white px-3 py-1 rounded-lg transition-colors"
                >
                  ↩️ Undo perubahan
                </button>
              )}

              {/* Map action chips — feedback visual setelah chatbot kontrol peta */}
              {m.mapActions?.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {m.mapActions.map((act, ai) => {
                    const chipInfo = {
                      select_pin:      { icon: "📍", label: "Pin diklik" },
                      highlight_pins:  { icon: "⚖️", label: "Mode Banding" },
                      fly_to:          { icon: "🗺️", label: "Peta di-zoom" },
                      set_route:       { icon: "🛣️", label: "Rute diset" },
                      clear_selection: { icon: "✕",  label: "Peta direset" },
                    }[act.type] || { icon: "⚡", label: act.type };
                    return (
                      <span
                        key={ai}
                        className="inline-flex items-center gap-1 text-[10px] bg-blue-900/40 border border-blue-700/50 text-blue-300 px-2 py-0.5 rounded-full"
                      >
                        {chipInfo.icon} {chipInfo.label}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="p-3 border-t border-slate-800">
        <div className="flex gap-2">
          {/* Mic button */}
          <button
            onClick={toggleMic}
            disabled={isLoading}
            title={listening ? 'Berhenti mendengarkan' : 'Bicara ke AI'}
            className={`flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-base transition-all border ${
              listening
                ? 'bg-red-600 border-red-500 text-white animate-pulse'
                : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white hover:border-slate-500'
            } ${isLoading ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            {listening ? '⏹' : '🎤'}
          </button>

          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) send(); }}
            className="flex-1 bg-slate-800 px-3 py-2 rounded-xl text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            disabled={isLoading || listening}
            placeholder={listening ? '🎤 Mendengarkan...' : mode === "chat" ? "Tanyakan sesuatu..." : "Contoh: ubah warna header menjadi biru gelap"}
          />
          <button
            onClick={() => send()}
            disabled={isLoading}
            className={`px-4 py-2 rounded-xl text-white text-sm font-semibold transition-colors ${
              isLoading ? "bg-slate-700 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-500"
            }`}
          >
            {isLoading ? "…" : "Kirim"}
          </button>
        </div>
        {listening && (
          <p className="text-xs text-red-400 text-center mt-1.5 animate-pulse">Sedang merekam — bicara sekarang...</p>
        )}
      </div>
    </div>
  );
}
