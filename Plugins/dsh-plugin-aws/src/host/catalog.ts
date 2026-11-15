/**
 * The AWS MCP server catalog: every current server from https://github.com/awslabs/mcp plus the hosted AWS MCP
 * Server, each in one group. Deprecated or superseded servers are left out: AWS API (superseded by the AWS MCP
 * Server), Cloud Control API (by AWS IaC), IAM, Kendra Index and Q Business anonymous (by the AWS MCP Server), and
 * the servers awslabs removed in April 2026 (Frontend, Diagram, Nova Canvas, Core, Git Repo Research, …).
 *
 * Versions are exact. A moving `@latest` would run unreviewed code and makes uvx check PyPI on every start, so an
 * update is a change here. Checked against PyPI and each server's README on 2026-11-13.
 */
import type { FieldView, GroupInfo } from '../shared.ts'

/** Where a form value goes. A boolean field adds its flag, or sets its variable to `true`, when checked. */
export type FieldTarget = { readonly env: string } | { readonly arg: string }

/** One form input with where its value goes. */
export interface FieldSpec extends FieldView {
  readonly target: FieldTarget
}

/** Arguments and environment added in one permission state. */
export interface LaunchDelta {
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

/** How DSH runs a server. */
export type Launch =
  /** A remote Streamable HTTP endpoint that needs no AWS credentials. */
  | { readonly kind: 'remote'; readonly url: string }
  /** A remote endpoint behind `mcp-proxy-for-aws-cli`, which signs requests with the AWS profile (SigV4). */
  | {
    readonly kind: 'proxy'
    /** Endpoint; `{region}` is replaced with the region (default `us-east-1`). */
    readonly url: string
    readonly service?: string
    /** Pass the region as `--metadata AWS_REGION=<region>` (the AWS MCP Server's operating region). */
    readonly regionMetadata?: boolean
    /** Region requests are signed for when the endpoint lives in one fixed region; default: the user's region. */
    readonly signingRegion?: string
    readonly args?: readonly string[]
  }
  /** A local Python server run by uvx from PyPI. */
  | {
    readonly kind: 'uvx'
    readonly package: string
    readonly version: string
    /** Console script when it differs from the package name. */
    readonly bin?: string
    readonly args?: readonly string[]
    /** Extra requirements (`uvx --with`), for dependencies a release leaves unbounded and a newer major broke. */
    readonly with?: readonly string[]
    /** Python version (`uvx --python`), for a release whose dependencies fail on newer Pythons. */
    readonly python?: string
  }

/** One catalog entry. */
export interface CatalogServer {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly group: string
  readonly docsUrl: string
  readonly launch: Launch
  /** Whether the server reads `AWS_PROFILE` and `AWS_REGION`. */
  readonly aws: boolean
  /** Pass the region as this flag instead of only `AWS_REGION`. */
  readonly regionArg?: string
  readonly env?: Readonly<Record<string, string>>
  readonly fields?: readonly FieldSpec[]
  readonly requireAny?: readonly string[]
  /** Added when writes are allowed. */
  readonly write?: LaunchDelta
  /** Added while writes are not allowed (servers that write unless told otherwise). */
  readonly readOnly?: LaunchDelta
  /** Added when sensitive data access is allowed. */
  readonly sensitive?: LaunchDelta
  readonly note?: string
}

/** Exact `mcp-proxy-for-aws-cli` release the proxied servers run. */
export const PROXY_PACKAGE = 'mcp-proxy-for-aws-cli'
export const PROXY_VERSION = '1.8.0'

const REPO = 'https://github.com/awslabs/mcp/tree/main/src'
const docs = (dir: string): string => `${REPO}/${dir}`
const uvx = (dir: string, version: string, extra: Omit<Extract<Launch, { kind: 'uvx' }>, 'kind' | 'package' | 'version'> = {}): Launch =>
  ({ kind: 'uvx', package: `awslabs.${dir}`, version, ...extra })

const text = (id: string, label: string, target: FieldTarget, more: Partial<FieldView> = {}): FieldSpec => ({ id, label, kind: 'text', target, ...more })
const secret = (id: string, label: string, env: string, more: Partial<FieldView> = {}): FieldSpec => ({ id, label, kind: 'secret', target: { env }, ...more })
const flag = (id: string, label: string, target: FieldTarget, more: Partial<FieldView> = {}): FieldSpec => ({ id, label, kind: 'boolean', target, ...more })

/** Usual write and sensitive-data flags of the awslabs servers. */
const ALLOW_WRITE: LaunchDelta = { args: ['--allow-write'] }
const ALLOW_SENSITIVE: LaunchDelta = { args: ['--allow-sensitive-data-access'] }
const ALLOW_WRITE_QUERY: LaunchDelta = { args: ['--allow_write_query'] }
const READONLY_FLAG: LaunchDelta = { args: ['--readonly'] }

export const GROUPS: readonly GroupInfo[] = [
  { id: 'start', title: 'AWS MCP Server (start here)', description: 'The managed server AWS recommends first: call any AWS API with your own IAM permissions, search the documentation, and load AWS agent skills and SOPs.' },
  { id: 'docs', title: 'Real-time access to official AWS documentation', description: 'Current AWS documentation, API references, What’s New posts, best practices and regional availability.' },
  { id: 'iac', title: 'Infrastructure as Code', description: 'CloudFormation and CDK guidance, construct examples, template validation and deployment troubleshooting.' },
  { id: 'containers', title: 'Containers', description: 'Build and run containers on Amazon EKS and Amazon ECS, and build images locally with Finch.' },
  { id: 'serverless', title: 'Serverless & functions', description: 'Build serverless applications with SAM and call Lambda functions as tools.' },
  { id: 'integration', title: 'APIs, messaging & integration', description: 'Queues, topics, brokers, Step Functions workflows, GraphQL APIs, maps and any OpenAPI API.' },
  { id: 'cost', title: 'Cost & billing', description: 'Price estimates before you build and billing analysis after.' },
  { id: 'operations', title: 'Observability & operations', description: 'Metrics, logs, alarms, traces, audit events, networking, AWS Support cases and modernization jobs.' },
  { id: 'security', title: 'Security', description: 'Check an account against the Well-Architected Security Pillar and run AWS Security Agent scans.' },
  { id: 'ai', title: 'AI & machine learning', description: 'Bedrock AgentCore, knowledge bases, custom models, SageMaker AI, translation and document parsing.' },
  { id: 'databases', title: 'Databases', description: 'Query and model data in DynamoDB, Aurora, RDS, DocumentDB, Neptune, Keyspaces and Timestream for InfluxDB.' },
  { id: 'caching', title: 'Caching', description: 'Manage ElastiCache and work with Valkey and Memcached data.' },
  { id: 'analytics', title: 'Data & analytics', description: 'Redshift, S3 Tables, Glue/EMR/Athena pipelines, Spark on SageMaker Unified Studio, IoT SiteWise and open datasets.' },
  { id: 'health', title: 'Healthcare & life sciences', description: 'HealthOmics workflows, HealthImaging DICOM data and HealthLake FHIR stores.' },
]

export const SERVERS: readonly CatalogServer[] = [
  // Start here
  {
    id: 'aws-mcp', name: 'AWS MCP Server', group: 'start', aws: true,
    description: 'Hosted by AWS (preview). Calls any of 300+ AWS services with your IAM permissions, runs sandboxed scripts, searches the documentation and retrieves agent skills. Without credentials only the documentation and skills tools work.',
    docsUrl: 'https://docs.aws.amazon.com/agent-toolkit/latest/userguide/mcp-server.html',
    launch: { kind: 'proxy', url: 'https://aws-mcp.us-east-1.api.aws/mcp', regionMetadata: true, signingRegion: 'us-east-1', args: ['--skip-auth'] },
    readOnly: { args: ['--read-only'] },
    write: {},
  },

  // Documentation
  {
    id: 'aws-knowledge', name: 'AWS Knowledge MCP Server', group: 'docs', aws: false,
    description: 'Managed remote server with the latest AWS docs, API references, What’s New posts, blogs, Well-Architected guidance, CDK and CloudFormation references, regional availability and agent skills. No AWS account needed.',
    docsUrl: docs('aws-knowledge-mcp-server'),
    launch: { kind: 'remote', url: 'https://knowledge-mcp.global.api.aws' },
  },
  {
    id: 'aws-docs', name: 'AWS Documentation MCP Server', group: 'docs', aws: false,
    description: 'Runs locally: searches AWS documentation, reads pages as Markdown and recommends related content.',
    docsUrl: docs('aws-documentation-mcp-server'),
    launch: uvx('aws-documentation-mcp-server', '1.2.5'),
    fields: [{ id: 'partition', label: 'Partition', kind: 'select', options: ['aws', 'aws-cn'], help: 'Use aws-cn for the AWS China documentation.', target: { env: 'AWS_DOCUMENTATION_PARTITION' } }],
  },

  // Infrastructure as Code
  {
    id: 'aws-iac', name: 'AWS IaC MCP Server', group: 'iac', aws: true,
    description: 'CloudFormation documentation, CDK best practices and construct examples, template validation and security checks, and troubleshooting of failed deployments.',
    docsUrl: docs('aws-iac-mcp-server'),
    launch: uvx('aws-iac-mcp-server', '1.0.26'),
  },

  // Containers
  {
    id: 'aws-eks', name: 'Amazon EKS MCP Server', group: 'containers', aws: true,
    description: 'Create and manage EKS clusters, deploy Kubernetes manifests, and read pod logs, events and CloudWatch metrics.',
    docsUrl: docs('eks-mcp-server'), launch: uvx('eks-mcp-server', '0.2.2'),
    write: ALLOW_WRITE, sensitive: ALLOW_SENSITIVE,
  },
  {
    id: 'aws-ecs', name: 'Amazon ECS MCP Server', group: 'containers', aws: true,
    description: 'Containerize an application, deploy it to ECS with Fargate and a load balancer, and troubleshoot running services.',
    docsUrl: docs('ecs-mcp-server'), launch: uvx('ecs-mcp-server', '0.1.38', { bin: 'ecs-mcp-server', with: ['fastmcp<4'] }),
    readOnly: { env: { ALLOW_WRITE: 'false' } }, write: { env: { ALLOW_WRITE: 'true' } },
    sensitive: { env: { ALLOW_SENSITIVE_DATA: 'true' } },
  },
  {
    id: 'aws-finch', name: 'Finch MCP Server', group: 'containers', aws: true,
    description: 'Build container images locally with Finch and push them to Amazon ECR.',
    docsUrl: docs('finch-mcp-server'), launch: uvx('finch-mcp-server', '0.2.1'),
    note: 'Needs Finch installed on this computer.',
  },

  // Serverless
  {
    id: 'aws-serverless', name: 'AWS Serverless MCP Server', group: 'serverless', aws: true,
    description: 'The whole serverless lifecycle with SAM: initialize, build, deploy, test and observe Lambda-based applications, plus serverless architecture guidance.',
    docsUrl: docs('aws-serverless-mcp-server'), launch: uvx('aws-serverless-mcp-server', '0.2.1'),
    write: ALLOW_WRITE, sensitive: ALLOW_SENSITIVE,
    note: 'Deployments need the AWS SAM CLI.',
  },
  {
    id: 'aws-lambda-tool', name: 'AWS Lambda Tool MCP Server', group: 'serverless', aws: true,
    description: 'Exposes selected Lambda functions as tools, so the agent can reach private resources through them.',
    docsUrl: docs('lambda-tool-mcp-server'), launch: uvx('lambda-tool-mcp-server', '2.1.2'),
    fields: [
      text('prefix', 'Function name prefix', { env: 'FUNCTION_PREFIX' }),
      text('list', 'Function names', { env: 'FUNCTION_LIST' }, { placeholder: 'fn-one, fn-two' }),
      text('tagKey', 'Tag key', { env: 'FUNCTION_TAG_KEY' }),
      text('tagValue', 'Tag value', { env: 'FUNCTION_TAG_VALUE' }),
      text('schemaTag', 'Input schema ARN tag key', { env: 'FUNCTION_INPUT_SCHEMA_ARN_TAG_KEY' }),
    ],
    requireAny: ['prefix', 'list', 'tagKey'],
  },

  // Integration
  {
    id: 'aws-sns-sqs', name: 'Amazon SNS/SQS MCP Server', group: 'integration', aws: true,
    description: 'Manage SNS topics and SQS queues, and publish, send and receive messages.',
    docsUrl: docs('amazon-sns-sqs-mcp-server'), launch: uvx('amazon-sns-sqs-mcp-server', '2.1.2'),
    write: { args: ['--allow-resource-creation'] },
  },
  {
    id: 'aws-mq', name: 'Amazon MQ MCP Server', group: 'integration', aws: true,
    description: 'Create and manage RabbitMQ and ActiveMQ brokers on Amazon MQ.',
    docsUrl: docs('amazon-mq-mcp-server'), launch: uvx('amazon-mq-mcp-server', '2.1.1'),
    write: { args: ['--allow-resource-creation'] },
  },
  {
    id: 'aws-stepfunctions', name: 'AWS Step Functions Tool MCP Server', group: 'integration', aws: true,
    description: 'Runs selected Step Functions state machines as tools.',
    docsUrl: docs('stepfunctions-tool-mcp-server'), launch: uvx('stepfunctions-tool-mcp-server', '0.2.2'),
    fields: [
      text('prefix', 'State machine prefix', { env: 'STATE_MACHINE_PREFIX' }),
      text('list', 'State machine names', { env: 'STATE_MACHINE_LIST' }, { placeholder: 'sm-one, sm-two' }),
      text('tagKey', 'Tag key', { env: 'STATE_MACHINE_TAG_KEY' }),
      text('tagValue', 'Tag value', { env: 'STATE_MACHINE_TAG_VALUE' }),
      text('schemaTag', 'Input schema ARN tag key', { env: 'STATE_MACHINE_INPUT_SCHEMA_ARN_TAG_KEY' }),
    ],
    requireAny: ['prefix', 'list', 'tagKey'],
  },
  {
    id: 'aws-appsync', name: 'AWS AppSync MCP Server', group: 'integration', aws: true,
    description: 'Create and manage AppSync GraphQL APIs, data sources, resolvers and functions.',
    docsUrl: docs('aws-appsync-mcp-server'), launch: uvx('aws-appsync-mcp-server', '0.2.1'),
    write: ALLOW_WRITE,
  },
  {
    id: 'aws-location', name: 'Amazon Location Service MCP Server', group: 'integration', aws: true,
    description: 'Place search, geocoding, reverse geocoding, nearby search and route calculation.',
    docsUrl: docs('aws-location-mcp-server'), launch: uvx('aws-location-mcp-server', '2.1.1'),
  },
  {
    id: 'aws-openapi', name: 'OpenAPI MCP Server', group: 'integration', aws: false,
    description: 'Turns any API with an OpenAPI specification into tools, generated from the spec at startup.',
    docsUrl: docs('openapi-mcp-server'), launch: uvx('openapi-mcp-server', '1.1.7'),
    fields: [
      text('name', 'API name', { env: 'API_NAME' }, { required: true, placeholder: 'petstore' }),
      text('baseUrl', 'API base URL', { env: 'API_BASE_URL' }, { required: true, placeholder: 'https://api.example.com' }),
      text('specUrl', 'OpenAPI spec URL', { env: 'API_SPEC_URL' }, { placeholder: 'https://api.example.com/openapi.json' }),
      text('specPath', 'OpenAPI spec file', { env: 'API_SPEC_PATH' }, { placeholder: '/path/to/openapi.json' }),
      { id: 'authType', label: 'Authentication', kind: 'select', options: ['none', 'bearer', 'basic', 'api_key'], target: { env: 'AUTH_TYPE' } },
      secret('token', 'Bearer token', 'AUTH_TOKEN'),
      secret('apiKey', 'API key', 'AUTH_API_KEY'),
      text('apiKeyName', 'API key name', { env: 'AUTH_API_KEY_NAME' }, { placeholder: 'X-API-Key' }),
    ],
    requireAny: ['specUrl', 'specPath'],
  },

  // Cost
  {
    id: 'aws-pricing', name: 'AWS Pricing MCP Server', group: 'cost', aws: true,
    description: 'Current AWS prices, cost estimates and cost reports, including estimates from CDK or Terraform projects.',
    docsUrl: docs('aws-pricing-mcp-server'), launch: uvx('aws-pricing-mcp-server', '1.1.1'),
  },
  {
    id: 'aws-billing', name: 'AWS Billing and Cost Management MCP Server', group: 'cost', aws: true,
    description: 'Cost Explorer, budgets, anomalies, Savings Plans and Reserved Instance coverage, Compute Optimizer and pricing-calculator workloads.',
    docsUrl: docs('billing-cost-management-mcp-server'), launch: uvx('billing-cost-management-mcp-server', '0.0.45'),
  },

  // Operations
  {
    id: 'aws-cloudwatch', name: 'Amazon CloudWatch MCP Server', group: 'operations', aws: true,
    description: 'Metrics, alarms and Logs Insights queries for troubleshooting, with alarm recommendations.',
    docsUrl: docs('cloudwatch-mcp-server'), launch: uvx('cloudwatch-mcp-server', '0.3.1'),
  },
  {
    id: 'aws-app-signals', name: 'CloudWatch Application Signals MCP Server', group: 'operations', aws: true,
    description: 'Service health, SLOs, traces and root-cause analysis from CloudWatch Application Signals.',
    docsUrl: docs('cloudwatch-applicationsignals-mcp-server'), launch: uvx('cloudwatch-applicationsignals-mcp-server', '0.2.1'),
  },
  {
    id: 'aws-prometheus', name: 'Amazon Managed Prometheus MCP Server', group: 'operations', aws: true,
    description: 'PromQL queries and metric discovery on Amazon Managed Service for Prometheus workspaces.',
    docsUrl: docs('prometheus-mcp-server'), launch: uvx('prometheus-mcp-server', '0.3.2'),
    fields: [text('url', 'Workspace URL', { arg: '--url' }, { placeholder: 'https://aps-workspaces.<region>.amazonaws.com/workspaces/ws-…', help: 'Optional. Without it the agent lists the workspaces and picks one.' })],
  },
  {
    id: 'aws-cloudtrail', name: 'AWS CloudTrail MCP Server', group: 'operations', aws: true,
    description: 'Look up CloudTrail events, run CloudTrail Lake queries and investigate who did what.',
    docsUrl: docs('cloudtrail-mcp-server'), launch: uvx('cloudtrail-mcp-server', '0.1.1'),
  },
  {
    id: 'aws-network', name: 'AWS Network MCP Server', group: 'operations', aws: true,
    description: 'Network troubleshooting and path tracing across VPCs, Transit Gateway, Cloud WAN, Network Firewall and VPN.',
    docsUrl: docs('aws-network-mcp-server'), launch: uvx('aws-network-mcp-server', '0.0.17'),
  },
  {
    id: 'aws-support', name: 'AWS Support MCP Server', group: 'operations', aws: true,
    description: 'Create, update and follow AWS Support cases.',
    docsUrl: docs('aws-support-mcp-server'), launch: uvx('aws-support-mcp-server', '0.1.23'),
    note: 'Needs a Business, Enterprise On-Ramp or Enterprise support plan.',
  },
  {
    id: 'aws-transform', name: 'AWS Transform MCP Server', group: 'operations', aws: true,
    description: 'Manage AWS Transform workspaces, jobs, connectors, human-in-the-loop tasks and artifacts for mainframe, VMware, .NET and custom code modernization.',
    docsUrl: docs('aws-transform-mcp-server'), launch: uvx('aws-transform-mcp-server', '0.2.4'),
  },
  {
    id: 'aws-sap', name: 'AWS Systems Manager for SAP MCP Server', group: 'operations', aws: true,
    description: 'Manage SAP applications registered with Systems Manager for SAP: configuration checks and scheduled start, stop and check operations.',
    docsUrl: docs('aws-for-sap-management-mcp-server'), launch: uvx('aws-for-sap-management-mcp-server', '0.1.1'),
  },

  // Security
  {
    id: 'aws-wa-security', name: 'Well-Architected Security Assessment MCP Server', group: 'security', aws: true,
    description: 'Checks an account against the Well-Architected Security Pillar: security services, findings, storage and network encryption.',
    docsUrl: docs('well-architected-security-mcp-server'), launch: uvx('well-architected-security-mcp-server', '0.2.1'),
  },
  {
    id: 'aws-security-agent', name: 'AWS Security Agent MCP Server', group: 'security', aws: true,
    description: 'AWS Security Agent: scan source code for vulnerabilities, run penetration tests and apply the suggested fixes.',
    docsUrl: docs('security-agent-mcp-server'), launch: uvx('security-agent-mcp-server', '0.2.2'),
  },

  // AI & ML
  {
    id: 'aws-agentcore', name: 'Amazon Bedrock AgentCore MCP Server', group: 'ai', aws: true,
    description: 'Direct access to the Bedrock AgentCore APIs (runtimes, memory, identity, gateways and more) plus AgentCore guides, to build and run agents.',
    docsUrl: docs('amazon-bedrock-agentcore-mcp-server'), launch: uvx('amazon-bedrock-agentcore-mcp-server', '0.2.1'),
  },
  {
    id: 'aws-bedrock-kb', name: 'Bedrock Knowledge Bases Retrieval MCP Server', group: 'ai', aws: true,
    description: 'Lists and queries Bedrock knowledge bases and returns cited results.',
    docsUrl: docs('bedrock-kb-retrieval-mcp-server'), launch: uvx('bedrock-kb-retrieval-mcp-server', '1.1.2'),
    fields: [
      text('tagKey', 'Inclusion tag key', { env: 'KB_INCLUSION_TAG_KEY' }, { help: 'Only knowledge bases tagged with this key (value true) are used. Default: mcp-multirag-kb.' }),
      flag('rerank', 'Rerank results', { env: 'BEDROCK_KB_RERANKING_ENABLED' }),
    ],
  },
  {
    id: 'aws-qindex', name: 'Amazon Q index MCP Server', group: 'ai', aws: true,
    description: 'Searches an Amazon Q index with the SearchRelevantContent API (for ISVs).',
    docsUrl: docs('amazon-qindex-mcp-server'), launch: uvx('amazon-qindex-mcp-server', '0.1.0', { with: ['mypy-boto3-qbusiness'] }),
  },
  {
    id: 'aws-bedrock-import', name: 'Bedrock Custom Model Import MCP Server', group: 'ai', aws: true,
    description: 'Imports custom models into Bedrock and manages them for on-demand inference.',
    docsUrl: docs('aws-bedrock-custom-model-import-mcp-server'), launch: uvx('aws-bedrock-custom-model-import-mcp-server', '0.0.23'),
    fields: [
      text('bucket', 'S3 bucket with the model files', { env: 'BEDROCK_MODEL_IMPORT_S3_BUCKET' }, { required: true }),
      text('role', 'Import role ARN', { env: 'BEDROCK_MODEL_IMPORT_ROLE_ARN' }),
    ],
    write: ALLOW_WRITE,
  },
  {
    id: 'aws-sagemaker-ai', name: 'Amazon SageMaker AI MCP Server', group: 'ai', aws: true,
    description: 'Deploy and manage SageMaker HyperPod clusters (EKS or Slurm) for model development.',
    docsUrl: docs('sagemaker-ai-mcp-server'), launch: uvx('sagemaker-ai-mcp-server', '1.1.1'),
    write: ALLOW_WRITE, sensitive: ALLOW_SENSITIVE,
  },
  {
    id: 'aws-translate', name: 'Amazon Translate MCP Server', group: 'ai', aws: true,
    description: 'Translation across 75+ languages, language detection, batch jobs and custom terminology.',
    docsUrl: docs('amazon-translate-mcp-server'), launch: uvx('amazon-translate-mcp-server', '1.0.7'),
  },
  {
    id: 'aws-document-loader', name: 'Document Loader MCP Server', group: 'ai', aws: false,
    description: 'Extracts text and content from PDF, Word, Excel, PowerPoint and image files on this computer.',
    docsUrl: docs('document-loader-mcp-server'), launch: uvx('document-loader-mcp-server', '1.0.25'),
  },

  // Databases
  {
    id: 'aws-dynamodb', name: 'Amazon DynamoDB MCP Server', group: 'databases', aws: true,
    description: 'Expert DynamoDB design guidance and data modeling.',
    docsUrl: docs('dynamodb-mcp-server'), launch: uvx('dynamodb-mcp-server', '2.1.10'),
  },
  {
    id: 'aws-postgres', name: 'Amazon Aurora PostgreSQL MCP Server', group: 'databases', aws: true,
    description: 'Runs SQL on Aurora and RDS PostgreSQL through the RDS Data API or a direct connection. The agent connects with the connect_to_database tool.',
    docsUrl: docs('postgres-mcp-server'), launch: uvx('postgres-mcp-server', '1.2.4'),
    write: ALLOW_WRITE_QUERY,
  },
  {
    id: 'aws-mysql', name: 'Amazon Aurora MySQL MCP Server', group: 'databases', aws: true,
    description: 'Runs SQL on Aurora and RDS MySQL through the RDS Data API. The agent connects with the connect_to_database tool.',
    docsUrl: docs('mysql-mcp-server'), launch: uvx('mysql-mcp-server', '1.1.5'),
    write: ALLOW_WRITE_QUERY,
  },
  {
    id: 'aws-dsql', name: 'Amazon Aurora DSQL MCP Server', group: 'databases', aws: true,
    description: 'Queries and transactions on an Aurora DSQL cluster, plus DSQL documentation.',
    docsUrl: docs('aurora-dsql-mcp-server'), launch: uvx('aurora-dsql-mcp-server', '1.1.5'),
    regionArg: '--region',
    fields: [
      text('endpoint', 'Cluster endpoint', { arg: '--cluster_endpoint' }, { required: true, placeholder: '<id>.dsql.<region>.on.aws' }),
      text('user', 'Database user', { arg: '--database_user' }, { required: true, placeholder: 'admin' }),
    ],
    write: { args: ['--allow-writes'] },
  },
  {
    id: 'aws-documentdb', name: 'Amazon DocumentDB MCP Server', group: 'databases', aws: true,
    description: 'Queries, aggregations and schema analysis on the DocumentDB cluster you configure.',
    docsUrl: docs('documentdb-mcp-server'), launch: uvx('documentdb-mcp-server', '2.0.1'),
    fields: [secret('connection', 'Connection string', 'DOCUMENTDB_CONNECTION_STRING', { required: true, placeholder: 'mongodb://user:password@cluster…:27017/?tls=true&retryWrites=false' })],
    write: ALLOW_WRITE,
  },
  {
    id: 'aws-neptune', name: 'Amazon Neptune MCP Server', group: 'databases', aws: true,
    description: 'openCypher and Gremlin queries and the graph schema of a Neptune Database or Neptune Analytics graph.',
    docsUrl: docs('amazon-neptune-mcp-server'), launch: uvx('amazon-neptune-mcp-server', '1.1.1'),
    fields: [text('endpoint', 'Neptune endpoint', { env: 'NEPTUNE_ENDPOINT' }, { required: true, placeholder: 'neptune-db://<host> or neptune-graph://<graph id>' })],
  },
  {
    id: 'aws-keyspaces', name: 'Amazon Keyspaces MCP Server', group: 'databases', aws: true,
    description: 'Explore keyspaces and tables and run CQL queries on Amazon Keyspaces or Apache Cassandra.',
    docsUrl: docs('amazon-keyspaces-mcp-server'), launch: uvx('amazon-keyspaces-mcp-server', '0.0.19', { python: '3.11' }),
    env: { DB_USE_KEYSPACES: 'true' },
    fields: [
      text('endpoint', 'Keyspaces endpoint', { env: 'DB_KEYSPACES_ENDPOINT' }, { required: true, placeholder: 'cassandra.us-east-1.amazonaws.com' }),
      text('region', 'Keyspaces region', { env: 'DB_KEYSPACES_REGION' }, { required: true, placeholder: 'us-east-1' }),
      text('username', 'Service-specific user name', { env: 'DB_CASSANDRA_USERNAME' }, { required: true }),
      secret('password', 'Service-specific password', 'DB_CASSANDRA_PASSWORD', { required: true }),
    ],
  },
  {
    id: 'aws-timestream', name: 'Timestream for InfluxDB MCP Server', group: 'databases', aws: true,
    description: 'Manage Timestream for InfluxDB instances and query or write InfluxDB data.',
    docsUrl: docs('timestream-for-influxdb-mcp-server'), launch: uvx('timestream-for-influxdb-mcp-server', '0.1.3'),
    fields: [
      text('url', 'InfluxDB URL', { env: 'INFLUXDB_URL' }, { placeholder: 'https://<host>:8086', help: 'Optional. Needed for data queries, not for managing instances.' }),
      text('org', 'InfluxDB organization', { env: 'INFLUXDB_ORG' }),
      secret('token', 'InfluxDB token', 'INFLUXDB_TOKEN'),
    ],
    write: { env: { ALLOW_WRITE: 'true', INFLUXDB_WRITE_MODE: 'true' } },
  },
  {
    id: 'aws-mssql', name: 'Amazon RDS for SQL Server MCP Server', group: 'databases', aws: true,
    description: 'Runs SQL on RDS for SQL Server with credentials from Secrets Manager. The agent connects with the connect_to_database tool.',
    docsUrl: docs('mssql-mcp-server'), launch: uvx('mssql-mcp-server', '0.2.3'),
    fields: [text('secretArn', 'Secrets Manager secret ARN', { arg: '--secret_arn' }, { help: 'Optional. Default: the instance’s master user secret.' })],
    write: ALLOW_WRITE_QUERY,
  },
  {
    id: 'aws-oracle', name: 'Amazon RDS for Oracle MCP Server', group: 'databases', aws: true,
    description: 'Runs SQL on the RDS for Oracle or Oracle Database@AWS database you configure, with credentials from Secrets Manager.',
    docsUrl: docs('oracle-mcp-server'), launch: uvx('oracle-mcp-server', '0.2.3', { args: ['--connection_method', 'ORACLE_PASSWORD'] }),
    regionArg: '--region',
    fields: [
      text('endpoint', 'Database endpoint', { arg: '--db_endpoint' }, { placeholder: '<instance>.<id>.<region>.rds.amazonaws.com' }),
      text('instance', 'Instance identifier', { arg: '--instance_identifier' }),
      text('service', 'Service name', { arg: '--service_name' }, { placeholder: 'ORCL' }),
      text('port', 'Port', { arg: '--port' }, { placeholder: '2484', help: 'TLS (the default) listens on 2484.' }),
      text('secretArn', 'Secrets Manager secret ARN', { arg: '--secret_arn' }),
    ],
    requireAny: ['endpoint', 'instance'],
    write: ALLOW_WRITE_QUERY,
  },
  {
    id: 'aws-db2', name: 'Amazon RDS for Db2 MCP Server', group: 'databases', aws: true,
    description: 'Runs SQL on RDS for Db2 over TLS with credentials from Secrets Manager. The agent connects with the connect_to_database tool.',
    docsUrl: docs('db2-mcp-server'), launch: uvx('db2-mcp-server', '0.1.1'),
    regionArg: '--region',
    fields: [
      text('certificate', 'RDS certificate bundle (PEM)', { arg: '--ssl_server_certificate' }, { required: true, placeholder: '/path/to/<region>-bundle.pem' }),
      text('secretArn', 'Secrets Manager secret ARN', { arg: '--secret_arn' }),
    ],
    write: ALLOW_WRITE_QUERY,
  },

  // Caching
  {
    id: 'aws-elasticache', name: 'Amazon ElastiCache MCP Server', group: 'caching', aws: true,
    description: 'The ElastiCache control plane: clusters, replication groups and serverless caches.',
    docsUrl: docs('elasticache-mcp-server'), launch: uvx('elasticache-mcp-server', '0.2.3'),
    readOnly: READONLY_FLAG, write: {},
  },
  {
    id: 'aws-valkey', name: 'ElastiCache / MemoryDB for Valkey MCP Server', group: 'caching', aws: true,
    description: 'Work with Valkey data structures, caching patterns and vector search.',
    docsUrl: docs('valkey-mcp-server'), launch: uvx('valkey-mcp-server', '1.1.3'),
    fields: [
      text('host', 'Host', { env: 'VALKEY_HOST' }, { required: true, placeholder: '127.0.0.1' }),
      text('port', 'Port', { env: 'VALKEY_PORT' }, { placeholder: '6379' }),
      text('username', 'User name', { env: 'VALKEY_USERNAME' }),
      secret('password', 'Password', 'VALKEY_PWD'),
      flag('tls', 'Use TLS', { env: 'VALKEY_USE_SSL' }),
      flag('cluster', 'Cluster mode', { env: 'VALKEY_CLUSTER_MODE' }),
    ],
    readOnly: READONLY_FLAG, write: {},
  },
  {
    id: 'aws-memcached', name: 'ElastiCache for Memcached MCP Server', group: 'caching', aws: false,
    description: 'Get, set and manage cache entries on a Memcached endpoint.',
    docsUrl: docs('memcached-mcp-server'), launch: uvx('memcached-mcp-server', '1.1.2'),
    fields: [
      text('host', 'Host', { env: 'MEMCACHED_HOST' }, { required: true }),
      text('port', 'Port', { env: 'MEMCACHED_PORT' }, { placeholder: '11211' }),
      flag('tls', 'Use TLS', { env: 'MEMCACHED_USE_TLS' }),
    ],
    readOnly: READONLY_FLAG, write: {},
  },

  // Analytics
  {
    id: 'aws-redshift', name: 'Amazon Redshift MCP Server', group: 'analytics', aws: true,
    description: 'Discover Redshift clusters and serverless workgroups, browse schemas and run queries.',
    docsUrl: docs('redshift-mcp-server'), launch: uvx('redshift-mcp-server', '0.1.3'),
  },
  {
    id: 'aws-s3-tables', name: 'AWS S3 Tables MCP Server', group: 'analytics', aws: true,
    description: 'Manage S3 table buckets, namespaces and tables for analytics.',
    docsUrl: docs('s3-tables-mcp-server'), launch: uvx('s3-tables-mcp-server', '0.1.1'),
    write: ALLOW_WRITE,
  },
  {
    id: 'aws-data-processing', name: 'AWS Data Processing MCP Server', group: 'analytics', aws: true,
    description: 'Glue Data Catalog and jobs, EMR on EC2 and Athena queries for data pipelines.',
    docsUrl: docs('aws-dataprocessing-mcp-server'), launch: uvx('aws-dataprocessing-mcp-server', '0.2.3'),
    write: ALLOW_WRITE, sensitive: ALLOW_SENSITIVE,
  },
  {
    id: 'aws-spark-troubleshoot', name: 'Spark Troubleshooting (SageMaker Unified Studio)', group: 'analytics', aws: true,
    description: 'Hosted by AWS: diagnoses failed Spark jobs on Glue, EMR and SageMaker Unified Studio.',
    docsUrl: docs('sagemaker-unified-studio-spark-troubleshooting-mcp-server'),
    launch: { kind: 'proxy', url: 'https://sagemaker-unified-studio-mcp.{region}.api.aws/spark-troubleshooting/mcp', service: 'sagemaker-unified-studio-mcp', args: ['--read-timeout', '180'] },
  },
  {
    id: 'aws-spark-code-rec', name: 'Spark Code Recommendation (SageMaker Unified Studio)', group: 'analytics', aws: true,
    description: 'Hosted by AWS: recommends fixes and optimizations for Spark code.',
    docsUrl: docs('sagemaker-unified-studio-spark-troubleshooting-mcp-server'),
    launch: { kind: 'proxy', url: 'https://sagemaker-unified-studio-mcp.{region}.api.aws/spark-code-recommendation/mcp', service: 'sagemaker-unified-studio-mcp', args: ['--read-timeout', '180'] },
  },
  {
    id: 'aws-spark-upgrade', name: 'Spark Upgrade (SageMaker Unified Studio)', group: 'analytics', aws: true,
    description: 'Hosted by AWS: upgrades PySpark and Scala applications to newer Spark versions.',
    docsUrl: docs('sagemaker-unified-studio-spark-upgrade-mcp-server'),
    launch: { kind: 'proxy', url: 'https://sagemaker-unified-studio-mcp.{region}.api.aws/spark-upgrade/mcp', service: 'sagemaker-unified-studio-mcp', args: ['--read-timeout', '180'] },
  },
  {
    id: 'aws-iot-sitewise', name: 'AWS IoT SiteWise MCP Server', group: 'analytics', aws: true,
    description: 'Industrial assets, models, data ingestion and analytics in IoT SiteWise.',
    docsUrl: docs('aws-iot-sitewise-mcp-server'), launch: uvx('aws-iot-sitewise-mcp-server', '11.0.23'),
    write: { env: { SITEWISE_MCP_ALLOW_WRITES: 'True' } },
  },
  {
    id: 'aws-roda', name: 'Registry of Open Data on AWS MCP Server', group: 'analytics', aws: false,
    description: 'Find, explore and preview the public datasets in the Registry of Open Data on AWS.',
    docsUrl: docs('roda-mcp-server'), launch: uvx('roda-mcp-server', '0.1.8'),
  },

  // Health
  {
    id: 'aws-healthomics', name: 'AWS HealthOmics MCP Server', group: 'health', aws: true,
    description: 'Create, run, debug and optimize HealthOmics workflows and search genomics files.',
    docsUrl: docs('aws-healthomics-mcp-server'), launch: uvx('aws-healthomics-mcp-server', '0.1.7'),
    fields: [text('buckets', 'Genomics S3 buckets', { env: 'GENOMICS_SEARCH_S3_BUCKETS' }, { placeholder: 's3://my-data/,s3://refs/', help: 'Optional. Buckets the file search looks in.' })],
  },
  {
    id: 'aws-healthimaging', name: 'AWS HealthImaging MCP Server', group: 'health', aws: true,
    description: 'Search, retrieve and manage HealthImaging data stores and DICOM image sets.',
    docsUrl: docs('healthimaging-mcp-server'), launch: uvx('healthimaging-mcp-server', '0.1.2'),
  },
  {
    id: 'aws-healthlake', name: 'AWS HealthLake MCP Server', group: 'health', aws: true,
    description: 'FHIR data stores in HealthLake: search, read, create and update resources, and import or export jobs.',
    docsUrl: docs('healthlake-mcp-server'), launch: uvx('healthlake-mcp-server', '0.0.21', { with: ['mcp<2'] }),
    readOnly: READONLY_FLAG, write: {},
  },
]

/** Every catalog server by id. */
export const SERVER_BY_ID: ReadonlyMap<string, CatalogServer> = new Map(SERVERS.map(server => [server.id, server]))
