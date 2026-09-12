// YouTube Max Quality Probe for Loon
// Read-only probe: inspects protobuf response bytes and never modifies playback data.

(function () {
  const bytes = $response && $response.body;
  const url = ($request && $request.url) || "unknown";
  const notify = !$argument || $argument.notify !== false;

  if (!(bytes instanceof Uint8Array)) {
    const msg = `[YT Max Quality Probe] Body is not Uint8Array | url=${url}`;
    console.log(msg);
    if (notify) $notification.post("YouTube 画质探测", "未读取到二进制响应", "请确认插件已启用并已开启 MitM。", null, 0);
    $done({});
    return;
  }

  function extractAsciiStrings(input, minLen) {
    const out = [];
    let buf = "";
    for (let i = 0; i < input.length; i++) {
      const c = input[i];
      if (c >= 32 && c <= 126) {
        buf += String.fromCharCode(c);
      } else {
        if (buf.length >= minLen) out.push(buf);
        buf = "";
      }
    }
    if (buf.length >= minLen) out.push(buf);
    return out;
  }

  const strings = extractAsciiStrings(bytes, 4);
  const interesting = [];
  const seen = Object.create(null);
  const matcher = /(1080p\s*Premium|Premium|enhanced\s*bitrate|premium_upsell|paygated|4320p|2160p|1440p|1080p|720p|qualityLabel|video\/|vp9|av01|itag)/i;

  for (let i = 0; i < strings.length; i++) {
    const s = strings[i];
    if (matcher.test(s)) {
      const clipped = s.length > 220 ? s.slice(0, 220) + "…" : s;
      if (!seen[clipped]) {
        seen[clipped] = true;
        interesting.push(clipped);
      }
      if (interesting.length >= 50) break;
    }
  }

  const joined = interesting.join("\n---\n");
  const premiumUi = /(1080p\s*Premium|enhanced\s*bitrate|YouTube\s*Premium)/i.test(joined);
  const upsell = /(premium_upsell|paygated)/i.test(joined);
  const accessEvidence = premiumUi && !upsell ? "UNKNOWN" : "NO";
  const levels = ["4320p", "2160p", "1440p", "1080p", "720p"].filter(function (q) {
    return joined.indexOf(q) !== -1;
  });

  console.log(
    "[YT Max Quality Probe]\n" +
    "URL: " + url + "\n" +
    "Body: " + bytes.length + " bytes\n" +
    "Premium UI marker: " + (premiumUi ? "YES" : "NO") + "\n" +
    "Premium upsell/paygate marker: " + (upsell ? "YES" : "NO") + "\n" +
    "Premium stream access evidence: " + accessEvidence + "\n" +
    "Quality markers: " + (levels.length ? levels.join(", ") : "NONE") + "\n" +
    "Matches:\n" + (joined || "NONE")
  );

  if (notify && (premiumUi || levels.length)) {
    const subtitle = upsell ? "检测到 Premium 付费/升级标记" : (premiumUi ? "检测到 Premium UI 标记" : "检测到画质标记");
    $notification.post(
      "YouTube 画质探测",
      subtitle,
      "Premium UI: " + (premiumUi ? "YES" : "NO") +
      " | Upsell: " + (upsell ? "YES" : "NO") +
      " | 画质: " + (levels.length ? levels.join(", ") : "未识别") +
      "\n是否存在可播放 Premium 流仍需解析 streamingData。",
      null,
      0
    );
  }

  // Read-only: do not alter the response.
  $done({});
})();
