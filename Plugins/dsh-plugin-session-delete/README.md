# Session delete for DeepSeek Harness

DeepSeek Harness can archive sessions but not delete them, and deleting a workspace moves its sessions to "Ungrouped". This plugin adds permanent deletion:

- **Delete session**: a trash button next to the archive button when you hover a session row, and a **Delete session** item in the session's "..." menu.
- **Delete workspace and sessions**: an item in the workspace's "..." menu, beside the built-in **Delete workspace**. It deletes every session in the workspace, then the workspace. The workspace folder and its files are never touched.

Both ask for confirmation. Deleting a session also deletes its subagent sessions. If the session is open in the conversation view, DSH switches to a new conversation.

## What is never deleted

A session is kept, and the dialog says why, when:

- it is **running**: a turn, a subagent, a background job or a schedule is active. Stop it first.
- its log is **open somewhere else**: another DSH process (Desktop and the CLI share sessions), or a subagent or integration that owns it.
- it is a **subagent session**: delete its parent instead.
- the session store is not the standard JSONL folder layout, or a session folder does not look like one. The plugin removes only a folder that sits exactly two levels under the session root, is not a symlink, holds no subfolders, and whose stored header names the session being deleted.

"Delete workspace and sessions" keeps the workspace when any of its sessions is kept, and lists them.

## Sessions used since DSH started

DSH keeps every session you chatted in loaded until it restarts. To delete one of those, the plugin asks the session controller to unload it with `releaseAgent`. That method is not in upstream DSH yet; it is proposed in [gabrielbav/deepseek-harness#1](https://github.com/gabrielbav/deepseek-harness/pull/1). The plugin detects it at runtime:

| DSH | Sessions not loaded | Idle sessions used since DSH started | Running sessions |
|---|---|---|---|
| with `releaseAgent` | deleted | unloaded, then deleted | kept |
| without it | deleted | kept: "Restart DSH and try again" | kept |

On a DSH without the method, the confirmation dialog says so up front.

## Install

From the Plugins page: **Add plugin** → `@gabrielbav/dsh-plugin-session-delete`, or a path to a checkout. From the command line:

```sh
dsh plugin --profile web add @gabrielbav/dsh-plugin-session-delete
```

Restart `dsh web` afterwards.

## Limitations

- **Worktree checkouts are not removed.** A checkout the worktree plugin created for a session stays on disk. Archive the session first if you want the worktree plugin's cleanup to run, then delete it.
- **Cached session data outside the session folder stays.** The projection cache keeps a small record per session under `$DSH_HOME/storages`. It is not shown anywhere and is not reused.
- **Archived ids stay in the archive list.** Removing a deleted id from the archive set would cancel the worktree plugin's pending cleanup. The leftover id names no session and is not displayed.
- **Empty project folders stay** under the session root after their last session is deleted.
- Deleting is permanent. There is no trash.

## Develop

```sh
pnpm install
pnpm build        # lib/index.js (Host), lib/client.js (browser)
pnpm test
```

The Host half is one ES module with no runtime dependencies. The browser half is CommonJS wrapped in the DSH page's module-loader factory by `scripts/wrap-client.mjs`. React and `@deepseek-ai/dsh-client-ui-primitives` come from the page.

The Host half answers three owner-only routes: `/api/sessionDelete.capabilities`, `/api/sessionDelete.deleteSession` and `/api/sessionDelete.deleteWorkspace`.

<a id="dsh-version"></a>
## DSH version

`releaseAgent` is added to `@deepseek-ai/dsh-api-session-controller` by [gabrielbav/deepseek-harness#1](https://github.com/gabrielbav/deepseek-harness/pull/1), which is not merged upstream. Stock DSH does not have it, so there the plugin keeps sessions loaded since startup until DSH restarts.

## License

MIT
