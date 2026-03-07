const axios = require('axios');
const url = 'https://www.instagram.com/reels/C4MTIwNjQ2YQ==/'; // Example placeholder URL

async function testFetchAll() {
  try {
    const resp = await axios.get(url, {
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
    
    console.log('og:image:', ogImg ? 'Found' : 'Missing');
    console.log('og:video:', ogVideo ? 'Found' : 'Missing');
    console.log('og:type:', ogType);
    
    // Look for any video link
    const videoLinks = html.match(/https?:\/\/[^/]*scontent[^"> \s]+\.mp4[^"> \s]*/g) || [];
    console.log('scontent .mp4 links found:', videoLinks.length);
    videoLinks.slice(0, 5).forEach(u => console.log('Video:', u));
    
  } catch (err) {
    console.error('Test failed:', err.message);
  }
}

testFetchAll();
