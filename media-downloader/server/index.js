const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const ytdlp = require('yt-dlp-exec');
const ffmpeg = require('ffmpeg-static');
const { spawn } = require('child_process');

// Helpers
const isImage = (ext) => ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext?.toLowerCase());

const app = express();
const port = 3002;

app.use(cors());
app.use(express.json());

// Path to the yt-dlp binary inside node_modules
const ytdlpPath = path.resolve(__dirname, 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp.exe');
console.log('Using yt-dlp binary at:', ytdlpPath);
console.log('Using ffmpeg binary at:', ffmpeg);

app.get('/download', async (req, res) => {
  const { url, filename, formatId } = req.query;

  if (!url) {
    console.error('Download error: No URL provided');
    return res.status(400).send('URL is required');
  }

  console.log(`\n>>> FFMPEG MERGE DOWNLOAD START <<<`);
  console.log(`- Target URL: ${url.substring(0, 50)}...`);
  console.log(`- Format ID: ${formatId || 'best'}`);
  
  try {
    const skipYtdlp = url.includes('scontent') || url.match(/\.(jpg|jpeg|png|webp|gif|mp4|mp3|m4a|webm)($|\?)/i);
    let videoUrl = url;
    let audioUrl = null;

    if (skipYtdlp) {
      console.log("- Direct media URL detected or scontent link, skipping re-extraction.");
    } else {
      // 1. Get raw info to find specific URLs for video and audio
      console.log(`- Fetching stream URLs for format ${formatId || 'best'}...`);
      
      let info;
      try {
        info = await ytdlp(url, {
          dumpSingleJson: true,
          noWarnings: true,
          format: formatId ? `${formatId}+bestaudio/best` : 'best',
          addHeader: [
            'referer:instagram.com',
            'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
          ],
          noCheckCertificate: true,
          preferFreeFormats: true
        });
      } catch (innerErr) {
        if (url.includes('instagram.com')) {
          console.log("- YT-DLP failed in download, trying internal scraper...");
          const scraped = await scrapeInstagramImage(url);
          if (scraped && scraped.formats && scraped.formats.length > 0) {
            // Find the format that matches formatId or first
            const fmt = scraped.formats.find(f => f.id === formatId) || scraped.formats[0];
            videoUrl = fmt ? fmt.url : null;
          } else {
            throw innerErr;
          }
        } else {
          throw innerErr;
        }
      }

      if (info) {
        // Correctly resolve the stream URL depending on if it's from scraper or yt-dlp
        if (info.platform === 'Instagram' && !info.requested_formats) {
          // Likely from our custom scraper or an image post
          const fmt = (info.formats && info.formats.length > 0) ? (info.formats.find(f => f.id === formatId) || info.formats[0]) : null;
          videoUrl = fmt ? fmt.url : (info.url || null);
        } else {
          // Likely from yt-dlp. Be careful: yt-dlp info.url is the stream. webpage_url is the page.
          // BUT some extractors put the page in info.url.
          const candidate = info.requested_formats ? info.requested_formats[0].url : (info.url || (info.formats && info.formats[0] ? info.formats[0].url : null));
          
          // If the candidate looks like the original page URL, avoid it.
          if (candidate && (candidate === url || candidate.includes('instagram.com/p/') || candidate.includes('instagram.com/reels/'))) {
             videoUrl = (info.formats && info.formats[0]) ? info.formats[0].url : candidate;
          } else {
             videoUrl = candidate;
          }
          
          audioUrl = info.requested_formats && info.requested_formats[1] ? info.requested_formats[1].url : null;
        }
      }
    }

    if (!videoUrl) throw new Error('Source stream URL missing');

    // Set headers for download
    const ext = path.extname(filename || 'download.mp4').toLowerCase();
    let contentType = 'video/mp4';
    if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
    else if (ext === '.png') contentType = 'image/png';
    else if (ext === '.webp') contentType = 'image/webp';
    else if (ext === '.mp3') contentType = 'audio/mpeg';

    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'download.mp4'}"`);
    res.setHeader('Content-Type', contentType);

    // Use Axios to check the real content-type if possible, or trust our mapper
    try {
      if (!audioUrl) {
        // Just proxy the single video/audio/image stream
        console.log(`- No merging needed, proxying single stream...`);
        
        const axiosOptions = { 
          method: 'get', 
          url: videoUrl, 
          responseType: 'stream',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
          }
        };
        
        const response = await axios(axiosOptions);
        
        // Use the real content-type from the source if we're just proxying
        const realContentType = response.headers['content-type'] || contentType;
        res.setHeader('Content-Type', realContentType);
        
        // Adjust filename if the content-type is an image but filename said mp4
        let finalFilename = filename || 'download.mp4';
        if (realContentType.includes('image') && finalFilename.endsWith('.mp4')) {
            finalFilename = finalFilename.replace('.mp4', '.jpg');
            res.setHeader('Content-Disposition', `attachment; filename="${finalFilename}"`);
        }

        response.data.pipe(res);
        return;
      }
    } catch (proxyError) {
      console.error('- Proxying attempt failed:', proxyError.message);
      // Fall through to see if ffmpeg might have worked (though unlikely without videoUrl) or just let main catch handle it
    }

    // 2. Perform on-the-fly merging via FFmpeg
    console.log('- Merging Video + Audio on-the-fly via FFmpeg...');
    const ffmpegProcess = spawn(ffmpeg, [
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', videoUrl,
      '-i', audioUrl,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov',
      'pipe:1'
    ]);

    ffmpegProcess.stdout.pipe(res);

    ffmpegProcess.stderr.on('data', (data) => {
      // Log FFmpeg status briefly
      if (data.toString().includes('frame=')) {
        process.stdout.write('.');
      }
    });

    ffmpegProcess.on('close', (code) => {
      console.log(`\n- FFmpeg process finished with code ${code}`);
      if (code === 0) console.log('>>> DOWNLOAD SUCCESSFUL <<<');
    });

    req.on('close', () => {
      console.log('- User connection closed. Killing FFmpeg...');
      ffmpegProcess.kill();
    });

  } catch (error) {
    console.error('!!! DOWNLOAD FATAL ERROR !!!', error.message);
    if (!res.headersSent) {
      res.status(500).send(`Merging error: ${error.message}`);
    }
  }
});

app.get('/', (req, res) => {
  res.send('Media Downloader Backend is LIVE');
});

// Specialized Instagram Image Scraper Fallback
const scrapeInstagramImage = async (igUrl) => {
  console.log('- Attempting mobile scraper for Instagram image...');
  try {
    const resp = await axios.get(igUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 10000
    });

    const html = resp.data;
    const ogImg = (html.match(/property="og:image"\s+content="([^"]+)"/i) || [])[1];
    const ogVideo = (html.match(/property="og:video"\s+content="([^"]+)"/i) || [])[1];
    const ogType = (html.match(/property="og:type"\s+content="([^"]+)"/i) || [])[1];
    const ogTitle = (html.match(/property="og:title"\s+content="([^"]+)"/i) || [])[1];
    const ogDesc = (html.match(/property="og:description"\s+content="([^"]+)"/i) || [])[1];

    // Aggressive pattern matching for video URLs in JSON-like strings
    const videoUrlPattern = /"video_url":"([^"]+)"/g;
    let match;
    let foundVideoUrl = null;
    while ((match = videoUrlPattern.exec(html)) !== null) {
      const url = match[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
      if (url.includes('scontent') && (url.includes('.mp4') || url.includes('_n.mp4'))) {
        foundVideoUrl = url;
        break; // Take the first valid scontent video URL
      }
    }

    const cleanImgUrl = (ogImg || '').replace(/&amp;/g, '&');
    const cleanVideoUrl = (ogVideo || foundVideoUrl || (html.match(/https?:\/\/[^/]*scontent[^"> \s]*\.mp4[^"> \s]*/g) || [])[0] || '').replace(/&amp;/g, '&');
    
    // Check if it's a video based on type, link format, or if we found a video URL
    let isVideo = ogType === 'video' || !!cleanVideoUrl || igUrl.includes('/reel/') || igUrl.includes('/reels/') || igUrl.includes('/tv/');

    console.log(`- Scraper detected: ${isVideo ? 'VIDEO' : 'IMAGE'}`);
    if (isVideo && !cleanVideoUrl) {
      console.warn('- Detected as video but no stream found. Metadata might be hidden.');
    }

    if (isVideo && cleanVideoUrl) {
      return {
        title: (ogTitle || 'Instagram Video').split('|')[0].trim(),
        description: ogDesc || '',
        thumbnail: cleanImgUrl,
        duration: 'Video',
        platform: 'Instagram',
        ext: 'mp4',
        url: cleanVideoUrl,
        webpage_url: igUrl,
        formats: [{
          id: 'best',
          ext: 'mp4',
          resolution: 'Original',
          qualityLabel: 'Original Video (MP4)',
          url: cleanVideoUrl,
          hasAudio: true,
          hasVideo: true,
          priority: 25
        }]
      };
    }

    if (!cleanImgUrl) throw new Error('No media metadata found in page');

    // Simple carousel detection for images
    const additionalImages = html.match(/https?:\/\/[^/]*scontent[^"> \s]+\.jpg[^"> \s]*/g) || [];
    const uniqueImages = Array.from(new Set(additionalImages.map(u => u.replace(/&amp;/g, '&'))))
      .filter(u => u !== cleanImgUrl)
      .slice(0, 10);

    const formats = [{
      id: 'original',
      ext: 'jpg',
      resolution: 'Original',
      qualityLabel: 'Original Photo (Image)',
      url: cleanImgUrl,
      hasAudio: false,
      hasVideo: false,
      priority: 15
    }];

    uniqueImages.forEach((u, i) => {
      formats.push({
        id: `slide-${i + 1}`,
        ext: 'jpg',
        resolution: 'Carousel Slide',
        qualityLabel: `Slide ${i + 2} (Image)`,
        url: u,
        hasAudio: false,
        hasVideo: false,
        priority: 14 - i
      });
    });

    return {
      title: (ogTitle || 'Instagram Photo').split('|')[0].trim(),
      description: ogDesc || '',
      thumbnail: cleanImgUrl,
      duration: 'Photo',
      platform: 'Instagram',
      ext: 'jpg', // ENSURE UI SEES JPG
      url: cleanImgUrl, // DIRECT MEDIA URL
      webpage_url: igUrl, // Original link
      formats: formats
    };
  } catch (err) {
    console.error('- Mobile scraper failed:', err.message);
    return null;
  }
};

app.post('/extract', async (req, res) => {
  const { url } = req.body;
  console.log(`\n>>> EXTRACTION REQUEST START <<<`);
  console.log(`- Target URL: ${url}`);

  if (!url) {
    console.error('Extraction error: No URL provided');
    return res.status(400).json({ error: 'URL is required' });
  }

  // Quick check for direct image links
  if (url.match(/\.(jpg|jpeg|png|webp|gif)($|\?)/i)) {
    console.log('- Direct Image URL detected, skipping yt-dlp...');
    return res.json({
      title: 'Direct Image',
      thumbnail: url,
      duration: 'Photo',
      platform: 'Direct',
      url: url,
      formats: [{
        id: 'original',
        ext: path.extname(url).slice(1).split('?')[0] || 'jpg',
        resolution: 'Original',
        qualityLabel: 'Original Photo (Image)',
        url: url,
        hasAudio: false,
        hasVideo: false
      }]
    });
  }


  try {
    console.log('- Spawning yt-dlp process...');
    
    let info;
    try {
      info = await ytdlp(url, {
        dumpSingleJson: true,
        noWarnings: true,
        preferFreeFormats: true,
        allowUnplayableFormats: true,
        noPlaylist: true,
        extractFlat: true,
        addHeader: [
          'referer:instagram.com',
          'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
          'accept-language:en-US,en;q=0.9'
        ],
        noCheckCertificate: true,
        geoByPass: true,
        youtubeSkipDashManifest: true
      });
    } catch (firstError) {
      const isInstagram = url.includes('instagram.com');
      const isPotentialVideo = url.includes('/reel/') || url.includes('/tv/') || url.includes('youtube.com') || url.includes('twitter.com') || url.includes('x.com');

      console.warn(`- Primary extraction failed. Instagram: ${isInstagram}, Video Probable: ${isPotentialVideo}`);
      
      // Try specialized scraper first if it's Instagram
      if (isInstagram) {
          info = await scrapeInstagramImage(url);
          // If the scraper surprisingly found a video or we are sure it's a video but scraper only found thumbnail,
          // we might want to try ytdlp one more time with a different approach
          if (info && info.duration === 'Photo' && isPotentialVideo) {
              console.log('- Scraper only found Photo for a potential video. Retrying YT-DLP...');
              info = null; 
          }
      }
      
      // If scraper didn't work, not Instagram, or we strictly need to find the video stream
      if (!info) {
          console.log('- Falling back to secondary ytdlp attempt with simplified headers...');
          try {
            info = await ytdlp(url, {
              dumpSingleJson: true,
              noWarnings: true,
              ignoreErrors: true,
              addHeader: [ 
                'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36' 
              ],
              noCheckCertificate: true
            });
          } catch (secondError) {
            console.error('- All extraction attempts failed.');
          }
      }
    }

    if (!info || (!info.url && !info.formats && !info.entries)) {
      // Fallback for Instagram images specifically
      if (url.includes('instagram.com')) {
        const scraperInfo = await scrapeInstagramImage(url);
        if (scraperInfo) {
          console.log(`- Scraper success: "${scraperInfo.title}"`);
          return res.json(scraperInfo);
        }
      }
      throw new Error('YT-DLP found no media content');
    }

    console.log(`- Extraction successful: "${info.title || 'Untitled'}"`);
    console.log(`- Formats found: ${info.formats ? info.formats.length : 0}`);

    const allFormats = (info.formats || []);
    // A format is a video if vcodec isn't none OR it has a non-image extension
    let hasAnyVideo = allFormats.some(f => {
      const ext = f.ext || (f.url ? path.extname(f.url).slice(1).split('?')[0] : '');
      return (f.vcodec && f.vcodec !== 'none') || (ext && !isImage(ext));
    });
    
    const isInstagram = url.includes('instagram.com');
    const mediaExt = info.ext || (info.url ? path.extname(info.url).slice(1).split('?')[0] : '');

    // FORCE Scraper retry if it's Instagram but no video formats found
    // This handles reels/videos that yt-dlp identifies as static images initially
    if (isInstagram && !hasAnyVideo) {
      console.log('- Instagram link with no formats found. Retrying with mobile scraper...');
      const scrapedResult = await scrapeInstagramImage(url);
      if (scrapedResult && scrapedResult.duration === 'Video') {
           console.log('- Scraper found the hidden Video! Returning.');
           return res.json(scrapedResult);
      }
    }

    const currentlyImage = isImage(mediaExt) && !hasAnyVideo;

    console.log(`- Detection: Ext=${mediaExt}, isImage=${isImage(mediaExt)}, hasVideo=${hasAnyVideo} => currentlyImage=${currentlyImage}`);
    
    // 0. Static Images
    let images = allFormats
      .filter(f => (f.ext === 'jpg' || f.ext === 'png' || f.ext === 'webp' || f.vcodec === 'none' && f.acodec === 'none' && !f.abr))
      .map(f => ({
        id: f.format_id,
        ext: f.ext,
        resolution: f.resolution || `${f.width}x${f.height}`,
        qualityLabel: (f.format_note || 'High Quality') + ' (Image)',
        url: f.url,
        filesize: f.filesize || f.filesize_approx,
        hasAudio: false,
        hasVideo: false,
        priority: 15 
      }));

    if (images.length === 0) {
      const fallbackUrl = info.url || info.thumbnail;
      if (fallbackUrl && (fallbackUrl.includes('.jpg') || fallbackUrl.includes('.png') || fallbackUrl.includes('.webp') || fallbackUrl.includes('image') || currentlyImage)) {
        images.push({
          id: 'fallback-img',
          ext: mediaExt || 'jpg',
          resolution: 'Original',
          qualityLabel: 'Original Photo (Image)',
          url: fallbackUrl,
          hasAudio: false,
          hasVideo: false,
          priority: 15
        });
      }
    }

    // 1. Progressive
    const progressive = allFormats
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
      .map(f => ({
        id: f.format_id,
        ext: f.ext,
        resolution: f.resolution || `${f.width}x${f.height}`,
        qualityLabel: (f.format_note || f.height + 'p') + ' (Complete)',
        url: f.url,
        hasAudio: true,
        hasVideo: true,
        priority: 10
      }));

    // 2. High-Res Video Only
    const videoOnly = allFormats
      .filter(f => f.vcodec !== 'none' && f.acodec === 'none' && f.height > 720)
      .map(f => ({
        id: f.format_id,
        ext: f.ext,
        resolution: f.resolution || `${f.width}x${f.height}`,
        qualityLabel: (f.format_note || f.height + 'p') + ' (Video Only)',
        url: f.url,
        hasAudio: true,
        hasVideo: true,
        priority: 5
      }));

    // 3. Audio Only
    const audioOnly = allFormats
      .filter(f => f.vcodec === 'none' && f.acodec !== 'none')
      .map(f => ({
        id: f.format_id,
        ext: f.ext,
        resolution: 'Audio',
        qualityLabel: (f.abr ? Math.round(f.abr) + 'kbps' : 'High Quality') + ' (Audio)',
        url: f.url,
        hasAudio: true,
        hasVideo: false,
        priority: 1
      }));

    const formats = [...images, ...progressive, ...videoOnly, ...audioOnly]
      .sort((a, b) => b.priority - a.priority);

    if (info.entries && info.entries.length > 0) {
      info.entries.forEach((entry, idx) => {
        if (entry.url) {
          formats.push({
            id: `entry-${idx}`,
            ext: entry.ext || 'jpg',
            resolution: 'Photo',
            qualityLabel: `Slide ${idx + 1} (Image)`,
            url: entry.url,
            hasAudio: false,
            hasVideo: false,
            priority: 20
          });
        }
      });
    }

    const bestFormat = {
      id: 'best',
      ext: mediaExt || 'mp4',
      resolution: info.resolution || 'Original',
      qualityLabel: currentlyImage ? 'High Quality (Image)' : 'Auto Best (Complete)',
      url: info.url,
      hasAudio: !currentlyImage,
      hasVideo: !currentlyImage
    };

    res.json({
      title: info.title || 'Untitled',
      description: info.description || info.caption || '',
      thumbnail: info.thumbnail,
      duration: info.duration_string || (currentlyImage ? 'Photo' : ''),
      platform: info.extractor_key,
      url: info.webpage_url,
      formats: [bestFormat, ...formats].slice(0, 15) 
    });
    
  } catch (error) {
    console.error('!!! EXTRACTION FATAL ERROR !!!', error);
    res.status(500).json({ 
      error: 'Failed to extract media', 
      details: error.message || 'Unknown error',
      code: (error.message || '').includes('image') || (error.message || '').includes('photo') ? 'PHOTOS_NOT_SUPPORTED' : 'EXTRACTION_FAILED',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

const host = '127.0.0.1';
app.listen(port, host, () => {
  console.log(`\n=========================================`);
  console.log(`Backend server ready at http://${host}:${port}`);
  console.log(`=========================================\n`);
});

process.on('uncaughtException', (err) => {
  console.error('CRITICAL: Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});
