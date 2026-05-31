'use strict';

// ── Language definitions ──────────────────────────────────────────────────────

// Source languages (display only — gpt-realtime-translate auto-detects input)
const SOURCE_LANGUAGES = [
  { code: 'es', label: '🇪🇸 Español'    },
  { code: 'en', label: '🇬🇧 English'    },
  { code: 'fr', label: '🇫🇷 Français'   },
  { code: 'de', label: '🇩🇪 Deutsch'    },
  { code: 'it', label: '🇮🇹 Italiano'   },
  { code: 'pt', label: '🇵🇹 Português'  },
  { code: 'ja', label: '🇯🇵 日本語'      },
  { code: 'zh', label: '🇨🇳 中文'        },
  { code: 'ar', label: '🇸🇦 عربي'        },
  { code: 'ko', label: '🇰🇷 한국어'      },
];

// Target languages — the 13 supported by gpt-realtime-translate
// apiValue is what the API expects for output_language
const TARGET_LANGUAGES = [
  { code: 'en', label: '🇬🇧 English',    apiValue: 'english'    },
  { code: 'es', label: '🇪🇸 Español',    apiValue: 'spanish'    },
  { code: 'pt', label: '🇵🇹 Português',  apiValue: 'portuguese' },
  { code: 'fr', label: '🇫🇷 Français',   apiValue: 'french'     },
  { code: 'de', label: '🇩🇪 Deutsch',    apiValue: 'german'     },
  { code: 'it', label: '🇮🇹 Italiano',   apiValue: 'italian'    },
  { code: 'ja', label: '🇯🇵 日本語',      apiValue: 'japanese'   },
  { code: 'zh', label: '🇨🇳 中文',        apiValue: 'chinese'    },
  { code: 'ko', label: '🇰🇷 한국어',      apiValue: 'korean'     },
  { code: 'ru', label: '🇷🇺 Русский',    apiValue: 'russian'    },
  { code: 'hi', label: '🇮🇳 हिन्दी',      apiValue: 'hindi'      },
  { code: 'id', label: '🇮🇩 Indonesia',  apiValue: 'indonesian' },
  { code: 'vi', label: '🇻🇳 Tiếng Việt', apiValue: 'vietnamese' },
];

const TRANSLATION_MODEL = 'gpt-realtime-translate';

// ── RealtimeTranslator ────────────────────────────────────────────────────────
class RealtimeTranslator {
  constructor({ onStatus, onInputTranscript, onOutputDelta, onOutputDone, onError }) {
    this.onStatus = onStatus;
    this.onInputTranscript = onInputTranscript;
    this.onOutputDelta = onOutputDelta;
    this.onOutputDone = onOutputDone;
    this.onError = onError;

    this._pc = null;
    this._dc = null;
    this._stream = null;
    this._active = false;
    this._model = null;
  }

  async start({ apiKey, model, targetLangApiValue, voice }) {
    this._model = model;
    this.onStatus('connecting');

    let session;
    try {
      session = await this._createSession(apiKey, model, targetLangApiValue, voice);
    } catch (err) {
      this.onStatus('error');
      this.onError(err.message);
      return;
    }

    const ephemeralKey = session.client_secret?.value;
    if (!ephemeralKey) {
      this.onStatus('error');
      this.onError('No se pudo obtener la clave de sesión de OpenAI.');
      return;
    }

    try {
      await this._setupWebRTC(ephemeralKey, model);
    } catch (err) {
      this.onStatus('error');
      this.onError(err.message);
      this.stop();
    }
  }

  _isTranslationModel(model) {
    return model === TRANSLATION_MODEL;
  }

  async _createSession(apiKey, model, targetLangApiValue, voice) {
    let endpoint, body;

    if (this._isTranslationModel(model)) {
      // New dedicated translation endpoint — no instructions, no voice
      endpoint = 'https://api.openai.com/v1/realtime/translations/client_secrets';
      body = {
        model,
        output_language: targetLangApiValue,
        input_audio_transcription: { model: 'gpt-realtime-whisper' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 200,
          silence_duration_ms: 700,
          create_response: true,
        },
      };
    } else {
      // Legacy gpt-4o-realtime-preview approach
      endpoint = 'https://api.openai.com/v1/realtime/sessions';
      body = {
        model,
        voice: voice || 'alloy',
        instructions:
          `You are a professional real-time interpreter. ` +
          `Translate everything spoken into ${targetLangApiValue}. ` +
          `Output ONLY the translation — no explanations, no original text.`,
        modalities: ['audio', 'text'],
        input_audio_transcription: { model: 'gpt-4o-mini-transcribe' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 200,
          silence_duration_ms: 700,
          create_response: true,
        },
      };
    }

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      let msg = `Error HTTP ${resp.status}`;
      try {
        const err = await resp.json();
        msg = err?.error?.message ?? msg;
      } catch (_) { /* ignore */ }
      throw new Error(msg);
    }

    return resp.json();
  }

  async _setupWebRTC(ephemeralKey, model) {
    this._pc = new RTCPeerConnection();

    // Play translated audio from OpenAI
    this._pc.ontrack = (e) => {
      const audioEl = document.getElementById('remote-audio');
      if ('srcObject' in audioEl) {
        audioEl.srcObject = e.streams[0];
      } else {
        audioEl.src = URL.createObjectURL(e.streams[0]); // legacy iOS fallback
      }
      audioEl.play().catch(() => {});
    };

    // Microphone
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this._stream.getTracks().forEach((t) => this._pc.addTrack(t, this._stream));

    // Data channel: text events (transcription, translation deltas, errors)
    this._dc = this._pc.createDataChannel('oai-events');
    this._dc.onopen = () => {
      this._active = true;
      this.onStatus('listening');
    };
    this._dc.onmessage = (e) => {
      try { this._handleEvent(JSON.parse(e.data)); } catch (_) { /* ignore */ }
    };
    this._dc.onerror = () => {
      this.onError('Error en el canal de datos.');
      this.onStatus('error');
    };

    this._pc.oniceconnectionstatechange = () => {
      if (this._pc?.iceConnectionState === 'failed') {
        this.onError('La conexión WebRTC falló.');
        this.onStatus('error');
      }
    };

    // SDP handshake — different endpoint for translation model
    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);

    const sdpUrl = this._isTranslationModel(model)
      ? 'https://api.openai.com/v1/realtime/translations/calls'
      : `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

    const sdpResp = await fetch(sdpUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ephemeralKey}`,
        'Content-Type': 'application/sdp',
      },
      body: offer.sdp,
    });

    if (!sdpResp.ok) {
      throw new Error(`Error al conectar con OpenAI (HTTP ${sdpResp.status})`);
    }

    await this._pc.setRemoteDescription({ type: 'answer', sdp: await sdpResp.text() });
  }

  _handleEvent(ev) {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.onStatus('listening');
        break;

      case 'input_audio_buffer.speech_stopped':
        this.onStatus('translating');
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript?.trim()) {
          this.onInputTranscript(ev.transcript.trim());
        }
        break;

      case 'response.text.delta':
        if (ev.delta) this.onOutputDelta(ev.delta);
        break;

      case 'response.done':
        this.onOutputDone();
        if (this._active) this.onStatus('listening');
        break;

      case 'error':
        this.onError(ev.error?.message ?? 'Error desconocido');
        break;
    }
  }

  stop() {
    this._active = false;
    this._stream?.getTracks().forEach((t) => t.stop());
    this._dc?.close();
    this._pc?.close();
    this._dc = null;
    this._pc = null;
    this._stream = null;
  }
}

// ── App state ─────────────────────────────────────────────────────────────────
let translator = null;
let sourceLangIndex = 0; // Español (display only, auto-detected by model)
let targetLangIndex = 0; // English

let turns = [];
let currentTurn = null;

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  populateLangSelects();
  loadSettings();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});

function populateLangSelects() {
  const src = document.getElementById('source-lang');
  const tgt = document.getElementById('target-lang');

  SOURCE_LANGUAGES.forEach((lang, i) => src.add(new Option(lang.label, i)));
  TARGET_LANGUAGES.forEach((lang, i) => tgt.add(new Option(lang.label, i)));

  src.value = sourceLangIndex;
  tgt.value = targetLangIndex;

  src.addEventListener('change', (e) => { sourceLangIndex = +e.target.value; });
  tgt.addEventListener('change', (e) => { targetLangIndex = +e.target.value; });
}

function swapLangs() {
  // Find the matching source in target list and vice versa (best effort)
  const srcCode = SOURCE_LANGUAGES[sourceLangIndex].code;
  const tgtCode = TARGET_LANGUAGES[targetLangIndex].code;

  const newSrcIdx = SOURCE_LANGUAGES.findIndex((l) => l.code === tgtCode);
  const newTgtIdx = TARGET_LANGUAGES.findIndex((l) => l.code === srcCode);

  if (newSrcIdx !== -1) {
    sourceLangIndex = newSrcIdx;
    document.getElementById('source-lang').value = newSrcIdx;
  }
  if (newTgtIdx !== -1) {
    targetLangIndex = newTgtIdx;
    document.getElementById('target-lang').value = newTgtIdx;
  }
}

// ── Translation control ───────────────────────────────────────────────────────
async function toggleTranslation() {
  if (translator) {
    stopTranslation();
  } else {
    await startTranslation();
  }
}

async function startTranslation() {
  const apiKey = localStorage.getItem('openai_api_key') || '';
  if (!apiKey) {
    showToast('Añade tu API Key en Ajustes primero.');
    openSettings();
    return;
  }

  const model = localStorage.getItem('openai_model') || TRANSLATION_MODEL;
  const voice = localStorage.getItem('openai_voice') || 'alloy';
  const targetLang = TARGET_LANGUAGES[targetLangIndex];

  document.getElementById('btn-mic').classList.add('active');
  document.getElementById('mic-hint').textContent = 'Toca para parar';
  document.getElementById('placeholder')?.remove();

  translator = new RealtimeTranslator({
    onStatus: handleStatus,
    onInputTranscript: handleInputTranscript,
    onOutputDelta: handleOutputDelta,
    onOutputDone: handleOutputDone,
    onError: handleError,
  });

  await translator.start({
    apiKey,
    model,
    targetLangApiValue: targetLang.apiValue,
    voice,
  });
}

function stopTranslation() {
  translator?.stop();
  translator = null;
  currentTurn = null;
  handleStatus('disconnected');
  document.getElementById('btn-mic').classList.remove('active');
  document.getElementById('mic-hint').textContent = 'Toca para empezar';
}

// ── Event handlers ────────────────────────────────────────────────────────────
function handleStatus(status) {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  const labels = {
    connecting:   'Conectando…',
    listening:    'Escuchando…',
    translating:  'Traduciendo…',
    disconnected: 'Pulsa para traducir',
    error:        'Error de conexión',
  };
  dot.className = `status-dot ${status}`;
  txt.className = `status-text ${status}`;
  txt.textContent = labels[status] ?? status;
}

function handleInputTranscript(text) {
  if (!currentTurn) {
    currentTurn = { input: text, output: '' };
    turns.push(currentTurn);
  } else {
    currentTurn.input = text;
  }
  renderTranscript();
}

function handleOutputDelta(delta) {
  if (!currentTurn) {
    currentTurn = { input: '', output: '' };
    turns.push(currentTurn);
  }
  currentTurn.output += delta;
  renderTranscript();
}

function handleOutputDone() {
  document.querySelectorAll('.cursor').forEach((el) => el.classList.remove('cursor'));
  currentTurn = null;
}

function handleError(msg) {
  showToast(`❌ ${msg}`);
  if (translator) {
    translator.stop();
    translator = null;
    document.getElementById('btn-mic').classList.remove('active');
    document.getElementById('mic-hint').textContent = 'Toca para empezar';
  }
}

// ── Transcript rendering ──────────────────────────────────────────────────────
function renderTranscript() {
  const container = document.getElementById('transcript');

  turns.forEach((turn, idx) => {
    let turnEl = container.querySelector(`[data-turn="${idx}"]`);
    if (!turnEl) {
      turnEl = document.createElement('div');
      turnEl.className = 'turn';
      turnEl.dataset.turn = idx;
      container.appendChild(turnEl);
    }

    const srcLabel = SOURCE_LANGUAGES[sourceLangIndex].label;
    const tgtLabel = TARGET_LANGUAGES[targetLangIndex].label;
    const isActive = (idx === turns.length - 1) && translator;

    turnEl.innerHTML = `
      ${turn.input
        ? `<div class="turn-input">
             <div class="turn-label input">${srcLabel}</div>
             <div class="turn-text">${escapeHtml(turn.input)}</div>
           </div>`
        : ''}
      ${turn.output
        ? `<div class="turn-output">
             <div class="turn-label output">${tgtLabel}</div>
             <div class="turn-text output${isActive ? ' cursor' : ''}">${escapeHtml(turn.output)}</div>
           </div>`
        : ''}
    `;
  });

  container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Settings ──────────────────────────────────────────────────────────────────
function openSettings() {
  loadSettings();
  document.getElementById('modal-settings').classList.add('open');
}

function closeSettings(e) {
  if (!e || e.target === document.getElementById('modal-settings') || !e.target.closest) {
    document.getElementById('modal-settings').classList.remove('open');
  }
}

function loadSettings() {
  document.getElementById('input-apikey').value = localStorage.getItem('openai_api_key') || '';
  document.getElementById('input-model').value  = localStorage.getItem('openai_model')   || TRANSLATION_MODEL;
  document.getElementById('select-voice').value = localStorage.getItem('openai_voice')   || 'alloy';
}

function saveSettings() {
  const apiKey = document.getElementById('input-apikey').value.trim();
  const model  = document.getElementById('input-model').value.trim() || TRANSLATION_MODEL;
  const voice  = document.getElementById('select-voice').value;

  if (apiKey && !apiKey.startsWith('sk-')) {
    showToast('La API Key debe empezar por sk-');
    return;
  }

  localStorage.setItem('openai_api_key', apiKey);
  localStorage.setItem('openai_model', model);
  localStorage.setItem('openai_voice', voice);

  closeSettings();
  showToast('Ajustes guardados ✓');
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });
