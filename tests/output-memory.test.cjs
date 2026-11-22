'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {createHash} = require('node:crypto');
const {spawn} = require('node:child_process');
const readline = require('node:readline');

const source = readFileSync(join(__dirname, '..', 'tools.js'), 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const mcp = value => ({content:[{type:'text', text:JSON.stringify(value)}], isError:false, structuredContent:value});
const flags = ['--jitless', '--no-addons', '--max-old-space-size=32',
  '--max-semi-space-size=1', '--stack-size=256'];

function binaryFixture() {
  const file = Buffer.alloc(163775);
  for (let i = 0; i < file.length; i++) file[i] = (i * 17 + 31) & 255;
  const value = {data_base64:file.toString('base64'), eof:true,
    next_offset:file.length, offset:0, size:file.length};
  const bytes = Buffer.from(JSON.stringify(mcp(value)));
  assert.equal(bytes.length, 436974);
  return bytes;
}

function unicodeFixture() {
  const size = 480 * 1024;
  // Noncanonical whitespace also requires hashing the original bytes, not reserialized JSON.
  const head = '\n \t{"content":[{"type":"text","text":"';
  const tail = '"}],"isError":true,"structuredContent":{"cursor":"opaque-中🙂","nested":[1,{"ok":false}]}}\n';
  const markers = [[1022, '🙂'], [4095, '中'], [32767, '中'], [65535, '🙂']];
  const parts = [head];
  let offset = Buffer.byteLength(head);
  for (const [at, text] of markers) {
    parts.push('x'.repeat(at - offset), text);
    offset = at + Buffer.byteLength(text);
  }
  parts.push('z'.repeat(size - Buffer.byteLength(tail) - offset), tail);
  const bytes = Buffer.from(parts.join(''));
  assert.equal(bytes.length, size);
  for (const [at, text] of markers) {
    assert.deepEqual(bytes.subarray(at, at + Buffer.byteLength(text)), Buffer.from(text));
  }
  assert.notEqual(sha256(bytes), sha256(JSON.stringify(JSON.parse(bytes.toString('utf8')))));
  return bytes;
}

function recoverInChild(bytes) {
  const artifact = {id:'0123456789abcdef0123456789abcdef', bytes:bytes.length, complete:true, sha256:sha256(bytes)};
  const receipt = mcp({spilled:true, format:'mcp_tool_result_json', artifact});
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...flags, join(__dirname, 'fixtures', 'output-memory-child.cjs')],
      {stdio:['pipe','pipe','pipe'], env:{...process.env, NODE_OPTIONS:''}});
    const requests = [], timers = new Set();
    let stderr = '', final, failure, active = 0, maximum = 0, lossyPages = 0;
    const abort = error => {failure ??= error; child.kill();};
    const deadline = setTimeout(() => abort(new Error('Bounded child timed out')), 15000);
    child.on('error', abort);
    child.stdin.on('error', abort);
    child.stderr.on('data', data => {stderr = (stderr + data.toString()).slice(-8192);});
    const lines = readline.createInterface({input:child.stdout, crlfDelay:Infinity});
    lines.on('line', line => {
      try {
        const frame = JSON.parse(line);
        if (frame.type !== 'call') {
          assert.equal(final, undefined);
          final = frame;
          return;
        }
        const request = frame.request, args = request.arguments;
        assert.equal(request.op, 'call');
        assert.equal(request.client_id, 'fixture');
        assert.equal(request.name, 'ssmcp.output.read');
        assert.deepEqual(Object.keys(args).sort(), ['id','max_bytes','offset']);
        assert.equal(args.id, artifact.id);
        assert.equal(args.max_bytes, 32768);
        assert.equal(args.offset, requests.length * 32768);
        requests.push(args);
        maximum = Math.max(maximum, ++active);
        assert.ok(active <= 4, 'At most four output page calls may overlap');
        // The unrestricted parent owns the full fixture. The child only receives native-shaped pages.
        const timer = setTimeout(() => {
          timers.delete(timer);
          const part = bytes.subarray(args.offset, args.offset + args.max_bytes);
          const text = part.toString('utf8');
          if (text.includes('\ufffd')) lossyPages++;
          const page = {id:artifact.id, path:null, storage:'memory', offset:args.offset,
            next_offset:args.offset + part.length, bytes:part.length, size:bytes.length,
            eof:args.offset + part.length === bytes.length, complete:true,
            observed_bytes:bytes.length, truncated:false,
            data_base64:part.toString('base64'), text, sha256:sha256(part), sha256_scope:'returned_chunk'};
          active--;
          child.stdin.write(JSON.stringify({type:'reply', id:frame.id, ok:true, value:mcp(page)}) + '\n');
        }, 5);
        timers.add(timer);
      } catch (error) { abort(error); }
    });
    child.on('close', (code, signal) => {
      clearTimeout(deadline);
      for (const timer of timers) clearTimeout(timer);
      lines.close();
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`Child exited ${code}, signal ${signal}\n${stderr}`));
      try {
        assert.equal(final?.type, 'result', JSON.stringify(final));
        assert.equal(active, 0);
        resolve({final, requests, maximum, lossyPages, artifact});
      } catch (error) { reject(error); }
    });
    child.stdin.write(JSON.stringify({type:'run', source, client_id:'fixture', receipt}) + '\n');
  });
}

for (const [name, fixture, pages, unicode] of [
  ['436974-byte binary MCP', binaryFixture, 14, false],
  ['480-KiB noncanonical Unicode MCP', unicodeFixture, 15, true],
]) {
  test(`saved output recovers ${name} in a 32-MiB child`, {timeout:20000}, async () => {
    const bytes = fixture(), expected = JSON.parse(bytes.toString('utf8'));
    const {final, requests, maximum, lossyPages, artifact} = await recoverInChild(bytes);
    const {recovered_output, ...actual} = final.result;
    assert.deepEqual(actual, expected, 'Every original MCP field, including isError, must survive');
    assert.deepEqual(final.forbidden, Array(6).fill('undefined'));
    assert.deepEqual(final.digests, [{bytes:bytes.length, sha256:sha256(bytes)}], 'Hash the original UTF-8 bytes');
    assert.deepEqual(recovered_output, {artifact, complete:true, next_offset:bytes.length, pages});
    assert.equal(requests.length, pages);
    assert.ok(maximum >= 1 && maximum <= 4);
    if (unicode) assert.ok(lossyPages >= 2, 'Native text previews split Unicode; recovery must use base64');
  });
}
