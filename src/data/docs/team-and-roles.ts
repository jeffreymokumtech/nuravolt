import type { DocArticle } from './types';

/**
 * Docs category: team-and-roles.
 *
 * The permissions table mirrors src/lib/auth/permissions-client.ts exactly;
 * update both together.
 */

const PUBLISHED = '2026-07-05';

export const teamAndRolesArticles: DocArticle[] = [
  {
    category: 'team-and-roles',
    slug: 'roles-and-permissions',
    title: 'Roles and permissions',
    intro: 'What each role can see and do, from org admin to viewer.',
    quickAnswer:
      'NuraVolt has five roles: Org admin (full control of the organisation, billing and connections), Manager (plants and team), Operator (day-to-day plant operations and tickets), Viewer (read only), and a platform-level Super admin reserved for NuraVolt staff. Plant access can additionally be granted per plant at View, Operate or Manage level.',
    sections: [
      {
        heading: 'Permission matrix',
        blocks: [
          {
            type: 'table',
            headers: ['Permission', 'Org admin', 'Manager', 'Operator', 'Viewer'],
            rows: [
              ['Manage organisation and billing', 'Yes', 'No', 'No', 'No'],
              ['Manage team members', 'Yes', 'Yes', 'No', 'No'],
              ['Create and update plants', 'Yes', 'Yes', 'No', 'No'],
              ['Delete plants', 'Yes', 'No', 'No', 'No'],
              ['Assign per-plant access', 'Yes', 'Yes', 'No', 'No'],
              ['Manage data connections', 'Yes', 'No', 'No', 'No'],
              ['View plant data and analytics', 'Yes', 'Yes', 'Yes', 'Yes'],
              ['Operate plants and work tickets', 'Yes', 'Yes', 'Yes', 'No'],
              ['Export data and create reports', 'Yes', 'Yes', 'Yes', 'No'],
            ],
            caption: 'Role permissions. Super admin (NuraVolt staff) additionally has platform administration.',
          },
        ],
      },
      {
        heading: 'Per-plant access levels',
        blocks: [
          {
            type: 'paragraph',
            text: 'Org admins and managers see every plant in the organisation. Operators and viewers see the plants they are granted, at one of three levels.',
          },
          {
            type: 'keyValue',
            pairs: [
              { label: 'View', value: 'Read dashboards, analytics and tickets for the plant.' },
              { label: 'Operate', value: 'Everything in View, plus working tickets and running actions such as the cleaning optimizer.' },
              { label: 'Manage', value: 'Everything in Operate, plus plant settings.' },
            ],
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Who gets the admin role?',
        a: 'The person who creates the organisation. Admins can promote other members afterwards.',
      },
      {
        q: 'Do AI assistants respect these roles?',
        a: 'Enterprise OAuth connections resolve access per user, so an assistant acting for a viewer sees exactly what that viewer sees. Organisation API keys are service credentials scoped to the whole org.',
      },
    ],
    relatedDocs: [
      { category: 'team-and-roles', slug: 'inviting-your-team' },
      { category: 'ai-and-api', slug: 'mcp-server' },
    ],
    datePublished: PUBLISHED,
  },
  {
    category: 'team-and-roles',
    slug: 'inviting-your-team',
    title: 'Inviting your team',
    intro: 'Invitations, seat limits, and granting plant access.',
    quickAnswer:
      'Invite teammates by email from Settings, then Team. Each invite carries a role; the teammate accepts the emailed link and lands in your organisation. Seats are limited by plan: 1 on Residential, 10 on Business, unlimited on Enterprise. Pending invitations count against the seat limit.',
    sections: [
      {
        heading: 'Sending an invitation',
        blocks: [
          {
            type: 'list',
            items: [
              'Go to Settings, then Team, and choose Invite member.',
              'Enter the email address and pick a role: Manager, Operator or Viewer.',
              'The teammate receives an email link. Accepting it adds them to the organisation with that role.',
            ],
          },
          {
            type: 'paragraph',
            text: 'Invitations expire if unused. You can cancel a pending invitation at any time, which also frees its seat.',
          },
        ],
      },
      {
        heading: 'Seat limits',
        blocks: [
          {
            type: 'table',
            headers: ['Plan', 'Seats'],
            rows: [
              ['Residential', '1'],
              ['Business', '10'],
              ['Enterprise', 'Unlimited'],
            ],
          },
          {
            type: 'paragraph',
            text: 'When members plus pending invitations reach the limit, new invitations are blocked with an upgrade prompt. Removing a member or cancelling an invite frees the seat immediately.',
          },
        ],
      },
      {
        heading: 'Granting plant access',
        blocks: [
          {
            type: 'paragraph',
            text: 'Operators and viewers only see plants they are granted. After a teammate joins, open the plant and assign them View, Operate or Manage access. Grants can carry an expiry date for contractors.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Can one person belong to several organisations?',
        a: 'Yes. An email address can be a member of multiple organisations and switch between them; roles are per organisation.',
      },
    ],
    relatedDocs: [
      { category: 'team-and-roles', slug: 'roles-and-permissions' },
      { category: 'billing', slug: 'plans-and-capacity' },
    ],
    datePublished: PUBLISHED,
  },
];
