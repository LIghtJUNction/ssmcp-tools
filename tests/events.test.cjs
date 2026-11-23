'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const source = readFileSync(join(__dirname, '..', 'tools.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const actions = ['subscribe','read','wait','ack','unsubscribe','subscriptions','publish','policy'];
function fixture(handler = (_name,args) => args) {
  const calls = [];
  const sdk = vm.runInNewContext(source, {}, {timeout:1000})({
    clients:[{id:'selected'}],previous:{},
    call:async () => assert.fail('event helpers must use the builtin bridge'),
    dispatch:async (kind,id,name,args) => {
      assert.equal(kind,'builtin');
      assert.equal(id,'_');
      calls.push({name,args:plain(args)});
      return handler(name,args);
    },
  });
  assert.deepEqual(calls,[]);
  return {sdk,calls};
}
test('removed convenience namespaces are absent without replacement proxies', () => {
  const {sdk} = fixture();
  for (const name of ['sync','native','capabilities','computer','reload','sessions','rtk','terminal']) {
    assert.equal(Object.hasOwn(sdk,name),false,name);
  }
  assert.equal(typeof sdk.rsync,'function');
  assert.equal(Object.isFrozen(sdk.events),true);
  assert.deepEqual(Object.keys(sdk.events),actions);
});
test('all eight event methods dispatch exactly once with opaque fields preserved', async () => {
  const requests = [
    {request_id:'subscribe-once',filter:{kinds:['worker.completed'],client_ids:['selected','source'],actor_id:'actor',task_id:'task',include_own_waits:false},
      after:17,source_agents:[{client_id:'source',agent_id:'source-actor',token:'fixture-source-token'}]},
    {subscription_id:'sub',limit:32},
    {subscription_id:'sub',limit:1,wait_ms:1000},
    {subscription_id:'sub',through:19},
    {subscription_id:'sub'},
    {},
    {request_id:'publish-once',name:'custom.build',data:{ok:true,nested:['unchanged']}},
    {patch:{enabled:true,window_ms:1000,kinds:['custom.build'],strategy:'batch'}},
  ];
  const response={subscription_id:'sub',events:[{seq:19,type:'worker.completed'}],next_cursor:19,gap:false};
  const {sdk,calls}=fixture(() => response);
  for(let i=0;i<actions.length;i++) {
    const args=Object.freeze({...requests[i],agent_id:'selected-actor',token:'fixture-selected-token'});
    const before=plain(args);
    const result=await sdk.events[actions[i]]('selected',args);
    assert.equal(result,response,'native response identity must survive');
    assert.deepEqual(plain(args),before,'caller arguments must not be mutated');
    assert.deepEqual(calls[i],{name:'events.'+actions[i],args:{...before,client_id:'selected'}});
  }
  assert.equal(calls.length,8,'no followup read, acknowledgement or polling is implicit');
});
test('event waits are single short observations and reject longer JS waits locally', async () => {
  const {sdk,calls}=fixture();
  for(const wait_ms of [undefined,0,1000]) {
    await sdk.events.wait('selected',{subscription_id:'sub',...(wait_ms===undefined?{}:{wait_ms})});
  }
  assert.deepEqual(calls.map(x=>x.args.wait_ms),[1000,0,1000]);
  for(const wait_ms of [1001,55000,55001,-1,null,NaN,1.5]) {
    await assert.rejects(sdk.events.wait('selected',{subscription_id:'sub',wait_ms}),/0\.\.=1000/);
  }
  assert.equal(calls.length,3);
});
test('invalid selectors and action overrides fail without native dispatch', async () => {
  const {sdk,calls}=fixture();
  for(const name of actions) {
    await assert.rejects(sdk.events[name]('',{}),/client ID/);
    await assert.rejects(sdk.events[name]('selected',null),/object/);
    await assert.rejects(sdk.events[name]('selected',[]),/object/);
    await assert.rejects(sdk.events[name]('selected',{client_id:'other'}),/match/);
    await assert.rejects(sdk.events[name]('selected',{action:name}),/action/);
  }
  assert.deepEqual(calls,[]);
});
test('native event authorization and transport errors are never retried', async () => {
  for(const reason of ['private subscription owner mismatch','source credential rejected','relay disconnected']) {
    const error=new Error(reason);
    const {sdk,calls}=fixture(() => {throw error;});
    await assert.rejects(sdk.events.subscribe('selected',{request_id:'same'}),candidate=>candidate===error);
    assert.equal(calls.length,1);
  }
});
test('event reply metadata and native error envelopes are not reinterpreted', async () => {
  const response={isError:true,content:[{type:'text',text:'event unavailable'}],structuredContent:{gap:true,oldest_seq:7,latest_seq:30,has_more:true},_meta:{unchanged:true}};
  const {sdk,calls}=fixture(() => response);
  assert.equal(await sdk.events.read('selected',{subscription_id:'sub'}),response);
  assert.equal(calls.length,1);
});
test('waitFor uses the event target in one short outer await operation', async () => {
  const {sdk,calls}=fixture();
  const target={type:'event',subscription_id:'sub',limit:16};
  const options=Object.freeze({targets:[target],mode:'any',agent:{id:'actor',token:'fixture-token'}});
  await sdk.waitFor('selected',options);
  await sdk.waitFor('selected',{wait_id:'wait',after:0,window_ms:1000,timeout_ms:1000});
  await sdk.waitFor.cancel('selected','wait');
  assert.deepEqual(calls,[
    {name:'await',args:{...plain(options),client_id:'selected',timeout_ms:1000}},
    {name:'await',args:{wait_id:'wait',after:0,window_ms:1000,timeout_ms:1000,client_id:'selected'}},
    {name:'await',args:{client_id:'selected',op:'cancel',wait_id:'wait'}},
  ]);
  assert.equal(Object.hasOwn(options,'timeout_ms'),false);
});
test('waitFor prevents long JS windows while forwarding cancellation unchanged', async () => {
  const {sdk,calls}=fixture();
  for(const options of [{timeout_ms:55000},{timeout_ms:0},{window_ms:55000},{window_ms:0},{timeout_ms:null}]) {
    await assert.rejects(sdk.waitFor('selected',options),/1000/);
  }
  await sdk.waitFor('selected',{op:'cancel',wait_id:'wait'});
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0],{name:'await',args:{op:'cancel',wait_id:'wait',client_id:'selected'}});
});
