// YouTube SABR full request capture for Loon
// Read-only. Decodes VideoPlaybackAbrRequest format selections and ABR state, and caches raw protobuf locally.

(function () {
  const url = ($request && $request.url) || "";
  const method = ($request && $request.method) || "UNKNOWN";
  const headers = ($request && $request.headers) || {};
  const body = $request && $request.body;

  function qp(name) {
    try { return new URL(url).searchParams.get(name) || ""; } catch (_) { return ""; }
  }

  function toBase64(input) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    for (let i = 0; i < input.length; i += 3) {
      const a = input[i], b = i + 1 < input.length ? input[i + 1] : 0, c = i + 2 < input.length ? input[i + 2] : 0;
      const n = (a << 16) | (b << 8) | c;
      out += chars[(n >>> 18) & 63] + chars[(n >>> 12) & 63] + (i + 1 < input.length ? chars[(n >>> 6) & 63] : "=") + (i + 2 < input.length ? chars[n & 63] : "=");
    }
    return out;
  }

  function fnv1a(input) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < input.length; i++) { h ^= input[i]; h = Math.imul(h, 16777619) >>> 0; }
    return ("00000000" + h.toString(16)).slice(-8);
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
    const r = readVarint(buf, pos, end), len = r[0], start = r[1], finish = start + len;
    if (finish > end) throw new Error("truncated length-delimited field");
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

  function parseFormatId(buf, start, end) {
    const out = { itag: 0, xtags: "" };
    let p = start;
    while (p < end) {
      const tr = readVarint(buf, p, end); const tag = tr[0]; p = tr[1];
      const field = Math.floor(tag / 8), wire = tag & 7;
      if (field === 1 && wire === 0) { const r = readVarint(buf, p, end); out.itag = r[0]; p = r[1]; }
      else if (field === 3 && wire === 2) { const r = readBytes(buf, p, end); out.xtags = utf8(buf, r[0], r[1]); p = r[2]; }
      else p = skipField(buf, p, end, wire);
    }
    return out;
  }

  function parseFormatGroup(buf, start, end) {
    const ids = [];
    let p = start;
    while (p < end) {
      const tr = readVarint(buf, p, end); const tag = tr[0]; p = tr[1];
      const field = Math.floor(tag / 8), wire = tag & 7;
      if (field === 1 && wire === 2) {
        const r = readBytes(buf, p, end); ids.push(parseFormatId(buf, r[0], r[1])); p = r[2];
      } else p = skipField(buf, p, end, wire);
    }
    return ids;
  }

  function parseClientAbrState(buf, start, end) {
    const wanted = {
      16: "lastManualSelectedResolution",
      18: "viewportWidth",
      19: "viewportHeight",
      20: "bitrateCapBytesPerSec",
      21: "stickyResolution",
      23: "bandwidthEstimate",
      26: "videoQualitySetting",
      28: "playerTimeMs",
      30: "dataSaverMode",
      32: "networkMeteredState",
      58: "preferVp9",
      59: "av1QualityThreshold",
      62: "sabrSupportQualityConstraints"
    };
    const out = {};
    let p = start;
    while (p < end) {
      const tr = readVarint(buf, p, end); const tag = tr[0]; p = tr[1];
      const field = Math.floor(tag / 8), wire = tag & 7;
      if (wanted[field] && wire === 0) {
        const r = readVarint(buf, p, end); out[wanted[field]] = r[0]; p = r[1];
      } else if (field === 79 && wire === 2) {
        const r = readBytes(buf, p, end); out.playbackAuthorizationBytes = r[1] - r[0]; p = r[2];
      } else p = skipField(buf, p, end, wire);
    }
    if (out.videoQualitySetting != null) {
      const names = {0:"UNKNOWN",1:"HIGHER_QUALITY",2:"DATA_SAVER",3:"ADVANCED_MENU"};
      out.videoQualitySettingName = names[out.videoQualitySetting] || String(out.videoQualitySetting);
    }
    out.dataSaverMode = !!out.dataSaverMode;
    out.preferVp9 = !!out.preferVp9;
    out.sabrSupportQualityConstraints = !!out.sabrSupportQualityConstraints;
    return out;
  }

  function parseAbrRequest(buf) {
    const out = {
      selectedFormatIds: [],
      preferredAudioFormatIds: [],
      preferredVideoFormatIds: [],
      preferredSubtitleFormatIds: [],
      formatGroups: [],
      playerTimeMs: 0,
      ustreamerConfigBytes: 0,
      streamerContextBytes: 0,
      clientAbrState: {}
    };
    let p = 0, end = buf.length;
    while (p < end) {
      const tr = readVarint(buf, p, end); const tag = tr[0]; p = tr[1];
      const field = Math.floor(tag / 8), wire = tag & 7;
      if (field === 1 && wire === 2) {
        const r = readBytes(buf, p, end); out.clientAbrState = parseClientAbrState(buf, r[0], r[1]); p = r[2];
      } else if (field === 2 && wire === 2) {
        const r = readBytes(buf, p, end); out.selectedFormatIds.push(parseFormatId(buf, r[0], r[1])); p = r[2];
      } else if (field === 4 && wire === 0) {
        const r = readVarint(buf, p, end); out.playerTimeMs = r[0]; p = r[1];
      } else if (field === 5 && wire === 2) {
        const r = readBytes(buf, p, end); out.ustreamerConfigBytes = r[1] - r[0]; p = r[2];
      } else if (field === 16 && wire === 2) {
        const r = readBytes(buf, p, end); out.preferredAudioFormatIds.push(parseFormatId(buf, r[0], r[1])); p = r[2];
      } else if (field === 17 && wire === 2) {
        const r = readBytes(buf, p, end); out.preferredVideoFormatIds.push(parseFormatId(buf, r[0], r[1])); p = r[2];
      } else if (field === 18 && wire === 2) {
        const r = readBytes(buf, p, end); out.preferredSubtitleFormatIds.push(parseFormatId(buf, r[0], r[1])); p = r[2];
      } else if (field === 19 && wire === 2) {
        const r = readBytes(buf, p, end); out.streamerContextBytes = r[1] - r[0]; p = r[2];
      } else if (field === 1000 && wire === 2) {
        const r = readBytes(buf, p, end); out.formatGroups.push(parseFormatGroup(buf, r[0], r[1])); p = r[2];
      } else p = skipField(buf, p, end, wire);
    }
    return out;
  }

  function compactFormats(list) {
    return (list || []).filter(x => x && x.itag).map(x => x.itag + (x.xtags ? "[" + x.xtags + "]" : ""));
  }

  const isBinary = body instanceof Uint8Array;
  const kind = /\/initplayback(?:\?|$)/i.test(url) ? "initplayback" : (/\/videoplayback(?:\?|\/|$)/i.test(url) ? "videoplayback" : "other");
  const safeQuery = {
    source: qp("source"), sabr: qp("sabr"), c: qp("c"), cver: qp("cver"),
    svpuc: qp("svpuc"), rqh: qp("rqh"), itag: qp("itag"), mime: qp("mime")
  };
  const contentType = headers["Content-Type"] || headers["content-type"] || "";
  let parsed = null, parseError = "";
  if (isBinary && body.length) {
    try { parsed = parseAbrRequest(body); } catch (e) { parseError = String(e && e.message || e); }
  }

  const hash = isBinary ? fnv1a(body) : "none";
  const summary = {
    version: 4,
    capturedAt: Date.now(),
    kind,
    method,
    contentType,
    bodyBytes: isBinary ? body.length : (body ? String(body).length : 0),
    bodyHash: hash,
    query: safeQuery,
    parsed,
    parseError
  };

  let captures = [];
  try { captures = JSON.parse($persistentStore.read("ytmq.sabr.meta") || "[]"); } catch (_) {}
  const exists = captures.some(x => x.bodyHash === hash && x.kind === kind);
  let rawSaved = false;
  if (!exists) {
    if (captures.length >= 8) captures.shift();
    captures.push(summary);
    $persistentStore.write(JSON.stringify(captures), "ytmq.sabr.meta");
    if (isBinary) {
      const slot = captures.length - 1;
      rawSaved = $persistentStore.write(toBase64(body), "ytmq.sabr.raw." + slot);
    }
  }

  const sel = parsed ? compactFormats(parsed.selectedFormatIds) : [];
  const prefV = parsed ? compactFormats(parsed.preferredVideoFormatIds) : [];
  const prefA = parsed ? compactFormats(parsed.preferredAudioFormatIds) : [];
  const st = parsed ? parsed.clientAbrState || {} : {};

  console.log(
    "[YT Capture / SABR v4]\n" +
    "kind=" + kind + " | method=" + method + " | body=" + summary.bodyBytes + " | hash=" + hash + " | rawSaved=" + rawSaved + "\n" +
    "client=" + (safeQuery.c || "-") + "/" + (safeQuery.cver || "-") + " | sabr=" + (safeQuery.sabr || "-") + " | source=" + (safeQuery.source || "-") + "\n" +
    "selected itags=" + (sel.length ? sel.join(", ") : "NONE") + "\n" +
    "preferred VIDEO itags=" + (prefV.length ? prefV.join(", ") : "NONE") + "\n" +
    "preferred AUDIO itags=" + (prefA.length ? prefA.join(", ") : "NONE") + "\n" +
    "ABR: qualityMode=" + (st.videoQualitySettingName || "-") +
    " | manualRes=" + (st.lastManualSelectedResolution || 0) +
    " | stickyRes=" + (st.stickyResolution || 0) +
    " | viewport=" + (st.viewportWidth || 0) + "x" + (st.viewportHeight || 0) +
    " | bandwidth=" + (st.bandwidthEstimate || 0) +
    " | bitrateCapBps=" + (st.bitrateCapBytesPerSec || 0) +
    " | dataSaver=" + (!!st.dataSaverMode) +
    " | preferVp9=" + (!!st.preferVp9) +
    " | av1Threshold=" + (st.av1QualityThreshold || 0) +
    " | qualityConstraints=" + (!!st.sabrSupportQualityConstraints) +
    " | authBytes=" + (st.playbackAuthorizationBytes || 0) +
    (parseError ? "\nparseError=" + parseError : "") +
    "\nSensitive signed URL/token/IP fields intentionally omitted."
  );

  $done({});
})();
