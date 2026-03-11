import {
  Component,
  AfterViewInit,
  ViewChild,
  ElementRef,
  HostListener,
  signal,
  OnDestroy,
  ChangeDetectorRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import anime from 'animejs';
import Lenis from 'lenis';

interface DownloadFormat {
  quality: string;
  type: string;
  url: string;
  size?: string;
  icon: string;
  badge?: string;
}

interface DownloadResult {
  title: string;
  thumbnail?: string;
  url?: string;
  platform: string;
  platformColor: string;
  duration?: string;
  formats: DownloadFormat[];
}

interface Platform {
  name: string;
  icon: string;
  color: string;
  hoverColor: string;
}

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements AfterViewInit, OnDestroy {
  title = signal('Liquid Social Downloader');
  mediaUrl: string = '';
  isProcessing: boolean = false;
  processingStep: string = '';
  downloadResult: DownloadResult | null = null;
  scrolled: boolean = false;
  errorMessage: string = '';
  isDarkMode: boolean = true;
  private lenis: Lenis | null = null;
  private rafId: number = 0;
  private scrollAnimatedSections = new Set<Element>();

  constructor(private http: HttpClient, private cd: ChangeDetectorRef) {}

  // Title characters split for stagger animation
  titleChars = 'Liquid Social'.split('');
  subtitleChars = 'Downloader'.split('');

  platforms: Platform[] = [
    { name: 'Instagram', icon: 'fa-instagram', color: '#E1306C', hoverColor: 'from-[#833ab4] via-[#fd1d1d] to-[#fcb045]' },
    { name: 'YouTube',   icon: 'fa-youtube',   color: '#FF0000', hoverColor: 'from-red-600 to-red-400' },
    { name: 'X (Twitter)', icon: 'fa-x-twitter', color: '#1DA1F2', hoverColor: 'from-slate-900 to-slate-700' },
    { name: 'Reddit',    icon: 'fa-reddit',    color: '#FF4500', hoverColor: 'from-orange-600 to-orange-400' },
    { name: 'Pinterest', icon: 'fa-pinterest', color: '#E60023', hoverColor: 'from-red-700 to-red-500' },
    { name: 'TikTok',    icon: 'fa-tiktok',   color: '#010101', hoverColor: 'from-slate-900 to-pink-600' },
    { name: 'Facebook',  icon: 'fa-facebook', color: '#1877F2', hoverColor: 'from-blue-700 to-blue-500' },
    { name: 'Vimeo',     icon: 'fa-vimeo',    color: '#1AB7EA', hoverColor: 'from-cyan-600 to-cyan-400' },
  ];

  features = [
    { icon: 'fa-bolt-lightning', title: 'Lightning Fast', desc: 'Download in seconds, not minutes. Powered by advanced extraction engine.' },
    { icon: 'fa-layer-group',    title: 'Multi-Quality',  desc: 'Choose from 4K, 1080p, 720p, 480p or extract audio-only MP3.' },
    { icon: 'fa-shield-halved',  title: 'Safe & Private', desc: 'No sign-up needed. Zero tracking. Your downloads stay yours.' },
    { icon: 'fa-infinity',       title: 'Any Platform',   desc: 'Works across 50+ platforms. Instagram, YouTube, Reddit & beyond.' },
  ];

  @ViewChild('cardContainer', { static: false }) cardContainer!: ElementRef;
  @ViewChild('heroSection', { static: false }) heroSection!: ElementRef;
  @ViewChild('featuresSection', { static: false }) featuresSection!: ElementRef;

  @HostListener('window:scroll')
  onWindowScroll() {
    this.scrolled = window.scrollY > 60;
    this.handleScrollAnimations();
  }

  ngAfterViewInit() {
    this.initTheme();
    this.initSmoothScrolling();
    this.initEntryAnimations();
    this.initParticles();
  }

  initTheme() {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
      this.isDarkMode = false;
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      this.isDarkMode = true;
      document.documentElement.removeAttribute('data-theme');
    }
  }

  toggleTheme() {
    this.isDarkMode = !this.isDarkMode;
    if (this.isDarkMode) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('theme', 'light');
    }
    
    // Animate theme transition
    anime({
      targets: 'body',
      duration: 500,
      easing: 'easeInOutQuad'
    });
  }

  ngOnDestroy() {
    if (this.lenis) this.lenis.destroy();
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }

  // ─── Smooth Scrolling (Lenis) ────────────────────────────────────────────────
  initSmoothScrolling() {
    this.lenis = new Lenis({
      duration: 1.4,
      easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      orientation: 'vertical',
      gestureOrientation: 'vertical',
      smoothWheel: true,
      wheelMultiplier: 0.9,
    });

    const raf = (time: number) => {
      this.lenis!.raf(time);
      this.rafId = requestAnimationFrame(raf);
    };
    this.rafId = requestAnimationFrame(raf);
  }

  // ─── Entry Animations ────────────────────────────────────────────────────────
  initEntryAnimations() {
    // Navbar slide in
    anime({
      targets: '.navbar',
      translateY: [-80, 0],
      opacity: [0, 1],
      duration: 900,
      easing: 'easeOutExpo',
      delay: 100
    });

    // Title character stagger
    anime({
      targets: '.hero-char',
      translateY: [60, 0],
      rotateX: [90, 0],
      opacity: [0, 1],
      duration: 900,
      delay: anime.stagger(40, { start: 400 }),
      easing: 'easeOutExpo'
    });

    // Subtitle fade up
    anime({
      targets: '.hero-subtitle',
      translateY: [30, 0],
      opacity: [0, 1],
      duration: 800,
      delay: 1000,
      easing: 'easeOutCubic'
    });

    // Card entry with 3D flip
    anime({
      targets: '.main-card',
      translateY: [120, 0],
      rotateX: [20, 0],
      opacity: [0, 1],
      duration: 1200,
      delay: 600,
      easing: 'easeOutElastic(1, .7)'
    });

    // Platform icons stagger pop
    anime({
      targets: '.platform-icon',
      scale: [0, 1],
      opacity: [0, 1],
      rotate: [-15, 0],
      duration: 600,
      delay: anime.stagger(80, { start: 1200 }),
      easing: 'spring(1, 80, 12, 0)'
    });

    // Floating orbs
    this.animateOrbs();
  }

  animateOrbs() {
    anime({
      targets: '.orb',
      translateX: () => anime.random(-60, 60),
      translateY: () => anime.random(-60, 60),
      scale: () => anime.random(0.75, 1.3),
      duration: () => anime.random(4000, 8000),
      easing: 'easeInOutSine',
      direction: 'alternate',
      loop: true
    });
  }

  initParticles() {
    // Animate hero grid lines
    anime({
      targets: '.grid-line',
      scaleY: [0, 1],
      opacity: [0, 0.15],
      duration: 2000,
      delay: anime.stagger(100, { start: 800 }),
      easing: 'easeOutQuart'
    });
  }

  // ─── Scroll Trigger Animations ───────────────────────────────────────────────
  handleScrollAnimations() {
    document.querySelectorAll('.scroll-reveal').forEach(el => {
      if (this.scrollAnimatedSections.has(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.88) {
        this.scrollAnimatedSections.add(el);
        anime({
          targets: el,
          translateY: [50, 0],
          opacity: [0, 1],
          duration: 900,
          easing: 'easeOutCubic'
        });
      }
    });

    // Stagger feature cards
    const featCards = document.querySelectorAll('.feat-card:not(.appeared)');
    featCards.forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.9) {
        el.classList.add('appeared');
        const idx = Array.from(document.querySelectorAll('.feat-card')).indexOf(el);
        anime({
          targets: el,
          translateY: [60, 0],
          opacity: [0, 1],
          scale: [0.92, 1],
          duration: 800,
          delay: idx * 120,
          easing: 'easeOutBack'
        });
      }
    });
  }

  // ─── 3D Card Tilt ────────────────────────────────────────────────────────────
  onCardMouseMove(event: MouseEvent) {
    if (!this.cardContainer) return;
    const card = this.cardContainer.nativeElement;
    const rect = card.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const rx = ((event.clientY - rect.top - cy) / cy) * -8;
    const ry = ((event.clientX - rect.left - cx) / cx) * 8;

    anime({
      targets: card,
      rotateX: rx,
      rotateY: ry,
      duration: 150,
      easing: 'linear'
    });

    // Shimmer / light follow
    const shimmer = card.querySelector('.card-shimmer') as HTMLElement;
    if (shimmer) {
      const xPct = ((event.clientX - rect.left) / rect.width) * 100;
      const yPct = ((event.clientY - rect.top) / rect.height) * 100;
      shimmer.style.background = `radial-gradient(circle at ${xPct}% ${yPct}%, rgba(255,255,255,0.12) 0%, transparent 60%)`;
    }
  }

  onCardMouseLeave() {
    if (!this.cardContainer) return;
    anime({
      targets: this.cardContainer.nativeElement,
      rotateX: 0,
      rotateY: 0,
      duration: 700,
      easing: 'easeOutElastic(1, .5)'
    });
    const shimmer = this.cardContainer.nativeElement.querySelector('.card-shimmer') as HTMLElement;
    if (shimmer) shimmer.style.background = 'none';
  }

  // ─── Download Logic ──────────────────────────────────────────────────────────
  extractMedia() {
    if (!this.mediaUrl.trim()) return;
    this.errorMessage = '';
    this.isProcessing = true;
    this.processingStep = 'Connecting to server...';
    this.downloadResult = null;

    // Button pulse
    anime({
      targets: '.extract-btn',
      scale: [1, 0.94, 1.04, 1],
      duration: 500,
      easing: 'easeOutElastic(1, .5)'
    });

    const headers = new HttpHeaders({
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    });

    const body = {
      url: this.mediaUrl
    };

    // Custom backend endpoint
    const apiUrl = '/api/extract';

    setTimeout(() => { if(this.isProcessing) this.processingStep = 'Analyzing platform...'; }, 1000);
    setTimeout(() => { if(this.isProcessing) this.processingStep = 'Extracting media links...'; }, 3000);
    setTimeout(() => { if(this.isProcessing) this.processingStep = 'Almost there...'; }, 6000);

    this.http.post<any>(apiUrl, body, { headers }).subscribe({
      next: (res) => {
        console.log('[Frontend] Backend Response:', res);
        this.isProcessing = false;
        const platform = this.detectPlatform(this.mediaUrl);
        
        if (res.status === 'error') {
          this.errorMessage = res.message || 'Failed to extract media. Please check the URL.';
          return;
        }

        // Process our backend response
        this.downloadResult = this.mapCustomResponse(res, platform);
        
        // Force Angular to render the new result-wrap before we animate it
        this.cd.detectChanges();

        console.log('[Frontend] Result block in DOM?', !!document.querySelector('.result-wrap'));

        setTimeout(() => {
          const target = document.querySelector('.result-wrap');
          if (target) {
            anime({
              targets: '.result-wrap',
              translateY: [40, 0],
              opacity: [0, 1],
              duration: 900,
              easing: 'easeOutExpo'
            });
          }
          
          anime({
            targets: '.fmt-btn',
            translateX: [-30, 0],
            opacity: [0, 1],
            duration: 600,
            delay: anime.stagger(100, { start: 200 }),
            easing: 'easeOutCubic'
          });
        }, 100);
      },
      error: (err) => {
        this.isProcessing = false;
        this.errorMessage = 'Service currently unavailable. Please try again later.';
        console.error('Extraction error:', err);
      }
    });
  }

  private mapCustomResponse(res: any, platform: string): DownloadResult {
    const colorMap: Record<string, string> = {
      'Instagram': '#E1306C', 'YouTube': '#FF0000', 'X (Twitter)': '#1DA1F2',
      'Reddit': '#FF4500',    'Pinterest': '#E60023', 'TikTok': '#010101',
      'Facebook': '#1877F2',  'Vimeo': '#1AB7EA',    'Twitch': '#9146FF',
    };

    const result: DownloadResult = {
      title: res.title || `${platform} Media`,
      thumbnail: res.thumbnail || 'https://images.unsplash.com/photo-1611162617474-5b21e879e113?q=80&w=800&auto=format&fit=crop',
      platform,
      platformColor: colorMap[platform] ?? '#8b5cf6',
      duration: res.duration,
      formats: res.formats || []
    };

    console.log('[Frontend] Mapped Result:', result);
    return result;
  }

  detectPlatform(url: string): string {
    const u = url.toLowerCase();
    if (u.includes('instagram.com'))                return 'Instagram';
    if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
    if (u.includes('x.com') || u.includes('twitter.com'))   return 'X (Twitter)';
    if (u.includes('reddit.com'))                   return 'Reddit';
    if (u.includes('pinterest.com') || u.includes('pin.it')) return 'Pinterest';
    if (u.includes('tiktok.com'))                   return 'TikTok';
    if (u.includes('facebook.com') || u.includes('fb.watch')) return 'Facebook';
    if (u.includes('vimeo.com'))                    return 'Vimeo';
    if (u.includes('twitch.tv'))                    return 'Twitch';
    if (u.includes('dailymotion.com'))              return 'Dailymotion';
    return 'Unknown';
  }


  onFormatClick(fmt: DownloadFormat) {
    anime({
      targets: `.fmt-${fmt.quality.toLowerCase().split(' ').join('-').replace(/[^a-z0-9-]/g, '')}`,
      scale: [1, 0.92, 1],
      duration: 300,
      easing: 'easeOutBack'
    });

    // Actually trigger the download without redirection
    if (fmt.url) {
      const link = document.createElement('a');
      link.href = fmt.url;
      // The filename is already handled by the server's Content-Disposition header
      link.setAttribute('download', ''); 
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  }

  clearResult() {
    this.downloadResult = null;
    this.mediaUrl = '';
    this.errorMessage = '';
  }
}
