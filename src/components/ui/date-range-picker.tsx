'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { CalendarIcon, X } from 'lucide-react';

export interface DateRange {
  start: string; // YYYY-MM-DD format
  end: string;   // YYYY-MM-DD format
}

interface DateRangePickerProps {
  value?: DateRange;
  onChange?: (range: DateRange | null) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

const QUICK_RANGES = [
  { label: 'Today', days: 0 },
  { label: 'Yesterday', days: 1, offset: 1 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'This month', days: 0, currentMonth: true },
  { label: 'Last month', days: 0, lastMonth: true },
];

function formatDateForInput(date: Date): string {
  return date.toISOString().split('T')[0];
}

function createDateRange(days: number, offset = 0, currentMonth = false, lastMonth = false): DateRange {
  const end = new Date();
  end.setDate(end.getDate() - offset);
  
  let start: Date;
  
  if (currentMonth) {
    start = new Date(end.getFullYear(), end.getMonth(), 1);
  } else if (lastMonth) {
    start = new Date(end.getFullYear(), end.getMonth() - 1, 1);
    end.setDate(0); // Last day of previous month
  } else {
    start = new Date(end);
    start.setDate(start.getDate() - days + (offset > 0 ? 0 : 1));
    if (offset > 0) {
      end.setDate(end.getDate() - 1);
    }
  }
  
  return {
    start: formatDateForInput(start),
    end: formatDateForInput(end)
  };
}

export default function DateRangePicker({ 
  value, 
  onChange, 
  placeholder = "Select date range",
  className = "",
  disabled = false
}: DateRangePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [startDate, setStartDate] = useState(value?.start || '');
  const [endDate, setEndDate] = useState(value?.end || '');

  const handleApply = () => {
    if (startDate && endDate) {
      // Validate date range
      const start = new Date(startDate);
      const end = new Date(endDate);
      
      if (start <= end && !isNaN(start.getTime()) && !isNaN(end.getTime())) {
        onChange?.({ start: startDate, end: endDate });
      } else {
        console.warn('Invalid date range selected');
        return;
      }
    }
    setIsOpen(false);
  };

  const handleClear = () => {
    setStartDate('');
    setEndDate('');
    onChange?.(null);
    setIsOpen(false);
  };

  const handleQuickRange = (range: typeof QUICK_RANGES[0]) => {
    const dateRange = createDateRange(
      range.days, 
      range.offset, 
      range.currentMonth, 
      range.lastMonth
    );
    setStartDate(dateRange.start);
    setEndDate(dateRange.end);
    onChange?.(dateRange);
    setIsOpen(false);
  };

  const displayValue = value 
    ? `${value.start} to ${value.end}`
    : placeholder;

  return (
    <div className={`relative ${className}`}>
      <Button
        variant="outline"
        className="w-full justify-start text-left"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
      >
        <CalendarIcon className="mr-2 h-4 w-4" />
        {displayValue}
      </Button>

      {isOpen && (
        <Card className="absolute top-full left-0 z-50 w-80 mt-1 p-0">
          <CardContent className="p-4">
            {/* Quick Range Buttons */}
            <div className="grid grid-cols-2 gap-2 mb-4">
              {QUICK_RANGES.map((range) => (
                <Button
                  key={range.label}
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => handleQuickRange(range)}
                >
                  {range.label}
                </Button>
              ))}
            </div>

            {/* Custom Date Inputs */}
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-gray-700">Start Date</label>
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">End Date</label>
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="mt-1"
                  min={startDate}
                />
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex justify-between items-center mt-4 pt-3 border-t">
              <Button
                variant="outline"
                size="sm"
                onClick={handleClear}
                className="text-xs"
              >
                <X className="w-3 h-3 mr-1" />
                Clear
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsOpen(false)}
                  className="text-xs"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleApply}
                  disabled={!startDate || !endDate}
                  className="text-xs"
                >
                  Apply
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setIsOpen(false)}
        />
      )}
    </div>
  );
}