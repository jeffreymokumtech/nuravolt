'use client';

import { useLanguage, LANGUAGES, type Language } from '@/contexts/LanguageContext';
import { Globe } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface LanguageSwitcherProps {
  variant?: 'default' | 'compact';
}

export default function LanguageSwitcher({ variant = 'default' }: LanguageSwitcherProps) {
  const { language, setLanguage } = useLanguage();

  return (
    <Select value={language} onValueChange={(val) => setLanguage(val as Language)}>
      <SelectTrigger
        className={`border-gray-200 bg-white hover:bg-gray-50 ${
          variant === 'compact' ? 'w-[120px] h-8 text-xs' : 'w-[140px] h-9 text-sm'
        }`}
      >
        <div className="flex items-center gap-1.5">
          <Globe className={variant === 'compact' ? 'w-3 h-3 text-gray-500' : 'w-3.5 h-3.5 text-gray-500'} />
          <SelectValue />
        </div>
      </SelectTrigger>
      <SelectContent>
        {LANGUAGES.map((lang) => (
          <SelectItem key={lang.value} value={lang.value}>
            {lang.nativeLabel}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
