/** The connectors this plugin ships, registered through the same public API as any other plugin's. */
import type { ConnectorDefinition, ConnectorServer, ServerInput } from './api.ts'

/** A GitHub App or OAuth App the user registered, from the plugin config. */
export interface GitHubAppConfig {
  readonly clientId: string
  readonly clientSecret?: string
  /** GitHub App slug, for the "choose repositories" link (`https://github.com/apps/<slug>/installations/new`). */
  readonly appSlug?: string
}

/** Built-in connector options. */
export interface BuiltinOptions {
  readonly github?: GitHubAppConfig
}

/** Exact `@azure-devops/mcp` release the Azure DevOps connector runs; a moving tag would run unreviewed code. */
export const AZURE_DEVOPS_MCP = '@azure-devops/mcp@2.11.0'

const ICONS = {
  granola: '<svg viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h10l4 4v12H5z"/><path d="M9 11h6M9 15h4"/></svg>',
  github: '<svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>',
  gitlab: '<svg viewBox="0 0 24 24"><path d="m12 21.4 3.7-11.3H8.3L12 21.4ZM3.1 10.1 2 13.5c-.1.3 0 .7.3.9l9.7 7-8.9-11.3Zm0 0h5.2L6.1 3.2c-.1-.4-.6-.4-.7 0l-2.3 6.9Zm17.8 0 1.1 3.4c.1.3 0 .7-.3.9l-9.7 7 8.9-11.3Zm0 0h-5.2l2.2-6.9c.1-.4.6-.4.7 0l2.3 6.9Z"/></svg>',
  linear: '<svg viewBox="0 0 24 24"><path d="M3.3 13.9 10.1 20.7A9 9 0 0 1 3.3 13.9ZM3 11.1l9.9 9.9a9 9 0 0 0 2-.4L3.4 9.1a9 9 0 0 0-.4 2Zm1.2-3.6 12.3 12.3a9 9 0 0 0 1.6-1L5.2 5.9a9 9 0 0 0-1 1.6ZM6.6 4.6A9 9 0 1 1 19.4 17.4L6.6 4.6Z"/></svg>',
  atlassian: '<svg viewBox="0 0 24 24"><path d="M7.4 11.3c-.3-.4-.9-.3-1.1.1L2.1 19.8c-.2.4.1.9.6.9h5.8c.3 0 .5-.1.6-.4 1.2-2.6.5-6.5-1.7-9ZM11.4 3.6c-2.2 3.4-2.1 7.2-.6 10.2l2.8 5.6c.1.2.4.4.6.4h5.8c.5 0 .8-.5.6-.9L12.6 3.6c-.2-.5-.9-.5-1.2 0Z"/></svg>',
  trello: '<svg viewBox="0 0 24 24"><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm1.5 3v11h4V6h-4Zm7 0v6h4V6h-4Z" fill-rule="evenodd"/></svg>',
  azureDevops: '<svg viewBox="0 0 24 24"><path d="M22 6.2v11.3l-4.6 3.8-7.2-2.6v2.6L6.1 16l11.6.9V7L22 6.2Zm-3.9.5L11.6 2.7v2.6L5.6 7.1 2 11.6v4.2l2.6 1.1V9.4l13.5-2.7Z"/></svg>',
}

/** One bearer-token HTTP server. */
function bearer(url: string): (input: ServerInput) => ConnectorServer {
  return ({ credential }) => ({ transport: 'streamable-http', url, headers: { Authorization: `Bearer ${credential}` } })
}

/**
 * Read the GitHub login of a token.
 * @param token OAuth or personal access token.
 * @param fetchFn Fetch implementation.
 * @returns The login.
 * @throws When GitHub refuses the token.
 */
export async function githubLogin(token: string, fetchFn: typeof fetch): Promise<string> {
  const response = await fetchFn('https://api.github.com/user', {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'dsh-connectors' },
  })
  if (response.status === 401) throw new Error('GitHub refused the token (401). Check that it is valid and not expired.')
  if (!response.ok) throw new Error(`GitHub answered ${response.status} when checking the token.`)
  const body = await response.json() as { login?: unknown }
  if (typeof body.login !== 'string') throw new Error('GitHub did not report the account of this token.')
  return body.login
}

/** Azure DevOps organization names: letters, digits and hyphens, not starting with a hyphen. */
const ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/

/**
 * Check an Azure DevOps PAT against its organization.
 * @param organization Organization name (`dev.azure.com/<organization>`).
 * @param pat Personal access token.
 * @param fetchFn Fetch implementation.
 * @returns The display name of the token's user.
 * @throws When the organization is malformed or Azure DevOps refuses the token.
 */
export async function azureDevopsUser(organization: string, pat: string, fetchFn: typeof fetch): Promise<string> {
  if (!ORGANIZATION.test(organization)) throw new Error('The organization is the name after dev.azure.com/, for example "contoso".')
  const response = await fetchFn(`https://dev.azure.com/${organization}/_apis/connectionData`, {
    headers: { Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`, Accept: 'application/json' },
    redirect: 'manual',
  })
  // A refused PAT gets 401, or 203 with a sign-in page; only JSON is an answer.
  if (response.status === 401 || response.status === 203 || !(response.headers.get('content-type') ?? '').includes('json')) {
    throw new Error(`Azure DevOps refused the token for ${organization}. Check the organization and that the token is valid.`)
  }
  if (!response.ok) throw new Error(`Azure DevOps answered ${response.status} for ${organization}.`)
  const body = await response.json() as { authenticatedUser?: { providerDisplayName?: unknown } }
  const name = body.authenticatedUser?.providerDisplayName
  return typeof name === 'string' && name !== '' ? name : organization
}

/**
 * The built-in connectors.
 * @param options Plugin config.
 * @returns Definitions in table order.
 */
export function builtins(options: BuiltinOptions): ConnectorDefinition[] {
  const githubToken = {
    fields: [{ id: 'token', label: 'Personal access token', secret: true, placeholder: 'github_pat_…' }],
    helpUrl: 'https://github.com/settings/personal-access-tokens/new',
    verify: async (values: Readonly<Record<string, string>>, fetchFn: typeof fetch) => {
      const token = values.token ?? ''
      return { credential: token, account: await githubLogin(token, fetchFn) }
    },
  }
  const app = options.github
  return [
    {
      id: 'granola',
      name: 'Granola',
      description: 'Meeting notes and transcripts',
      icon: ICONS.granola,
      oauth: { resourceUrl: 'https://mcp.granola.ai/mcp' },
      server: bearer('https://mcp.granola.ai/mcp'),
    },
    {
      id: 'github',
      name: 'GitHub',
      description: 'Repositories, issues, pull requests and Actions',
      icon: ICONS.github,
      ...app === undefined ? {} : {
        oauth: {
          resourceUrl: 'https://api.githubcopilot.com/mcp/',
          client: { clientId: app.clientId, ...app.clientSecret === undefined ? {} : { clientSecret: app.clientSecret } },
          identify: githubLogin,
          ...app.appSlug === undefined ? {} : { setupUrl: `https://github.com/apps/${app.appSlug}/installations/new` },
        },
      },
      token: githubToken,
      server: bearer('https://api.githubcopilot.com/mcp/'),
    },
    {
      id: 'gitlab',
      name: 'GitLab',
      description: 'Projects, issues, merge requests and pipelines on gitlab.com',
      icon: ICONS.gitlab,
      oauth: { resourceUrl: 'https://gitlab.com/api/v4/mcp' },
      server: bearer('https://gitlab.com/api/v4/mcp'),
    },
    {
      id: 'linear',
      name: 'Linear',
      description: 'Issues, projects and cycles',
      icon: ICONS.linear,
      oauth: { resourceUrl: 'https://mcp.linear.app/mcp' },
      server: bearer('https://mcp.linear.app/mcp'),
    },
    {
      id: 'atlassian',
      name: 'Jira & Confluence',
      description: 'Atlassian Rovo MCP: Jira issues, Confluence pages, Compass',
      icon: ICONS.atlassian,
      oauth: { resourceUrl: 'https://mcp.atlassian.com/v1/mcp' },
      server: bearer('https://mcp.atlassian.com/v1/mcp'),
    },
    {
      id: 'trello',
      name: 'Trello',
      description: 'Boards, lists, cards and checklists',
      icon: ICONS.trello,
      oauth: { resourceUrl: 'https://mcp.trello.com/v1' },
      server: bearer('https://mcp.trello.com/v1'),
    },
    {
      id: 'azure-devops',
      name: 'Azure DevOps',
      description: 'Work items, repos, pipelines and wikis',
      icon: ICONS.azureDevops,
      token: {
        fields: [
          { id: 'organization', label: 'Organization', placeholder: 'contoso' },
          { id: 'token', label: 'Personal access token', secret: true },
        ],
        helpUrl: 'https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate',
        verify: async (values, fetchFn) => {
          const organization = values.organization ?? ''
          const pat = values.token ?? ''
          const account = await azureDevopsUser(organization, pat, fetchFn)
          // `@azure-devops/mcp --authentication pat` reads base64("<email>:<pat>"); the email part may be any value.
          return { credential: Buffer.from(`dsh:${pat}`).toString('base64'), account, values: { organization } }
        },
      },
      server: ({ credential, values }) => {
        const organization = values.organization ?? ''
        if (!ORGANIZATION.test(organization)) throw new Error('The organization is missing. Connect again with the organization name.')
        return {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', AZURE_DEVOPS_MCP, organization, '--authentication', 'pat'],
        env: { PERSONAL_ACCESS_TOKEN: credential },
          // The first start downloads the package.
          startupTimeoutMs: 180_000,
        }
      },
    },
  ]
}
