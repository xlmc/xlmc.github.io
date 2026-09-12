// YouTube HLS Manifest Probe for Loon
// Read-only: inspects the actual HLS master playlist and never modifies playback.

(function () {
  const url = ($request && $request.url) || "unknown";
  let body = $response && $response.body;

  if (body instanceof Uint8Array) {
    try {
      body = new TextDecoder("utf-8").decode(body);
    } catch (e) {
      let s = "";
      for (let i = 0; i < body.length; i++) s += String.fromCharCode(body[i]);
      body = s;
    }
  }

  if (typeof body !== "string" || body.indexOf("#EXTM3U") === -1) {
    console.log("[YT HLS Probe]\nNot an HLS text manifest\nURL: " + url);
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
    return m ? m[1] : "?";
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
    const resolution = getAttr(attrs, "RESOLUTION");
    const bandwidth = parseInt(getAttr(attrs, "BANDWIDTH") || "0", 10) || 0;
    const avgBandwidth = parseInt(getAttr(attrs, "AVERAGE-BANDWIDTH") || "0", 10) || 0;
    const codecs = getAttr(attrs, "CODECS");
    const frameRate = getAttr(attrs, "FRAME-RATE");
    const itag = getItag(uri);

    variants.push({ resolution, bandwidth, avgBandwidth, codecs, frameRate, itag, uri });
  }

  const videoVariants = variants.filter(v => /^\d+x\d+$/.test(v.resolution));
  const sorted = videoVariants.slice().sort((a, b) => {
    const ah = parseInt((a.resolution.split("x")[1] || "0"), 10) || 0;
    const bh = parseInt((b.resolution.split("x")[1] || "0"), 10) || 0;
    if (bh !== ah) return bh - ah;
    return (b.avgBandwidth || b.bandwidth) - (a.avgBandwidth || a.bandwidth);
  });

  const fullHd = sorted.filter(v => {
    const p = v.resolution.split("x");
    return parseInt(p[1] || "0", 10) === 1080;
  });

  const out = sorted.map((v, idx) => {
    const bw = v.bandwidth ? Math.round(v.bandwidth / 1000) + " kbps" : "?";
    const avg = v.avgBandwidth ? Math.round(v.avgBandwidth / 1000) + " kbps" : "?";
    return (
      "#" + (idx + 1) +
      " " + (v.resolution || "?") +
      " | itag=" + v.itag +
      " | BW=" + bw +
      " | AVG=" + avg +
      (v.frameRate ? " | FPS=" + v.frameRate : "") +
      (v.codecs ? " | " + v.codecs : "")
    );
  });

  console.log(
    "[YT HLS Probe]\n" +
    "URL: " + url + "\n" +
    "Variants: " + sorted.length + "\n" +
    "1080p variants: " + fullHd.length + "\n" +
    (out.length ? out.join("\n") : "No EXT-X-STREAM-INF variants found")
  );

  if (fullHd.length) {
    const best = fullHd.slice().sort((a, b) => (b.avgBandwidth || b.bandwidth) - (a.avgBandwidth || a.bandwidth))[0];
    const bestBw = best ? Math.round((best.avgBandwidth || best.bandwidth || 0) / 1000) : 0;
    $notification.post(
      "YouTube 实际流探测",
      "检测到 " + fullHd.length + " 个 1080p 变体",
      "最高 1080p 带宽约 " + (bestBw || "?") + " kbps，itag=" + (best ? best.itag : "?") + "。打开脚本日志查看全部变体。",
      null,
      0
    );
  }

  $done({});
})();
