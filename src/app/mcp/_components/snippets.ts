/**
 * Copy-paste install snippets for MCP clients. Used by both the landing page
 * (`ConnectorTabs`) and the setup guide. Single source of truth so the two
 * pages never drift.
 *
 * Ship the placeholder `nv_live_YOUR_KEY_HERE` — the customer's admin UI reveal
 * dialog also shows the correct snippet with their real key inlined.
 */

export const MCP_ENDPOINT = 'https://nuravolt.com/api/mcp/mcp';

export interface ConnectorSnippet {
  key: 'claude-desktop' | 'chatgpt' | 'cursor' | 'continue';
  label: string;
  filename?: string;
  language: 'json' | 'text';
  body: string;
  notes?: string;
}

export const CONNECTOR_SNIPPETS: ConnectorSnippet[] = [
  {
    key: 'claude-desktop',
    label: 'Claude Desktop',
    filename: '~/Library/Application Support/Claude/claude_desktop_config.json',
    language: 'json',
    body: `{
  "mcpServers": {
    "nuravolt": {
      "url": "${MCP_ENDPOINT}",
      "headers": {
        "Authorization": "Bearer nv_live_YOUR_KEY_HERE"
      }
    }
  }
}`,
    notes: 'Restart Claude Desktop after editing. NuraVolt tools appear in the tool tray at the bottom of the composer.',
  },
  {
    key: 'chatgpt',
    label: 'ChatGPT (Custom Connector)',
    language: 'text',
    body: `Settings  →  Connectors  →  Custom connector

Name:               NuraVolt
Type:               MCP server
URL:                ${MCP_ENDPOINT}
Authentication:     Bearer token
Token:              nv_live_YOUR_KEY_HERE
Enable in chats:    Yes`,
    notes: 'ChatGPT Business/Enterprise plans only, as of 2026.',
  },
  {
    key: 'cursor',
    label: 'Cursor',
    filename: '~/.cursor/mcp.json',
    language: 'json',
    body: `{
  "mcpServers": {
    "nuravolt": {
      "url": "${MCP_ENDPOINT}",
      "headers": {
        "Authorization": "Bearer nv_live_YOUR_KEY_HERE"
      }
    }
  }
}`,
    notes: 'Cursor picks up MCP servers on next restart. Toggle NuraVolt on in Settings → MCP.',
  },
  {
    key: 'continue',
    label: 'Continue.dev',
    filename: '~/.continue/config.yaml',
    language: 'text',
    body: `mcpServers:
  - name: nuravolt
    url: ${MCP_ENDPOINT}
    headers:
      Authorization: Bearer nv_live_YOUR_KEY_HERE`,
  },
];
