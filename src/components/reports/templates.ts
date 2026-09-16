/**
 * Report templates: named widget layouts the new-dashboard chooser (and the
 * demo seeder) instantiate against an org's own plants. Pure data — no
 * client imports — so scripts can reuse it.
 *
 * Grid is 12 columns (DashboardCanvas COLS).
 */

export interface TemplateWidget {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  config: {
    title?: string;
    plantIds?: string[];
    deviceIds?: string[];
    range?: string;
    options?: Record<string, unknown>;
  };
}

export interface BuiltTemplate {
  title: string;
  description: string;
  plantIds: string[];
  widgets: TemplateWidget[];
}

export interface ReportTemplate {
  id: string;
  label: string;
  description: string;
  /** Which plants the template needs to be useful. */
  requires: 'pv' | 'bess' | 'any';
  /**
   * When true, the chooser fetches the plant's worst inverters (by twin loss)
   * before building, and passes them as `worstDevices`. Build must still work
   * without them (generic titles, unset device slots).
   */
  wantsWorstDevices?: boolean;
  build: (opts: {
    pvPlant?: string;
    bessPlant?: string;
    allPlants: string[];
    worstDevices?: string[];
  }) => BuiltTemplate;
}

const kpi = (
  id: string,
  x: number,
  title: string,
  metric: string,
  plant?: string
): TemplateWidget => ({
  id,
  type: 'kpi.single_metric',
  x,
  y: 0,
  w: 3,
  h: 3,
  config: { title, plantIds: plant ? [plant] : undefined, options: { metric } },
});

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    id: 'weekly_ops',
    label: 'Weekly operations review',
    description:
      'Key numbers up top (delivery, twin loss, coverage), energy vs expectation, soiling trend, and live contract status. Adds the battery panel when a storage plant is in scope.',
    requires: 'any',
    build: ({ pvPlant, bessPlant, allPlants }) => {
      const pv = pvPlant ?? allPlants[0];
      const widgets: TemplateWidget[] = [
        kpi('w_tpl_kpi_actual', 0, 'Energy delivered', 'total_actual_mwh', pv),
        kpi('w_tpl_kpi_expected', 3, 'Energy expected', 'total_predicted_mwh', pv),
        kpi('w_tpl_kpi_loss', 6, 'Twin loss', 'avg_loss_pct', pv),
        kpi('w_tpl_kpi_lost', 9, 'Energy lost', 'total_loss_mwh', pv),
        {
          id: 'w_tpl_energy',
          type: 'chart.timeseries',
          x: 0,
          y: 3,
          w: 12,
          h: 6,
          config: {
            title: 'Energy · actual vs expected',
            plantIds: pv ? [pv] : undefined,
            options: { metric: 'power_ac' },
          },
        },
        {
          id: 'w_tpl_evm',
          type: 'pv.expected_vs_measured',
          x: 0,
          y: 9,
          w: 6,
          h: 6,
          config: { title: 'Expected vs measured', plantIds: pv ? [pv] : undefined },
        },
        {
          id: 'w_tpl_sr',
          type: 'chart.timeseries',
          x: 6,
          y: 9,
          w: 6,
          h: 6,
          config: {
            title: 'Soiling ratio trend',
            plantIds: pv ? [pv] : undefined,
            options: { metric: 'soiling_ratio' },
          },
        },
        {
          id: 'w_tpl_contracts',
          type: 'contracts.status',
          x: 0,
          y: 15,
          w: 6,
          h: 5,
          config: { title: 'Contract status' },
        },
      ];
      if (bessPlant) {
        widgets.push(
          {
            id: 'w_tpl_bess_warranty',
            type: 'bess.warranty_status',
            x: 6,
            y: 15,
            w: 6,
            h: 5,
            config: { title: 'Battery warranty', plantIds: [bessPlant] },
          },
          {
            id: 'w_tpl_bess_soh',
            type: 'bess.soh_history',
            x: 0,
            y: 20,
            w: 6,
            h: 6,
            config: { title: 'Battery state of health', plantIds: [bessPlant] },
          },
          {
            id: 'w_tpl_bess_dispatch',
            type: 'bess.dispatch',
            x: 6,
            y: 20,
            w: 6,
            h: 6,
            config: { title: 'Dispatch and prices', plantIds: [bessPlant] },
          }
        );
      }
      return {
        title: 'Weekly operations review',
        description:
          'Energy delivery, twin deviation, soiling, contract obligations, and battery health.',
        plantIds: allPlants,
        widgets,
      };
    },
  },
  {
    id: 'storage_review',
    label: 'Storage review',
    description:
      'Battery-first: warranty position, state-of-health trajectory, dispatch behaviour, and the storage contracts.',
    requires: 'bess',
    build: ({ bessPlant, allPlants }) => {
      const bess = bessPlant ?? allPlants[0];
      return {
        title: 'Storage review',
        description: 'Warranty position, SoH trajectory, and dispatch economics.',
        plantIds: bess ? [bess] : allPlants,
        widgets: [
          {
            id: 'w_tpl_s_warranty',
            type: 'bess.warranty_status',
            x: 0,
            y: 0,
            w: 5,
            h: 6,
            config: { title: 'Warranty position', plantIds: bess ? [bess] : undefined },
          },
          {
            id: 'w_tpl_s_soh',
            type: 'bess.soh_history',
            x: 5,
            y: 0,
            w: 7,
            h: 6,
            config: { title: 'State of health', plantIds: bess ? [bess] : undefined },
          },
          {
            id: 'w_tpl_s_dispatch',
            type: 'bess.dispatch',
            x: 0,
            y: 6,
            w: 7,
            h: 6,
            config: { title: 'Dispatch and prices', plantIds: bess ? [bess] : undefined },
          },
          {
            id: 'w_tpl_s_contracts',
            type: 'contracts.status',
            x: 7,
            y: 6,
            w: 5,
            h: 6,
            config: { title: 'Contract status', plantIds: bess ? [bess] : undefined },
          },
        ],
      };
    },
  },
  {
    id: 'executive_summary',
    label: 'Executive summary',
    description:
      'The helicopter view: headline delivery numbers, portfolio energy trend, and live contract status on one short page. Built for a board pack or a monthly owner update.',
    requires: 'any',
    build: ({ pvPlant, bessPlant, allPlants }) => {
      const pv = pvPlant ?? allPlants[0];
      const widgets: TemplateWidget[] = [
        kpi('w_tpl_x_actual', 0, 'Energy delivered', 'total_actual_mwh', pv),
        kpi('w_tpl_x_expected', 3, 'Energy expected', 'total_predicted_mwh', pv),
        kpi('w_tpl_x_loss', 6, 'Twin loss', 'avg_loss_pct', pv),
        kpi('w_tpl_x_lost', 9, 'Energy lost', 'total_loss_mwh', pv),
        {
          id: 'w_tpl_x_energy',
          type: 'chart.timeseries',
          x: 0,
          y: 3,
          w: 12,
          h: 5,
          config: {
            title: 'Energy · actual vs expected',
            plantIds: pv ? [pv] : undefined,
            options: { metric: 'power_ac' },
          },
        },
        {
          id: 'w_tpl_x_contracts',
          type: 'contracts.status',
          x: 0,
          y: 8,
          w: 6,
          h: 5,
          config: { title: 'Contract status' },
        },
        bessPlant
          ? {
              id: 'w_tpl_x_bess',
              type: 'bess.warranty_status',
              x: 6,
              y: 8,
              w: 6,
              h: 5,
              config: { title: 'Battery warranty', plantIds: [bessPlant] },
            }
          : {
              id: 'w_tpl_x_waterfall',
              type: 'pv.loss_waterfall',
              x: 6,
              y: 8,
              w: 6,
              h: 5,
              config: { title: 'Loss breakdown', plantIds: pv ? [pv] : undefined },
            },
      ];
      return {
        title: 'Executive summary',
        description: 'Headline delivery, energy trend, contract status, and asset health.',
        plantIds: allPlants,
        widgets,
      };
    },
  },
  {
    id: 'inverter_deep_dive',
    label: 'Inverter deep dive',
    description:
      'The low-level view: fleet loss ranking, per-inverter soiling ranking, the worst performers charted against the twin, plus string health and loss breakdown.',
    requires: 'pv',
    wantsWorstDevices: true,
    build: ({ pvPlant, allPlants, worstDevices }) => {
      const pv = pvPlant ?? allPlants[0];
      const pvScope = pv ? [pv] : undefined;
      const worst = worstDevices ?? [];
      const widgets: TemplateWidget[] = [
        {
          id: 'w_tpl_d_ranking',
          type: 'pv.residual_heatmap',
          x: 0,
          y: 0,
          w: 6,
          h: 8,
          config: { title: 'Fleet loss ranking', plantIds: pvScope },
        },
        {
          id: 'w_tpl_d_soiling',
          type: 'pv.soiling_ranking',
          x: 6,
          y: 0,
          w: 6,
          h: 8,
          config: { title: 'Soiling ranking', plantIds: pvScope },
        },
      ];
      const slots = [0, 1] as const;
      slots.forEach((i) => {
        const device = worst[i];
        widgets.push({
          id: `w_tpl_d_worst_${i + 1}`,
          type: 'pv.expected_vs_measured',
          x: i * 6,
          y: 8,
          w: 6,
          h: 6,
          config: {
            title: device
              ? `Worst performer ${i + 1}: ${device}`
              : `Worst performer ${i + 1}: pick an inverter via Edit`,
            plantIds: pvScope,
            deviceIds: device ? [device] : undefined,
          },
        });
      });
      widgets.push(
        {
          id: 'w_tpl_d_strings',
          type: 'pv.string_health',
          x: 0,
          y: 14,
          w: 6,
          h: 6,
          config: { title: 'String health', plantIds: pvScope },
        },
        {
          id: 'w_tpl_d_waterfall',
          type: 'pv.loss_waterfall',
          x: 6,
          y: 14,
          w: 6,
          h: 6,
          config: { title: 'Loss breakdown', plantIds: pvScope },
        }
      );
      return {
        title: 'Inverter deep dive',
        description:
          'Fleet loss and soiling rankings, worst performers vs the twin, string health, and loss breakdown.',
        plantIds: pv ? [pv] : allPlants,
        widgets,
      };
    },
  },
];
