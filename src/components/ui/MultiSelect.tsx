'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, ChevronDown, X, Search } from 'lucide-react';

interface MultiSelectProps {
  options: string[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
  label?: string;
  maxDisplay?: number;
  searchable?: boolean;
}

export default function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = 'Select items...',
  label,
  maxDisplay = 3,
  searchable = true,
}: MultiSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredOptions = options.filter((opt) =>
    opt.toLowerCase().includes(search.toLowerCase())
  );

  const toggleOption = (option: string) => {
    if (selected.includes(option)) {
      onChange(selected.filter((s) => s !== option));
    } else {
      onChange([...selected, option]);
    }
  };

  const selectAll = () => {
    onChange([...options]);
  };

  const clearAll = () => {
    onChange([]);
  };

  const displayValue = () => {
    if (selected.length === 0) return placeholder;
    if (selected.length === options.length) return 'All selected';
    if (selected.length <= maxDisplay) return selected.join(', ');
    return `${selected.slice(0, maxDisplay).join(', ')} +${selected.length - maxDisplay} more`;
  };

  return (
    <div ref={containerRef} className="relative">
      {label && (
        <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
          {label}
        </label>
      )}

      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm border rounded-lg transition-all text-left ${
          isOpen
            ? 'border-blue-500 ring-2 ring-blue-100'
            : selected.length > 0
            ? 'border-blue-300 bg-blue-50'
            : 'border-gray-300 hover:border-gray-400'
        }`}
      >
        <span className={`truncate ${selected.length === 0 ? 'text-gray-400' : 'text-gray-700'}`}>
          {displayValue()}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-gray-400 transition-transform flex-shrink-0 ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* Dropdown */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl z-50 overflow-hidden"
          >
            {/* Search */}
            {searchable && (
              <div className="p-2 border-b border-gray-100">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search..."
                    className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:border-blue-400"
                    autoFocus
                  />
                </div>
              </div>
            )}

            {/* Quick Actions */}
            <div className="flex items-center gap-2 px-2 py-1.5 border-b border-gray-100 bg-gray-50">
              <button
                onClick={selectAll}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium"
              >
                Select All
              </button>
              <span className="text-gray-300">|</span>
              <button
                onClick={clearAll}
                className="text-xs text-gray-500 hover:text-gray-700 font-medium"
              >
                Clear
              </button>
              <span className="ml-auto text-xs text-gray-400">
                {selected.length}/{options.length}
              </span>
            </div>

            {/* Options List */}
            <div className="max-h-60 overflow-y-auto">
              {filteredOptions.length === 0 ? (
                <div className="px-3 py-4 text-sm text-gray-500 text-center">
                  No matches found
                </div>
              ) : (
                filteredOptions.map((option) => {
                  const isSelected = selected.includes(option);
                  return (
                    <button
                      key={option}
                      onClick={() => toggleOption(option)}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                        isSelected
                          ? 'bg-blue-50 text-blue-700'
                          : 'text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      <div
                        className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                          isSelected
                            ? 'bg-blue-600 border-blue-600'
                            : 'border-gray-300'
                        }`}
                      >
                        {isSelected && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <span className="truncate">{option}</span>
                    </button>
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Selected Tags (optional visual) */}
      {selected.length > 0 && selected.length <= 5 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {selected.map((item) => (
            <span
              key={item}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full"
            >
              {item}
              <button
                onClick={() => toggleOption(item)}
                className="hover:bg-blue-200 rounded-full p-0.5"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
