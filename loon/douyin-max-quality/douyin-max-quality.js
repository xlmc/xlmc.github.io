// Douyin Max Quality - Loon request rewriter v9
// Do NOT mutate Douyin's signed /play/ query. Resolve a clean ratio=default URL
// with a side-channel HEAD request, then redirect to the returned signed CDN URL.
// On any failure, leave the original app request byte-for-byte unchanged.

(function () {
  const raw = $request && $request.url;
  if (!raw || typeof raw !== "string") { $done({}); return; }

  function header(headers, name) {
    if (!headers) return "";
    const target = String(name).toLowerCase();
    for (const k in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, k) && String(k).toLowerCase() === target) {
        return String(headers[k] == null ? "" : headers[k]);
      }
    }
    return "";
  }

  function queryValue(url, name) {
    try {
      const u = new URL(url);
      return u.searchParams.get(name) || "";
    } catch (_) {
      const q = url.split("?")[1] || "";
      const h = q.split("#")[0];
      const parts = h ? h.split("&") : [];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i].split("=");
        let k = p[0] || "";
        try { k = decodeURIComponent(k); } catch (_) {}
        if (k === name) {
          let v = p.slice(1).join("=");
          try { v = decodeURIComponent(v); } catch (_) {}
          return v;
        }
      }
      return "";
    }
  }

  try {
    if (!/^https:\/\/(?:aweme\.snssdk\.com|api\.amemv\.com)\/aweme\/v\d+\/play\/?(?:\?|$)/i.test(raw)) {
      $done({}); return;
    }

    // Prevent a possible recursive interception of the probe request itself.
    if (queryValue(raw, "__loon_dyhq_probe") === "1") { $done({}); return; }

    const videoId = queryValue(raw, "video_id");
    if (!videoId) { $done({}); return; }

    const ua = header($request.headers, "User-Agent") ||
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

    const resolver = "https://aweme.snssdk.com/aweme/v1/play/?video_id=" +
      encodeURIComponent(videoId) +
      "&ratio=default&line=0&__loon_dyhq_probe=1";

    $httpClient.head({
      url: resolver,
      timeout: 1800,
      headers: { "User-Agent": ua, "Accept": "*/*" },
      "auto-redirect": false
    }, function (error, response) {
      if (error || !response) {
        console.log("[抖音最高画质 v9] UHD probe failed; keep original request");
        $done({});
        return;
      }

      const status = Number(response.status || 0);
      const location = header(response.headers, "Location");
      if (status >= 300 && status < 400 && /^https?:\/\//i.test(location)) {
        console.log("[抖音最高画质 v9] UHD resolved -> signed CDN");
        $done({ url: location });
        return;
      }

      // Some regions/accounts may not expose the original/UHD resolver. Never force it.
      console.log("[抖音最高画质 v9] no UHD redirect (status=" + status + "); keep original request");
      $done({});
    });
  } catch (e) {
    console.log("[抖音最高画质 v9] pass-through: " + String(e && e.message || e));
    $done({});
  }
})();
