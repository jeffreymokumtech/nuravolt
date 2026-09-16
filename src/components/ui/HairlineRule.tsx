import { cn } from '@/helpers/utils';

interface HairlineRuleProps {
  className?: string;
  orientation?: 'horizontal' | 'vertical';
}

export function HairlineRule({ className, orientation = 'horizontal' }: HairlineRuleProps) {
  if (orientation === 'vertical') {
    return (
      <span
        aria-hidden='true'
        role='separator'
        className={cn('inline-block w-px self-stretch bg-divider', className)}
      />
    );
  }

  return <hr className={cn('border-0 h-px bg-divider', className)} />;
}

export default HairlineRule;
