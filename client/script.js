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
  
  // --- IMPROVED AUDIO CONTEXT FIX START ---
  // Key improvement: Always create fresh context AND properly clear old state
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  
  try {
    // Step 1: Clean up any existing TTS context completely
    if (ttsAudioContext) {
      try {
        // Stop any playing audio first
        if (currentAudioSource) {
          currentAudioSource.stop();
          currentAudioSource = null;
        }
        
        // Clear the queue
        audioQueue = [];
        isPlayingAudio = false;
        
        // Close the old context
        if (ttsAudioContext.state !== 'closed') {
          await ttsAudioContext.close();
        }
        console.log('🔇 Old TTS AudioContext closed cleanly');
      } catch(e) {
        console.log("Error closing old context (will proceed anyway):", e);
      }
      ttsAudioContext = null;
    }

    // Step 2: Create a completely fresh context
    // This is crucial - doing it inside user gesture ensures 'running' state
    console.log('🎵 Creating FRESH TTS AudioContext');
    ttsAudioContext = new AudioContextClass();
    audioContextInitialized = true;
    
    // Step 3: Explicitly resume if needed (belt and suspenders)
    if (ttsAudioContext.state === 'suspended') {
      await ttsAudioContext.resume();
    }
    
    console.log(`✅ TTS Context Ready (State: ${ttsAudioContext.state}, Sample Rate: ${ttsAudioContext.sampleRate}Hz)`);
    
  } catch (e) {
    console.error('Failed to initialize TTS context:', e);
    alert('Audio system error. Please refresh the page.');
    return;
  }
  // --- IMPROVED AUDIO CONTEXT FIX END ---

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
        isTranscribing = false; // User finished speaking
      }
      
      if (data.type === 'assistant_transcript_delta') {
        isTranscribing = false; // Assistant is now responding
        
        // Create new bubble only if we don't have one OR if it's from a previous response
        if (!currentSpeechBubble || currentSpeechBubble.dataset.completed === 'true') {
          // Clear any old bubble
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
        
        // Don't sanitize deltas - just append them directly
        // Sanitization will happen on completion
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
            // NOW sanitize the complete text
            const sanitizedText = sanitizeText(data.text);
            speechTextSpan.textContent = sanitizedText;
            currentSpeechBubble.dataset.completed = 'true';
          }
        }
        
        // Reset for next message
        currentSpeechText = '';
      }
      
      if (data.type === 'assistant_audio_delta') {
        // CRITICAL: Verify context state before attempting playback
        if (!ttsAudioContext) {
          console.error('🔊 Skipping audio: Context is null');
          return;
        }
        
        if (ttsAudioContext.state === 'closed') {
          console.error('🔊 Skipping audio: Context is closed');
          return;
        }
        
        // If suspended, try to resume (though this shouldn't happen with our new setup)
        if (ttsAudioContext.state === 'suspended') {
          console.warn('🔊 Context suspended, attempting resume...');
          ttsAudioContext.resume().then(() => {
            playPCM16Audio(data.audio);
          }).catch(err => {
            console.error('Failed to resume context:', err);
          });
          return;
        }
        
        // Context is running, proceed with playback
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
            // Sanitize the interrupted text
            const sanitizedText = sanitizeText(currentSpeechText);
            speechTextSpan.textContent = sanitizedText;
          }
        }
        
        stopAudioPlayback();
        
        // Don't clear the bubble reference - let it stay visible
        // currentSpeechBubble = null;
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

function stopRecording() {
  if (!isRecording) return;
  
  console.log('🛑 Stopping recording (manual pause)');
  wasPausedManually = true;
  
  // CRITICAL FIX: Send stop message to server BEFORE cleanup
  // This ensures conversation is saved properly
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ 
        type: 'stop',
        requestNewSession: false // Keep the conversation going
      }));
      console.log('✅ Stop signal sent to server');
    } catch (err) {
      console.error('Error sending stop signal:', err);
    }
  }
  
  // IMPROVED: Don't destroy TTS context on pause - just stop playback
  // This prevents the audio malfunction issue
  stopAudioPlayback();
  
  // Clean up microphone resources
  cleanup(false);
}

function cleanup(destroyTTSContext = true) {
  console.log('🧹 Cleaning up resources...');
  
  isRecording = false;
  updateUI(false);
  stopHeartbeat();
  
  // Clean up microphone audio context
  if (processor) {
    processor.disconnect();
    processor = null;
  }
  
  if (source) {
    source.disconnect();
    const stream = source.mediaStream;
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }
    source = null;
  }
  
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  
  // CRITICAL FIX: Only destroy TTS context if explicitly requested
  // For manual pause, we keep it alive to prevent audio issues
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
  } else if (!destroyTTSContext) {
    console.log('🎵 TTS AudioContext preserved for resume');
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  
  // IMPORTANT: Don't reset speech bubbles on pause
  // This preserves the conversation state
  // currentSpeechBubble = null;
  // currentSpeechText = '';
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
    } catch (e) { 
      console.log('Source already stopped:', e);
    }
    currentAudioSource = null;
  }
  audioQueue = [];
  isPlayingAudio = false;
}

/**
 * Sanitizes streaming text to remove garbled characters, mojibake,
 * and incomplete UTF-8 sequences that appear during live streaming.
 */
function sanitizeText(text) {
  if (!text) return '';

  // 1. First, replace common mojibake/special symbols with readable equivalents if they exist
  // This prevents losing intended characters like curly quotes or dashes
  let sanitized = text
    .replace(/[\u201C\u201D]/g, '"') // Curly quotes to straight
    .replace(/[\u2018\u2019]/g, "'") // Curly apostrophes to straight
    .replace(/\u2014/g, '-')         // Em-dash to hyphen
    .replace(/\u2026/g, '...');      // Ellipsis

  // 2. Eliminate everything that isn't a standard "safe" character.
  // This whitelist includes:
  // a-z, A-Z (English letters)
  // 0-9 (Numbers)
  // \s (Whitespace/Newlines)
  // Basic punctuation: . , ! ? : ; ( ) ' " - / _ @ # % & * + =
  // Any character outside this set (including partial UTF-8 bytes like Â or ) is deleted.
  sanitized = sanitized.replace(/[^a-zA-Z0-9\s.,!?:;()'"\-\/_@#%&*\+=]/g, '');

  // 3. Collapse multiple spaces and trim
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
  // CRITICAL: Ensure we have a valid, running context
  if (!ttsAudioContext) {
    console.error('🔊 Audio skipped: Context is null (this should not happen after our fix)');
    return;
  }
  
  if (ttsAudioContext.state === 'closed') {
    console.error('🔊 Audio skipped: Context is closed (this should not happen after our fix)');
    return;
  }
  
  // This check should be rare now, but kept as a safety measure
  if (ttsAudioContext.state === 'suspended') {
    console.warn('🔊 Context suspended, attempting auto-resume...');
    ttsAudioContext.resume()
      .then(() => {
        console.log('✅ Context resumed successfully');
        actuallyPlayAudio(base64Audio);
      })
      .catch(e => {
        console.error('❌ Auto-resume failed:', e);
      });
    return;
  }

  // Context is in 'running' state, proceed with playback
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

  // Final state check before playing
  if (ttsAudioContext.state === 'suspended') {
    console.warn('🔊 Context suspended in playNextAudioChunk, cannot play');
    isPlayingAudio = false;
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
  } else if (!document.hidden && isRecording) {
    // Page became visible again - ensure audio context is ready
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