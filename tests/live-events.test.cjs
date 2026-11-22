'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'tools.js'), 'utf8');
const factory = vm.runInNewContext(source, {}, {timeout: 1000});
const current = {
  name: 'ssmcp.ui.events',
  inputSchema: {type: 'object', properties: {action: {const: 'thread'}}},
};
const legacy = {
  name: 'ssmcp.ui.history',
  inputSchema: {oneOf: [{properties: {action: {const: 'thread'}}}]},
};
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(pages, nativeResult) {
  const calls = [], catalogs = [];
  const sdk = factory({
    clients: [{id: 'one'}],
    digest: () => '0'.repeat(64),
    call: async (id, name, arguments_) => {
      calls.push({id, name, arguments: plain(arguments_)});
      if (nativeResult) return nativeResult;
      return {isError: false, structuredContent: {generation: 'live', next_cursor: 17}};
    },
    dispatch: async (kind, id, name, cursor) => {
      assert.equal(kind, 'tools');
      catalogs.push({id, cursor});
      if (typeof pages === 'function') return pages(cursor, catalogs.length);
      const page = pages[cursor ?? 'first'];
      if (page instanceof Error) throw page;
      assert.ok(page, 'the helper requested only a returned catalog cursor');
      return page;
    },
    previous: {},
  });
  assert.equal(calls.length, 0, 'loading helpers must never call a native tool');
  assert.equal(catalogs.length, 0, 'loading helpers must never inspect a client');
  return {sdk, calls, catalogs};
}

test('current live events preserve exact selectors and cursors', async () => {
  const {sdk, calls} = fixture({first: {tools: [current]}});
  const result = await sdk.ui.events('one', {
    action: 'thread', client_id: 'one', agent_id: 'agent_exact',
    cursor: 12, generation: 'live', limit: 32,
  });
  assert.deepEqual(result, {generation: 'live', next_cursor: 17});
  assert.deepEqual(calls, [{
    id: 'one', name: 'ssmcp.ui.events',
    arguments: {action: 'thread', client_id: 'one', agent_id: 'agent_exact', cursor: 12, generation: 'live', limit: 32},
  }]);
  assert.equal(Object.isFrozen(sdk.ui), true);
  assert.equal(Object.hasOwn(sdk.ui, 'history'), false);
  assert.equal(Object.hasOwn(sdk, 'history'), false);
});

test('current events take precedence over legacy support on an earlier page', async () => {
  const {sdk, calls, catalogs} = fixture({
    first: {tools: [legacy], nextCursor: 'second'},
    second: {tools: [current], nextCursor: null},
  });
  await sdk.ui.events('one', {main: true});
  assert.equal(catalogs.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'ssmcp.ui.events');
  assert.deepEqual(calls[0].arguments, {main: true, action: 'thread', client_id: 'one'});
});

test('an older client receives only its advertised thread action', async () => {
  const {sdk, calls} = fixture({first: {tools: [legacy], nextCursor: null}});
  await sdk.ui.events('one', {cursor: 3});
  assert.deepEqual(calls, [{
    id: 'one', name: 'ssmcp.ui.history',
    arguments: {cursor: 3, action: 'thread', client_id: 'one'},
  }]);
});

test('archive or malformed legacy schemas do not authorize a fallback', async () => {
  for (const descriptor of [
    {name: 'ssmcp.ui.history', inputSchema: {properties: {action: {const: 'list'}}}},
    {name: 'ssmcp.ui.history', inputSchema: {properties: {action: {enum: 'thread'}}}},
    {name: 'ssmcp.ui.history_archive', inputSchema: legacy.inputSchema},
  ]) {
    const {sdk, calls} = fixture({first: {tools: [descriptor]}});
    await assert.rejects(sdk.ui.events('one'), /does not advertise live thread events/);
    assert.equal(calls.length, 0);
  }
});

test('a present incompatible current API does not fall back to an older namespace', async () => {
  const {sdk, calls} = fixture({first: {tools: [
    {name: 'ssmcp.ui.events', inputSchema: {properties: {action: {const: 'other'}}}},
    legacy,
  ]}});
  await assert.rejects(sdk.ui.events('one'), /does not advertise live thread events/);
  assert.equal(calls.length, 0);
});

test('retired actions and mismatched targets are rejected before discovery', async () => {
  const {sdk, calls, catalogs} = fixture({first: {tools: [legacy]}});
  for (const args of [
    null, [], 'invalid',
    ...['list', 'metadata', 'read', 'search', 'archive'].map(action => ({action})),
    {client_id: 'another'}, {id: 'old-conversation'}, {state: 'archived'},
  ]) {
    await assert.rejects(sdk.ui.events('one', args));
  }
  assert.equal(catalogs.length, 0);
  assert.equal(calls.length, 0);
});

test('authorization and current native failures never retry through history', async () => {
  const denied = fixture({first: new Error('access denied')});
  await assert.rejects(denied.sdk.ui.events('one'), /access denied/);
  assert.equal(denied.calls.length, 0);
  const failed = fixture(
    {first: {tools: [current, legacy]}},
    {isError: true, content: [{type: 'text', text: 'native access denied'}]},
  );
  await assert.rejects(failed.sdk.ui.events('one'), /native access denied/);
  assert.deepEqual(failed.calls.map(call => call.name), ['ssmcp.ui.events']);
});

test('incomplete or repeated catalog cursors never trigger legacy reads', async () => {
  const repeated = fixture({
    first: {tools: [legacy], nextCursor: 'again'},
    again: {tools: [], nextCursor: 'again'},
  });
  await assert.rejects(repeated.sdk.ui.events('one'), /repeated a cursor/);
  assert.equal(repeated.calls.length, 0);

  const bounded = fixture((_cursor, page) => ({tools: [legacy], nextCursor: 'page-' + page}));
  await assert.rejects(bounded.sdk.ui.events('one'), /bounded capability discovery/);
  assert.equal(bounded.catalogs.length, 32);
  assert.equal(bounded.calls.length, 0);
});


test('retired memory helpers are absent while workspace roots remain available', async () => {
  const {sdk, calls, catalogs} = fixture({first: {tools: [current]}});
  assert.deepEqual(Object.keys(sdk.context), ['roots']);
  assert.equal(Object.isFrozen(sdk.context), true);
  for (const name of ['status', 'read', 'list', 'compact', 'fork', 'switch']) {
    assert.equal(Object.hasOwn(sdk.context, name), false, name);
  }
  await sdk.context.roots('one');
  assert.deepEqual(calls, [{id: 'one', name: 'ssmcp.context.roots', arguments: {}}]);
  assert.equal(catalogs.length, 0);
});
