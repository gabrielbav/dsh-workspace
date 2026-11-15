# dsh-workspace

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), and the tooling to build and run them against the harness from source.

| Plugin | npm | What it does |
| --- | --- | --- |
| [dsh-code](Plugins/dsh-code) | [`@gabrielbav/dsh-code`](https://www.npmjs.com/package/@gabrielbav/dsh-code) | Code mode: each session gets its own Docker + gVisor workspace with a repository and branch you pick |
| [dsh-plugin-airlock](Plugins/dsh-plugin-airlock) | [`dsh-plugin-airlock`](https://www.npmjs.com/package/dsh-plugin-airlock) | Quarantines and scans plugins, skills and subagents before they install: six security scanners and an optional LLM judge |
| [dsh-connectors](Plugins/dsh-connectors) | [`@gabrielbav/dsh-connectors`](https://www.npmjs.com/package/@gabrielbav/dsh-connectors) | A Connectors page in Settings for remote MCP servers (Granola, GitHub, GitLab, Azure DevOps, custom), and a service other plugins register connectors with |
| [dsh-plugin-aws](Plugins/dsh-plugin-aws) | [`@gabrielbav/dsh-plugin-aws`](https://www.npmjs.com/package/@gabrielbav/dsh-plugin-aws) | Settings → AWS: turn the official AWS MCP servers (awslabs) on and off by group or one by one |
| [dsh-plugin-session-delete](Plugins/dsh-plugin-session-delete) | [`@gabrielbav/dsh-plugin-session-delete`](https://www.npmjs.com/package/@gabrielbav/dsh-plugin-session-delete) | Delete sessions and workspaces permanently |

## Install a plugin

You don't need this repo to use a plugin. In DSH, open **Settings → Plugins → Add plugin** and enter the npm name, or run:

```sh
dsh plugin --profile web add -w @gabrielbav/dsh-connectors
```

Each plugin's README covers its settings and requirements.

## Develop

Requirements: Node >= 24.9, corepack (for pnpm 11.28.5), git and the `gh` CLI. dsh-code also needs Docker with the gVisor (`runsc`) runtime.

```sh
git clone https://github.com/gabrielbav/dsh-workspace
cd dsh-workspace
make bootstrap          # clones the harness fork, builds it with its hook branches, then every plugin
make start-all          # boots DSH with every plugin (or: make start P="airlock code")
```

Run `make help` for every target. The layout:

| Path | What it is |
| --- | --- |
| `Plugins/<name>` | One plugin per folder, each with its own `package.json`, lockfile and npm package |
| `Fork/deepseek-harness` | Submodule: a fork of DeepSeek Harness. A few plugins need small generic hooks that live on its `feat/*` branches |
| `Fork/sync.sh` | Builds the fork's `local/daily` branch: upstream `master` with every `feat/*` hook stacked on top |
| `Makefile` | Builds the fork and the plugins and boots DSH with any set of plugins, each set in its own profile |

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## License

MIT, see [LICENSE](LICENSE). Each plugin also ships its own LICENSE file.
