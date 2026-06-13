// Client for backend /api/chat & /api/chat-stream
const API = process.env.REACT_APP_API_URL || '';

// streamMessage — Chat mode: SSE streaming with typewriter effect
//
// Returns: AbortController (call .abort() to cancel)
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

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const raw = trimmed.slice(5).trim();
          if (!raw) continue;

          try {
            const event = JSON.parse(raw);
            if (event.actions) {
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

      onDone?.();
    } catch (err) {
      if (err.name === 'AbortError') return;
      onError?.(err.message || String(err));
    }
  })();

  return controller;
}

// sendMessage — Edit mode: non-streaming, returns full reply text
async function sendMessage(message, mode = 'chat', history = []) {
  const resp = await fetch(`${API}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, mode, history }),
  });

  try {
    const j = await resp.json();
    if (j && typeof j === 'object' && 'reply' in j) return j.reply;
    const dataText = j && (j.text || j.reply || (typeof j === 'string' ? j : null));
    if (dataText) return String(dataText);
  } catch (e) {
    // not JSON — fall through
  }

  try {
    const raw = await resp.text();
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i].trim());
        const candidate = parsed.reply || parsed.text || parsed.response || parsed;
        if (candidate) return String(candidate);
      } catch {
        // skip
      }
    }
    return raw;
  } catch {
    return '(No reply)';
  }
}

export default { sendMessage, streamMessage };
