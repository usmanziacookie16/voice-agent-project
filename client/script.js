const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const transcriptionDiv = document.getElementById('transcription');

let ws, audioContext, processor, source;
let isRecording = false;
let currentAssistantMessage = null;
let currentAssistantText = '';
let pendingUserMessage = null;
let messageSequence = 0;

// Track if this is the first connection or a reconnection
let isFirstConnection = true;
let currentSessionId = null; // Track current session to avoid duplicates
let persistentConversationId = null; // Persistent conversation ID across manual stops
let hasHadFirstGreeting = false; // Track if we've ever had the initial greeting

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

// Update voice button and status based on recording state
function updateVoiceUI(recording) {
  const voiceButton = document.getElementById('voiceButton');
  const agentStatus = document.getElementById('agentStatus');
  
  if (recording) {
    voiceButton.classList.add('active');
    agentStatus.textContent = 'Listening...';
    agentStatus.classList.add('listening');
  } else {
    voiceButton.classList.remove('active');
    agentStatus.textContent = 'Ready to listen';
    agentStatus.classList.remove('listening');
  }
}

// Voice button click handler - must be set up after DOM loads
document.addEventListener('DOMContentLoaded', () => {
  const voiceButton = document.getElementById('voiceButton');
  
  voiceButton.addEventListener('click', () => {
    console.log('Voice button clicked, active:', voiceButton.classList.contains('active'));
    if (voiceButton.classList.contains('active')) {
      // Currently recording, so stop
      stopBtn.click();
    } else {
      // Not recording, so start
      startBtn.click();
    }
  });
});

startBtn.onclick = async () => {
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
  startBtn.disabled = true;
  stopBtn.disabled = false;
  updateVoiceUI(true);

  // Don't clear transcription if resuming - only show placeholder if empty
  if (transcriptionDiv.children.length === 0 || transcriptionDiv.querySelector('.welcome-message')) {
    transcriptionDiv.innerHTML = '<p class="placeholder"><em>Listening...</em></p>';
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);

  // Connection timeout (10 seconds)
  connectionTimeout = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      console.error('❌ Connection timeout');
      ws.close();
      showConnectionError('Connection timeout. Please check your internet and try again.');
      cleanup(false);
    }
  }, 10000);

  ws.onopen = async () => {
    clearTimeout(connectionTimeout);
    console.log('Connected to server');
    reconnectAttempts = 0;
    
    // Start heartbeat monitoring
    startHeartbeat();
    
    // Remove any connection errors
    removeConnectionError();
    
    // Generate or reuse session ID
    if (!currentSessionId) {
      currentSessionId = Date.now();
    }
    
    // Generate or reuse conversation ID (persists across manual stops)
    if (!persistentConversationId) {
      persistentConversationId = currentSessionId;
      console.log('🆕 New conversation ID:', persistentConversationId);
    } else {
      console.log('🔄 Reusing conversation ID:', persistentConversationId);
    }
    
    ws.send(JSON.stringify({ 
      type: "start",
      username: username,
      sessionId: currentSessionId,
      conversationId: persistentConversationId,
      isReconnection: !isFirstConnection,
      hasMessages: transcriptionDiv.querySelectorAll('.message').length > 0
    }));
    
    // Mark that first connection has been made
    if (isFirstConnection) {
      isFirstConnection = false;
      hasHadFirstGreeting = true;
    }

    // Only show placeholder if conversation is empty
    if (transcriptionDiv.children.length === 0 || transcriptionDiv.querySelector('.placeholder')) {
      transcriptionDiv.innerHTML = '<p class="placeholder"><em>Starting conversation...</em></p>';
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
    
    // Remove any connection error messages on successful message
    removeConnectionError();
    
    // Debug logging (except audio deltas)
    if (msg.type !== 'assistant_audio_delta') {
      console.log('📨 Received:', msg.type, msg.text ? `"${msg.text.substring(0, 50)}${msg.text.length > 50 ? '...' : ''}"` : '');
    }

    // Show user message
    if (msg.type === 'user_transcription') {
      // Remove placeholder/welcome message if it exists
      const placeholder = transcriptionDiv.querySelector('.placeholder');
      if (placeholder) placeholder.remove();
      const welcome = transcriptionDiv.querySelector('.welcome-message');
      if (welcome) welcome.remove();

      // Mark all existing messages as older
      markMessagesAsOlder();

      // If there's a pending assistant message, add user message first
      if (currentAssistantMessage) {
        const p = document.createElement('p');
        p.classList.add('message', 'user-message', 'recent');
        p.innerHTML = `<strong>You:</strong> ${escapeHtml(msg.text)}`;
        p.dataset.sequence = messageSequence++;
        transcriptionDiv.insertBefore(p, currentAssistantMessage);
        
        // Mark current assistant message as recent too
        currentAssistantMessage.classList.add('recent');
        currentAssistantMessage.classList.remove('older');
      } else {
        const p = document.createElement('p');
        p.classList.add('message', 'user-message', 'recent');
        p.innerHTML = `<strong>You:</strong> ${escapeHtml(msg.text)}`;
        p.dataset.sequence = messageSequence++;
        transcriptionDiv.appendChild(p);
      }
      
      // Auto-scroll to bottom with extra padding
      transcriptionDiv.scrollTop = transcriptionDiv.scrollHeight + 50;
    }

    // Stream assistant text in real-time (FASTER than audio transcript)
    if (msg.type === 'assistant_transcript_delta') {
      // Remove placeholder/welcome message if still exists
      const placeholder = transcriptionDiv.querySelector('.placeholder');
      if (placeholder) placeholder.remove();
      const welcome = transcriptionDiv.querySelector('.welcome-message');
      if (welcome) welcome.remove();
      
      // Create assistant message if it doesn't exist yet
      if (!currentAssistantMessage) {
        // Mark all existing messages as older when assistant starts responding
        markMessagesAsOlder();
        
        currentAssistantText = '';
        currentAssistantMessage = document.createElement("p");
        currentAssistantMessage.classList.add("message", "assistant-message", "recent");
        currentAssistantMessage.innerHTML = `<strong>Assistant:</strong> <span class="response-text"></span>`;
        currentAssistantMessage.dataset.sequence = messageSequence++;
        transcriptionDiv.appendChild(currentAssistantMessage);
      }
      
      if (currentAssistantMessage) {
        currentAssistantText += msg.text;
        const span = currentAssistantMessage.querySelector(".response-text");
        span.textContent = currentAssistantText;
        span.classList.add('typing');
        
        // Auto-scroll to bottom with extra padding
        transcriptionDiv.scrollTop = transcriptionDiv.scrollHeight + 50;
      }
    }

    // Complete transcript received - ensure nothing is missing
    if (msg.type === 'assistant_transcript_complete') {
      if (currentAssistantMessage) {
        const span = currentAssistantMessage.querySelector(".response-text");
        
        // Use complete transcript if it's longer (fixes incomplete streaming)
        if (msg.text.length > currentAssistantText.length) {
          console.log('✅ Using complete transcript (was incomplete)');
          currentAssistantText = msg.text;
          span.textContent = currentAssistantText;
          transcriptionDiv.scrollTop = transcriptionDiv.scrollHeight + 50;
        }
      }
    }

    // Response was INTERRUPTED by user speaking
    if (msg.type === 'response_interrupted') {
      console.log('⚠️ Response interrupted by user');
      
      // Stop all audio playback immediately
      stopAudioPlayback();
      
      if (currentAssistantMessage) {
        const span = currentAssistantMessage.querySelector(".response-text");
        span.classList.remove('typing');
        
        // Add ellipsis to show it was cut off
        if (!currentAssistantText.endsWith('...')) {
          currentAssistantText += '...';
          span.textContent = currentAssistantText;
        }
        
        // Add interrupted class for visual feedback
        currentAssistantMessage.classList.add('interrupted');
      }
      
      // Reset for next response
      currentAssistantMessage = null;
      currentAssistantText = '';
    }

    // Stream assistant TTS audio (base64 PCM16)
    if (msg.type === "assistant_audio_delta") {
      playPCM16Audio(msg.audio);
    }

    // End of turn - finalize the message
    if (msg.type === 'response_complete') {
      console.log('✅ Response complete');
      
      if (currentAssistantMessage) {
        const span = currentAssistantMessage.querySelector(".response-text");
        if (span) span.classList.remove('typing');
      }
      
      // Reset for next response
      currentAssistantMessage = null;
      currentAssistantText = '';
    }

    // Error handling
    if (msg.type === 'error') {
      const errorP = document.createElement('p');
      errorP.classList.add('message', 'error-message');
      errorP.innerHTML = `<strong>Error:</strong> ${escapeHtml(msg.message)}`;
      transcriptionDiv.appendChild(errorP);
      transcriptionDiv.scrollTop = transcriptionDiv.scrollHeight + 50;
    }
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    showConnectionError('Connection error. Retrying...');
    
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
        showConnectionError(`Connection lost. Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        
        setTimeout(() => {
          if (isRecording) {
            // Reconnect without clearing conversation
            const existingMessages = transcriptionDiv.querySelectorAll('.message');
            startBtn.click();
          }
        }, RECONNECT_DELAY);
      } else {
        cleanup(false); // Connection lost, not manual stop
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          showConnectionError('Connection lost after multiple attempts. Please try again.');
        } else if (transcriptionDiv.children.length === 0) {
          showConnectionError('Connection lost. Please try again.');
        }
      }
    }
  };
};

stopBtn.onclick = () => {
  console.log('🛑 Stop button pressed - saving and preparing for new session');
  
  // Send stop signal to server (will trigger save)
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'stop', requestNewSession: true }));
      console.log('📤 Stop signal sent to server');
    } catch (err) {
      console.error('Error sending stop signal:', err);
    }
  }
  
  // Clean up and reset for new session
  cleanup(true); // Manual stop
};

function cleanup(isManualStop = false) {
  console.log('Cleaning up...', isManualStop ? '(manual stop)' : '(connection lost)');
  isRecording = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  updateVoiceUI(false);

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
  
  // Keep conversation history - only reset current message state
  currentAssistantMessage = null;
  currentAssistantText = '';
  
  // If manually stopped (user clicked stop), reset session completely for NEW conversation
  // If connection lost, keep session for reconnection
  if (isManualStop) {
    console.log('🔄 Manual stop - resetting for NEW conversation (new row in database)');
    isFirstConnection = true;
    currentSessionId = null;
    persistentConversationId = null; // Clear this to create new row
    hasHadFirstGreeting = false; // Reset greeting flag
  } else {
    console.log('🔌 Connection lost - session preserved for reconnection');
  }
  
  // Keep messageSequence to continue numbering
}

// Heartbeat to detect connection issues
function startHeartbeat() {
  lastHeartbeat = Date.now();
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const timeSinceLastMessage = Date.now() - lastHeartbeat;
      if (timeSinceLastMessage > 30000) { // 30 seconds without any message
        console.warn('⚠️ No server response for 30 seconds');
        showConnectionError('Connection may be unstable...');
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

// Show connection error message
function showConnectionError(message) {
  // Remove any existing connection errors first
  removeConnectionError();
  
  const errorP = document.createElement('p');
  errorP.classList.add('message', 'error-message', 'connection-error');
  errorP.innerHTML = `<strong>Connection:</strong> ${escapeHtml(message)}`;
  transcriptionDiv.appendChild(errorP);
  transcriptionDiv.scrollTop = transcriptionDiv.scrollHeight + 50;
}

// Remove connection error messages
function removeConnectionError() {
  const connectionErrors = transcriptionDiv.querySelectorAll('.connection-error');
  connectionErrors.forEach(error => error.remove());
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

// Mark all existing messages as older (fade them)
function markMessagesAsOlder() {
  const allMessages = transcriptionDiv.querySelectorAll('.message');
  allMessages.forEach(msg => {
    msg.classList.remove('recent');
    msg.classList.add('older');
  });
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
    cleanup(true); // Treat page unload as manual stop
  }
});