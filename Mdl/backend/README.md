# Liquid Media Downloader Backend

This is the custom API for the Liquid Media Downloader application. It uses `yt-dlp` (via `youtube-dl-exec`) to extract media information from various social platforms.

### Requirements

- Node.js installed
- **FFmpeg (Highly Recommended)**: Install FFmpeg on your system to allow merging video/audio for high-quality (1080p+) downloads.
  - On Windows: `winget install ffmpeg`
  - On Mac: `brew install ffmpeg`

### Features

- Support for YouTube, Instagram, X (Twitter), TikTok, Reddit, and 50+ more.
- Automatic thumbnail and title extraction.
- Support for carousel posts (multi-item downloads).
- Formats quality and size automatically.

### Running Manually

1. `cd backend`
2. `npm install`
3. `node server.js`

The API will be available at `http://localhost:3000`.
