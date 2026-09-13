// YouTube NoAds + Max Quality - SABR exact-format rewriter v12
// Uses the exact highest FormatId captured from the merged /player handler.
// Preserves native session/buffer/selected-format state and keeps original fallbacks.

(function () {
  let body = $request && ($request.bodyBytes || $request.body);
  if (body instanceof ArrayBuffer) body = new Uint8Array(body);
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
  if (!target || target.version !== 12 || !target.capturedAt || Date.now() - Number(target.capturedAt) > 120000 || !Array.isArray(target.formats) || !target.formats.length || !Array.isArray(target.allFormats)) {
    $done({});
    return;
  }

  const best = target.formats[0];
  if (!best || !Number(best.itag)) { $done({}); return; }

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

  function utf8Encode(s) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(String(s || ""));
    const str = unescape(encodeURIComponent(String(s || "")));
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

  function formatIdMessage(f) {
    const chunks = [varField(1, Number(f.itag || 0))];
    const lm = Number(f.lastModified || 0);
    if (lm > 0 && Number.isSafeInteger(lm)) chunks.push(varField(2, lm));
    if (f.xtags) chunks.push(bytesField(3, utf8Encode(f.xtags)));
    return concat(chunks);
  }

  function sameFormat(a, b) {
    if (!a || !b || Number(a.itag || 0) !== Number(b.itag || 0)) return false;
    const al = Number(a.lastModified || 0), bl = Number(b.lastModified || 0);
    if (al && bl && al !== bl) return false;
    const ax = String(a.xtags || ""), bx = String(b.xtags || "");
    if (ax && bx && ax !== bx) return false;
    return true;
  }

  function belongsToCapturedVideo(id) {
    if (!id || !Number(id.itag || 0)) return false;
    for (const f of target.allFormats) if (sameFormat(id, f)) return true;
    return false;
  }

  function rewriteClientAbrState(payload) {
    const fields = parseFields(payload, 0, payload.length);
    let currentBandwidth = 0;
    for (const f of fields) if (f.field === 23 && f.wire === 0) currentBandwidth = Math.max(currentBandwidth, Number(f.value || 0));

    // Current ClientAbrState proto fields:
    // 13 time_since_last_manual_format_selection_ms
    // 16 last_manual_selected_resolution
    // 20 client_bitrate_cap_bytes_per_sec
    // 21 sticky_resolution
    // 23 bandwidth_estimate
    // 26 video_quality_setting (1 = HIGHER_QUALITY)
    // 30 data_saver_mode
    // 32 network_metered_state (1 = UNMETERED)
    const desiredBandwidth = Math.max(currentBandwidth, 250000000, Math.floor(Number(target.maxBitrate || 0) * 8));
    const replacements = {
      13: 0,
      16: Number(target.resolution || 0),
      21: Number(target.resolution || 0),
      23: desiredBandwidth,
      26: 1,
      30: 0,
      32: 1
    };

    const done = Object.create(null), chunks = [];
    for (const f of fields) {
      if (f.field === 20 && f.wire === 0) continue;
      if (Object.prototype.hasOwnProperty.call(replacements, f.field) && f.wire === 0) {
        if (!done[f.field]) {
          chunks.push(varField(f.field, replacements[f.field]));
          done[f.field] = true;
        }
      } else chunks.push(f.raw);
    }
    for (const k of Object.keys(replacements)) {
      const n = Number(k);
      if (!done[n]) chunks.push(varField(n, replacements[n]));
    }
    return concat(chunks);
  }

  function rewritePlaybackCookie(payload) {
    const fields = parseFields(payload, 0, payload.length);
    const chunks = [];
    let wroteResolution = false, wroteVideo = false;

    for (const f of fields) {
      if (f.field === 1 && f.wire === 0) {
        if (!wroteResolution) {
          // YouTube documents 999999 as manual/max-available resolution in PlaybackCookie.
          chunks.push(varField(1, 999999));
          wroteResolution = true;
        }
      } else if (f.field === 7 && f.wire === 2) {
        if (!wroteVideo) {
          chunks.push(bytesField(7, formatIdMessage(best)));
          wroteVideo = true;
        }
      } else chunks.push(f.raw);
    }

    if (!wroteResolution) chunks.push(varField(1, 999999));
    if (!wroteVideo) chunks.push(bytesField(7, formatIdMessage(best)));
    return concat(chunks);
  }

  function rewriteStreamerContext(payload) {
    const fields = parseFields(payload, 0, payload.length);
    const chunks = [];
    let wroteCookie = false;

    for (const f of fields) {
      if (f.field === 3 && f.wire === 2) {
        const cookie = payload.slice(f.dataStart, f.dataEnd);
        chunks.push(bytesField(3, rewritePlaybackCookie(cookie)));
        wroteCookie = true;
      } else chunks.push(f.raw);
    }

    if (!wroteCookie) {
      const cookie = concat([
        varField(1, 999999),
        bytesField(7, formatIdMessage(best))
      ]);
      chunks.push(bytesField(3, cookie));
    }
    return concat(chunks);
  }

  function collectIdentityEvidence(fields) {
    const ids = [];
    for (const f of fields) {
      if ((f.field === 2 || f.field === 17) && f.wire === 2) {
        try { ids.push(parseFormatId(body.slice(f.dataStart, f.dataEnd))); } catch (_) {}
      } else if (f.field === 19 && f.wire === 2) {
        try {
          const ctx = body.slice(f.dataStart, f.dataEnd);
          const ctxFields = parseFields(ctx, 0, ctx.length);
          for (const cf of ctxFields) {
            if (cf.field !== 3 || cf.wire !== 2) continue;
            const cookie = ctx.slice(cf.dataStart, cf.dataEnd);
            const cookieFields = parseFields(cookie, 0, cookie.length);
            for (const pf of cookieFields) {
              if (pf.field === 7 && pf.wire === 2) {
                try { ids.push(parseFormatId(cookie.slice(pf.dataStart, pf.dataEnd))); } catch (_) {}
              }
            }
          }
        } catch (_) {}
      }
    }
    return ids;
  }

  function rewriteRequest(buf) {
    const fields = parseFields(buf, 0, buf.length);
    const evidence = collectIdentityEvidence(fields);
    let matched = false;
    for (const id of evidence) if (belongsToCapturedVideo(id)) { matched = true; break; }

    // Never apply a freshly captured target to another prefetched video.
    if (!matched) return null;

    const chunks = [];
    let sawClient = false, wrotePreferred = false;
    for (const f of fields) {
      if (f.field === 1 && f.wire === 2) {
        chunks.push(bytesField(1, rewriteClientAbrState(buf.slice(f.dataStart, f.dataEnd))));
        sawClient = true;
      } else if (f.field === 17 && f.wire === 2) {
        if (!wrotePreferred) {
          chunks.push(bytesField(17, formatIdMessage(best)));
          wrotePreferred = true;
        }
        let id = null;
        try { id = parseFormatId(buf.slice(f.dataStart, f.dataEnd)); } catch (_) {}
        if (!sameFormat(id, best)) chunks.push(f.raw);
      } else if (f.field === 19 && f.wire === 2) {
        chunks.push(bytesField(19, rewriteStreamerContext(buf.slice(f.dataStart, f.dataEnd))));
      } else chunks.push(f.raw);
    }

    if (!sawClient) return null;
    if (!wrotePreferred) chunks.push(bytesField(17, formatIdMessage(best)));
    return concat(chunks);
  }

  try {
    const out = rewriteRequest(body);
    if (!out) {
      console.log("[YT NoAds+Max v12] SABR target mismatch/unknown shape; pass-through");
      $done({});
      return;
    }

    console.log(
      "[YT NoAds+Max v12] forced=" + (target.menuLabel || (target.resolution + "p")) +
      " | target itag=" + best.itag +
      " | body=" + body.length + "->" + out.length
    );
    $done({ body: out });
  } catch (e) {
    console.log("[YT NoAds+Max v12] SABR pass-through: " + String(e && e.message || e));
    $done({});
  }
})();
