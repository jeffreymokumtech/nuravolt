'use client';

import { motion } from 'framer-motion';

export type Severity = 'critical' | 'warning' | 'info';

interface SeverityCount {
  critical: number;
  warning: number;
  info: number;
}

interface SeverityFilterButtonsProps {
  selected: Severity[];
  onChange: (selected: Severity[]) => void;
  counts: SeverityCount;
  showAll?: boolean;
}

const SEVERITY_CONFIG: Record<Severity, { label: string; color: string; bgColor: string; borderColor: string; activeColor: string }> = {
  critical: {
    label: 'Critical',
    color: 'text-red-700',
    bgColor: 'bg-red-50',
    borderColor: 'border-red-200',
    activeColor: 'bg-red-600',
  },
  warning: {
    label: 'Warning',
    color: 'text-amber-700',
    bgColor: 'bg-amber-50',
    borderColor: 'border-amber-200',
    activeColor: 'bg-amber-500',
  },
  info: {
    label: 'Info',
    color: 'text-blue-700',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
    activeColor: 'bg-blue-500',
  },
};

export default function SeverityFilterButtons({
  selected,
  onChange,
  counts,
  showAll = true,
}: SeverityFilterButtonsProps) {
  const toggleSeverity = (severity: Severity) => {
    if (selected.includes(severity)) {
      onChange(selected.filter((s) => s !== severity));
    } else {
      onChange([...selected, severity]);
    }
  };

  const selectAll = () => {
    onChange(['critical', 'warning', 'info']);
  };

  const isAllSelected = selected.length === 0 || selected.length === 3;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {showAll && (
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={selectAll}
          className={`px-3 py-1.5 text-sm font-medium rounded-lg border transition-all ${
            isAllSelected
              ? 'bg-gray-900 text-white border-gray-900'
              : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
          }`}
        >
          All
          <span className={`ml-1.5 px-1.5 py-0.5 text-xs rounded-full ${
            isAllSelected ? 'bg-gray-700 text-gray-200' : 'bg-gray-100 text-gray-500'
          }`}>
            {counts.critical + counts.warning + counts.info}
          </span>
        </motion.button>
      )}

      {(Object.keys(SEVERITY_CONFIG) as Severity[]).map((severity) => {
        const config = SEVERITY_CONFIG[severity];
        const isSelected = selected.includes(severity) || isAllSelected;
        const count = counts[severity];

        return (
          <motion.button
            key={severity}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => toggleSeverity(severity)}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg border transition-all ${
              isSelected && !isAllSelected
                ? `${config.activeColor} text-white border-transparent`
                : isSelected
                ? `${config.bgColor} ${config.color} ${config.borderColor}`
                : 'bg-white text-gray-400 border-gray-200 opacity-60 hover:opacity-100'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  isSelected ? 'bg-current' : 'bg-gray-300'
                }`}
              />
              {config.label}
            </span>
            <span
              className={`ml-1.5 px-1.5 py-0.5 text-xs rounded-full ${
                isSelected && !isAllSelected
                  ? 'bg-white/20 text-white'
                  : isSelected
                  ? 'bg-white text-inherit'
                  : 'bg-gray-100 text-gray-400'
              }`}
            >
              {count}
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}
