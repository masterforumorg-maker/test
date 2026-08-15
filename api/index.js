import { Readable } from "node:stream";

// Bellek içi token önbelleği (Anlık 0ms başlatma sağlar)
const tokenCache = new Map();

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Accept-Ranges", "bytes");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  let targetUrlStr = req.query.url;
  const audioLang = req.query.audio || ""; // 'tur' veya 'eng'

  if (!targetUrlStr) {
    return res.status(400).send("Missing url parameter.");
  }

  try {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = req.headers["x-forwarded-proto"] || "https";
    const proxyBase = `${proto}://${host}/api?url=`;

    // 1. VidMoly embed linki geldiyse hızlı önbellekten al veya çöz
    if (targetUrlStr.includes("vidmoly.net/embed-") || targetUrlStr.includes("vidmoly.to/embed-") || targetUrlStr.includes("vidmoly.me/embed-")) {
      const now = Date.now();
      const cached = tokenCache.get(targetUrlStr);

      if (cached && (now - cached.time < 30 * 60 * 1000)) {
        targetUrlStr = cached.m3u8;
      } else {
        const embResp = await fetch(targetUrlStr, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": "https://sezonlukdizi.cc/"
          }
        });
        const embHtml = await embResp.text();
        const m3u8Match = embHtml.match(/(https?:\/\/[^\s'"<>]+\.m3u8[^\s'"<>]*)/i);
        if (m3u8Match && m3u8Match[1]) {
          targetUrlStr = m3u8Match[1];
          tokenCache.set(req.query.url, { m3u8: targetUrlStr, time: now });
        }
      }
    }

    const targetUrl = new URL(targetUrlStr);

    // Dinamik Referer ve Origin Tespiti
    let dynamicReferer = "https://vidmoly.net/";
    let dynamicOrigin = "https://vidmoly.net";

    if (targetUrl.hostname.includes("vidload.top") || targetUrl.hostname.includes("eksenload.top")) {
      const pathParts = targetUrl.pathname.split("/");
      let fileId = "";
      const encodeIdx = pathParts.indexOf("encode");
      if (encodeIdx !== -1 && pathParts[encodeIdx + 1]) {
        fileId = pathParts[encodeIdx + 1];
      }
      dynamicReferer = fileId ? `https://eksenload.top/eplayer/${fileId}` : "https://eksenload.top/";
      dynamicOrigin = "https://eksenload.top";
    } else if (targetUrl.hostname.includes("vmeas.cloud") || targetUrl.hostname.includes("vidmoly")) {
      dynamicReferer = "https://vidmoly.net/";
      dynamicOrigin = "https://vidmoly.net";
    } else {
      dynamicReferer = `${targetUrl.protocol}//${targetUrl.hostname}/`;
      dynamicOrigin = `${targetUrl.protocol}//${targetUrl.hostname}`;
    }

    const fetchHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Referer": dynamicReferer,
      "Origin": dynamicOrigin,
      "Accept": "*/*",
      "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7"
    };

    if (req.headers.range) {
      fetchHeaders["Range"] = req.headers.range;
    }

    const response = await fetch(targetUrl.href, {
      headers: fetchHeaders,
      redirect: "follow"
    });

    const isM3U8 = targetUrl.pathname.endsWith(".m3u8") || targetUrl.href.includes(".m3u8");

    if (isM3U8 && response.ok) {
      let text = await response.text();
      const basePath = targetUrl.href.substring(0, targetUrl.href.lastIndexOf("/") + 1);

      // 1. Ses kanalları (URI="...")
      text = text.replace(/URI=["']([^"']+)["']/g, (match, p1) => {
        let abs = p1.startsWith("http") ? p1 : (p1.startsWith("/") ? targetUrl.origin + p1 : basePath + p1);
        return `URI="${proxyBase}${encodeURIComponent(abs)}"`;
      });

      // 2. Alt playlistler ve Segmentler
      text = text.split("\n").map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          let abs = trimmed.startsWith("http") ? trimmed : (trimmed.startsWith("/") ? targetUrl.origin + trimmed : basePath + trimmed);
          return `${proxyBase}${encodeURIComponent(abs)}`;
        }
        return line;
      }).join("\n");

      // 3. Eğer Altyazılı sekmesi istenmişse (audio=eng), İngilizce sesi varsayılan (DEFAULT=YES) yap!
      if (audioLang === "eng") {
        text = text.split("\n").map(line => {
          if (line.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) {
            if (line.includes('LANGUAGE="eng"') || line.includes('NAME="English"')) {
              line = line.replace(/DEFAULT=(?:YES|NO)/, "DEFAULT=YES").replace(/AUTOSELECT=(?:YES|NO)/, "AUTOSELECT=YES");
            } else {
              line = line.replace(/DEFAULT=(?:YES|NO)/, "DEFAULT=NO");
            }
          }
          return line;
        }).join("\n");
      }

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.status(200).send(text);
    }

    // Video Segmentleri (.ts ve .mp4) için Yüksek Hızlı Doğrudan Akış (Stream Pipe)
    res.setHeader("Content-Type", response.headers.get("content-type") || "video/mp2t");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    if (response.headers.get("content-range")) {
      res.setHeader("Content-Range", response.headers.get("content-range"));
    }
    if (response.headers.get("content-length")) {
      res.setHeader("Content-Length", response.headers.get("content-length"));
    }

    res.status(response.status);

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body);
      return nodeStream.pipe(res);
    } else {
      const arrayBuffer = await response.arrayBuffer();
      return res.send(Buffer.from(arrayBuffer));
    }

  } catch (error) {
    return res.status(500).send("Proxy Error: " + error.message);
  }
}
