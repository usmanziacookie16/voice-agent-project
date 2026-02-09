// DOM Elements
const voiceButton = document.getElementById('voiceButton');
const speechBubble = document.getElementById('speechBubble');
const welcomeMessage = document.getElementById('welcomeMessage');
const currentSpeechText = document.getElementById('currentSpeechText');

// WebSocket and Audio
let ws;
let audioContext = null; // For Microphone
let ttsAudioContext = null; // For Playback
let processor = null;
let source = null;
let micStream = null;

// State Management
let isRecording = false;
let isSessionActive = false;
let isPaused = false;

// Text and Message Handling
let currentAssistantText = '';
let messageSequence = 0;

// NEW: Text sync with audio
let fullTranscriptText = '';
let wordsToDisplay = [];
let isThinkingState = false;

// NEW: Sync Counters
let totalChunksReceived = 0;
let chunksPlayed = 0;

// Connection Management
let isFirstConnection = true;
let currentSessionId = null;
let persistentConversationId = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 3000;
let heartbeatInterval = null;
let lastHeartbeat = Date.now();

// Audio Playback
let audioQueue = [];
let isPlayingAudio = false;
let currentAudioSource = null;

// Conversation Storage
const conversationMessages = [];

// Speech Bubble Control
let speechBubbleTimeout = null;

// Animation State
let isUserSpeaking = false;
let isAssistantSpeaking = false;

// Browser Detection
function detectBrowser() {
  const userAgent = navigator.userAgent.toLowerCase();
  const isFirefox = userAgent.indexOf('firefox') > -1;
  const isSafari = userAgent.indexOf('safari') > -1 && userAgent.indexOf('chrome') === -1;
  
  if (isFirefox) {
    showBrowserWarning('Firefox detected. Ensure microphone permissions are granted.');
  } else if (isSafari) {
    showBrowserWarning('Safari detected. Ensure microphone permissions are granted.');
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

// --- STATE MANAGEMENT & UI ---

function updateVoiceUI() {
  voiceButton.classList.remove('active', 'paused');
  
  if (!isSessionActive) {
    // Idle state: show mic icon
  } else if (isPaused) {
    // Paused state: show play icon
    voiceButton.classList.add('paused');
  } else {
    // Active state: show pause icon
    voiceButton.classList.add('active');
  }
}

// --- SPEECH BUBBLE ---

let textAnimationFrame = null;
let targetText = '';
let currentDisplayText = '';
const textAnimationSpeed = 30; // ms per character

function showSpeechBubble(text) {
  // Hide welcome message when speech bubble is triggered
  if (welcomeMessage.style.display !== 'none') {
    welcomeMessage.style.display = 'none';
  }

  speechBubble.classList.remove('fade-out');
  speechBubble.classList.add('show');
  speechBubble.style.display = 'block'; // Ensure it's part of layout
  
  // Add thinking class if text is "..."
  if (text === '...') {
    currentSpeechText.classList.add('thinking-dots');
    currentSpeechText.textContent = text;
    currentDisplayText = text;
    targetText = text;
  } else {
    currentSpeechText.classList.remove('thinking-dots');
    animateText(text);
  }
  
  if (speechBubbleTimeout) {
    clearTimeout(speechBubbleTimeout);
    speechBubbleTimeout = null;
  }
}

function animateText(newText) {
  targetText = newText;
  if (newText.length > currentDisplayText.length) {
    if (!textAnimationFrame) {
      animateTextStep();
    }
  } else {
    currentDisplayText = newText;
    currentSpeechText.textContent = newText;
  }
}

function animateTextStep() {
  if (currentDisplayText.length < targetText.length) {
    currentDisplayText = targetText.substring(0, currentDisplayText.length + 1);
    currentSpeechText.textContent = currentDisplayText;
    textAnimationFrame = setTimeout(animateTextStep, textAnimationSpeed);
  } else {
    textAnimationFrame = null;
  }
}

function hideSpeechBubble() {
  speechBubble.classList.add('fade-out');
  setTimeout(() => {
    speechBubble.classList.remove('show', 'fade-out');
    // We do NOT bring back the welcome message here automatically
    // It stays clean until the next interaction or page reload
  }, 1500);
}

// --- VOICE BUTTON ---

voiceButton.addEventListener('click', () => {
  if (!isSessionActive) {
    startSession();
  } else if (isPaused) {
    resumeSession();
  } else {
    pauseSession();
  }
});

// --- SESSION MANAGEMENT ---

async function startSession() {
  if (isSessionActive) return;
  
  const username = sessionStorage.getItem('username');
  if (!username) {
    alert('Session expired. Please login again.');
    window.location.href = 'login.html';
    return;
  }
  
  console.log('🎙️ Starting session for:', username);
  
  // Initialize TTS Audio Context
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  try {
    if (!ttsAudioContext) {
      ttsAudioContext = new AudioContextClass();
    }
    if (ttsAudioContext.state === 'suspended') {
      await ttsAudioContext.resume();
    }
    console.log('✅ TTS Context Ready');
  } catch (e) {
    console.error('Failed to initialize TTS context:', e);
    alert('Audio system error. Please refresh the page.');
    return;
  }
  
  isSessionActive = true;
  isRecording = true;
  isPaused = false;
  updateVoiceUI();
  
  // WebSocket Connection
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);
  
  ws.onopen = async () => {
    console.log('✅ Connected to server');
    reconnectAttempts = 0;
    startHeartbeat();
    
    if (!currentSessionId) {
      currentSessionId = Date.now();
    }
    
    if (!persistentConversationId) {
      persistentConversationId = currentSessionId;
    }
    
    ws.send(JSON.stringify({ 
      type: "start",
      username: username,
      sessionId: currentSessionId,
      conversationId: persistentConversationId,
      isReconnection: !isFirstConnection,
      hasMessages: !isFirstConnection
    }));
    
    if (isFirstConnection) {
      isFirstConnection = false;
      // Immediately show "..." when connecting for the first time
      showSpeechBubble("...");
    }
    
    // Start microphone
    try {
      const constraints = {
        audio: {
          channelCount: 1,
          sampleRate: 24000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      };
      
      micStream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log('✅ Microphone access granted');
      
      audioContext = new AudioContextClass();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      
      source = audioContext.createMediaStreamSource(micStream);
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      processor.connect(audioContext.destination);
      
      processor.onaudioprocess = (e) => {
        if (!isRecording || isPaused || !ws || ws.readyState !== WebSocket.OPEN) return;
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
    } catch (err) {
      console.error('Microphone error:', err);
      alert('Microphone Error: ' + err.message);
      cleanup();
      return;
    }
  };
  
  ws.onmessage = (event) => {
    lastHeartbeat = Date.now();
    
    try {
      const msg = JSON.parse(event.data);
      
      if (msg.type === 'connection_ready') {
        console.log('✅ Ready to send audio');
      }
      
      if (msg.type === 'history_restored') {
        console.log('✅ Conversation history restored');
      }
      
      if (msg.type === 'user_transcription') {
        console.log('User said:', msg.text);
        isUserSpeaking = true;
        
        conversationMessages.push({
          sequence: messageSequence++,
          role: 'user',
          content: msg.text,
          timestamp: new Date().toISOString()
        });
      }
      
      // NEW: Show thinking indicator
      if (msg.type === 'response_creating') {
        console.log('🤔 AI is thinking...');
        isThinkingState = true;
        isUserSpeaking = false;
        
        // Reset text sync variables
        fullTranscriptText = '';
        wordsToDisplay = [];
        currentAssistantText = '';
        
        // Reset counters for the new response
        totalChunksReceived = 0;
        chunksPlayed = 0;
        
        // Show "..." in speech bubble
        showSpeechBubble('...');
      }
      
      if (msg.type === 'assistant_transcript_delta') {
        if (!isAssistantSpeaking) {
          isAssistantSpeaking = true;
          isUserSpeaking = false;
        }
        
        // Remove thinking state
        isThinkingState = false;
        
        // Accumulate the full transcript text (don't display yet)
        fullTranscriptText += msg.text;
        
        // Split into words for progressive display
        wordsToDisplay = fullTranscriptText.split(' ');
        
        // Don't update display here - let audio chunks drive the text display
      }
      
      if (msg.type === 'assistant_transcript_complete') {
        // Ensure we display the complete text if audio is somehow done or skipped
        fullTranscriptText = msg.text;
        wordsToDisplay = fullTranscriptText.split(' ');
        
         if (audioQueue.length === 0 && !isPlayingAudio) {
             currentAssistantText = fullTranscriptText;
             showSpeechBubble(currentAssistantText);
        }
        
        isThinkingState = false;
      }
      
      if (msg.type === "assistant_audio_delta") {
        // Increment total chunks received for ratio calculation
        totalChunksReceived++;
        playPCM16Audio(msg.audio);
      }
      
      if (msg.type === 'response_interrupted') {
        console.log('⛔ Interrupted');
        stopAudioPlayback();
        
        isAssistantSpeaking = false;
        
        if (currentAssistantText) {
          currentAssistantText += '...';
          showSpeechBubble(currentAssistantText);
        }
        
        // Reset text sync variables
        currentAssistantText = '';
        fullTranscriptText = '';
        wordsToDisplay = [];
        totalChunksReceived = 0;
        chunksPlayed = 0;
        isThinkingState = false;
      }
      
      if (msg.type === 'response_complete') {
        console.log('✅ Response complete');
        isAssistantSpeaking = false;
        
        if (currentAssistantText) {
          conversationMessages.push({
            sequence: messageSequence++,
            role: 'assistant',
            content: currentAssistantText,
            timestamp: new Date().toISOString()
          });
        }
      }
      
      if (msg.type === 'error') {
        console.error('Server error:', msg.message);
        showSpeechBubble(`Error: ${msg.message}`);
      }
    } catch (err) {
      console.error('Error parsing message:', err);
    }
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
  
  ws.onclose = (event) => {
    stopHeartbeat();
    if (isSessionActive && event.code !== 1000 && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      console.log(`Reconnecting (${reconnectAttempts})...`);
      setTimeout(() => {
        if (isSessionActive) startSession();
      }, RECONNECT_DELAY);
    } else {
      cleanup();
    }
  };
}

function pauseSession() {
  if (!isSessionActive || isPaused) return;
  
  console.log('⏸️ Pausing session');
  isPaused = true;
  
  // Suspend TTS Context to freeze audio in place
  if (ttsAudioContext && ttsAudioContext.state === 'running') {
    ttsAudioContext.suspend();
  }
  
  // Suspend Mic Context (optional, but good to save resources)
  if (audioContext && audioContext.state === 'running') {
    audioContext.suspend();
  }
  
  isPlayingAudio = false; // Flag for UI logic
  
  updateVoiceUI();
}

function resumeSession() {
  if (!isSessionActive || !isPaused) return;
  
  console.log('▶️ Resuming session');
  isPaused = false;
  
  // Resume TTS Context
  if (ttsAudioContext && ttsAudioContext.state === 'suspended') {
    ttsAudioContext.resume();
    // Re-flag playing if we have items in queue or active source
    if (currentAudioSource || audioQueue.length > 0) {
        isPlayingAudio = true;
    }
  }
  
  // Resume Mic Context
  if (audioContext && audioContext.state === 'suspended') {
    audioContext.resume();
  }

  // Trigger next chunk if queue exists and we aren't currently playing
  if (audioQueue.length > 0 && !currentAudioSource) {
     playNextAudioChunk();
  }
  
  updateVoiceUI();
}

function stopSession() {
  if (!isSessionActive) return;
  
  console.log('🛑 Stopping session');
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'stop' }));
    } catch (err) {}
  }
  
  stopAudioPlayback();
  cleanup();
}

function cleanup() {
  console.log('🧹 Cleaning up...');
  
  isSessionActive = false;
  isRecording = false;
  isPaused = false;
  
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
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  
  updateVoiceUI();
}

// --- AUDIO PROCESSING ---

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

// --- AUDIO PLAYBACK ---

function playPCM16Audio(base64Audio) {
  if (!ttsAudioContext || ttsAudioContext.state === 'closed') {
    return;
  }
  
  if (ttsAudioContext.state === 'suspended' && !isPaused) {
    ttsAudioContext.resume().then(() => {
      actuallyPlayAudio(base64Audio);
    }).catch(e => {
      console.error('Failed to resume context:', e);
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
  if (isPaused) {
    // If paused, we do NOT play, but we keep the queue intact
    isPlayingAudio = false;
    return;
  }
  
  if (isPlayingAudio && currentAudioSource) {
    return;
  }
  
  if (audioQueue.length === 0 || !ttsAudioContext || ttsAudioContext.state === 'closed') {
    isPlayingAudio = false;
    currentAudioSource = null;
    return;
  }
  
  // --- NEW: SYNC LOGIC ---
  // When we start a chunk, we update the text
  isPlayingAudio = true;
  chunksPlayed++;
  
  if (wordsToDisplay.length > 0) {
      // Calculate ratio of audio played vs total audio received
      // Math.max(1, ...) prevents division by zero
      const ratio = Math.min(1.0, chunksPlayed / Math.max(1, totalChunksReceived));
      
      // Determine how many words to show based on that ratio
      const wordCount = Math.ceil(wordsToDisplay.length * ratio);
      const textToShow = wordsToDisplay.slice(0, wordCount).join(' ');
      
      // Update display if we have more text to show
      if (textToShow.length >= currentAssistantText.length) {
          currentAssistantText = textToShow;
          showSpeechBubble(currentAssistantText);
      }
  }
  // -----------------------
  
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
    
    const gainNode = ttsAudioContext.createGain();
    bufferSource.connect(gainNode);
    gainNode.connect(ttsAudioContext.destination);
    
    const now = ttsAudioContext.currentTime;
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(1, now + 0.01);
    
    currentAudioSource = bufferSource;
    
    bufferSource.onended = () => {
      currentAudioSource = null;
      isPlayingAudio = false;
      
      if (!isPaused && audioQueue.length > 0) {
        playNextAudioChunk();
      }
    };
    
    bufferSource.start(0);
  } catch (err) {
    console.error('Error in playNextAudioChunk:', err);
    isPlayingAudio = false;
    currentAudioSource = null;
    
    if (!isPaused && audioQueue.length > 0) {
      setTimeout(() => playNextAudioChunk(), 50);
    }
  }
}

function stopAudioPlayback() {
  if (currentAudioSource) {
    try {
      currentAudioSource.stop();
    } catch (e) {}
    currentAudioSource = null;
  }
  audioQueue = [];
  isPlayingAudio = false;
}

// --- HEARTBEAT ---

function startHeartbeat() {
  lastHeartbeat = Date.now();
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const timeSinceLastMessage = Date.now() - lastHeartbeat;
      if (timeSinceLastMessage > 30000) {
        console.warn('⚠️ No server response for 30 seconds');
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

// --- PAGE VISIBILITY ---

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isSessionActive) {
    if (ttsAudioContext && ttsAudioContext.state === 'suspended') {
      ttsAudioContext.resume();
    }
  }
});

// --- CLEANUP ON UNLOAD ---

window.addEventListener('beforeunload', () => {
  if (isSessionActive && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'emergency_save' }));
    } catch (err) {}
    cleanup();
  }
});