# AWS for DeepSeek Harness

Adds an **AWS** page to Settings. It lists the official AWS MCP servers in groups such as **Real-time access to official AWS documentation** or **Infrastructure as Code**. Turn on a whole group with its switch, or turn servers on one at a time. Each server you turn on adds its tools to every session in that dsh (chats, subagents, automation tasks), named `mcp__<server>__<tool>`. You don't need to edit an MCP config file.

The catalog follows [awslabs/mcp](https://github.com/awslabs/mcp) and the [Agent Toolkit for AWS](https://github.com/aws/agent-toolkit-for-aws), which AWS calls its successor. It leaves out deprecated and superseded servers:

- **AWS API** is superseded by the AWS MCP Server.
- **Cloud Control API** is superseded by AWS IaC.
- **IAM**, **Kendra Index** and **Q Business anonymous** are deprecated in favor of the AWS MCP Server.
- **Frontend**, **Diagram**, **Nova Canvas**, **Core** and **Git Repo Research** were removed from awslabs in April 2026.

## Servers

| Group | Servers |
|---|---|
| AWS MCP Server (start here) | AWS MCP Server (hosted by AWS, preview) |
| Real-time access to official AWS documentation | AWS Knowledge (remote), AWS Documentation |
| Infrastructure as Code | AWS IaC |
| Containers | Amazon EKS, Amazon ECS, Finch |
| Serverless & functions | AWS Serverless (SAM), AWS Lambda Tool |
| APIs, messaging & integration | SNS/SQS, Amazon MQ, Step Functions Tool, AppSync, Location Service, OpenAPI |
| Cost & billing | AWS Pricing, Billing and Cost Management |
| Observability & operations | CloudWatch, CloudWatch Application Signals, Managed Prometheus, CloudTrail, Network, Support, Transform, Systems Manager for SAP |
| Security | Well-Architected Security Assessment, AWS Security Agent |
| AI & machine learning | Bedrock AgentCore, Bedrock Knowledge Bases Retrieval, Q index, Bedrock Custom Model Import, SageMaker AI, Translate, Document Loader |
| Databases | DynamoDB, Aurora PostgreSQL, Aurora MySQL, Aurora DSQL, DocumentDB, Neptune, Keyspaces, Timestream for InfluxDB, RDS for SQL Server, RDS for Oracle, RDS for Db2 |
| Caching | ElastiCache, Valkey, Memcached |
| Data & analytics | Redshift, S3 Tables, Data Processing (Glue, EMR, Athena), Spark Troubleshooting, Spark Code Recommendation, Spark Upgrade, IoT SiteWise, Registry of Open Data |
| Healthcare & life sciences | HealthOmics, HealthImaging, HealthLake |

Each row on the page shows the server's description, whether it runs remotely or locally, its state (Starting, On with its tool count, Needs setup, Error), and links to its docs.

## How it works

DSH's MCP manager runs the servers. This plugin registers each enabled server with `ctx.mcpManager.register()` and removes it when you turn it off. There are three kinds:

- **Remote**: AWS Knowledge is an HTTPS endpoint that needs no AWS account.
- **Remote, signed**: the AWS MCP Server and the three SageMaker Unified Studio Spark servers are hosted by AWS. They run through AWS's local `mcp-proxy-for-aws-cli`, which signs requests with your AWS profile (SigV4).
- **Local**: every other server is a Python package from PyPI, run with `uvx --from <package>==<version>`.

All versions are pinned, so DSH never runs a release nobody reviewed. A few releases also need a dependency bound they leave out. ECS runs with `--with fastmcp<4`, HealthLake with `--with mcp<2`, Q index with `--with mypy-boto3-qbusiness`, and Keyspaces on Python 3.11. Pinning also skips the PyPI check `@latest` makes on every start. An update is a change to [`src/host/catalog.ts`](src/host/catalog.ts). The first start of a server downloads it (and a Python if needed), so it may take up to 3 minutes.

### Your AWS account

- The **AWS account** box sets the AWS CLI profile and region that every server uses. Each server's **Settings** can override them.
- Leave them empty to use the AWS SDK's default chain (`AWS_PROFILE`, `~/.aws/config`).
- The page suggests the profile names it finds in `~/.aws/config` and `~/.aws/credentials`. It reads only the section names, never keys.
- DSH does not pass `AWS_ACCESS_KEY_ID`-style environment variables to MCP servers (it drops every credential-shaped variable). So sign in with a profile: IAM Identity Center/SSO (`aws configure sso`, `aws sso login`) or keys in `~/.aws/credentials`.

### Read-only by default

Servers that have a read-only mode start in it:

- The plugin leaves out `--allow-write`, `--allow-writes`, `--allow_write_query` and `--allow-resource-creation`.
- It sets `ALLOW_WRITE=false` for ECS.
- It adds `--readonly` for ElastiCache, Valkey, Memcached and HealthLake, and `--read-only` for the AWS MCP Server proxy.

In a server's **Settings**, **Allow changes** and **Allow access to sensitive data** turn on its write mode and `--allow-sensitive-data-access`. Rows with writes allowed show a **Can write** tag. Some servers have no read-only mode. Support, Security Agent, HealthImaging, Lambda Tool, Step Functions Tool, OpenAPI, Neptune and others do what their tools and your permissions allow. In the end your IAM permissions decide what any server can do, so a read-only profile is the safest choice.

### Settings per server

Some servers need input before they can start, for example a DSQL cluster endpoint, a Neptune endpoint, a DocumentDB connection string, Valkey or Memcached hosts, Lambda or Step Functions name filters, or an OpenAPI spec. Until those settings are filled in, the server shows **Needs setup** and is not registered.

- **Secret fields** go to DSH's credential store (`$DSH_HOME`) as `DSH_AWS_<SERVER>_<FIELD>`. Examples are the DocumentDB connection string, the Keyspaces password, the InfluxDB token, the Valkey password and OpenAPI tokens. The server receives them through a `${credential:…}` template when it starts. The page never reads a stored secret back.
- **Extra environment variables** take `NAME=value` lines for any option the form doesn't cover. See the server's docs.
- The settings are stored in the `dsh-aws/settings` credential record, so they survive restarts.

### Requirements

- [uv](https://docs.astral.sh/uv/) on the Host: `curl -LsSf https://astral.sh/uv/install.sh | sh`. The plugin looks for `uvx` on `PATH`, then in `~/.local/bin`, `~/.cargo/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. The page warns when it is missing. AWS Knowledge works without it.
- Some servers need more. Finch needs Finch, and AWS Serverless deployments need the SAM CLI. AWS Support needs a Business, Enterprise On-Ramp or Enterprise support plan. Db2 needs the RDS certificate bundle. The row notes say when.
- The `mcp-manager` and `credentials` services, which the Web and Desktop profiles mount. No harness fork is needed.

## Install

From the Plugins page: **Add plugin** → `@gabrielbav/dsh-plugin-aws`. Or from the command line:

```sh
dsh plugin --profile web add -w @gabrielbav/dsh-plugin-aws
```

Restart dsh, then open **Settings → AWS**.

From a checkout, in the DSH workspace: `make plugins P=aws`, then `make start P=aws`.

## Develop

```sh
corepack pnpm@11.28.5 install
corepack pnpm@11.28.5 run build      # lib/index.js (Host) and lib/client.js (browser)
corepack pnpm@11.28.5 run typecheck
corepack pnpm@11.28.5 test
```

To add or update a server, edit [`src/host/catalog.ts`](src/host/catalog.ts): its group, pinned version, form fields, and which flags or variables it gets in read-only, write and sensitive mode. The tests check that every id is a valid MCP server name, every group has servers, versions are exact, and deprecated servers stay out.

## License

MIT
