// Douyin Max Quality - Loon request rewriter v8
// Do not touch feed/detail JSON. Only rewrite the actual /aweme/v*/play/ request
// so recommendation, pagination, comments and profile payloads stay byte-for-byte original.

(function () {
  const raw = $request && $request.url;
  if (!raw || typeof raw !== "string") { $done({}); return; }

  function manualRewrite(input) {
    const hashPos = input.indexOf("#");
    const hash = hashPos >= 0 ? input.slice(hashPos) : "";
    const main = hashPos >= 0 ? input.slice(0, hashPos) : input;
    const qPos = main.indexOf("?");
    const base = qPos >= 0 ? main.slice(0, qPos) : main;
    const query = qPos >= 0 ? main.slice(qPos + 1) : "";
    const parts = query ? query.split("&") : [];
    const kept = [];
    let hasRatio = false, hasImprove = false, hasWatermark = false;

    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      const eq = parts[i].indexOf("=");
      const rawKey = eq >= 0 ? parts[i].slice(0, eq) : parts[i];
      let key = rawKey;
      try { key = decodeURIComponent(rawKey); } catch (_) {}
      const lower = key.toLowerCase();

      // These pin a specific transcoded ladder and can defeat ratio=default.
      if (lower === "quality_type" || /^adapt\d+$/.test(lower)) continue;

      if (lower === "ratio") {
        if (!hasRatio) kept.push(rawKey + "=default");
        hasRatio = true;
        continue;
      }
      if (lower === "improve_bitrate") {
        if (!hasImprove) kept.push(rawKey + "=1");
        hasImprove = true;
        continue;
      }
      if (lower === "watermark") {
        if (!hasWatermark) kept.push(rawKey + "=0");
        hasWatermark = true;
        continue;
      }
      kept.push(parts[i]);
    }

    if (!hasRatio) kept.push("ratio=default");
    if (!hasImprove) kept.push("improve_bitrate=1");
    if (!hasWatermark) kept.push("watermark=0");
    return base + "?" + kept.join("&") + hash;
  }

  try {
    if (!/\/aweme\/v\d+\/play\/?(?:\?|$)/i.test(raw)) { $done({}); return; }

    let next = raw;
    try {
      const u = new URL(raw);
      if (!u.searchParams.get("video_id")) { $done({}); return; }
      u.searchParams.set("ratio", "default");
      u.searchParams.set("improve_bitrate", "1");
      u.searchParams.set("watermark", "0");
      u.searchParams.delete("quality_type");

      const keys = [];
      u.searchParams.forEach(function (_, key) { keys.push(key); });
      for (let i = 0; i < keys.length; i++) {
        if (/^adapt\d+$/i.test(keys[i])) u.searchParams.delete(keys[i]);
      }
      next = u.toString();
    } catch (_) {
      next = manualRewrite(raw);
    }

    if (next === raw) { $done({}); return; }
    console.log("[抖音最高画质 v8] playback request -> ratio=default, improve_bitrate=1");
    $done({ url: next });
  } catch (e) {
    console.log("[抖音最高画质 v8] pass-through: " + String(e && e.message || e));
    $done({});
  }
})();
