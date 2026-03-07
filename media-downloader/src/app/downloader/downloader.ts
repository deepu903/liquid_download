import { Component, NgZone, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MediaService } from '../media.service';
import gsap from 'gsap';

@Component({
  selector: 'app-downloader',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './downloader.html',
  styleUrl: './downloader.css'
})
export class DownloaderComponent {
  mediaUrl: string = '';
  isDownloading: boolean = false;
  progress: number = 0;
  statusMessage: string = 'Ready to download';
  showSuccess: boolean = false;
  showError: boolean = false;
  errorMessage: string = '';
  currentMedia: any = null;

  constructor(
    private mediaService: MediaService,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef
  ) {}

  startDownload() {
    this.showError = false; // Reset error on new attempt
    if (!this.mediaUrl || !this.mediaUrl.includes('http')) {
      this.triggerError('Please enter a valid media link');
      return;
    }

    this.isDownloading = true;
    this.progress = 0;
    this.statusMessage = 'Analyzing URL...';
    this.showSuccess = false;

    // Start animation immediately for perceived speed
    this.animateProgress();

    // Fetch real media info
    this.mediaService.getMediaInfo(this.mediaUrl).subscribe({
      next: (info: any) => {
        // Map backend 'url' to 'sourceUrl' for the interface
        if (info.url) info.sourceUrl = info.url;
        this.currentMedia = info;
        this.statusMessage = `Found: ${info.title}. Finalizing...`;
        this.checkDataAndFinish();
      },
      error: (err) => {
        this.ngZone.run(() => {
          this.isDownloading = false;
          gsap.killTweensOf(this);
          this.triggerError(this.mapError(err));
        });
      }
    });
  }

  private mapError(err: any): string {
    const serverError = (err.error?.code || err.error?.error || '').toLowerCase();
    const details = (err.error?.details || '').toLowerCase();
    const mainMsg = (err.message || '').toLowerCase();
    const status = err.status;

    const isPrivate = serverError.includes('private') || details.includes('private') || mainMsg.includes('private');

    if (isPrivate) {
      return 'This post seems to be private. Try with a public link!';
    }
    if (status === 404) {
      return 'We couldn\'t find that media. Double check your link!';
    }
    if (status === 0) {
      return 'Connection lost. Please check your internet and try again.';
    }

    return 'Something went wrong on our end. Please try again soon!';
  }

  triggerError(message: string) {
    console.log('Downloader: triggerError called with:', message);
    this.errorMessage = message;
    this.showError = true;
    this.isDownloading = false;
    
    // Force UI update
    this.cdr.detectChanges();
    
    // Shake animation for the card
    gsap.fromTo('.downloader-card', 
      { x: -10 }, 
      { x: 10, duration: 0.1, repeat: 5, yoyo: true, ease: 'none', onComplete: () => {
        gsap.set('.downloader-card', { x: 0 });
      }}
    );
  }

  closeError() {
    console.log('Downloader: closeError called');
    this.showError = false;
    this.statusMessage = 'Ready to download';
    this.cdr.detectChanges();
  }

  animateProgress() {
    // Run outside Angular zone for performance during animation
    this.ngZone.runOutsideAngular(() => {
      const tl = gsap.timeline();

      // Fast progress to 90%
      tl.to(this, {
        progress: 90,
        duration: 2.5,
        ease: 'power1.out',
        onUpdate: () => {
          // Re-enter zone occasionally or manually trigger detection
          this.ngZone.run(() => {
            this.progress = Math.floor(this.progress);
          });
        }
      });

      // Slow "waiting" crawl from 90 to 98
      tl.to(this, {
        progress: 98,
        duration: 10,
        ease: 'none',
        onUpdate: () => {
          this.ngZone.run(() => {
            this.progress = Math.floor(this.progress);
          });
        }
      });
    });
  }

  // Add a listener for when currentMedia is set to finish the animation
  private checkDataAndFinish() {
    console.log('Downloader: checkDataAndFinish called', { hasMedia: !!this.currentMedia, isDownloading: this.isDownloading });
    
    if (this.currentMedia && this.isDownloading) {
      console.log('Downloader: Finishing animation...');
      gsap.killTweensOf(this); // Stop the crawl
      
      this.ngZone.runOutsideAngular(() => {
        gsap.to(this, {
          progress: 100,
          duration: 0.8,
          ease: 'power2.out',
          onUpdate: () => {
            this.ngZone.run(() => {
              this.progress = Math.floor(this.progress);
            });
          },
          onComplete: () => {
            console.log('Downloader: Animation complete, calling finishDownload()');
            this.ngZone.run(() => {
              this.finishDownload();
            });
          }
        });
      });
    } else if (this.currentMedia && !this.isDownloading) {
      console.warn('Downloader: Media found but isDownloading was false? Forcing finish.');
      this.finishDownload();
    }
  }

  finishDownload() {
    this.isDownloading = false;
    this.statusMessage = 'Media Extracted Successfully!';
    this.showSuccess = true;
    this.cdr.detectChanges(); // Ensure UI reflects state immediately

    // Pulse animation for success
    setTimeout(() => {
      gsap.to('.success-icon', {
        scale: 1.2,
        duration: 0.5,
        yoyo: true,
        repeat: 1
      });
    }, 50);
  }

  downloadFormat(format: any) {
    if (format && format.url) {
      this.statusMessage = `Starting ${format.qualityLabel} download...`;
      this.mediaService.downloadFile(
        format.url, 
        `${this.currentMedia.title.replace(/\s+/g, '_')}_${format.qualityLabel}.${format.ext}`,
        format.id
      );
      
      // Keep success message for a bit then reset
      setTimeout(() => {
        this.resetState();
      }, 3000);
    }
  }

  resetState() {
    this.showSuccess = false;
    this.statusMessage = 'Ready to download';
    this.currentMedia = null;
    this.mediaUrl = '';
    this.cdr.detectChanges();
  }
}
