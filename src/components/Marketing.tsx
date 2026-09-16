"use client";

import { Heading } from "@/components";
import Image from "next/image";
import MImage1 from "@/assets/images/marketing1.svg";
import MImage2 from "@/assets/images/marketing2.svg";
import MImage3 from "@/assets/images/marketing3.svg";
import MImage4 from "@/assets/images/marketing4.svg";

const MImage1Src = MImage1.src;
const MImage2Src = MImage2.src;
const MImage3Src = MImage3.src;
const MImage4Src = MImage4.src;

const data = [
  {
    image: `${MImage1Src}`,
    title: "Discord community for",
    description: "Motivation, Partnerships, Cross promotions, Networking",
  },
  {
    image: `${MImage2Src}`,
    title: "SEO Blog Template",
  },
  {
    image: `${MImage3Src}`,
    title: "Best tools for Landing Page conversion Boost",
  },
  {
    image: `${MImage4Src}`,
    title: "Product Hunt launch small guide",
  },
];

const MarketingCard = ({ item }: any) => {
  return (
    <div className="min-h-full flex flex-col items-center scale-1 hover:scale-[1.05] transition-all duration-300">
      {item?.image && (
        <Image
          src={item?.image}
          alt="logo"
          loading="lazy"
          width={330}
          height={330}
          objectFit="cover"
          className="h-[350px] w-auto"
        />
      )}
      <p className="text-black1 dark:text-white font-medium text-lg text-center px-3">
        {item?.title}
      </p>
      {item?.description && (
        <p className="text-[#7B7E83] dark:text-[#5A5E66] font-medium text-center text-base px-3">
          {item?.description}
        </p>
      )}
    </div>
  );
};

const Marketing = () => {
  return (
    <div className="flex justify-center items-center bg-white dark:bg-[#010814] my-16 w-full">
      <div className="max-w-[1440px] w-full px-4 sm:px-12">
        <div className="max-w-[440px] mx-auto">
          <Heading
            title="TOP Marketing Tools"
            desc="Use the best and proven methodologies to launch your micro SaaS fast and earn money from happy customers"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-y-16 items-center justify-center mt-12">
          {data?.map((item: any, index: number) => (
            <MarketingCard key={index} item={item} />
          ))}
        </div>
      </div>
    </div>
  );
};

export default Marketing;
