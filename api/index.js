export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const targetUrlStr = req.query.url;
  if (!targetUrlStr) {
    return res.status(400).send("Missing url parameter.");
  }

  try {
    const targetUrl = new URL(targetUrlStr);

    const pathParts = targetUrl.pathname.split("/");
    let fileId = "";
    const encodeIdx = pathParts.indexOf("encode");
    if (encodeIdx !== -1 && pathParts[encodeIdx + 1]) {
      fileId = pathParts[encodeIdx + 1];
    }

    const dynamicReferer = fileId ? `https://eksenload.top/eplayer/${fileId}` : "https://eksenload.top/";

    const fetchHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": dynamicReferer,
      "Origin": "https://eksenload.top",
      "Accept": "*/*",
      "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7"
    };

    const response = await fetch(targetUrl.href, {
      headers: fetchHeaders,
      redirect: "follow"
    });

    const isM3U8 = targetUrl.pathname.endsWith(".m3u8") || targetUrl.href.includes(".m3u8");

    if (isM3U8 && response.ok) {
      let text = await response.text();
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const proto = req.headers["x-forwarded-proto"] || "https";
      const proxyBase = `${proto}://${host}/api?url=`;

      const basePath = targetUrl.href.substring(0, targetUrl.href.lastIndexOf("/") + 1);

      text = text.replace(/URI=["']([^"']+)["']/g, (match, p1) => {
        let abs = p1.startsWith("http") ? p1 : (p1.startsWith("/") ? targetUrl.origin + p1 : basePath + p1);
        return `URI="${proxyBase}${encodeURIComponent(abs)}"`;
      });

      text = text.split("\n").map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          let abs = trimmed.startsWith("http") ? trimmed : (trimmed.startsWith("/") ? targetUrl.origin + trimmed : basePath + trimmed);
          return `${proxyBase}${encodeURIComponent(abs)}`;
        }
        return line;
      }).join("\n");

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.status(200).send(text);
    }

    res.setHeader("Content-Type", response.headers.get("content-type") || "video/mp2t");
    res.setHeader("Cache-Control", "public, max-age=86400");

    const arrayBuffer = await response.arrayBuffer();
    return res.status(response.status).send(Buffer.from(arrayBuffer));

  } catch (error) {
    return res.status(500).send("Proxy Error: " + error.message);
  }
}
