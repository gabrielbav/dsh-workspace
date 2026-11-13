// Reference connector package. A real one would point at its service's MCP endpoint and usually offer OAuth
// (`oauth: { resourceUrl }`) when the service supports Dynamic Client Registration.
export const name = 'dsh-connector-example'
export const inject = ['connectors']

export function apply(ctx) {
  ctx.effect(() => ctx.connectors.register({
    id: 'example',
    name: 'Example',
    description: 'Reference connector from @gabrielbav/dsh-connector-example',
    token: {
      fields: [{ id: 'token', label: 'API token', secret: true }],
      verify: async values => ({ credential: values.token }),
    },
    server: ({ credential }) => ({
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: `Bearer ${credential}` },
    }),
  }), 'connector-example: register')
}
