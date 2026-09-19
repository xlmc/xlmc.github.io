// YouTube Max Quality - Shadowrocket SABR rewriter v24
// Independent quality-only implementation. It never touches ad responses.
// Matches each SABR request against a multi-video cache observed from the real /player response,
// then switches the request to that video's exact highest available official quality tier.

(function () {
  const PREFIX = "[YT Max SR v24][SABR]";
  const CACHE_KEY = "ytmq.sr.targets.v24";
  const TTL_MS = 5 * 60 * 1000;

  let body = $request && ($request.bodyBytes || $request.body);
  if (body instanceof ArrayBuffer) body = new Uint8Array(body);
  const url = ($request && $request.url) || "";
  const method = String(($request && $request.method) || "").toUpperCase();

  function query(name) {
    try { return new URL(url).searchParams.get(name) || ""; } catch (_) { return ""; }
  }

  if (method !== "POST" || query("sabr") !== "1" || !(body instanceof Uint8Array) || !body.length || !/\/videoplayback(?:\?|\/|$)/i.test(url)) {
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
    for (const f of parseFields(payload, 0, payload.length)) {
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

  function identityString(id) {
    if (!id) return "?";
    return String(id.itag || 0) + ":" + String(id.lastModified || 0) + (id.xtags ? ":x" : "");
  }

  function matchScore(a, b) {
    if (!a || !b || !Number(a.itag) || Number(a.itag) !== Number(b.itag)) return 0;
    let score = 1;
    const al = Number(a.lastModified || 0), bl = Number(b.lastModified || 0);
    if (al && bl) {
      if (al !== bl) return 0;
      score += 4;
    }
    const ax = String(a.xtags || ""), bx = String(b.xtags || "");
    if (ax && bx) {
      if (ax !== bx) return 0;
      score += 3;
    }
    return score;
  }

  function loadTargets() {
    let list = [];
    try { list = JSON.parse($persistentStore.read(CACHE_KEY) || "[]"); } catch (_) {}
    if (!Array.isArray(list)) list = [];
    const now = Date.now();
    return list.filter(x => x && x.version === 24 && x.capturedAt && now - Number(x.capturedAt) <= TTL_MS && Array.isArray(x.formats) && x.formats.length && Array.isArray(x.allFormats));
  }

  function collectIdentityEvidence(fields, buf) {
    const ids = [];
    function push(payload) {
      try {
        const id = parseFormatId(payload);
        if (id.itag) ids.push(id);
      } catch (_) {}
    }

    for (const f of fields) {
      // selected_format_ids and preferred_video_format_ids
      if ((f.field === 2 || f.field === 17) && f.wire === 2) {
        push(buf.slice(f.dataStart, f.dataEnd));
      }
      // UnknownMessage1.format_id inside field 6
      else if (f.field === 6 && f.wire === 2) {
        try {
          const nested = buf.slice(f.dataStart, f.dataEnd);
          for (const nf of parseFields(nested, 0, nested.length)) {
            if (nf.field === 1 && nf.wire === 2) push(nested.slice(nf.dataStart, nf.dataEnd));
          }
        } catch (_) {}
      }
      // StreamerContext.playback_cookie.video_fmt
      else if (f.field === 19 && f.wire === 2) {
        try {
          const ctx = buf.slice(f.dataStart, f.dataEnd);
          for (const cf of parseFields(ctx, 0, ctx.length)) {
            if (cf.field !== 3 || cf.wire !== 2) continue;
            const cookie = ctx.slice(cf.dataStart, cf.dataEnd);
            for (const pf of parseFields(cookie, 0, cookie.length)) {
              if (pf.field === 7 && pf.wire === 2) push(cookie.slice(pf.dataStart, pf.dataEnd));
            }
          }
        } catch (_) {}
      }
      // field1000.UnknownMessage3.format_ids
      else if (f.field === 1000 && f.wire === 2) {
        try {
          const nested = buf.slice(f.dataStart, f.dataEnd);
          for (const nf of parseFields(nested, 0, nested.length)) {
            if (nf.field === 1 && nf.wire === 2) push(nested.slice(nf.dataStart, nf.dataEnd));
          }
        } catch (_) {}
      }
    }
    return ids;
  }

  function collectTopLevelIds(fields, buf, fieldNo) {
    const out = [];
    for (const f of fields) {
      if (f.field !== fieldNo || f.wire !== 2) continue;
      try {
        const id = parseFormatId(buf.slice(f.dataStart, f.dataEnd));
        if (id.itag) out.push(id);
      } catch (_) {}
    }
    return out;
  }

  function collectBufferedIds(fields, buf) {
    const out = [];
    for (const f of fields) {
      if (f.field !== 3 || f.wire !== 2) continue;
      try {
        const range = buf.slice(f.dataStart, f.dataEnd);
        for (const rf of parseFields(range, 0, range.length)) {
          if (rf.field !== 1 || rf.wire !== 2) continue;
          const id = parseFormatId(range.slice(rf.dataStart, rf.dataEnd));
          if (id.itag) out.push(id);
        }
      } catch (_) {}
    }
    return out;
  }

  function findTopFormat(target, ids) {
    if (!target || !Array.isArray(target.formats)) return null;
    for (const id of ids || []) {
      for (const f of target.formats) {
        if (matchScore(id, f) >= 5) return f;
      }
    }
    return null;
  }

  function findRecentTarget(targets) {
    const now = Date.now();
    const recent = targets
      .filter(x => x && x.capturedAt && now - Number(x.capturedAt) <= 8000)
      .sort((a, b) => Number(b.capturedAt) - Number(a.capturedAt));
    // Use temporal fallback only when exactly one freshly captured video exists.
    // This fixes the first SABR request (which often has no FormatId evidence) without
    // risking a wrong match when YouTube preloads multiple videos at once.
    return recent.length === 1 ? { target: recent[0], score: 0 } : null;
  }

  function findTarget(targets, evidence) {
    let winner = null, bestScore = 0;
    for (const target of targets) {
      let score = 0;
      for (const id of evidence) {
        for (const candidate of target.allFormats) {
          score = Math.max(score, matchScore(id, candidate));
        }
      }
      // Strong identity = itag + lastModified (score >=5) or itag + lastModified + xtags.
      // Do not trust itag-only matches because the same itag is reused across videos.
      if (score > bestScore) {
        bestScore = score;
        winner = target;
      }
    }
    return bestScore >= 5 ? { target: winner, score: bestScore } : null;
  }

  function targetContains(target, id) {
    for (const f of target.allFormats) if (matchScore(id, f) >= 5) return true;
    return false;
  }

  function rewriteClientAbrState(payload, target) {
    const fields = parseFields(payload, 0, payload.length);
    let currentBandwidth = 0;
    for (const f of fields) {
      if (f.field === 23 && f.wire === 0) currentBandwidth = Math.max(currentBandwidth, Number(f.value || 0));
    }

    const desiredBandwidth = Math.max(currentBandwidth, 500000000, Math.floor(Number(target.maxBitrate || 0) * 8));
    const replacements = {
      13: 0,                              // just manually selected
      16: Number(target.resolution || 0), // last_manual_selected_resolution
      21: Number(target.resolution || 0), // sticky_resolution
      23: desiredBandwidth,               // bandwidth_estimate
      26: 3,                              // ADVANCED_MENU
      30: 0,                              // data_saver_mode=false
      32: 1                               // UNMETERED
    };

    const done = Object.create(null), chunks = [];
    for (const f of fields) {
      if (f.field === 20 && f.wire === 0) continue; // remove bitrate ceiling
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

  function rewritePlaybackCookie(payload, best) {
    const fields = parseFields(payload, 0, payload.length);
    const chunks = [];
    let wroteResolution = false, wroteVideo = false;
    for (const f of fields) {
      if (f.field === 1 && f.wire === 0) {
        if (!wroteResolution) {
          chunks.push(varField(1, 999999));
          wroteResolution = true;
        }
      } else if (f.field === 7 && f.wire === 2) {
        if (!wroteVideo) {
          chunks.push(bytesField(7, formatIdMessage(best)));
          wroteVideo = true;
        }
      } else {
        chunks.push(f.raw);
      }
    }
    if (!wroteResolution) chunks.push(varField(1, 999999));
    if (!wroteVideo) chunks.push(bytesField(7, formatIdMessage(best)));
    return concat(chunks);
  }

  function rewriteStreamerContext(payload, best) {
    const fields = parseFields(payload, 0, payload.length);
    const chunks = [];
    let wroteCookie = false;
    for (const f of fields) {
      if (f.field === 3 && f.wire === 2) {
        chunks.push(bytesField(3, rewritePlaybackCookie(payload.slice(f.dataStart, f.dataEnd), best)));
        wroteCookie = true;
      } else {
        chunks.push(f.raw);
      }
    }
    if (!wroteCookie) {
      chunks.push(bytesField(3, concat([
        varField(1, 999999),
        bytesField(7, formatIdMessage(best))
      ])));
    }
    return concat(chunks);
  }

  function rewriteRequest(buf, target, beforeSelected, beforeBuffered) {
    const fields = parseFields(buf, 0, buf.length);
    const topFormats = target.formats.filter(f => f && Number(f.itag));
    const nativeTop = findTopFormat(target, beforeSelected) || findTopFormat(target, beforeBuffered);
    const best = nativeTop || topFormats[0];
    if (!best) return null;

    const hadTopBefore = !!nativeTop;
    const chunks = [];
    let sawClient = false, wrotePreferred = false, switchedSelectedVideo = false, sawTargetVideo = false;

    for (const f of fields) {
      if (f.field === 1 && f.wire === 2) {
        chunks.push(bytesField(1, rewriteClientAbrState(buf.slice(f.dataStart, f.dataEnd), target)));
        sawClient = true;
      } else if (f.field === 2 && f.wire === 2) {
        // Manual quality changes update the selected video format too. Replace only the
        // video FormatId belonging to this target; preserve selected audio/subtitle IDs.
        let id = null;
        try { id = parseFormatId(buf.slice(f.dataStart, f.dataEnd)); } catch (_) {}
        if (id && targetContains(target, id)) {
          sawTargetVideo = true;
          if (!switchedSelectedVideo) {
            // If YouTube already selected another codec in the same highest tier, keep that
            // exact server-compatible format instead of fighting it back to topFormats[0].
            chunks.push(bytesField(2, formatIdMessage(best)));
            switchedSelectedVideo = true;
          }
        } else {
          chunks.push(f.raw);
        }
      } else if (f.field === 17 && f.wire === 2) {
        // Replace the native current-video preference with all compatible variants from
        // the exact highest official tier (resolution > HDR > FPS > bitrate).
        if (!wrotePreferred) {
          for (const fmt of topFormats) chunks.push(bytesField(17, formatIdMessage(fmt)));
          wrotePreferred = true;
        }
      } else if (f.field === 19 && f.wire === 2) {
        chunks.push(bytesField(19, rewriteStreamerContext(buf.slice(f.dataStart, f.dataEnd), best)));
      } else {
        chunks.push(f.raw);
      }
    }

    if (!sawClient) return null;
    if (!wrotePreferred) {
      for (const fmt of topFormats) chunks.push(bytesField(17, formatIdMessage(fmt)));
    }
    return {
      body: concat(chunks),
      selectedMode: hadTopBefore ? "already-top" : (sawTargetVideo && switchedSelectedVideo ? "switched" : "not-found"),
      preferred: topFormats.map(f => f.itag),
      cookie: best.itag
    };
  }

  try {
    const targets = loadTargets();
    if (!targets.length) {
      console.log(PREFIX + " miss: cache empty | body=" + body.length);
      $done({});
      return;
    }

    const fields = parseFields(body, 0, body.length);
    const evidence = collectIdentityEvidence(fields, body);
    const beforeSelected = collectTopLevelIds(fields, body, 2);
    const beforePvi = collectTopLevelIds(fields, body, 17);
    const beforeBuffered = collectBufferedIds(fields, body);
    let matched = findTarget(targets, evidence);
    let matchKind = "strong";
    if (!matched && evidence.length === 0) {
      matched = findRecentTarget(targets);
      if (matched) matchKind = "recent";
    }
    if (!matched) {
      console.log(
        PREFIX + " miss: no target match | cache=" + targets.length +
        " | evidence=" + evidence.slice(0, 8).map(identityString).join(",") +
        " | selected=" + beforeSelected.map(identityString).join(",") +
        " | buffered=" + beforeBuffered.map(identityString).join(",") +
        " | pvi=" + beforePvi.map(identityString).join(",")
      );
      $done({});
      return;
    }

    const target = matched.target;
    const rewritten = rewriteRequest(body, target, beforeSelected, beforeBuffered);
    if (!rewritten) {
      console.log(PREFIX + " miss: unknown SABR shape | video=" + (target.videoId || "?") + " | target=" + target.menuLabel);
      $done({});
      return;
    }

    console.log(
      PREFIX + " forced | video=" + (target.videoId || "?") +
      " | target=" + target.menuLabel +
      " | match=" + matchKind +
      " | score=" + matched.score +
      " | beforeSelected=" + (beforeSelected.map(identityString).join(",") || "-") +
      " | beforeBuffered=" + (beforeBuffered.map(identityString).join(",") || "-") +
      " | beforePvi=" + (beforePvi.map(identityString).join(",") || "-") +
      " | selected=" + rewritten.selectedMode +
      " | pvi=" + rewritten.preferred.join(",") +
      " | cookie=" + rewritten.cookie +
      " | body=" + body.length + "->" + rewritten.body.length
    );
    $done({ body: rewritten.body });
  } catch (e) {
    console.log(PREFIX + " error: " + String(e && e.message || e));
    $done({});
  }
})();
