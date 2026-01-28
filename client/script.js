const toggleButton = document.getElementById('toggleButton');
const currentSpeechDiv = document.getElementById('currentSpeech');
const agentStatus = document.getElementById('agentStatus');

let ws, audioContext, processor, source;
let isRecording = false;
let currentSpeechBubble = null;
let currentSpeechText = '';
let messageSequence = 0;

// Persistent conversation state - survives pause/resume
let persistentConversationId = null;
let hasActiveConversation = false;

// Track if this is the first connection or a reconnection
let isFirstConnection = true;
let currentSessionId = null;

// Connection management
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 3000;
let heartbeatInterval = null;
let lastHeartbeat = Date.now();
let connectionTimeout = null;

// Web Audio API for better TTS playback
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
    agentStatus.textContent = hasActiveConversation ? 'Paused - Click to resume' : 'Ready to listen';
    agentStatus.classList.remove('listening');
  }
}

// Toggle button click handler
toggleButton.addEventListener('click', () => {
  if (isRecording) {
    stopRecording(true); // Manual pause
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
    
    // Generate or reuse conversation ID - THIS IS KEY FOR PERSISTENCE
    if (!persistentConversationId) {
      persistentConversationId = currentSessionId;
      console.log('🆕 New conversation ID:', persistentConversationId);
    } else {
      console.log('🔄 Reusing conversation ID:', persistentConversationId);
    }
    
    // Send start message with conversation state
    ws.send(JSON.stringify({ 
      type: "start",
      username: username,
      sessionId: currentSessionId,
      conversationId: persistentConversationId,
      isReconnection: !isFirstConnection,
      hasMessages: hasActiveConversation // Tell server we have conversation history
    }));
    
    console.log(`📤 Sent start request - hasMessages: ${hasActiveConversation}`);
    
    // Mark that first connection has been made
    if (isFirstConnection) {
      isFirstConnection = false;
    }

    try {
      // Check if getUserMedia is supported
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Your browser does not support audio recording. Please use Chrome, Edge, or a modern browser.');
      }

      // Request microphone access with browser-specific handling
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

      // Check AudioContext support (Safari uses webkitAudioContext)
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('Your browser does not support audio processing. Please use a modern browser.');
      }

      // IMPORTANT: Use device sample rate to avoid Firefox issues
      audioContext = new AudioContextClass();
      const actualSampleRate = audioContext.sampleRate;
      console.log(`Using sample rate: ${actualSampleRate}Hz`);
      
      // Safari may need manual resume
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      // Initialize TTS audio context with SAME sample rate as microphone context
      if (!ttsAudioContext) {
        ttsAudioContext = new AudioContextClass({ sampleRate: actualSampleRate });
        if (ttsAudioContext.state === 'suspended') {
          await ttsAudioContext.resume();
        }
      }

      source = audioContext.createMediaStreamSource(stream);
      
      // Use ScriptProcessor for better browser compatibility
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
      
      let errorMessage = 'Could not access microphone. ';
      
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        errorMessage += 'Please grant microphone permission in your browser settings and try again.\n\n';
        errorMessage += 'Firefox: Click the 🔒 icon in the address bar → Permissions → Microphone → Allow\n';
        errorMessage += 'Safari: Safari menu → Settings → Websites → Microphone → Allow for this website';
      } else if (err.name === 'NotFoundError') {
        errorMessage += 'No microphone device found. Please connect a microphone and try again.';
      } else if (err.message) {
        errorMessage += err.message;
      } else {
        errorMessage += 'Please check your browser settings and try again.';
      }
      
      alert(errorMessage);
      cleanup(false);
    }
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    
    // Update heartbeat timestamp
    lastHeartbeat = Date.now();

    if (msg.type === 'user_transcription') {
      console.log('User said:', msg.text);
      // Mark that we now have conversation content
      hasActiveConversation = true;
    }

    if (msg.type === 'assistant_transcript_delta') {
      if (!currentSpeechBubble) {
        currentSpeechBubble = document.createElement('div');
        currentSpeechBubble.className = 'speech-bubble';
        currentSpeechBubble.innerHTML = '<span class="speech-text typing"></span>';
        
        currentSpeechDiv.innerHTML = '';
        currentSpeechDiv.appendChild(currentSpeechBubble);
        currentSpeechText = '';
      }

      currentSpeechText += msg.text;
      const speechTextSpan = currentSpeechBubble.querySelector('.speech-text');
      if (speechTextSpan) {
        speechTextSpan.textContent = currentSpeechText;
      }
      
      // Mark that we now have conversation content
      hasActiveConversation = true;
    }

    if (msg.type === 'assistant_transcript_complete') {
      const speechTextSpan = currentSpeechBubble?.querySelector('.speech-text');
      if (speechTextSpan) {
        speechTextSpan.classList.remove('typing');
      }
    }

    if (msg.type === 'assistant_audio_delta') {
      playPCM16Audio(msg.audio);
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
      
      currentSpeechBubble = null;
      currentSpeechText = '';
    }

    if (msg.type === 'response_complete') {
      console.log('✅ Assistant response complete');
      
      const speechTextSpan = currentSpeechBubble?.querySelector('.speech-text');
      if (speechTextSpan) {
        speechTextSpan.classList.remove('typing');
      }
      
      currentSpeechBubble = null;
      currentSpeechText = '';
    }

    if (msg.type === 'error') {
      console.error('Server error:', msg.message);
      showStatusError(msg.message);
    }
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    showStatusError('Connection error. Attempting to reconnect...');
  };

  ws.onclose = () => {
    console.log('WebSocket closed');
    
    stopHeartbeat();
    
    if (isRecording) {
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        console.log(`Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        showStatusError(`Connection lost. Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        
        setTimeout(() => {
          if (!isRecording) return;
          startRecording();
        }, RECONNECT_DELAY);
      } else {
        showStatusError('Connection lost. Please click to reconnect.');
        cleanup(false);
      }
    }
  };
}

function stopRecording(isManualPause = false) {
  console.log(`🛑 Stopping recording (manual pause: ${isManualPause})`);
  
  isRecording = false;
  updateUI(false);

  stopAudioPlayback();
  stopHeartbeat();
  
  if (connectionTimeout) {
    clearTimeout(connectionTimeout);
    connectionTimeout = null;
  }

  if (processor) {
    processor.disconnect();
    processor = null;
  }
  if (source) {
    source.disconnect();
    source = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close();
    audioContext = null;
  }
  
  // Don't close TTS context so we can resume audio playback
  // if (ttsAudioContext && ttsAudioContext.state !== 'closed') {
  //   ttsAudioContext.close();
  //   ttsAudioContext = null;
  // }
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      // Send stop message WITHOUT requesting new session
      ws.send(JSON.stringify({ 
        type: 'stop'
      }));
      console.log('📤 Sent stop message - conversation will be preserved');
    } catch (err) {
      console.error('Error sending stop message:', err);
    }
    ws.close();
  }
  
  // Keep conversation state for resume
  if (isManualPause) {
    console.log('⏸️ Manual pause - conversation preserved for resume');
    console.log(`   Conversation ID: ${persistentConversationId}`);
    console.log(`   Has active conversation: ${hasActiveConversation}`);
  }
}

function cleanup(preserveState = true) {
  stopRecording(preserveState);
  
  // Don't reset conversation state - allow resume
  if (!preserveState) {
    // Only reset if explicitly told to (e.g., on logout)
    persistentConversationId = null;
    hasActiveConversation = false;
    isFirstConnection = true;
  }
}

// Heartbeat to detect connection issues
function startHeartbeat() {
  lastHeartbeat = Date.now();
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const timeSinceLastMessage = Date.now() - lastHeartbeat;
      if (timeSinceLastMessage > 30000) { // 30 seconds without any message
        console.warn('⚠️ No server response for 30 seconds');
        showStatusError('Connection may be unstable...');
      }
    }
  }, 5000); // Check every 5 seconds
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// Show error in status bar at bottom (NOT in speech bubble)
function showStatusError(message) {
  // Update the agent status at the top
  agentStatus.textContent = `⚠️ ${message}`;
  agentStatus.classList.add('error');
  agentStatus.classList.remove('listening');
}

// Remove error from status
function removeStatusError() {
  agentStatus.classList.remove('error');
  if (isRecording) {
    agentStatus.textContent = 'Listening...';
    agentStatus.classList.add('listening');
  } else {
    agentStatus.textContent = hasActiveConversation ? 'Paused - Click to resume' : 'Ready to listen';
  }
}

// Stop audio playback immediately (for interruptions)
function stopAudioPlayback() {
  // Stop current audio source
  if (currentAudioSource) {
    try {
      currentAudioSource.stop();
    } catch (e) {
      // Already stopped
    }
    currentAudioSource = null;
  }
  
  // Clear audio queue
  audioQueue = [];
  isPlayingAudio = false;
}

// Convert float32 → 16-bit PCM
function convertFloat32ToPCM16(float32Array) {
  const pcm16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return pcm16.buffer;
}

// Simple linear resampling for microphone input
function resampleAudio(inputData, inputSampleRate, outputSampleRate) {
  if (inputSampleRate === outputSampleRate) {
    return inputData;
  }
  
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.round(inputData.length / ratio);
  const output = new Float32Array(outputLength);
  
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, inputData.length - 1);
    const fraction = srcIndex - srcIndexFloor;
    
    // Linear interpolation
    output[i] = inputData[srcIndexFloor] * (1 - fraction) + inputData[srcIndexCeil] * fraction;
  }
  
  return output;
}

// Base64 helper
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Enhanced audio playback using Web Audio API
function playPCM16Audio(base64Audio) {
  if (!ttsAudioContext || ttsAudioContext.state === 'closed') return;

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
    // Use the actual TTS context sample rate
    const sampleRate = ttsAudioContext.sampleRate;
    
    // Resample from 24000Hz to context sample rate if needed
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

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
    // CRITICAL: Request emergency save before page closes
    try {
      ws.send(JSON.stringify({ type: 'emergency_save' }));
      // Small delay to ensure message is sent
      const start = Date.now();
      while (Date.now() - start < 100) {
        // Blocking loop to ensure save request is sent
      }
    } catch (err) {
      console.error('Could not send emergency save on unload:', err);
    }
    cleanup(true); // Preserve state on page unload
  }
});
