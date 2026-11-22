'use strict';
// Small offline model of code_mode's JSON-lines host/VM bridge. No native tools.
const vm = require('node:vm');
const readline = require('node:readline');
const {createHash} = require('node:crypto');
const pending = new Map(), digests = [];
let started = false, finished = false, nextId = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
function finish(frame, code) {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify(frame) + '\n', () => process.exit(code));
}
const fail = error => finish({type:'error', message:error.message}, 1);
function bridge(clientId, name, encoded) {
  if (pending.size >= 16 || nextId >= 128) throw new Error('Host call budget exceeded');
  const args = JSON.parse(encoded), id = ++nextId;
  return new Promise(resolve => {
    pending.set(id, resolve);
    send({type:'call', id, request:{op:'call', client_id:clientId, name, arguments:args}});
  });
}
function digest(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4 * 1024 * 1024) return '';
  const sha256 = createHash('sha256').update(value, 'utf8').digest('hex');
  digests.push({bytes:Buffer.byteLength(value, 'utf8'), sha256});
  return sha256;
}
async function run(frame) {
  const context = vm.createContext(Object.assign(Object.create(null), {
    __host:bridge, __digest:digest,
    __input:JSON.stringify({client_id:frame.client_id, receipt:frame.receipt}),
  }), {codeGeneration:{strings:false, wasm:false}});
  vm.runInContext(`
    const native = globalThis.__host, hash = globalThis.__digest;
    const input = JSON.parse(globalThis.__input);
    delete globalThis.__host; delete globalThis.__digest; delete globalThis.__input;
    const forbidden = [typeof Buffer, typeof TextDecoder, typeof atob, typeof crypto,
      typeof require, typeof process];
    if (forbidden.some(value => value !== 'undefined')) throw new Error('Unexpected VM host global');
    const call = async (id, name, args = {}) => {
      const reply = JSON.parse(await native(id, name, JSON.stringify(args)));
      if (!reply.ok) throw new Error(reply.error);
      return reply.value;
    };
    const core = Object.freeze({call, digest:hash, clients:[{id:input.client_id}], previous:{},
      dispatch:() => {throw new Error('Unexpected catalog request');}});
  `, context, {timeout:2000});
  vm.runInContext('const sdk = (\n' + frame.source + '\n)(core);', context, {timeout:2000});
  if (nextId !== 0) throw new Error('Loading a source made a native call');
  const result = await vm.runInContext(`(async () => ({
    result:await sdk.outputs.result(input.client_id, input.receipt), forbidden,
  }))()`, context, {timeout:2000});
  if (pending.size) throw new Error('Unawaited calls');
  finish({type:'result', ...result, digests}, 0);
}
const input = readline.createInterface({input:process.stdin, crlfDelay:Infinity});
input.on('line', line => {
  if (finished) return;
  try {
    if (Buffer.byteLength(line, 'utf8') > 4 * 1024 * 1024) throw new Error('Oversized frame');
    const frame = JSON.parse(line);
    if (!started) {
      if (frame.type !== 'run') throw new Error('Expected run frame');
      started = true;
      run(frame).catch(fail);
      return;
    }
    if (frame.type !== 'reply' || !pending.has(frame.id) || typeof frame.ok !== 'boolean') {
      throw new Error('Invalid reply');
    }
    const resolve = pending.get(frame.id);
    pending.delete(frame.id);
    // Same extra serialization boundary as the production host after readline JSON.parse.
    resolve(JSON.stringify(frame.ok ? {ok:true, value:frame.value} : {ok:false, error:frame.error}));
  } catch (error) { fail(error); }
});
input.on('close', () => {if (!finished) fail(new Error('Input closed before completion'));});
