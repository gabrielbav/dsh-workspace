# Contributing

Issues and pull requests are welcome. One PR can touch several plugins when a change spans them.

## Setup

Follow **Develop** in the [README](README.md): `git clone`, then `make bootstrap`. It:

1. Clones the harness fork into `Fork/deepseek-harness` if it is missing. If you cloned with `--recurse-submodules`, it moves the fork's git directory into that folder instead, because the harness's install hooks fail on the submodule layout.
2. Runs `Fork/sync.sh` with `PUSH=0 BASE=origin/master`. This builds the `local/daily` branch on your machine: the upstream commit the fork last synced to, plus every `feat/*` hook branch. Nothing is pushed.
3. Builds the harness and every plugin.

After pulling new changes, run `make setup` again. When the fork's `feat/*` branches change, run `make sync PUSH=0 BASE=origin/master`. Don't sync onto a newer upstream than the fork's `master`: the hook branches may conflict there until the maintainer rebases them.

`make start*` refuses to boot when the fork is not on `local/daily`, when a plugin's hook branch is missing from it, or when the build is older than `local/daily`. The error message names the command that fixes it.

## Where a change goes

1. **In the plugin** (`Plugins/<name>`), using the services, events and routes the harness already offers. Most changes belong here.
2. **In profile config** (`cordis.patch.yml`).
3. **As a generic hook in the fork**, only when the harness has no way to do it. A hook is a small extension point that any plugin could use, on its own `feat/<hook>` branch based on `master`, with a PR against [gabrielbav/deepseek-harness](https://github.com/gabrielbav/deepseek-harness). Plugin-specific code never goes into the fork. The plugin checks at runtime whether the hook exists and behaves sensibly when it doesn't. Add the branch to the plugin's `hooks_<name>` line in the `Makefile`.

## Before opening a PR

Run these in each plugin folder you changed:

```sh
corepack pnpm@11.28.5 run typecheck
corepack pnpm@11.28.5 test
```

- **dsh-code:** for changes under `src/core`, `src/egress` or `src/host`, also run `pnpm run test:docker` (needs Docker with gVisor). Never weaken its isolation: gVisor only, no Docker socket, no host Git inside a checkout the sandbox can write to, no credentials passed into containers, egress only through the proxy.
- **Docs:** update the plugin's README when behavior changes (dsh-code also tracks status in `docs/plan.md`).
- **Links:** keep README links absolute (`https://github.com/gabrielbav/dsh-workspace/...`), since npm shows the README outside this repo.

Releases to npm are done by the maintainer.
