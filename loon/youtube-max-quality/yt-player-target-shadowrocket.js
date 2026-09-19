// YouTube Max Quality - Shadowrocket target probe v16
// Independent from ad blocking: observes the outbound /player request, performs a duplicate
// request to the same YouTube endpoint, parses the returned player protobuf, and caches
// several recent per-video highest-quality targets for the SABR rewriter.

(function () {
  const PREFIX = "[YT Max SR v16][PLAYER]";
  const CACHE_KEY = "ytmq.sr.targets.v16";
  const MAX_TARGETS = 12;
  const TTL_MS = 5 * 60 * 1000;

  const req = $request || {};
  const url = req.url || "";
  const method = String(req.method || "POST").toUpperCase();
  const headers = Object.assign({}, req.headers || {});

  function headerValue(name) {
    const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
    return key ? String(headers[key] || "") : "";
  }

  // Prevent recursion if Shadowrocket routes the internal probe through the script chain.
  if (headerValue("x-ytmq-probe") === "1") {
    $done({});
    return;
  }

  if (method !== "POST" || !/\/youtubei\/v1\/player(?:\?|$)/i.test(url)) {
    $done({});
    return;
  }

  let requestBody = req.bodyBytes || req.body;
  if (requestBody instanceof ArrayBuffer) requestBody = new Uint8Array(requestBody);
  if (!(requestBody instanceof Uint8Array) || !requestBody.length) {
    console.log(PREFIX + " skip: no binary request body");
    $done({});
    return;
  }

  let requestedVideoId = "";
  try { requestedVideoId = new URL(url).searchParams.get("id") || ""; } catch (_) {}

  // A repeated /player request for the same video does not need another network probe.
  // This avoids delaying normal playback after the target has already been learned.
  if (requestedVideoId) {
    const cached = loadTargets().find(x => x && x.videoId === requestedVideoId);
    if (cached) {
      console.log(PREFIX + " cache hit | video=" + requestedVideoId + " | target=" + cached.menuLabel);
      $done({});
      return;
    }
  }

  function toBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (typeof ArrayBuffer !== "undefined" && x instanceof ArrayBuffer) return new Uint8Array(x);
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(x)) {
      return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    }
    if (typeof x === "string") {
      const out = new Uint8Array(x.length);
      for (let i = 0; i < x.length; i++) out[i] = x.charCodeAt(i) & 0xff;
      return out;
    }
    return null;
  }

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
    const r = readVarint(buf, pos, end);
    const len = r[0], start = r[1], finish = start + len;
    if (finish > end) throw new Error("truncated field");
    return [start, finish, finish];
  }

  function parseFields(buf, start, end) {
    const fields = [];
    let p = start;
    while (p < end) {
      const fieldStart = p;
      const tr = readVarint(buf, p, end);
      const tag = tr[0];
      p = tr[1];
      const field = Math.floor(tag / 8), wire = tag & 7;
      let value = null, dataStart = -1, dataEnd = -1;

      if (wire === 0) {
        const r = readVarint(buf, p, end);
        value = r[0];
        p = r[1];
      } else if (wire === 1) {
        if (p + 8 > end) throw new Error("truncated fixed64");
        p += 8;
      } else if (wire === 2) {
        const r = readBytes(buf, p, end);
        dataStart = r[0];
        dataEnd = r[1];
        p = r[2];
      } else if (wire === 5) {
        if (p + 4 > end) throw new Error("truncated fixed32");
        p += 4;
      } else {
        throw new Error("unsupported wire type " + wire);
      }
      fields.push({ field, wire, value, dataStart, dataEnd, raw: buf.slice(fieldStart, p) });
    }
    return fields;
  }

  function utf8(buf, start, end) {
    if (typeof TextDecoder !== "undefined") {
      try { return new TextDecoder("utf-8").decode(buf.slice(start, end)); } catch (_) {}
    }
    let s = "";
    for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]);
    try { return decodeURIComponent(escape(s)); } catch (_) { return s; }
  }

  function parseColorInfo(payload) {
    let primaries = 0, transfer = 0;
    for (const f of parseFields(payload, 0, payload.length)) {
      if (f.wire !== 0) continue;
      if (f.field === 1) primaries = Number(f.value || 0);
      else if (f.field === 2) transfer = Number(f.value || 0);
    }
    return primaries === 9 && (transfer === 14 || transfer === 16 || transfer === 18);
  }

  function parseFormat(payload) {
    const out = {
      itag: 0, mimeType: "", bitrate: 0, averageBitrate: 0,
      width: 0, height: 0, fps: 0, qualityLabel: "",
      lastModified: 0, xtags: "", isHdr: false
    };
    for (const f of parseFields(payload, 0, payload.length)) {
      if (f.wire === 0) {
        const v = Number(f.value || 0);
        if (f.field === 1) out.itag = v;
        else if (f.field === 6) out.bitrate = v;
        else if (f.field === 7) out.width = v;
        else if (f.field === 8) out.height = v;
        else if (f.field === 11) out.lastModified = v;
        else if (f.field === 25) out.fps = v;
        else if (f.field === 31) out.averageBitrate = v;
      } else if (f.wire === 2) {
        if (f.field === 5) out.mimeType = utf8(payload, f.dataStart, f.dataEnd);
        else if (f.field === 23) out.xtags = utf8(payload, f.dataStart, f.dataEnd);
        else if (f.field === 26) out.qualityLabel = utf8(payload, f.dataStart, f.dataEnd);
        else if (f.field === 33) {
          try { out.isHdr = parseColorInfo(payload.slice(f.dataStart, f.dataEnd)); } catch (_) {}
        }
      }
    }
    const m = /(\d{3,4})p/i.exec(out.qualityLabel || "");
    out.resolution = m ? Number(m[1]) : ((out.width && out.height) ? Math.min(out.width, out.height) : (out.height || out.width || 0));
    if (!out.isHdr && out.itag >= 330 && out.itag <= 337) out.isHdr = true;
    return out;
  }

  function parseStreamingData(payload) {
    const formats = [];
    for (const f of parseFields(payload, 0, payload.length)) {
      if ((f.field === 2 || f.field === 3) && f.wire === 2) {
        try {
          const fmt = parseFormat(payload.slice(f.dataStart, f.dataEnd));
          if (fmt.itag && fmt.resolution > 0 && /^video\//i.test(fmt.mimeType || "")) formats.push(fmt);
        } catch (_) {}
      }
    }
    return formats;
  }

  function parseVideoId(payload) {
    try {
      for (const f of parseFields(payload, 0, payload.length)) {
        if (f.field === 1 && f.wire === 2) return utf8(payload, f.dataStart, f.dataEnd);
      }
    } catch (_) {}
    return "";
  }

  function compactFormat(f) {
    return { itag: f.itag, lastModified: f.lastModified || 0, xtags: f.xtags || "" };
  }

  function chooseTarget(formats) {
    if (!formats.length) return null;
    let maxRes = 0;
    for (const f of formats) if (f.resolution > maxRes) maxRes = f.resolution;
    let pool = formats.filter(f => f.resolution === maxRes);

    const hdr = pool.filter(f => f.isHdr);
    if (hdr.length) pool = hdr;

    let maxFps = 0;
    for (const f of pool) if ((f.fps || 0) > maxFps) maxFps = f.fps || 0;
    pool = pool.filter(f => (f.fps || 0) === maxFps);

    pool.sort((a, b) => {
      const abr = (b.averageBitrate || b.bitrate || 0) - (a.averageBitrate || a.bitrate || 0);
      if (abr) return abr;
      return (b.bitrate || 0) - (a.bitrate || 0);
    });

    return {
      version: 16,
      capturedAt: Date.now(),
      resolution: maxRes,
      hdr: hdr.length > 0,
      fps: maxFps,
      maxBitrate: pool[0] ? (pool[0].averageBitrate || pool[0].bitrate || 0) : 0,
      menuLabel: maxRes + "p" + (maxFps > 30 ? String(Math.round(maxFps)) : "") + (hdr.length ? " HDR" : ""),
      allFormats: formats.map(compactFormat),
      formats: pool.slice(0, 6).map(f => ({
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
        isHdr: !!f.isHdr
      }))
    };
  }

  function parsePlayer(buf) {
    let streamingData = null, videoId = "";
    for (const f of parseFields(buf, 0, buf.length)) {
      if (f.field === 4 && f.wire === 2) streamingData = buf.slice(f.dataStart, f.dataEnd);
      else if (f.field === 11 && f.wire === 2) videoId = parseVideoId(buf.slice(f.dataStart, f.dataEnd));
    }
    if (!streamingData) return null;
    const target = chooseTarget(parseStreamingData(streamingData));
    if (!target) return null;
    target.videoId = videoId;
    return target;
  }

  function loadTargets() {
    let list = [];
    try { list = JSON.parse($persistentStore.read(CACHE_KEY) || "[]"); } catch (_) {}
    if (!Array.isArray(list)) list = [];
    const now = Date.now();
    return list.filter(x => x && x.version === 16 && x.capturedAt && now - Number(x.capturedAt) <= TTL_MS);
  }

  function saveTarget(target) {
    let list = loadTargets();
    // Replace an existing entry for the same video; otherwise prepend.
    list = list.filter(x => !(target.videoId && x.videoId === target.videoId));
    list.unshift(target);
    list = list.slice(0, MAX_TARGETS);
    $persistentStore.write(JSON.stringify(list), CACHE_KEY);
    return list.length;
  }

  const probeHeaders = Object.assign({}, headers);
  for (const k of Object.keys(probeHeaders)) {
    const lower = k.toLowerCase();
    if (lower === "content-length" || lower === "host") delete probeHeaders[k];
  }
  probeHeaders["x-ytmq-probe"] = "1";

  console.log(PREFIX + " probe start | requestBody=" + requestBody.length);

  $httpClient.post({
    url,
    headers: probeHeaders,
    body: requestBody,
    "binary-mode": true,
    timeout: 10
  }, function (error, response, data) {
    try {
      if (error) {
        console.log(PREFIX + " probe error: " + String(error));
        $done({});
        return;
      }
      const status = Number((response && (response.status || response.statusCode)) || 0);
      const bytes = toBytes(data);
      if (!bytes || !bytes.length) {
        console.log(PREFIX + " probe empty | status=" + status);
        $done({});
        return;
      }
      const target = parsePlayer(bytes);
      if (!target) {
        console.log(PREFIX + " parse miss | status=" + status + " body=" + bytes.length);
        $done({});
        return;
      }
      if (!target.videoId && requestedVideoId) target.videoId = requestedVideoId;
      const count = saveTarget(target);
      console.log(
        PREFIX + " captured | video=" + (target.videoId || "?") +
        " | target=" + target.menuLabel +
        " | top=" + target.formats.map(f => f.itag).join(",") +
        " | all=" + target.allFormats.length +
        " | cache=" + count
      );
    } catch (e) {
      console.log(PREFIX + " parse error: " + String(e && e.message || e));
    }
    $done({});
  });
})();
