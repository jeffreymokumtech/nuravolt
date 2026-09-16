"use client";
import { useEffect, useRef, useState } from "react";

const LazyLoadIframe = ({
  src,
  title,
  width = "1136",
  height = "640",
}: any) => {
  const iframeRef = useRef<any>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsLoaded(true);
            observer.unobserve(iframeRef.current);
          }
        });
      },
      {
        threshold: 0.25,
      }
    );

    if (iframeRef.current) {
      observer.observe(iframeRef.current);
    }

    return () => {
      if (iframeRef.current) {
        observer.unobserve(iframeRef.current);
      }
    };
  }, []);

  return (
    <div ref={iframeRef} className="relative video-class w-full">
      {!isLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-200">
          <span>Loading...</span>
        </div>
      )}
      {isLoaded && (
        <iframe
          width={width}
          height={height}
          src={src}
          title={title}
          frameBorder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
        />
      )}
    </div>
  );
};

export default LazyLoadIframe;
