// Douyin Max Quality - Loon response rewriter v7
// Conservative mode: preserve recommendation payload and the full native ABR ladder.
// Only prepend the original/high-bitrate resolver to playback URL lists.

(function () {
  const raw = $response && $response.body;
  if (typeof raw !== "string" || !raw.length) { $done({}); return; }

  function text(v) {
    return v == null ? "" : String(v);
  }

  function clone(o) {
    if (!o || typeof o !== "object") return o;
    try { return JSON.parse(JSON.stringify(o)); } catch (_) { return o; }
  }

  function validAddr(a) {
    return !!(a && typeof a === "object" && Array.isArray(a.url_list) && a.url_list.length);
  }

  function uniqueUrls(urls) {
    const out = [];
    const seen = Object.create(null);
    for (let i = 0; i < urls.length; i++) {
      const u = text(urls[i]).trim();
      if (!u || seen[u]) continue;
      seen[u] = 1;
      out.push(u);
    }
    return out;
  }

  function originalUrls(videoId) {
    const id = encodeURIComponent(videoId);
    const common = "video_id=" + id +
      "&ratio=default" +
      "&watermark=0" +
      "&media_type=4" +
      "&vr_type=0" +
      "&improve_bitrate=1" +
      "&is_play_url=1";
    return [
      "https://aweme.snssdk.com/aweme/v1/play/?" + common + "&line=0",
      "https://api.amemv.com/aweme/v1/play/?" + common + "&line=1"
    ];
  }

  function videoIdOf(video) {
    const ids = [
      video && video.play_addr && video.play_addr.uri,
      video && video.play_addr_265 && video.play_addr_265.uri,
      video && video.play_addr_h264 && video.play_addr_h264.uri,
      video && video.vid
    ];
    if (video && Array.isArray(video.bit_rate)) {
      for (let i = 0; i < video.bit_rate.length; i++) {
        const f = video.bit_rate[i];
        const a = f && (f.play_addr || f.playAddr || f.play_addr_265 || f.play_addr_h264);
        if (a && a.uri) ids.push(a.uri);
      }
    }
    for (let i = 0; i < ids.length; i++) {
      const id = text(ids[i]).trim();
      if (id) return id;
    }
    return "";
  }

  function prependOriginal(addr, videoId) {
    if (!validAddr(addr) || !videoId) return false;
    const old = addr.url_list.slice();
    const next = uniqueUrls(originalUrls(videoId).concat(old));
    if (!next.length) return false;
    addr.url_list = next;
    return true;
  }

  let changed = 0;
  const picked = [];

  function processVideo(video) {
    if (!video || typeof video !== "object") return;
    const videoId = videoIdOf(video);
    if (!videoId) return;

    let localChanged = false;

    // Main playback address only. Do not replace the object, do not change codec metadata.
    if (validAddr(video.play_addr)) {
      localChanged = prependOriginal(video.play_addr, videoId) || localChanged;
    }

    // Preserve every native bitrate candidate and its order. Only add the resolver to the
    // highest advertised bitrate candidate, leaving lower ABR fallbacks fully intact.
    if (Array.isArray(video.bit_rate) && video.bit_rate.length) {
      let best = null;
      let bestRate = -1;
      for (let i = 0; i < video.bit_rate.length; i++) {
        const f = video.bit_rate[i];
        if (!f || typeof f !== "object") continue;
        const br = Number(f.bit_rate || f.bitrate || 0) || 0;
        if (br > bestRate) { best = f; bestRate = br; }
      }
      if (best) {
        const addr = best.play_addr || best.playAddr || best.play_addr_265 || best.play_addr_h264;
        if (validAddr(addr)) localChanged = prependOriginal(addr, videoId) || localChanged;
      }
    }

    if (localChanged) {
      changed++;
      picked.push("uri=" + videoId);
    }
  }

  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i]);
      return;
    }

    // Only touch objects explicitly stored under a `video` key. This avoids rewriting
    // recommendation controls, pagination data, user cards, comments and other resources.
    if (node.video && typeof node.video === "object") processVideo(node.video);

    for (const k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k) || k === "video") continue;
      walk(node[k]);
    }
  }

  try {
    const data = JSON.parse(raw);
    walk(data);
    if (!changed) { $done({}); return; }
    console.log("[抖音最高画质 v7] conservative=" + changed + " | " + picked.slice(0, 8).join(" ; "));
    $done({ body: JSON.stringify(data) });
  } catch (e) {
    console.log("[抖音最高画质 v7] pass-through: " + String(e && e.message || e));
    $done({});
  }
})();
