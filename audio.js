// Захват микрофона, приведение к 16 кГц, нарезка по паузам (простой VAD по энергии), WAV.

export class Resampler {
  constructor(inRate, outRate = 16000) { this.r = inRate / outRate; this.sum = 0; this.n = 0; this.t = 0; }
  process(x) {
    const out = new Float32Array(Math.ceil(x.length / this.r) + 2);
    let k = 0;
    for (let i = 0; i < x.length; i++) {
      this.sum += x[i]; this.n++; this.t += 1;
      if (this.t >= this.r) { out[k++] = this.sum / this.n; this.sum = 0; this.n = 0; this.t -= this.r; }
    }
    return out.subarray(0, k);
  }
}

const FRAME = 320; // 20 мс при 16 кГц

export class Segmenter {
  constructor({ minSec = 3, maxSec = 12, silenceMs = 500 } = {}, emit) {
    this.minF = minSec * 50; this.maxF = maxSec * 50; this.silF = Math.round(silenceMs / 20);
    this.emit = emit;
    this.left = new Float32Array(0);
    this.frames = []; this.en = []; this.sp = [];
    this.nf = null; this.silRun = 0; this.offset = 0; // offset — номер первого кадра буфера
    this.level = 0;
  }
  push(x) {
    let buf = x;
    if (this.left.length) { buf = new Float32Array(this.left.length + x.length); buf.set(this.left); buf.set(x, this.left.length); }
    let i = 0;
    for (; i + FRAME <= buf.length; i += FRAME) this.frame(buf.slice(i, i + FRAME));
    this.left = buf.slice(i);
  }
  frame(f) {
    let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i];
    const rms = Math.sqrt(s / f.length);
    this.level = rms;
    if (this.nf === null) this.nf = Math.max(rms, 0.0008);
    // трекер уровня фона: быстро вниз, медленно вверх
    this.nf = rms < this.nf ? this.nf * 0.7 + rms * 0.3 : this.nf * 1.003;
    this.nf = Math.max(this.nf, 0.0008);
    const speech = rms > Math.max(this.nf * 3, 0.006);
    this.frames.push(f); this.en.push(rms); this.sp.push(speech ? 1 : 0);
    this.silRun = speech ? 0 : this.silRun + 1;

    const hasSpeech = this.speechCount() > 0;
    if (!hasSpeech) {
      // держим только 0,3 с тишины перед речью
      while (this.frames.length > 15) this.drop(1);
      return;
    }
    const n = this.frames.length;
    if ((n >= this.minF && this.silRun >= this.silF) || (n >= this.maxF * 0.7 && this.silRun >= 12)) {
      this.cut(n - Math.floor(this.silRun / 2));
    } else if (n >= this.maxF) {
      let mi = n - 1, mv = Infinity;
      for (let i = Math.max(0, n - 150); i < n; i++) if (this.en[i] < mv) { mv = this.en[i]; mi = i; }
      this.cut(mi + 1);
    }
  }
  speechCount() { let c = 0; for (const v of this.sp) c += v; return c; }
  drop(k) { this.frames.splice(0, k); this.en.splice(0, k); this.sp.splice(0, k); this.offset += k; }
  cut(k) {
    k = Math.max(1, Math.min(k, this.frames.length));
    const fr = this.frames.slice(0, k);
    let speech = 0; for (let i = 0; i < k; i++) speech += this.sp[i];
    const start = this.offset;
    this.drop(k);
    if (speech >= 10) { // хотя бы 0,2 с речи, иначе это шум
      const a = new Float32Array(fr.length * FRAME);
      fr.forEach((f, i) => a.set(f, i * FRAME));
      this.emit(a, { startSec: start / 50, speechSec: speech / 50 });
    }
  }
  flush() {
    if (this.left.length) { const f = new Float32Array(FRAME); f.set(this.left); this.left = new Float32Array(0); this.frames.push(f); this.en.push(0); this.sp.push(0); }
    if (this.frames.length) this.cut(this.frames.length);
  }
}

const WORKLET = `class Cap extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(2048);this.n=0}
process(inp){const c=inp[0]&&inp[0][0];if(c){for(let i=0;i<c.length;i++){this.b[this.n++]=c[i];if(this.n===2048){this.port.postMessage(this.b.slice(0));this.n=0}}}return true}}
registerProcessor('cap',Cap)`;

export class Recorder {
  async start({ onSegment, segOpts, log = () => {} }) {
    log('запись: запрос микрофона');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    log('запись: микрофон получен');
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    await this.ctx.resume();
    log(`запись: аудио ${this.ctx.sampleRate} Гц`);
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    this.src = this.ctx.createMediaStreamSource(this.stream);
    log('запись: обработчик звука загружен');
    this.node = new AudioWorkletNode(this.ctx, 'cap');
    const mute = this.ctx.createGain(); mute.gain.value = 0;
    this.src.connect(this.node); this.node.connect(mute); mute.connect(this.ctx.destination);
    this.rs = new Resampler(this.ctx.sampleRate, 16000);
    this.seg = new Segmenter(segOpts, onSegment);
    this.chunks = []; this.samples = 0;
    let first = true;
    this.node.port.onmessage = (e) => {
      if (first) { first = false; log('запись: звук идёт'); }
      const y = this.rs.process(e.data);
      this.chunks.push(y); this.samples += y.length;
      this.seg.push(y);
    };
    this.t0 = Date.now();
  }
  get level() { return this.seg ? this.seg.level : 0; }
  // новые сэмплы с прошлого вызова — для автосохранения записи кусками
  takeNew() {
    const from = this.taken || 0, arr = this.chunks.slice(from);
    this.taken = this.chunks.length;
    let n = 0; for (const c of arr) n += c.length;
    const out = new Float32Array(n); let o = 0;
    for (const c of arr) { out.set(c, o); o += c.length; }
    return out;
  }
  get seconds() { return this.samples / 16000; }
  async stop() {
    try { this.node.port.onmessage = null; this.src.disconnect(); this.node.disconnect(); } catch {}
    this.stream.getTracks().forEach((t) => t.stop());
    try { await this.ctx.close(); } catch {}
    this.seg.flush();
    const all = new Float32Array(this.samples);
    let o = 0; for (const c of this.chunks) { all.set(c, o); o += c.length; }
    this.chunks = [];
    return all;
  }
}

export function encodeWav(pcm, rate = 16000) {
  const b = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([b], { type: 'audio/wav' });
}

export async function decodeWav(blob) {
  const v = new DataView(await blob.arrayBuffer());
  const n = (v.byteLength - 44) / 2, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = v.getInt16(44 + i * 2, true) / 0x8000;
  return out;
}

// Нарезка уже записанного аудио (для перераспознавания)
export function segmentAll(pcm, segOpts) {
  const segs = [];
  const s = new Segmenter(segOpts, (a, meta) => segs.push({ a, meta }));
  for (let i = 0; i < pcm.length; i += 4096) s.push(pcm.subarray(i, i + 4096));
  s.flush();
  return segs;
}
