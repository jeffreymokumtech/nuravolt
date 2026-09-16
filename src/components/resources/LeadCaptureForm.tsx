'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Download, Loader2, CheckCircle, Mail } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { exportWhitepaperToPDF, WHITEPAPER_TEMPLATES } from '@/utils/whitepaperPdfExport';

interface LeadCaptureFormProps {
  resourceSlug: string;
  resourceType: 'whitepaper' | 'checklist' | 'dataset';
  resourceTitle: string;
  downloadUrl: string;
}

export default function LeadCaptureForm({
  resourceSlug,
  resourceType,
  resourceTitle,
  downloadUrl
}: LeadCaptureFormProps) {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    company: '',
    role: '',
    region: '',
    capacity: '',
    honeypot: '' // Anti-spam field
  });

  const [utmParams, setUtmParams] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGeneratingPDF, setIsGeneratingPDF] = useState(false);
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

    setIsSubmitting(true);

    try {
      const response = await fetch('/api/leads/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          resourceSlug,
          resourceType,
          resourceTitle,
          downloadUrl,
          utmParams
        })
      });

      if (!response.ok) {
        throw new Error('Failed to submit form');
      }

      const data = await response.json();

      // Track conversion event
      if (typeof window !== 'undefined' && (window as any).posthog) {
        (window as any).posthog.capture('resource_download', {
          resource_slug: resourceSlug,
          resource_type: resourceType,
          resource_title: resourceTitle
        });
      }

      setShowSuccess(true);

    } catch (err) {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  // Map resource slugs to template keys
  const slugToTemplateKey: Record<string, keyof typeof WHITEPAPER_TEMPLATES> = {
    'soiling-intelligence': 'soilingIntelligence',
    'fault-detection-spec': 'faultDetection',
    'transfer-learning': 'transferLearning',
    'forecasting-365day': 'forecastingGuide',
    'digital-twin-config': 'digitalTwinGuide',
  };

  const handleDownloadPDF = async () => {
    setIsGeneratingPDF(true);
    try {
      const templateKey = slugToTemplateKey[resourceSlug];
      if (templateKey && WHITEPAPER_TEMPLATES[templateKey]) {
        const options = WHITEPAPER_TEMPLATES[templateKey]();
        await exportWhitepaperToPDF(options);
      } else {
        // Fallback: open the download URL (for legacy resources)
        window.open(downloadUrl, '_blank');
      }
    } catch (err) {
      console.error('PDF generation failed:', err);
      // Fallback to URL
      window.open(downloadUrl, '_blank');
    } finally {
      setIsGeneratingPDF(false);
    }
  };

  if (showSuccess) {
    const hasTemplate = slugToTemplateKey[resourceSlug] !== undefined;

    return (
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="bg-gradient-to-br from-blue-50 to-green-50 border border-green-200 rounded-lg p-8 text-center"
        >
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-8 h-8 text-green-500" />
          </div>
          <h3 className="text-2xl font-bold text-gray-900 mb-2">
            Thank you, {formData.name.split(' ')[0]}!
          </h3>
          <p className="text-gray-600 mb-6">
            Your download is ready. Click below to get your copy.
          </p>

          {/* Primary Download Button */}
          <Button
            onClick={handleDownloadPDF}
            disabled={isGeneratingPDF}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white mb-4"
            size="lg"
          >
            {isGeneratingPDF ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Generating PDF...
              </>
            ) : (
              <>
                <Download className="w-5 h-5 mr-2" />
                Download {hasTemplate ? 'PDF' : resourceTitle}
              </>
            )}
          </Button>

          {/* Email confirmation */}
          <div className="flex items-center justify-center gap-2 text-sm text-gray-500 mb-4">
            <Mail className="w-4 h-4" />
            <span>Also sent to <strong>{formData.email}</strong></span>
          </div>

          <p className="text-xs text-gray-400">
            Questions? Contact{' '}
            <a href="mailto:jeffrey@nuravolt.com" className="text-blue-600 hover:underline">
              jeffrey@nuravolt.com
            </a>
          </p>
        </motion.div>
      </AnimatePresence>
    );
  }

  return (
    <motion.form
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      onSubmit={handleSubmit}
      className="bg-white border border-gray-200 rounded-lg p-6 shadow-lg"
    >
      <h3 className="text-xl font-bold text-gray-900 mb-4">
        Download {resourceTitle}
      </h3>
      <p className="text-sm text-gray-600 mb-6">
        Enter your details to get instant access to this free resource.
      </p>

      {error && (
        <div className="bg-blue-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {/* Name */}
        <div>
          <Label htmlFor="name" className="text-gray-700">
            Full Name <span className="text-red-500">*</span>
          </Label>
          <Input
            id="name"
            type="text"
            value={formData.name}
            onChange={(e) => handleChange('name', e.target.value)}
            placeholder="John Smith"
            required
            className="mt-1"
          />
        </div>

        {/* Email */}
        <div>
          <Label htmlFor="email" className="text-gray-700">
            Work Email <span className="text-red-500">*</span>
          </Label>
          <Input
            id="email"
            type="email"
            value={formData.email}
            onChange={(e) => handleChange('email', e.target.value)}
            placeholder="john@company.com"
            required
            className="mt-1"
          />
        </div>

        {/* Company */}
        <div>
          <Label htmlFor="company" className="text-gray-700">
            Company
          </Label>
          <Input
            id="company"
            type="text"
            value={formData.company}
            onChange={(e) => handleChange('company', e.target.value)}
            placeholder="Acme Solar"
            className="mt-1"
          />
        </div>

        {/* Role */}
        <div>
          <Label htmlFor="role" className="text-gray-700">
            Job Title
          </Label>
          <Input
            id="role"
            type="text"
            value={formData.role}
            onChange={(e) => handleChange('role', e.target.value)}
            placeholder="O&M Manager"
            className="mt-1"
          />
        </div>

        {/* Region */}
        <div>
          <Label htmlFor="region" className="text-gray-700">
            Region
          </Label>
          <Select value={formData.region} onValueChange={(value) => handleChange('region', value)}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Select region" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="uae">UAE</SelectItem>
              <SelectItem value="ksa">Saudi Arabia</SelectItem>
              <SelectItem value="qatar">Qatar</SelectItem>
              <SelectItem value="oman">Oman</SelectItem>
              <SelectItem value="kuwait">Kuwait</SelectItem>
              <SelectItem value="bahrain">Bahrain</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Plant Capacity */}
        <div>
          <Label htmlFor="capacity" className="text-gray-700">
            Plant Capacity (MW)
          </Label>
          <Input
            id="capacity"
            type="text"
            value={formData.capacity}
            onChange={(e) => handleChange('capacity', e.target.value)}
            placeholder="50"
            className="mt-1"
          />
        </div>

        {/* Honeypot field (hidden) */}
        <input
          type="text"
          name="website"
          value={formData.honeypot}
          onChange={(e) => handleChange('honeypot', e.target.value)}
          style={{ position: 'absolute', left: '-9999px' }}
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      <Button
        type="submit"
        disabled={isSubmitting}
        className="w-full mt-6 bg-blue-600 hover:bg-blue-700"
      >
        {isSubmitting ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Processing...
          </>
        ) : (
          <>
            <Download className="w-4 h-4 mr-2" />
            Download Now
          </>
        )}
      </Button>

      <p className="text-xs text-gray-500 mt-4 text-center">
        By downloading, you agree to our{' '}
        <a href="/privacy-policy" className="text-blue-600 hover:underline">
          Privacy Policy
        </a>
        . Unsubscribe anytime.
      </p>
    </motion.form>
  );
}
