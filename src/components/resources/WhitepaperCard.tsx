'use client';

import { motion } from 'framer-motion';
import { FileText, CheckSquare, ArrowRight, Clock, BookOpen } from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';

interface WhitepaperCardProps {
  slug: string;
  title: string;
  description: string;
  type: 'whitepaper' | 'checklist' | 'documentation';
  pages?: number;
  category?: string;
  coverImage?: string;
  insights: string[];
  downloadUrl?: string;
  isDirectDownload?: boolean;
}

export default function WhitepaperCard({
  slug,
  title,
  description,
  type,
  pages,
  category,
  coverImage,
  insights,
  downloadUrl,
  isDirectDownload
}: WhitepaperCardProps) {
  const Icon = type === 'whitepaper' ? FileText : type === 'checklist' ? CheckSquare : BookOpen;

  // Calculate estimated read time (rough estimate: 3 min per page for whitepapers, 1 min for checklists)
  const readTime = type === 'whitepaper' ? (pages || 0) * 3 : 1;

  // Determine topic tags from title
  const getTopicTags = () => {
    const tags = [];
    if (title.toLowerCase().includes('irradiation') || title.toLowerCase().includes('pv') || title.toLowerCase().includes('solar')) {
      tags.push('Solar PV');
    }
    if (title.toLowerCase().includes('inverter')) {
      tags.push('Inverters');
    }
    if (title.toLowerCase().includes('bess') || title.toLowerCase().includes('battery')) {
      tags.push('Battery Storage');
    }
    if (title.toLowerCase().includes('data')) {
      tags.push('Data Quality');
    }
    if (title.toLowerCase().includes('predictive') || title.toLowerCase().includes('detection')) {
      tags.push('Predictive Maintenance');
    }
    return tags;
  };

  const topicTags = getTopicTags();

  const renderCardContent = () => (
    <div className="bg-paper border border-divider rounded-lg overflow-hidden shadow-sm hover:shadow-sm transition-shadow h-full flex flex-col">
      {/* Cover Image */}
      {coverImage ? (
        <div className="relative h-48 bg-paper-2">
          <Image
            src={coverImage}
            alt={title}
            fill
            className="object-cover"
          />
        </div>
      ) : (
        <div className="relative h-48 bg-paper-2 flex items-center justify-center">
          <Icon className="w-16 h-16 text-primary opacity-50" />
        </div>
      )}

      {/* Content */}
      <div className="p-6 flex-1 flex flex-col">
        {/* Type Badge and Category */}
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <span className={`text-xs font-semibold px-3 py-1 rounded-full ${
            type === 'whitepaper'
              ? 'bg-paper-2 text-primary'
              : type === 'checklist'
              ? 'bg-paper-2 text-signal-positive'
              : 'bg-paper-2 text-primary'
          }`}>
            {type === 'whitepaper' ? 'Technical Guide' : type === 'checklist' ? 'Practical Tool' : 'Reference Doc'}
            {pages && ` • ${pages} page${pages > 1 ? 's' : ''}`}
          </span>
          {category && (
            <span className="text-xs font-medium px-2 py-1 bg-paper-2 text-ink-2 rounded">
              {category}
            </span>
          )}
        </div>

        {/* Topic Tags */}
        {topicTags.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {topicTags.map((tag, index) => (
              <span
                key={index}
                className="text-xs px-2 py-1 bg-paper-2 text-primary rounded border border-divider"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Title */}
        <h3 className="text-xl font-bold text-ink mb-2 group-hover:text-primary transition-colors line-clamp-2">
          {title}
        </h3>

        {/* Description */}
        <p className="text-ink-2 text-sm mb-4 flex-1 line-clamp-3">
          {description}
        </p>

        {/* Read Time */}
        <div className="flex items-center text-xs text-ink-3 mb-4">
          <Clock className="w-3 h-3 mr-1" />
          <span>{readTime} min read</span>
          <span className="mx-2">•</span>
          <BookOpen className="w-3 h-3 mr-1" />
          <span>Free Download</span>
        </div>

        {/* Key Insights */}
        {insights && insights.length > 0 && (
          <div className="mb-4">
            <p className="text-xs font-semibold text-ink-3 uppercase mb-2">
              What you'll learn:
            </p>
            <ul className="space-y-1">
              {insights.slice(0, 3).map((insight, index) => (
                <li key={index} className="text-sm text-ink-2 flex items-start">
                  <span className="text-primary mr-2 mt-0.5">✓</span>
                  <span className="line-clamp-1">{insight}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* CTA */}
        <div className="mt-auto pt-4 border-t border-divider">
          <div className="flex items-center justify-between">
            <span className="text-primary font-semibold group-hover:text-primary transition-colors">
              {isDirectDownload ? 'View Documentation' : 'Download Now'}
            </span>
            <div className="flex items-center text-primary group-hover:text-primary">
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <motion.div
      whileHover={{ y: -5 }}
      transition={{ type: 'spring', stiffness: 300 }}
      className="group"
    >
      {isDirectDownload && downloadUrl ? (
        <a
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {renderCardContent()}
        </a>
      ) : (
        <Link href={`/resources/${slug}`}>
          {renderCardContent()}
        </Link>
      )}
    </motion.div>
  );
}
