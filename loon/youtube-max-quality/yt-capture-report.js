// YouTube Max Quality Capture Report for Loon
// Reads locally cached passive capture data. Does not make network requests or expose signed URLs/tokens.

(function () {
  function readJson(key, fallback) {
    try {
      const raw = $persistentStore.read(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }

  function has(key) { return !!$persistentStore.read(key); }
  function fmtIds(list) {
    if (!Array.isArray(list) || !list.length) return "NONE";
    return list.filter(x => x && x.itag).map(x => x.itag + (x.xtags ? "[" + x.xtags + "]" : "")).join(", ") || "NONE";
  }

  const session = readJson("ytmq.session", {});
  const player = readJson("ytmq.player.meta", null);
  const sabr = readJson("ytmq.sabr.meta", []);
  const hls = readJson("ytmq.hls.meta", null);

  const lines = [];
  lines.push("[YT FULL CAPTURE REPORT v4]");
  lines.push("videoId=" + ((player && player.videoId) || session.videoId || "unknown"));

  if (player) {
    lines.push("PLAYER: body=" + player.bodyBytes + " | hash=" + player.bodyHash + " | rawCached=" + has("ytmq.player.raw"));
    lines.push("PLAYER qualities=" + ((player.qualityMarkers || []).join(", ") || "NONE"));
    lines.push("PLAYER PremiumUI=" + (player.premiumUi ? "YES" : "NO") + " | upsell/paygate=" + (player.premiumUpsellOrPaygate ? "YES" : "NO") + " | SABR marker=" + (player.sabrMarker ? "YES" : "NO"));
  } else {
    lines.push("PLAYER: NOT CAPTURED");
  }

  lines.push("SABR unique requests=" + (Array.isArray(sabr) ? sabr.length : 0));
  if (Array.isArray(sabr)) {
    sabr.forEach((x, i) => {
      const p = x.parsed || {};
      const st = p.clientAbrState || {};
      lines.push("SABR#" + (i + 1) + ": " + x.kind + " | body=" + x.bodyBytes + " | hash=" + x.bodyHash + " | rawCached=" + has("ytmq.sabr.raw." + i));
      lines.push("  selected=" + fmtIds(p.selectedFormatIds));
      lines.push("  preferredVideo=" + fmtIds(p.preferredVideoFormatIds));
      lines.push("  preferredAudio=" + fmtIds(p.preferredAudioFormatIds));
      lines.push("  ABR qualityMode=" + (st.videoQualitySettingName || "-") + " | manualRes=" + (st.lastManualSelectedResolution || 0) + " | stickyRes=" + (st.stickyResolution || 0) + " | viewport=" + (st.viewportWidth || 0) + "x" + (st.viewportHeight || 0) + " | bandwidth=" + (st.bandwidthEstimate || 0) + " | capBps=" + (st.bitrateCapBytesPerSec || 0) + " | dataSaver=" + (!!st.dataSaverMode) + " | preferVp9=" + (!!st.preferVp9) + " | av1Threshold=" + (st.av1QualityThreshold || 0) + " | qualityConstraints=" + (!!st.sabrSupportQualityConstraints) + " | authBytes=" + (st.playbackAuthorizationBytes || 0));
      if (x.parseError) lines.push("  parseError=" + x.parseError);
    });
  }

  if (hls && Array.isArray(hls.variants)) {
    lines.push("HLS fallback variants=" + hls.variants.length + " | rawCached=" + has("ytmq.hls.raw"));
    hls.variants.slice(0, 12).forEach((v, i) => {
      lines.push("  HLS#" + (i + 1) + " " + v.resolution + " | itag=" + (v.itag || "?") + " | BW=" + (v.bandwidth || 0) + " | AVG=" + (v.averageBandwidth || 0) + (v.frameRate ? " | FPS=" + v.frameRate : "") + (v.codecs ? " | " + v.codecs : ""));
    });
  } else {
    lines.push("HLS fallback: not used in this playback");
  }

  lines.push("CAPTURE STATUS: player raw + SABR request raws are cached locally when available.");
  lines.push("No signed media URL, IP, cookie, authorization header, or raw token is printed in this report.");
  lines.push("If decoding logic changes later, re-run this report after updating the script; replaying the video should not be necessary as long as the local cache remains.");

  const report = lines.join("\n");
  console.log(report);
  $notification.post("YouTube 全量抓取报告", "抓取完成", "打开脚本日志，把这一条报告发给我即可。", null, 0);
  $done({});
})();
