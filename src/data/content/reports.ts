import type { ArticleView, ContentSection, FAQ, RelatedLink } from './types';

/**
 * Template R — Original data reports.
 *
 * Reports are the linkable, citable assets: original analysis of public data,
 * with the numbers rendered as static HTML tables so crawlers and AI engines
 * can lift them. Each report pairs an open page with an email-gated raw dataset.
 * Body is authored directly as ContentSection[] (like insights), and may use the
 * `table` and `stat` blocks.
 */

export interface ReportEntry {
  slug: string;
  title: string;
  intro: string;
  quickAnswer: string;
  sections: ContentSection[];
  faq: FAQ[];
  related: RelatedLink[];
  sources?: string[];
  datePublished?: string;
  dataset?: ArticleView['dataset'];
}

export const reports: ReportEntry[] = [
  {
    slug: 'ml-solar-fault-detection-benchmark',
    title: 'Can machine learning actually detect solar faults? A benchmark on public data',
    intro:
      'We trained fault and remaining-useful-life models on four public solar and battery datasets. Here is what worked, what did not, and the exact numbers behind both.',
    quickAnswer:
      'On public PV fault data a gradient-boosted classifier reaches 0.998 macro-F1 on the 5-class Lazzaretti dataset but only 0.766 on the harder 8-class GPVS-Faults set, where thermal and sensor-drift faults stay weak. Remaining-useful-life models flag fast-moving faults within a day but miss slow degradation by nearly a week. Battery end-of-life prediction lands at 17 percent error for LFP and 30 percent for NMC.',
    sections: [
      {
        heading: 'What we tested',
        blocks: [
          {
            type: 'paragraph',
            text: 'Every result below comes from a public, openly licensed dataset and a held-out test set. Nothing here uses client-confidential plant data. The point is not that machine learning is magic, it is to show honestly how much accuracy depends on the fault type and the dataset.',
          },
          {
            type: 'stat',
            items: [
              { value: '497,407', label: 'labeled PV rows', sub: 'Lazzaretti: 397,926 train, 99,481 test' },
              { value: '1.37M', label: 'rows for RUL training', sub: '989,134 train, 274,760 test' },
              { value: '137', label: 'battery cells', sub: '124 LFP (Severson) + 13 NMC (NASA)' },
            ],
          },
          {
            type: 'list',
            items: [
              'Lazzaretti UTFPR PV Fault Dataset (CC BY 4.0): 5 fault classes from a 5 kW site in Curitiba, Brazil.',
              'GPVS-Faults: 8 fault classes across two operating modes at the system level.',
              'Severson 2019 (Toyota, MIT, Stanford): 124 commercial A123 LFP cells cycled to end of life.',
              'NASA Ames PCoE Battery Aging Dataset: 13 well-formed NMC cells.',
            ],
          },
        ],
      },
      {
        heading: 'PV fault classification: near-perfect on one dataset, hard on another',
        blocks: [
          {
            type: 'paragraph',
            text: 'A gradient-boosted classifier on the Lazzaretti data separates all five classes almost perfectly. The same model family on the harder GPVS-Faults set, with eight classes and different fault families, drops to 0.766 macro-F1. The honest story is in the per-class breakdown.',
          },
          {
            type: 'table',
            caption: 'Lazzaretti 5-class PV faults. Macro-F1 0.998, accuracy 0.997.',
            headers: ['Fault class', 'Precision', 'Recall', 'F1', 'Test samples'],
            rows: [
              ['normal', '0.9988', '0.9969', '0.9979', '59,230'],
              ['short_circuit', '0.9983', '0.9975', '0.9979', '1,203'],
              ['degradation', '0.9976', '0.9995', '0.9985', '2,062'],
              ['open_circuit', '0.9983', '1.0000', '0.9992', '1,183'],
              ['partial_shading', '0.9950', '0.9979', '0.9964', '35,803'],
            ],
          },
          {
            type: 'table',
            caption: 'GPVS-Faults 8-class. Macro-F1 0.766, accuracy 0.766. Sorted best to worst F1.',
            headers: ['Fault class', 'Precision', 'Recall', 'F1', 'Test samples'],
            rows: [
              ['dc_link_capacitor_aging', '0.9991', '0.9998', '0.9994', '8,000'],
              ['string_short_circuit', '0.7449', '0.8506', '0.7943', '8,000'],
              ['grid_voltage_sag', '0.9054', '0.7014', '0.7904', '8,000'],
              ['string_open_circuit', '0.8625', '0.7260', '0.7884', '8,000'],
              ['normal', '0.7212', '0.7897', '0.7539', '8,000'],
              ['grid_voltage_swell', '0.7089', '0.7991', '0.7513', '8,000'],
              ['irradiance_sensor_drift', '0.6222', '0.6379', '0.6299', '8,000'],
              ['inverter_overtemperature', '0.6252', '0.6212', '0.6232', '8,000'],
            ],
          },
          {
            type: 'paragraph',
            text: 'Thermal (inverter overtemperature) and sensor-drift faults are the hardest to separate from normal operation with the available signals, and they sit at the bottom of the GPVS table. This is a genuine limit of the data, not a modeling shortcut. The Lazzaretti model trains on a single 5 kW site, so cross-dataset transfer to GPVS is intentionally not expected: the fault families differ.',
          },
        ],
      },
      {
        heading: 'Remaining useful life: fast faults are easy, slow ones are not',
        blocks: [
          {
            type: 'paragraph',
            text: 'We trained seven remaining-useful-life regressors on 1.37M rows, evaluated at 1, 3, 7, 14 and 30 day horizons. Mean absolute error is in days. "Within 1 day" is the share of test cases predicted within a day of the true failure date. "Meets bar" is our operational criterion for next-day alerting.',
          },
          {
            type: 'table',
            caption: 'Seven RUL models, Lazzaretti-derived. Five of seven meet the next-day bar.',
            headers: ['Fault', 'MAE (days)', 'Within 1 day', 'Meets bar'],
            rows: [
              ['Bypass diode stress', '0.35', '90.5%', 'Yes'],
              ['Inverter overtemperature', '0.48', '84.0%', 'Yes'],
              ['Thermal hotspot risk', '0.54', '79.1%', 'Yes'],
              ['String degradation', '0.69', '71.5%', 'Yes'],
              ['String mismatch', '1.34', '60.1%', 'Yes'],
              ['Module degradation', '4.75', '39.0%', 'No'],
              ['Insulation degradation', '7.18', '8.9%', 'No'],
            ],
          },
          {
            type: 'paragraph',
            text: 'The two models that miss the bar, module degradation and insulation, are slow, low-signal faults where a mean error of 5 to 7 days is expected. They are useful on 14 to 30 day horizons, not for next-day alerts. Reporting that plainly is the point: a single headline accuracy would hide it.',
          },
        ],
      },
      {
        heading: 'Battery end-of-life across chemistries',
        blocks: [
          {
            type: 'paragraph',
            text: 'End-of-life prediction is harder for batteries because public cycling data is scarce. We benchmarked two chemistries with the best available open datasets. MAPE is mean absolute percentage error against true end-of-life cycle.',
          },
          {
            type: 'table',
            caption: 'Battery end-of-life prediction. Neither is warranty-grade; both support operational planning.',
            headers: ['Chemistry', 'Dataset', 'Cells', 'Method', 'MAPE', 'Within 10%', 'Within 25%'],
            rows: [
              ['LFP', 'Severson 2019 (A123)', '124', 'leave-one-out gradient boosting', '17.2%', '49%', '84%'],
              ['NMC', 'NASA PCoE', '13', 'linear extrapolation', '29.5%', '69%', '85%'],
            ],
          },
          {
            type: 'paragraph',
            text: 'LFP has a well-studied knee point that gradient boosting captures from the first 100 cycles. NMC public data is thin (13 usable cells) and fades roughly linearly from cycle zero, so a simple extrapolation matches it about as well as anything more complex would.',
          },
        ],
      },
      {
        heading: 'What this means',
        blocks: [
          {
            type: 'paragraph',
            text: 'Two things carry across every table. First, accuracy is fault-specific: a headline number is close to meaningless without the per-class or per-model breakdown. Second, the features matter more than the model. Plant-agnostic ratios, rather than absolute kW, are what let the PV classifier transfer from a 5 kW rooftop to a MW-scale utility plant without retraining. That is the difference between a demo and something you can point at a portfolio you have never seen.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Are these numbers reproducible?',
        a: 'Yes. Every dataset is public and openly licensed (Lazzaretti CC BY 4.0, GPVS-Faults, Severson 2019, NASA PCoE). The per-class and per-model figures come straight from held-out test sets, and the full table is in the downloadable dataset.',
      },
      {
        q: 'Why is GPVS-Faults so much lower than Lazzaretti?',
        a: 'It is a harder 8-class problem with different fault families, and thermal and sensor-drift faults overlap with normal operation in the available signals. They are genuinely hard to separate, which is why we report per-class F1 rather than a single accuracy number.',
      },
      {
        q: 'Can a model trained on one plant work on another?',
        a: 'For PV classification, yes, when the features are plant-agnostic ratios rather than absolute power. That is what lets the Lazzaretti model transfer from a 5 kW rooftop to MW-scale utility plants without retraining.',
      },
    ],
    related: [
      { title: 'Fault library', href: '/faults', description: 'The fault modes these models detect.' },
      { title: 'Soiling loss', href: '/faults/soiling-loss', description: 'A recoverable loss, separate from hardware faults.' },
      { title: 'State of Health (SoH)', href: '/bess/state-of-health', description: 'The battery metric behind end-of-life prediction.' },
      { title: 'Best solar monitoring software in 2026', href: '/compare/best-solar-monitoring-software-2026', description: 'The platform landscape these models compete in.' },
      { title: 'How to monitor a C&I solar portfolio in 2026', href: '/insights/ci-solar-monitoring-guide-2026', description: 'The practical guide built on these benchmarks.' },
    ],
    sources: [
      'Lazzaretti et al., UTFPR PV Fault Dataset (CC BY 4.0)',
      'GPVS-Faults dataset',
      'Severson et al., Nature Energy 2019',
      'NASA Ames PCoE Battery Aging Dataset',
    ],
    datePublished: '2026-07-05',
    dataset: {
      slug: 'ml-solar-fault-benchmark',
      title: 'the ML fault-detection benchmark dataset (CSV)',
      downloadUrl: '/reports/datasets/ml-solar-fault-benchmark.csv',
      blurb:
        'Every number in this report as a single CSV: per-class F1 for both PV datasets, per-model remaining-useful-life accuracy across five horizons, and battery end-of-life error by chemistry. Free, in exchange for an email so we can tell you when we publish new benchmarks.',
    },
  },
  {
    slug: 'open-solar-battery-fault-datasets',
    title: 'Where to get open solar and battery fault data',
    intro:
      'A working index of the public datasets behind fault detection and degradation modeling in solar and storage: what each covers, how to access it, and which we have benchmarked.',
    quickAnswer:
      'The most useful open datasets for PV and battery fault work are Lazzaretti (5-class PV faults, CC BY 4.0), GPVS-Faults (8-class grid-connected PV), Severson 2019 (LFP battery cycling to end of life) and NASA PCoE (NMC battery aging). We benchmarked all four. Other open sources cover PV production time series and infrared module imagery but are not yet benchmarked here.',
    sections: [
      {
        heading: 'The datasets we benchmarked',
        blocks: [
          {
            type: 'paragraph',
            text: 'These four are openly licensed, widely used, and reproducible. The benchmark column links to our own held-out results in the companion report, so you can see what a standard model achieves before you invest in one.',
          },
          {
            type: 'table',
            caption: 'Open datasets benchmarked in our fault-detection report.',
            headers: ['Dataset', 'Domain', 'Scope', 'License / access', 'Our result'],
            rows: [
              ['Lazzaretti UTFPR', 'PV faults', '5 classes, ~497K labeled rows, 5 kW site', 'CC BY 4.0', '0.998 macro-F1'],
              ['GPVS-Faults', 'PV faults', '8 classes across 2 modes, ~320K rows, grid-connected', 'Open (Mendeley Data)', '0.766 macro-F1'],
              ['Severson 2019', 'LFP battery', '124 A123 cells cycled to end of life', 'Open (data.matr.io)', '17.2% MAPE'],
              ['NASA PCoE', 'NMC battery', '13 well-formed cells (of 42)', 'Public domain (NASA)', '29.5% MAPE'],
            ],
          },
        ],
      },
      {
        heading: 'Other open datasets worth knowing',
        blocks: [
          {
            type: 'paragraph',
            text: 'These are pointers, not benchmarks. We have not independently validated the specifics below, so treat the descriptions as a starting point and confirm details at the source before you rely on them.',
          },
          {
            type: 'table',
            caption: 'Open sources we have not benchmarked here.',
            headers: ['Dataset', 'Domain', 'What it offers', 'Access'],
            rows: [
              ['NREL PVDAQ', 'PV production', 'Multi-site inverter and string time series', 'Open (NREL)'],
              ['DKASC Alice Springs', 'PV performance', 'Multiple module technologies, long time series', 'Open'],
              ['Raptor Maps IR modules', 'PV thermal', 'Labeled infrared module images across anomaly types', 'Open (GitHub)'],
              ['Battery Archive', 'Battery cycling', 'Aggregated public cell datasets across chemistries', 'Open'],
            ],
          },
        ],
      },
      {
        heading: 'What is missing',
        blocks: [
          {
            type: 'paragraph',
            text: 'Open data skews to lab conditions or single sites. There is very little open, labeled, multi-site utility-scale fault data, and almost no open desert or MENA soiling ground truth. That gap is exactly why cross-dataset generalization matters: a model that only works on the site it was trained on is not much use to an operator with a portfolio the training set never saw.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Which dataset should I start with for PV fault detection?',
        a: 'Lazzaretti, for a clean 5-class problem that is CC BY 4.0 and easy to reproduce. Then GPVS-Faults for a harder, more realistic 8-class test that exposes where simple models struggle.',
      },
      {
        q: 'Is there open utility-scale fault data?',
        a: 'Very little. Most open sets are lab-generated or single-site. Multi-site labeled utility data is largely proprietary, which is why generalization from public data is the practical path.',
      },
    ],
    related: [
      { title: 'ML solar fault benchmark', href: '/reports/ml-solar-fault-detection-benchmark', description: 'Our held-out results on these datasets.' },
      { title: 'Fault library', href: '/faults', description: 'The fault modes these datasets label.' },
      { title: 'State of Health (SoH)', href: '/bess/state-of-health', description: 'The battery metric behind the cycling datasets.' },
    ],
    sources: [
      'Lazzaretti et al., UTFPR PV Fault Dataset (CC BY 4.0)',
      'GPVS-Faults dataset (Mendeley Data)',
      'Severson et al., Nature Energy 2019 (data.matr.io)',
      'NASA Ames PCoE Battery Aging Dataset',
    ],
    datePublished: '2026-07-05',
    dataset: {
      slug: 'open-solar-battery-datasets-index',
      title: 'the open dataset index (CSV)',
      downloadUrl: '/reports/datasets/open-solar-battery-datasets-index.csv',
      blurb:
        'The full index as a CSV: dataset, domain, scope, license and access, and whether we benchmarked it. Free, in exchange for an email so we can tell you when we add datasets.',
    },
  },
];

const REPORTS_HUB = { label: 'Reports', href: '/reports' };

export function getReport(slug: string): ReportEntry | undefined {
  return reports.find((r) => r.slug === slug);
}

export function normalizeReport(entry: ReportEntry): ArticleView {
  return {
    category: 'Data report',
    hub: REPORTS_HUB,
    slug: entry.slug,
    urlRelative: `/reports/${entry.slug}`,
    title: entry.title,
    intro: entry.intro,
    quickAnswer: entry.quickAnswer,
    sections: entry.sections,
    faq: entry.faq,
    related: entry.related,
    datePublished: entry.datePublished,
    sources: entry.sources,
    dataset: entry.dataset,
  };
}
