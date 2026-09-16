import React from "react";

// A better way to illustrate with icons
// Pass any SVG icon as children (recommended width/height : w-6 h-6)
// By default, it's using your primary color for styling
const BetterIcon = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="w-12 h-12 inline-flex items-center justify-center rounded-full dark:bg-primary/20 dark:text-primary bg-[#49c172]/30 text-[#49c172]">
      {children}
    </div>
  );
};

export default BetterIcon;
