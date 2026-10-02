import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

export const RATE = 48000;
export const CHUNK_SECONDS = 60;
export function wavHeader(bytes) {
  const b = Buffer.alloc(44);
  b.write('RIFF'); b.writeUInt32LE(bytes + 36, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40);
  return b;
}
export function stereoToMono(pcm) {
  if (pcm.length % 4) throw new Error('PCMフレームのサイズが不正です。');
  const mono = Buffer.allocUnsafe(pcm.length / 2);
  for (let i = 0; i < pcm.length; i += 4) {
    mono.writeInt16LE(Math.round((pcm.readInt16LE(i) + pcm.readInt16LE(i + 2)) / 2), i / 2);
  }
  return mono;
}

// One writer per speaking interval. Write to disk incrementally, never buffer a meeting.
export class ChunkWriter extends Writable {
  constructor({ dir, userId, offsetMs, nextId, onChunk, onBytes, chunkSeconds = CHUNK_SECONDS }) {
    super();
    Object.assign(this, { dir, userId, offsetMs, nextId, onChunk, onBytes });
    this.limit = Math.floor(chunkSeconds * RATE) * 2;
    this.totalBytes = 0;
    this.bytes = 0;
    this.fd = null;
  }
  openChunk() {
    const id = this.nextId();
    this.segment = { id, userId: this.userId, offsetMs: this.offsetMs + this.totalBytes / (RATE * 2) * 1000,
      file: `audio/${String(id).padStart(6, '0')}-${this.userId}.wav` };
    this.fd = fs.openSync(path.join(this.dir, this.segment.file), 'w', 0o600);
    fs.writeSync(this.fd, wavHeader(0));
    this.bytes = 0;
  }
  closeChunk() {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    try { fs.writeSync(fd, wavHeader(this.bytes), 0, 44, 0); }
    finally { fs.closeSync(fd); }
    if (this.bytes > 0) this.onChunk({ ...this.segment, durationMs: this.bytes / (RATE * 2) * 1000 });
  }
  _write(pcm, encoding, done) {
    try {
      const mono = stereoToMono(pcm);
      this.onBytes(mono.length);
      for (let offset = 0; offset < mono.length;) {
        if (this.fd === null) this.openChunk();
        const count = Math.min(mono.length - offset, this.limit - this.bytes);
        fs.writeSync(this.fd, mono, offset, count);
        this.bytes += count; this.totalBytes += count; offset += count;
        if (this.bytes === this.limit) this.closeChunk();
      }
      done();
    } catch (error) { done(error); }
  }
  _final(done) {
    try { this.closeChunk(); done(); } catch (error) { done(error); }
  }
  _destroy(error, done) {
    try { this.closeChunk(); done(error); } catch (closeError) { done(error || closeError); }
  }
}
