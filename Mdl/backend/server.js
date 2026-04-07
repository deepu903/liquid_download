// ============================================================
//  Liquid Downloader — Cloudflare Worker
//  POST /api/extract  |  GET /api/download
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

// ── Helpers ─────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function formatBytes(b) {
  if (!b) return 'N/A';
  const k = 1024, s = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + s[i];
}

function formatDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function getVideoId(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/(?:shorts|embed|v|e)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    // youtu.be/<id>
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0];
  } catch (_) {}
  return null;
}

function isYT(url) {
  return url.includes('youtube.com') || url.includes('youtu.be');
}

// ── YouTube via Invidious ────────────────────────────────────────────────────

const INVIDIOUS = [
  'inv.tux.digital',
  'invidious.private.coffee',
  'invidious.jing.rocks',
  'iv.melmac.space',
  'yt.artemislena.eu',
  'invidious.flokinet.to',
  'invidious.privacydev.net',
];

async function extractYouTube(url) {
  const videoId = getVideoId(url);
  if (!videoId) return null;

  for (const host of INVIDIOUS) {
    try {
      const apiUrl = `https://${host}/api/v1/videos/${videoId}?fields=title,formatStreams,adaptiveFormats,videoThumbnails,author,lengthSeconds`;
      const r = await fetch(apiUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const d = await r.json();
      if (!d?.title) continue;

      const all = [...(d.formatStreams || []), ...(d.adaptiveFormats || [])];
      return {
        title: d.title,
        thumbnail: d.videoThumbnails?.find(t => t.quality === 'maxresdefault' || t.quality === 'hqdefault')?.url || d.videoThumbnails?.[0]?.url,
        duration: d.lengthSeconds,
        uploader: d.author,
        formats: all.map(f => {
          const audio = f.vcodec === 'none' || !f.vcodec || f.type?.startsWith('audio/');
          return {
            url: f.url,
            ext: audio ? 'm4a' : 'mp4',
            vcodec: audio ? 'none' : (f.vcodec || 'h264'),
            acodec: f.acodec || 'aac',
            height: parseInt(f.resolution) || 0,
            resolution: audio ? 'audio' : (f.qualityLabel || f.quality || '720p'),
            filesize: f.contentLength ? parseInt(f.contentLength) : null,
          };
        }),
      };
    } catch (_) {}
  }
  return null;
}

// ── Enhanced Generic Scraper (Social Media Ready) ────────────────────────────

async function extractGeneric(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const html = await r.text();

    const getMeta = (prop) => {
      const match = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
                   html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
      return match ? match[1] : null;
    };

    const title = getMeta('og:title') || getMeta('twitter:title') || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || 'Media';
    const thumbnail = getMeta('og:image') || getMeta('twitter:image');
    
    // Look for high-priority video URLs
    const videoUrl = getMeta('og:video:url') || getMeta('og:video:secure_url') || getMeta('og:video') || getMeta('twitter:player:stream');

    const formats = [];
    if (videoUrl) {
      formats.push({ format_id: 'og-video', url: videoUrl, ext: 'mp4', vcodec: 'h264', acodec: 'aac', resolution: 'Original' });
    }

    // JSON-LD or platform data search
    const jsonLd = html.match(/<script type=["']application\/ld\+json["']>([^<]+)<\/script>/i);
    if (jsonLd) {
      try {
        const data = JSON.parse(jsonLd[1]);
        const contentUrl = data.contentUrl || data.video?.contentUrl || data.thumbnailUrl;
        if (contentUrl && !formats.find(f => f.url === contentUrl)) {
          formats.push({ format_id: 'ld-json', url: contentUrl, ext: data.video ? 'mp4' : 'jpg', vcodec: data.video ? 'h264' : 'none', acodec: 'aac', resolution: 'Original' });
        }
      } catch (_) {}
    }

    // Pure Regex fallbacks for direct stream links
    if (formats.length === 0) {
      const streamMatch = html.match(/https?:\/\/[^"']+\.(?:mp4|m4a|m3u8|webm)(?:\?[^"']*)?/gi);
      if (streamMatch) {
        streamMatch.slice(0, 5).forEach((u, i) => {
          if (!formats.find(f => f.url === u)) {
            formats.push({ format_id: `regex-${i}`, url: u, ext: u.includes('m4a') ? 'm4a' : 'mp4', vcodec: u.includes('m4a') ? 'none' : 'h264', acodec: 'aac', resolution: 'Raw Stream' });
          }
        });
      }
    }

    return formats.length ? { title, thumbnail, duration: null, formats } : null;
  } catch (_) { return null; }
}

// ── Build download format list ───────────────────────────────────────────────

function buildFormats(output) {
  const seen = new Set();
  const result = [];

  // Gallery / multi-entry
  if (output.entries) {
    output.entries.forEach((e, i) => {
      const u = e.url || e.thumbnail;
      if (u && !seen.has(u)) {
        seen.add(u);
        const isVid = e.vcodec !== 'none';
        result.push({ quality: isVid ? `Part ${i + 1}` : `Photo ${i + 1}`, type: isVid ? 'MP4' : 'Image', url: u, size: formatBytes(e.filesize), icon: isVid ? 'fa-film' : 'fa-image', badge: isVid ? 'HQ' : 'Photo' });
      }
    });
  }

  if (output.formats?.length) {
    const videos = output.formats.filter(f => f.vcodec !== 'none').sort((a, b) => (b.height || 0) - (a.height || 0));
    const audios = output.formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none');

    for (const f of videos) {
      if (seen.has(f.url) || result.length >= 12) continue;
      const h = f.height || 0;
      const ql = h >= 2160 ? '4K' : h >= 1440 ? '1440p' : h >= 1080 ? '1080p' : h >= 720 ? '720p' : h >= 480 ? '480p' : h >= 360 ? '360p' : (f.resolution || 'Video');
      seen.add(f.url);
      result.push({ quality: ql, type: (f.ext || 'mp4').toUpperCase(), url: f.url, size: formatBytes(f.filesize), icon: 'fa-film', badge: h >= 720 ? 'HQ' : '' });
    }

    if (audios.length) {
      const best = audios.find(f => f.ext === 'm4a') || audios[0];
      if (!seen.has(best.url)) {
        seen.add(best.url);
        result.push({ quality: 'Audio Only', type: 'M4A', url: best.url, size: formatBytes(best.filesize), icon: 'fa-music', badge: 'Audio' });
      }
    }
  }

  // Fallback single URL
  if (!result.length && output.url) {
    result.push({ quality: 'Original', type: (output.ext || 'Media').toUpperCase(), url: output.url, size: 'Direct', icon: 'fa-download', badge: 'Direct' });
  }

  return result;
}

// ── Route: POST /api/extract ─────────────────────────────────────────────────

async function handleExtract(request) {
  let body;
  try { body = await request.json(); } catch (_) {
    return json({ status: 'error', message: 'Invalid JSON body.' }, 400);
  }

  const rawUrl = (body.url || '').trim();
  if (!rawUrl) return json({ status: 'error', message: 'Please provide a valid URL.' }, 400);

  // Resolve redirect (for short links)
  let targetUrl = rawUrl;
  try {
    const r = await fetch(rawUrl, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) });
    targetUrl = r.url || rawUrl;
  } catch (_) {}

  let output = isYT(targetUrl) ? await extractYouTube(targetUrl) : null;
  if (!output) output = await extractGeneric(targetUrl);

  if (!output || (!output.formats?.length && !output.entries?.length && !output.url)) {
    return json({ status: 'error', message: 'No media found or extraction failed. The link might be private or protected.' });
  }

  const { host, protocol } = new URL(request.url);
  const base = `${protocol}//${host}`;
  const sanitizedTitle = (output.title || 'media').slice(0, 50).replace(/[^a-z0-9]/gi, '_');

  const formats = buildFormats(output).map(f => {
    let ext = (f.type || 'media').toLowerCase();
    if (ext === 'image') { const m = f.url.match(/\.(jpg|jpeg|png|webp|gif)/i); ext = m?.[1] || 'jpg'; }
    return {
      ...f,
      url: `${base}/api/download?url=${encodeURIComponent(f.url)}&filename=${encodeURIComponent(sanitizedTitle + '.' + ext)}`,
    };
  });

  return json({ status: 'success', title: output.title || 'Liquid Download', thumbnail: output.thumbnail || null, duration: formatDuration(output.duration), formats });
}

// ── Route: GET /api/download ─────────────────────────────────────────────────

async function handleDownload(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const filename = searchParams.get('filename') || 'download';

  if (!url) return new Response('URL parameter required', { status: 400, headers: CORS });

  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://www.google.com/' },
      redirect: 'follow',
      signal: AbortSignal.timeout(120000),
    });

    if (!upstream.ok && upstream.status !== 206) {
      return new Response(`Source returned ${upstream.status}`, { status: 502, headers: CORS });
    }

    const headers = {
      ...CORS,
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
    };
    const cl = upstream.headers.get('content-length');
    if (cl) headers['Content-Length'] = cl;

    return new Response(upstream.body, { status: 200, headers });
  } catch (err) {
    return new Response('Relay failed: ' + err.message, { status: 500, headers: CORS });
  }
}

// ── Worker Entry ─────────────────────────────────────────────────────────────

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (pathname === '/' || pathname === '/health') return json({ status: 'ok', message: '🚀 Liquid Downloader Worker is live!' });
    if (pathname === '/api/extract' && method === 'POST') return handleExtract(request);
    if (pathname === '/api/download' && method === 'GET') return handleDownload(request);

    return json({ status: 'error', message: 'Not found.' }, 404);
  },
};
