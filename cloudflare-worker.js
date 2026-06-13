/**
 * JakTraffic CCTV Proxy — Cloudflare Worker
 *
 * Deploy: dash.cloudflare.com → Workers & Pages → Create Worker → paste this code
 *
 * Usage: https://<your-worker>.workers.dev/?url=<encoded-balitower-m3u8-url>
 * Example: https://jaktraffic-cctv.example.workers.dev/?url=https%3A%2F%2Fcctv.balitower.co.id%2FKaret-Tengsin-005-700086_2%2Findex.m3u8
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const ALLOWED_ORIGIN = "https://cctv.balitower.co.id";

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const reqUrl = new URL(request.url);
    const targetUrl = reqUrl.searchParams.get("url");

    if (!targetUrl) {
      return new Response("Missing ?url= parameter", { status: 400, headers: CORS_HEADERS });
    }

    // Security: only proxy Balitower CCTV URLs
    if (!targetUrl.startsWith(ALLOWED_ORIGIN + "/")) {
      return new Response("Forbidden: only Balitower CCTV URLs allowed", { status: 403, headers: CORS_HEADERS });
    }

    try {
      const upstream = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125",
          "Referer": ALLOWED_ORIGIN + "/",
          "Origin": ALLOWED_ORIGIN,
        },
      });

      const contentType = upstream.headers.get("content-type") || "";
      const isPlaylist =
        targetUrl.endsWith(".m3u8") ||
        contentType.includes("mpegurl") ||
        contentType.includes("x-mpegURL");

      if (isPlaylist) {
        // Rewrite segment/playlist URLs so they also route through this Worker
        const text = await upstream.text();
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
        const workerProxy = `${reqUrl.origin}/?url=`;

        const rewritten = text
          .split("\n")
          .map((line) => {
            const trimmed = line.trim();
            if (trimmed === "" || trimmed.startsWith("#")) return line;
            const abs = trimmed.startsWith("http") ? trimmed : baseUrl + trimmed;
            return workerProxy + encodeURIComponent(abs);
          })
          .join("\n");

        return new Response(rewritten, {
          status: upstream.status,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "no-store",
          },
        });
      }

      // For .ts segments and other binary content — stream through directly
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": contentType || "video/MP2T",
          "Cache-Control": "public, max-age=5",
        },
      });
    } catch (err) {
      return new Response(`Upstream error: ${err.message}`, {
        status: 502,
        headers: CORS_HEADERS,
      });
    }
  },
};
