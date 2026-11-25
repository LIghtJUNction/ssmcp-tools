'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const source=readFileSync(join(__dirname,'..','tools.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const mcp=value=>({content:[],isError:false,structuredContent:value});
function fixture(handler) {
  let now=10000;
  const calls=[];
  const sdk=vm.runInNewContext(source,{Date:{now:()=>now}},{timeout:1000})({
    clients:[{id:'one'}],previous:{},
    dispatch:async()=>assert.fail('unexpected builtin'),
    call:async(id,name,args)=>{
      calls.push({id,name,args:plain(args)});
      return handler(name,args,{advance:ms=>{now+=ms;},set:value=>{now=value;}});
    },
  });
  return {sdk,calls};
}
test('exec.run shares its observation window with launch latency and preserves cursors', async()=>{
  const args=Object.freeze({command:['slow'],timeout_ms:90000,wait_ms:1000});
  const {sdk,calls}=fixture((name,args,clock)=>{
    if(name==='ssmcp.exec.start'){clock.advance(400);return mcp({job_id:'job',running:true});}
    if(name==='ssmcp.exec.wait'){assert.equal(args.wait_ms,600);clock.advance(600);return mcp({job_id:'job',running:true,wait_timed_out:true});}
    return mcp({snapshot:{job_id:'job',running:true},stdout:'partial',stderr:'',stdout_cursor:7,stderr_cursor:2,stdout_eof:false});
  });
  const value=await sdk.exec.run('one',args);
  assert.equal(value.job_id,'job');assert.equal(value.running,true);
  assert.equal(value.stdout_cursor,7);assert.equal(value.stderr_cursor,2);
  assert.equal(calls[0].args.timeout_ms,90000);
  assert.equal(calls.length,3);
  assert.equal(args.wait_ms,1000);
});
test('exec.run does not add a wait after launch consumes the default short window', async()=>{
  const {sdk,calls}=fixture((name,args,clock)=>{
    if(name==='ssmcp.exec.start'){clock.advance(2000);return mcp({job_id:'job',running:true});}
    assert.equal(name,'ssmcp.exec.read');
    return mcp({snapshot:{job_id:'job',running:true},stdout_cursor:0,stderr_cursor:0});
  });
  const value=await sdk.exec.run('one',{command:['slow']});
  assert.equal(value.job_id,'job');assert.equal(value.running,true);
  assert.equal(calls.length,2);
});
test('a native wait preserves start-only receipts alongside the latest job state', async () => {
  const reuse = {input_version:'tree-abc',ttl_ms:1000};
  const {sdk,calls} = fixture((name, args) => {
    if (name === 'ssmcp.exec.start') {
      assert.deepEqual(plain(args), {command:['inspect'],reuse});
      return mcp({job_id:'physical-job',running:true,reuse:{status:'joined'}});
    }
    assert.equal(args.job_id, 'physical-job');
    if (name === 'ssmcp.exec.wait') return mcp({job_id:'physical-job',running:false,exit_code:0});
    assert.equal(name, 'ssmcp.exec.read');
    return mcp({snapshot:{job_id:'physical-job',running:false,exit_code:0},stdout:'result'});
  });
  const value = await sdk.exec.run('one', {command:['inspect'],reuse});
  assert.equal(value.job_id, 'physical-job');
  assert.equal(value.running, false);
  assert.equal(value.exit_code, 0);
  assert.equal(value.stdout, 'result');
  assert.deepEqual(plain(value.reuse), {status:'joined'});
  assert.equal(calls.length, 3);
});
test('parallel pending jobs keep their slots and never enter a polling loop',async()=>{
  const {sdk,calls}=fixture((name,args)=>{
    const job_id=name==='ssmcp.exec.start'?args.command[0]:args.job_id;
    const state={job_id,running:true,exit_code:null};
    return mcp(name==='ssmcp.exec.read'?{snapshot:state,stdout_cursor:3,stderr_cursor:1}:state);
  });
  const result=await sdk.exec.parallel('one',Array.from({length:4},(_,i)=>({command:['job'+i]})),{concurrency:2});
  assert.deepEqual(plain(result.slice(0,2).map(x=>x.value.job_id)),['job0','job1']);
  assert(result.slice(0,2).every(x=>x.status==='fulfilled'&&x.value.running&&x.value.stdout_cursor===3));
  assert(result.slice(2).every(x=>x.status==='rejected'&&x.not_started&&!Object.hasOwn(x,'job_id')));
  assert.equal(calls.filter(x=>x.name==='ssmcp.exec.start').length,2);
  assert.equal(calls.filter(x=>x.name==='ssmcp.exec.wait').length,2);
  assert.equal(calls.length,6);
});
test('parallel completed jobs share one deadline before further launches',async()=>{
  let completed=0;
  const {sdk,calls}=fixture((name,args,clock)=>{
    const job_id=name==='ssmcp.exec.start'?args.command[0]:args.job_id;
    if(name==='ssmcp.exec.start')return mcp({job_id,running:true});
    if(name==='ssmcp.exec.wait'){
      assert.equal(args.wait_ms,completed===0?1000:500);
      clock.advance(completed++===0?400:500);
      return mcp({job_id,running:false,exit_code:0});
    }
    if(completed===1)clock.advance(100);
    return mcp({snapshot:{job_id,running:false,exit_code:0},stdout_cursor:4,stderr_cursor:0});
  });
  const result=await sdk.exec.parallel('one',[{command:['first']},{command:['second']},{command:['third']}],{concurrency:1,wait_ms:1000});
  assert.deepEqual(plain(result.slice(0,2).map(x=>x.value.job_id)),['first','second']);
  assert.equal(result[2].not_started,true);
  assert.match(result[2].reason,/window ended/);
  assert.deepEqual(calls.filter(x=>x.name==='ssmcp.exec.wait').map(x=>x.args.wait_ms),[1000,500]);
});
test('backward clock changes close the parallel observation window',async()=>{
  let completed=0;
  const {sdk,calls}=fixture((name,args,clock)=>{
    const job_id=name==='ssmcp.exec.start'?args.command[0]:args.job_id;
    if(name==='ssmcp.exec.start'){
      if(completed)clock.set(10000);
      return mcp({job_id,running:true});
    }
    if(name==='ssmcp.exec.wait'){
      if(completed===0)clock.advance(800);
      completed++;
      return mcp({job_id,running:false,exit_code:0});
    }
    return mcp({snapshot:{job_id,running:false,exit_code:0}});
  });
  await sdk.exec.parallel('one',[{command:['first']},{command:['second']}],{concurrency:1,wait_ms:1000});
  assert.deepEqual(calls.filter(x=>x.name==='ssmcp.exec.wait').map(x=>x.args.wait_ms),[1000]);
});
test('a zero batch window launches at most one job per slot and does not cancel',async()=>{
  const {sdk,calls}=fixture((name,args)=>{
    const job_id=name==='ssmcp.exec.start'?args.command[0]:args.job_id;
    const state={job_id,running:false,exit_code:0};
    return mcp(name==='ssmcp.exec.read'?{snapshot:state}:state);
  });
  const result=await sdk.exec.parallel('one',Array.from({length:4},(_,i)=>({command:['job'+i]})),{concurrency:2,wait_ms:0});
  assert.equal(result.filter(x=>x.not_started).length,2);
  assert.equal(calls.length,4);
  assert(calls.every(x=>['ssmcp.exec.start','ssmcp.exec.read'].includes(x.name)));
});
test('unconfirmed parallel jobs never free slots or cause replay',async()=>{
  const {sdk,calls}=fixture((name,args)=>{
    if(name==='ssmcp.exec.start')return mcp({job_id:args.command[0],running:true});
    throw new Error('read transport lost');
  });
  const result=await sdk.exec.parallel('one',[{command:['first'],wait_ms:0},{command:['next']}],{concurrency:1});
  assert.equal(result[0].job_id,'first');
  assert.match(result[0].reason,/read transport lost/);
  assert.equal(result[1].not_started,true);
  assert.equal(calls.length,2);
});
test('native job observation supports 55 seconds while default wait remains short',async()=>{
  const {sdk,calls}=fixture((_name,args)=>mcp(args));
  await sdk.exec.wait('one','job');
  await sdk.exec.wait('one','job',{wait_ms:55000});
  await sdk.exec.read('one',{job_id:'job',wait_ms:55000});
  assert.deepEqual(calls.map(x=>x.args.wait_ms),[1000,55000,55000]);
  for(const method of ['wait','read']) {
    for(const wait_ms of [55001,-1,null,NaN,1.5]) {
      await assert.rejects(sdk.exec[method]('one','job',{wait_ms}),/0\.\.=55000/);
    }
  }
  assert.equal(calls.length,3);
});
test('invalid batch windows do not launch any commands',async()=>{
  const {sdk,calls}=fixture(()=>assert.fail('invalid budget launched a process'));
  for(const wait_ms of [55001,-1,null,NaN,1.5]) {
    await assert.rejects(sdk.exec.parallel('one',[{command:['no']}],{wait_ms}),/0\.\.=55000/);
  }
  assert.deepEqual(calls,[]);
});
