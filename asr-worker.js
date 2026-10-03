// Распознавание речи прямо на устройстве: Whisper через transformers.js (WebGPU или WebAssembly).
// Никаких внешних API: модель скачивается один раз с Hugging Face и дальше лежит в кэше браузера.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';

env.allowLocalModels = false;
env.useBrowserCache = true;

const CANDIDATES = {
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
  return { encoder_model: 'q8', decoder_model_merged: 'q8' };
}

let asr = null;
let loaded = null; // {model, device}
let chain = Promise.resolve();

async function webgpuInfo() {
  try {
    if (!self.navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    return { f16: adapter.features.has('shader-f16') };
  } catch { return null; }
}

async function load({ model, device }) {
  if (loaded && loaded.model === model && (device === 'auto' || loaded.device === device)) {
    postMessage({ type: 'ready', ...loaded, cached: true });
    return;
  }
  if (asr) { try { await asr.dispose(); } catch {} asr = null; loaded = null; }

  const gpu = await webgpuInfo();
  let devices = device === 'auto' ? (gpu ? ['webgpu', 'wasm'] : ['wasm']) : [device];
  const files = {};
  const errors = [];
  const t0 = performance.now();

  for (const dev of devices) {
    for (const c of CANDIDATES[model]) {
      try {
        postMessage({ type: 'status', text: `Загрузка ${c.id} (${dev})…` });
        asr = await pipeline('automatic-speech-recognition', c.id, {
          device: dev,
          dtype: dtypeFor(c.kind, dev, gpu?.f16),
          progress_callback: (p) => {
            if (p.status === 'progress' && p.total) {
              files[p.file] = { loaded: p.loaded, total: p.total };
              let l = 0, t = 0;
              for (const f of Object.values(files)) { l += f.loaded; t += f.total; }
              postMessage({ type: 'progress', loaded: l, total: t });
            }
          },
        });
        // Прогрев: первый прогон компилирует шейдеры
        postMessage({ type: 'status', text: 'Подготовка модели…' });
        await asr(new Float32Array(16000), { language: 'russian', task: 'transcribe' });
        loaded = { model, device: dev, repo: c.id };
        postMessage({ type: 'ready', ...loaded, loadMs: Math.round(performance.now() - t0) });
        return;
      } catch (e) {
        errors.push(`${c.id}/${dev}: ${e?.message || e}`);
        if (asr) { try { await asr.dispose(); } catch {} asr = null; }
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
    if (audio.length > 16000 * 29) { opts.chunk_length_s = 30; opts.stride_length_s = 5; }
    const out = await asr(audio, opts);
    postMessage({ type: 'result', id, text: (out?.text || '').trim(), ms: Math.round(performance.now() - t0), dur: audio.length / 16000 });
  } catch (e) {
    postMessage({ type: 'result', id, error: String(e?.message || e) });
  }
}

self.onmessage = (e) => {
  const m = e.data;
  // Строго по очереди: одна задача за раз
  if (m.type === 'load') chain = chain.then(() => load(m));
  else if (m.type === 'run') chain = chain.then(() => run(m));
};
postMessage({ type: 'boot' });
