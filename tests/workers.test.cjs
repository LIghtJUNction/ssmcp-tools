'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {createHash} = require('node:crypto');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'tools.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const mcp = value => ({content:[{type:'text', text:JSON.stringify(value)}], structuredContent:value, isError:false});
const claim = {attempt:1, epoch:1, generation:'generation', id:'claim', slot:0, task_id:'task-1'};
// Native schema from ssmcp commit 9902b88c8d48639cbe5e0effacbd0877e55be174,
// src/worker/pool.rs. Current live 0.10.27 does not yet advertise this tool.
const availabilityTool = {name:'ssmcp.worker.wait_available', inputSchema:{
  type:'object', additionalProperties:false, required:[], properties:{
    after:{type:'object', additionalProperties:false, required:['generation','revision'],
      properties:{generation:{type:'string'}, revision:{type:'integer', minimum:0}}},
    wait_ms:{type:'integer', minimum:0, maximum:5000, default:5000},
  },
}};
const task = status => ({task_id:'task-1', status, output:null, error:null, replay_safe:false});
const pool = {generation:'generation', idle:0, working:1, slots:[{
  slot:0, epoch:1, state:'working', task_id:'task-1', next_log_sequence:101,
  logs:Array.from({length:100}, (_, i) => ({sequence:i, text:'中文😀'.repeat(50)})),
}]};

function fixture(handler, descriptors = [], options = {}) {
  const calls = [], catalogs = [];
  let now = 0;
  const context = vm.createContext({Date:{now:() => now}});
  assert.deepEqual(plain(vm.runInContext('[typeof Buffer, typeof TextDecoder, typeof atob]', context)),
    ['undefined','undefined','undefined']);
  const factory = vm.runInContext(source, context, {timeout:1000});
  const sdk = factory({
    clients:[{id:'pool'}], previous:{},
    digest:Object.hasOwn(options, 'digest') ? options.digest : sha256,
    call:async (id, name, args) => {
      calls.push({id, name, args:plain(args)});
      return handler(name, args, {advance:ms => {now += ms;}, calls});
    },
    dispatch:async (kind, id, name, cursor) => {
      assert.equal(kind, 'tools');
      catalogs.push({id, cursor});
      return {tools:descriptors, nextCursor:null};
    },
  });
  assert.equal(calls.length, 0);
  assert.equal(catalogs.length, 0);
  return {sdk, calls, catalogs};
}

function spilled(reply, mutatePage = page => page) {
  const bytes = Buffer.from(JSON.stringify(reply));
  const receipt = mcp({spilled:true, format:'mcp_tool_result_json',
    artifact:{id:'artifact', bytes:bytes.length, complete:true, sha256:sha256(bytes)}});
  return {receipt, bytes, read(args) {
    assert.equal(args.id, 'artifact');
    assert.equal(args.max_bytes, 4096);
    const chunk = bytes.subarray(args.offset, args.offset + args.max_bytes);
    return mcp(mutatePage({id:'artifact', offset:args.offset, bytes:chunk.length,
      next_offset:args.offset + chunk.length, size:bytes.length,
      complete:true, truncated:false, eof:args.offset + chunk.length === bytes.length,
      data_base64:chunk.toString('base64'), text:chunk.toString('utf8')}));
  }};
}

test('worker helpers preserve native arguments and binding, with concise monitor logs', async () => {
  const value = {task:task('unknown'), worker:pool, page:{tasks:[task('unknown')], next_cursor:'opaque'}};
  const {sdk, calls} = fixture(() => mcp(value));
  const out = await sdk.workers.tasks('pool', {cursor:'opaque-before', limit:4});
  assert.deepEqual(plain(out.page), value.page);
  assert.deepEqual(plain(out.task), value.task);
  assert.equal(out.worker.slots[0].logs, undefined);
  assert.equal(out.worker.slots[0].logs_omitted, 100);
  assert.equal(out.worker.slots[0].next_log_sequence, 101);
  assert.deepEqual(calls, [{id:'pool', name:'ssmcp.worker.tasks', args:{cursor:'opaque-before', limit:4}}]);
  assert.ok(Object.isFrozen(sdk.workers));
});

test('saved MCP JSON recovers exact Unicode, claim, task/page cursors and completeness', async () => {
  const value = {status:'assigned', claim, text:'验收😀'.repeat(2100),
    cancel_requested:false, retire_requested:false, worker:pool,
    page:{tasks:[task('working')], next_cursor:'exact-next'}};
  const saved = spilled(mcp(value));
  assert.ok(saved.bytes.length > 4096);
  const {sdk, calls} = fixture((name, args) => name === 'ssmcp.output.read' ? saved.read(args) : saved.receipt);
  const out = await sdk.workers.wait('pool', {request_id:'original-wait', wait_ms:0});
  assert.deepEqual(plain(out.claim), claim);
  assert.equal(out.text, value.text);
  assert.deepEqual(plain(out.page), value.page);
  assert.equal(out._output.complete, true);
  assert.equal(out._output.next_offset, saved.bytes.length);
  assert.equal(out._output.artifact.sha256, sha256(saved.bytes));
  assert.equal(calls[0].args.request_id, 'original-wait');
  assert.ok(calls.slice(1).every(call => call.id === 'pool' && call.name === 'ssmcp.output.read'));
  const raw = await sdk.outputs.result('pool', saved.receipt);
  assert.deepEqual(plain(raw.structuredContent), value);
});

test('saved output rejects same-length content changes despite consistent page metadata', async () => {
  const saved = spilled(mcp({task:{...task('completed'), output:'ORIGINAL'}}));
  const at = saved.bytes.lastIndexOf('ORIGINAL');
  assert.ok(at >= 0);
  saved.bytes[at] = 'X'.charCodeAt(0);
  assert.equal(saved.bytes.length, saved.receipt.structuredContent.artifact.bytes);
  assert.equal(JSON.parse(saved.bytes.toString('utf8')).structuredContent.task.output, 'XRIGINAL');
  assert.notEqual(sha256(saved.bytes), saved.receipt.structuredContent.artifact.sha256);
  const {sdk, calls} = fixture((name, args) => saved.read(args));
  await assert.rejects(sdk.outputs.result('pool', saved.receipt), error => {
    assert.match(error.message, /SHA-256 does not match/);
    assert.equal(error.recovery.complete, false);
    assert.equal(error.recovery.next_offset, saved.bytes.length);
    assert.deepEqual(plain(error.native_result), saved.receipt);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'ssmcp.output.read');
});

test('saved output fails explicitly when runtime SHA-256 support is unavailable or asynchronous', async () => {
  for (const digest of [undefined, () => '', () => Promise.resolve('0'.repeat(64)),
    () => {throw new Error('runtime digest unavailable');}]) {
    const saved = spilled(mcp({task:task('completed')}));
    const {sdk, calls} = fixture((name, args) => saved.read(args), [], {digest});
    await assert.rejects(sdk.outputs.result('pool', saved.receipt), error => {
      assert.match(error.message, /requires a synchronous SHA-256 digest/);
      assert.equal(error.recovery.complete, false);
      assert.deepEqual(plain(error.native_result), saved.receipt);
      return true;
    });
    assert.equal(calls.length, digest === undefined ? 0 : 1);
  }
});

test('retrying a lost wait receipt preserves the original request ID and claim', async () => {
  let attempt = 0;
  const {sdk, calls} = fixture(() => {
    if (++attempt === 1) throw new Error('transport timeout; original call may continue');
    return mcp({status:'assigned', claim, text:'exact task'});
  });
  const args = {request_id:'same-request', wait_ms:0};
  await assert.rejects(sdk.workers.wait('pool', args), /transport timeout/);
  assert.equal(calls.length, 1, 'the helper never retries a mutation automatically');
  const out = await sdk.workers.wait('pool', args);
  assert.deepEqual(plain(out.claim), claim);
  assert.deepEqual(calls.map(call => call.args), [args, args]);
});

test('native failures remain errors even when the complete failure was spilled', async () => {
  const failure = {isError:true, content:[{type:'text', text:'manager access denied'}], structuredContent:{code:'denied'}};
  for (const spill of [false, true]) {
    const saved = spilled(failure);
    const {sdk, calls} = fixture((name, args) => name === 'ssmcp.output.read' ? saved.read(args) : spill ? saved.receipt : failure);
    await assert.rejects(sdk.workers.result('pool', {task_id:'task-1'}), error => {
      assert.match(error.message, /manager access denied/);
      assert.equal(error.native_result.isError, true);
      assert.equal(error.native_result.structuredContent.code, 'denied');
      return true;
    });
    assert.ok(calls.every(call => ['ssmcp.worker.result','ssmcp.output.read'].includes(call.name)));
  }
});

test('partial captures, oversized artifacts and invalid page cursors are never task results', async () => {
  for (const change of [{complete:false}, {bytes:480 * 1024 + 1},
    {sha256:undefined}, {sha256:'receipt-hash'}, {sha256:'A'.repeat(64)}]) {
    const saved = spilled(mcp({task:task('completed')}));
    Object.assign(saved.receipt.structuredContent.artifact, change);
    const {sdk, calls} = fixture(() => saved.receipt);
    await assert.rejects(sdk.workers.result('pool', {task_id:'task-1'}), error => {
      assert.equal(error.recovery.complete, false);
      assert.equal(error.recovery.next_offset, 0);
      assert.deepEqual(plain(error.native_result), plain(saved.receipt));
      return true;
    });
    assert.equal(calls.length, 1);
  }
  for (const change of [{next_offset:0}, {complete:false}, {truncated:true}, {size:999}, {data_base64:'not-base64'}]) {
    const saved = spilled(mcp({task:task('completed')}), page => ({...page, ...change}));
    const {sdk} = fixture((name, args) => name === 'ssmcp.output.read' ? saved.read(args) : saved.receipt);
    await assert.rejects(sdk.workers.result('pool', {task_id:'task-1'}), error => {
      assert.equal(error.recovery.complete, false);
      assert.equal(error.recovery.next_offset, 0);
      return true;
    });
  }
});

test('read transport failure preserves its exact artifact and byte cursor', async () => {
  const saved = spilled(mcp({task:{...task('completed'), output:'x'.repeat(8000)}}));
  const {sdk} = fixture((name, args) => {
    if (name !== 'ssmcp.output.read') return saved.receipt;
    if (args.offset >= 4096) throw new Error('read disconnected');
    return saved.read(args);
  });
  await assert.rejects(sdk.workers.result('pool', {task_id:'task-1'}), error => {
    assert.match(error.message, /read disconnected/);
    assert.equal(error.recovery.next_offset, 4096);
    assert.equal(error.recovery.artifact.id, 'artifact');
    return true;
  });
});

test('bounded native waits return completion for the same task without resubmitting', async () => {
  let round = 0;
  const {sdk, calls} = fixture((name, args, clock) => {
    assert.equal(name, 'ssmcp.worker.result');
    clock.advance(++round === 1 ? 5000 : 100);
    return mcp({task:{...task(round === 1 ? 'working' : 'completed'), output:round === 1 ? null : 'actual output'}});
  });
  const out = await sdk.workers.waitResult('pool', {task_id:'task-1', timeout_ms:10000});
  assert.equal(out.result.task.output, 'actual output');
  assert.equal(out.wait.reason, 'terminal');
  assert.equal(out.wait.timed_out, false);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.id === 'pool' && call.args.task_id === 'task-1' && call.args.wait_ms === 5000));
});

test('timeout keeps queued/working state; unknown and cancelling never trigger retries', async () => {
  for (const state of ['queued','working','completed','failed','cancelled','unknown','cancelling']) {
    const {sdk, calls} = fixture((name, args, clock) => {
      clock.advance(['queued','working'].includes(state) ? args.wait_ms : 1);
      return mcp({task:task(state)});
    });
    const out = await sdk.workers.waitResult('pool', {task_id:'task-1', timeout_ms:7000});
    assert.deepEqual(plain(out.result.task), task(state));
    assert.equal(out.wait.timed_out, ['queued','working'].includes(state));
    assert.equal(calls.length, ['queued','working'].includes(state) ? 2 : 1);
    assert.ok(calls.every(call => call.name === 'ssmcp.worker.result'));
  }
});

test('a nonblocking observation and malformed wait results remain bounded', async () => {
  const {sdk, calls} = fixture(() => mcp({task:task('working')}));
  const out = await sdk.workers.waitResult('pool', {task_id:'task-1', timeout_ms:0});
  assert.equal(out.wait.timed_out, true);
  assert.deepEqual(calls[0].args, {task_id:'task-1', wait_ms:0});
  for (const args of [{}, {task_id:'task-1', timeout_ms:25001}, {task_id:'task-1', manager:'forged'}]) {
    await assert.rejects(sdk.workers.waitResult('pool', args));
  }
  assert.equal(calls.length, 1);
  const invalid = fixture(() => mcp({task:{...task('working'), task_id:'other'}}));
  await assert.rejects(invalid.sdk.workers.waitResult('pool', {task_id:'task-1'}), /unexpected task ID/);
  assert.equal(invalid.calls.length, 1);
});

test('availability requires an advertised native event tool, never polling or takeover', async () => {
  const unsupported = fixture(() => {throw new Error('must not call a native mutation');});
  await assert.rejects(unsupported.sdk.workers.waitAvailable('pool'), error => error.code === 'WORKER_EVENT_WAIT_UNAVAILABLE');
  assert.equal(unsupported.calls.length, 0);
  const availability = {generation:'native-generation', revision:9, idle:1,
    accepting:true, idle_slots:[{slot:2, epoch:4}], scope:'coordination_slots'};
  const present = fixture(() => mcp({status:'changed', changed:true, availability}), [availabilityTool]);
  const args = {after:{generation:'native-generation', revision:8}, wait_ms:1000};
  const out = await present.sdk.workers.waitAvailable('pool', args);
  assert.equal(out.status, 'changed');
  assert.deepEqual(plain(out.availability), availability);
  assert.deepEqual(present.calls, [{id:'pool', name:availabilityTool.name, args}]);
});

test('availability rejects incompatible capabilities and forged cursors without a fallback', async () => {
  const incompatible = fixture(() => {throw new Error('must not forward');}, [
    {name:availabilityTool.name, inputSchema:{type:'object'}},
  ]);
  await assert.rejects(incompatible.sdk.workers.waitAvailable('pool'), error => error.code === 'WORKER_EVENT_WAIT_INCOMPATIBLE');
  assert.equal(incompatible.calls.length, 0);
  const valid = fixture(() => mcp({status:'unchanged', changed:false}), [availabilityTool]);
  for (const args of [{request_id:'wrong-contract'}, {wait_ms:5001},
    {after:{generation:'g', revision:1, owner:'forged'}},
    {after:{generation:'g', revision:Number.MAX_SAFE_INTEGER + 1}}]) {
    await assert.rejects(valid.sdk.workers.waitAvailable('pool', args));
  }
  assert.equal(valid.catalogs.length, 0);
  assert.equal(valid.calls.length, 0);
  const rejected = fixture(() => ({isError:true, content:[{type:'text', text:'stale generation'}]}), [availabilityTool]);
  await assert.rejects(rejected.sdk.workers.waitAvailable('pool', {after:{generation:'old', revision:0}}), /stale generation/);
  assert.equal(rejected.calls.length, 1);
});

test('a changed pool generation stops task waiting without retry or resubmission', async () => {
  let iteration = 0;
  const {sdk, calls} = fixture((name, args, clock) => {
    clock.advance(5000);
    return mcp({task:task('working'), worker:{generation:++iteration === 1 ? 'old' : 'replacement'}});
  });
  await assert.rejects(sdk.workers.waitResult('pool', {task_id:'task-1', timeout_ms:20000}), error => {
    assert.equal(error.task_id, 'task-1');
    assert.equal(error.observation.worker.generation, 'replacement');
    return true;
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.name === 'ssmcp.worker.result'));
});

test('a legal near-64-KiB terminal output survives a spilled native wait result', async () => {
  const output = '完整😀'.repeat(6000);
  assert.ok(Buffer.byteLength(output) > 32768 && Buffer.byteLength(output) <= 65536);
  const value = {task:{...task('completed'), output}, worker:{generation:'generation'}, wait:{native:'preserved'}};
  const saved = spilled(mcp(value));
  const {sdk, calls} = fixture((name, args) => name === 'ssmcp.output.read' ? saved.read(args) : saved.receipt);
  const out = await sdk.workers.waitResult('pool', {task_id:'task-1', timeout_ms:20000});
  assert.equal(out.result.task.output, output);
  assert.deepEqual(plain(out.result.wait), value.wait);
  assert.equal(out.result._output.complete, true);
  assert.equal(out.wait.reason, 'terminal');
  assert.equal(calls.filter(call => call.name === 'ssmcp.worker.result').length, 1);
});

test('wall-clock rollback cannot increase the native waiting budget', async () => {
  const {sdk, calls} = fixture((name, args, clock) => {
    clock.advance(-1000);
    return mcp({task:task('working')});
  });
  const out = await sdk.workers.waitResult('pool', {task_id:'task-1', timeout_ms:7000});
  assert.deepEqual(calls.map(call => call.args.wait_ms), [5000, 2000]);
  assert.equal(out.result.task.status, 'working');
  assert.equal(out.wait.reason, 'wait_budget');
  assert.equal(out.wait.elapsed_ms, 0);
});
