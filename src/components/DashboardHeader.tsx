'use client';

import { Button } from '@/components/ui/button';
import NuraVoltLogo from '@/components/NuraVoltLogo';
import Link from 'next/link';
import { User } from 'lucide-react';
import { useRouter } from 'next/navigation';

const DashboardHeader = () => {
  const router = useRouter();

  return (
    <header className="bg-white shadow-sm border-b">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-18">
          <Link href="/dashboard" className="flex items-center">
            <NuraVoltLogo width={200} height={50} showTagline={true} className="h-10" />
          </Link>

          <nav className="hidden md:flex items-center space-x-8">
            <Link href="/dashboard" className="text-gray-700 hover:text-blue-600 transition-colors">
              Dashboard
            </Link>
            <Link href="/chat" className="text-gray-700 hover:text-blue-600 transition-colors">
              AI Assistant
            </Link>
            <Link href="/blog" className="text-gray-700 hover:text-blue-600 transition-colors">
              Blog
            </Link>
          </nav>

          <div className="flex items-center space-x-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push('/sign-in')}
              className="h-8 w-8 p-0 rounded-full bg-blue-100 text-blue-600 hover:bg-blue-200"
            >
              <User className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
};

export default DashboardHeader;