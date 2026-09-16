import { ReactNode } from "react";
import { Heading, Logo } from "@/components";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/helpers/utils";
import { Save } from "lucide-react";

const data = [
  {
    title: "Software agency ",
    features: [
      "Hiring headaches",
      "Management horror",
      "Over price",
      "No guarantee result",
    ],
    cost: "$10,000 - $25,000",
  },
  {
    title: "No-code",
    features: [
      "30 days learning course",
      "Limitations",
      "Not your IP",
      "No SEO",
    ],
    cost: "$34 - $160 / monthly",
  },
  {
    title: "Personal coding",
    features: ["Find time", "Identify what needed", "Do not overthink", "Code"],
    cost: "55 hours and your rate: $6,000",
  },
  {
    title: <Logo />,
    features: ["Ready to use", "14 min setup", "LIVE in 1 day"],
    cost: "One time $247 payment",
    isGreen: true,
  },
];

interface itemProps {
  title: string | ReactNode;
  features: string[];
  cost: string;
  isGreen?: boolean;
}

interface MoneyCardProps {
  item: itemProps;
}

const MoneyCard = ({ item }: MoneyCardProps) => {
  return (
    <div
      className={`w-full pt-6 border rounded-[12px] bg-white dark:bg-gradient-to-r from-[#1E242D] to-[#0B111B] h-full scale-1 hover:scale-[1.05] transition-all duration-300 ${
        !item?.isGreen ? "border-[#EA2222]" : "border-[#1AAB12]"
      }`}
    >
      <div className="h-full flex flex-col justify-between gap-4">
        <div className="px-3">
          <div className="text-black1 dark:text-white text-xl font-medium mb-4">
            {item?.title}
          </div>
          <ul
            className={`list-disc ml-4 mb-6 ${
              item?.isGreen ? "marker:text-[#1AAB12]" : "marker:text-[#E93737]"
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
        </div>
        <div
          className={`px-3 text-white font-bold text-lg rounded-b-lg flex items-center justify-center min-h-[50px] ${
            item?.isGreen ? "bg-[#1AAB12]" : "bg-[#E93737]"
          }`}
        >
          {item?.cost}
        </div>
      </div>
    </div>
  );
};

const SaveMoney = () => {
  return (
    <div className="flex justify-center items-center w-full bg-white dark:bg-[#010814] my-16">
      <div className="max-w-[1440px] w-full px-4 sm:px-12">
        <div className="max-w-[450px] mx-auto mb-6">
          <Heading
            title="Save Money"
            desc="You don’t have to invest an arm and a leg or spend months launching your micro SaaS"
          />
        </div>
        <div>
          <p className="text-base font-medium text-black1 dark:text-white text-center">
            Hourly rate: $60 / hour
          </p>
          <Slider
            defaultValue={[50]}
            max={100}
            step={1}
            className={cn("max-w-[380px] mt-4 mb-8 mx-auto")}
            // {...props}
          />
          <p className="text-lg font-medium text-black1 dark:text-white text-center">
            MicroSaaS Fast starter kit saves you
          </p>
          <p className="text-[#1AAB12] text-[32px] font-bold text-center mb-5">
            $13,655
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mx-auto max-w-[320px] sm:max-w-[700px] xl:max-w-none">
          {data?.map((item: itemProps, index: number) => (
            <MoneyCard key={index} item={item} />
          ))}
        </div>
      </div>
    </div>
  );
};

export default SaveMoney;
