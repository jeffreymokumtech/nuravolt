import { Quote } from "@/icons";
import Image from "next/image";
import ProfilePic from "@/assets/images/profile-pic.svg";

const Review = () => {
  return (
    <div className="bg-white dark:bg-[#010814] w-full">
      <div className="max-w-[730px] flex flex-col items-center px-4 sm:px-12 mx-auto py-16">
        <Quote />
        <p className="text-lg font-medium text-black1 dark:text-white my-5 text-center">
          In just 2 months, I’ve already launched 3 ideas, 2 made $0, but one
          has brought in $1,600! The boilerplate saved me tons of time on
          writing wrappers and gave me the motivation to ship finally!
        </p>
        <div className="flex gap-2 items-center">
          <Image
            src={ProfilePic}
            alt="logo"
            width={45}
            height={45}
            className="rounded-full"
          />
          <div>
            <p className="text-[#1364FF] dark:text-white font-medium text-lg">
              John Dow
            </p>
            <p className="text-[#7B7E83] dark:text-[#5A5E66] font-medium text-sm">
              Marketer
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Review;
