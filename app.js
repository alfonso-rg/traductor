'use strict';

// ── Language definitions ──────────────────────────────────────────────────────
const LANGUAGES = [
  { code: 'es', label: '🇪🇸 Español',    name: 'Spanish'    },
  { code: 'en', label: '🇬🇧 English',    name: 'English'    },
  { code: 'fr', label: '🇫🇷 Français',   name: 'French'     },
  { code: 'de', label: '🇩🇪 Deutsch',    name: 'German'     },
  { code: 'it', label: '🇮🇹 Italiano',   name: 'Italian'    },
  { code: 'pt', label: '🇵🇹 Português',  name: 'Portuguese' },
  { code: 'ja', label: '🇯🇵 日本語',      name: 'Japanese'   },
  { code: 'zh', label: '🇨🇳 中文',        name: 'Chinese'    },
  { code: 'ar', label: '🇸🇦 عربي',        name: 'Arabic'     },
  { code: 'ko', label: '🇰🇷 한국어',      name: 'Korean'     },
];

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
  }

  async start({ apiKey, model, sourceLang, targetLang, voice }) {
    this.onStatus('connecting');

    // Step 1: Get an ephemeral session token from OpenAI
    let session;
    try {
      session = await this._createSession(apiKey, model, sourceLang, targetLang, voice);
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

    // Step 2: Set up WebRTC connection
    try {
      await this._setupWebRTC(ephemeralKey, model);
    } catch (err) {
      this.onStatus('error');
      this.onError(err.message);
      this.stop();
    }
  }

  async _createSession(apiKey, model, sourceLang, targetLang, voice) {
    const resp = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        voice,
        instructions: this._buildInstructions(sourceLang, targetLang),
        modalities: ['audio', 'text'],
        input_audio_transcription: { model: 'gpt-4o-mini-transcribe' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 200,
          silence_duration_ms: 700,
          create_response: true,
        },
      }),
    });

    if (!resp.ok) {
      let msg = `Error HTTP ${resp.status}`;
      try {
        const body = await resp.json();
        msg = body?.error?.message ?? msg;
      } catch (_) { /* ignore */ }
      throw new Error(msg);
    }

    return resp.json();
  }

  async _setupWebRTC(ephemeralKey, model) {
    this._pc = new RTCPeerConnection();

    // Play translated audio coming from OpenAI
    this._pc.ontrack = (e) => {
      const audioEl = document.getElementById('remote-audio');
      if ('srcObject' in audioEl) {
        audioEl.srcObject = e.streams[0];
      } else {
        // Legacy fallback (older iOS)
        audioEl.src = URL.createObjectURL(e.streams[0]);
      }
      // iOS requires explicit play() after srcObject assignment
      audioEl.play().catch(() => {});
    };

    // Get microphone access
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this._stream.getTracks().forEach((t) => this._pc.addTrack(t, this._stream));

    // Data channel: receives text events (transcription, translation deltas, errors)
    this._dc = this._pc.createDataChannel('oai-events');
    this._dc.onopen = () => {
      this._active = true;
      this.onStatus('listening');
    };
    this._dc.onmessage = (e) => {
      try { this._handleEvent(JSON.parse(e.data)); } catch (_) { /* ignore malformed */ }
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

    // SDP handshake with OpenAI
    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);

    const sdpResp = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ephemeralKey}`,
        'Content-Type': 'application/sdp',
      },
      body: offer.sdp,
    });

    if (!sdpResp.ok) {
      throw new Error(`Error al conectar con OpenAI Realtime (HTTP ${sdpResp.status})`);
    }

    const answerSdp = await sdpResp.text();
    await this._pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
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
        if (ev.delta) {
          this.onOutputDelta(ev.delta);
        }
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

  _buildInstructions(sourceLang, targetLang) {
    return (
      `You are a professional real-time interpreter. ` +
      `Your only task: translate spoken ${sourceLang} into ${targetLang}. ` +
      `Output ONLY the ${targetLang} translation — nothing else. ` +
      `No explanations, no commentary, no original text. ` +
      `Preserve tone and meaning exactly.`
    );
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
let sourceLangIndex = 0; // Español
let targetLangIndex = 1; // English

// Transcript model: [{input: string, output: string}]
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
  LANGUAGES.forEach((lang, i) => {
    src.add(new Option(lang.label, i));
    tgt.add(new Option(lang.label, i));
  });
  src.value = sourceLangIndex;
  tgt.value = targetLangIndex;
  src.addEventListener('change', (e) => { sourceLangIndex = +e.target.value; });
  tgt.addEventListener('change', (e) => { targetLangIndex = +e.target.value; });
}

function swapLangs() {
  const src = document.getElementById('source-lang');
  const tgt = document.getElementById('target-lang');
  const tmp = +src.value;
  src.value = +tgt.value;
  tgt.value = tmp;
  sourceLangIndex = +src.value;
  targetLangIndex = +tgt.value;
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

  const model = localStorage.getItem('openai_model') || 'gpt-4o-realtime-preview';
  const voice = localStorage.getItem('openai_voice') || 'alloy';

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
    sourceLang: LANGUAGES[sourceLangIndex].name,
    targetLang: LANGUAGES[targetLangIndex].name,
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
    // Output might have started before the transcription arrived
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
  // Remove the blinking cursor from the last output
  const cursors = document.querySelectorAll('.cursor');
  cursors.forEach((el) => el.classList.remove('cursor'));
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

  // Build/update turns efficiently using a keyed approach
  turns.forEach((turn, idx) => {
    let turnEl = container.querySelector(`[data-turn="${idx}"]`);
    if (!turnEl) {
      turnEl = document.createElement('div');
      turnEl.className = 'turn';
      turnEl.dataset.turn = idx;
      container.appendChild(turnEl);
    }

    const srcLabel = LANGUAGES[sourceLangIndex].label;
    const tgtLabel = LANGUAGES[targetLangIndex].label;
    const isLastTurn = (idx === turns.length - 1) && translator;

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
             <div class="turn-text output ${isLastTurn ? 'cursor' : ''}">${escapeHtml(turn.output)}</div>
           </div>`
        : ''}
    `;
  });

  // Auto-scroll to bottom
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Settings modal ────────────────────────────────────────────────────────────
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
  document.getElementById('input-model').value = localStorage.getItem('openai_model') || 'gpt-4o-realtime-preview';
  const voice = localStorage.getItem('openai_voice') || 'alloy';
  document.getElementById('select-voice').value = voice;
}

function saveSettings() {
  const apiKey = document.getElementById('input-apikey').value.trim();
  const model  = document.getElementById('input-model').value.trim() || 'gpt-4o-realtime-preview';
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

// Close settings on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSettings();
});
