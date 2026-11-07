import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexClient } from '../lib/codex.mjs';
import { transport, respond, serverFrame } from './wire-fixture.mjs';

test('WebSocket consumes split frames, fragmented messages and ping between fragments', async t => {
  const child = transport((request, process) => {
    if (request.method === 'initialize') respond(process, request, {});
    if (request.method === 'large') {
      const text = JSON.stringify({ id: request.id, result: { text: 'a'.repeat(70000) } });
      const first = serverFrame(text.slice(0, 20), { final: false });
      const ping = serverFrame('ping', { opcode: 9 });
      const last = serverFrame(text.slice(20), { opcode: 0 });
      const combined = Buffer.concat([first, ping, last]);
      for (let i = 0; i < combined.length; i += 17) process.stdout.write(combined.subarray(i, i + 17));
    }
  });
  const client = new CodexClient({ spawnProcess: () => child });
  t.after(() => client.close());
  await client.connect();
  assert.equal((await client.request('large')).text.length, 70000);
  assert.equal(child.controls[0].opcode, 10);
  assert.equal(child.controls[0].body.toString(), 'ping');
});

test('client frames use correct masking and lengths for small, medium and large requests', async t => {
  const child = transport((request, process) => {
    if (request.id !== undefined) respond(process, request, request.params);
  });
  const client = new CodexClient({ spawnProcess: () => child });
  t.after(() => client.close());
  await client.connect();
  for (const length of [1, 1000, 70000]) {
    const result = await client.request('echo', { text: 'x'.repeat(length) });
    assert.equal(result.text.length, length);
  }
});

test('WebSocket upgrade failures and timeout are explicit and clean up proxy', async () => {
  for (const [options, expected] of [[{ accept: false }, /Invalid Codex WebSocket handshake/], [{ upgrade: false }, /timed out: WebSocket handshake/]]) {
    const child = transport(() => {}, options);
    const client = new CodexClient({ spawnProcess: () => child, timeout: 20 });
    await assert.rejects(client.connect(), expected);
    assert.equal(child.killed, true);
    assert.equal(client.ready, false);
    client.close();
  }
});

test('WebSocket close rejects outstanding RPC instead of waiting for timeout', async t => {
  const child = transport((request, process) => {
    if (request.method === 'initialize') respond(process, request, {});
    if (request.method === 'wait') process.stdout.write(serverFrame(Buffer.alloc(0), { opcode: 8 }));
  });
  const client = new CodexClient({ spawnProcess: () => child });
  t.after(() => client.close());
  await client.connect();
  await assert.rejects(client.request('wait'), /closed the WebSocket/);
  assert.equal(client.ready, false);
});
