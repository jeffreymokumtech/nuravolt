// Performance monitoring utilities
export const measurePerformance = () => {
  if (typeof window !== 'undefined' && 'performance' in window) {
    // Measure Core Web Vitals
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'FCP') {
          console.log('First Contentful Paint:', entry.startTime);
        }
        if (entry.name === 'LCP') {
          console.log('Largest Contentful Paint:', entry.startTime);
        }
        if (entry.entryType === 'first-input') {
          console.log('First Input Delay:', (entry as any).processingStart - entry.startTime);
        }
        if (entry.entryType === 'layout-shift') {
          console.log('Cumulative Layout Shift:', (entry as any).value);
        }
      }
    });

    try {
      observer.observe({ entryTypes: ['paint', 'largest-contentful-paint', 'first-input', 'layout-shift'] });
    } catch (e) {
      console.log('Performance observer not supported');
    }
  }
};

// Lazy loading utility
export const lazyLoad = (callback: () => void, delay = 100) => {
  if (typeof window !== 'undefined') {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(callback);
    } else {
      setTimeout(callback, delay);
    }
  }
};

// Preload critical resources
export const preloadResource = (href: string, as: string, type?: string) => {
  if (typeof document !== 'undefined') {
    const link = document.createElement('link');
    link.rel = 'preload';
    link.href = href;
    link.as = as;
    if (type) link.type = type;
    document.head.appendChild(link);
  }
};

// Resource hints
export const addResourceHints = () => {
  if (typeof document !== 'undefined') {
    const domains = [
      'https://js.stripe.com',
      'https://api.stripe.com'
    ];

    domains.forEach(domain => {
      const link = document.createElement('link');
      link.rel = 'dns-prefetch';
      link.href = domain;
      document.head.appendChild(link);
    });
  }
};