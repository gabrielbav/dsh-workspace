# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This repository is `gabrielbav/dsh-workspace`: plugins for DeepSeek Harness (DSH) plus the tooling to build and run them against a fork of the harness. It is a monorepo for the plugins, with the fork as a git submodule. Each plugin folder keeps its own `package.json`, lockfile, dependency install and npm package, so run plugin commands from inside that plugin's folder. There is no root pnpm workspace on purpose: pnpm searches upward, and one would change every plugin's install.

**This file is the only place for agent instructions.** Never add new CLAUDE.md, AGENTS.md or other agent-instruction files under `Plugins/` or to the fork (`Plugins/dsh-code/CLAUDE.md` and the fork's upstream files predate this rule and stay as they are). Add any new guidance here.

Before 2026-11-15 each plugin was its own GitHub repo; their histories were imported into `Plugins/<name>` with paths rewritten, so `git log -- Plugins/<name>` shows the full history.

Some steps below are marked as the maintainer's (`gabrielbav`): pushing to the fork, `make sync` onto a new upstream, npm releases and awesome-list PRs. A contributor builds with `make bootstrap` and syncs with `make sync PUSH=0 BASE=origin/master`, which never pushes and stays on the upstream commit the fork's `feat/*` branches were last rebased onto.

### The fork submodule

`Fork/deepseek-harness` is a submodule with `ignore = all`. The recorded commit is only the `master` a fresh clone starts from; the checkout itself runs on `local/daily`, which is built locally and never pushed. So:
- Never run `git submodule update` on an existing checkout: it detaches the fork from `local/daily`.
- The fork needs a plain `.git` directory. A `--recurse-submodules` clone keeps it under `.git/modules` with `core.worktree`, and the harness's lefthook postinstall then fails `pnpm install`. `make bootstrap` clones the fork itself when it is missing, and moves the git dir into place when it finds the submodule layout.
- `ignore = all` does not stop `git add -A` or `git commit -a` from recording the fork's current commit (`local/daily`). The Makefile marks the gitlink `skip-worktree` (`make build`, `make bootstrap`, `make start*`) so `git add` leaves it alone; in a new clone, run `git update-index --skip-worktree Fork/deepseek-harness` before the first `git add -A`. Before pushing, `git ls-tree HEAD Fork/deepseek-harness` must show a commit that is on the fork's `origin/master`.
- To move the recorded commit (rarely needed, for example after a big upstream release), stage it explicitly: `git update-index --cacheinfo 160000,<master sha>,Fork/deepseek-harness && git update-index --skip-worktree Fork/deepseek-harness`. `--cacheinfo` clears the skip-worktree flag, so without the second command the next `git add -A` records `local/daily` again. Never record a `local/daily` commit; nobody else can fetch it.
- Fork commits and pushes happen inside `Fork/deepseek-harness`, against the fork's own remote.

## Layout

| Folder | What it is |
| --- | --- |
| `Fork/deepseek-harness` | Submodule: the maintainer's (`gabrielbav`) fork of `deepseek-ai/deepseek-harness`, a pnpm monorepo built on Cordis (`packages/<group>/<pkg>`, `apps/`, `vendor/`, `docs/`) |
| `Fork/sync.sh` | Syncs the fork with upstream using the branch model below. It lives outside the fork on purpose |
| `Makefile` | Entry point: builds the fork and plugins and boots dsh in different setups. Run `make help` |
| `Plugins/dsh-code` | Code mode plugin bundle (pnpm workspace, the package is in `packages/dsh-code`) |
| `Plugins/dsh-plugin-airlock` | Security install gate: quarantines and scans plugins, skills and subagents before install |
| `Plugins/dsh-plugin-session-delete` | Permanent session and workspace deletion |
| `Plugins/dsh-connectors` | Settings "Connectors" page and the `connectors` service other plugins register connectors with; MCP servers registered through `mcpManager.register` |
| `Plugins/dsh-plugin-aws` | Settings "AWS" page: switches the official AWS MCP servers (awslabs) on and off by group or one by one, with a settings form per server; registers them through `mcpManager.register` and runs local ones with `uvx` |
| `.github/workflows` | CI, one workflow per plugin, each filtered by `paths:` to its folder (only dsh-code has one so far) |

New plugins go in `Plugins/`. Register each one in the `Makefile` plugin registry (`PLUGINS`, `repo_<name>`, `pkg_<name>`, and `hooks_<name>` listing every fork hook branch it needs, empty when none). Set its `package.json` `repository` to `git+https://github.com/gabrielbav/dsh-workspace.git` with `directory` pointing at the package folder, and use absolute `github.com/gabrielbav/dsh-workspace/...` or `raw.githubusercontent.com/gabrielbav/dsh-workspace/main/...` links in its README, because npm renders the README outside the repo.

## Awesome lists (maintainer only)

These plugins are submitted to community "awesome" lists. No local copies are kept. GitHub needs a fork to open a PR, so the fork is temporary:
1. `gh repo fork <upstream> --clone` into the session scratchpad, as `gabrielbav` (`GH_TOKEN="$(gh auth token --user gabrielbav)"`).
2. Edit, commit, push a branch, `gh pr create -R <upstream>`.
3. Delete the fork on GitHub only after every PR from it is merged or closed. Deleting it earlier closes the open PRs.

| Upstream | Fork on GitHub (delete when its PRs settle) |
| --- | --- |
| `awesome-dsh-plugin/awesome-dsh-plugin` | `gabrielbav/awesome-dsh-plugin` |
| `0xsline/awesome-deepseek-harness` | `gabrielbav/awesome-deepseek-harness` |
| `Dominic789654/awesome-deepseek-harness` | `gabrielbav/awesome-deepseek-harness-1` |
| `Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins` | `gabrielbav/Awesome-DeepSeek-Harness-Plugins` |
| `beancookie/awesome-dsh-plugin` | `gabrielbav/awesome-dsh-plugin-1` |
| `Alex-Yanggg/awesome-DSH-plugin` | `gabrielbav/awesome-DSH-plugin-2` |
| `kejixiaoliang/awesome-dsh-plugins` | `gabrielbav/awesome-dsh-plugins` |

Check what is still open with `gh pr list -R <upstream> --author gabrielbav --state all`.

## Plugins and harness changes are kept apart

**Do not modify files in the fork (`Fork/deepseek-harness` or its worktrees) unless the user explicitly asks for that specific change.** The fork must keep surviving upstream releases with as little rebase and conflict work as possible. Solve needs in this order:
1. In the plugin, using the harness's existing services, events and routes.
2. In profile config (`~/.dsh/profiles/*`, `cordis.patch.yml`).
3. In tooling in this repo that lives outside the fork (for example scripts in `Fork/`, next to the checkout).
4. As a last resort, propose a minimal generic hook (rules below) and wait for approval before writing it.

Plugin code stays in its `Plugins/<name>` folder. When a plugin needs something the harness does not offer, add a minimal generic hook to the fork on its own branch and open the PR against the fork (upstream `CONTRIBUTING.md` does not accept external PRs). Never put plugin-specific code in the fork. The plugin then checks for the hook at runtime. The two existing plugins handle a missing hook differently:
- session-delete probes for `ctx.sessionController.releaseAgent` (branch `feat/session-controller-release-agent`). Without it, the plugin keeps sessions that were loaded since startup.
- airlock uses `pluginManager.registerInstallGate` (branch `feat/install-gate`) when present ("Full enforcement"). Since 0.2.0 it also runs without it ("Standard"): it vets chat installs through `tools/pre-execute`, adds its own scan-first install to Add plugin, and audits the rest. So the hook is optional and `hooks_airlock` is empty. To test the Standard tier, either rebuild `local/daily` without `feat/install-gate`, or turn off "Use the install-gate hook" in Airlock's settings, which runs the same code path.

### Fork branch model: topic branches + integration branch

| Branch | Role |
| --- | --- |
| `master` | Mirror of `upstream/master`. Never commit to it, only fast-forward. |
| `feat/<hook>` | One branch per generic hook, based on `master`, holding only that hook. It must be PR-ready at all times. Every hook PR is opened from a `feat/*` branch, including PRs made by cloud or remote sessions (which name branches like `ccr-*`). Any other name is left out of `local/daily`. |
| `local/daily` | The branch to build and run locally: `master` with every `feat/*` branch stacked on top. It is generated: never commit to it directly, rebuild it instead. |

When upstream ships a release, run `make sync` (`Fork/sync.sh`, then `make build`). It:
1. Fetches upstream and fast-forwards `master`.
2. Rebases each `feat/*` onto the base (`upstream/master`, or a release tag via `BASE=dsh-vX.Y.Z`) and pushes it with `--force-with-lease` (`PUSH=0` skips pushing).
3. Recreates `local/daily` as the base with every `feat/*` cherry-picked on top. It leaves `local/daily` alone when it is already up to date.
4. Stops on a conflict with the rebase or cherry-pick in progress. Resolve it, continue it, then rerun.

Guards that make a missing hook fail loudly instead of hiding a feature:
- `sync.sh` refuses to run while an open PR on the fork comes from a branch outside `feat/*`. It also creates local branches for any `feat/*` that exists only on origin.
- `make start*` refuses to boot when the fork is not on `local/daily`, when `local/daily` lacks a hook branch listed in a booted plugin's `hooks_<name>`, or when `local/daily` moved since the last `make build` (`make build` writes the built commit to `Fork/.built-commit`).
When a plugin gains a dependency on a new hook, add that branch to its `hooks_<name>` in the same change.

`sync.sh` pushes and queries GitHub as the fork's owner (`gh auth token --user <owner>`) for that run only, since the active `gh` account may be a different one, and it pushes with `--no-verify` because the fork's lefthook pre-push hook typechecks the checked-out tree, not the branch being pushed. Maintainer only: a manual push to the fork from the maintainer's work account fails with 403; prefix it with `GH_TOKEN="$(gh auth token --user gabrielbav)"`.

Then restart dsh. The script turns on `rerere` in the fork, so a conflict you have resolved once resolves itself the next time. When upstream gains an equivalent of a hook, delete that `feat/*` branch and switch its plugin to the upstream API. Use one checkout with branches. Add a worktree only temporarily, when a `feat/*` branch must be edited while `local/daily` keeps running, and remove it afterwards.

## Harness (`Fork/deepseek-harness`)

pnpm 11.28.5 (use `corepack pnpm` if the global pnpm differs), Node >= 24.9. `dsh` is not on PATH, so run it from the fork.

```sh
pnpm install
pnpm run build:artifacts     # what to run while developing
pnpm run build:check         # run before claiming completion, after the latest build:artifacts
pnpm run typecheck
pnpm run lint
pnpm run test                # unit tests; CI's gate is test:coverage
pnpm run dev:web             # build:artifacts, then launch Web. start:web skips the build
pnpm dsh --profile headless "task"   # one task from source (needs DEEPSEEK_API_KEY)
```

Run focused tests for the area you change, not the whole suite. The fork also has its own upstream `Makefile` (`make web`, `make dev-web`) that runs only the `web` profile. For workspace setups, use the root `Makefile`. Before `make sync`, stop any running dsh and commit or discard changes in the fork, because the script refuses to run on a dirty tree.

## dsh-code (`Plugins/dsh-code`)

- `README.md` describes the bundle. `docs/plan.md` tracks status and open work, `docs/validation.md` records architecture decisions, and `docs/spec.md` is the product spec. Update `README.md` and `docs/plan.md` with every behavior change.
- Never weaken an isolation invariant to make something work. That means:
  - gVisor only;
  - no Docker socket;
  - no host Git inside a checkout the sandbox can write to;
  - no credentials passed into containers;
  - egress only through the proxy.
- Before pushing, run `pnpm run typecheck` and `pnpm test`. For changes under `src/core`, `src/egress` or `src/host`, also run `pnpm run test:docker`.
- Running it needs Docker with the gVisor (`runsc`) runtime on the host. Build it with `make plugins P=code`, which builds the workspace root, not `packages/dsh-code`.
- State the Harness owns (a session's mode or preset, its working directory, its Workspace) is read from the Harness on every check (`agentPresets.composedPreset` / `presetForSession`, `workingDirectory.get`). It is never kept as a plugin-side copy fed by events, because a copy is lost on restart and misses sessions that never emit the event (for example, Code mode as the default). Browser caches only mirror the Host's answer. Durable plugin state lives in the workspace records under `dataDir`.
- On the maintainer's Mac, Docker + gVisor runs in a dedicated Colima VM, profile `dsh`, kept apart from other projects' VMs (for example `brainfold`). `make docker` starts it without changing the global Docker context, then builds `dsh-code-worker:0.1.0` and pulls `node:24-alpine`. The root `Makefile` exports `DOCKER_HOST=unix://$HOME/.colima/dsh/docker.sock`, so dsh started through it talks to that VM. `make docker-stop` stops it.
- The VM was set up once: `runsc` installed inside it from gVisor's apt repo (`colima ssh -p dsh`), and registered in `~/.colima/dsh/colima.yaml` under `docker: runtimes: runsc: path: /usr/bin/runsc`. Colima rewrites `/etc/docker/daemon.json` from that file on every start, so never edit `daemon.json` in the VM. Check it with `docker run --rm --runtime runsc alpine dmesg` (prints `Starting gVisor...`).
- Workspaces live in `~/.dsh-code` (the default `dataDir`). Colima shares `$HOME` with the VM, so bind mounts work. A `dataDir` outside `$HOME` would not be visible to containers.
- The sidebar switch and session filter need the `sidebar.mode` slot and `uiWorkspace.registerSessionFilter` from `feat/sidebar-mode-session-filter` (fork PR #3, which replaced #2 opened from a `ccr-*` branch). Listed as `hooks_code`.

- Live tests: `pnpm run test:docker` (on macOS with `TMPDIR` under `$HOME`). The remote suite runs over SSH against the Colima VM's own SSH server: take the port, login and key from `colima ssh-config -p dsh`, read the fingerprint with `colima ssh -p dsh -- ssh-keygen -l -E sha256 -f /etc/ssh/ssh_host_ed25519_key.pub`, then set `DSH_CODE_REMOTE_TESTS=1 DSH_CODE_REMOTE_HOST=127.0.0.1 DSH_CODE_REMOTE_PORT=… DSH_CODE_REMOTE_USER=… DSH_CODE_REMOTE_KEY=… DSH_CODE_REMOTE_HOSTKEY=SHA256:…`.
- A scratch Harness (`DSH_HOME=<scratch> make start P=code`) uses the real `~/.dsh-code` unless its profile patch sets `dataDir`. Give it its own `dataDir` only together with a remote host (remote mode gets its own Docker namespace). In local mode every data folder shares the `dsh-code-egress` proxy and networks, so a second local data folder would recreate the user's proxy. Put scratch settings in the profile's own `cordis.patch.yml`; Settings cannot edit a row overridden by `$DSH_HOME/cordis.patch.yml`. For a scripted turn without an API key, run the fork's mock model (`pnpm run mock:llm --port 8790 --api-key mock-key --sequence tool_call_success,success --tool-name … --tool-arguments …`) and start dsh with `DEEPSEEK_BASE_URL=http://127.0.0.1:8790/v1 DEEPSEEK_API_KEY=mock-key`.

Published on npm as `@gabrielbav/dsh-code` (0.2.0 first). Releases are maintainer only. To release: bump `version` in `packages/dsh-code/package.json`, build, check `npm pack --dry-run` in `packages/dsh-code` (prepack copies `Plugins/dsh-code`'s README and LICENSE in), commit and push, then publish from `packages/dsh-code`. The npm account (`gabrielbav`) uses a passkey, not a one-time code. A `!` command is not a terminal, so `npm publish` stops with `EOTP`. Run it under a pseudo-terminal so npm waits for the browser approval: `script -q /dev/null npm publish --auth-type=web`, then open the printed `npmjs.com/auth/cli/...` link. A new version is first shown as `0.0.0-stage` and appears after a few minutes of processing.

## Single-package plugins (airlock, session-delete)

Both use the same structure and the scripts in their `package.json`. Host and browser halves talk through owner-only Fetch routes under `/api/<pluginName>.*`.

The plugins do not pin a pnpm version. Use `corepack pnpm@11.28.5` to match the harness (the root `Makefile` does this). A profile only sees a plugin's built `lib/`, so rebuild after every source change and restart dsh.

## Running a plugin in a local DSH

Use the root `Makefile`:
- `make setup` builds the fork and every plugin.
- `make start-pure` boots the fork with no plugins.
- `make start-all` boots it with every plugin.
- `make start P="airlock code"` boots it with only the listed plugins.
- `make start-web` boots your everyday `web` profile.

Each setup is a generated profile (`dsh-pure`, `dsh-all`, `dsh-<names>`). It is created from the shipped web template and gets the plugins as `link:` dependencies. `make reset` deletes the generated profiles. `web` and the sessions are never touched. Sessions and credentials sit in `$DSH_HOME` and are shared by every profile. Run only one setup at a time, since they share the default port. Pass app flags with `ARGS='--no-open --port 3081'`. dsh's plugin manager (UI installs and `dsh plugin add`) runs the `pnpm` on `PATH`. The global Homebrew pnpm 9.x fails there with `ERR_PNPM_ADDING_TO_ROOT`, so the root `Makefile` puts `Fork/.bin/pnpm` first on `PATH`, a generated shim for `corepack pnpm@11.28.5`. A dsh started any other way installs plugins with the wrong pnpm. For a scratch run, set `DSH_HOME=<dir>` in front of any `make start*`.

Settings in a profile's own `cordis.patch.yml` (model, locale, `requireInstallGate`) stay in that profile. A generated profile starts from the template defaults. Settings that should apply to every profile go in `$DSH_HOME/cordis.patch.yml`, which is layered over each profile's own patch file.

- The web profile lives at `~/.dsh/profiles/web`.
- Airlock is installed there as `link:` to `Plugins/dsh-plugin-airlock`. Profiles store `link:` paths as absolute paths. After cloning or moving this repo to another folder, run `make relink` (`make bootstrap` runs it): it repoints every profile's missing `.../Plugins/<name>` links at this checkout and reinstalls that profile. Renaming a plugin folder is different: update the `Makefile` registry and run `make reset`, then fix `web` by hand.
- After rebuilding a plugin, restart dsh.
- Other plugins: `dsh plugin --profile <name> add -w <npm name or link:/abs/path>`. Without `-w`, pnpm refuses (`ERR_PNPM_ADDING_TO_ROOT`), because each profile is its own pnpm workspace root. `add` also appends the bundle to the profile's `dsh.profile.bundles`.
- The web profile's `cordis.patch.yml` sets `requireInstallGate: true`. Plugins cannot be installed while the gate is missing, so bootstrapping or upgrading airlock needs that flag removed for a while.
- To test anything destructive (for example session deletion), use a scratch `DSH_HOME`, not the real one. Sessions are stored as zstd JSONL under `$DSH_HOME/sessions`.
