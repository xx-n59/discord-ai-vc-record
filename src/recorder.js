import { performance } from 'node:perf_hooks';
import { pipeline } from 'node:stream/promises';
import prism from 'prism-media';
import { EndBehaviorType } from '@discordjs/voice';
import { ChunkWriter } from './audio.js';
import { saveSession } from './storage.js';

export class Recorder {
  constructor(connection, session, config, getUser, onFailure) {
    Object.assign(this, { connection, session, config, getUser, onFailure });
    this.active = new Map(); this.jobs = new Set(); this.stopping = false;
    this.bytes = 0; this.sequence = 0; this.epoch = performance.now();
    this.onSpeaking = userId => {
      try { this.subscribe(userId); }
      catch (error) { this.onFailure(error); }
    };
    connection.receiver.speaking.on('start', this.onSpeaking);
    // Capture users who were already speaking as the connection became ready.
    for (const userId of connection.receiver.speaking.users.keys()) this.onSpeaking(userId);
  }
  subscribe(userId) {
    if (this.stopping || this.active.has(userId)) return;
    const user = this.getUser(userId);
    if (user?.bot) return;
    this.session.participants[userId] = user?.name || userId;
    const source = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    this.active.set(userId, source);
    source.once('close', () => {
      if (this.active.get(userId) === source) this.active.delete(userId);
    });
    const writer = new ChunkWriter({
      dir: this.session.dir, userId, offsetMs: performance.now() - this.epoch,
      nextId: () => ++this.sequence,
      onBytes: bytes => {
        this.bytes += bytes;
        if (this.bytes > this.config.maxBytes) throw new Error('録音サイズが設定上限に達しました。');
      },
      onChunk: segment => { this.session.segments.push(segment); saveSession(this.session); },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const job = pipeline(source, decoder, writer).catch(error => {
      this.session.warnings.push('音声受信または保存中にエラーがあり、一部が欠落している可能性があります。');
      saveSession(this.session);
      if (!this.stopping) this.onFailure(error);
    }).finally(() => this.jobs.delete(job));
    this.jobs.add(job);
  }
  stop() {
    this.stopPromise ||= this.finish();
    return this.stopPromise;
  }
  async finish() {
    this.stopping = true;
    this.connection.receiver.speaking.off('start', this.onSpeaking);
    for (const [userId, source] of this.active) {
      this.connection.receiver.subscriptions?.delete(userId);
      source.push(null);
    }
    await Promise.all([...this.jobs]);
    this.session.endedAt = new Date().toISOString();
    this.session.status = 'recorded';
    saveSession(this.session);
  }
}
