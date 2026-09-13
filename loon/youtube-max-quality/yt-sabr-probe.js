// YouTube Max Quality - SABR request rewriter for Loon
// Forces the highest resolution advertised by the latest /player response.

(function () {
  const body = $request && $request.body;
  const url = ($request && $request.url) || "";
  const method = ($request && $request.method) || "";
  let isSabr = false;
  try { isSabr = new URL(url).searchParams.get("sabr") === "1"; } catch (_) {}
  if (method.toUpperCase() !== "POST" || !isSabr || !(body instanceof Uint8Array) || !body.length || !/\/videoplayback(?:\?|\/|$)/i.test(url)) { $done({}); return; }

  let target = null;
  try { target = JSON.parse($persistentStore.read("ytmq.max.target") || "null"); } catch (_) {}
  if (!target || !target.resolution || !Array.isArray(target.formats) || !target.formats.length || Date.now() - (target.capturedAt || 0) > 10 * 60 * 1000) {
    $done({}); return;
  }

  function readVarint(buf, pos, end) {
    let value = 0, mul = 1, count = 0;
    while (pos < end && count < 10) {
      const b = buf[pos++]; value += (b & 0x7f) * mul;
      if (b < 0x80) return [value, pos];
      mul *= 128; count++;
    }
    throw new Error("bad varint");
  }
  function readBytes(buf, pos, end) {
    const r = readVarint(buf, pos, end), len = r[0], start = r[1], finish = start + len;
    if (finish > end) throw new Error("truncated field");
    return [start, finish, finish];
  }
  function parseFields(buf, start, end) {
    const fields = [];
    let p = start;
    while (p < end) {
      const fieldStart = p, tr = readVarint(buf, p, end), tag = tr[0]; p = tr[1];
      const field = Math.floor(tag / 8), wire = tag & 7;
      let dataStart = -1, dataEnd = -1, value = null;
      if (wire === 0) { const r = readVarint(buf, p, end); value = r[0]; p = r[1]; }
      else if (wire === 1) p = Math.min(p + 8, end);
      else if (wire === 2) { const r = readBytes(buf, p, end); dataStart = r[0]; dataEnd = r[1]; p = r[2]; }
      else if (wire === 5) p = Math.min(p + 4, end);
      else throw new Error("unsupported wire type " + wire);
      fields.push({ field, wire, value, dataStart, dataEnd, raw: buf.slice(fieldStart, p) });
    }
    return fields;
  }
  function encVarint(n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    const a = [];
    while (n >= 128) { a.push((n % 128) + 128); n = Math.floor(n / 128); }
    a.push(n); return new Uint8Array(a);
  }
  function concat(chunks) {
    let len = 0; for (const c of chunks) len += c.length;
    const out = new Uint8Array(len); let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }
  function varField(field, value) { return concat([encVarint(field * 8), encVarint(value)]); }
  function bytesField(field, payload) { return concat([encVarint(field * 8 + 2), encVarint(payload.length), payload]); }
  function utf8(s) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s || "");
    const str = unescape(encodeURIComponent(s || "")), out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i); return out;
  }
  function formatIdMessage(f) {
    const chunks = [varField(1, f.itag)];
    if (f.lastModified) chunks.push(varField(2, f.lastModified));
    if (f.xtags) chunks.push(bytesField(3, utf8(f.xtags)));
    return concat(chunks);
  }
  function rewriteAbrState(payload) {
    const fields = parseFields(payload, 0, payload.length);
    const desiredBandwidth = Math.max(100000000, (target.maxBitrate || 0) * 4);
    const replacements = {
      13: 0,
      16: target.resolution,
      20: 0,
      21: target.resolution,
      23: desiredBandwidth,
      26: 3,
      30: 0
    };
    const done = Object.create(null), chunks = [];
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(replacements, f.field) && f.wire === 0) {
        if (!done[f.field]) { chunks.push(varField(f.field, replacements[f.field])); done[f.field] = true; }
      } else chunks.push(f.raw);
    }
    for (const k of Object.keys(replacements)) {
      const n = Number(k); if (!done[n]) chunks.push(varField(n, replacements[n]));
    }
    return concat(chunks);
  }
  function rewriteRequest(buf) {
    const fields = parseFields(buf, 0, buf.length), chunks = [];
    let wrotePreferredVideo = false, changedState = false;
    for (const f of fields) {
      if (f.field === 1 && f.wire === 2) {
        const payload = buf.slice(f.dataStart, f.dataEnd);
        chunks.push(bytesField(1, rewriteAbrState(payload)));
        changedState = true;
      } else if (f.field === 17 && f.wire === 2) {
        if (!wrotePreferredVideo) {
          for (const fmt of target.formats) chunks.push(bytesField(17, formatIdMessage(fmt)));
          wrotePreferredVideo = true;
        }
      } else chunks.push(f.raw);
    }
    if (!changedState) chunks.push(bytesField(1, rewriteAbrState(new Uint8Array(0))));
    if (!wrotePreferredVideo) for (const fmt of target.formats) chunks.push(bytesField(17, formatIdMessage(fmt)));
    return concat(chunks);
  }

  try {
    const out = rewriteRequest(body);
    console.log("[YT Max Quality] forced=" + target.resolution + "p | preferred itags=" + target.formats.map(f => f.itag).join(",") + " | body=" + body.length + "->" + out.length);
    $done({ body: out });
  } catch (e) {
    console.log("[YT Max Quality] SABR rewrite error: " + String(e && e.message || e));
    $done({});
  }
})();
