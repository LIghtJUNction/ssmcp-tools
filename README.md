# SSMCP tools

This repository contains the JavaScript helper functions used by SSMCP code mode. Functions such as `exec.run`, `tools.search`, `say`, `ui.wait`, `messages.send`, and `workers.submit` are editable source in `tools.js`. They call SSMCP's authenticated host operations; editing a helper does not grant additional permissions.

Feature availability follows the selected client's live registry and the exact tool-source receipts. Publishing this repository alone does not install, load, or validate it on a client.

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

## Live thread events

Use `ui.events(clientId, {agent_id?, main?, cursor?, generation?, limit?})` to read the bounded event stream held by that live client. The helper supplies `action: "thread"` and the exact selected `client_id`. Follow the returned `generation` and `next_cursor`; earlier events can leave the memory budget. A process exit or reload does not restore them.

The helper discovers the authorized native catalog, prefers `ssmcp.ui.events`, and only uses an older client's `ssmcp.ui.history` when its schema explicitly advertises the `thread` action and the current API is absent. Capability discovery is limited to 32 catalog pages. An authorization error, native failure, malformed catalog, or incomplete scan stops the read. It does not retry through another namespace.

`ui.history` and the global `history.list`, `history.metadata`, `history.read`, and `history.search` helpers are removed. The event helper rejects conversation IDs, archive fields, other actions, and a `client_id` that differs from the selected client. Native account, thread, cursor, and connection checks remain authoritative.

Run the focused helper contract checks with:

```sh
node --test tests/live-events.test.cjs
```

## Worker tasks and bounded waits

`workers.status`, `attach`, `submit`, `tasks`, `result`, `cancel`, `stop`, and
`resize` call the corresponding
`ssmcp.worker.*` tools with the current authenticated binding. External workers
also have `wait`, `claim`, `complete`, `report`, and `release` helpers. Arguments
are forwarded unchanged; native schemas and ownership checks remain authoritative.
These helpers do not start models, switch identities, or automatically repeat a
submission. A manager can submit once and wait for that exact task:

```js
const accepted = await workers.submit(poolId, {
  request_id: "build-request-1",
  text: "Run the assigned checks and report their actual outcome.",
});
return await workers.waitResult(poolId, {
  task_id: accepted.task.task_id,
  timeout_ms: 20000,
});
```

`waitResult` accepts `timeout_ms` from 0 to 25000, default 20000. It uses bounded
native `worker.result` waits of at most 5000 ms each. It returns
`{result: <native result view>, wait: <observation metadata>}`. The actual
`result.task.status` remains `queued`, `working`, `cancelling`, `completed`, `failed`, `cancelled`,
or `unknown`. The separate `wait` object reports `reason`, `timed_out`, and
`elapsed_ms`. Terminal observations and `cancelling` stop further waits.
`unknown` preserves the native `replay_safe` value and never triggers resubmission.
A waiting deadline does not cancel a task or make a working task fail. Resume by
observing the same task ID. The time setting bounds requested native waiting;
network calls and result recovery can add latency, so keep the enclosing
code-mode deadline longer. Call and iteration budgets also stop observation with
the last actual task state, identified by `call_budget` or `wait_budget`.

An external worker retains its original `request_id` when retrying `workers.wait`
after a lost response. Preserve the returned claim unchanged for `complete`, then
use a new wait ID. Retirement requires the exact native retirement receipt.

### Pool availability events

`workers.waitAvailable(poolId, {after?, wait_ms?})` discovers the selected client's
`ssmcp.worker.wait_available` and forwards the arguments exactly once when its
generation/revision schema is advertised. Discover its current schema before choosing arguments.
There is no periodic polling fallback. Missing support raises
`WORKER_EVENT_WAIT_UNAVAILABLE`. If bounded discovery ends before finding the tool,
an incomplete catalog remains a discovery error.

The inspected client 0.10.27 registry does **not** advertise this primitive. The
inspected relay 0.10.26 await targets are `exec`, `job`, `agent_status`,
`agent_messages`, and `user_input`; an agent presence status does not establish
worker-pool capacity. Updating this JavaScript repository alone therefore cannot
provide pool event wakeups on those versions.

The [native source contract at 9902b88](https://github.com/LIghtJUNction/ssmcp/blob/9902b88c8d48639cbe5e0effacbd0877e55be174/src/worker/pool.rs)
implements a wait on capacity revisions under the existing manager binding.
Omit `after` for an immediate snapshot; pass its exact `{generation, revision}`
to wait up to 5000 ms for a change. The native statuses are `current`, `changed`,
`unchanged`, and `not_accepting`. A change is an observation, not a reservation
or proof that an idle worker now exists: inspect `availability.accepting` and
`availability.idle_slots` before scheduling. Progress logs do not advance this
capacity revision. Stale generations remain native errors.

```js
const current = await workers.waitAvailable(poolId, {wait_ms: 0});
const {generation, revision} = current.availability;
return await workers.waitAvailable(poolId, {
  after: {generation, revision},
  wait_ms: 5000,
});
```

The helper's contract fixtures use that pinned schema. Native event execution
still needs a client build exposing it; these JS tests are not native lifecycle
tests. As a temporary coordination channel, a worker can send its manager an
explicit collaboration message after completing a claim and entering idle.
The manager can await that inbox event, then verify the actual pool receipt;
the message alone does not establish available capacity.

### Recovering saved results

Worker helpers automatically recover `mcp_tool_result_json` spill receipts before
reading task data. The concise result preserves complete tasks, prompts, outputs,
errors, claims, retirement receipts, cancellation flags, and task-page cursors.
Only repeated `worker.slots[].logs` arrays are omitted; `logs_omitted` gives their
count and `next_log_sequence` remains unchanged. `tasks` preserves its native
`page.tasks` and `page.next_cursor` for subsequent pages.

For an unchanged full MCP payload, including monitor logs:

```js
const receipt = await call(poolId, "ssmcp.worker.status", {});
const recovered = await outputs.result(poolId, receipt);
if (recovered.isError) return recovered;
return recovered.structuredContent;
```

Recovery reads immutable complete artifacts in 32768-byte pages, at most four
concurrently, and decodes UTF-8 after joining the exact base64 bytes. It checks
page sizes, offsets, completeness, truncation, and EOF. `recovered_output` retains
the artifact receipt and verified byte/page progress; worker views expose it as
`_output`. Before parsing, recovery verifies the strictly decoded original UTF-8
JSON text against the receipt's 64-character lowercase SHA-256. A missing or
invalid synchronous runtime digest, or a hash mismatch, fails recovery without
returning an unverified result.
The recovery limit is 480 KiB, requiring at most 15 output reads, and 120 native
calls per helper operation; a bounded wait shares that call budget across its
observations. Larger or incomplete artifacts, invalid JSON, failed reads, and
native errors remain errors. Recovery failures
retain `native_result` and `recovery` with the original artifact and exact
`next_offset`; use explicit `outputs.read` if a larger capture is needed. A spill
metadata object is never returned as a task result.

Run the focused contracts with:

```sh
node --test tests/live-events.test.cjs tests/workers.test.cjs
```

Publishing a reviewed Git commit and updating a client's clean official checkout
with `ssmcp tools update` are separate steps. Once the source is updated, the next
selected-client code-mode run interprets it; these helpers need no Rust rebuild
or active-session reload. Check that run's tool-source receipt to identify the
loaded commit and hash. New native event primitives still require native support.

## License and origin

MIT. The initial helpers were extracted from the SSMCP code-mode API, retaining their behavior and host dispatch boundaries. Runtime validation results belong to the exact SSMCP source and tool-source revisions used in that run.

### Workspace context

The context namespace exposes only context.roots(clientId), which reads the workspace roots advertised by that client. The retired memory helpers status, read, list, compact, fork and switch are no longer exported. Loading the SDK does not restore or request conversation memory.
