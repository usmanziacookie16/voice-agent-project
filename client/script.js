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

// NEW: Pause/Resume state
let isPaused = false;
let micStream = null;
let lastToggleTime = 0;
const TOGGLE_DEBOUNCE_MS = 300; // Prevent rapid clicking

// Connection management
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 3000;
let heartbeatInterval = null;
let lastHeartbeat = Date.now();
let connectionTimeout = null;

// Web Audio API for TTS (Text-to-Speech) playback
let ttsAudioContext = null; 
let audioQueue = [];
let isPlayingAudio = false;
let currentAudioSource = null;

// Track audio state
let audioContextInitialized = false;
let lastAudioPlayAttempt = 0;

// CRITICAL FIX: Track if we're in the middle of transcription
let isTranscribing = false;

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
    agentStatus.textContent = isPaused ? 'Paused - Click to resume' : 'Listening...';
    agentStatus.classList.add('listening');
  } else {
    toggleButton.classList.remove('active');
    agentStatus.textContent = 'Ready to listen';
    agentStatus.classList.remove('listening');
  }
}

// Toggle button click handler
toggleButton.addEventListener('click', () => {
  // Debounce: Prevent rapid clicks (noise prevention)
  const now = Date.now();
  if (now - lastToggleTime < TOGGLE_DEBOUNCE_MS) {
    console.log('⏭️ Click ignored (too fast)');
    return;
  }
  lastToggleTime = now;
  
  if (!isRecording) {
    // Start fresh session
    startRecording();
  } else if (isPaused) {
    // Resume from pause
    resumeRecording();
  } else {
    // Pause
    pauseRecording();
  }
});

async function startRecording() {
  if (isRecording && !isPaused) return;
  
  // Get username from session
  const username = sessionStorage.getItem('username');
  
  if (!username) {
    alert('Session expired. Please login again.');
    window.location.href = 'login.html';
    return;
  }
  
  console.log('Starting with username:', username);
  
  // --- IMPROVED AUDIO CONTEXT FIX START ---
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  
  try {
    // Create TTS context if not exists
    if (!ttsAudioContext) {
      console.log('🎵 Creating TTS AudioContext');
      ttsAudioContext = new AudioContextClass();
      audioContextInitialized = true;
      
      if (ttsAudioContext.state === 'suspended') {
        await ttsAudioContext.resume();
      }
      
      console.log(`✅ TTS Context Ready (State: ${ttsAudioContext.state})`);
    }
    
  } catch (e) {
    console.error('Failed to initialize TTS context:', e);
    alert('Audio system error. Please refresh the page.');
    return;
  }
  // --- IMPROVED AUDIO CONTEXT FIX END ---

  isRecording = true;
  isPaused = false;
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
      micStream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log('✅ Microphone access granted');

      // Create Microphone Audio Context
      audioContext = new AudioContextClass();
      const actualSampleRate = audioContext.sampleRate;
      console.log(`Mic sample rate: ${actualSampleRate}Hz`);
      
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      source = audioContext.createMediaStreamSource(micStream);
      
      // Use ScriptProcessor
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      processor.connect(audioContext.destination);

      processor.onaudioprocess = (e) => {
        if (!isRecording || isPaused || !ws || ws.readyState !== WebSocket.OPEN) return;
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
      alert(`Microphone Error: ${err.message}\n\nPlease ensure:\n1. Your browser has microphone permission\n2. Your device has a working microphone\n3. No other app is using the microphone`);
      cleanup(false);
      return;
    }
  };

  ws.onmessage = (event) => {
    lastHeartbeat = Date.now();
    
    try {
      const data = JSON.parse(event.data);
      
      if (data.type === 'connection_ready') {
        console.log('✅ Ready to send audio');
        removeStatusError();
      }
      
      if (data.type === 'history_restored') {
        console.log('✅ Conversation history restored');
      }
      
      if (data.type === 'user_transcription') {
        console.log('User said:', data.text);
        isTranscribing = false;
      }
      
      if (data.type === 'assistant_transcript_delta') {
        isTranscribing = false;
        
        // Create new bubble only if we don't have one OR if it's from a previous response
        if (!currentSpeechBubble || currentSpeechBubble.dataset.completed === 'true') {
          currentSpeechBubble = document.createElement('div');
          currentSpeechBubble.className = 'speech-bubble';
          currentSpeechBubble.dataset.completed = 'false';
          
          const speechText = document.createElement('span');
          speechText.className = 'speech-text typing';
          currentSpeechBubble.appendChild(speechText);
          
          currentSpeechDiv.innerHTML = '';
          currentSpeechDiv.appendChild(currentSpeechBubble);
          currentSpeechText = '';
        }
        
        currentSpeechText += data.text;
        
        const speechTextSpan = currentSpeechBubble.querySelector('.speech-text');
        if (speechTextSpan) {
          speechTextSpan.textContent = currentSpeechText;
        }
      }
      
      if (data.type === 'assistant_transcript_complete') {
        console.log('Assistant completed:', data.text);
        
        if (currentSpeechBubble) {
          const speechTextSpan = currentSpeechBubble.querySelector('.speech-text');
          if (speechTextSpan) {
            speechTextSpan.classList.remove('typing');
            const sanitizedText = sanitizeText(data.text);
            speechTextSpan.textContent = sanitizedText;
            currentSpeechBubble.dataset.completed = 'true';
          }
        }
        
        currentSpeechText = '';
      }
      
      if (data.type === 'assistant_audio_delta') {
        // Don't play audio if paused, but still queue it
        if (isPaused) {
          // Silent queueing during pause - prevents audio glitches
          try {
            const raw = atob(data.audio);
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
          } catch (err) {
            console.error('Error queueing audio while paused:', err);
          }
          return;
        }
        
        if (!ttsAudioContext) {
          console.error('🔊 Skipping audio: Context is null');
          return;
        }
        
        if (ttsAudioContext.state === 'closed') {
          console.error('🔊 Skipping audio: Context is closed');
          return;
        }
        
        if (ttsAudioContext.state === 'suspended') {
          console.warn('🔊 Context suspended, attempting resume...');
          ttsAudioContext.resume().then(() => {
            playPCM16Audio(data.audio);
          }).catch(err => {
            console.error('Failed to resume context:', err);
          });
          return;
        }
        
        playPCM16Audio(data.audio);
      }
      
      if (data.type === 'response_interrupted') {
        console.log('⚠️ Response interrupted by user');
        
        if (currentSpeechBubble) {
          currentSpeechBubble.classList.add('interrupted');
          currentSpeechBubble.dataset.completed = 'true';
          const speechTextSpan = currentSpeechBubble.querySelector('.speech-text');
          if (speechTextSpan) {
            speechTextSpan.classList.remove('typing');
            const sanitizedText = sanitizeText(currentSpeechText);
            speechTextSpan.textContent = sanitizedText;
          }
        }
        
        stopAudioPlayback();
        currentSpeechText = '';
      }
      
      if (data.type === 'response_complete') {
        console.log('✅ Response complete');
        
        if (currentSpeechBubble) {
          currentSpeechBubble.dataset.completed = 'true';
          const speechTextSpan = currentSpeechBubble.querySelector('.speech-text');
          if (speechTextSpan) {
            speechTextSpan.classList.remove('typing');
          }
        }
      }
      
      if (data.type === 'error') {
        console.error('Server error:', data.message);
        showStatusError(data.message);
      }
    } catch (err) {
      console.error('Error parsing message:', err);
    }
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    showStatusError('Connection error. Retrying...');
  };

  ws.onclose = () => {
    console.log('WebSocket closed');
    stopHeartbeat();
    
    if (isRecording && !wasPausedManually && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      console.log(`🔄 Attempting reconnect ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`);
      showStatusError(`Connection lost. Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
      
      setTimeout(() => {
        if (isRecording) {
          startRecording();
        }
      }, RECONNECT_DELAY);
    } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      showStatusError('Connection failed. Please refresh the page.');
      cleanup(false);
    }
  };
}

function pauseRecording() {
  if (!isRecording || isPaused) return;
  
  console.log('⏸️ Pausing (keeping connection alive)');
  isPaused = true;
  wasPausedManually = true;
  
  // CRITICAL: Stop all audio playback immediately and cleanly
  if (currentAudioSource) {
    try {
      currentAudioSource.stop(0); // Stop immediately with no delay
      currentAudioSource.disconnect(); // Disconnect from destination
    } catch (e) {
      console.log('Source already stopped');
    }
    currentAudioSource = null;
  }
  isPlayingAudio = false;
  
  // Stop microphone processing - fully disconnect
  if (processor && source) {
    try {
      processor.disconnect();
      source.disconnect();
    } catch (e) {
      console.log('Processor already disconnected');
    }
  }
  
  updateUI(true); // Keep active appearance but show paused
  agentStatus.textContent = '⏸️ Paused - Click to resume';
  toggleButton.classList.remove('active');
}

function resumeRecording() {
  if (!isRecording || !isPaused) return;
  
  console.log('▶️ Resuming');
  
  // CRITICAL: Ensure no audio is playing before we resume
  if (currentAudioSource) {
    try {
      currentAudioSource.stop(0);
      currentAudioSource.disconnect();
    } catch (e) {
      // Already stopped
    }
    currentAudioSource = null;
  }
  isPlayingAudio = false;
  
  isPaused = false;
  
  // Reconnect processor cleanly - ensure no duplicate connections
  if (processor && source && audioContext) {
    try {
      // First, ensure everything is disconnected
      try {
        processor.disconnect();
        source.disconnect();
      } catch (e) {
        // Already disconnected, that's fine
      }
      
      // Now reconnect cleanly
      source.connect(processor);
      processor.connect(audioContext.destination);
      console.log('✅ Processor reconnected');
    } catch (e) {
      console.error('Error reconnecting processor:', e);
    }
  }
  
  // Resume audio playback of queued chunks with a small delay
  // This prevents click/pop sounds from immediate playback
  if (audioQueue.length > 0) {
    console.log(`▶️ Resuming ${audioQueue.length} queued audio chunks`);
    
    // Add tiny delay to prevent audio glitches
    setTimeout(() => {
      if (!isPaused) { // Double-check we're still resumed
        playNextAudioChunk();
      }
    }, 50);
  }
  
  updateUI(true);
  agentStatus.textContent = 'Listening...';
  toggleButton.classList.add('active');
}

function stopRecording() {
  if (!isRecording) return;
  
  console.log('🛑 Stopping recording completely');
  wasPausedManually = true;
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ 
        type: 'stop',
        requestNewSession: false
      }));
    } catch (err) {
      console.error('Error sending stop signal:', err);
    }
  }
  
  stopAudioPlayback();
  cleanup(false);
}

function cleanup(destroyTTSContext = true) {
  console.log('🧹 Cleaning up resources...');
  
  isRecording = false;
  isPaused = false;
  updateUI(false);
  stopHeartbeat();
  
  if (processor) {
    processor.disconnect();
    processor = null;
  }
  
  if (source) {
    source.disconnect();
    source = null;
  }
  
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }
  
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  
  if (destroyTTSContext && ttsAudioContext) {
    try {
      stopAudioPlayback();
      ttsAudioContext.close();
      console.log('🔇 TTS AudioContext closed cleanly');
    } catch(e) {
      console.error('Error closing TTS context:', e);
    }
    ttsAudioContext = null;
    audioContextInitialized = false;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
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
    agentStatus.textContent = isPaused ? '⏸️ Paused - Click to resume' : 'Listening...';
    agentStatus.classList.add('listening');
  } else {
    agentStatus.textContent = 'Ready to listen';
  }
}

function stopAudioPlayback() {
  if (currentAudioSource) {
    try {
      currentAudioSource.stop();
    } catch (e) { 
      console.log('Source already stopped:', e);
    }
    currentAudioSource = null;
  }
  audioQueue = [];
  isPlayingAudio = false;
}

function sanitizeText(text) {
  if (!text) return '';

  let sanitized = text
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u2014/g, '-')
    .replace(/\u2026/g, '...');

  sanitized = sanitized.replace(/[^a-zA-Z0-9\s.,!?:;()'"\-\/_@#%&*\+=]/g, '');
  sanitized = sanitized.replace(/\s+/g, ' ').trim();

  return sanitized;
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
  if (!ttsAudioContext || ttsAudioContext.state === 'closed') {
    console.error('🔊 Audio skipped: Invalid context');
    return;
  }
  
  if (ttsAudioContext.state === 'suspended') {
    console.warn('🔊 Context suspended, attempting auto-resume...');
    ttsAudioContext.resume()
      .then(() => {
        actuallyPlayAudio(base64Audio);
      })
      .catch(e => {
        console.error('❌ Auto-resume failed:', e);
      });
    return;
  }

  actuallyPlayAudio(base64Audio);
}

function actuallyPlayAudio(base64Audio) {
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
    
    if (!isPlayingAudio && !isPaused) {
      playNextAudioChunk();
    }
  } catch (err) {
    console.error('Error playing audio:', err);
  }
}

function playNextAudioChunk() {
  // Check if paused - if so, stop immediately
  if (isPaused) {
    console.log('⏸️ Playback paused, keeping queue');
    isPlayingAudio = false;
    return;
  }
  
  // If already playing, don't start another one (prevents overlap)
  if (isPlayingAudio && currentAudioSource) {
    return;
  }
  
  if (audioQueue.length === 0 || !ttsAudioContext || ttsAudioContext.state === 'closed') {
    isPlayingAudio = false;
    currentAudioSource = null;
    return;
  }

  if (ttsAudioContext.state === 'suspended') {
    console.warn('🔊 Context suspended in playNextAudioChunk');
    isPlayingAudio = false;
    return;
  }

  isPlayingAudio = true;
  const audioData = audioQueue.shift();
  
  try {
    const sampleRate = ttsAudioContext.sampleRate;
    
    let finalAudioData = audioData;
    if (sampleRate !== 24000) {
      finalAudioData = resampleAudio(audioData, 24000, sampleRate);
    }
    
    const audioBuffer = ttsAudioContext.createBuffer(1, finalAudioData.length, sampleRate);
    audioBuffer.getChannelData(0).set(finalAudioData);
    
    const bufferSource = ttsAudioContext.createBufferSource();
    bufferSource.buffer = audioBuffer;
    
    // Add gain node for smooth fade-in/out (prevents clicks and pops)
    const gainNode = ttsAudioContext.createGain();
    bufferSource.connect(gainNode);
    gainNode.connect(ttsAudioContext.destination);
    
    // Smooth fade-in (prevents click at start)
    const now = ttsAudioContext.currentTime;
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(1, now + 0.01); // 10ms fade-in
    
    currentAudioSource = bufferSource;
    
    bufferSource.onended = () => {
      currentAudioSource = null;
      isPlayingAudio = false;
      
      // Continue with next chunk if not paused
      if (!isPaused && audioQueue.length > 0) {
        playNextAudioChunk();
      }
    };
    
    bufferSource.start(0);
  } catch (err) {
    console.error('Error in playNextAudioChunk:', err);
    isPlayingAudio = false;
    currentAudioSource = null;
    
    // Try to recover by playing next chunk
    if (!isPaused && audioQueue.length > 0) {
      setTimeout(() => playNextAudioChunk(), 50);
    }
  }
}

// Handle page visibility changes
document.addEventListener('visibilitychange', () => {
  if (document.hidden && isRecording) {
    console.log('Page hidden, maintaining connection...');
  } else if (!document.hidden && isRecording) {
    if (ttsAudioContext && ttsAudioContext.state === 'suspended') {
      console.log('Page visible again, resuming audio context');
      ttsAudioContext.resume();
    }
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