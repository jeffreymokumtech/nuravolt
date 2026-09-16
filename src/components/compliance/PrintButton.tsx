'use client';

import { Printer } from 'lucide-react';

export default function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
    >
      <Printer className="w-4 h-4" />
      Save as PDF
    </button>
  );
}
