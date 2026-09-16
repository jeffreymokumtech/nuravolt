'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import HoneypotField from '@/components/HoneypotField';
import { trackLeadCaptured } from '@/utils/analytics';

interface BookingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const BookingModal = ({ isOpen, onClose }: BookingModalProps) => {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [honeypot, setHoneypot] = useState('');
  const [formData, setFormData] = useState({
    email: '',
    companyName: '',
    plantCapacityMw: '',
    message: ''
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Check honeypot
    if (honeypot) {
      console.warn('Bot detected via honeypot');
      onClose();
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: formData.email,
          companyName: formData.companyName,
          plantCapacityMw: formData.plantCapacityMw || undefined,
          message: formData.message,
          honeypot
        })
      });

      if (!response.ok) {
        throw new Error('Failed to submit form');
      }

      // Track lead capture
      trackLeadCaptured('contact_form', 'warm');

      toast({
        title: 'Message Sent!',
        description: 'Thanks for reaching out. We\'ll get back to you soon.',
      });

      // Reset form
      setFormData({
        email: '',
        companyName: '',
        plantCapacityMw: '',
        message: ''
      });

      onClose();
    } catch (error) {
      toast({
        title: 'Failed to send message',
        description: 'Please try again or email us at contact@nuravolt.com',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Get in Touch</DialogTitle>
          <DialogDescription>
            Tell us about your solar operations and we&apos;ll get back to you within 24 hours.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Business Email *</Label>
            <Input
              id="email"
              type="email"
              required
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              placeholder="your@company.com"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="company">Company Name *</Label>
            <Input
              id="company"
              type="text"
              required
              value={formData.companyName}
              onChange={(e) => setFormData({ ...formData, companyName: e.target.value })}
              placeholder="Your Company"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="capacity">Plant Capacity (MW)</Label>
            <Input
              id="capacity"
              type="number"
              value={formData.plantCapacityMw}
              onChange={(e) => setFormData({ ...formData, plantCapacityMw: e.target.value })}
              placeholder="50"
              min="1"
              step="0.1"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="message">Message</Label>
            <Textarea
              id="message"
              value={formData.message}
              onChange={(e) => setFormData({ ...formData, message: e.target.value })}
              placeholder="Tell us about your current challenges or what you'd like to learn..."
              rows={3}
            />
          </div>

          <HoneypotField
            value={honeypot}
            onChange={setHoneypot}
          />

          <div className="flex gap-3 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting}
              className="flex-1"
            >
              {isSubmitting ? 'Sending...' : 'Send Message'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default BookingModal;