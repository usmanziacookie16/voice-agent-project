const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const transcriptionDiv = document.getElementById('transcription');

let ws, audioContext, processor, source;
let isRecording = false;
let currentAssistantMessage = null;
let currentAssistantText = '';
let pendingUserMessage = null;
let messageSequence = 0;

let isFirstConnection = true;
let currentSessionId = null;
let persistentConversationId = null;
let hasHadFirstGreeting = false;

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 3000;
let heartbeatInterval = null;
let lastHeartbeat = Date.now();
let connectionTimeout = null;

let ttsAudioContext = null;
let audioQueue = [];
let isPlayingAudio = false;
let currentAudioSource = null;

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

detectBrowser();

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

document.addEventListener('DOMContentLoaded', () => {
  const voiceButton = document.getElementById('voiceButton');
  
  voiceButton.addEventListener('click', () => {
    console.log('Voice button clicked, active:', voiceButton.classList.contains('active'));
    if (voiceButton.classList.contains('active')) {
      stopBtn.click();
    } else {
      startBtn.click();
    }
  });
});

startBtn.onclick = async () => {
  if (isRecording) return;
  
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

  if (transcriptionDiv.children.length === 0 || transcriptionDiv.querySelector('.welcome-message')) {
    transcriptionDiv.innerHTML = '<p class="placeholder"><em>Requesting microphone access...</em></p>';
  }

  // Use wss:// for HTTPS, ws:// for HTTP
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);

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
    
    startHeartbeat();
    removeConnectionError();
    
    if (!currentSessionId) {
      currentSessionId = Date.now();
    }
    
    if (!persistentConversationId) {
      persistentConversationId = currentSessionId;
      console.log('🆕 New conversation ID:', persistentConversationId);
    } else {
      console.log('🔄 Reusing conversation ID:', persistentConversationId);
    }
    
    // Send start message but DON'T trigger greeting yet
    ws.send(JSON.stringify({ 
      type: "start",
      username: username,
      sessionId: currentSessionId,
      conversationId: persistentConversationId,
      isReconnection: !isFirstConnection,
      hasMessages: transcriptionDiv.querySelectorAll('.message').length > 0
    }));
    
    if (isFirstConnection) {
      isFirstConnection = false;
      hasHadFirstGreeting = true;
    }

    if (transcriptionDiv.children.length === 0 || transcriptionDiv.querySelector('.placeholder')) {
      transcriptionDiv.innerHTML = '<p class="placeholder"><em>Setting up microphone...</em></p>';
    }

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Your browser does not support audio recording. Please use Chrome, Edge, or a modern browser.');
      }

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

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('Your browser does not support audio processing. Please use a modern browser.');
      }

      audioContext = new AudioContextClass();
      const actualSampleRate = audioContext.sampleRate;
      console.log(`Using sample rate: ${actualSampleRate}Hz`);
      
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      if (!ttsAudioContext) {
        ttsAudioContext = new AudioContextClass({ sampleRate: actualSampleRate });
        if (ttsAudioContext.state === 'suspended') {
          await ttsAudioContext.resume();
        }
      }

      source = audioContext.createMediaStreamSource(stream);
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      processor.connect(audioContext.destination);

      processor.onaudioprocess = (e) => {
        if (!isRecording || !ws || ws.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        
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

      // CRITICAL: Send microphone_ready signal AFTER microphone is confirmed working
      console.log('🎤 Sending microphone_ready signal to server');
      ws.send(JSON.stringify({ 
        type: "microphone_ready",
        hasMessages: transcriptionDiv.querySelectorAll('.message').length > 0
      }));

      // Update UI to show ready
      if (transcriptionDiv.querySelector('.placeholder')) {
        transcriptionDiv.innerHTML = '<p class="placeholder"><em>Starting conversation...</em></p>';
      }

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
    
    lastHeartbeat = Date.now();
    removeConnectionError();
    
    if (msg.type !== 'assistant_audio_delta') {
      console.log('📨 Received:', msg.type, msg.text ? `"${msg.text.substring(0, 50)}${msg.text.length > 50 ? '...' : ''}"` : '');
    }

    if (msg.type === 'user_transcription') {
      const placeholder = transcriptionDiv.querySelector('.placeholder');
      if (placeholder) placeholder.remove();
      const welcome = transcriptionDiv.querySelector('.welcome-message');
      if (welcome) welcome.remove();

      markMessagesAsOlder();

      if (currentAssistantMessage) {
        const p = document.createElement('p');
        p.classList.add('message', 'user-message', 'recent');
        p.innerHTML = `<strong>You:</strong> ${escapeHtml(msg.text)}`;
        p.dataset.sequence = messageSequence++;
        transcriptionDiv.insertBefore(p, currentAssistantMessage);
        
        currentAssistantMessage.classList.add('recent');
        currentAssistantMessage.classList.remove('older');
      } else {
        const p = document.createElement('p');
        p.classList.add('message', 'user-message', 'recent');
        p.innerHTML = `<strong>You:</strong> ${escapeHtml(msg.text)}`;
        p.dataset.sequence = messageSequence++;
        transcriptionDiv.appendChild(p);
      }
      
      transcriptionDiv.scrollTop = transcriptionDiv.scrollHeight + 50;
    }

    if (msg.type === 'assistant_transcript_delta') {
      const placeholder = transcriptionDiv.querySelector('.placeholder');
      if (placeholder) placeholder.remove();
      const welcome = transcriptionDiv.querySelector('.welcome-message');
      if (welcome) welcome.remove();
      
      if (!currentAssistantMessage) {
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
        
        transcriptionDiv.scrollTop = transcriptionDiv.scrollHeight + 50;
      }
    }

    if (msg.type === 'assistant_transcript_complete') {
      if (currentAssistantMessage) {
        const span = currentAssistantMessage.querySelector(".response-text");
        
        if (msg.text.length > currentAssistantText.length) {
          console.log('✅ Using complete transcript (was incomplete)');
          currentAssistantText = msg.text;
          span.textContent = currentAssistantText;
          transcriptionDiv.scrollTop = transcriptionDiv.scrollHeight + 50;
        }
      }
    }

    if (msg.type === 'response_interrupted') {
      console.log('⚠️ Response interrupted by user');
      
      stopAudioPlayback();
      
      if (currentAssistantMessage) {
        const span = currentAssistantMessage.querySelector(".response-text");
        span.classList.remove('typing');
        
        if (!currentAssistantText.endsWith('...')) {
          currentAssistantText += '...';
          span.textContent = currentAssistantText;
        }
        
        currentAssistantMessage.classList.add('interrupted');
      }
      
      currentAssistantMessage = null;
      currentAssistantText = '';
    }

    if (msg.type === "assistant_audio_delta") {
      playPCM16Audio(msg.audio);
    }

    if (msg.type === 'response_complete') {
      console.log('✅ Response complete');
      
      if (currentAssistantMessage) {
        const span = currentAssistantMessage.querySelector(".response-text");
        if (span) span.classList.remove('typing');
      }
      
      currentAssistantMessage = null;
      currentAssistantText = '';
    }

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
      if (event.code !== 1000 && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        console.log(`🔄 Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
        showConnectionError(`Connection lost. Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        
        setTimeout(() => {
          if (isRecording) {
            const existingMessages = transcriptionDiv.querySelectorAll('.message');
            startBtn.click();
          }
        }, RECONNECT_DELAY);
      } else {
        cleanup(false);
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
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'stop', requestNewSession: true }));
      console.log('📤 Stop signal sent to server');
    } catch (err) {
      console.error('Error sending stop signal:', err);
    }
  }
  
  cleanup(true);
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
  
  currentAssistantMessage = null;
  currentAssistantText = '';
  
  if (isManualStop) {
    console.log('🔄 Manual stop - resetting for NEW conversation (new row in database)');
    isFirstConnection = true;
    currentSessionId = null;
    persistentConversationId = null;
    hasHadFirstGreeting = false;
  } else {
    console.log('🔌 Connection lost - session preserved for reconnection');
  }
}

function startHeartbeat() {
  lastHeartbeat = Date.now();
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const timeSinceLastMessage = Date.now() - lastHeartbeat;
      if (timeSinceLastMessage > 30000) {
        console.warn('⚠️ No server response for 30 seconds');
        showConnectionError('Connection may be unstable...');
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

function showConnectionError(message) {
  removeConnectionError();
  
  const errorP = document.createElement('p');
  errorP.classList.add('message', 'error-message', 'connection-error');
  errorP.innerHTML = `<strong>Connection:</strong> ${escapeHtml(message)}`;
  transcriptionDiv.appendChild(errorP);
  transcriptionDiv.scrollTop = transcriptionDiv.scrollHeight + 50;
}

function removeConnectionError() {
  const connectionErrors = transcriptionDiv.querySelectorAll('.connection-error');
  connectionErrors.forEach(error => error.remove());
}

function stopAudioPlayback() {
  if (currentAudioSource) {
    try {
      currentAudioSource.stop();
    } catch (e) {
      // Already stopped
    }
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
    const sampleRate = ttsAudioContext.sampleRate;
    
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

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function markMessagesAsOlder() {
  const allMessages = transcriptionDiv.querySelectorAll('.message');
  allMessages.forEach(msg => {
    msg.classList.remove('recent');
    msg.classList.add('older');
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && isRecording) {
    console.log('Page hidden, maintaining connection...');
  }
});

window.addEventListener('beforeunload', (event) => {
  if (isRecording && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'emergency_save' }));
      const start = Date.now();
      while (Date.now() - start < 100) {
        // Blocking loop to ensure save request is sent
      }
    } catch (err) {
      console.error('Could not send emergency save on unload:', err);
    }
    cleanup(true);
  }
});
