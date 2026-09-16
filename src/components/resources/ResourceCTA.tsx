'use client';

import { motion } from 'framer-motion';
import { ArrowRight, Download, FileText } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

interface ResourceCTAProps {
  title: string;
  description: string;
  resourceSlug: string;
  variant?: 'banner' | 'card' | 'inline';
  className?: string;
}

export default function ResourceCTA({
  title,
  description,
  resourceSlug,
  variant = 'banner',
  className = '',
}: ResourceCTAProps) {
  if (variant === 'banner') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        className={`bg-data-bg text-data-fg rounded-sm p-8 my-12 ${className}`}
      >
        <div className='flex flex-col md:flex-row items-start md:items-center justify-between gap-6'>
          <div className='flex-1'>
            <div className='flex items-center font-mono text-meta uppercase tracking-[0.08em] text-data-fg-2 mb-3'>
              <FileText className='w-3.5 h-3.5 mr-2' />
              Free resource
            </div>
            <h3 className='text-h2 font-semibold mb-2'>{title}</h3>
            <p className='text-body text-data-fg-2'>{description}</p>
          </div>
          <Button asChild size='lg' variant='secondary' className='bg-paper text-ink hover:bg-paper-2 whitespace-nowrap'>
            <Link href={`/resources/${resourceSlug}`}>
              <Download className='w-4 h-4 mr-2' />
              Download
              <ArrowRight className='w-4 h-4 ml-2' />
            </Link>
          </Button>
        </div>
      </motion.div>
    );
  }

  if (variant === 'card') {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true }}
        className={`bg-paper border border-divider rounded-sm p-6 my-8 ${className}`}
      >
        <div className='flex items-start gap-4'>
          <div className='bg-paper-2 rounded-sm p-3 flex-shrink-0'>
            <FileText className='w-5 h-5 text-ink-2' />
          </div>
          <div className='flex-1'>
            <h4 className='text-h2 font-semibold text-ink mb-2'>{title}</h4>
            <p className='text-body text-ink-2 mb-4'>{description}</p>
            <Button asChild variant='outline'>
              <Link href={`/resources/${resourceSlug}`}>
                <Download className='w-4 h-4 mr-2' />
                Download
              </Link>
            </Button>
          </div>
        </div>
      </motion.div>
    );
  }

  // inline variant
  return (
    <div className={`inline-flex items-center gap-2 my-4 ${className}`}>
      <Download className='w-4 h-4 text-primary' />
      <Link
        href={`/resources/${resourceSlug}`}
        className='text-primary hover:underline font-semibold'
      >
        {title} →
      </Link>
    </div>
  );
}
