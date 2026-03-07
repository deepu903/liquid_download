const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const youtubedl = require('youtube-dl-exec');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: '*', // Allow all origins for development
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));
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

// Proxy download to bypass IP locks/CORS
app.get('/api/download', async (req, res) => {
    const { url, filename } = req.query;
    if (!url) return res.status(400).send('URL is required');

    try {
        console.log(`[PROXY] Starting stream for: ${filename}`);

        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Connection': 'keep-alive'
            },
            // Follow redirects automatically
            maxRedirects: 5
        });

        // Set attachment headers so it downloads instead of opening
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename || 'download')}"`);
        
        if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
        if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);

        response.data.pipe(res);

        response.data.on('error', (err) => {
            console.error('[STREAM ERROR]', err.message);
            if (!res.headersSent) res.status(500).send('Stream error');
        });

    } catch (error) {
        console.error('[PROXY ERROR]', error.message);
        if (error.response) {
            console.error('[PROXY ERROR DATA]', error.response.status);
        }
        res.status(500).send('Failed to stream file. This link might be IP-locked by the platform.');
    }
});

app.post('/api/extract', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ status: 'error', message: 'Please provide a valid URL' });
    }

    console.log(`[API] Extracting: ${url}`);

    try {
        let targetUrl = url;
        
        // Pinterest/Shortened links: follow redirects manually to get the clean direct link
        if (url.includes('t.co') || url.includes('bit.ly') || url.includes('pin.it') || url.includes('goo.gl')) {
            try {
                const resp = await axios.head(url, { 
                    maxRedirects: 5, 
                    timeout: 5000,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
                });
                const resolved = resp.request.res.responseUrl;
                if (resolved && !resolved.match(/^https?:\/\/[^\/]+\/?$/)) {
                    targetUrl = resolved;
                    console.log(`[API] Resolved redirect: ${targetUrl}`);
                }
            } catch (pingErr) {
                console.warn(`[API] Redirect ping failed: ${pingErr.message}`);
                // If HEAD fails, try a GET with manual redirect tracking
                try {
                    const resp = await axios.get(url, { maxRedirects: 5, timeout: 5000 });
                    targetUrl = resp.request.res.responseUrl || url;
                } catch(e) {}
            }
        }

        // Determine referer
        let referer = 'https://www.google.com/';
        if (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be')) referer = 'https://www.youtube.com/';
        else if (targetUrl.includes('instagram.com')) referer = 'https://www.instagram.com/';
        else if (targetUrl.includes('pinterest.com') || targetUrl.includes('pin.it')) referer = 'https://www.pinterest.com/';
        else if (targetUrl.includes('tiktok.com')) referer = 'https://www.tiktok.com/';
        else if (targetUrl.includes('facebook.com')) referer = 'https://www.facebook.com/';

        console.log(`[API] Using referer: ${referer}`);

        // Optimize for speed: only get metadata, no playlist, skip expensive checks
        const output = await youtubedl(targetUrl, {
            dumpSingleJson: true,
            noCheckCertificates: true,
            noWarnings: true,
            noPlaylist: true,
            skipDownload: true,
            quiet: true,
            addHeader: [
                `referer:${referer}`,
                'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'accept-language:en-US,en;q=0.9',
                'sec-ch-ua: "Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
                'sec-ch-ua-mobile:?0',
                'sec-ch-ua-platform: "Windows"'
            ]
        }).catch(async (err) => {
            // FALLBACK for Pinterest Mobile links if yt-dlp fails
            if (targetUrl.includes('pinterest.com') || targetUrl.includes('pin.it')) {
                console.log('[API] Attempting Pinterest scraping fallback...');
                try {
                    const htmlResponse = await axios.get(targetUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
                    });
                    const imgMatch = htmlResponse.data.match(/"contentUrl":"(https:\/\/i\.pinimg\.com\/originals\/[^"]+)"/) || 
                                     htmlResponse.data.match(/property="og:image" content="(https:\/\/i\.pinimg\.com\/originals\/[^"]+)"/);
                    
                    if (imgMatch && imgMatch[1]) {
                        return {
                            title: 'Pinterest Image',
                            url: imgMatch[1],
                            formats: [],
                            extractor: 'pinterest_fallback'
                        };
                    }
                } catch (scrapErr) {
                    console.error('[API] Scrape fallback failed:', scrapErr.message);
                }
            }
            console.error(`[YT-DLP ERROR] Full Error:`, err);
            throw err;
        });

        console.log(`[API] Successfully extracted: ${output.title}`);

        const formats = [];
        const seenUrls = new Set();

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
                        type: isVideo ? f.ext.toUpperCase() : 'Audio',
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
                }
                const sanitizedTitle = (output.title || 'media').substring(0, 50).replace(/[^a-z0-9]/gi, '_');
                return {
                    ...f,
                    url: `http://localhost:3000/api/download?url=${encodeURIComponent(f.url)}&filename=${encodeURIComponent(sanitizedTitle + '.' + ext)}`
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

app.listen(PORT, '127.0.0.1', () => {
    console.log(`
🚀 Liquid Media API is running!
📡 Local: http://127.0.0.1:${PORT}
🔧 Status: Healthy
    `);
});
