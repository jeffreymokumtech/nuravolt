import type { DocArticle } from './types';

/**
 * Docs category: analytics.
 *
 * Grounded in nuravolt/soiling/per_inverter_analysis.py (per-inverter SR),
 * the cold-start policy (physics digital twin day 1, nearest climate-zone
 * soiling transfer), and the ticket workflow in src/types/tickets.ts.
 */

const PUBLISHED = '2026-07-05';

export const analyticsArticles: DocArticle[] = [
  {
    category: 'analytics',
    slug: 'soiling-intelligence',
    title: 'Soiling intelligence',
    intro: 'What the soiling ratio means, how per-inverter estimation works, and how the cleaning optimizer uses it.',
    quickAnswer:
      'The soiling ratio (SR) is the fraction of expected energy your modules deliver given the dirt on them: SR 0.95 means 5 percent of production is lost to soiling. NuraVolt estimates SR per inverter from AC power, irradiance and temperature after weather and curtailment correction, forecasts it 365 days ahead, and recommends cleaning dates where the recovered energy pays for the clean.',
    sections: [
      {
        heading: 'Soiling ratio, in plain terms',
        blocks: [
          {
            type: 'paragraph',
            text: 'Dust, pollen and salt settle on modules and block light. The soiling ratio compares what your plant actually produces against what it should produce with clean modules under the same weather. A plant at SR 0.92 is losing 8 percent of its energy to dirt.',
          },
          {
            type: 'paragraph',
            text: 'Most plants carry at most one reference sensor, so NuraVolt infers soiling per inverter from operational data instead. Uneven soiling is normal: rows near a road or field edge foul faster, and per-inverter estimates make that visible.',
          },
        ],
      },
      {
        heading: 'Forecast and cleaning optimizer',
        blocks: [
          {
            type: 'list',
            items: [
              'A 365-day SR forecast per plant, with confidence bounds and rain-recovery effects from weather forecasts.',
              'Cleaning recommendations that weigh the cost of a clean against the energy it recovers at your tariff.',
              'A schedule you can approve as O&M tickets, so the recommendation becomes a work order.',
            ],
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Does rain reset the soiling ratio?',
        a: 'Heavy rain partially cleans modules and the model credits it, typically a few percentage points of recovery for a strong event. Light rain can make soiling worse by cementing dust, which the model also reflects.',
      },
      {
        q: 'Do I need a soiling sensor?',
        a: 'No. A DustIQ or similar sensor improves confidence and is used when present, but per-inverter estimation works from power, irradiance and temperature data alone.',
      },
    ],
    relatedDocs: [
      { category: 'analytics', slug: 'cold-start-and-model-maturity' },
      { category: 'analytics', slug: 'fault-detection-and-tickets' },
    ],
    datePublished: PUBLISHED,
  },
  {
    category: 'analytics',
    slug: 'cold-start-and-model-maturity',
    title: 'Cold start and model maturity',
    intro: 'What you see on day one, and how estimates improve as your data accrues.',
    quickAnswer:
      'On day one your plant gets a physics-based digital twin built from its layout (tilt, azimuth, capacity) and a provisional soiling estimate transferred from the most similar climate zone we have models for. Both are labeled provisional. As weeks of your own data accrue, plant-specific models are trained automatically and replace the provisional ones.',
    sections: [
      {
        heading: 'Day one: provisional estimates',
        blocks: [
          {
            type: 'keyValue',
            pairs: [
              {
                label: 'Digital twin',
                value: 'A physics model of expected production built from the layout you entered in the wizard plus satellite weather. Available immediately.',
              },
              {
                label: 'Soiling',
                value: 'A transfer estimate from the nearest climate analog among our foundation models, labeled as provisional with wider confidence bounds.',
              },
            ],
          },
          {
            type: 'paragraph',
            text: 'Provisional results carry a visible label and a model version. They are honest estimates, good enough to plan a first cleaning review, but expect them to shift as real data arrives.',
          },
        ],
      },
      {
        heading: 'The upgrade ladder',
        blocks: [
          {
            type: 'list',
            items: [
              'First data lands within about 15 minutes of connecting a cloud source.',
              'Daily analytics start with the first full days of production history.',
              'Once enough days of clean data accrue, per-inverter soiling models are trained on your plant and the provisional label disappears.',
              'Models keep retraining as seasons change; the model version shown with each result tells you what produced it.',
            ],
          },
        ],
      },
    ],
    faq: [
      {
        q: 'How long until the models are plant-specific?',
        a: 'It depends on data quality and weather variety, typically a few weeks of production data. The plant status page shows where you are on the ladder.',
      },
    ],
    relatedDocs: [
      { category: 'analytics', slug: 'soiling-intelligence' },
      { category: 'getting-started', slug: 'onboard-your-first-plant' },
    ],
    datePublished: PUBLISHED,
  },
  {
    category: 'analytics',
    slug: 'fault-detection-and-tickets',
    title: 'Fault detection and tickets',
    intro: 'How fault alerts become work orders your team can execute and audit.',
    quickAnswer:
      'NuraVolt classifies inverter and string anomalies into faults, and every fault can open an O&M ticket. Tickets move through a validation workflow: NEW, then VALIDATED, ASSIGNED, IN_PROGRESS and DONE, with comments, history and revenue impact estimates attached. AI narration can draft the ticket summary; a person approves it.',
    sections: [
      {
        heading: 'From anomaly to ticket',
        blocks: [
          {
            type: 'list',
            items: [
              'Detection: rule-based and model-based checks flag underperformance, thermal anomalies and failures.',
              'Interpretation: each alert carries an explanation and an estimated energy and revenue impact.',
              'Ticketing: alerts open tickets, or your team creates them by hand. Every ticket keeps its trigger and history.',
            ],
          },
        ],
      },
      {
        heading: 'The ticket workflow',
        blocks: [
          {
            type: 'table',
            headers: ['Status', 'Meaning'],
            rows: [
              ['NEW', 'Created, awaiting review.'],
              ['VALIDATED', 'A person confirmed the issue is real.'],
              ['ASSIGNED', 'A technician or crew owns it.'],
              ['IN_PROGRESS', 'Work started on site.'],
              ['DONE', 'Resolved and closed.'],
            ],
          },
          {
            type: 'paragraph',
            text: 'Validation is deliberate: nothing is dispatched purely on a model score. Priorities weigh estimated revenue impact so the most expensive faults surface first.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Can AI assistants create tickets?',
        a: 'Yes, through the MCP server with a key that has the tickets write scope. Every AI-created ticket is attributed in the audit log and still passes the human validation step.',
      },
    ],
    relatedDocs: [
      { category: 'analytics', slug: 'soiling-intelligence' },
      { category: 'ai-and-api', slug: 'mcp-server' },
    ],
    datePublished: PUBLISHED,
  },
];
