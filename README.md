# SSMCP tools

This repository contains the JavaScript helper functions used by SSMCP code mode. Functions such as `exec.run`, `tools.search`, `say`, `ui.wait`, `messages.send`, and `workers.submit` are editable source in `tools.js`. They call SSMCP's authenticated host operations; editing a helper does not grant additional permissions.

## Source contract

`manifest.json` names one UTF-8 JavaScript entry file. The file evaluates to a synchronous factory accepting `core` and returning named helper exports. SSMCP evaluates it in the same bounded VM as the user's code, without Node.js imports, filesystem access, network access, or dynamic code generation. Top-level factories define helpers; they must not start native operations.

The factory receives `call`, `dispatch`, `digest`, `clients`, and `previous`. `previous` contains the exports loaded before this factory. An override replaces an entire export name. It can preserve other methods explicitly:

```js
core => ({
  exec: Object.freeze({
    ...core.previous.exec,
    run: async (clientId, args) => {
      // Add a local convention, then use the existing authenticated operation.
      return core.previous.exec.run(clientId, args);
    },
  }),
})
```

The host's `call`, `clients`, `image`, `print`, and `console` primitives cannot be replaced. Message completion permission is validated by the host after the script returns; a helper cannot create approval by returning `may_finish: true`.

## Local iteration

SSMCP's official checkout lives at `$XDG_DATA_HOME/ssmcp/tools/official` (normally `~/.local/share/ssmcp/tools/official`). It is an ordinary Git working tree. First use can initialize it offline from the fixed Git bundle shipped with SSMCP. Its origin is `https://github.com/LIghtJUNction/ssmcp-tools.git`.

The client reads `$XDG_CONFIG_HOME/ssmcp/ssmcprc.toml` (normally `~/.config/ssmcp/ssmcprc.toml`) on each run. It loads the official source first and then the listed overrides in order:

```toml
version = 1

[tools]
overrides = [
  ".ssmcp/tools/local",
  "/absolute/path/to/my-tools.js",
]
```

Relative paths resolve against that client's workspace. A directory contains its own `manifest.json`; a registered JavaScript file is loaded directly. SSMCP does not search or execute unregistered workspace files.

Agents should inspect the selected source, edit a local override, validate it with a bounded code-mode call, and commit useful changes in the relevant repository. A source or schema error remains visible; the loader does not silently return to an embedded helper implementation. Source receipts include the exact loaded content hashes, Git commit and dirty state when a Git repository is present.

## Choosing the client

`tool_client_id` selects the authorized client whose RC and sources apply to a code-mode run. An existing verified agent binding selects that client's sources by default. A single available client can be selected automatically. Multiple available clients without a selection use an explicitly identified read-only official seed, with a prompt to choose a client; their local overrides are not combined.

## Updates

`ssmcp tools status` reports the local RC and source identities. `ssmcp tools check` observes the official repository's remote default branch without changing its working tree. `ssmcp tools update` only fast-forwards a clean official checkout. Dirty, detached, or diverged work is preserved and reported. User override repositories are not changed.

`ssmcp update --check` also checks the tool repository, and `ssmcp update` applies an eligible fast-forward. Binary and tool versions are separate. A newer local SSMCP binary does not disable the tool update check.

## License and origin

MIT. The initial helpers were extracted from the SSMCP code-mode API, retaining their behavior and host dispatch boundaries. Runtime validation results belong to the exact SSMCP source and tool-source revisions used in that run.
