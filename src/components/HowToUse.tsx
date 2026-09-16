import { Heading, LazyLoadIframe } from "@/components";

const HowToUse = () => {
  return (
    <div className="flex justify-center items-center w-full bg-white dark:bg-[#010814] my-16">
      <div className="max-w-[1440px] w-full px-4 sm:px-12">
        <div id="0" className="max-w-[405px] mx-auto mb-6">
          <Heading
            title="How to Use"
            desc="Just insert inside your code, no-code or AI tool inside and go LIVE"
          />
        </div>
        <div className="video-class mt-10">
          <LazyLoadIframe
            src="https://www.youtube.com/embed/gRxrvPqDKNw?si=veriUjp8slBmdCNP"
            title="Build 56 micro SaaS, Earn $14,400/m, with SIMPLE Tech Stack"
          />
        </div>
      </div>
    </div>
  );
};

export default HowToUse;
