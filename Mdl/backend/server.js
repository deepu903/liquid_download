// ============================================================
//  Liquid Downloader — Cloudflare Worker (V9 STEALTH)
//  POST /api/extract  |  GET /api/download
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
const STEALTH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15';

// ── Helpers ─────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
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
    const m = u.pathname.match(/(?:shorts|embed|v|e|reels|reel|p|video)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0];
  } catch (_) {}
  return null;
}

// ── Extraction Stages ────────────────────────────────────────────────────────

async function extractInstaAjax(url) {
  try {
    // This mimics a hidden endpoint used by SaveInsta-like services
    const r = await fetch(url + '?__a=1&__d=dis', {
      headers: { 'User-Agent': STEALTH_UA, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) {
      const d = await r.json();
      const media = d.graphql?.shortcode_media || d.items?.[0];
      if (media) {
        return {
          title: media.title || media.caption?.text || 'Instagram Reel',
          thumbnail: media.display_url || media.thumbnail_src,
          formats: [{ url: media.video_url, ext: 'mp4', resolution: 'Original' }]
        };
      }
    }
  } catch (_) {}
  return null;
}

async function extractByCobalt(url) {
  const apis = ['https://cobalt.mnotf.dev/api/json', 'https://cobalt.q-f-l.xyz/api/json', 'https://api.cobalt.tools/api/json'];
  for (const api of apis) {
    try {
      const r = await fetch(api, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': STEALTH_UA },
        body: JSON.stringify({ url, videoQuality: '1080' }),
        signal: AbortSignal.timeout(9000),
      });
      if (!r.ok) continue;
      const d = await r.json();
      if (d.status === 'stream' || d.status === 'redirect') {
        return { title: d.filename || 'Media', formats: [{ url: d.url, ext: 'mp4', resolution: 'HD' }] };
      }
    } catch (_) {}
  }
  return null;
}

async function extractPiped(videoId) {
  const nodes = ['pipedapi.kavin.rocks', 'pipedapi.adminforge.de', 'pipedapi.lunar.icu'];
  for (const node of nodes) {
    try {
      const r = await fetch(`https://${node}/streams/${videoId}`, { signal: AbortSignal.timeout(7000) });
      if (!r.ok) continue;
      const d = await r.json();
      if (d.title) {
        const streams = (d.videoStreams || []).filter(s => s.videoOnly === false);
        return { title: d.title, thumbnail: d.thumbnailUrl, duration: d.duration, formats: streams.map(s => ({ url: s.url, ext: s.extension || 'mp4', resolution: s.quality || 'HD' })) };
      }
    } catch (_) {}
  }
  return null;
}

async function extractTikTok(url) {
  try {
    const r = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    if (d.code === 0 && d.data) {
      return { title: d.data.title, thumbnail: d.data.cover, duration: d.data.duration, formats: [{ url: `https://www.tikwm.com${d.data.hdplay}`, ext: 'mp4', resolution: 'HD (No Watermark)' }] };
    }
  } catch (_) {}
  return null;
}

// ── Route: POST /api/extract ─────────────────────────────────────────────────

async function handleExtract(request) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ status: 'error', message: 'Invalid JSON' }, 400); }
  const rawUrl = (body.url || '').trim();
  if (!rawUrl) return json({ status: 'error', message: 'Empty URL' }, 400);

  let targetUrl = rawUrl;
  try {
    const r = await fetch(rawUrl, { method: 'HEAD', headers: { 'User-Agent': STEALTH_UA }, redirect: 'follow', signal: AbortSignal.timeout(5000) });
    targetUrl = r.url || rawUrl;
  } catch (_) {}

  const videoId = getVideoId(targetUrl);
  let output = null;

  // 1. Instagram Specialized Ajax
  if (targetUrl.includes('instagram.com')) {
    output = await extractInstaAjax(targetUrl);
  }

  // 2. Platform specialized
  if (!output && isYT(targetUrl)) output = await extractPiped(videoId);
  if (!output && targetUrl.includes('tiktok.com')) output = await extractTikTok(targetUrl);

  // 3. Global cluster
  if (!output) output = await extractByCobalt(targetUrl);

  // 4. Mirror search fallback (YouTube)
  if (!output && videoId && videoId.length === 11) output = await extractPiped(videoId);

  if (!output || !output.formats?.length) {
    return json({ 
      status: 'error', 
      message: 'Extraction failed.', 
      debug: { targetUrl, scraper: 'v9_stealth' } 
    });
  }

  const { host, protocol } = new URL(request.url);
  const base = `${protocol}//${host}`;
  const sanitizedTitle = (output.title || 'media').slice(0, 50).replace(/[^a-z0-9]/gi, '_');

  const formats = output.formats.map((f, i) => ({
    quality: f.resolution,
    type: f.ext.toUpperCase(),
    url: `${base}/api/download?url=${encodeURIComponent(f.url)}&filename=${encodeURIComponent(sanitizedTitle + '.' + f.ext)}`,
    icon: 'fa-download', badge: 'HD'
  }));

  return json({ status: 'success', title: output.title, thumbnail: output.thumbnail, duration: formatDuration(output.duration), formats });
}

async function handleDownload(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  if (!url) return new Response('Missing URL', { status: 400, headers: CORS });
  try {
    const upstream = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://www.google.com/' }, redirect: 'follow', signal: AbortSignal.timeout(120000) });
    const headers = { ...CORS, 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${encodeURIComponent(searchParams.get('filename') || 'download')}"` };
    const cl = upstream.headers.get('content-length');
    if (cl) headers['Content-Length'] = cl;
    return new Response(upstream.body, { status: 200, headers });
  } catch (err) { return new Response('Relay failed', { status: 500, headers: CORS }); }
}

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (pathname === '/api/extract' && method === 'POST') return handleExtract(request);
    if (pathname === '/api/download' && method === 'GET') return handleDownload(request);
    return json({ status: 'ok', msg: 'Liquid V9' });
  },
};
