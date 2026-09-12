// YouTube Max Quality - Player target resolver for Loon
// Reads /youtubei/v1/player protobuf and selects the highest official-style quality tier:
// resolution > HDR > frame rate > bitrate.

(function () {
  const bytes = $response && $response.body;
  const requestUrl = ($request && $request.url) || "";
  if (!(bytes instanceof Uint8Array)) { $done({}); return; }

  function readVarint(buf, pos, end) {
    let value = 0, mul = 1, count = 0;
    while (pos < end && count < 10) {
      const b = buf[pos++];
      value += (b & 0x7f) * mul;
      if (b < 0x80) return [value, pos];
      mul *= 128;
      count++;
    }
    throw new Error("bad varint");
  }
  function readBytes(buf, pos, end) {
    const r = readVarint(buf, pos, end), len = r[0], start = r[1], finish = start + len;
    if (finish > end) throw new Error("truncated field");
    return [start, finish, finish];
  }
  function skipField(buf, pos, end, wire) {
    if (wire === 0) return readVarint(buf, pos, end)[1];
    if (wire === 1) return Math.min(pos + 8, end);
    if (wire === 2) return readBytes(buf, pos, end)[2];
    if (wire === 5) return Math.min(pos + 4, end);
    throw new Error("unsupported wire type " + wire);
  }
  function utf8(buf, start, end) {
    try { return new TextDecoder("utf-8").decode(buf.slice(start, end)); }
    catch (_) {
      let s = "";
      for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]);
      return s;
    }
  }
  function parseColorInfo(buf, start, end) {
    const out = { primaries: 0, transfer: 0, matrix: 0 };
    let p = start;
    while (p < end) {
      const tr = readVarint(buf, p, end), tag = tr[0]; p = tr[1];
      const field = Math.floor(tag / 8), wire = tag & 7;
      if (wire === 0 && (field === 1 || field === 2 || field === 3)) {
        const r = readVarint(buf, p, end), v = r[0]; p = r[1];
        if (field === 1) out.primaries = v;
        else if (field === 2) out.transfer = v;
        else if (field === 3) out.matrix = v;
      } else p = skipField(buf, p, end, wire);
    }
    // YouTube/ISO values: BT.2020 primaries=9; BT.2020-10=14, PQ/ST2084=16, HLG=18.
    out.isHdr = out.primaries === 9 && (out.transfer === 14 || out.transfer === 16 || out.transfer === 18);
    return out;
  }
  function parseFormat(buf, start, end) {
    const out = { itag: 0, mimeType: "", bitrate: 0, averageBitrate: 0, width: 0, height: 0, fps: 0, qualityLabel: "", xtags: "", lastModified: 0, colorInfo: null, isHdr: false };
    let p = start;
    while (p < end) {
      const tr = readVarint(buf, p, end), tag = tr[0]; p = tr[1];
      const field = Math.floor(tag / 8), wire = tag & 7;
      if (wire === 0 && (field === 1 || field === 6 || field === 7 || field === 8 || field === 11 || field === 25 || field === 31)) {
        const r = readVarint(buf, p, end), v = r[0]; p = r[1];
        if (field === 1) out.itag = v;
        else if (field === 6) out.bitrate = v;
        else if (field === 7) out.width = v;
        else if (field === 8) out.height = v;
        else if (field === 11) out.lastModified = v;
        else if (field === 25) out.fps = v;
        else if (field === 31) out.averageBitrate = v;
      } else if (wire === 2 && (field === 5 || field === 23 || field === 26 || field === 33)) {
        const r = readBytes(buf, p, end); p = r[2];
        if (field === 5) out.mimeType = utf8(buf, r[0], r[1]);
        else if (field === 23) out.xtags = utf8(buf, r[0], r[1]);
        else if (field === 26) out.qualityLabel = utf8(buf, r[0], r[1]);
        else if (field === 33) {
          out.colorInfo = parseColorInfo(buf, r[0], r[1]);
          out.isHdr = !!out.colorInfo.isHdr;
        }
      } else p = skipField(buf, p, end, wire);
    }
    const q = /([0-9]{3,4})p/i.exec(out.qualityLabel || "");
    out.resolution = q ? parseInt(q[1], 10) : ((out.width && out.height) ? Math.min(out.width, out.height) : (out.height || out.width || 0));
    // Compatibility fallback for legacy VP9.2 HDR itags if ColorInfo is absent.
    if (!out.isHdr && out.itag >= 330 && out.itag <= 337) out.isHdr = true;
    return out;
  }
  function parseStreamingData(buf, start, end) {
    const formats = [], adaptive = [];
    let p = start;
    while (p < end) {
      const tr = readVarint(buf, p, end), tag = tr[0]; p = tr[1];
      const field = Math.floor(tag / 8), wire = tag & 7;
      if ((field === 2 || field === 3) && wire === 2) {
        const r = readBytes(buf, p, end), f = parseFormat(buf, r[0], r[1]); p = r[2];
        (field === 3 ? adaptive : formats).push(f);
      } else p = skipField(buf, p, end, wire);
    }
    return adaptive.length ? adaptive : formats;
  }
  function parsePlayer(buf) {
    let p = 0, end = buf.length;
    while (p < end) {
      const tr = readVarint(buf, p, end), tag = tr[0]; p = tr[1];
      const field = Math.floor(tag / 8), wire = tag & 7;
      if (field === 4 && wire === 2) {
        const r = readBytes(buf, p, end);
        return parseStreamingData(buf, r[0], r[1]);
      }
      p = skipField(buf, p, end, wire);
    }
    return [];
  }
  function qp(name) {
    try { return new URL(requestUrl).searchParams.get(name) || ""; } catch (_) { return ""; }
  }
  function menuLabel(resolution, fps, hdr) {
    const rate = fps > 30 ? String(Math.round(fps)) : "";
    return resolution + "p" + rate + (hdr ? " HDR" : "");
  }

  try {
    const all = parsePlayer(bytes);
    const video = all.filter(f => f.itag && f.resolution > 0 && /^video\//i.test(f.mimeType || ""));
    if (!video.length) { console.log("[YT Max Quality] player: no video formats parsed"); $done({}); return; }

    let maxResolution = 0;
    for (const f of video) if (f.resolution > maxResolution) maxResolution = f.resolution;

    const sameResolution = video.filter(f => f.resolution === maxResolution);
    const hdrFormats = sameResolution.filter(f => f.isHdr);
    const dynamicRangePool = hdrFormats.length ? hdrFormats : sameResolution;

    // Match YouTube's menu semantics: at the same resolution and dynamic range,
    // prefer the highest frame-rate label (e.g. 2160p60 HDR over 2160p HDR).
    let maxFps = 0;
    for (const f of dynamicRangePool) if ((f.fps || 0) > maxFps) maxFps = f.fps || 0;
    const frameRatePool = dynamicRangePool.filter(f => (f.fps || 0) === maxFps);

    // Same official quality tier: prefer the highest bitrate variant.
    const top = frameRatePool.sort((a, b) => {
      const abr = (b.averageBitrate || b.bitrate || 0) - (a.averageBitrate || a.bitrate || 0);
      if (abr) return abr;
      return (b.bitrate || 0) - (a.bitrate || 0);
    });

    const maxBitrate = top.reduce((m, f) => Math.max(m, f.averageBitrate || f.bitrate || 0), 0);
    const hdr = hdrFormats.length > 0;
    const label = menuLabel(maxResolution, maxFps, hdr);
    const target = {
      version: 8,
      videoId: qp("id") || qp("videoId") || "",
      capturedAt: Date.now(),
      resolution: maxResolution,
      hdr,
      fps: maxFps,
      menuLabel: label,
      maxBitrate,
      allVideoItags: video.map(f => f.itag),
      formats: top.map(f => ({
        itag: f.itag,
        lastModified: f.lastModified || 0,
        xtags: f.xtags || "",
        bitrate: f.bitrate || 0,
        averageBitrate: f.averageBitrate || 0,
        width: f.width || 0,
        height: f.height || 0,
        fps: f.fps || 0,
        qualityLabel: f.qualityLabel || "",
        mimeType: f.mimeType || "",
        isHdr: !!f.isHdr,
        colorInfo: f.colorInfo || null
      }))
    };
    $persistentStore.write(JSON.stringify(target), "ytmq.max.target");
    console.log("[YT Max Quality] target=" + label + " | preferred itags=" + top.map(f => f.itag).join(",") + " | maxBitrate=" + maxBitrate);
  } catch (e) {
    console.log("[YT Max Quality] player parse error: " + String(e && e.message || e));
  }
  $done({});
})();
