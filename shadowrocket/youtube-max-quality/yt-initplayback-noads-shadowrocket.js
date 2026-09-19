// YouTube NoAds - Shadowrocket initplayback fallback v24
// Mirrors the original Maasea no-key fallback locally: when initplayback reaches the
// acknowledged ad/Onesie stage, return an empty 200 so the app falls back to v1/player.
// No remote Worker, no duplicate request, and no playback response rewriting here.

(function () {
  const PREFIX = "[YT NoAds SR v24][INIT]";
  const url = ($request && $request.url) || "";

  let u;
  try { u = new URL(url); } catch (_) {
    $done({});
    return;
  }

  if (!/\/initplayback$/i.test(u.pathname)) {
    $done({});
    return;
  }

  const ack = u.searchParams.get("ack");
  const oad = u.searchParams.get("oad");
  const oaad = u.searchParams.get("oaad");

  // The original request module only takes over the acknowledged initplayback stage.
  // Earlier redirector/bootstrap initplayback requests remain native.
  if (!ack) {
    $done({});
    return;
  }

  console.log(
    PREFIX + " fallback | ack=" + ack +
    " | oad=" + (oad || "-") +
    " | oaad=" + (oaad || "-")
  );

  $done({
    response: {
      status: 200,
      headers: { "Content-Type": "text/plain" },
      body: new Uint8Array(0)
    }
  });
})();