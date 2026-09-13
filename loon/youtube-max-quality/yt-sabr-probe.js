// YouTube Max Quality - Shadowrocket/Loon SABR preference rewriter v11
// Isolation mode: never touches /youtubei/v1/player, ad data, player responses,
// preferred format lists, session context, playback cookies, or buffer state.
// It only nudges documented ClientAbrState quality/network preference fields.

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

  function varField(field, value) {
    return concat([encVarint(field * 8), encVarint(value)]);
  }

  function bytesField(field, payload) {
    return concat([encVarint(field * 8 + 2), encVarint(payload.length), payload]);
  }

  function rewriteClientAbrState(payload) {
    const fields = parseFields(payload, 0, payload.length);
    let currentBandwidth = 0;
    for (const f of fields) {
      if (f.field === 23 && f.wire === 0) currentBandwidth = Math.max(currentBandwidth, Number(f.value || 0));
    }

    // Current documented SABR fields:
    // 20 client_bitrate_cap_bytes_per_sec
    // 23 bandwidth_estimate
    // 26 video_quality_setting (1 = HIGHER_QUALITY)
    // 30 data_saver_mode
    // 32 network_metered_state (1 = UNMETERED)
    // We intentionally do NOT touch resolution, preferredVideoFormatIds, selected formats,
    // player time, playback cookies, streamer context, or any ad/player response data.
    const replacements = {
      23: Math.max(currentBandwidth, 250000000),
      26: 1,
      30: 0,
      32: 1
    };

    const done = Object.create(null);
    const chunks = [];
    for (const f of fields) {
      // Remove a native bitrate ceiling if present; let server ABR choose from all allowed tiers.
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
    const chunks = [];
    let changed = false;

    for (const f of fields) {
      if (f.field === 1 && f.wire === 2) {
        const payload = buf.slice(f.dataStart, f.dataEnd);
        chunks.push(bytesField(1, rewriteClientAbrState(payload)));
        changed = true;
      } else {
        chunks.push(f.raw);
      }
    }

    // Unknown/changed SABR shape: fail open and leave the request untouched.
    return changed ? concat(chunks) : null;
  }

  try {
    const out = rewriteRequest(body);
    if (!out) {
      console.log("[YT Max Quality v11] no ClientAbrState; pass-through");
      $done({});
      return;
    }

    console.log("[YT Max Quality v11] isolated ABR preference applied | body=" + body.length + "->" + out.length);
    $done({ body: out });
  } catch (e) {
    console.log("[YT Max Quality v11] pass-through: " + String(e && e.message || e));
    $done({});
  }
})();
