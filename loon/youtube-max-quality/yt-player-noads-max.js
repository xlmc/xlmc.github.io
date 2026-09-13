// YouTube Player merged handler v12
// Goal: keep the core /player ad removal from the user's current YouTubeNoAds module
// while extracting the exact highest available video FormatId for the SABR request rewriter.
// All unrelated protobuf fields are preserved byte-for-byte.

(function () {
  let body = $response && ($response.bodyBytes || $response.body);
  if (body instanceof ArrayBuffer) body = new Uint8Array(body);
  if (!(body instanceof Uint8Array) || !body.length) { $done({}); return; }

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

  function encVarint(n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    const a = [];
    while (n >= 128) {
      a.push((n % 128) + 128);
      n = Math.floor(n / 128);
    }
    a.push(n);
    return new Uint8Array(a);
  }

  function concat(chunks) {
    let len = 0;
    for (const c of chunks) len += c.length;
    const out = new Uint8Array(len);
    let p = 0;
    for (const c of chunks) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }

  function bytesField(field, payload) {
    return concat([encVarint(field * 8 + 2), encVarint(payload.length), payload]);
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
    const fields = parseFields(payload, 0, payload.length);
    for (const f of fields) {
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
    const fields = parseFields(payload, 0, payload.length);
    for (const f of fields) {
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
    const fields = parseFields(payload, 0, payload.length);
    for (const f of fields) {
      if ((f.field === 3 || f.field === 2) && f.wire === 2) {
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
      const fields = parseFields(payload, 0, payload.length);
      for (const f of fields) if (f.field === 1 && f.wire === 2) return utf8(payload, f.dataStart, f.dataEnd);
    } catch (_) {}
    return "";
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
      const ab = (b.averageBitrate || b.bitrate || 0) - (a.averageBitrate || a.bitrate || 0);
      if (ab) return ab;
      return (b.bitrate || 0) - (a.bitrate || 0);
    });

    return {
      version: 12,
      capturedAt: Date.now(),
      resolution: maxRes,
      hdr: hdr.length > 0,
      fps: maxFps,
      maxBitrate: pool[0] ? (pool[0].averageBitrate || pool[0].bitrate || 0) : 0,
      menuLabel: maxRes + "p" + (maxFps > 30 ? String(Math.round(maxFps)) : "") + (hdr.length ? " HDR" : ""),
      formats: pool.slice(0, 4).map(f => ({
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

  function stripPlaybackTracking(payload) {
    const fields = parseFields(payload, 0, payload.length);
    const chunks = [];
    let changed = false;
    for (const f of fields) {
      // Maasea's current player handler removes pageadViewthroughconversion (field 18).
      if (f.field === 18) { changed = true; continue; }
      chunks.push(f.raw);
    }
    return { changed, body: changed ? concat(chunks) : payload };
  }

  try {
    const fields = parseFields(body, 0, body.length);
    const chunks = [];
    let changed = false;
    let streamingData = null;
    let videoId = "";

    for (const f of fields) {
      // Core /player ad fields used by the current YouTubeNoAds module.
      if (f.field === 7 || f.field === 68) {
        changed = true;
        continue;
      }

      if (f.field === 9 && f.wire === 2) {
        const payload = body.slice(f.dataStart, f.dataEnd);
        const r = stripPlaybackTracking(payload);
        if (r.changed) {
          chunks.push(bytesField(9, r.body));
          changed = true;
        } else chunks.push(f.raw);
        continue;
      }

      if (f.field === 4 && f.wire === 2) streamingData = body.slice(f.dataStart, f.dataEnd);
      if (f.field === 11 && f.wire === 2) videoId = parseVideoId(body.slice(f.dataStart, f.dataEnd));
      chunks.push(f.raw);
    }

    if (streamingData) {
      const formats = parseStreamingData(streamingData);
      const target = chooseTarget(formats);
      if (target) {
        target.videoId = videoId;
        try { $persistentStore.write(JSON.stringify(target), "ytmq.max.target"); } catch (_) {}
        console.log("[YT NoAds+Max v12] target=" + target.menuLabel + " | itag=" + target.formats.map(f => f.itag).join(","));
      } else {
        console.log("[YT NoAds+Max v12] no video formats parsed");
      }
    }

    if (changed) $done({ body: concat(chunks) });
    else $done({});
  } catch (e) {
    console.log("[YT NoAds+Max v12] player pass-through: " + String(e && e.message || e));
    $done({});
  }
})();
