import Image from "next/image";
import logo from "@/assets/images/logo.svg";

const Logo = ({ isLarge = false }) => {
  return (
    <div className="flex items-center gap-1">
      <Image
        src={logo}
        width={24}
        height={24}
        layout="lazy"
        alt="logo"
        className={`${isLarge ? `hidden` : ""}`}
      />
      <div className="flex gap-1 items-center">
        <p
          className={`text-black1 dark:text-white ${
            isLarge
              ? "text-[20px] sm:text-[32px] leading-[20px] sm:leading-[32px] font-bold"
              : "text-[20px] leading-[20px] font-semibold"
          }`}
        >
          MicroSaas
        </p>
        <p
          className={`text-white dark:text-black1 bg-black dark:bg-white font-semibold px-2 rounded-[3px] pb-[3px] pt-[2px] ${
            isLarge
              ? "text-[20px] sm:text-[32px] leading-[20px] sm:leading-[32px]"
              : "text-[20px] leading-[20px]"
          }`}
        >
          Fast
        </p>
      </div>
    </div>
  );
};

export default Logo;
