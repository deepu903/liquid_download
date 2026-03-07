const axios = require('axios');
const url = 'https://www.instagram.com/p/DVOsZc9Ey_W/'; // Post from previous context

async function testVurl() {
  try {
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      },
      timeout: 10000
    });

    const html = resp.data;
    const videoUrlPattern = /"video_url":"([^"]+)"/g;
    let match;
    let foundVideoUrl = null;
    while ((match = videoUrlPattern.exec(html)) !== null) {
      const url = match[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
      console.log('Found URL candidate:', url.substring(0, 100));
      if (url.includes('scontent') && (url.includes('.mp4') || url.includes('_n.mp4'))) {
        foundVideoUrl = url;
        break; 
      }
    }
    console.log('Final foundVideoUrl:', foundVideoUrl ? 'YES' : 'NO');
  } catch (err) {
    console.error(err.message);
  }
}
testVurl();
