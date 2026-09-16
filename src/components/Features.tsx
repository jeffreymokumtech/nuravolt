import { Heading } from "@/components";
import {
  Auth,
  Blog,
  Clerk,
  Database,
  Email,
  Landing,
  Licence,
  Licence2,
  NextJs,
  Payment,
  Postgres,
  Prisma,
  Resend,
  Seo,
  Shadecn,
  Stripe,
  Tailwind,
  Typescript,
  Ui,
  Wordpress,
} from "@/icons";
import Image from "next/image";
import StopCodingBg from "@/assets/images/stop-coding-bg1.svg";
import StopCodingBgDark from "@/assets/images/stop-coding-bg2.svg";

import LandingImg from "@/assets/images/landing.svg";
import AuthImg from "@/assets/images/auth.svg";
import EmailImg from "@/assets/images/email.svg";
import PaymentImg from "@/assets/images/payment.svg";
import SeoImg from "@/assets/images/seo.svg";
import BlogImg from "@/assets/images/blog.svg";
import DatabaseImg from "@/assets/images/database.svg";
import UiImg from "@/assets/images/ui.svg";
import LicenceImg from "@/assets/images/licence.svg";

const LandingImgUrl = LandingImg.src;
const AuthImgUrl = AuthImg.src;
const EmailImgUrl = EmailImg.src;
const PaymentImgUrl = PaymentImg.src;
const SeoImgUrl = SeoImg.src;
const BlogImgUrl = BlogImg.src;
const DatabaseImgUrl = DatabaseImg.src;
const UiImgUrl = UiImg.src;
const LicenceImgUrl = LicenceImg.src;

const data = [
  {
    icon: <Landing />,
    image: `${LandingImgUrl}`,
    title: "Landing Page",
    desc: "Balanced, awesome UI components that are tailored to highlight the VALUE of your micro SaaS, with a focus on boosting your conversion rate",
    features: [
      "Landing page",
      "Waitlist",
      "Dashboard",
      "8 Value focused UI sections",
    ],
    time: "10 HOURS SAVED",
    technologies: [
      {
        icon: <Typescript />,
        text: "TypeScript",
      },
      {
        icon: <NextJs />,
        text: "Next.Js",
      },
      {
        icon: <Tailwind />,
        text: "TailwindCSS",
      },
      {
        icon: <Shadecn />,
        text: "shadcn/ui",
      },
    ],
  },
  {
    icon: <Auth />,
    image: `${AuthImgUrl}`,
    title: "Auth & User Profiles",
    desc: "Fully completed user authentication with MFA/2FA and user profile modules",
    features: [
      "Sign up & Sign in pages",
      "User profile",
      "Google auth",
      "Verification code",
      "Organizations",
    ],
    time: "15 HOURS SAVED",
    technologies: [
      {
        icon: <Clerk />,
        text: "Clerk.com",
      },
    ],
  },
  {
    icon: <Email />,
    image: `${EmailImgUrl}`,
    title: "Emails",
    desc: "Welcome your users with sexy emails",
    features: [
      "Send transactional emails",
      "Email design",
      "DNS setup to avoid spam folder (DKIM, DMARC, SPF in subdomain)",
      "Webhook to receive & forward emails",
    ],
    time: "3 HOURS SAVED",
    technologies: [
      {
        icon: <Resend />,
        text: "Resend",
      },
    ],
  },
  {
    icon: <Payment />,
    image: `${PaymentImgUrl}`,
    title: "Payments",
    desc: "Start collecting payments (subscriptions and one-time purchases) in 4 minutes",
    features: [
      "Checkout sessions",
      "Webhooks to update the subscriptions",
      "One time payment & Subscriptions",
      "Pricing page",
      "Manage subscription",
    ],
    time: "8 HOURS SAVED",
    technologies: [
      {
        icon: <Stripe />,
        text: "Stripe",
      },
    ],
  },
  {
    icon: <Seo />,
    image: `${SeoImgUrl}`,
    title: "SEO",
    desc: "Everything that you need from SEO are inside. Rank higher on Google with the fully completed tech SEO",
    features: [
      "Sitemap",
      "Metatags",
      "Page speed optimisation",
      "OpenGraph",
      "Rich Snippets",
    ],
    time: "4 HOURS SAVED",
  },
  {
    icon: <Blog />,
    image: `${BlogImgUrl}`,
    title: "Blog CMS",
    desc: "Google loves WordPress SEO structure. You have your WordPress CMS inside with Next.js wrapper and sexy blog design and all metatags, etc",
    features: [
      "Preview page",
      "Article page",
      "CMS",
      "Custom design",
      "SEO optimized",
    ],
    time: "12 HOURS SAVED",
    technologies: [
      {
        icon: <Wordpress />,
        text: "WordPress",
      },
    ],
  },
  {
    icon: <Database />,
    image: `${DatabaseImgUrl}`,
    title: "Database ORM",
    desc: "Ideal DB setup for your fast lauch & future scalability",
    features: [
      "PostgreSQL (project)",
      "MySQL (Blog)",
      "Database schema with Prisma",
      "Simplified data transactions",
    ],
    time: "2 HOURS SAVED",
    technologies: [
      {
        icon: <Prisma />,
        text: "Prisma",
      },
      {
        icon: <Postgres />,
        text: "PostgreSQL",
      },
    ],
  },
  {
    icon: <Ui />,
    image: `${UiImgUrl}`,
    title: "UI Design",
    desc: "Design and UI components that boost your SALES and user attention to your marketing hooks",
    features: [
      "UI Next.js Components",
      "Components library with ChakraUI / Daisyui",
      "Built-in TailwindCSS / ShadcnUI",
      "Customizable theme to match your brand",
    ],
    time: "2 HOURS SAVED",
    technologies: [
      {
        icon: <Shadecn />,
        text: "Shadcn/UI",
      },
      {
        icon: <Tailwind />,
        text: "TailwindCSS",
      },
    ],
  },
  {
    icon: <Licence />,
    image: `${LicenceImgUrl}`,
    title: "License & Code Ownership",
    desc: "Your license is valid forever for unlimited apps. Build as many apps as you want, ship them to production, and use them forever",
    features: ["Code is yours!", "Build unlimited apps"],
    time: "ZERO Legal Headachaes",
    technologies: [
      {
        icon: <Licence2 />,
        text: "License",
      },
    ],
    isBlue: true,
  },
];

const Features = () => {
  return (
    <div className="relative flex justify-center items-center w-full">
      <Image
        src={StopCodingBg}
        alt="background"
        fill
        objectFit="cover"
        priority={true}
        className="z-0 block dark:hidden"
      />
      <Image
        src={StopCodingBgDark}
        alt="background"
        fill
        objectFit="cover"
        priority={true}
        className="z-0 hidden dark:block"
      />
      <div className="relative z-10 max-w-[1440px] w-full px-4 sm:px-12 py-12">
        <div className="max-w-[528px] mx-auto mb-24">
          <Heading
            title="STOP Coding, Start Making MONEY!"
            desc="This starter kit uses modern tech tools and marketing focused design that give you competitive advantage to move fast and earn $"
          />
        </div>
        {data?.map((item, index) => (
          <div
            key={index}
            className={`flex gap-8 lg:gap-4 justify-between mb-16 ${
              index % 2 === 0
                ? "flex-col-reverse lg:flex-row-reverse"
                : "flex-col-reverse lg:flex-row"
            }`}
          >
            <Image
              src={item.image}
              alt={item.title}
              width={590}
              height={315}
              className="rounded-[16px] lg:w-[50%]"
            />
            <div className="lg:w-[45%]">
              <div className="flex gap-2">
                <div className="text-[#1364FF] dark:text-white mt-2">
                  {item.icon}
                </div>
                <div className="text-[32px] font-bold text-black1 dark:text-white">
                  {item.title}
                </div>
              </div>
              <p className="text-lg font-medium text-[#7B7E83] dark:text-[#808389] my-4">
                {item.desc}
              </p>
              <ul
                className={`list-disc ml-4 mb-6 ${
                  item?.isBlue
                    ? "marker:text-[#1364FF] "
                    : "marker:text-[#1AAB12]"
                }`}
              >
                {item.features.map((feature, index) => (
                  <li
                    key={index}
                    className="text-base font-medium text-black1 dark:text-white mb-2"
                  >
                    {feature}
                  </li>
                ))}
              </ul>
              <div
                className={`text-white mb-4 text-sm font-semibold w-fit rounded-[6px] px-3 py-[6px] ${
                  item?.isBlue ? "bg-[#1364FF] " : "bg-[#1AAB12]"
                }`}
              >
                {item.time}
              </div>
              {item?.technologies && (
                <div className="flex flex-wrap py-2 border border-[#4D525A] rounded-[4px] w-fit">
                  {item?.technologies?.map((tech, index) => (
                    <div
                      key={index}
                      className={`flex items-center gap-2 text-black1 dark:text-white font-xs font-medium px-4 ${
                        index !== 0 && "border-l border-[#4D525A]"
                      }`}
                    >
                      {tech.icon} {tech.text}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Features;
