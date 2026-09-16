'use client'

import React, { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

export default function ThankYouPopup() {
	const router = useRouter();
	const pathname = usePathname();

    const searchParams = useSearchParams();
    const sessionId = searchParams.get('session_id')
  const [isOpen, setIsOpen] = useState(!!sessionId);

useEffect(() => {
  localStorage.removeItem('priceId')
}, [])

  const closePopup = () => {
    router.replace(pathname);
    setIsOpen(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
      <div className="bg-white p-8 rounded-lg shadow-lg text-center">
        <h2 className="text-2xl font-bold mb-4">Thank You!</h2>
        <p className="mb-6">We appreciate your support.</p>
        <button
          onClick={closePopup}
          className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-full text-lg transition duration-300 ease-in-out transform hover:scale-105"
        >
          Start
        </button>
      </div>
    </div>
  );
}