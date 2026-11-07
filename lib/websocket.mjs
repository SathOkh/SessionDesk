import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 32 * 1024 * 1024;

// The CLI proxy forwards bytes, not messages. The Unix control socket uses
// RFC 6455, including HTTP Upgrade and masked client frames.
export class ProxyWebSocket extends EventEmitter {
  constructor(input, output, timeout = 12000) {
    super();
    Object.assign(this, { input, output, timeout });
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentSize = 0;
    this.open = false;
    this.stopped = false;
    this.onData = chunk => {
      try { this.receive(chunk); } catch (error) { this.abort(error); this.emit('error', error); }
    };
    input.on('data', this.onData);
  }

  start() {
    this.key = randomBytes(16).toString('base64');
    this.expectedAccept = createHash('sha1').update(this.key + GUID).digest('base64');
    return new Promise((resolve, reject) => {
      this.resolveUpgrade = resolve;
      this.rejectUpgrade = reject;
      this.timer = setTimeout(() => this.abort(new Error('Codex timed out: WebSocket handshake')), this.timeout);
      this.output.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
  }

  receive(chunk) {
    if (this.stopped) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.open) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (this.buffer.length > 16384) throw new Error('Invalid Codex WebSocket handshake: header too large');
        return;
      }
      const lines = this.buffer.subarray(0, end).toString('latin1').split('\r\n');
      const status = lines.shift();
      const headers = new Map(lines.map(line => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
      }));
      if (!/^HTTP\/1\.[01] 101\b/.test(status)) throw new Error(`Codex WebSocket upgrade rejected: ${status}`);
      if (headers.get('sec-websocket-accept') !== this.expectedAccept
        || headers.get('upgrade')?.toLowerCase() !== 'websocket'
        || !headers.get('connection')?.toLowerCase().split(/\s*,\s*/).includes('upgrade')) {
        throw new Error('Invalid Codex WebSocket handshake response');
      }
      this.buffer = this.buffer.subarray(end + 4);
      clearTimeout(this.timer);
      this.open = true;
      this.resolveUpgrade();
      this.rejectUpgrade = null;
    }
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      if (first & 0x70 || second & 0x80) throw new Error('Invalid Codex WebSocket frame');
      let size = second & 0x7f;
      let offset = 2;
      if (size === 126) {
        if (this.buffer.length < 4) return;
        size = this.buffer.readUInt16BE(2); offset = 4;
      } else if (size === 127) {
        if (this.buffer.length < 10) return;
        const large = this.buffer.readBigUInt64BE(2);
        if (large > BigInt(MAX_MESSAGE)) throw new Error('Codex WebSocket message exceeds 32 MB');
        size = Number(large); offset = 10;
      }
      if (size > MAX_MESSAGE) throw new Error('Codex WebSocket message exceeds 32 MB');
      if (opcode >= 8 && (!final || size > 125)) throw new Error('Invalid Codex WebSocket control frame');
      if (this.buffer.length < offset + size) return;
      const payload = this.buffer.subarray(offset, offset + size);
      this.buffer = this.buffer.subarray(offset + size);
      if (opcode === 8) {
        this.writeFrame(payload, 8);
        throw new Error('Codex closed the WebSocket connection');
      }
      if (opcode === 9) { this.writeFrame(payload, 10); continue; }
      if (opcode === 10) continue;
      if (opcode !== 0 && opcode !== 1) throw new Error('Unsupported Codex WebSocket frame');
      if (opcode === 0 && !this.fragments.length) throw new Error('Unexpected Codex WebSocket continuation');
      if (opcode === 1 && this.fragments.length) throw new Error('Unexpected Codex WebSocket text frame');
      this.fragmentSize += size;
      if (this.fragmentSize > MAX_MESSAGE) throw new Error('Codex WebSocket message exceeds 32 MB');
      this.fragments.push(payload);
      if (final) {
        const message = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = []; this.fragmentSize = 0;
        this.emit('message', message);
      }
    }
  }

  send(message) {
    if (!this.open || this.stopped) throw new Error('Codex WebSocket is not connected');
    this.writeFrame(Buffer.from(message));
  }

  writeFrame(payload, opcode = 1) {
    const extended = payload.length < 126 ? 0 : payload.length <= 65535 ? 2 : 8;
    const header = Buffer.alloc(2 + extended + 4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | (extended === 0 ? payload.length : extended === 2 ? 126 : 127);
    if (extended === 2) header.writeUInt16BE(payload.length, 2);
    if (extended === 8) header.writeBigUInt64BE(BigInt(payload.length), 2);
    const mask = randomBytes(4);
    mask.copy(header, 2 + extended);
    const encoded = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) encoded[i] = payload[i] ^ mask[i % 4];
    this.output.write(Buffer.concat([header, encoded]));
  }

  abort(error = new Error('Connection closed')) {
    this.stopped = true;
    this.open = false;
    clearTimeout(this.timer);
    this.input.off('data', this.onData);
    this.rejectUpgrade?.(error);
    this.rejectUpgrade = null;
  }
}
