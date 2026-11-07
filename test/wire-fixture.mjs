import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import assert from 'node:assert/strict';

// Independent fake daemon: accepts the raw HTTP/WebSocket bytes forwarded by
// `codex app-server proxy`. It intentionally does not accept JSONL.
export function serverFrame(value, { opcode = 1, final = true } = {}) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const header = Buffer.alloc(body.length < 126 ? 2 : body.length <= 65535 ? 4 : 10);
  header[0] = (final ? 128 : 0) | opcode;
  header[1] = header.length === 2 ? body.length : header.length === 4 ? 126 : 127;
  if (header.length === 4) header.writeUInt16BE(body.length, 2);
  if (header.length === 10) header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

export function transport(handler, { upgrade = true, accept = true, onResponse = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  child.controls = [];
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  child.stdin = new Writable({ write(chunk, encoding, done) {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) { done(); return; }
        const header = buffer.subarray(0, end).toString();
        assert.match(header, /^GET \/ HTTP\/1.1/);
        const key = /Sec-WebSocket-Key: ([^\r]+)/i.exec(header)[1];
        const digest = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        buffer = buffer.subarray(end + 4);
        upgraded = true;
        if (upgrade) child.stdout.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept ? digest : 'invalid'}\r\n\r\n`);
      }
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15;
        assert.ok(buffer[1] & 128, 'client frames must be masked');
        let size = buffer[1] & 127;
        let offset = 2;
        if (size === 126) { if (buffer.length < 4) break; size = buffer.readUInt16BE(2); offset = 4; }
        else if (size === 127) { if (buffer.length < 10) break; size = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + 4 + size) break;
        const mask = buffer.subarray(offset, offset + 4);
        const body = Buffer.from(buffer.subarray(offset + 4, offset + 4 + size));
        for (let i = 0; i < size; i++) body[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + 4 + size);
        if (opcode === 1) {
          const message = JSON.parse(body.toString());
          if (!message.method && onResponse) onResponse(message, child);
          else handler(message, child);
        }
        else child.controls.push({ opcode, body });
      }
      done();
    } catch (error) { done(error); }
  } });
  return child;
}

export const respond = (child, request, result) => child.stdout.write(serverFrame({ id: request.id, result }));
