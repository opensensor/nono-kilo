---
name: opensensor-nono
description: Diagnose sandbox denials when the Kilo CLI runs with the OpenSensor nono profile.
---

# OpenSensor nono harness

The OS enforces the sandbox for Kilo and its subprocesses. A failed operation
does not authorize a broader grant, an unsandboxed retry, or disabling trust
verification. Report the denied path, executable, endpoint, or environment
variable, and relate it to the user's task.

The profile grants the selected workspace read/write access, along with Kilo's
config, data, cache, dedicated UI state, and nono profile drafts. It reads the
installed runtime/toolchain directories and nono packages/profiles. It does not
grant all of the home directory, shared cache, or shared state directory.

Use the effective environment paths:

- Config: `${XDG_CONFIG_HOME:-$HOME/.config}/kilo`.
- Data and provider login storage: `${XDG_DATA_HOME:-$HOME/.local/share}/kilo`.
- UI state: `$XDG_STATE_HOME/kilo`; the profile sets XDG_STATE_HOME to a dedicated
  `opensensor-kilo` directory beneath the host's state home.
- Cache: `${XDG_CACHE_HOME:-$HOME/.cache}/kilo`.
- Temporary files: `$TMPDIR`; the profile sets this to Kilo's `tmp` cache directory.

For a denial, first check whether the operation can stay within the workspace.
When more access is necessary, describe the smallest required path or provider
variable and have the operator review a profile change outside the sandbox.
Never request a whole-home grant to repair a single missing file permission.
Do not access SSH keys, cloud credentials, browser profiles, or unrelated repos
to work around a denial. Do not modify the installed pack or trust policy.

Outbound networking is enabled by this compatibility profile. Model-provider
credentials deliberately available to Kilo are also visible to its subprocesses.
Do not describe this profile as credential isolation, network isolation, or a
hosted multi-tenant execution boundary.
