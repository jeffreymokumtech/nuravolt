import { useState, useCallback } from 'react';

interface ToastProps {
  title?: string;
  description?: string;
  variant?: 'default' | 'destructive';
}

export function useToast() {
  const [toasts, setToasts] = useState<ToastProps[]>([]);

  const toast = useCallback(({ title, description, variant = 'default' }: ToastProps) => {
    console.log(`Toast: ${title} - ${description}`);
    // Simple implementation for now
  }, []);

  const dismiss = useCallback(() => {
    setToasts([]);
  }, []);

  return {
    toast,
    dismiss,
    toasts
  };
}