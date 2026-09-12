// Douyin Max Quality - Loon response rewriter
// Follows Douyin/Aweme's own bitrate ladder: the highest advertised bit_rate wins.

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

  function bitrateOf(f) {
    return num(f && (f.bit_rate || f.bitrate || f.avg_bitrate || f.average_bitrate || 0));
  }

  function dataSizeOf(f) {
    const a = addrOf(f) || {};
    return num(a.data_size || (f && f.data_size) || 0);
  }

  function parseResolutionToken(s) {
    const m = /(\d{3,4})p/i.exec(text(s));
    return m ? num(m[1]) : 0;
  }

  function resolutionOf(f, video) {
    const a = addrOf(f) || {};
    const w = num(a.width || (f && f.width) || 0);
    const h = num(a.height || (f && f.height) || 0);
    if (w && h) return Math.min(w, h);
    return parseResolutionToken(f && f.gear_name) ||
      parseResolutionToken(a.url_key) ||
      parseResolutionToken(video && video.ratio) || 0;
  }

  function fpsOf(f) {
    const a = addrOf(f) || {};
    return num((f && (f.FPS || f.fps)) || a.fps || 0);
  }

  function hdrOf(f) {
    if (!f) return false;
    return num(f.HDR_type || f.hdr_type || f.hdrType || 0) > 0 ||
      num(f.HDR_bit || f.hdr_bit || f.hdrBit || 0) > 8;
  }

  function clone(o) {
    if (!o || typeof o !== "object") return o;
    try { return JSON.parse(JSON.stringify(o)); } catch (_) { return o; }
  }

  function isVideoObject(v) {
    return !!(v && typeof v === "object" && Array.isArray(v.bit_rate) && v.bit_rate.length);
  }

  function pickBest(candidates, video) {
    // Douyin's own rendition ladder is represented by bit_rate / gear_name / quality_type.
    // For "最高画质", follow the client-side convention used by mature Aweme tweaks:
    // select the entry with the highest bit_rate. quality_type is an enum/code, not a
    // monotonically increasing quality score, so it must not be sorted numerically.
    let best = candidates[0];
    let bestBitrate = bitrateOf(best);
    for (let i = 1; i < candidates.length; i++) {
      const br = bitrateOf(candidates[i]);
      if (br > bestBitrate) {
        best = candidates[i];
        bestBitrate = br;
      }
    }

    // Compatibility fallback for unusual responses where bit_rate is missing/zero.
    if (bestBitrate <= 0) {
      for (let i = 1; i < candidates.length; i++) {
        const a = candidates[i];
        const b = best;
        const as = dataSizeOf(a), bs = dataSizeOf(b);
        if (as > bs || (as === bs && resolutionOf(a, video) > resolutionOf(b, video))) best = a;
      }
    }
    return best;
  }

  let changed = 0;
  const picked = [];

  function processVideo(video) {
    if (!isVideoObject(video)) return;
    const candidates = video.bit_rate.filter(f => f && typeof f === "object" && validAddr(addrOf(f)));
    if (!candidates.length) return;

    const best = pickBest(candidates, video);
    const bestAddr = clone(addrOf(best));
    if (!validAddr(bestAddr)) return;

    // Make the highest Douyin rendition the default playback address.
    video.play_addr = bestAddr;
    if (num(best.is_h265 || best.is_bytevc1) > 0) {
      if (Object.prototype.hasOwnProperty.call(video, "play_addr_265")) video.play_addr_265 = clone(bestAddr);
    } else {
      if (Object.prototype.hasOwnProperty.call(video, "play_addr_h264")) video.play_addr_h264 = clone(bestAddr);
    }

    // Leave the native Douyin rendition object intact, but remove lower ABR choices.
    // gear_name / quality_type / HDR_type / FPS and other native metadata are preserved.
    video.bit_rate = [best];

    const r = resolutionOf(best, video);
    if (r) video.ratio = r + "p";
    if (num(bestAddr.width)) video.width = num(bestAddr.width);
    if (num(bestAddr.height)) video.height = num(bestAddr.height);

    const gear = text(best.gear_name) || "unknown";
    const qualityType = best.quality_type != null ? text(best.quality_type) : "-";
    const br = bitrateOf(best);
    const fps = fpsOf(best);
    picked.push(gear + " | q=" + qualityType +
      (r ? " | " + r + "p" : "") +
      (fps ? " | " + fps + "fps" : "") +
      (hdrOf(best) ? " | HDR" : "") +
      (br ? " | " + Math.round(br / 1000) + "kbps" : ""));
    changed++;
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
    console.log("[抖音最高画质] rewritten=" + changed + " | " + picked.slice(0, 8).join(" ; "));
    $done({ body: JSON.stringify(data) });
  } catch (e) {
    console.log("[抖音最高画质] pass-through: " + String(e && e.message || e));
    $done({});
  }
})();
