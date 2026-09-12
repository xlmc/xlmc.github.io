// Douyin Max Quality - Shadowrocket response rewriter
// Keeps only the best advertised video rendition in mobile Aweme JSON responses.

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

  function addrOf(f) {
    return (f && (f.play_addr || f.playAddr || f.play_addr_265 || f.play_addr_h264)) || null;
  }

  function validAddr(a) {
    return !!(a && Array.isArray(a.url_list) && a.url_list.length);
  }

  function parseResolutionToken(s) {
    const m = /(\d{3,4})p/i.exec(text(s));
    return m ? num(m[1]) : 0;
  }

  function resolutionOf(f, video) {
    const a = addrOf(f) || {};
    const w = num(a.width || f.width || 0);
    const h = num(a.height || f.height || 0);
    if (w && h) return Math.min(w, h);
    return parseResolutionToken(f.gear_name) ||
      parseResolutionToken(a.url_key) ||
      parseResolutionToken(f.quality_label) ||
      parseResolutionToken(video && video.ratio) || 0;
  }

  function hdrOf(f, video) {
    const a = addrOf(f) || {};
    const hdrType = num(f.HDR_type || f.hdr_type || f.hdrType || 0);
    const hdrBit = num(f.HDR_bit || f.hdr_bit || f.hdrBit || 0);
    if (hdrType > 0 || hdrBit > 8) return 1;
    if (num(video && (video.is_source_HDR || video.is_source_hdr)) > 0) return 1;
    const s = [f.gear_name, f.format, f.dynamic_range, f.color_space, a.url_key].map(text).join(" ");
    return /\b(?:hdr|pq|hlg|dolby|dv)\b/i.test(s) ? 1 : 0;
  }

  function fpsOf(f) {
    const a = addrOf(f) || {};
    return num(f.fps || a.fps || 0);
  }

  function bitrateOf(f) {
    return num(f.bit_rate || f.bitrate || f.avg_bitrate || f.average_bitrate || 0);
  }

  function sizeOf(f) {
    const a = addrOf(f) || {};
    return num(a.data_size || f.data_size || 0);
  }

  function codecScore(f) {
    if (num(f.is_h265 || f.is_bytevc1) > 0) return 1;
    const a = addrOf(f) || {};
    return /(?:h265|hevc|bytevc1)/i.test(text(a.url_key) + " " + text(f.format)) ? 1 : 0;
  }

  function rank(f, video) {
    return [resolutionOf(f, video), hdrOf(f, video), fpsOf(f), bitrateOf(f), codecScore(f), sizeOf(f)];
  }

  function better(a, b, video) {
    const ra = rank(a, video), rb = rank(b, video);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] !== rb[i]) return ra[i] > rb[i];
    }
    return false;
  }

  function clone(o) {
    if (!o || typeof o !== "object") return o;
    try { return JSON.parse(JSON.stringify(o)); } catch (_) { return o; }
  }

  function isVideoObject(v) {
    return !!(v && typeof v === "object" && Array.isArray(v.bit_rate) && v.bit_rate.length);
  }

  let changed = 0;
  const picked = [];

  function processVideo(video) {
    if (!isVideoObject(video)) return;
    const candidates = video.bit_rate.filter(f => f && typeof f === "object" && validAddr(addrOf(f)));
    if (!candidates.length) return;

    let best = candidates[0];
    for (let i = 1; i < candidates.length; i++) if (better(candidates[i], best, video)) best = candidates[i];

    const bestAddr = clone(addrOf(best));
    if (!validAddr(bestAddr)) return;

    video.play_addr = bestAddr;
    if (num(best.is_h265 || best.is_bytevc1) > 0) {
      if (Object.prototype.hasOwnProperty.call(video, "play_addr_265")) video.play_addr_265 = clone(bestAddr);
    } else {
      if (Object.prototype.hasOwnProperty.call(video, "play_addr_h264")) video.play_addr_h264 = clone(bestAddr);
    }

    // Remove lower ABR candidates so the mobile player cannot down-select to them.
    video.bit_rate = [best];

    const r = resolutionOf(best, video);
    if (r) video.ratio = r + "p";
    if (num(bestAddr.width)) video.width = num(bestAddr.width);
    if (num(bestAddr.height)) video.height = num(bestAddr.height);

    changed++;
    picked.push((best.gear_name || (r ? r + "p" : "unknown")) +
      (hdrOf(best, video) ? " HDR" : "") +
      (fpsOf(best) ? " " + fpsOf(best) + "fps" : "") +
      (bitrateOf(best) ? " " + Math.round(bitrateOf(best) / 1000) + "kbps" : ""));
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
    console.log("[Douyin Max Quality] rewritten=" + changed + " | " + picked.slice(0, 8).join(" ; "));
    $done({ body: JSON.stringify(data) });
  } catch (e) {
    console.log("[Douyin Max Quality] pass-through: " + String(e && e.message || e));
    $done({});
  }
})();
