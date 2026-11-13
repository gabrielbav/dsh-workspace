# dsh-code

**Code mode for [DeepSeek Harness](https://github.com/gabrielbav/deepseek-harness).** Pick a repository and a branch, chat as usual, and every command and file edit the agent makes runs in its own gVisor sandbox, on its own branch, behind an egress allowlist. That sandbox runs on your computer or on a VM you own.

```text
 your computer                                        Docker host: this computer, or your Azure / AWS VM over SSH
┌───────────────────────────────────────┐            ┌───────────────────────────────────────────────────────────┐
│ DeepSeek Harness + dsh-code           │  docker    │  session A ┌───────────────────────┐                      │
│  • chat, model, approvals, history    │  exec ───▶ │            │ gVisor kernel (runsc) │  checkout + branch   │
│  • GitHub token (gh), never shipped   │            │            │ uid 1000, no caps,    │  dsh-code/3f9a…      │
│  • bare Git mirror per session ◀──────┼─ bundles ──┤            │ read-only root        │                      │
│      clone ▶ / ◀ push                 │            │            └──────────┬────────────┘                      │
│  • Preview tab ◀── docker exec relay ─┼────────────┤  session B ┌──────────┴────────────┐  internal network,   │
│                                       │            │            │ gVisor … (separate)   │  no route out        │
└───────────────────────────────────────┘            │            └──────────┬────────────┘                      │
                                                     │                ┌──────▼──────┐   allowlist, no private  │
                                                     │                │ egress proxy├──▶ IPs, DNS checked once  │
                                                     │                └─────────────┘   per-session approvals   │
                                                     └───────────────────────────────────────────────────────────┘
```

Docs: [remote VMs (Azure, AWS)](https://github.com/gabrielbav/dsh-code/blob/main/docs/remote.md) · [spec](https://github.com/gabrielbav/dsh-code/blob/main/docs/spec.md) · [design decisions](https://github.com/gabrielbav/dsh-code/blob/main/docs/validation.md) · [plan and open work](https://github.com/gabrielbav/dsh-code/blob/main/docs/plan.md)

## What changes in a Code mode session

| | A standard Harness session | A Code mode session |
|---|---|---|
| Where commands run | On your computer, in the folder you chose | In a gVisor container of its own, one per session |
| Kernel | The host's; the built-in sandbox confines file writes | gVisor's user-space kernel between the agent and the host kernel |
| Files the agent can reach | Your folder (writes confined by the permission mode) | Only the session's checkout, plus folders you add read-only |
| Network | Open | An egress proxy with an allowlist; direct IPs, private, link-local and metadata addresses refused; new hosts approved per session |
| Git | Your working tree | A fresh checkout on its own `dsh-code/…` branch; pushes only that branch |
| Credentials | In your environment | The GitHub token stays on your computer; nothing credential-like enters the sandbox |
| Where it can run | This computer | This computer (Linux, macOS) or a VM you own |

Chat, models, approvals, streaming, skills and history stay Harness's own. Code mode only changes where commands and file tools run, through documented extension points: Harness itself needs no changes.

## Quick start

1. **Install** from **Settings > Plugins > Add plugin** (`@gabrielbav/dsh-code`), or `dsh plugin --profile web add @gabrielbav/dsh-code`.
2. **Choose Code mode** in the mode selector. A setup notice lists anything missing (Docker, gVisor, the worker image) with how to fix it, and **Build worker image** builds the image for you. Code stays off until every check passes; it never falls back to ordinary Docker.
3. **Pick a repository and branch** with **+ → Repository** and **+ → Branch**, then send a message. The workspace starts with that first message.

Rather not run Docker on this computer? Point Code at your own VM: **Settings > Code > Remote Docker host**, then **Prepare the VM**. See [docs/remote.md](https://github.com/gabrielbav/dsh-code/blob/main/docs/remote.md) for Azure and AWS, step by step.

## Features

### The coding workflow

- **"Code mode" in the mode selector**, in any Workspace. From the first message the session works in its own checkout; switching modes before then drops the Code choices.
- **Repository and Branch in the + menu** (also `/repository` and `/branch`), only on Code mode sessions. Repositories of every account the `gh` CLI is signed in with, grouped by account; the group you pick from is the account that clones and pushes. Accounts can be hidden in Settings > Code.
- **A branch per session** (`dsh-code/<hash>`) by default, or work on the chosen branch itself.
- **Subagents** spawned or forked in a Code session inherit the preset and run in the same container and checkout.
- **Delete session** in the header removes the workspace and the session, after warning about uncommitted or unpushed work. A session deleted any other way loses its workspace too: a sweep removes workspaces whose session no longer exists. Remote branches and pull requests are never deleted.

### The Environment tab

Beside Chat and Trajectory: the GitHub account, repository, branches and commit, workspace status, where it runs, network policy, sandbox options, live CPU, memory, process and disk usage, and the provisioning timeline step by step. It also holds this session's Preview options, variables and approved hosts. Host paths, container names and images are not shown.

### The Preview tab

The web app the agent starts, found by the port it listens on. It is reached through `docker exec`, so no host port is published and no route into the container exists; it works the same on Linux, macOS, Windows and a remote VM. Two modes, both switchable in Settings and per session:

- **Frame:** a sandboxed frame in your browser, with an opaque origin, no cookies forwarded and no logins.
- **Isolated browser:** Chromium runs inside the sandbox and only screen frames leave it, so page code never runs on your computer and apps with logins work.

### Safety controls, all yours to set

- **The Harness permission selector applies.** Read-only mounts the checkout read-only (the container restarts when you switch). Full access never opens the sandbox.
- **Ask before a blocked host.** When a request hits the allowlist, the agent can call `request_network_access` with the host and a reason; the Harness approval card asks you (Allow once or Reject, never "always"). An approved host is added for that session only, and the Environment tab lists it with Remove. Nothing is granted with the network off, in a session that never asks, or without your yes.
- **Lockdown:** no network, a read-only workspace, no cache, no extra folders, whatever else is set.
- **Read-only workspace, dependency cache, extra read-only folders** (with a folder picker), **shared memory size** and **environment variables** (defaults in Settings, per-session values in the Environment tab; credential-like names refused). All off or empty by default.
- **Clear refusals.** Every sandbox refusal reads `[sandbox: …]`, and a stopped container reports `[sandbox: the Code workspace is offline]` instead of a misleading error; the next message restarts it.

### Where it runs

- **Linux:** the checkout is a folder under the data folder.
- **macOS with Colima:** gVisor shows folders shared from the Mac as owned by root, so the sandbox user cannot write them. Code detects this at setup and keeps the checkout in a Docker volume inside the VM instead, still as the non-root user. **Settings > Code > Checkout storage** can force either.
- **Your own VM (Azure, AWS, any SSH host):** give the host, login, key file and the VM's host key fingerprint. Code drives Docker there over SSH with its own config (pinned host key, one key file, no prompts, no forwarding) and never touches `~/.ssh`. **Prepare the VM** installs Docker and gVisor with `sudo`. Your GitHub token and the Git mirror stay on your computer; the agent's traffic leaves from the VM.

## Verified by tests

Unit tests (127) cover the policy, proxy, settings, container spec, remote settings and key pinning, the approval tool and the preset file. The live suites create real gVisor containers and check, among others:

- the container kernel is gVisor, the user is uid 1000, capabilities are all zero, the root filesystem is read-only, and there is no Docker socket;
- direct egress is blocked, unlisted hosts and the metadata address get 403, a tightened policy refuses a destination at once, and a host approved for one session is refused to another;
- 1,000 reads through the file helper while sandbox code swaps a symlink between a workspace file and a host file never return the host file;
- a `pre-push` hook and a `core.fsmonitor` command planted in the checkout do not run on the host when it pushes;
- real exit codes, whole process groups stopped, an offline container reported as such, and cleanup after restart (containers, checkouts, mirrors, volumes);
- on macOS, the non-root sandbox user writes, commits and pushes from a volume checkout;
- over SSH to a remote Docker host: the host key pin (a wrong fingerprint is refused), provisioning on the VM, the file helper and Preview relay through SSH, egress filtering and a session grant on the VM, and a push from this computer.

```sh
pnpm test                 # unit tests
pnpm run test:docker      # live tests; needs Docker, runsc and the worker image
```

## Requirements

- Docker Engine with the gVisor `runsc` runtime registered, on Linux, in a Colima VM on macOS, or on a remote VM (Prepare the VM installs both there). There is no fallback to ordinary Docker.
- The GitHub CLI (`gh`) signed in with one or more accounts. Each session uses one: its token is read with `gh auth token --user` and passed as `GH_TOKEN` only to that session's `gh` and `git` processes on your computer. No token enters a container or reaches a remote VM.
- DeepSeek Harness 0.2.2 or later.
- The worker image (about 1.8 GB, including headless Chromium for the isolated browser). **Build worker image** builds it; by hand, after `pnpm run build`:

```sh
docker build -t dsh-code-worker:0.3.0 packages/dsh-code/worker
```

Registering gVisor with Docker on Linux (see [gVisor's install guide](https://gvisor.dev/docs/user_guide/install/)):

```sh
sudo apt-get install -y runsc     # from gVisor's apt repository; configures Docker when it is installed
sudo runsc install && sudo systemctl restart docker
```

## Install from source

```sh
pnpm install && pnpm run build
(cd packages/dsh-code && pnpm pack --pack-destination ../..)
dsh plugin --profile web add ./gabrielbav-dsh-code-0.3.0.tgz
```

The package declares a Harness bundle, so `dsh plugin add` appends it to the profile's bundle list. Its `@deepseek-ai/*` dependencies are peers satisfied by the running Harness.

## Configure

Use **Settings > Code**, or override the `code-workspaces` row in the profile's `cordis.patch.yml`:

```yaml
- id: code-workspaces
  config:
    dataDir: /var/lib/dsh-code      # workspaces, mirrors, records
    workerImage: dsh-code-worker:0.3.0
    cpus: 2
    memoryMb: 4096
    pids: 512
    tmpMb: 1024
    maxWorkspaces: 8
    network: allowlist              # allowlist | none | open
    allow: [github.com, '*.github.com', registry.npmjs.org, pypi.org]
    privateAllow: []                # explicit private destinations, as host:port
    ports: [80, 443]
    previewPorts: []                # container ports that may be previewed, e.g. [3000, 5173]
    storage: auto                   # auto | bind | volume
    remoteHost: ''                  # a VM's address runs sandboxes there over SSH
    remotePort: 22
    remoteUser: ''
    remoteIdentityFile: ''          # private key file on this computer
    remoteHostKey: ''               # the VM's SHA256 host key fingerprint
```

Settings > Code edits everything above except `dataDir`. Changes apply without restarting Harness; changing the remote host reloads Code with it. `/tmp` size and image changes reach a workspace when it restarts. `dataDir` defaults to `~/.dsh-code`, or `/var/lib/dsh-code` when Harness runs as root.

## Security model

| Control | How it is enforced |
| --- | --- |
| Runtime | Every workspace container is created with `--runtime runsc` and checked after start; the setup check confirms the container kernel is gVisor. No fallback |
| Privileges | Non-root user, `--cap-drop ALL`, `no-new-privileges`, read-only root filesystem, tmpfs `/tmp`, CPU, memory and process limits. No create-time working directory on the checkout mount (on gVisor it would make the mount read as root-owned) |
| Docker socket and host files | Never mounted. The only writable mount is the session's own checkout (a folder, or a Docker volume). Opt-in: a per-repository dependency cache and extra read-only folders; home roots, credential folders (`~/.ssh`, `~/.aws`, `~/.config/gh`, …), system folders, the Docker socket and the Code data folder are refused |
| Processes | The preset's `ctx.subprocess` runs every command through `docker exec` in the session's container and refuses any directory outside a ready Code workspace |
| File tools | The preset's `ctx.fs` runs every file operation inside the container, through a helper baked into the worker image. Symlinks resolve in the container's mount namespace, so a link swapped by sandbox code cannot reach a host file; the host checks every target the helper returns |
| Prompt files | `CLAUDE.md`, `AGENTS.md` and skills in the checkout are read through the container, so a repository symlink to a host file finds nothing |
| Git | The host never runs Git in the sandbox-writable checkout. A volume checkout is imported from a bundle of the host's mirror; every push streams a bundle out of the sandbox (2 GiB cap), which the host checks with `git bundle verify` before pushing only the session's `dsh-code/…` branch from its own mirror |
| Credentials | Model credentials stay in Harness. The session's GitHub token goes only to its `gh` and `git` processes on your computer, never into a container or to a remote VM. Credential-looking variable names are never forwarded |
| Network | An internal Docker network with no route out. The egress proxy admits only allowlisted host names, refuses direct IPs, IPv6, private, CGNAT, link-local, multicast and metadata addresses (also after DNS resolution), dials the address it checked, and closes tunnels a tightened policy refuses. The worker has no DNS. Per-session approvals are keyed by the container's internal address and dropped when that container stops |
| Approvals | `request_network_access` asks through the Harness approval card; Allow once or Reject only. The proxy points to it only for hosts missing from the allowlist |
| Previews | Through `docker exec`, never a published port. Frame mode: `Content-Security-Policy: sandbox` without `allow-same-origin`, no Cookie or Authorization forwarded, Set-Cookie dropped, tokens bound to one session and port for 8 hours. Isolated mode: only JPEG frames leave the sandbox; the bridge accepts a fixed set of actions, never raw DevTools access |
| Remote host | Code's own SSH config: the host key you give is pinned (any other key is refused, and the pin is cleared when a check fails), one key file, `BatchMode`, no agent, port or X11 forwarding. The key file is only referenced. Invalid remote settings start no workspace anywhere rather than falling back to this computer |
| Lifecycle | Records survive restarts; startup removes orphaned containers and volumes, marks missing ones offline and refreshes the egress proxy when its code changed. Live tests run under their own Docker namespace and never touch a running install |

The `code` preset leaves out tools that would act from the host on the agent's behalf: out-of-process subagent providers (SDK, Claude Code, Codex, ACP), workflows, web fetch, office documents and plugin management. In-process subagents and web search remain.

## Known limitations

- **Previews** need `dsh web` (the desktop app has no web server) and proxy plain HTTP only: no WebSocket, so no dev-server hot reload. Apps work best with relative asset paths.
- **Volume checkouts** (macOS, remote VMs) are not visible in Finder or in the Harness file tree, and deleting the Docker VM loses work that was not pushed.
- **On a remote VM**, extra read-only folders are skipped (they are on your computer). **Prepare the VM** has been run against a VM that already had Docker and gVisor, not yet against a fresh Azure or AWS VM.
- **Windows (WSL2)** is untested.
- **Host-configured MCP servers** run on the host as before; repository-defined MCP servers are not started for Code sessions.
- **Choices before the first message** (repository, branch, account) live in memory until the workspace starts.
- **Not implemented yet:** Remote Control, team deployment, a published digest-pinned worker image (see the [plan](https://github.com/gabrielbav/dsh-code/blob/main/docs/plan.md)).

## Develop

```sh
pnpm install
pnpm run build        # tsc, Typert metadata, browser bundle, worker helpers
pnpm test             # unit tests
pnpm run test:docker  # live Docker + gVisor tests; on macOS run with TMPDIR under $HOME
```

The remote suite runs against any VM with Docker, gVisor and the worker image; [docs/remote.md](https://github.com/gabrielbav/dsh-code/blob/main/docs/remote.md#testing-code-against-a-remote-host) shows the variables (the Colima VM's own SSH server works too).

The build uses only published packages: `@deepseek-ai/dsh-*@0.2.2-rc.1` for types and the Typert generator, patched (`patches/`) so it recognizes the npm-installed protocol package outside the Harness monorepo.

## Layout

```text
packages/dsh-code/
  src/core/      Docker CLI, container spec, workspace manager, remote host, host Git, GitHub CLI, settings
  src/egress/    egress policy and proxy (runs in its own container)
  src/host/      Harness plugins: codeWorkspaces service, Docker subprocess, container fs, prompt fs, preview, isolated browser, network tool
  src/worker/    in-container file helper and browser bridge
  src/client/    Web UI: + menu rows, status line, Environment and Preview tabs, Settings > Code
  worker/        worker image Dockerfile
  cordis.patch.yml  bundle rows and the `code` preset
docs/remote.md   running sandboxes on an Azure or AWS VM
```
