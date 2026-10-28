# OpenSensor Kilo harness

An OpenSensor-maintained [nono](https://nono.sh) pack for running the
[Kilo CLI](https://kilo.ai/docs/code-with-ai/platforms/cli) in an OS sandbox.
The source is maintained in
[opensensor/nono-kilo](https://github.com/opensensor/nono-kilo). Signed registry
releases are published from the public
[matteius/nono-kilo](https://github.com/matteius/nono-kilo) fork as `matteius/kilo`.
This is an independent community integration, not an official Kilo product.

This pack adapts the upstream
[nolabs-ai/kilo](https://github.com/nolabs-ai/nono-packs/tree/main/kilo) integration.
It adds XDG-aware paths, separate Kilo UI state and temporary storage, filtered
environment inheritance, and independently maintained release checks.
It does not install Kilo or fork its model/tool execution loop.

## Browser dashboard

The [agent workspace dashboard](dashboard/README.md) is maintained in this
repository under `dashboard/`. It provides project sandbox settings, keyring
secrets, live terminals with steering, granular Git permissions, network
visualization, and on-demand network approvals for Kilo, Claude Code and native Codex.

On a Linux host with Node.js 22+ (24 recommended), nono and at least one supported agent CLI installed:

```sh
git clone https://github.com/opensensor/nono-kilo.git
cd nono-kilo/dashboard
npm ci
mkdir -p "$HOME/opensensor"
OPENSENSOR_NONO="$(command -v nono)" OPENSENSOR_KILO="$(command -v kilo)" npm start
# In another terminal in the same dashboard directory:
npm run open
```

The last command prints the private unlock link. See the
[dashboard setup guide](dashboard/README.md) for the systemd user service,
keyring dependencies, LAN access and project configuration. The dashboard
generates a fresh random unlock key on first start; local sessions, settings,
keys and keyring contents stay outside the source checkout.

The registry pack remains at the repository root. `nono pull matteius/kilo`
installs the CLI harness; install the dashboard from this source checkout.
The dashboard has its own npm manifest and lockfile, while the root
`package.json` is the nono registry manifest.

## Run

Install nono 0.80.0 or newer and the Kilo CLI first. The tested versions are
recorded in `versions.json`; the initial pair is nono 0.80.0 / Kilo 7.8.18.

```sh
nono pull matteius/kilo
cd /path/to/your/project
~/.local/bin/nono-kilo

# Non-interactive task
~/.local/bin/nono-kilo run "Explain this project"
```

Authenticate with `kilo auth login` before entering the sandbox, or supply a
supported provider key through the environment. Existing Kilo config and login
data are reused. Kilo still controls its own tool-approval prompts.

If `~/.local/bin` is on your PATH, use `nono-kilo` directly. Arguments pass through
to Kilo. The launcher creates the required directories and runs
`nono run --profile matteius/kilo --allow-cwd -- kilo ...`.

The fully qualified profile name `matteius/kilo` avoids ambiguity with the
upstream pack. Its profile lives in the `matteius/kilo` package directory, and its
skill is `opensensor-nono`; neither replaces the upstream pack's files.

## Access and compatibility

The profile grants read/write access to the selected project and these paths:

| Purpose | Host path (XDG variables use their normal defaults) |
| --- | --- |
| Kilo configuration and skill | `$XDG_CONFIG_HOME/kilo` |
| Kilo data, sessions and provider login storage | `$XDG_DATA_HOME/kilo` |
| Kilo UI state | `$XDG_STATE_HOME/opensensor-kilo` |
| Kilo cache and temporary files | `$XDG_CACHE_HOME/kilo` |
| Proposed nono profile changes | `$NONO_CONFIG/profile-drafts` |

Inside Kilo, `XDG_STATE_HOME` points to the dedicated `opensensor-kilo`
directory and `TMPDIR` points to `$XDG_CACHE_HOME/kilo/tmp`. This lets the TUI
resolve its state root and load its embedded UI library without a grant for
the shared state parent. UI history/preferences are separate from unsandboxed
Kilo; existing session data and provider logins retain their normal data path.
The `nono-kilo` launcher is verified on installation and runs on the host to
create only these Kilo directories before sandbox setup. It does not download,
remove, or change existing files. This supports a first launch and custom XDG
locations; re-pull the pack if you change the config location to reinstall the
skill. To use nono flags directly, prepare the directories first:

```sh
~/.local/bin/nono-kilo --prepare-only
nono run --profile matteius/kilo -- kilo
```

The standalone Kilo installation at `~/.kilo/bin` and standard Node, Bun, Rust,
Python, Nix and Git configuration are readable through
nono's runtime groups. Writes to shared toolchain installations and caches may
need a separately reviewed project profile. The pack inherits nono's default
system access, including OS temporary/device access and user executable reads.
It does not grant home-directory access, shared user-cache access, or a macOS
Keychain bypass. Browser-based login should be done outside the sandbox.

Outbound network access is enabled for Kilo's supported providers and developer
tools. This is a local CLI sandbox, not a hosted multi-tenant isolation boundary
or an egress policy. Use nono's `--allow-domain` options or a separately reviewed
network profile when you need restricted destinations.

The inherited environment is allowlisted. It includes terminal/locale settings,
XDG paths, proxy/TLS configuration, `KILO_*`, `KILOCODE_*`, and explicitly
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, and
`GOOGLE_GENERATIVE_AI_API_KEY`. Other shell credentials (for example `GH_TOKEN`
and `AWS_SECRET_ACCESS_KEY`) are not inherited. Provider keys and login files
that Kilo needs remain readable by Kilo and its children; this pack does not
claim to isolate them from the agent.

Run from the project you intend to expose. Do not select your home directory as
the workspace. Registry signature checks remain enabled in normal use.

## Development and validation

```sh
python3 scripts/validate.py
NONO_BIN=/path/to/nono KILO_BIN=/path/to/kilo python3 tests/smoke.py
npm ci --prefix dashboard
npm test --prefix dashboard
```

The smoke checks use temporary XDG directories beneath the test user's home,
without replacing HOME or reading existing Kilo login data. They exercise the
real sandbox, filesystem and environment boundaries, Kilo runtime startup, and
TUI startup. They do not send a prompt to a paid model. CI runs on Linux and
macOS with the official standalone Kilo distributions in `versions.json`.
The local Linux checks also cover the npm installation under nvm. Nonstandard
installation prefixes (including GitHub's hosted Node toolcache) require a
separately reviewed read grant; the profile does not broadly expose `/opt`.

Dashboard CI runs its unit, HTTP and live PTY/WebSocket tests on Linux with
Node.js 22 and 24. The [dashboard guide](dashboard/README.md#development-and-verification)
also documents the real-sandbox, keyring and network-approval checks.

## Publishing

Create a public `matteius/kilo` **pack** in
[the nono registry](https://registry.nono.sh/publish), with source repository
`matteius/nono-kilo` and no repository subpath. Registry sign-in and 2FA are
required to configure trusted publishing.

Register this exact trusted publisher:

| Field | Value |
| --- | --- |
| Repository | `matteius/nono-kilo` |
| Workflow | `.github/workflows/publish.yml` |
| Ref pattern | `refs/tags/v*` |
| GitHub environment | empty |

Keep the publishing fork's `main` branch synchronized with OpenSensor. After CI
passes, update `package.json` and `policy.json` together, commit, and push the
matching version tag to `matteius/nono-kilo`, for example `v0.1.0`. Publishing is
restricted to that repository so an OpenSensor tag cannot sign for the personal
namespace. The workflow checks that
the tag matches the manifest, runs validation and runtime checks, and uses the
SHA-pinned upstream `agent-sign` action with GitHub OIDC to sign and publish
every declared artifact. No long-lived registry token is needed.

Verify a release by pulling its exact version into a clean nono configuration:

```sh
nono pull matteius/kilo@0.1.0
~/.local/bin/nono-kilo --version
```

Use a new semver release for fixes; published artifacts are versioned.
Track upstream Kilo/nono changes through `versions.json`, rerun both OS jobs,
and record material permission changes in release notes. See `NOTICE` for
source attribution. Contributions are welcome under Apache-2.0.
