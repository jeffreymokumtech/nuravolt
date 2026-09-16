import { Heading } from "@/components";
import Image from "next/image";
import MainBG from "@/assets/images/zero-risk-bg1.svg";
import MainBGDark from "@/assets/images/zero-risk-bg2.svg";
import ZeroRistImage from "@/assets/images/zero-risk1.svg";
import ZeroRistImageDark from "@/assets/images/zero-risk2.svg";

const ZeroRisk = () => {
  return (
    <div className="relative flex justify-center items-center w-full">
      <Image
        src={MainBG}
        alt="background"
        fill
        objectFit="cover"
        className="z-0 block dark:hidden"
      />
      <Image
        src={MainBGDark}
        alt="background"
        fill
        objectFit="cover"
        className="z-0 hidden dark:block"
      />
      <div className="relative z-10 max-w-[1440px] w-full px-4 sm:px-12 py-12">
        <div className="max-w-[537px] mx-auto">
          <Heading
            title="Zero Risk!"
            desc="Test 1, 2, 5 or 10 ideas simultaneously with Micro SaaS Fast. One idea, one week, no stress. Do not rely on one idea, your motivation etc"
          />
        </div>
        <div className="">
          <Image
            src={ZeroRistImage}
            alt="no-risk"
            width={1150}
            height={550}
            priority={true}
            // sizes="(max-width: 600px) 700px, 700px"
            className="object-contain block dark:hidden"
          />
          <Image
            src={ZeroRistImageDark}
            alt="no-risk"
            width={1150}
            height={550}
            priority={true}
            // sizes="(max-width: 600px) 700px, 700px"
            className="object-contain hidden dark:block"
          />
        </div>
      </div>
    </div>
  );
};

export default ZeroRisk;
