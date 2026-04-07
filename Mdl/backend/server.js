// ============================================================
//  Liquid Downloader — Cloudflare Worker Backend
//  Endpoints: POST /api/extract  |  GET /api/download
// ============================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
};

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

// ── Helpers ─────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return 'N/A';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDuration(sec) {
  if (!sec) return '';
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = Math.floor(sec % 60);
  let r = '';
  if (hrs > 0) r += String(hrs).padStart(2, '0') + ':';
  r += String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  return r;
}

function getVideoId(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    // youtu.be/ID or /shorts/ID or /embed/ID
    const m = u.pathname.match(/(?:shorts|embed|v)\/([A-Za-z0-9_-]{11})|^\/([A-Za-z0-9_-]{11})$/);
    if (m) return m[1] || m[2];
  } catch (_) {}
  return null;
}

// ── YouTube via Invidious (multiple public instances) ────────

const INVIDIOUS_INSTANCES = [
  'invidious.jing.rocks',
  'iv.melmac.space',
  'yt.artemislena.eu',
  'invidious.flokinet.to',
  'invidious.privacydev.net',
];

async function extractYouTube(url) {
  const videoId = getVideoId(url);
  if (!videoId) return null;

  for (const host of INVIDIOUS_INSTANCES) {
    try {
      const apiUrl = `https://${host}/api/v1/videos/${videoId}?fields=title,description,formatStreams,adaptiveFormats,videoThumbnails,author,lengthSeconds`;
      const r = await fetch(apiUrl, {
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) continue;
      const data = await r.json();
      if (!data || !data.title) continue;

      const allFormats = [...(data.formatStreams || []), ...(data.adaptiveFormats || [])];
      return {
        title: data.title,
        thumbnail: data.videoThumbnails?.find(t => t.quality === 'maxresdefault' || t.quality === 'hqdefault')?.url
                   || data.videoThumbnails?.[0]?.url,
        duration: data.lengthSeconds,
        uploader: data.author,
        webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
        formats: allFormats.map(f => {
          const isAudioOnly = f.vcodec === 'none' || !f.vcodec || (f.type && f.type.startsWith('audio/'));
          return {
            format_id: f.itag || f.quality || 'unknown',
            url: f.url,
            ext: isAudioOnly ? 'm4a' : 'mp4',
            vcodec: isAudioOnly ? 'none' : (f.vcodec || 'h264'),
            acodec: f.acodec || 'aac',
            height: f.height ? parseInt(f.height) : 0,
            abr: f.bitrate ? Math.round(parseInt(f.bitrate) / 1000) : null,
            resolution: isAudioOnly ? 'audio' : (f.qualityLabel || f.quality || '720p'),
            filesize: f.contentLength ? parseInt(f.contentLength) : null,
          };
        }),
      };
    } catch (e) {
      // Try next instance
    }
  }
  return null;
}

// ── Generic OG-tag / HTML scraper ────────────────────────────

async function extractGeneric(url) {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const html = await r.text();

    // Helper to get meta content
    const getMeta = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
              || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
      return m ? m[1] : null;
    };

    const title = getMeta('og:title') || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || 'Media';
    const thumbnail = getMeta('og:image');
    const videoUrl = getMeta('og:video:secure_url') || getMeta('og:video');

    const formats = [];
    if (videoUrl) {
      formats.push({
        format_id: 'og-video',
        url: videoUrl,
        ext: 'mp4',
        vcodec: 'h264',
        acodec: 'aac',
        height: 0,
        resolution: 'Original',
        filesize: null,
      });
    }

    // Grab <video src> or <source src>
    const videoSrcMatches = [...html.matchAll(/<(?:video|source)[^>]+src=["']([^"']+)["']/gi)];
    for (const m of videoSrcMatches) {
      const src = m[1].startsWith('//') ? 'https:' + m[1] : m[1].startsWith('/') ? new URL(m[1], url).href : m[1];
      if (!formats.find(f => f.url === src)) {
        formats.push({ format_id: 'html-video', url: src, ext: 'mp4', vcodec: 'h264', acodec: 'aac', height: 0, resolution: 'Original', filesize: null });
      }
    }

    return formats.length > 0 ? { title, thumbnail, duration: null, formats } : null;
  } catch (_) {
    return null;
  }
}

// ── Build response formats from raw extraction output ────────

function buildFormats(output, baseUrl) {
  const formats = [];
  const seenUrls = new Set();

  if (!output?.formats?.length) {
    // Single URL output
    if (output?.url) {
      formats.push({
        quality: 'Original',
        type: (output.ext || 'Media').toUpperCase(),
        url: output.url,
        size: 'Direct',
        icon: 'fa-download',
        badge: 'Direct',
      });
    }
    return formats;
  }

  // Filter & sort: video by height desc, then audio
  const videos = output.formats.filter(f => f.vcodec !== 'none').sort((a, b) => (b.height || 0) - (a.height || 0));
  const audios = output.formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none');

  for (const f of videos) {
    if (seenUrls.has(f.url) || formats.length >= 15) continue;
    const h = f.height || 0;
    let qlabel = '';
    if (h >= 2160) qlabel = '4K';
    else if (h >= 1440) qlabel = '1440p';
    else if (h >= 1080) qlabel = '1080p';
    else if (h >= 720) qlabel = '720p';
    else if (h >= 480) qlabel = '480p';
    else if (h >= 360) qlabel = '360p';
    else qlabel = f.resolution || 'Video';

    seenUrls.add(f.url);
    formats.push({
      quality: qlabel,
      type: (f.ext || 'mp4').toUpperCase(),
      url: f.url,
      size: formatBytes(f.filesize),
      icon: 'fa-film',
      badge: h >= 720 ? 'HQ' : '',
    });
  }

  // Best audio track
  if (audios.length > 0) {
    const best = audios.find(f => f.ext === 'm4a') || audios[0];
    if (!seenUrls.has(best.url)) {
      seenUrls.add(best.url);
      formats.push({
        quality: 'Audio Only',
        type: 'M4A',
        url: best.url,
        size: formatBytes(best.filesize),
        icon: 'fa-music',
        badge: 'Audio',
      });
    }
  }

  // If videos had no audio (DASH), inject audio format too if not already present
  const hasAudioBadge = formats.some(f => f.badge === 'Audio');
  if (!hasAudioBadge && audios.length > 0) {
    const best = audios[0];
    if (!seenUrls.has(best.url)) {
      seenUrls.add(best.url);
      formats.push({
        quality: 'Audio Only',
        type: 'M4A',
        url: best.url,
        size: formatBytes(best.filesize),
        icon: 'fa-music',
        badge: 'Audio',
      });
    }
  }

  return formats;
}

// ── Route: POST /api/extract ─────────────────────────────────

async function handleExtract(request) {
  let body;
  try { body = await request.json(); } catch (_) {
    return jsonResponse({ status: 'error', message: 'Invalid JSON body.' }, 400);
  }

  const rawUrl = (body.url || '').trim();
  if (!rawUrl) return jsonResponse({ status: 'error', message: 'Please provide a valid URL.' }, 400);

  let targetUrl = rawUrl;
  // Resolve short links (t.co, youtu.be, etc.)
  try {
    const r = await fetch(rawUrl, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) });
    targetUrl = r.url || rawUrl;
  } catch (_) {}

  const isYouTube = targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be');

  let output = null;

  if (isYouTube) {
    output = await extractYouTube(targetUrl);
  }

  if (!output) {
    output = await extractGeneric(targetUrl);
  }

  if (!output || (!output.formats?.length && !output.url)) {
    return jsonResponse({
      status: 'error',
      message: 'No media found or extraction failed. The site might be protected or the link might be private.',
    });
  }

  const host = new URL(request.url).host;
  const proto = request.url.startsWith('https') ? 'https' : 'http';

  const rawFormats = buildFormats(output, `${proto}://${host}`);

  const sanitizedTitle = (output.title || 'media').substring(0, 60).replace(/[^a-z0-9]/gi, '_');

  const formats = rawFormats.map(f => {
    let ext = (f.type || 'media').toLowerCase();
    if (ext === 'image') {
      const match = f.url.match(/\.(jpg|jpeg|png|webp|gif)/i);
      ext = match ? match[1] : 'jpg';
    }
    const proxyUrl = `${proto}://${host}/api/download?url=${encodeURIComponent(f.url)}&filename=${encodeURIComponent(sanitizedTitle + '.' + ext)}`;
    return { ...f, url: proxyUrl };
  });

  return jsonResponse({
    status: 'success',
    title: output.title || 'Liquid Download',
    thumbnail: output.thumbnail || null,
    duration: formatDuration(output.duration),
    formats,
  });
}

// ── Route: GET /api/download (proxy relay) ───────────────────

async function handleDownload(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const filename = searchParams.get('filename') || 'download';

  if (!url) {
    return new Response('URL parameter is required', { status: 400, headers: CORS_HEADERS });
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': '*/*',
        'Referer': 'https://www.google.com/',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(120000),
    });

    if (!upstream.ok && upstream.status !== 206) {
      return new Response('Failed to fetch source', { status: 502, headers: CORS_HEADERS });
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentLength = upstream.headers.get('content-length');

    const headers = {
      ...CORS_HEADERS,
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
    };
    if (contentLength) headers['Content-Length'] = contentLength;

    return new Response(upstream.body, { status: 200, headers });
  } catch (err) {
    return new Response('Stream relay failed: ' + err.message, { status: 500, headers: CORS_HEADERS });
  }
}

// ── Main Worker Entry Point ──────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return jsonResponse({ status: 'ok', message: '🚀 Liquid Downloader Worker is running!' });
    }

    // POST /api/extract
    if (url.pathname === '/api/extract' && method === 'POST') {
      return handleExtract(request);
    }

    // GET /api/download
    if (url.pathname === '/api/download' && method === 'GET') {
      return handleDownload(request);
    }

    return jsonResponse({ status: 'error', message: 'Not found.' }, 404);
  },
};
