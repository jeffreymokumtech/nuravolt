"use client";
import { Heading } from "@/components";
import dynamic from "next/dynamic";
import Image from "next/image";
import { useEffect, useState } from "react";
import AvatarOne from "@/assets/images/avatar1.svg"
import AvatarTwo from "@/assets/images/avatar2.svg"
import TestimonialImage from "@/assets/images/testimonial.svg"


const AvatarOneSrc = AvatarOne.src;
const AvatarTwoSrc = AvatarTwo.src;
const TestimonialImageSrc = TestimonialImage.src;


// Dynamically import Masonry components
const Masonry = dynamic(
  () => import("react-responsive-masonry").then((mod) => mod.default),
  { ssr: false }
);
const ResponsiveMasonry = dynamic(
  () => import("react-responsive-masonry").then((mod) => mod.ResponsiveMasonry),
  { ssr: false }
);

const data = [
  {
    video:
      "https://ik.imagekit.io/gpujoep0b/sample-video.mp4?updatedAt=1727865840219",
    text: "“The school is good. My child seems happy and is doing...”",
  },
  {
    avatar: `${AvatarOneSrc}`,
    name: "Vlad",
    text: "The decision to send our daughter to The Grove School has been validated time and again through her enthusiastic participation in class, the projects she brings home, and the growth we've seen in her self-confidence and academic abilities. The school’s commitment to nurturing leadership qualities alongside academic success is evident in its vibrant... ",
  },
  {
    video:
      "https://ik.imagekit.io/gpujoep0b/sample-video.mp4?updatedAt=1727865840219",
    text: "“The school is good. My child seems happy and is doing...”",
  },
  {
    image: `${TestimonialImageSrc}`,
  },
  {
    video:
      "https://ik.imagekit.io/gpujoep0b/sample-video.mp4?updatedAt=1727865840219",
    text: "“The school is good. My child seems happy and is doing...”",
  },
  {
    avatar: `${AvatarTwoSrc}`,
    name: "Max",
    text: "After transferring from another school, we noticed immediate improvements in our daughter's confidence and academic abilities. The Grove School offers excellent support and resources.",
  },
];

const TestimonialCard = ({ item }) => {
  return (
    <div className="p-0 shadow-2xl dark:shadow-none border dark:border-[#373C53] bg-white dark:bg-gradient-to-r from-[#1E242D] to-[#0B111B] scale-1 hover:scale-[1.025] rounded-[20px] transition-all duration-300">
      {item?.video && (
        <div className="">
          <video
            controls
            width="272"
            height="340"
            className="h-[340px] w-[100%] object-cover rounded-t-[20px]"
          >
            <source src={item?.video} type="video/mp4" />
            Your browser does not support the video tag.
          </video>
        </div>
      )}
      {item?.image && (
        <Image
          src={item?.image}
          alt="image"
          //priority={true}
          width={1000}
          height={500}
          className="rounded-lg object-cover"
        />
      )}
      {item?.avatar && (
        <div className="flex gap-3 items-center mt-5 mx-5">
          <Image
            src={item?.avatar}
            alt="image"
            //priority={true}
            width={40}
            height={40}
            className="rounded-full"
          />
          {item?.name && (
            <p className="text-lg text-black1 dark:text-white font-bold">
              {item?.name}
            </p>
          )}
        </div>
      )}
      {item?.text && (
        <p className="text-black dark:text-white m-5 text-base font-normal">
          {item?.text}
        </p>
      )}
    </div>
  );
};

const Testimonials = () => {
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  if (!isClient) return null; // Render nothing if not client-side

  return (
    <div className="flex justify-center items-center bg-white dark:bg-[#010814] my-16 w-full">
      <div className="max-w-[1440px] w-full px-4 sm:px-12">
        <div className="max-w-[800px] mx-auto mb-16">
          <Heading
            title="Maker Who Already Shipped Micro SaaS, AI tools, Startups & Side Projects"
            desc="They’re making their first money online, quitting their 9-to-5 jobs, working from anywhere, and doing what they love"
            maxWidth={460}
          />
        </div>
        <div>
          <ResponsiveMasonry
            columnsCountBreakPoints={{ 350: 1, 650: 2, 1000: 3 }}
          >
            <Masonry gutter="16px">
              {data?.map((item, index) => (
                <div key={index} className="col-span-1">
                  <TestimonialCard item={item} />
                </div>
              ))}
            </Masonry>
          </ResponsiveMasonry>
        </div>
      </div>
    </div>
  );
};

export default Testimonials;
