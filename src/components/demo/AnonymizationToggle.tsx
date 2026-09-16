'use client';

import { useAnonymization } from '@/contexts/AnonymizationContext';
import { Switch } from '@/components/ui/switch';
import { EyeOff, Eye } from 'lucide-react';

interface AnonymizationToggleProps {
  variant?: 'compact' | 'full';
}

export default function AnonymizationToggle({ variant = 'compact' }: AnonymizationToggleProps) {
  const { isAnonymized, setAnonymized } = useAnonymization();

  if (variant === 'full') {
    return (
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium text-ink">Demo Anonymization</p>
          <p className="text-sm text-ink-3">
            Hide geographic identifiers from plant names and locations
          </p>
        </div>
        <Switch
          checked={isAnonymized}
          onCheckedChange={setAnonymized}
        />
      </div>
    );
  }

  return (
    <button
      onClick={() => setAnonymized(!isAnonymized)}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
        isAnonymized
          ? 'bg-indigo-50 border-indigo-300 text-indigo-700 hover:bg-indigo-100'
          : 'bg-white border-gray-300 text-ink-2 hover:bg-gray-50'
      }`}
      title={isAnonymized ? 'Show real names' : 'Anonymize names'}
    >
      {isAnonymized ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      <span className="hidden sm:inline">{isAnonymized ? 'Anonymized' : 'Anonymize'}</span>
    </button>
  );
}
