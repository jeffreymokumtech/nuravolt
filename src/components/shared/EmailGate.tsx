'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { X, Mail, Loader2, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface EmailGateProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (email: string, name: string) => void;
  title: string;
  description: string;
  contentType: 'case_study' | 'roi_results';
  contentId: string;
}

export default function EmailGate({
  isOpen,
  onClose,
  onSuccess,
  title,
  description,
  contentType,
  contentId
}: EmailGateProps) {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    honeypot: '' // Anti-spam field
  });

  const [utmParams, setUtmParams] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [error, setError] = useState('');

  // Capture UTM parameters on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const utm: Record<string, string> = {};

      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'].forEach(key => {
        const value = params.get(key);
        if (value) utm[key] = value;
      });

      setUtmParams(utm);
    }
  }, []);

  // Reset form when modal closes
  useEffect(() => {
    if (!isOpen) {
      setFormData({ name: '', email: '', honeypot: '' });
      setShowSuccess(false);
      setError('');
    }
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Honeypot check
    if (formData.honeypot) {
      return; // Bot detected
    }

    // Basic validation
    if (!formData.email || !formData.name) {
      setError('Please fill in all required fields');
      return;
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(formData.email)) {
      setError('Please enter a valid email address');
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch('/api/leads/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          resourceSlug: contentId,
          resourceType: contentType,
          resourceTitle: title,
          utmParams
        })
      });

      if (!response.ok) {
        throw new Error('Failed to submit form');
      }

      // Track conversion event
      if (typeof window !== 'undefined' && (window as any).posthog) {
        (window as any).posthog.capture(`${contentType}_unlocked`, {
          content_id: contentId,
          content_title: title,
          user_email: formData.email
        });
      }

      setShowSuccess(true);

      // Wait for success animation, then close and trigger onSuccess
      setTimeout(() => {
        onSuccess(formData.email, formData.name);
        onClose();
      }, 1500);

    } catch (err) {
      console.error('Email gate submission error:', err);
      setError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
          />

          {/* Modal */}
          <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-paper rounded shadow-sm max-w-md w-full p-8 relative"
            >
              {/* Close button */}
              <button
                onClick={onClose}
                className="absolute top-4 right-4 text-ink-3 hover:text-ink-2 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>

              {/* Success State */}
              {showSuccess ? (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-center py-8"
                >
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 200, damping: 15 }}
                  >
                    <CheckCircle2 className="w-16 h-16 text-primary mx-auto mb-4" />
                  </motion.div>
                  <h3 className="text-2xl font-bold text-ink mb-2">
                    You're all set!
                  </h3>
                  <p className="text-ink-2">
                    Loading your content...
                  </p>
                </motion.div>
              ) : (
                <>
                  {/* Icon */}
                  <div className="w-12 h-12 bg-paper-2 rounded-full flex items-center justify-center mb-6">
                    <Mail className="w-6 h-6 text-primary" />
                  </div>

                  {/* Header */}
                  <h2 className="text-2xl font-bold text-ink mb-2">
                    {title}
                  </h2>
                  <p className="text-ink-2 mb-6">
                    {description}
                  </p>

                  {/* Form */}
                  <form onSubmit={handleSubmit} className="space-y-4">
                    {/* Name */}
                    <div>
                      <Label htmlFor="name" className="text-ink-2 font-medium mb-2 block">
                        Full Name *
                      </Label>
                      <Input
                        id="name"
                        type="text"
                        placeholder="John Smith"
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        className="w-full border-divider focus:border-divider focus:ring-ring"
                        required
                      />
                    </div>

                    {/* Email */}
                    <div>
                      <Label htmlFor="email" className="text-ink-2 font-medium mb-2 block">
                        Work Email *
                      </Label>
                      <Input
                        id="email"
                        type="email"
                        placeholder="john@company.com"
                        value={formData.email}
                        onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                        className="w-full border-divider focus:border-divider focus:ring-ring"
                        required
                      />
                    </div>

                    {/* Honeypot (hidden) */}
                    <input
                      type="text"
                      name="website"
                      value={formData.honeypot}
                      onChange={(e) => setFormData({ ...formData, honeypot: e.target.value })}
                      className="hidden"
                      tabIndex={-1}
                      autoComplete="off"
                    />

                    {/* Error Message */}
                    {error && (
                      <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="bg-signal-critical/5 border border-signal-critical/40 text-red-800 rounded-lg p-3 text-sm"
                      >
                        {error}
                      </motion.div>
                    )}

                    {/* Submit Button */}
                    <Button
                      type="submit"
                      disabled={isSubmitting}
                      className="w-full bg-primary hover:bg-primary text-white py-3 rounded-lg font-semibold transition-colors"
                    >
                      {isSubmitting ? (
                        <>
                          <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                          Submitting...
                        </>
                      ) : (
                        'Continue'
                      )}
                    </Button>

                    {/* Privacy Note */}
                    <p className="text-xs text-ink-3 text-center">
                      We respect your privacy. No spam, unsubscribe anytime.
                    </p>
                  </form>
                </>
              )}
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
