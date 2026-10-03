// Распознавание речи прямо на устройстве: Whisper через transformers.js (WebGPU или WebAssembly).
// Никаких внешних API: модель скачивается один раз с Hugging Face и дальше лежит в кэше браузера.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';

env.allowLocalModels = false;
env.useBrowserCache = true;

const CANDIDATES = {
  tiny: [
    { id: 'onnx-community/whisper-tiny', kind: 'onnx' },
    { id: 'Xenova/whisper-tiny', kind: 'xenova' },
  ],
  base: [
    { id: 'onnx-community/whisper-base', kind: 'onnx' },
    { id: 'Xenova/whisper-base', kind: 'xenova' },
  ],
  small: [
    { id: 'onnx-community/whisper-small', kind: 'onnx' },
    { id: 'Xenova/whisper-small', kind: 'xenova' },
  ],
  medium: [
    { id: 'Xenova/whisper-medium', kind: 'xenova' },
    { id: 'onnx-community/whisper-medium', kind: 'onnx-q4' },
  ],
};

function dtypeFor(kind, device, f16) {
  if (kind === 'xenova') return 'q8';
  if (kind === 'onnx-q4') return { encoder_model: 'q4', decoder_model_merged: 'q4' };
  if (device === 'webgpu') return { encoder_model: f16 ? 'fp16' : 'fp32', decoder_model_merged: 'q4' };
  // CPU: 8-битные веса — в 2–4 раза меньше памяти, чем fp16/fp32
  return { encoder_model: 'q8', decoder_model_merged: 'q8' };
}

let asr = null;
let loaded = null;
let chain = Promise.resolve();

async function webgpuInfo() {
  try {
    if (!self.navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    return { f16: adapter.features.has('shader-f16') };
  } catch { return null; }
}

async function tryLoad(c, dev, gpu, threads, files) {
  env.backends.onnx.wasm.numThreads = threads;
  return pipeline('automatic-speech-recognition', c.id, {
    device: dev,
    dtype: dtypeFor(c.kind, dev, gpu?.f16),
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        files[p.file] = { loaded: p.loaded, total: p.total };
        let l = 0; for (const f of Object.values(files)) l += f.loaded;
        postMessage({ type: 'progress', loadedMB: l / 1e6, file: p.file.split('/').pop(), filePct: Math.round((p.loaded / p.total) * 100), fileMB: p.total / 1e6 });
      }
    },
  });
}

async function load({ model, device, threads }) {
  const key = model + '|' + device + '|' + threads;
  if (loaded && loaded.key === key) { postMessage({ type: 'ready', ...loaded, cached: true }); return; }
  if (asr) { try { await asr.dispose(); } catch {} asr = null; loaded = null; }

  const gpu = device === 'wasm' ? null : await webgpuInfo();
  const devices = device === 'auto' ? (gpu ? ['webgpu', 'wasm'] : ['wasm']) : [device];
  const errors = [];
  const t0 = performance.now();

  for (const dev of devices) {
    for (const c of CANDIDATES[model]) {
      const threadOpts = dev === 'wasm' && threads > 1 ? [threads, 1] : [1];
      for (const th of threadOpts) {
        const files = {};
        try {
          postMessage({ type: 'status', text: `Загрузка ${c.id.split('/')[1]} (${dev === 'webgpu' ? 'WebGPU' : 'CPU×' + th})…`, stage: { dev, repo: c.id } });
          asr = await tryLoad(c, dev, gpu, th, files);
          if (dev === 'webgpu') {
            postMessage({ type: 'status', text: 'Подготовка модели…' });
            await asr(new Float32Array(16000), { language: 'russian', task: 'transcribe' });
          }
          loaded = { key, model, device: dev, repo: c.id, threads: dev === 'wasm' ? th : 0 };
          postMessage({ type: 'ready', ...loaded, loadMs: Math.round(performance.now() - t0) });
          return;
        } catch (e) {
          errors.push(`${c.id}/${dev}/${th}: ${e?.message || e}`);
          if (asr) { try { await asr.dispose(); } catch {} asr = null; }
        }
      }
    }
  }
  postMessage({ type: 'error', text: 'Не удалось загрузить модель. ' + errors.join(' | ') });
}

const LANG = { ru: 'russian', en: 'english', auto: null };

async function run({ id, audio, language }) {
  if (!asr) { postMessage({ type: 'result', id, error: 'model_not_loaded' }); return; }
  const t0 = performance.now();
  try {
    const opts = { task: 'transcribe' };
    if (LANG[language]) opts.language = LANG[language];
    const sec = audio.length / 16000;
    if (sec > 29) { opts.chunk_length_s = 30; opts.stride_length_s = 5; }
    else {
      // Предел длины ответа: на тишине/шуме Whisper иногда зацикливается и генерирует сотни токенов
      opts.max_new_tokens = Math.min(400, Math.ceil(sec * 7) + 16);
      // Пульс из распознавания: в журнале видно, дошло ли до текста и сколько токенов выдано
      let toks = 0;
      opts.streamer = {
        put() {
          toks++;
          if (toks === 1) postMessage({ type: 'trace', text: `первый шаг через ${((performance.now() - t0) / 1000).toFixed(1)} с` });
          else if (toks % 8 === 0) postMessage({ type: 'trace', text: `токенов ${toks} (${((performance.now() - t0) / 1000).toFixed(1)} с)`, replace: 'распознавание: токенов' });
        },
        end() {},
      };
    }
    const out = await asr(audio, opts);
    postMessage({ type: 'result', id, text: (out?.text || '').trim(), ms: Math.round(performance.now() - t0), dur: audio.length / 16000 });
  } catch (e) {
    postMessage({ type: 'result', id, error: String(e?.message || e) });
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') chain = chain.then(() => load(m));
  else if (m.type === 'run') chain = chain.then(() => run(m));
};
postMessage({ type: 'boot', isolated: self.crossOriginIsolated === true });
