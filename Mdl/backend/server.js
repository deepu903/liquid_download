const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const ytDlExec = require('youtube-dl-exec');
let youtubedl = ytDlExec;
const axios = require('axios');
const { execSync, spawn } = require('child_process');
const { JSDOM } = require('jsdom');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// ── yt-dlp binary detection ──────────────────────────────────
const YTDLP_CANDIDATES = [
    'yt-dlp',
    path.join(__dirname, 'ytdlp-bin'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    process.env.YTDLP_PATH || ''
];

let ytdlpBin = null;
for (const c of YTDLP_CANDIDATES) {
    if (!c) continue;
    try { execSync(`test -x "${c}"`); ytdlpBin = c; break; } catch (_) {}
}
if (!ytdlpBin) {
    try { ytdlpBin = execSync('which yt-dlp 2>/dev/null').toString().trim() || null; } catch (_) {}
}
if (ytdlpBin) {
    console.log(`[STARTUP] ✅ yt-dlp found at: ${ytdlpBin}`);
    if (typeof ytDlExec.create === 'function') {
        youtubedl = ytDlExec.create(ytdlpBin);
    }
} else {
    console.error('[STARTUP] ❌ yt-dlp NOT found');
}

// ── CORS ─────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'Accept'] }));
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(helmet({ crossOriginResourcePolicy: false, crossOriginEmbedderPolicy: false }));
app.use(morgan('dev'));
app.use(express.json());

// ── Helpers ───────────────────────────────────────────────────
function formatBytes(bytes) {
    if (!bytes || bytes === 0) return 'N/A';
    const k = 1024, sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
function formatDuration(sec) {
    if (!sec) return '';
    const hrs = Math.floor(sec / 3600), mins = Math.floor((sec % 3600) / 60), secs = Math.floor(sec % 60);
    let r = '';
    if (hrs > 0) r += String(hrs).padStart(2, '0') + ':';
    return r + String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
}

// ── GET /api/download — Direct Relay Proxy ───────────────────
app.get('/api/download', async (req, res) => {
    const { url, filename } = req.query;
    if (!url) return res.status(400).send('URL is required');

    try {
        const commonUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
        const axiosOpts = {
            method: 'get', url, responseType: 'stream',
            timeout: 150000, maxContentLength: Infinity,
            headers: { 'User-Agent': commonUA, 'Accept': '*/*', 'Referer': 'https://www.google.com/', 'Connection': 'keep-alive' },
            maxRedirects: 15
        };
        if (process.env.YOUTUBE_COOKIES) axiosOpts.headers['Cookie'] = process.env.YOUTUBE_COOKIES;

        const response = await axios(axiosOpts);
        const finalFilename = filename || 'download';
        const contentType = response.headers['content-type'] || '';

        res.setHeader('Content-Type', contentType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(finalFilename)}"`);
        if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);

        console.log(`[PROXY] Streaming: ${finalFilename}`);
        response.data.pipe(res);
        response.data.on('error', (err) => { if (!res.headersSent) res.status(500).send('Source relay failed'); });
        res.on('close', () => { if (response.data?.destroy) response.data.destroy(); });
    } catch (error) {
        console.error('[PROXY]', error.message);
        if (!res.headersSent) res.status(500).send('Stream connection failed.');
    }
});

// ── GET /health ───────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.json({ status: 'ok', message: '🚀 Liquid Media API is running!' }));

// ── POST /api/extract ─────────────────────────────────────────
app.post('/api/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ status: 'error', message: 'Please provide a valid URL' });

    try {
        let targetUrl = url.trim();

        // Resolve redirects
        if (!targetUrl.includes('youtube.com') && !targetUrl.includes('youtu.be')) {
            try {
                const r = await axios.get(url, { maxRedirects: 5, timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } });
                targetUrl = r.request?.res?.responseUrl || url;
            } catch (e) {}
        }

        let referer = 'https://www.google.com/';
        if (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be')) referer = 'https://www.youtube.com/';
        else if (targetUrl.includes('instagram.com')) referer = 'https://www.instagram.com/';

        let output = null;
        let ytdlpErrorDetails = null;

        // ── STAGE 1: yt-dlp waterfall ─────────────────────────
        const ytdlpBaseOpts = {
            dumpSingleJson: true, noCheckCertificates: true, noPlaylist: true,
            skipDownload: true, quiet: true, rmCacheDir: true,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            addHeader: [
                'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language: en-US,en;q=0.9',
                'Referer: ' + referer,
            ],
        };

        const fs = require('fs'), os = require('os');
        if (process.env.YOUTUBE_COOKIES) {
            try {
                const cp = path.join(os.tmpdir(), 'yt-cookies.txt');
                fs.writeFileSync(cp, process.env.YOUTUBE_COOKIES);
                ytdlpBaseOpts.cookies = cp;
            } catch (e) {}
        }

        const isYouTube = targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be');
        const strategies = isYouTube
            ? [{ client: 'ios', label: 'ios' }, { client: 'tv_embedded', label: 'tv_embedded' }, { client: 'android', label: 'android' }, { client: 'tv', label: 'tv' }]
            : [{ client: null, label: 'default' }];

        for (const s of strategies) {
            try {
                const opts = { ...ytdlpBaseOpts, forceIpv4: true };
                if (s.client) opts.extractorArgs = `youtube:player_client=${s.client}`;
                output = await youtubedl(targetUrl, opts);
                if (output && (output.formats?.length > 0 || output.url)) break;
                output = null;
            } catch (e) {
                ytdlpErrorDetails = e.message;
                output = null;
                await new Promise(r => setTimeout(r, 1500));
            }
        }

        // ── STAGE 2: ytdl-core fallback ───────────────────────
        if (!output && isYouTube) {
            try {
                const ytdl = require('@distube/ytdl-core');
                const info = await ytdl.getInfo(targetUrl);
                if (info?.formats) {
                    output = {
                        title: info.videoDetails.title,
                        thumbnail: info.videoDetails.thumbnails[0]?.url,
                        duration: parseInt(info.videoDetails.lengthSeconds),
                        formats: info.formats.map(f => ({
                            format_id: f.itag, url: f.url,
                            ext: f.hasVideo ? 'mp4' : 'm4a',
                            vcodec: f.hasVideo ? 'h264' : 'none',
                            acodec: f.hasAudio ? 'aac' : 'none',
                            height: f.height || 0,
                            resolution: f.hasVideo ? (f.qualityLabel || '720p') : 'audio',
                            filesize: f.contentLength ? parseInt(f.contentLength) : null,
                        }))
                    };
                }
            } catch (e) { console.warn('[STAGE2]', e.message); }
        }

        // ── STAGE 3: Invidious fallback ───────────────────────
        if (!output && isYouTube) {
            const instances = ['invidious.jing.rocks', 'iv.melmac.space', 'yt.artemislena.eu', 'invidious.flokinet.to'];
            const vidId = targetUrl.includes('v=') ? targetUrl.split('v=')[1].split('&')[0] : targetUrl.split('/').pop();
            for (const host of instances) {
                try {
                    const r = await axios.get(`https://${host}/api/v1/videos/${vidId}?fields=title,formatStreams,adaptiveFormats,videoThumbnails,lengthSeconds`, { timeout: 5000 });
                    const d = r.data;
                    if (d?.title) {
                        const allFmts = [...(d.formatStreams || []), ...(d.adaptiveFormats || [])];
                        output = {
                            title: d.title,
                            thumbnail: d.videoThumbnails?.[0]?.url,
                            duration: d.lengthSeconds,
                            formats: allFmts.map(f => {
                                const audioOnly = f.vcodec === 'none' || f.type?.startsWith('audio/');
                                return {
                                    format_id: f.itag || 'audio', url: f.url,
                                    ext: audioOnly ? 'm4a' : 'mp4',
                                    vcodec: audioOnly ? 'none' : 'h264',
                                    acodec: 'aac',
                                    height: f.resolution ? parseInt(f.resolution) : 0,
                                    resolution: audioOnly ? 'audio' : (f.qualityLabel || f.quality || '720p'),
                                    filesize: f.contentLength ? parseInt(f.contentLength) : null,
                                };
                            })
                        };
                        break;
                    }
                } catch (e) {}
            }
        }

        // ── STAGE 4: Generic HTML scraper ─────────────────────
        if (!output && !isYouTube) {
            try {
                const r = await axios.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,*/*' }, timeout: 8000 });
                const dom = new JSDOM(r.data);
                const doc = dom.window.document;
                const srcs = [];
                doc.querySelectorAll('video, source').forEach(v => { if (v.src) srcs.push(v.src); });
                const metaVid = doc.querySelector('meta[property="og:video"]')?.content || doc.querySelector('meta[property="og:video:secure_url"]')?.content;
                if (metaVid) srcs.push(metaVid);
                if (srcs.length > 0) {
                    output = {
                        title: doc.title || 'Media',
                        thumbnail: doc.querySelector('meta[property="og:image"]')?.content,
                        formats: srcs.map((u, i) => ({
                            format_id: `src${i}`, url: u.startsWith('//') ? 'https:' + u : u,
                            ext: 'mp4', vcodec: 'h264', acodec: 'aac', height: 0, resolution: 'Original', filesize: null
                        }))
                    };
                }
            } catch (e) {}
        }

        if (!output) {
            return res.status(200).json({ status: 'error', message: 'No media found or extraction failed.', debug_error: ytdlpErrorDetails });
        }

        // ── Build response formats ────────────────────────────
        const formats = [];
        const seen = new Set();

        // Handle image/gallery entries
        if (output.entries) {
            output.entries.forEach((entry, i) => {
                const u = entry.url || entry.thumbnail;
                if (u && !seen.has(u)) {
                    seen.add(u);
                    const isVid = entry.vcodec !== 'none';
                    formats.push({ quality: isVid ? `Part ${i+1}` : `Photo ${i+1}`, type: isVid ? 'MP4' : 'Image', url: u, size: formatBytes(entry.filesize), icon: isVid ? 'fa-film' : 'fa-image', badge: isVid ? 'HQ' : 'Photo' });
                }
            });
        }

        // Handle formats
        if (output.formats?.length > 0) {
            const videos = output.formats.filter(f => f.vcodec !== 'none').sort((a, b) => (b.height||0) - (a.height||0));
            const audios = output.formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none');

            for (const f of videos) {
                if (seen.has(f.url) || formats.length >= 12) continue;
                const h = f.height || 0;
                let ql = h >= 2160 ? '4K' : h >= 1440 ? '1440p' : h >= 1080 ? '1080p' : h >= 720 ? '720p' : h >= 480 ? '480p' : h >= 360 ? '360p' : (f.resolution || 'Video');
                seen.add(f.url);
                formats.push({ quality: ql, type: (f.ext || 'mp4').toUpperCase(), url: f.url, size: formatBytes(f.filesize), icon: 'fa-film', badge: h >= 720 ? 'HQ' : '' });
            }

            // Best audio
            if (audios.length > 0) {
                const best = audios.find(f => f.ext === 'm4a') || audios[0];
                if (!seen.has(best.url)) {
                    seen.add(best.url);
                    formats.push({ quality: 'Audio Only', type: 'M4A', url: best.url, size: formatBytes(best.filesize), icon: 'fa-music', badge: 'Audio' });
                }
            }
        }

        // Fallback single URL
        if (formats.length === 0 && output.url) {
            formats.push({ quality: 'Original', type: (output.ext || 'Media').toUpperCase(), url: output.url, size: 'Direct', icon: 'fa-download', badge: 'Direct' });
        }

        // Proxy all URLs through /api/download
        const sanitizedTitle = (output.title || 'media').substring(0, 50).replace(/[^a-z0-9]/gi, '_');
        const host = req.get('host'), protocol = req.protocol;
        const proxied = formats.map(f => {
            let ext = (f.type || 'media').toLowerCase();
            if (ext === 'image') { const m = f.url.match(/\.(jpg|jpeg|png|webp|gif)/i); ext = m ? m[1] : 'jpg'; }
            return { ...f, url: `${protocol}://${host}/api/download?url=${encodeURIComponent(f.url)}&filename=${encodeURIComponent(sanitizedTitle + '.' + ext)}` };
        });

        return res.json({ status: 'success', title: output.title || 'Liquid Download', thumbnail: output.thumbnail || null, duration: formatDuration(output.duration), formats: proxied });

    } catch (error) {
        console.error('[API ERROR]', error.message);
        return res.status(500).json({ status: 'error', message: 'Failed to extract media.' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Liquid Media API running on port ${PORT}`);
});
