// YouTube Max Quality Capture for Loon
// Read-only. Stores the latest raw player response locally so later decoders can reuse it without replaying the video.

(function () {
  const bytes = $response && $response.body;
  const requestUrl = ($request && $request.url) || "";

  if (!(bytes instanceof Uint8Array)) {
    console.log("[YT Capture / Player] Body is not Uint8Array");
    $done({});
    return;
  }

  function qp(name) {
    try { return new URL(requestUrl).searchParams.get(name) || ""; } catch (_) { return ""; }
  }

  function extractAsciiStrings(input, minLen) {
    const out = [];
    let buf = "";
    for (let i = 0; i < input.length; i++) {
      const c = input[i];
      if (c >= 32 && c <= 126) buf += String.fromCharCode(c);
      else {
        if (buf.length >= minLen) out.push(buf);
        buf = "";
      }
    }
    if (buf.length >= minLen) out.push(buf);
    return out;
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

  const strings = extractAsciiStrings(bytes, 4);
  const interesting = [];
  const seen = Object.create(null);
  const matcher = /(1080p\s*Premium|Premium|enhanced\s*bitrate|premium_upsell|paygated|4320p|2160p|1440p|1080p|720p|480p|qualityLabel|video\/|vp9|av01|avc1|serverAbrStreamingUrl|manifest\.googlevideo)/i;
  for (let i = 0; i < strings.length; i++) {
    const s = strings[i];
    if (!matcher.test(s)) continue;
    const clipped = s.length > 240 ? s.slice(0, 240) + "…" : s;
    if (!seen[clipped]) { seen[clipped] = true; interesting.push(clipped); }
    if (interesting.length >= 80) break;
  }

  const joined = interesting.join("\n---\n");
  const premiumUi = /(1080p\s*Premium|enhanced\s*bitrate|YouTube\s*Premium)/i.test(joined);
  const upsell = /(premium_upsell|paygated)/i.test(joined);
  const levels = ["4320p", "2160p", "1440p", "1080p", "720p", "480p"].filter(q => joined.indexOf(q) !== -1);
  const hasSabr = /(serverAbrStreamingUrl|sabr=1|\/videoplayback)/i.test(joined);
  const videoId = qp("id") || qp("videoId") || "unknown";
  const endpoint = /\/get_watch(?:\?|$)/.test(requestUrl) ? "get_watch" : "player";
  const now = Date.now();

  let session = {};
  try { session = JSON.parse($persistentStore.read("ytmq.session") || "{}"); } catch (_) {}
  if (session.videoId !== videoId || !session.startedAt || now - session.startedAt > 600000) {
    session = { videoId, startedAt: now };
    $persistentStore.write("[]", "ytmq.sabr.meta");
    for (let i = 0; i < 8; i++) $persistentStore.write(undefined, "ytmq.sabr.raw." + i);
    $persistentStore.write(undefined, "ytmq.hls.meta");
  }
  session.lastPlayerAt = now;
  $persistentStore.write(JSON.stringify(session), "ytmq.session");

  const meta = {
    version: 4,
    videoId,
    endpoint,
    capturedAt: now,
    bodyBytes: bytes.length,
    bodyHash: fnv1a(bytes),
    premiumUi,
    premiumUpsellOrPaygate: upsell,
    qualityMarkers: levels,
    sabrMarker: hasSabr,
    interesting: interesting.slice(0, 40)
  };
  $persistentStore.write(JSON.stringify(meta), "ytmq.player.meta");
  const rawSaved = $persistentStore.write(toBase64(bytes), "ytmq.player.raw");

  console.log(
    "[YT Capture / Player v4]\n" +
    "videoId=" + videoId + " | endpoint=" + endpoint + "\n" +
    "body=" + bytes.length + " bytes | hash=" + meta.bodyHash + " | rawSaved=" + rawSaved + "\n" +
    "qualities=" + (levels.length ? levels.join(", ") : "NONE") + "\n" +
    "Premium UI=" + (premiumUi ? "YES" : "NO") + " | upsell/paygate=" + (upsell ? "YES" : "NO") + "\n" +
    "SABR marker=" + (hasSabr ? "YES" : "NO") + "\n" +
    "Raw protobuf cached locally; Premium stream access will be decided from SABR format IDs, not UI text."
  );

  $done({});
})();
