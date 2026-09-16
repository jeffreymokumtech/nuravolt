import type { DocArticle } from './types';

/**
 * Docs category: ai-and-api. Overview only; the deep setup guide lives at
 * /mcp/setup and docs/MCP_SERVER.md.
 */

const PUBLISHED = '2026-07-05';

export const aiAndApiArticles: DocArticle[] = [
  {
    category: 'ai-and-api',
    slug: 'mcp-server',
    title: 'The MCP server: your data inside AI assistants',
    intro: 'Query plants, soiling, faults and tickets from Claude, ChatGPT or Cursor.',
    quickAnswer:
      'The NuraVolt MCP server exposes 12 tools (list plants, soiling forecasts, fault classification, ticket creation and more) to any assistant that speaks the Model Context Protocol. Business plans authenticate with scoped API keys; Enterprise adds an OAuth connector where each user signs in with their own account and access follows their plant permissions.',
    sections: [
      {
        heading: 'Two ways to connect',
        blocks: [
          {
            type: 'keyValue',
            pairs: [
              {
                label: 'API keys (Business and Enterprise)',
                value: 'Organisation-level service credentials with per-key scopes. Generate them under Settings, then MCP API keys. Best for shared automations.',
              },
              {
                label: 'OAuth connector (Enterprise)',
                value: 'Add NuraVolt as a connector by URL; each teammate signs in with their own account. Access follows per-user plant permissions and the audit log names the person, not a key.',
              },
            ],
          },
          {
            type: 'paragraph',
            text: 'Every call, read or write, lands in an audit log with duration, arguments and status. Write tools require an idempotency key so retries can never create duplicate tickets.',
          },
        ],
      },
      {
        heading: 'Set it up',
        blocks: [
          {
            type: 'paragraph',
            text: 'The full setup guide, including Claude Desktop, ChatGPT and Cursor snippets, scope reference and troubleshooting, lives on the MCP setup page.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Can the AI break something in my plant?',
        a: 'No control paths exist. Write scopes cover tickets and cleaning schedules only, both of which pass human validation workflows.',
      },
    ],
    extraRelated: [
      {
        title: 'MCP setup guide',
        href: '/mcp/setup',
        description: 'Step-by-step connector installation with scope reference and troubleshooting.',
      },
      {
        title: 'MCP server overview',
        href: '/mcp',
        description: 'What the MCP server is and the full tool catalogue.',
      },
    ],
    relatedDocs: [{ category: 'analytics', slug: 'fault-detection-and-tickets' }],
    datePublished: PUBLISHED,
  },
];
