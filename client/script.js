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
let currentSessionId = null; // Track current session to avoid duplicates
let persistentConversationId = null; // Persistent conversation ID across manual pauses
let hasHadFirstGreeting = false; // Track if we've ever had the initial greeting
let wasPausedManually = false; // Track if user manually paused (for "ready to continue" message)

// Connection management
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 3000; // 3 seconds
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
    // Change "Ready to listen" to "Paused" or keep it as "Ready"
    agentStatus.textContent = wasPausedManually ? 'Paused' : 'Ready to listen';
    agentStatus.classList.remove('listening');
  }
}

// Toggle button click handler
toggleButton.addEventListener('click', () => {
  if (isRecording) {
    // Currently recording, so pause
    stopRecording();
  } else {
    // Not recording, so start
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
      showErrorBubble('Connection timeout. Please check your internet and try again.');
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
    removeErrorBubble();
    
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
    
    // Determine if we have messages (was paused)
    const hasMessages = wasPausedManually;
    
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
      // Create audioContext without specifying sample rate - let browser choose
      audioContext = new AudioContextClass();
      const actualSampleRate = audioContext.sampleRate;
      console.log(`Using sample rate: ${actualSampleRate}Hz`);
      
      // Safari may need manual resume
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      // Initialize TTS audio context with SAME sample rate as microphone context
      // This is critical for Firefox compatibility
      if (!ttsAudioContext) {
        ttsAudioContext = new AudioContextClass({ sampleRate: actualSampleRate });
        if (ttsAudioContext.state === 'suspended') {
          await ttsAudioContext.resume();
        }
      }

      source = audioContext.createMediaStreamSource(stream);
      
      // Use ScriptProcessor for better browser compatibility
      // Safari and Firefox work better with 4096 buffer
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
    
    // Remove any error messages on successful message
    removeErrorBubble();
    
    // Debug logging (except audio deltas)
    if (msg.type !== 'assistant_audio_delta') {
      console.log('📨 Received:', msg.type, msg.text ? `"${msg.text.substring(0, 50)}${msg.text.length > 50 ? '...' : ''}"` : '');
    }

    // User transcription - we don't display user messages anymore
    if (msg.type === 'user_transcription') {
      console.log('👤 User said:', msg.text);
    }

    // Stream assistant text in real-time (FASTER than audio transcript)
    if (msg.type === 'assistant_transcript_delta') {
      // Remove welcome message if still exists
      const welcomeMsg = currentSpeechDiv.querySelector('.welcome-message');
      if (welcomeMsg) welcomeMsg.remove();
      
      // Create speech bubble if it doesn't exist yet
      if (!currentSpeechBubble) {
        currentSpeechText = '';
        currentSpeechBubble = document.createElement("div");
        currentSpeechBubble.classList.add("speech-bubble");
        currentSpeechBubble.innerHTML = `<span class="speech-text"></span>`;
        currentSpeechDiv.innerHTML = ''; // Clear any previous content
        currentSpeechDiv.appendChild(currentSpeechBubble);
      }
      
      if (currentSpeechBubble) {
        currentSpeechText += msg.text;
        const span = currentSpeechBubble.querySelector(".speech-text");
        span.textContent = currentSpeechText;
        span.classList.add('typing');
      }
    }

    // Complete transcript received - ensure nothing is missing
    if (msg.type === 'assistant_transcript_complete') {
      if (currentSpeechBubble) {
        const span = currentSpeechBubble.querySelector(".speech-text");
        
        // Use complete transcript if it's longer (fixes incomplete streaming)
        if (msg.text.length > currentSpeechText.length) {
          console.log('✅ Using complete transcript (was incomplete)');
          currentSpeechText = msg.text;
          span.textContent = currentSpeechText;
        }
      }
    }

    // Response was INTERRUPTED by user speaking
    if (msg.type === 'response_interrupted') {
      console.log('⚠️ Response interrupted by user');
      
      // Stop all audio playback immediately
      stopAudioPlayback();
      
      if (currentSpeechBubble) {
        const span = currentSpeechBubble.querySelector(".speech-text");
        span.classList.remove('typing');
        
        // Add ellipsis to show it was cut off
        if (!currentSpeechText.endsWith('...')) {
          currentSpeechText += '...';
          span.textContent = currentSpeechText;
        }
        
        // Add interrupted class for visual feedback
        currentSpeechBubble.classList.add('interrupted');
      }
      
      // Reset for next response
      currentSpeechBubble = null;
      currentSpeechText = '';
    }

    // Stream assistant TTS audio (base64 PCM16)
    if (msg.type === "assistant_audio_delta") {
      playPCM16Audio(msg.audio);
    }

    // End of turn - finalize the message
    if (msg.type === 'response_complete') {
      console.log('✅ Response complete');
      
      if (currentSpeechBubble) {
        const span = currentSpeechBubble.querySelector(".speech-text");
        if (span) span.classList.remove('typing');
      }
      
      // Keep the bubble visible (don't reset)
      // Only reset the reference so a new bubble is created next time
      currentSpeechBubble = null;
      currentSpeechText = '';
    }

    // Error handling
    if (msg.type === 'error') {
      showErrorBubble(msg.message);
    }
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    showErrorBubble('Connection error. Retrying...');
    
    // CRITICAL: Request emergency save from server
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'emergency_save' }));
      } catch (err) {
        console.error('Could not send emergency save request:', err);
      }
    }
  };

  ws.onclose = (event) => {
    console.log('WebSocket closed', event.code, event.reason);
    stopHeartbeat();
    
    if (isRecording) {
      // Attempt to reconnect if not a clean close
      if (event.code !== 1000 && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        console.log(`🔄 Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
        showErrorBubble(`Connection lost. Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        
        setTimeout(() => {
          if (isRecording) {
            startRecording();
          }
        }, RECONNECT_DELAY);
      } else {
        cleanup(false); // Connection lost, not manual pause
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          showErrorBubble('Connection lost after multiple attempts. Please try again.');
        }
      }
    }
  };
}

function stopRecording() {
  console.log('⏸️ Pause button pressed - saving conversation');
  
  // Mark that this was a manual pause
  wasPausedManually = true;
  
  // Send stop signal to server (will trigger save)
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      // Don't request new session - we want to continue this conversation
      ws.send(JSON.stringify({ type: 'stop', requestNewSession: false }));
      console.log('📤 Pause signal sent to server');
    } catch (err) {
      console.error('Error sending pause signal:', err);
    }
  }
  
  // Clean up but keep conversation state
  cleanup(true); // Manual pause
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
  if (ttsAudioContext && ttsAudioContext.state !== 'closed') {
    ttsAudioContext.close();
    ttsAudioContext = null;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'stop' }));
    } catch (err) {
      console.error('Error sending stop message:', err);
    }
    ws.close();
  }
  
  // Keep speech bubble visible
  // Reset current speech state for next response
  currentSpeechBubble = null;
  currentSpeechText = '';
  
  // If manually paused, keep everything for resume
  // If connection lost, also keep state for reconnection
  if (isManualPause) {
    console.log('⏸️ Manual pause - ready to resume conversation');
    // Don't reset session or conversation ID - we want to continue
  } else {
    console.log('🔌 Connection lost - session preserved for reconnection');
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
        showErrorBubble('Connection may be unstable...');
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

// Show error as a bubble
function showErrorBubble(message) {
  // Remove any existing errors first
  removeErrorBubble();
  
  const errorBubble = document.createElement('div');
  errorBubble.classList.add('speech-bubble', 'interrupted', 'error-bubble');
  errorBubble.innerHTML = `<span class="speech-text">⚠️ ${escapeHtml(message)}</span>`;
  currentSpeechDiv.innerHTML = '';
  currentSpeechDiv.appendChild(errorBubble);
}

// Remove error bubbles
function removeErrorBubble() {
  const errorBubbles = currentSpeechDiv.querySelectorAll('.error-bubble');
  errorBubbles.forEach(bubble => bubble.remove());
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
    cleanup(true); // Treat page unload as manual pause
  }
});