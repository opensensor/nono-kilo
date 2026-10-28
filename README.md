# OpenSensor Kilo workspace

A local browser dashboard for projects, Kilo tasks, nono sandbox sessions, captured output, and working-tree diffs. It uses the installed `opensensor-kilo-local` profile and runs at **http://127.0.0.1:4317**.

## Use

1. Select an individual project in the sidebar. Git repositories directly under `~/opensensor` are discovered automatically; **Add project** accepts nested directories within that workspace.
2. Choose a model and enter a task. The initial selection is Kilo's free router. This is a per-run choice and does not modify your Kilo configuration.
3. Click **Start session**. Watch **Output**, inspect the current **Working tree**, or use **Stop**.
4. **Test sandbox boundaries** checks project reads/writes, environment filtering, and denied reads/writes outside the project without calling a model.

The demo project is `~/opensensor/nono-kilo-demo`. **Try the demo prompt** selects it and prepares a read-only task that runs its four tests. **Copy terminal command** lets you use the interactive Kilo TUI from the same project instead.

Kilo tool approval defaults remain in effect unless you explicitly select **Auto-approve Kilo tool prompts** for that session. Noninteractive Kilo can reject tasks that require an unanswered permission prompt. The nono profile's filesystem and environment restrictions remain in effect either way.

## Start and stop the dashboard

```sh
systemctl --user start nono-kilo-dashboard
systemctl --user status nono-kilo-dashboard
systemctl --user stop nono-kilo-dashboard
```

For development (stop the service first to free the port):

```sh
npm start
npm test
```

No npm dependencies or build step are needed; Node.js 22+ is required. The service requires the installed nono CLI, Kilo CLI, local profile, and Python 3 for the boundary check. The existing model/provider configuration and authentication are reused. The configured MiniMax endpoint was unavailable during setup; choose another reachable model or restore that service.

The installed user service starts automatically at login. It uses saved Kilo credentials and the service environment; API keys exported only in a terminal are not automatically copied into the service.

## Local boundaries and storage

- Listens only on `127.0.0.1`; it is not published or exposed on the LAN.
- Host and Origin checks reject DNS rebinding and cross-site requests. Mutations also require a custom request header and JSON content type.
- Project paths are canonicalized and must be children of `~/opensensor`. The workspace root and symlinks pointing outside it are rejected.
- Commands are launched as argument arrays, never through a shell. The dashboard cannot supply arbitrary nono flags or disable sandbox enforcement.
- The selected project, Kilo config/data/cache, and isolated Kilo UI state are writable. The profile also grants standard runtime/system reads. Networking is allowed for tasks and blocked for the boundary check. Kilo's provider credentials are available to Kilo and its subprocesses.
- Dashboard records and logs live in `~/.local/state/nono-kilo-dashboard`, outside the sandbox grants. Logs are capped at 1 MiB per session; the UI shows the most recent 160,000 characters.
- The working-tree tab shows current Git changes, including pre-existing changes. It is not a per-session attribution system.
- Terminal-launched Kilo sessions are listed, but their terminal transcripts are not retroactively captured.
- Stopping the dashboard service also stops its active child sessions. Finished output persists across restarts.

This is a local, single-user control surface. Other processes running as your OS user can access it. It is not designed for remote hosting or multiple users.

The `nono-ts` 0.3.0 npm package was evaluated, but its declared Linux native package returned 404. The dashboard uses the working nono CLI for enforcement, session supervision, and profile handling instead. The management server itself is not placed inside the agent sandbox.

Configuration overrides: `OPENSENSOR_WORKSPACE`, `OPENSENSOR_DASHBOARD_STATE`, `OPENSENSOR_NONO`, `OPENSENSOR_KILO`, and `OPENSENSOR_PORT`. These configure the local server; they are not browser-controlled.
