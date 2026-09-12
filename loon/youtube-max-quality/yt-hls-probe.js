// YouTube HLS fallback capture for Loon
// Read-only. Parses HLS variants, stores metadata locally, and avoids logging signed URLs.

(function () {
  let body = $response && $response.body;

  if (body instanceof Uint8Array) {
    try { body = new TextDecoder("utf-8").decode(body); }
    catch (_) {
      let s = "";
      for (let i = 0; i < body.length; i++) s += String.fromCharCode(body[i]);
      body = s;
    }
  }

  if (typeof body !== "string" || body.indexOf("#EXTM3U") === -1) {
    console.log("[YT Capture / HLS v4]\nNot an HLS text manifest");
    $done({});
    return;
  }

  function getAttr(line, key) {
    const re = new RegExp("(?:^|,)" + key + "=(?:\\\"([^\\\"]*)\\\"|([^,]*))", "i");
    const m = line.match(re);
    return m ? (m[1] != null ? m[1] : m[2]) : "";
  }

  function getItag(uri) {
    let m = uri.match(/(?:\/|%2F)itag(?:\/|%2F)(\d+)/i);
    if (!m) m = uri.match(/[?&]itag=(\d+)/i);
    return m ? parseInt(m[1], 10) : 0;
  }

  const lines = body.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

    let uri = "";
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (!candidate) continue;
      if (candidate.startsWith("#")) break;
      uri = candidate;
      break;
    }

    const attrs = line.slice("#EXT-X-STREAM-INF:".length);
    variants.push({
      resolution: getAttr(attrs, "RESOLUTION"),
      bandwidth: parseInt(getAttr(attrs, "BANDWIDTH") || "0", 10) || 0,
      averageBandwidth: parseInt(getAttr(attrs, "AVERAGE-BANDWIDTH") || "0", 10) || 0,
      codecs: getAttr(attrs, "CODECS"),
      frameRate: getAttr(attrs, "FRAME-RATE"),
      itag: getItag(uri)
    });
  }

  const sorted = variants.filter(v => /^\d+x\d+$/.test(v.resolution)).sort((a, b) => {
    const ah = parseInt((a.resolution.split("x")[1] || "0"), 10) || 0;
    const bh = parseInt((b.resolution.split("x")[1] || "0"), 10) || 0;
    if (bh !== ah) return bh - ah;
    return (b.averageBandwidth || b.bandwidth) - (a.averageBandwidth || a.bandwidth);
  });

  const meta = {
    version: 4,
    capturedAt: Date.now(),
    variants: sorted
  };
  $persistentStore.write(JSON.stringify(meta), "ytmq.hls.meta");
  $persistentStore.write(body, "ytmq.hls.raw");

  const out = sorted.map((v, i) => {
    const bw = v.bandwidth ? Math.round(v.bandwidth / 1000) : 0;
    const avg = v.averageBandwidth ? Math.round(v.averageBandwidth / 1000) : 0;
    return "#" + (i + 1) + " " + v.resolution + " | itag=" + (v.itag || "?") + " | BW=" + (bw || "?") + "kbps | AVG=" + (avg || "?") + (v.frameRate ? " | FPS=" + v.frameRate : "") + (v.codecs ? " | " + v.codecs : "");
  });

  console.log(
    "[YT Capture / HLS v4]\n" +
    "variants=" + sorted.length + " | 1080p=" + sorted.filter(v => /x1080$/.test(v.resolution)).length + "\n" +
    (out.length ? out.join("\n") : "No video variants") +
    "\nManifest cached locally; signed variant URLs intentionally omitted."
  );

  $done({});
})();
