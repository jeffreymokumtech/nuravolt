"use client";

import React, { useState } from "react";

const StripePortalButton: React.FC = () => {
  const [isLoading, setIsLoading] = useState(false);

  const handlePortalRedirect = async () => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/stripe/create-portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnUrl: window.location.origin }),
      });

      if (!response.ok) {
        throw new Error("Failed to create portal");
      }

      const { url } = await response.json();
      if (url) {
        window.location.href = url;
      } else {
        console.error("No URL returned from the API");
      }
    } catch (error) {
      console.error("Error:", error);
      alert("Failed to open Stripe portal. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen dark:bg-black1 bg-gray-100">
      <button
        onClick={handlePortalRedirect}
        disabled={isLoading}
        className={`
          bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded
          ${isLoading ? "opacity-50 cursor-not-allowed" : ""}
        `}
      >
        {isLoading ? "Loading..." : "Go to Stripe Customer Portal"}
      </button>
    </div>
  );
};

export default StripePortalButton;
