// YouTube Max Quality - Shadowrocket/Loon SABR preference rewriter v10
// Coexists with YouTube ad-block modules: preserve the original SABR request structure,
// patch only documented ABR preference fields, and keep every native format/session fallback.

(function () {
  const body = $request && $request.body;
  const url = ($request && $request.url) || "";
  const method = ($request && $request.method) || "";

  function query(name) {
    try { return new URL(url).searchParams.get(name) || ""; } catch (_) { return ""; }
  }

  if (method.toUpperCase() !== "POST" || query("sabr") !== "1" || !(body instanceof Uint8Array) || !body.length || !/\/videoplayback(?:\?|\/|$)/i.test(url)) {
    $done({});
    return;
  }

  let target = null;
  try { target = JSON.parse($persistentStore.read("ytmq.max.target") || "null"); } catch (_) {}
  if (!target || !target.resolution || !Array.isArray(target.formats) || !target.formats.length || !target.capturedAt) {
    $done({});
    return;
  }

  const now = Date.now();
  const sabrId = query("id");
  const age = now - Number(target.capturedAt || 0);

  // Bind a freshly captured /player target to the first SABR stream id. This keeps the
  // preference active for long videos without accidentally reusing an old video's target.
  if (target.boundSabrId) {
    if (!sabrId || target.boundSabrId !== sabrId || age > 6 * 60 * 60 * 1000) {
      $done({});
      return;
    }
  } else {
    if (age > 60 * 1000) {
      $done({});
      return;
    }
    if (sabrId) {
      target.boundSabrId = sabrId;
      target.boundAt = now;
      try { $persistentStore.write(JSON.stringify(target), "ytmq.max.target"); } catch (_) {}
    }
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
      let dataStart = -1, dataEnd = -1, value = null;

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

  function varField(field, value) {
    return concat([encVarint(field * 8), encVarint(value)]);
  }

  function bytesField(field, payload) {
    return concat([encVarint(field * 8 + 2), encVarint(payload.length), payload]);
  }

  function utf8Encode(s) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s || "");
    const str = unescape(encodeURIComponent(s || ""));
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
    return out;
  }

  function utf8Decode(buf, start, end) {
    if (typeof TextDecoder !== "undefined") {
      try { return new TextDecoder("utf-8").decode(buf.slice(start, end)); } catch (_) {}
    }
    let s = "";
    for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]);
    try { return decodeURIComponent(escape(s)); } catch (_) { return s; }
  }

  function parseFormatId(payload) {
    const out = { itag: 0, lastModified: 0, xtags: "" };
    const fields = parseFields(payload, 0, payload.length);
    for (const f of fields) {
      if (f.field === 1 && f.wire === 0) out.itag = Number(f.value || 0);
      else if (f.field === 2 && f.wire === 0) out.lastModified = Number(f.value || 0);
      else if (f.field === 3 && f.wire === 2) out.xtags = utf8Decode(payload, f.dataStart, f.dataEnd);
    }
    return out;
  }

  function formatKey(f) {
    return String(Number(f.itag || 0)) + "|" + String(Number(f.lastModified || 0)) + "|" + String(f.xtags || "");
  }

  function formatIdMessage(f) {
    const itag = Number(f && f.itag || 0);
    if (!itag) return null;
    const chunks = [varField(1, itag)];
    const lm = Number(f.lastModified || 0);
    if (Number.isSafeInteger(lm) && lm > 0) chunks.push(varField(2, lm));
    if (f.xtags) chunks.push(bytesField(3, utf8Encode(String(f.xtags))));
    return concat(chunks);
  }

  function rewriteClientAbrState(payload) {
    const fields = parseFields(payload, 0, payload.length);
    let currentBandwidth = 0;
    for (const f of fields) {
      if (f.field === 23 && f.wire === 0) currentBandwidth = Math.max(currentBandwidth, Number(f.value || 0));
    }

    // Current SABR proto:
    // 16 last_manual_selected_resolution, 21 sticky_resolution,
    // 23 bandwidth_estimate, 26 video_quality_setting (1 = HIGHER_QUALITY),
    // 30 data_saver_mode, 32 network_metered_state (1 = UNMETERED).
    const desiredBandwidth = Math.max(
      currentBandwidth,
      100000000,
      Math.floor(Number(target.maxBitrate || 0) * 8)
    );
    const replacements = {
      16: Number(target.resolution),
      21: Number(target.resolution),
      23: desiredBandwidth,
      26: 1,
      30: 0,
      32: 1
    };

    const done = Object.create(null);
    const chunks = [];
    for (const f of fields) {
      // field 20 is client_bitrate_cap_bytes_per_sec. Omit it so the native request has no cap.
      if (f.field === 20 && f.wire === 0) continue;

      if (Object.prototype.hasOwnProperty.call(replacements, f.field) && f.wire === 0) {
        if (!done[f.field]) {
          chunks.push(varField(f.field, replacements[f.field]));
          done[f.field] = true;
        }
      } else {
        chunks.push(f.raw);
      }
    }

    for (const k of Object.keys(replacements)) {
      const n = Number(k);
      if (!done[n]) chunks.push(varField(n, replacements[n]));
    }
    return concat(chunks);
  }

  function rewriteRequest(buf) {
    const fields = parseFields(buf, 0, buf.length);
    const preferred = [];
    let clientStateSeen = false;

    for (const f of fields) {
      if (f.field === 1 && f.wire === 2) clientStateSeen = true;
      if (f.field === 17 && f.wire === 2) {
        const payload = buf.slice(f.dataStart, f.dataEnd);
        let id = null;
        try { id = parseFormatId(payload); } catch (_) {}
        preferred.push({ raw: f.raw, id, key: id ? formatKey(id) : "" });
      }
    }

    // A valid modern SABR request should already contain ClientAbrState. Never synthesize
    // one from scratch; if its shape changes, pass the request through untouched.
    if (!clientStateSeen) return null;

    const targetFormats = target.formats
      .filter(f => f && Number(f.itag || 0) > 0)
      .slice(0, 4);

    const originalByKey = Object.create(null);
    for (const p of preferred) if (p.key && !originalByKey[p.key]) originalByKey[p.key] = p.raw;

    const preferredChunks = [];
    const emitted = Object.create(null);
    for (const fmt of targetFormats) {
      const key = formatKey(fmt);
      if (emitted[key]) continue;
      if (originalByKey[key]) {
        preferredChunks.push(originalByKey[key]);
        emitted[key] = true;
        continue;
      }
      const payload = formatIdMessage(fmt);
      if (payload) {
        preferredChunks.push(bytesField(17, payload));
        emitted[key] = true;
      }
    }
    for (const p of preferred) {
      if (p.key && emitted[p.key]) continue;
      preferredChunks.push(p.raw);
      if (p.key) emitted[p.key] = true;
    }

    const chunks = [];
    let wrotePreferred = false;
    for (const f of fields) {
      if (f.field === 1 && f.wire === 2) {
        const payload = buf.slice(f.dataStart, f.dataEnd);
        chunks.push(bytesField(1, rewriteClientAbrState(payload)));
      } else if (f.field === 17 && f.wire === 2) {
        if (!wrotePreferred) {
          for (const c of preferredChunks) chunks.push(c);
          wrotePreferred = true;
        }
      } else {
        chunks.push(f.raw);
      }
    }

    if (!wrotePreferred) {
      for (const c of preferredChunks) chunks.push(c);
    }
    return concat(chunks);
  }

  try {
    const out = rewriteRequest(body);
    if (!out) {
      console.log("[YT Max Quality v10] unknown SABR shape; pass-through");
      $done({});
      return;
    }
    console.log(
      "[YT Max Quality v10] " + (target.menuLabel || (target.resolution + "p")) +
      " | sticky=" + target.resolution +
      " | prefer=" + target.formats.slice(0, 4).map(f => f.itag).join(",") +
      " | body=" + body.length + "->" + out.length
    );
    $done({ body: out });
  } catch (e) {
    console.log("[YT Max Quality v10] SABR pass-through: " + String(e && e.message || e));
    $done({});
  }
})();
