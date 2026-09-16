'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { format, subDays, subMonths, startOfYear, startOfMonth, endOfMonth, addMonths, isSameDay, isWithinInterval, isBefore, isAfter } from 'date-fns';

export interface DateRange {
  start: Date | null;
  end: Date | null;
}

interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  minDate?: Date;
  maxDate?: Date;
  className?: string;
}

// Presets are generated relative to maxDate (end of available data), not today
function getPresets(anchor: Date) {
  return [
    { label: 'Last 7 days', getValue: () => ({ start: subDays(anchor, 7), end: anchor }) },
    { label: 'Last 30 days', getValue: () => ({ start: subDays(anchor, 30), end: anchor }) },
    { label: 'Last 90 days', getValue: () => ({ start: subDays(anchor, 90), end: anchor }) },
    { label: 'This month', getValue: () => ({ start: startOfMonth(anchor), end: anchor }) },
    { label: 'Last month', getValue: () => {
      const lastMonth = subMonths(anchor, 1);
      return { start: startOfMonth(lastMonth), end: endOfMonth(lastMonth) };
    }},
    { label: 'All data', getValue: () => ({ start: subMonths(anchor, 24), end: anchor }) },
  ];
}

export default function DateRangePicker({
  value,
  onChange,
  minDate,
  maxDate,
  className = '',
}: DateRangePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  // Initialize calendar to the selected end date, maxDate, or today
  const [currentMonth, setCurrentMonth] = useState(
    value.end ?? maxDate ?? new Date()
  );
  const [selectingEnd, setSelectingEnd] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep calendar month in sync when value changes externally
  useEffect(() => {
    if (value.end) setCurrentMonth(value.end);
    else if (maxDate) setCurrentMonth(maxDate);
  }, [value.end, maxDate]);

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

  const handleDateClick = (date: Date) => {
    if (!selectingEnd || !value.start) {
      // Selecting start date
      onChange({ start: date, end: null });
      setSelectingEnd(true);
    } else {
      // Selecting end date
      if (isBefore(date, value.start)) {
        // If clicked date is before start, swap them
        onChange({ start: date, end: value.start });
      } else {
        onChange({ start: value.start, end: date });
      }
      setSelectingEnd(false);
      setIsOpen(false);
    }
  };

  const presets = getPresets(maxDate ?? new Date());

  const handlePresetClick = (preset: ReturnType<typeof getPresets>[0]) => {
    const range = preset.getValue();
    // Clamp to minDate if needed
    if (minDate && isBefore(range.start, minDate)) {
      range.start = minDate;
    }
    onChange(range);
    setIsOpen(false);
  };

  const clearSelection = () => {
    onChange({ start: null, end: null });
    setSelectingEnd(false);
  };

  const getDaysInMonth = (date: Date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const days: (Date | null)[] = [];

    // Add empty slots for days before the first day of month
    for (let i = 0; i < firstDay.getDay(); i++) {
      days.push(null);
    }

    // Add all days in the month
    for (let d = 1; d <= lastDay.getDate(); d++) {
      days.push(new Date(year, month, d));
    }

    return days;
  };

  const isInRange = (date: Date) => {
    if (!value.start || !value.end) return false;
    return isWithinInterval(date, { start: value.start, end: value.end });
  };

  const isDisabled = (date: Date) => {
    if (minDate && isBefore(date, minDate)) return true;
    if (maxDate && isAfter(date, maxDate)) return true;
    return false;
  };

  const displayValue = () => {
    if (!value.start && !value.end) return 'Select date range';
    if (value.start && !value.end) return `${format(value.start, 'MMM d, yyyy')} - ...`;
    if (value.start && value.end) {
      return `${format(value.start, 'MMM d, yyyy')} - ${format(value.end, 'MMM d, yyyy')}`;
    }
    return 'Select date range';
  };

  const days = getDaysInMonth(currentMonth);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 px-3 py-2 text-sm border rounded-lg transition-all ${
          isOpen
            ? 'border-blue-500 ring-2 ring-blue-100 bg-white'
            : value.start
            ? 'border-blue-300 bg-blue-50 text-blue-700'
            : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
        }`}
      >
        <Calendar className="w-4 h-4" />
        <span className="whitespace-nowrap">{displayValue()}</span>
        {value.start && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              clearSelection();
            }}
            className="p-0.5 hover:bg-gray-200 rounded"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </button>

      {/* Dropdown */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute top-full left-0 mt-2 bg-white border border-gray-200 rounded-xl shadow-xl z-50 overflow-hidden"
          >
            <div className="flex">
              {/* Presets */}
              <div className="w-40 border-r border-gray-200 p-2">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide px-2 py-1">
                  Quick Select
                </div>
                {presets.map((preset) => (
                  <button
                    key={preset.label}
                    onClick={() => handlePresetClick(preset)}
                    className="w-full text-left px-2 py-1.5 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 rounded transition-colors"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              {/* Calendar */}
              <div className="p-4">
                {/* Month Navigation */}
                <div className="flex items-center justify-between mb-4">
                  <button
                    onClick={() => setCurrentMonth(addMonths(currentMonth, -1))}
                    className="p-1 hover:bg-gray-100 rounded transition-colors"
                  >
                    <ChevronLeft className="w-5 h-5 text-gray-600" />
                  </button>
                  <div className="font-semibold text-gray-900">
                    {format(currentMonth, 'MMMM yyyy')}
                  </div>
                  <button
                    onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
                    className="p-1 hover:bg-gray-100 rounded transition-colors"
                  >
                    <ChevronRight className="w-5 h-5 text-gray-600" />
                  </button>
                </div>

                {/* Day Headers */}
                <div className="grid grid-cols-7 gap-1 mb-2">
                  {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((day) => (
                    <div
                      key={day}
                      className="w-8 h-8 flex items-center justify-center text-xs font-medium text-gray-500"
                    >
                      {day}
                    </div>
                  ))}
                </div>

                {/* Days Grid */}
                <div className="grid grid-cols-7 gap-1">
                  {days.map((day, idx) => {
                    if (!day) {
                      return <div key={`empty-${idx}`} className="w-8 h-8" />;
                    }

                    const isStart = value.start && isSameDay(day, value.start);
                    const isEnd = value.end && isSameDay(day, value.end);
                    const inRange = isInRange(day);
                    const disabled = isDisabled(day);
                    const isToday = isSameDay(day, new Date());

                    return (
                      <button
                        key={day.toISOString()}
                        disabled={disabled}
                        onClick={() => handleDateClick(day)}
                        className={`w-8 h-8 text-sm rounded-full flex items-center justify-center transition-all ${
                          disabled
                            ? 'text-gray-300 cursor-not-allowed'
                            : isStart || isEnd
                            ? 'bg-blue-600 text-white font-semibold'
                            : inRange
                            ? 'bg-blue-100 text-blue-700'
                            : isToday
                            ? 'border border-blue-400 text-blue-600'
                            : 'text-gray-700 hover:bg-gray-100'
                        }`}
                      >
                        {day.getDate()}
                      </button>
                    );
                  })}
                </div>

                {/* Helper Text */}
                <div className="mt-3 text-xs text-gray-500 text-center">
                  {selectingEnd ? 'Select end date' : 'Select start date'}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
