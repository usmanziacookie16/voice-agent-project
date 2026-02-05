const toggleButton = document.getElementById('toggleButton');
const currentSpeechDiv = document.getElementById('currentSpeech');
const agentStatus = document.getElementById('agentStatus');

let ws, audioContext, processor, source;
let isRecording = false;
let currentSpeechBubble = null;
let currentSpeechText = '';
let messageSequence = 0;

// Track if this is the first connection or a reconnection
let isFirstConnection = true;
let currentSessionId = null;
let persistentConversationId = null;
let hasHadFirstGreeting = false;
let wasPausedManually = false;

// Connection management
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 3000;
let heartbeatInterval = null;
let lastHeartbeat = Date.now();
let connectionTimeout = null;

// Web Audio API for TTS (Text-to-Speech) playback
// FIXED: Create this once and reuse it (suspend/resume) to avoid browser restrictions
let ttsAudioContext = null; 
let audioQueue = [];
let isPlayingAudio = false;
let currentAudioSource = null;

// Detect browser and show compatibility warning
function detectBrowser() {
  const userAgent = navigator.userAgent.toLowerCase();
  const isFirefox = userAgent.indexOf('firefox') > -1;
  const isSafari = userAgent.indexOf('safari') > -1 && userAgent.indexOf('chrome') === -1;
  
  if (isFirefox) {
    showBrowserWarning('You are using Firefox. Please ensure microphone permissions are granted. Click the 🔒 icon in the address bar → Permissions → Microphone → Allow.');
  } else if (isSafari) {
    showBrowserWarning('You are using Safari. Please ensure microphone permissions are granted. Go to Safari → Settings → Websites → Microphone → Allow for this website.');
  }
}

function showBrowserWarning(message) {
  const warningDiv = document.getElementById('browserWarning');
  const messageP = document.getElementById('browserMessage');
  if (warningDiv && messageP) {
    messageP.textContent = message;
    warningDiv.style.display = 'block';
  }
}

// Check browser on load
detectBrowser();

// Update UI based on recording state
function updateUI(listening) {
  if (listening) {
    toggleButton.classList.add('active');
    agentStatus.textContent = 'Listening...';
    agentStatus.classList.add('listening');
  } else {
    toggleButton.classList.remove('active');
    agentStatus.textContent = wasPausedManually ? 'Paused' : 'Ready to listen';
    agentStatus.classList.remove('listening');
  }
}

// Toggle button click handler
toggleButton.addEventListener('click', () => {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

async function startRecording() {
  if (isRecording) return;
  
  // Get username from session
  const username = sessionStorage.getItem('username');
  
  if (!username) {
    alert('Session expired. Please login again.');
    window.location.href = 'login.html';
    return;
  }
  
  console.log('Starting with username:', username);
  
  // --- AUDIO CONTEXT FIX START ---
  // Initialize or Resume TTS AudioContext IMMEDIATELY on user click.
  // This ensures the browser doesn't block audio playback later.
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  
  try {
    if (!ttsAudioContext) {
      ttsAudioContext = new AudioContextClass();
    }
    
    if (ttsAudioContext.state === 'suspended') {
      await ttsAudioContext.resume();
      console.log('✅ TTS AudioContext resumed');
    }
  } catch (e) {
    console.error('Failed to initialize/resume TTS context:', e);
  }
  // --- AUDIO CONTEXT FIX END ---

  isRecording = true;
  updateUI(true);

  // Clear welcome message if present
  const welcomeMsg = currentSpeechDiv.querySelector('.welcome-message');
  if (welcomeMsg) {
    welcomeMsg.remove();
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);

  // Connection timeout (10 seconds)
  connectionTimeout = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      console.error('❌ Connection timeout');
      ws.close();
      showStatusError('Connection timeout. Please check your internet and try again.');
      cleanup(false);
    }
  }, 10000);

  ws.onopen = async () => {
    clearTimeout(connectionTimeout);
    console.log('Connected to server');
    reconnectAttempts = 0;
    
    // Start heartbeat monitoring
    startHeartbeat();
    
    // Remove any error messages
    removeStatusError();
    
    // Generate or reuse session ID
    if (!currentSessionId) {
      currentSessionId = Date.now();
    }
    
    // Generate or reuse conversation ID (persists across manual pauses)
    if (!persistentConversationId) {
      persistentConversationId = currentSessionId;
      console.log('🆕 New conversation ID:', persistentConversationId);
    } else {
      console.log('🔄 Reusing conversation ID:', persistentConversationId);
    }
    
    // Determine if we have messages to load
    const hasMessages = wasPausedManually || (persistentConversationId !== currentSessionId);
    
    ws.send(JSON.stringify({ 
      type: "start",
      username: username,
      sessionId: currentSessionId,
      conversationId: persistentConversationId,
      isReconnection: !isFirstConnection,
      hasMessages: hasMessages
    }));
    
    // Mark that first connection has been made
    if (isFirstConnection) {
      isFirstConnection = false;
      hasHadFirstGreeting = true;
    }

    try {
      // Check if getUserMedia is supported
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Your browser does not support audio recording.');
      }

      // Request microphone access
      const constraints = {
        audio: {
          channelCount: 1,
          sampleRate: 24000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      };

      console.log('Requesting microphone access...');
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log('✅ Microphone access granted');

      // Check AudioContext support for Microphone
      if (!AudioContextClass) {
        throw new Error('Your browser does not support audio processing.');
      }

      // Create Microphone Audio Context
      // We create a new one each time to ensure clean mic stream handling
      audioContext = new AudioContextClass();
      const actualSampleRate = audioContext.sampleRate;
      console.log(`Mic sample rate: ${actualSampleRate}Hz`);
      
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      source = audioContext.createMediaStreamSource(stream);
      
      // Use ScriptProcessor
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      processor.connect(audioContext.destination);

      processor.onaudioprocess = (e) => {
        if (!isRecording || !ws || ws.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        
        // Resample to 24000Hz if needed (for OpenAI API)
        let resampledData = input;
        if (audioContext.sampleRate !== 24000) {
          resampledData = resampleAudio(input, audioContext.sampleRate, 24000);
        }
        
        const pcm16 = convertFloat32ToPCM16(resampledData);
        const base64 = arrayBufferToBase64(pcm16);
        
        try {
          ws.send(JSON.stringify({ type: "audio", audio: base64 }));
        } catch (err) {
          console.error('Error sending audio:', err);
        }
      };
    } catch (err) {
      console.error('Microphone access error:', err);
      let errorMessage = 'Could not access microphone. Please check permissions.';
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        errorMessage = 'Please allow microphone access in your browser settings.';
      }
      alert(errorMessage);
      cleanup(false);
    }
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    lastHeartbeat = Date.now();
    removeStatusError();
    
    if (msg.type !== 'assistant_audio_delta') {
      console.log('Server message:', msg.type);
    }

    if (msg.type === 'connection_ready') {
      console.log('✅ Voice agent ready');
    }

    if (msg.type === 'user_transcription') {
      console.log('User said:', msg.text);
    }

    if (msg.type === 'assistant_transcript_delta') {
      if (!currentSpeechBubble) {
        currentSpeechBubble = document.createElement('div');
        currentSpeechBubble.className = 'speech-bubble';
        
        const speechTextSpan = document.createElement('span');
        speechTextSpan.className = 'speech-text typing';
        currentSpeechBubble.appendChild(speechTextSpan);
        
        currentSpeechDiv.innerHTML = '';
        currentSpeechDiv.appendChild(currentSpeechBubble);
        currentSpeechText = '';
      }

      currentSpeechText += msg.text;
      const speechTextSpan = currentSpeechBubble.querySelector('.speech-text');
      if (speechTextSpan) {
        speechTextSpan.textContent = currentSpeechText;
      }
    }

    if (msg.type === 'assistant_transcript_complete') {
      if (currentSpeechBubble) {
        const speechTextSpan = currentSpeechBubble.querySelector('.speech-text');
        if (speechTextSpan) {
          speechTextSpan.classList.remove('typing');
          speechTextSpan.textContent = msg.text;
        }
        currentSpeechText = msg.text;
      }
      currentSpeechBubble = null;
      currentSpeechText = '';
    }

    if (msg.type === 'assistant_audio_delta') {
      playPCM16Audio(msg.audio);
    }

    if (msg.type === 'response_complete') {
      console.log('✅ Response complete');
      if (currentSpeechBubble) {
        const speechTextSpan = currentSpeechBubble.querySelector('.speech-text');
        if (speechTextSpan) {
          speechTextSpan.classList.remove('typing');
        }
      }
      currentSpeechBubble = null;
      currentSpeechText = '';
    }

    if (msg.type === 'response_interrupted') {
      console.log('⚠️ Response interrupted by user');
      stopAudioPlayback();
      
      if (currentSpeechBubble) {
        currentSpeechBubble.classList.add('interrupted');
        const speechTextSpan = currentSpeechBubble.querySelector('.speech-text');
        if (speechTextSpan) {
          speechTextSpan.classList.remove('typing');
        }
      }
    }

    if (msg.type === 'error') {
      console.error('Server error:', msg.message);
      showStatusError(msg.message);
    }
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    showStatusError('Connection error. Please try again.');
  };

  ws.onclose = () => {
    console.log('WebSocket closed');
    if (isRecording && !wasPausedManually) {
      showStatusError('Connection lost. Please check your internet.');
      cleanup(false);
    }
  };
}

function stopRecording() {
  console.log('🛑 Stop recording (manual pause)');
  wasPausedManually = true;
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ 
        type: 'stop',
        requestNewSession: false 
      }));
    } catch (err) {
      console.error('Error sending stop message:', err);
    }
  }
  cleanup(true);
}

function cleanup(isManualPause = false) {
  console.log('Cleaning up...', isManualPause ? '(manual pause)' : '(connection lost)');
  isRecording = false;
  updateUI(false);

  stopAudioPlayback();
  stopHeartbeat();
  
  if (connectionTimeout) {
    clearTimeout(connectionTimeout);
    connectionTimeout = null;
  }

  // Clean up Microphone components
  if (processor) {
    processor.disconnect();
    processor = null;
  }
  if (source) {
    source.disconnect();
    source = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close(); // We close mic context to release hardware
    audioContext = null;
  }

  // FIX: Do NOT close ttsAudioContext. Suspend it instead.
  // This allows us to resume it instantly next time without browser restrictions.
  if (ttsAudioContext && ttsAudioContext.state !== 'closed') {
    ttsAudioContext.suspend().then(() => {
      console.log('⏸️ TTS AudioContext suspended (preserved for next turn)');
    });
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  
  // Reset bubbles logic
  currentSpeechBubble = null;
  currentSpeechText = '';
}

// Heartbeat to detect connection issues
function startHeartbeat() {
  lastHeartbeat = Date.now();
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const timeSinceLastMessage = Date.now() - lastHeartbeat;
      if (timeSinceLastMessage > 30000) {
        console.warn('⚠️ No server response for 30 seconds');
        showStatusError('Connection may be unstable...');
      }
    }
  }, 5000);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

function showStatusError(message) {
  agentStatus.textContent = `⚠️ ${message}`;
  agentStatus.classList.add('error');
  agentStatus.classList.remove('listening');
}

function removeStatusError() {
  agentStatus.classList.remove('error');
  if (isRecording) {
    agentStatus.textContent = 'Listening...';
    agentStatus.classList.add('listening');
  } else {
    agentStatus.textContent = wasPausedManually ? 'Paused' : 'Ready to listen';
  }
}

function stopAudioPlayback() {
  if (currentAudioSource) {
    try {
      currentAudioSource.stop();
    } catch (e) { }
    currentAudioSource = null;
  }
  audioQueue = [];
  isPlayingAudio = false;
}

function convertFloat32ToPCM16(float32Array) {
  const pcm16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return pcm16.buffer;
}

function resampleAudio(inputData, inputSampleRate, outputSampleRate) {
  if (inputSampleRate === outputSampleRate) return inputData;
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.round(inputData.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, inputData.length - 1);
    const fraction = srcIndex - srcIndexFloor;
    output[i] = inputData[srcIndexFloor] * (1 - fraction) + inputData[srcIndexCeil] * fraction;
  }
  return output;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function playPCM16Audio(base64Audio) {
  // Safety checks
  if (!ttsAudioContext || ttsAudioContext.state === 'closed') {
    console.warn('🔊 Audio skipped: Context is closed or null');
    return;
  }
  
  // Try to auto-resume if somehow still suspended (rare if startRecording worked)
  if (ttsAudioContext.state === 'suspended') {
    ttsAudioContext.resume().catch(e => console.error('Auto-resume failed:', e));
  }

  try {
    const raw = atob(base64Audio);
    const pcm16Array = new Int16Array(raw.length / 2);
    
    for (let i = 0; i < pcm16Array.length; i++) {
      const byte1 = raw.charCodeAt(i * 2);
      const byte2 = raw.charCodeAt(i * 2 + 1);
      pcm16Array[i] = (byte2 << 8) | byte1;
    }

    const float32Array = new Float32Array(pcm16Array.length);
    for (let i = 0; i < pcm16Array.length; i++) {
      float32Array[i] = pcm16Array[i] / 32768.0;
    }

    audioQueue.push(float32Array);
    
    if (!isPlayingAudio) {
      playNextAudioChunk();
    }
  } catch (err) {
    console.error('Error playing audio:', err);
  }
}

function playNextAudioChunk() {
  if (audioQueue.length === 0 || !ttsAudioContext || ttsAudioContext.state === 'closed') {
    isPlayingAudio = false;
    currentAudioSource = null;
    return;
  }

  isPlayingAudio = true;
  const audioData = audioQueue.shift();
  
  try {
    const sampleRate = ttsAudioContext.sampleRate;
    
    // Resample from 24000Hz (OpenAI default) to context sample rate
    let finalAudioData = audioData;
    if (sampleRate !== 24000) {
      finalAudioData = resampleAudio(audioData, 24000, sampleRate);
    }
    
    const audioBuffer = ttsAudioContext.createBuffer(1, finalAudioData.length, sampleRate);
    audioBuffer.getChannelData(0).set(finalAudioData);
    
    const bufferSource = ttsAudioContext.createBufferSource();
    bufferSource.buffer = audioBuffer;
    bufferSource.connect(ttsAudioContext.destination);
    
    currentAudioSource = bufferSource;
    
    bufferSource.onended = () => {
      currentAudioSource = null;
      playNextAudioChunk();
    };
    
    bufferSource.start();
  } catch (err) {
    console.error('Error in playNextAudioChunk:', err);
    isPlayingAudio = false;
    currentAudioSource = null;
  }
}

// Handle page visibility changes
document.addEventListener('visibilitychange', () => {
  if (document.hidden && isRecording) {
    console.log('Page hidden, maintaining connection...');
  }
});

// Cleanup on page unload
window.addEventListener('beforeunload', (event) => {
  if (isRecording && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'emergency_save' }));
      const start = Date.now();
      while (Date.now() - start < 100) {}
    } catch (err) {
      console.error('Could not send emergency save on unload:', err);
    }
    cleanup(true);
  }
});