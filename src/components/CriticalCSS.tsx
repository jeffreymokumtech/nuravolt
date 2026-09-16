import { useEffect } from 'react';

const CriticalCSS = (): null => {
  useEffect(() => {
    // Load non-critical CSS asynchronously
    const loadCSS = (href: string) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.media = 'print';
      link.onload = () => {
        link.media = 'all';
      };
      document.head.appendChild(link);
    };

    // Load deferred stylesheets
    const deferredStyles = [
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
    ];

    deferredStyles.forEach(loadCSS);
  }, []);

  return null;
};

export default CriticalCSS;