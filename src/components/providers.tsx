'use client';

import { ReactNode } from "react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "react-hot-toast";
import { Tooltip } from "react-tooltip";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <div className="min-h-screen bg-background">
          {children}
        </div>
      </ThemeProvider>

      <Toaster
        position="bottom-center"
        toastOptions={{
          duration: 3000,
          className: "text-sm dark:bg-black dark:text-white",
        }}
      />
      
      <Tooltip
        id="tooltip"
        className="z-[60] !opacity-100 max-w-sm shadow-lg"
      />
    </>
  );
}
