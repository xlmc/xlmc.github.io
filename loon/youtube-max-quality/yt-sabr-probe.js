// YouTube SABR request probe for Loon
// Read-only: logs actual googlevideo playback request metadata; never modifies traffic.

(function () {
  const url = ($request && $request.url) || "";
  const method = ($request && $request.method) || "UNKNOWN";
  const headers = ($request && $request.headers) || {};
  const body = $request && $request.body;

  function qp(name) {
    try {
      const u = new URL(url);
      return u.searchParams.get(name) || "";
    } catch (_) {
      const m = url.match(new RegExp("(?:[?&])" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^&]+)", "i"));
      return m ? decodeURIComponent(m[1]) : "";
    }
  }

  function bodyLength(v) {
    if (!v) return 0;
    if (typeof v === "string") return v.length;
    if (typeof v.byteLength === "number") return v.byteLength;
    if (typeof v.length === "number") return v.length;
    return 0;
  }

  const isInit = /\/initplayback(?:\?|$)/i.test(url);
  const isPlayback = /\/videoplayback(?:\?|\/|$)/i.test(url);
  const sabrFlag = qp("sabr");
  const itag = qp("itag");
  const source = qp("source");
  const rn = qp("rn");
  const range = qp("range");
  const mime = qp("mime");
  const cpn = qp("cpn");
  const contentType = headers["Content-Type"] || headers["content-type"] || "";

  console.log(
    "[YT SABR Probe]\n" +
    "Kind: " + (isInit ? "initplayback" : (isPlayback ? "videoplayback" : "other")) + "\n" +
    "Method: " + method + "\n" +
    "URL: " + url + "\n" +
    "source=" + (source || "-") +
    " | sabr=" + (sabrFlag || "-") +
    " | itag=" + (itag || "-") +
    " | rn=" + (rn || "-") +
    " | range=" + (range || "-") +
    " | mime=" + (mime || "-") +
    " | cpn=" + (cpn || "-") + "\n" +
    "Content-Type: " + (contentType || "-") + "\n" +
    "Request body: " + bodyLength(body) + " bytes"
  );

  $done({});
})();
