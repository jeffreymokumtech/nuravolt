import Link from 'next/link';

interface OpsDemoStripProps {
  totalCapacityMw?: number;
  plantCount?: number;
  ctaHref?: string;
}

export default function OpsDemoStrip({
  totalCapacityMw = 45,
  plantCount = 10,
  ctaHref = '/#contact',
}: OpsDemoStripProps) {
  return (
    <div
      className="flex items-center justify-between px-4 font-mono text-[10.5px] uppercase tracking-wider"
      style={{
        height: 22,
        background: 'var(--ops-panel-2)',
        borderBottom: '1px solid var(--ops-hair)',
        color: 'var(--ops-muted)',
      }}
    >
      <div className="flex items-center gap-2">
        <span style={{ color: 'var(--ops-bright)', fontWeight: 600 }}>DEMO</span>
        <span style={{ color: 'var(--ops-dim)' }}>|</span>
        <span>
          <span style={{ color: 'var(--ops-txt)' }}>{totalCapacityMw} MW</span>
          {' sample portfolio '}
          <span style={{ color: 'var(--ops-dim)' }}>·</span>
          {' '}
          <span style={{ color: 'var(--ops-txt)' }}>{plantCount} plants</span>
          {' '}
          <span style={{ color: 'var(--ops-dim)' }}>·</span>
          {' anonymised'}
        </span>
      </div>

      <Link
        href={ctaHref}
        className="transition-colors hover:opacity-80"
        style={{ color: 'var(--ops-info)' }}
      >
        Get your demo →
      </Link>
    </div>
  );
}
