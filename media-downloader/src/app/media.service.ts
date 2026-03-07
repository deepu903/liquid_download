import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, map, of, throwError } from 'rxjs';

export interface MediaFormat {
  id: string;
  ext: string;
  resolution: string;
  qualityLabel: string;
  url: string;
  filesize?: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export interface MediaInfo {
  title: string;
  thumbnail?: string;
  duration?: string;
  description?: string;
  sourceUrl?: string;
  platform: string;
  formats: MediaFormat[];
}

@Injectable({
  providedIn: 'root'
})
export class MediaService {
  // Replace with your actual proxy or extraction API endpoint
  private apiUrl = 'http://127.0.0.1:3002/extract'; 

  constructor(private http: HttpClient) {}

  /**
   * Fetches media information from a given URL using the local backend.
   */
  getMediaInfo(url: string): Observable<MediaInfo> {
    console.log('MediaService: Requesting extraction for:', url);
    return this.http.post<MediaInfo>(this.apiUrl, { url }).pipe(
      map(response => {
        console.log('MediaService: Extraction response received:', response);
        return response;
      }),
      catchError(error => {
        console.error('MediaService: Backend extraction failed:', error);
        return throwError(() => error);
      })
    );
  }

  /**
   * Triggers a browser download for the given URL via the backend proxy.
   */
  downloadFile(url: string, filename: string, formatId?: string): void {
    const proxyUrl = `http://127.0.0.1:3002/download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}&formatId=${encodeURIComponent(formatId || '')}`;
    
    // Direct navigation is more reliable for endpoints that return Content-Disposition: attachment
    window.location.href = proxyUrl;
  }

  private detectPlatform(url: string): string {
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'YouTube';
    if (url.includes('instagram.com')) return 'Instagram';
    if (url.includes('tiktok.com')) return 'TikTok';
    if (url.includes('reddit.com')) return 'Reddit';
    if (url.includes('pinterest.com') || url.includes('pin.it')) return 'Pinterest';
    if (url.includes('twitter.com') || url.includes('x.com')) return 'X';
    return 'Web';
  }
}
