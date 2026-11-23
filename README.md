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

## Source selection and local iteration

The client owns source selection. Follow its [source-loading contract](https://github.com/LIghtJUNction/ssmcp/blob/main/docs/code-mode.md#find-and-iterate-tool-implementations) and the outer `structuredContent.tool_sources` receipt for the exact loaded layers, source hashes and Git identity. Older clients can use a different loader. A file appearing in a workspace does not establish which source the current run executed.

Use an isolated checkout or a selected project override for edits. Run the focused checks before activating source, then use a new code-mode request and verify its receipt. Native authentication, schemas and resource boundaries still apply. A source or schema failure remains an error.

`tool_client_id` selects the authorized client whose source configuration applies. An existing verified agent binding selects that client's sources by default. Multiple clients without a selection use an explicitly identified official seed; their private overrides are not combined.

`ssmcp tools status` reports local source identity and may initialize the official checkout from the bundled seed. `check` observes upstream state, while `update` may fast-forward an eligible clean official checkout. Dirty or diverged work is preserved. Publishing source and updating a running client's selected helper are separate steps.

## Public helpers and removed aliases

The host provides `call`, `clients`, `image`, `print` and `console`. This factory exports `tools`, `say`, `ui`, `collab`, `messages`, `events`, `outputs`, `fs`, `context`, `skills`, `agents`, `exec`, `rsync`, `jobs`, `waitFor`, `ports`, `resources` and `workers`.

The following eight convenience exports have been deleted from the factory. Their native operations remain accessible:

| Removed export | Current API |
| --- | --- |
| `sync` | `rsync(options)` |
| `native` | `call(clientId, discoveredName, args)` |
| `capabilities` | `call(clientId,"ssmcp.client.capabilities",{})` |
| `computer` | `call(clientId,"ssmcp.computer."+operation,args)` |
| `reload` | `call(clientId,"ssmcp.client.reload",{})` |
| `sessions` | `call(clientId,"ssmcp.session."+operation,args)` |
| `rtk` | `exec.start/run(clientId,{command:["rtk",...argv]})` |
| `terminal` | `call(clientId,"terminal."+operation,args)` |

Discover exact names and schemas with `tools.search`. A raw `call` returns the complete MCP result: inspect `isError` before reading `structuredContent`. Transport errors remain rejected promises. No replacement proxy or automatic fallback recreates the deleted aliases.

## Event subscriptions

`events` exposes eight methods: `subscribe`, `read`, `wait`, `ack`, `unsubscribe`, `subscriptions`, `publish` and `policy`. Each accepts the selected client ID followed by an arguments object, then dispatches exactly one `events.<action>` builtin with `client_id`. It preserves source identities, subscription IDs, cursors, native errors and reply fields.

~~~js
const subscription = await events.subscribe(clientId, {
  request_id: "build-events-1",
  filter: {kinds:["worker.completed"],client_ids:[clientId]},
});
return subscription;
~~~

The subscription request may include `after` and `source_agents:[{client_id,agent_id,token}]`. Each additional source needs its own private credentials. The selected client uses explicit `agent_id`/`token` or this run's verified `collab.bind`. A token for one client does not authenticate another; the native relay checks account access and exact private subscription ownership.

Use the returned subscription ID with `read` or `wait`. JS `events.wait` defaults to 1000 ms and accepts 0–1000 ms. It never loops. For a longer observation, call the public `events` tool directly with `action:"wait"`, or the public `await` tool with `{type:"event",subscription_id,limit?}`; supporting relays permit up to 55000 ms without holding a JavaScript slot.

`ack` forwards `subscription_id` and `through`; `unsubscribe` forwards `subscription_id`. `subscriptions` lists the caller's subscriptions. `publish` forwards `request_id`, a `custom.*` name and `data`. `policy` forwards its optional native `patch`. The helper does not acknowledge, subscribe again, publish again or change cursors automatically. Check the supporting relay's current schema for retained ranges and authorization. Updating this repository alone does not implement the relay event service.

`waitFor` also performs one short `await` operation. Its timeout defaults to 1000 ms; an explicit timeout or window must be 1000 ms. Resume an outer wait with its original `wait_id`, exact `after` cursor and new observation window. `waitFor.cancel` only stops that observation.

## Bounded command observations

`exec.run` starts once, waits at most once, then immediately reads one output page. Its `wait_ms` defaults to 1000 ms and accepts 0–55000 ms. Time spent launching reduces the remaining observation window. It returns the actual job state, original `job_id`, stdout/stderr cursors and capture metadata. A command can still be running when this call returns.

`exec.parallel` accepts up to 32 items and `{concurrency:4,wait_ms:1000}`. Concurrency accepts 1–8. The batch shares one `wait_ms` observation window, at most 55000 ms; an item's own `wait_ms` can reduce its wait further. Each launched job receives at most one wait and one read. Only a confirmed completed job frees its batch slot. Running and unconfirmed jobs keep their slots, and remaining items are explicitly `not_started:true`. With a zero batch window, at most the first job in each slot starts.

`fulfilled` means an observation was returned. Inspect `value.running` and `value.exit_code` to determine completion and success. Local validation failures are `rejected` with `not_started:true`. A failure after launch retains the known `job_id`; a lost launch response may require `exec.list`. Neither case cancels or repeats work. `timeout_ms` still controls the command's independent execution deadline.

The window bounds requested observation, not arbitrary network or output-transfer latency. Prefer the short default; start long work with `exec.start` and observe it through the public `await` tool or subsequent reads. Direct `exec.wait` defaults to 1000 ms and accepts explicit waits up to 55000 ms when the native client supports them. `exec.read` is immediate unless an explicit native wait is supplied. Preserve both stream cursors across reads.

## Live thread events

Use `ui.events(clientId, {agent_id?, main?, cursor?, generation?, limit?})` to read the bounded event stream held by that live client. The helper supplies `action: "thread"` and the exact selected `client_id`. Follow the returned `generation` and `next_cursor`; earlier events can leave the memory budget. A process exit or reload does not restore them.

The helper discovers the authorized native catalog, prefers `ssmcp.ui.events`, and only uses an older client's `ssmcp.ui.history` when its schema explicitly advertises the `thread` action and the current API is absent. Capability discovery is limited to 32 catalog pages. An authorization error, native failure, malformed catalog, or incomplete scan stops the read. It does not retry through another namespace.

`ui.history` and the global `history.list`, `history.metadata`, `history.read`, and `history.search` helpers are removed. The event helper rejects conversation IDs, archive fields, other actions, and a `client_id` that differs from the selected client. Native account, thread, cursor, and connection checks remain authoritative.

Run the focused helper contract checks with:

```sh
node --test tests/live-events.test.cjs
```

## Worker tasks and bounded waits

`workers.status/attach/submit/tasks/result/cancel/stop/resize` and external worker
`wait/claim/complete/report/release` call the corresponding `ssmcp.worker.*`
operations under the current authenticated binding. They do not start a model,
switch identity or resubmit work. Preserve each native claim and retirement
receipt unchanged.

`workers.wait` defaults to one 1000 ms observation. `workers.result` defaults to
an immediate observation. Both reject JS waits above 1000 ms. Long observations
belong in the public `await` tool or a direct native call using its discovered
schema; a supporting client accepts up to 55000 ms.

`workers.waitResult(poolId,{task_id,timeout_ms:1000})` makes exactly one short
`worker.result` call and retains the existing envelope
`{result:<native view>,wait:{reason,timed_out,elapsed_ms}}`. Timeout accepts
0–1000 ms. The returned task keeps its actual queued, working, cancelling,
completed, failed, cancelled or unknown state. An unknown result preserves
`replay_safe` and never triggers submission. Observe the same task ID in a later
outer call to continue; expiry does not cancel it.

An external worker reuses its original `request_id` when retrying a lost wait
response. Preserve the assigned claim for `complete`, then choose a new wait
request ID. Retirement uses the exact native receipt.

### Pool availability

`workers.waitAvailable(poolId,{after?,wait_ms?})` discovers the advertised
`ssmcp.worker.wait_available` generation/revision schema and calls it once.
Its JS wait defaults to 1000 ms and accepts 0–1000 ms. The capability check
supports both the older 5000 ms and current 55000 ms native schema without
claiming that the native primitive exists on every client. Missing support or
incomplete discovery is an error; there is no polling fallback.

Omit `after` for the native current snapshot, or pass the returned exact
`{generation,revision}` cursor to observe a change. Inspect the actual accepting
state and idle capacity before scheduling. An event does not reserve a worker.
Generation changes, account access and stale cursors remain native decisions.

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
calls per helper operation; a short worker observation uses that same bounded
recovery budget. Larger or incomplete artifacts, invalid JSON, failed reads, and
native errors remain errors. Recovery failures
retain `native_result` and `recovery` with the original artifact and exact
`next_offset`; use explicit `outputs.read` if a larger capture is needed. A spill
metadata object is never returned as a task result.

## Checks and delivery

~~~sh
node --test tests/*.test.cjs
~~~

These tests exercise helper dispatch, short waits, shared execution budgets,
exact claim preservation, error handling and bounded output recovery. They do not
establish native event authorization or deployment on a live client. The SSMCP
repository also runs the real code-mode JSON bridge against its packaged bundle.

Commit source changes, then separately update the selected client's helper when
authorized. Every new code-mode call records the actual loaded source identity.
New native capabilities still require a supporting native build.

## License and origin

MIT. These helpers were extracted from the SSMCP code-mode API. Runtime validation
belongs to the exact native build and tool-source revisions observed in that run.

### Workspace context

`context.roots(clientId)` lists the client's advertised workspace roots. Retired
memory status/read/list/compact/fork/switch helpers remain absent. Loading the SDK
does not restore or request conversation memory.
