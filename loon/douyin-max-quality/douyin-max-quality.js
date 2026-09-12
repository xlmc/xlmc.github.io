// Douyin Max Quality - Loon response rewriter
// Prefer Douyin's original/high-bitrate play endpoint (ratio=default + improve_bitrate=1),
// then fall back to the highest advertised bit_rate rendition.

(function () {
  const raw = $response && $response.body;
  if (typeof raw !== "string" || !raw.length) { $done({}); return; }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

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

  function addrOf(f) {
    return (f && (f.play_addr || f.playAddr || f.play_addr_265 || f.play_addr_h264)) || null;
  }

  function bitrateOf(f) {
    return num(f && (f.bit_rate || f.bitrate || f.avg_bitrate || f.average_bitrate || 0));
  }

  function dataSizeOf(f) {
    const a = addrOf(f) || {};
    return num(a.data_size || (f && f.data_size) || 0);
  }

  function isVideoObject(v) {
    if (!v || typeof v !== "object") return false;
    if (validAddr(v.play_addr) && text(v.play_addr.uri)) return true;
    return Array.isArray(v.bit_rate) && v.bit_rate.some(f => f && typeof f === "object" && validAddr(addrOf(f)));
  }

  function pickHighestBitrate(candidates) {
    if (!candidates.length) return null;
    let best = candidates[0];
    let bestBr = bitrateOf(best);
    for (let i = 1; i < candidates.length; i++) {
      const br = bitrateOf(candidates[i]);
      if (br > bestBr || (br === bestBr && dataSizeOf(candidates[i]) > dataSizeOf(best))) {
        best = candidates[i];
        bestBr = br;
      }
    }
    return best;
  }

  function videoIdOf(video, fallbackAddr) {
    const ids = [
      video && video.play_addr && video.play_addr.uri,
      video && video.play_addr_265 && video.play_addr_265.uri,
      video && video.play_addr_h264 && video.play_addr_h264.uri,
      fallbackAddr && fallbackAddr.uri,
      video && video.vid
    ];
    for (let i = 0; i < ids.length; i++) {
      const id = text(ids[i]).trim();
      if (id) return id;
    }
    return "";
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

  function makePreferredAddr(baseAddr, videoId) {
    const out = clone(baseAddr) || {};
    const fallback = validAddr(baseAddr) ? baseAddr.url_list : [];
    out.uri = videoId;
    // High-bitrate/original endpoints first. Existing CDN/play URLs remain as safe fallback.
    out.url_list = uniqueUrls(originalUrls(videoId).concat(fallback));
    return out;
  }

  let changed = 0;
  const picked = [];

  function processVideo(video) {
    if (!isVideoObject(video)) return;

    const candidates = Array.isArray(video.bit_rate)
      ? video.bit_rate.filter(f => f && typeof f === "object" && validAddr(addrOf(f)))
      : [];
    const best = pickHighestBitrate(candidates);
    const fallbackAddr = (best && addrOf(best)) || video.play_addr || video.play_addr_265 || video.play_addr_h264;
    if (!validAddr(fallbackAddr)) return;

    const videoId = videoIdOf(video, fallbackAddr);
    if (!videoId) return;

    const preferredAddr = makePreferredAddr(fallbackAddr, videoId);
    if (!validAddr(preferredAddr)) return;

    // Force the player toward the original/high-bitrate resolver while keeping native fallback URLs.
    video.play_addr = clone(preferredAddr);
    if (Object.prototype.hasOwnProperty.call(video, "play_addr_265")) video.play_addr_265 = clone(preferredAddr);
    if (Object.prototype.hasOwnProperty.call(video, "play_addr_h264")) video.play_addr_h264 = clone(preferredAddr);

    // Keep one native rendition object so ABR cannot immediately down-select to lower ladders.
    // Only its playback address is redirected to the original/high-bitrate resolver; all native
    // gear_name / quality_type / codec / HDR / FPS metadata remains untouched.
    if (best) {
      const preferred = clone(best);
      if (preferred.play_addr) preferred.play_addr = clone(preferredAddr);
      else if (preferred.playAddr) preferred.playAddr = clone(preferredAddr);
      else preferred.play_addr = clone(preferredAddr);
      if (preferred.play_addr_265) preferred.play_addr_265 = clone(preferredAddr);
      if (preferred.play_addr_h264) preferred.play_addr_h264 = clone(preferredAddr);
      video.bit_rate = [preferred];
    }

    changed++;
    picked.push("uri=" + videoId +
      " | original/default" +
      (best ? " | fallback=" + (text(best.gear_name) || "highest-bitrate") : "" ) +
      (best && bitrateOf(best) ? " | " + Math.round(bitrateOf(best) / 1000) + "kbps" : ""));
  }

  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i]);
      return;
    }

    if (isVideoObject(node)) processVideo(node);

    for (const k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k) || k === "bit_rate") continue;
      walk(node[k]);
    }
  }

  try {
    const data = JSON.parse(raw);
    walk(data);
    if (!changed) { $done({}); return; }
    console.log("[抖音最高画质 v5] original-priority=" + changed + " | " + picked.slice(0, 8).join(" ; "));
    $done({ body: JSON.stringify(data) });
  } catch (e) {
    console.log("[抖音最高画质 v5] pass-through: " + String(e && e.message || e));
    $done({});
  }
})();
