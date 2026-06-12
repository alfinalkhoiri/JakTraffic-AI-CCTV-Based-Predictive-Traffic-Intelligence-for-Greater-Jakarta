// Robust client for backend /api/chat & /api/chat-stream
// Default to backend URL so dev server requests go to Flask when REACT_APP_API_URL is not set.
const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

// ─────────────────────────────────────────────────────────────────────────────
// streamMessage — mode Chat: SSE streaming dengan typewriter effect
//
// Params:
//   message   : string pesan user
//   history   : array { role, content } — max 10 turns terakhir
//   onChunk   : callback(chunkText: string) — dipanggil per chunk teks baru
//   onDone    : callback() — dipanggil saat stream selesai
//   onError   : callback(errMsg: string) — dipanggil jika ada error
//   onActions : callback(actions: Array) — dipanggil dengan map actions dari backend
//
// Returns: abort controller (bisa dipakai untuk cancel)
// ─────────────────────────────────────────────────────────────────────────────
function streamMessage(message, history = [], onChunk, onDone, onError, onActions) {
  const controller = new AbortController();

  (async () => {
    try {
      const resp = await fetch(`${API}/api/chat-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        onError?.(`Server error: ${resp.status}`);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE format: setiap event dipisah "\n\n", setiap baris mulai "data: "
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // simpan baris yang belum lengkap

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const raw = trimmed.slice(5).trim();
          if (!raw) continue;

          try {
            const event = JSON.parse(raw);
            if (event.actions) {
              // Map actions dari backend — dipanggil setelah done
              onActions?.(event.actions);
            } else if (event.chunk) {
              onChunk?.(event.chunk);
            } else if (event.done) {
              onDone?.();
              return;
            } else if (event.error) {
              onError?.(event.error);
              return;
            }
          } catch {
            // ignore malformed JSON
          }
        }
      }

      // Stream berakhir tanpa event "done" — anggap selesai
      onDone?.();
    } catch (err) {
      if (err.name === 'AbortError') return; // dibatalkan user — bukan error
      onError?.(err.message || String(err));
    }
  })();

  return controller;
}

// ─────────────────────────────────────────────────────────────────────────────
// sendMessage — dipakai untuk mode Edit (non-streaming, return full text)
// history: array of { role: 'user'|'assistant', content: string }
// ─────────────────────────────────────────────────────────────────────────────
async function sendMessage(message, mode = 'chat', history = []) {
  const resp = await fetch(`${API}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, mode, history }),
  });

  // Try JSON parse first
  try {
    const j = await resp.json();
    if (j && typeof j === 'object' && 'reply' in j) return j.reply;
    const dataText = j && (j.text || j.reply || (typeof j === 'string' ? j : null));
    if (dataText) return String(dataText);
  } catch (e) {
    // not JSON — fall through
  }

  // Fallback: raw text (could be NDJSON stream). Try to extract last JSON-like chunk.
  try {
    const raw = await resp.text();
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      try {
        const parsed = JSON.parse(line);
        const candidate = parsed.reply || parsed.text || parsed.response || parsed;
        if (candidate) return String(candidate);
      } catch (err) {
        // not JSON — skip
      }
    }
    return raw;
  } catch (err) {
    return '(No reply)';
  }
}

export default { sendMessage, streamMessage };
