export default {
  async fetch(request, env) {
    const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const ytDlExec = require('youtube-dl-exec');
let youtubedl = ytDlExec; // Default fallback
const axios = require('axios');
const { execSync, spawn } = require('child_process');

const { JSDOM } = require('jsdom');

const app = express();
// Railway injects PORT dynamically — never hardcode it
const PORT = process.env.PORT || 8080;

// Verify yt-dlp binary exists at startup and bind it explicitly
const path = require('path');
const YTDLP_CANDIDATES = [
    'yt-dlp',                     // system path (installed via nix)
    path.join(__dirname, 'ytdlp-bin'), 
    '/usr/local/bin/yt-dlp',      
    '/usr/bin/yt-dlp',            
    process.env.YTDLP_PATH || ''  
];

let ytdlpBin = null;
for (const candidate of YTDLP_CANDIDATES) {
    if (!candidate) continue;
    try { execSync(`test -x "${candidate}"`); ytdlpBin = candidate; break; } catch (_) {}
}

// Fallback: try `which`
if (!ytdlpBin) {
    try { ytdlpBin = execSync('which yt-dlp 2>/dev/null').toString().trim() || null; } catch (_) {}
}

if (ytdlpBin) {
    console.log(`[STARTUP] ✅ yt-dlp found at: ${ytdlpBin}`);
    if (typeof ytDlExec.create === 'function') {
        youtubedl = ytDlExec.create(ytdlpBin);
        console.log('[STARTUP] ✅ youtube-dl-exec bound to system yt-dlp.');
    }
} else {
    console.error('[STARTUP] ❌ yt-dlp NOT found! PATH:', process.env.PATH);
}


// Middleware — explicit CORS for Railway + Vercel
const corsOptions = {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
    credentials: false,
};
app.use(cors(corsOptions));

// Manual CORS fallback headers (in case proxy strips them)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(helmet({
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
}));
app.use(morgan('dev')); // Logging
app.use(express.json());

// Log all incoming requests for debugging
app.use((req, res, next) => {
    console.log(`[DEBUG] ${req.method} ${req.url} - Origin: ${req.headers.origin}`);
    next();
});

// Helper to format bytes
function formatBytes(bytes) {
    if (bytes === 0 || !bytes) return 'N/A';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Helper to format seconds
function formatDuration(sec) {
    if (!sec) return '';
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = Math.floor(sec % 60);
    let res = "";
    if (hrs > 0) res += (hrs < 10 ? "0" + hrs : hrs) + ":";
    res += (mins < 10 ? "0" + mins : mins) + ":" + (secs < 10 ? "0" + secs : secs);
    return res;
}

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// Debug endpoint — shows yt-dlp binary status inside the Railway container
app.get('/api/debug', (req, res) => {
    let ytdlpVersion = null;
    let ytdlpWhich = null;
    try { ytdlpVersion = execSync(`${ytdlpBin || 'yt-dlp'} --version 2>/dev/null`).toString().trim(); } catch (_) {}
    try { ytdlpWhich = execSync('which yt-dlp 2>/dev/null || echo "not in PATH"').toString().trim(); } catch (_) {}
    res.json({
        ytdlpBin,
        ytdlpVersion,
        ytdlpWhich,
        path: process.env.PATH,
        node: process.version,
        platform: process.platform,
    });
});


// Proxy download
app.get('/api/download', async (req, res) => {
    const { url, filename } = req.query;
    if (!url) return res.status(400).send('URL is required');

    try {
        console.log(`[PROXY] Starting relay for: ${filename}`);

        const commonUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
        const axiosOpts = {
            method: 'get',
            url: url,
            responseType: 'stream',
            timeout: 150000,
            maxContentLength: Infinity,
            headers: {
                'User-Agent': commonUserAgent,
                'Accept': '*/*',
                'Referer': 'https://www.google.com/',
                'Connection': 'keep-alive'
            },
            maxRedirects: 15
        };

        if (process.env.YOUTUBE_COOKIES) {
            axiosOpts.headers['Cookie'] = process.env.YOUTUBE_COOKIES;
        }

        const response = await axios(axiosOpts);
        const finalFilename = filename || 'download';
        const contentType = response.headers['content-type'] || '';
        
        // --- High-Reliability Direct Relay ---
        // Delivers the original, perfect-quality source file exactly as provided by the platform
        res.setHeader('Content-Type', contentType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(finalFilename)}"`);
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }

        console.log(`[PROXY] Streaming original stream: ${finalFilename}`);
        response.data.pipe(res);

        response.data.on('error', (err) => {
            console.error('[PROXY] Stream Error:', err.message);
            if (!res.headersSent) res.status(500).send('Source relay failure');
        });

        res.on('close', () => {
            if (response.data && response.data.destroy) response.data.destroy();
        });

        res.on('close', () => {
            if (response.data && response.data.destroy) response.data.destroy();
        });

        return;

    } catch (error) {
        console.error('[PROXY CRITICAL]', error.message);
        if (!res.headersSent) res.status(500).send('Stream connection failed.');
    }
});

app.post('/api/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ status: 'error', message: 'Please provide a valid URL' });

    console.log(`[API] Extracting: ${url}`);

    try {
        let targetUrl = url;
        
        // Manual Redirect Handling (Pinterest/Shortened)
        if (url.match(/pin\.it|t\.co|bit\.ly|goo\.gl|tinyurl/)) {
            try {
                const resp = await axios.get(url, { 
                    maxRedirects: 5, 
                    timeout: 5000,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
                });
                targetUrl = resp.request.res.responseUrl || url;
                console.log(`[API] Resolved URL: ${targetUrl}`);
            } catch (e) { console.warn('[API] Redirect failed, using original'); }
        }

        // Determine referer
        let referer = 'https://www.google.com/';
        if (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be')) referer = 'https://www.youtube.com/';
        else if (targetUrl.includes('instagram.com')) referer = 'https://www.instagram.com/';
        else if (targetUrl.includes('tiktok.com')) referer = 'https://www.tiktok.com/';

        // -- STAGE 1: yt-dlp waterfall (multiple client strategies) --
        let output = null;
        let ytdlpErrorDetails = null;

        // Strategy A: Advanced bot block bypass tree (IPv6 & Cookies)
        // Hardened options to mimic a real human browser and bypass bot detection
        const ytdlpBaseOpts = {
            dumpSingleJson: true,
            noCheckCertificates: true,
            noPlaylist: true,
            skipDownload: true,
            quiet: true,
            rmCacheDir: true,
            // Mimic a fresh 2024 browser session — crucial for bypassing "Sign in" walls
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            addHeader: [
                'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language: en-US,en;q=0.9',
                'Sec-Ch-Ua: "Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
                'Sec-Ch-Ua-Mobile: ?0',
                'Sec-Ch-Ua-Platform: "Windows"',
                'Referer: https://www.youtube.com/',
            ],
        };

        const fs = require('fs');
        const os = require('os');
        
        // Use cookies if provided via Railway environment or a local file
        if (process.env.YOUTUBE_COOKIES) {
            try {
                const cookiePath = path.join(os.tmpdir(), 'yt-cookies.txt');
                fs.writeFileSync(cookiePath, process.env.YOUTUBE_COOKIES);
                ytdlpBaseOpts.cookies = cookiePath;
            } catch (e) {}
        }

        const isYoutubeLink = targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be');

        // Waterfall to try specialized clients sequentially
        const ytStrategies = isYoutubeLink ? [
            { client: 'ios',         label: 'ios (Robo-Bypass)', forceIpv4: true },
            { client: 'tv_embedded', label: 'tv_embedded (Formats)', forceIpv4: true },
            { client: 'android',     label: 'android (Robust)',   forceIpv4: true },
            { client: 'tv',          label: 'tv (Fallback)',      forceIpv4: true }
        ] : [
            { client: null, label: 'default', forceIpv4: true }
        ];

        for (const strategy of ytStrategies) {
            try {
                console.log(`[EXTRACT-1] Mimicking Browser - Trying client: ${strategy.label}...`);
                const options = { ...ytdlpBaseOpts };
                if (strategy.forceIpv4) options.forceIpv4 = true;
                if (strategy.client) options.extractorArgs = `youtube:player_client=${strategy.client}`;
                
                output = await youtubedl(targetUrl, options);
                const hasFormats = output && (output.formats?.length > 0 || output.url);
                if (hasFormats) {
                    console.log(`[EXTRACT-1] ✅ Success with ${strategy.label}`);
                    break;
                }
                console.warn(`[EXTRACT-1] No formats from ${strategy.label}, trying next...`);
                output = null;
            } catch (ytErr) {
                const errMsg = ytErr.message?.split('\n')[0];
                console.warn(`[EXTRACT-1] ${strategy.label} failed: ${errMsg}`);
                ytdlpErrorDetails = ytErr.message;
                
                // Keep trying other clients even if one says "Sign in"
                output = null;
                
                // Add a small delay to avoid triggering 429 after a failure
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        // -- STAGE 2: Hardened Fallback for YouTube (ytdl-core) --
        const isYouTube = targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be');
        if (!output && isYouTube) {
            console.log('[EXTRACT-2] 🛡️ yt-dlp blocked. Trying ytdl-core fallback...');
            try {
                const ytdl = require('@distube/ytdl-core');
                const info = await ytdl.getInfo(targetUrl);
                if (info && info.formats) {
                    console.log('[EXTRACT-2] ✅ Success with ytdl-core');
                    output = {
                        title: info.videoDetails.title,
                        thumbnail: info.videoDetails.thumbnails[0]?.url,
                        duration_string: info.videoDetails.lengthSeconds + 's',
                        webpage_url: info.videoDetails.video_url,
                        uploader: info.videoDetails.author.name,
                        formats: info.formats.map(f => ({
                            format_id: f.itag,
                            url: f.url,
                            ext: f.container || (f.mimeType ? f.mimeType.split('/')[1].split(';')[0] : 'mp4'),
                            vcodec: f.hasVideo ? 'h264' : 'none',
                            acodec: f.hasAudio ? 'aac' : 'none',
                            resolution: f.qualityLabel || 'audio',
                            filesize: f.contentLength ? parseInt(f.contentLength) : null
                        }))
                    };
                }
            } catch (ytdlErr) {
                console.warn('[EXTRACT-2] ytdl-core also failed:', ytdlErr.message);
            }
        }

        // -- STAGE 3: Global Hub Fallback (Invidious API) --
        if (!output && isYouTube) {
            console.log('[EXTRACT-3] 🌐 Engine 1 & 2 failed. Attempting Global Hub fallback...');
            const instances = [
                'invidious.jing.rocks',
                'iv.melmac.space',
                'yt.artemislena.eu',
                'invidious.flokinet.to'
            ];
            
            const videoId = targetUrl.includes('v=') ? targetUrl.split('v=')[1].split('&')[0] : targetUrl.split('/').pop();
            
            for (const instance of instances) {
                try {
                    console.log(`[EXTRACT-3] Trying Instance: ${instance}`);
                    const invRes = await axios.get(`https://${instance}/api/v1/videos/${videoId}?fields=title,formatStreams,adaptiveFormats,videoThumbnails,author,lengthSeconds`, { timeout: 4000 });
                    const data = invRes.data;
                    if (data && data.title) {
                        console.log(`[EXTRACT-3] ✅ Success with ${instance}`);
                        const allFormats = [...(data.formatStreams || []), ...(data.adaptiveFormats || [])];
                        output = {
                            title: data.title,
                            thumbnail: data.videoThumbnails?.find(t => t.quality === 'maxresdefault' || t.quality === 'hqdefault')?.url,
                            duration_string: data.lengthSeconds + 's',
                            webpage_url: `https://youtube.com/watch?v=${videoId}`,
                            uploader: data.author,
                            formats: allFormats.map(f => {
                            // Strictly determine if this is an audio-only stream
                            const isAudioOnly = (f.type?.startsWith('audio/')) || (f.vcodec === 'none');
                            return {
                                format_id: f.itag || f.quality,
                                url: f.url,
                                ext: f.container || (f.type ? f.type.split('/')[1].split(';')[0] : 'mp4'),
                                vcodec: isAudioOnly ? 'none' : (f.vcodec || 'h264'),
                                acodec: f.acodec || (f.type?.includes('audio') ? 'aac' : 'none'),
                                resolution: isAudioOnly ? 'audio' : (f.qualityLabel || f.quality || '720p'),
                                filesize: f.contentLength ? parseInt(f.contentLength) : null
                            };
                        })
                        };
                        break; // Stop at first working instance
                    }
                } catch (e) {
                    console.warn(`[EXTRACT-3] ${instance} failed:`, e.message);
                }
            }
        }

        // -- STAGE 4: Generic Scraper Fallback --
        const hasData = output && (output.formats?.length > 0 || output.entries?.length > 0 || output.url);
        
        // Skip generic fallback for YouTube as it provides useless open-graph metadata (fake 1 format)
        if (!hasData && !isYouTube) {
            console.log('[EXTRACT-2] Using Generic HTML Scraper...');
            try {
                const htmlResponse = await axios.get(targetUrl, {
                    headers: { 
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
                    },
                    timeout: 10000
                });

                const dom = new JSDOM(htmlResponse.data);
                const doc = dom.window.document;
                const sources = [];

                // Find <video> tags
                doc.querySelectorAll('video').forEach(v => {
                    const src = v.src || v.querySelector('source')?.src;
                    if (src) sources.push({ url: src, type: 'video' });
                });

                // Find Meta tags
                const metaVid = doc.querySelector('meta[property="og:video"]')?.content || 
                               doc.querySelector('meta[property="og:video:secure_url"]')?.content;
                if (metaVid) sources.push({ url: metaVid, type: 'video' });

                // Find iframes
                doc.querySelectorAll('iframe').forEach(ifr => {
                    if (ifr.src?.match(/youtube|vimeo|dailymotion/)) sources.push({ url: ifr.src, type: 'embed' });
                });

                if (sources.length > 0) {
                    output = {
                        title: doc.title || 'Extracted Media',
                        url: targetUrl,
                        extractor: 'generic',
                        thumbnail: doc.querySelector('meta[property="og:image"]')?.content,
                        formats: sources.map((s, i) => ({
                            url: s.url.startsWith('//') ? 'https:' + s.url : (s.url.startsWith('/') ? new URL(s.url, targetUrl).href : s.url),
                            ext: s.type === 'video' ? 'mp4' : 'link',
                            format_note: `Source ${i+1}`,
                            vcodec: s.type === 'video' ? 'h264' : 'none',
                            acodec: s.type === 'video' ? 'aac' : 'none'
                        }))
                    };
                }
            } catch (scrapErr) {
                console.error('[EXTRACT-2] Failed:', scrapErr.message);
            }
        }

        if (!output) {
            // Return 200 status even on "extraction failure" so the frontend can read the JSON error body
            // instead of jumping to the catch/error block in Angular.
            return res.status(200).json({ status: 'error', message: 'No media found or extraction failed. The site might be protected or link might be private.', debug_error: ytdlpErrorDetails });
        }

        const formats = [];
        const seenUrls = new Set();

        // Process formats/entries...

        // 1. Initial Check: If no entries/formats, but we have a url, check if it's an image
        if (!output.formats?.length && !output.entries?.length && output.url) {
            const isImg = output.url.match(/\.(jpg|jpeg|png|webp|gif|avif)/i) || output.extractor?.includes('pinterest');
            if (isImg) {
                formats.push({
                    quality: 'Original HQ',
                    type: 'Image',
                    url: output.url,
                    size: 'Best',
                    icon: 'fa-image',
                    badge: 'Photo'
                });
                seenUrls.add(output.url);
            }
        }

        // 2. Pinterest/Instagram Specific (Often returns image urls in thumbnails)
        if (targetUrl.includes('pinterest.com') || targetUrl.includes('pin.it') || targetUrl.includes('instagram.com')) {
            const thumbs = output.thumbnails?.sort((a,b) => (b.width||0) - (a.width||0)) || [];
            const bestThumb = thumbs[0]?.url;
            if (bestThumb && !seenUrls.has(bestThumb)) {
                formats.push({
                    quality: 'Original HD',
                    type: 'Image',
                    url: bestThumb,
                    size: 'High Res',
                    icon: 'fa-image',
                    badge: 'Photo'
                });
                seenUrls.add(bestThumb);
            }
        }

        // 3. Handle Multi-item (Carousels/Galleries)
        if (output.entries) {
             output.entries.forEach((entry, idx) => {
                 const bestUrl = entry.url || entry.thumbnails?.[0]?.url || entry.thumbnail;
                 if (bestUrl && !seenUrls.has(bestUrl)) {
                    seenUrls.add(bestUrl);
                    const isVideo = entry.vcodec !== 'none' && entry.ext !== 'jpg' && entry.ext !== 'png' && entry.ext !== 'webp' && entry.ext !== 'jpeg';
                    formats.push({
                        quality: entry.ext ? entry.ext.toUpperCase() : (isVideo ? `Part ${idx+1}` : `Photo ${idx+1}`),
                        type: isVideo ? 'Video' : 'Image',
                        url: bestUrl,
                        size: formatBytes(entry.filesize || entry.filesize_approx),
                        icon: isVideo ? 'fa-film' : 'fa-image',
                        badge: isVideo ? `Part ${idx+1}` : `Photo ${idx+1}`
                    });
                 }
             });
        } 
        
        // 4. Handle Formats (Videos/Audios)
        if (output.formats && output.formats.length > 0) {
            const filteredFormats = output.formats.filter(f => !f.format_note?.includes('fragment'));
            const sortedFormats = filteredFormats.sort((a, b) => (b.height || 0) - (a.height || 0));

            for (const f of sortedFormats) {
                const height = f.height || 0;
                const isVideo = f.vcodec !== 'none';
                const isAudio = f.acodec !== 'none';
                
                let qualityLabel = '';
                if (height >= 2160) qualityLabel = '4K';
                else if (height >= 1440) qualityLabel = '1440p';
                else if (height >= 1080) qualityLabel = '1080p';
                else if (height >= 720) qualityLabel = '720p';
                else if (height >= 480) qualityLabel = '480p';
                else if (isVideo) qualityLabel = (height || 'Original') + 'p';
                else if (isAudio) qualityLabel = (f.abr || f.tbr || 'High') + 'k';

                if (qualityLabel && !seenUrls.has(f.url) && formats.length < 20) {
                    seenUrls.add(f.url);
                    formats.push({
                        quality: qualityLabel + (isVideo && !isAudio ? ' [No Audio]' : ''),
                        type: isVideo ? f.ext.toUpperCase() : 'MP3',
                        url: f.url,
                        size: formatBytes(f.filesize || f.filesize_approx),
                        icon: isVideo ? (isAudio ? 'fa-film' : 'fa-video-slash') : 'fa-music',
                        badge: height >= 720 ? 'HQ' : (isAudio ? 'Audio' : '')
                    });
                }
            }
        }

        // 5. Final Fallback (If still empty, take thumbnail or url)
        if (formats.length === 0) {
            const finalUrl = output.url || output.thumbnail;
            if (finalUrl) {
                formats.push({
                    quality: 'Original',
                    type: (output.ext || 'Media').toUpperCase(),
                    url: finalUrl,
                    size: 'Direct',
                    icon: 'fa-download',
                    badge: 'Direct'
                });
            }
        }

        // 6. Explicit Audio Option Injection (MP3/M4A)
        // Guarantee an Audio format exists for the user
        const hasAudioOption = formats.some(f => f.type.toLowerCase().includes('audio'));
        if (!hasAudioOption && formats.length > 0) {
            let targetUrl = formats[0].url;
            let audioExt = 'm4a';

            if (output.formats?.length > 0) {
                // Find pure audio-only formats (vcodec=none) as they are the only ones that work for .mp3 target
                const pureAudios = output.formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none');
                if (pureAudios.length > 0) {
                    const bestAudio = pureAudios.find(f => f.ext === 'm4a') || pureAudios[0];
                    targetUrl = bestAudio.url;
                    audioExt = bestAudio.ext;
                }
            }
            
            formats.push({
                quality: 'High (MP3)',
                type: 'MP3',
                url: targetUrl,
                size: 'Audio',
                icon: 'fa-music',
                badge: 'Audio'
            });
        }

        const responsePayload = {
            status: 'success',
            title: output.title || 'Liquid Download',
            thumbnail: output.thumbnail || null,
            duration: formatDuration(output.duration),
            formats: formats.map(f => {
                let ext = (f.type || 'media').toLowerCase();
                if (ext === 'image') {
                    const match = f.url.match(/\.(jpg|jpeg|png|webp|gif)/i);
                    ext = match ? match[1] : 'jpg';
                } else if (ext === 'audio') {
                    ext = 'm4a'; // Muxed mp4 audio natively plays correctly as m4a
                }
                const sanitizedTitle = (output.title || 'media').substring(0, 50).replace(/[^a-z0-9]/gi, '_');
                const host = req.get('host');
                const protocol = req.protocol;
                return {
                    ...f,
                    url: `${protocol}://${host}/api/download?url=${encodeURIComponent(f.url)}&filename=${encodeURIComponent(sanitizedTitle + '.' + ext)}`
                };
            })
        };

        console.log(`[API] Sending ${responsePayload.formats.length} formats to frontend`);
        return res.json(responsePayload);

    } catch (error) {
        console.error('[API ERROR]', error.message);
        return res.status(500).json({ 
            status: 'error', 
            message: 'Failed to extract media. This can happen due to platform restrictions or an invalid link.' 
        });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 Liquid Media API is running!
📡 Listening on: 0.0.0.0:${PORT}
🌍 Railway PORT env: ${process.env.PORT || 'not set (using 8080)'}
🔧 Status: Healthy
    `);
});
    return new Response("Backend is working!");
  }
};
