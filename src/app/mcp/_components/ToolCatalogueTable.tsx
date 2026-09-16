import { CATALOGUE, type CatalogueTool } from './catalogue';

/**
 * Static tool catalogue table. Server component — no state, no interactivity.
 * Groups by domain, badges each row with scope + read/write.
 */
export default function ToolCatalogueTable() {
  const grouped = CATALOGUE.reduce<Record<string, CatalogueTool[]>>((acc, t) => {
    (acc[t.group] ??= []).push(t);
    return acc;
  }, {});
  const groups = Object.keys(grouped);

  return (
    <div className="border border-divider rounded overflow-hidden bg-paper">
      <table className="w-full text-sm">
        <thead className="bg-paper-2 text-left">
          <tr className="font-mono text-meta uppercase tracking-[0.06em] text-ink-3">
            <th className="px-4 py-3">Tool</th>
            <th className="px-4 py-3">Purpose</th>
            <th className="px-4 py-3">Scope</th>
            <th className="px-4 py-3 text-right">Kind</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-divider">
          {groups.map((group) => (
            <>
              <tr key={`h-${group}`} className="bg-paper-2/60">
                <td colSpan={4} className="px-4 py-2 font-mono text-meta uppercase tracking-[0.06em] text-ink-3">
                  {group}
                </td>
              </tr>
              {grouped[group].map((t) => (
                <tr key={t.name} className="hover:bg-paper-2/60">
                  <td className="px-4 py-3 font-mono text-[13px] text-ink whitespace-nowrap">
                    {t.name}
                  </td>
                  <td className="px-4 py-3 text-body text-ink-2">{t.purpose}</td>
                  <td className="px-4 py-3">
                    <span className="rounded bg-paper-2 border border-divider px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
                      {t.scope}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {t.kind === 'read' ? (
                      <span className="rounded-full px-2 py-0.5 text-[11px] font-medium bg-signal-positive/10 text-signal-positive">
                        read
                      </span>
                    ) : (
                      <span className="rounded-full px-2 py-0.5 text-[11px] font-medium bg-primary/10 text-primary">
                        write
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}
