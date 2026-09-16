import { ElementType, ReactNode } from 'react';
import { cn } from '@/helpers/utils';

interface MarketingSectionProps {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
  surface?: 'paper' | 'paper-2' | 'data';
  size?: 'default' | 'hero' | 'compact';
  as?: ElementType;
  id?: string;
}

const surfaceClass = {
  paper: 'bg-paper text-ink',
  'paper-2': 'bg-paper-2 text-ink',
  data: 'bg-data-bg text-data-fg',
} as const;

const sizeClass = {
  default: 'py-16',
  hero: 'py-24',
  compact: 'py-10',
} as const;

export function MarketingSection({
  children,
  className,
  innerClassName,
  surface = 'paper',
  size = 'default',
  as: Tag = 'section',
  id,
}: MarketingSectionProps) {
  return (
    <Tag id={id} className={cn(surfaceClass[surface], sizeClass[size], className)}>
      <div className={cn('container mx-auto px-4 sm:px-6 lg:px-8', innerClassName)}>
        {children}
      </div>
    </Tag>
  );
}

export default MarketingSection;
