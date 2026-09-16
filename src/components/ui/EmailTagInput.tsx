'use client';

import { useState, useRef, KeyboardEvent, ClipboardEvent } from 'react';
import { X } from 'lucide-react';

interface EmailTagInputProps {
  emails: string[];
  onChange: (emails: string[]) => void;
  placeholder?: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function EmailTagInput({
  emails,
  onChange,
  placeholder = 'Add email address...',
}: EmailTagInputProps) {
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addEmail = (raw: string) => {
    const email = raw.trim().toLowerCase();
    if (!email) return false;

    if (!EMAIL_REGEX.test(email)) {
      setError(true);
      setTimeout(() => setError(false), 1000);
      return false;
    }

    if (emails.includes(email)) return false;

    onChange([...emails, email]);
    return true;
  };

  const addMultiple = (text: string) => {
    const candidates = text.split(/[,;\s\n]+/).filter(Boolean);
    const added: string[] = [];
    for (const c of candidates) {
      const email = c.trim().toLowerCase();
      if (EMAIL_REGEX.test(email) && !emails.includes(email) && !added.includes(email)) {
        added.push(email);
      }
    }
    if (added.length > 0) {
      onChange([...emails, ...added]);
    }
  };

  const removeEmail = (email: string) => {
    onChange(emails.filter(e => e !== email));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      e.preventDefault();
      if (addEmail(inputValue)) {
        setInputValue('');
      }
    } else if (e.key === 'Backspace' && !inputValue && emails.length > 0) {
      removeEmail(emails[emails.length - 1]);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text');
    addMultiple(text);
    setInputValue('');
  };

  const handleBlur = () => {
    if (inputValue.trim()) {
      if (addEmail(inputValue)) {
        setInputValue('');
      }
    }
  };

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className={`flex flex-wrap gap-1.5 p-2 min-h-[42px] border rounded-lg cursor-text transition-colors ${
        error
          ? 'border-red-400 bg-red-50'
          : 'border-gray-300 bg-white focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500'
      }`}
    >
      {emails.map((email) => (
        <span
          key={email}
          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 rounded-full"
        >
          {email}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              removeEmail(email);
            }}
            className="hover:bg-blue-200 rounded-full p-0.5 transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onBlur={handleBlur}
        placeholder={emails.length === 0 ? placeholder : ''}
        className="flex-1 min-w-[120px] text-sm outline-none bg-transparent"
      />
    </div>
  );
}
