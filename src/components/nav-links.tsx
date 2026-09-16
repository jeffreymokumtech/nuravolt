import { ScrollToSection } from "@/utils/scroll-to-section";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

interface NavLink {
  icon?: JSX.Element;
  title: string;
  link: string;
}

interface PropsTypes {
  nav_links: NavLink[];
  isFooter?: boolean;
}

const NavLinks = ({ nav_links, isFooter = false }: PropsTypes) => {
  const router = useRouter();
  const pathname = usePathname();

  const handleNavigate = (item: any, index: number) => {
    if (pathname === "/" && item?.link === "/") {
      ScrollToSection(index.toString());
    } else {
      router.push(item?.link);
      setTimeout(() => {
        ScrollToSection(index.toString());
      }, 1500);
    }
  };

  return (
    <div
      className={`flex ${
        isFooter ? "flex-col" : "flex-col lg:flex-row lg:items-center"
      } gap-x-8 gap-y-6`}
    >
      {nav_links?.map((item: NavLink, index: number) =>
        pathname === "/" && item?.link === "/" ? (
          <p
            key={index}
            className={`text-black1 dark:text-white cursor-pointer hover:text-primary dark:hover:text-primary transition-colors duration-300 ease-in-out ${
              !isFooter
                ? "text-center flex items-center font-semibold text-lg gap-2"
                : "font-medium"
            }`}
            style={{
              lineHeight: "normal",
            }}
            onClick={() => handleNavigate(item, index)}
          >
            <span>{item?.icon}</span> {item?.title}
          </p>
        ) : (
          <Link
            key={index}
            href={item?.link}
            className={`text-black1 dark:text-white cursor-pointer hover:text-primary dark:hover:text-primary transition-colors duration-300 ease-in-out ${
              !isFooter
                ? "text-center flex items-center font-semibold text-lg gap-2"
                : "font-medium"
            }`}
            style={{
              lineHeight: "normal",
            }}
            onClick={() => handleNavigate(item, index)}
          >
            <span>{item?.icon}</span> {item?.title}
          </Link>
        )
      )}
    </div>
  );
};

export default NavLinks;
