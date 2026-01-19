import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

// Load config from environment variables (production) or config.json (development)
let config = {
  PORT: process.env.PORT || 3000,
  OPENAI_KEY: process.env.OPENAI_KEY,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY
};

// If config.json exists (development), use it
if (fs.existsSync('./config.json')) {
  const fileConfig = JSON.parse(fs.readFileSync('./config.json'));
  config = { ...config, ...fileConfig };
  console.log('📋 Using config.json (development mode)');
} else {
  console.log('🌍 Using environment variables (production mode)');
}

// Validate that we have the required config
if (!config.OPENAI_KEY || !config.SUPABASE_URL || !config.SUPABASE_KEY) {
  console.error('❌ Missing required configuration!');
  console.error('Please set environment variables or create config.json');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files from client directory
// Works for both local (../client) and production (./client)
const clientPath = fs.existsSync('../client') ? '../client' : './client';
app.use(express.static(clientPath));
console.log(`📁 Serving static files from: ${clientPath}`);

// Middleware to parse JSON bodies
app.use(express.json());

// --- AUTH API ROUTES ---

// Sign Up Route
app.post('/api/signup', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const { data, error } = await supabase
      .from('users')
      .insert([{ username, password }])
      .select();

    if (error) {
      // Check for unique constraint violation (username exists)
      if (error.code === '23505') {
        return res.status(400).json({ error: 'Username already exists' });
      }
      throw error;
    }

    res.json({ success: true, message: 'User created' });
  } catch (err) {
    console.error('Signup Error:', err.message);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Login Route
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .eq('password', password)
      .single();

    if (error || !data) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    res.json({ success: true, username: data.username });
  } catch (err) {
    console.error('Login Error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});


// Supabase Connection
const supabaseUrl = config.SUPABASE_URL;
const supabaseKey = config.SUPABASE_KEY;
let supabase;

// Connection retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds

// Track active sessions to prevent duplicates
const activeSessions = new Map(); // sessionId -> { username, conversationId, lastSaveTime, messageCount }

// Helper function to retry operations
async function retryOperation(operation, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      return await operation();
    } catch (error) {
      console.log(`⚠️ Attempt ${i + 1}/${retries} failed:`, error.message);
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
  }
}

try {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('✅ Connected to Supabase');
} catch (error) {
  console.error('❌ Supabase connection error:', error);
  console.log('⚠️ Will fall back to local file storage');
}

// Function to save conversation to Supabase with deduplication
async function saveConversation(username, conversationId, messages, sessionId = null, forceImmediate = false) {
  // Skip if no messages to save
  if (!messages || messages.length === 0) {
    console.log('⏭️ No messages to save');
    return;
  }

  // Deduplication check using session tracking (unless force immediate)
  if (!forceImmediate && sessionId && activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    const now = Date.now();
    
    // Don't save if same message count (no new messages)
    if (session.messageCount === messages.length) {
      console.log(`⏭️ Skipped save (no new messages): ${username}_C`);
      return;
    }
    
    // Debounce: Don't save if last save was less than 1 second ago (reduced from 2s)
    if (session.lastSaveTime && (now - session.lastSaveTime) < 1000) {
      console.log(`⏭️ Skipped save (debounce): ${username}_C`);
      return;
    }
    
    // Update session info
    session.messageCount = messages.length;
    session.lastSaveTime = now;
  } else if (sessionId) {
    // Register new session
    activeSessions.set(sessionId, {
      username,
      conversationId,
      messageCount: messages.length,
      lastSaveTime: Date.now()
    });
  }
  
  const conversationData = {
    username: username,
    conversation_id: conversationId,
    condition: 'C', // C for Conversational (voice assistant)
    timestamp: new Date().toISOString(),
    messages: messages,
    total_messages: messages.length,
    updated_at: new Date().toISOString()
  };
  
  try {
    if (supabase) {
      // Use retry mechanism for network resilience
      await retryOperation(async () => {
        // Check if conversation exists
        const { data: existing, error: selectError } = await supabase
          .from('conversations')
          .select('id, total_messages')
          .eq('username', username)
          .eq('conversation_id', conversationId)
          .single();

        // Handle no results (not an error)
        if (selectError && selectError.code !== 'PGRST116') {
          throw selectError;
        }

        if (existing) {
          // Only update if we have more messages (prevents duplicates)
          if (messages.length > (existing.total_messages || 0)) {
            const { error: updateError } = await supabase
              .from('conversations')
              .update(conversationData)
              .eq('username', username)
              .eq('conversation_id', conversationId);
            
            if (updateError) throw updateError;
            console.log(`💾 Conversation updated in Supabase: ${username}_C (${messages.length} messages)`);
          } else {
            console.log(`⏭️ Skipped update (no new messages): ${username}_C`);
          }
        } else {
          // Insert new conversation
          const { error: insertError } = await supabase
            .from('conversations')
            .insert([conversationData]);
          
          if (insertError) {
            // Check if it's a duplicate key error
            if (insertError.code === '23505') {
              console.log(`⚠️ Conversation already exists (race condition avoided): ${username}_C`);
            } else {
              throw insertError;
            }
          } else {
            console.log(`💾 Conversation saved to Supabase: ${username}_C (${messages.length} messages)`);
          }
        }
      });
    } else {
      // Fallback to local file storage
      saveFallbackLocal(username, conversationId, conversationData);
    }
  } catch (error) {
    console.error('❌ Error saving conversation:', error);
    // Fallback to local storage on error
    saveFallbackLocal(username, conversationId, conversationData);
  }
}

// Fallback function for local storage
function saveFallbackLocal(username, conversationId, conversationData) {
  try {
    const conversationsDir = './conversations';
    if (!fs.existsSync(conversationsDir)) {
      fs.mkdirSync(conversationsDir);
    }
    const filename = `${conversationsDir}/${username}_C_${conversationId}.json`;
    
    // Check if file exists and has same or more messages (prevent duplicates)
    if (fs.existsSync(filename)) {
      const existing = JSON.parse(fs.readFileSync(filename));
      if (existing.total_messages >= conversationData.total_messages) {
        console.log(`⏭️ Skipped local save (no new messages): ${filename}`);
        return;
      }
    }
    
    fs.writeFileSync(filename, JSON.stringify(conversationData, null, 2));
    console.log(`💾 Conversation saved locally (fallback): ${filename}`);
  } catch (localError) {
    console.error('❌ Local save also failed:', localError);
  }
}

wss.on('connection', async (clientWs) => {
  console.log('Client connected');
  
  // Conversation tracking
  let username = null;
  let conversationId = null;
  let sessionId = null;
  const conversationMessages = [];
  let messageSequence = 0;
  
  let openaiWs = null;
  let activeResponse = false;
  let currentResponseId = null;
  let currentAssistantMessage = { role: 'assistant', content: '', timestamp: null, interrupted: false };
  let isReconnection = false;
  
  // Auto-save interval - save every 10 seconds if there are unsaved changes
  let lastSavedMessageCount = 0;
  const autoSaveInterval = setInterval(() => {
    if (conversationMessages.length > lastSavedMessageCount && username && conversationId) {
      console.log('⏰ Auto-save triggered (10s interval)');
      saveConversation(username, conversationId, conversationMessages, sessionId, false);
      lastSavedMessageCount = conversationMessages.length;
    }
  }, 10000); // Every 10 seconds

  clientWs.on('message', async (message) => {
    const msg = JSON.parse(message);

    // Start the session
    if (msg.type === 'start') {
      // Capture username and session info from client
      username = msg.username || 'anonymous';
      sessionId = msg.sessionId || Date.now();
      conversationId = msg.conversationId || sessionId; // Use provided conversationId
      isReconnection = msg.isReconnection || false;
      const hasMessages = msg.hasMessages || false; // Check if client has conversation history (was paused)
      
      console.log(`👤 User: ${username} | Session: ${sessionId} | Conversation: ${conversationId} | Reconnection: ${isReconnection} | Has Messages: ${hasMessages}`);
      
      // Use existing conversationId if reconnecting, otherwise use provided one
      if (activeSessions.has(sessionId)) {
        const existingConversationId = activeSessions.get(sessionId).conversationId;
        console.log(`🔄 Reconnecting to existing conversation: ${existingConversationId}`);
      } else {
        console.log(`📝 Using conversation: ${conversationId}`);
      }
      
      const model = 'gpt-4o-realtime-preview';
      const url = `wss://api.openai.com/v1/realtime?model=${model}`;
      const { default: WebSocket } = await import('ws');

      openaiWs = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${config.OPENAI_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      openaiWs.on('open', () => {
        console.log('✅ Connected to OpenAI Realtime API');
        openaiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: `Act as a facilitator to help the user write a self-reflection. The user recently wrote a term paper. Your task is to facilitate the user writing the self-reflection via multi-turn dialogue
You will ask open-ended questions that should align with the six stages of Gibbs' Reflective Cycle in this order: Description, Feelings, Evaluation, Analysis, Conclusion, and Action Plan. You are to remain implicit regarding the phases of Gibbs' Reflective Cycle throughout the session.


At the start of each phase, ask one of the following questions in order:
1. Can you describe the process of writing your term paper, from planning to completion?
2. How did you feel while working on the term paper, especially during challenging moments?
3. What aspects of your term paper do you think went well, and what didn't work as effectively?
4. Why do you think certain parts of the process were successful or unsuccessful? Were there any factors or strategies that contributed to the outcome?
5. What have you learned from writing this term paper, both about the subject and your own writing process?
6. What will you do differently in your next term paper to improve your approach and results?

Ask one main question per turn exactly as they are written above. When asking these main questions do not add any examples based on previous input. Use specific, process-focused follow-up questions if the response is brief or lacks detail. Ask specific questions rather than generic questions. Do not move to the next question unless the user provides sufficient detail or explicitly refuses to elaborate. If the user refuses, acknowledge briefly and continue without pressure.

Provide feedback on each answer provided by the user. The feedback should focus on the level of reflection rather than the content of the experience. Encourage, supervise, and incorporate social and personal values. Scaffolded Follow-up questions can also be employed to explore deeper when needed.
Request specific examples from the user. If the student mentions a shift in views, prompt him for examples from his experience that illustrate this change.
Do not perform the reflection for the user. Do Not Respond with more than 1-3 sentences or Questions. Always response in English Language.

`,
            voice: 'alloy',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: { 
              type: 'server_vad', 
              threshold: 0.5, 
              prefix_padding_ms: 300, 
              silence_duration_ms: 600
            },
            temperature: 1.0,
            max_response_output_tokens: 'inf'
          }
        }));

        // Send initial greeting based on connection type
        if (!isReconnection && !hasMessages) {
          // First time ever OR new session after complete stop - initial greeting
          setTimeout(() => {
            console.log('🎤 Sending initial greeting (first time or new session)');
            openaiWs.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [
                  {
                    type: 'input_text',
                    text: 'Say "Hello there, I am Lexi. I am here to assist you in writing the self-reflection on the term paper you wrote. Can you describe your experience there?'
                  }
                ]
              }
            }));
            
            // Trigger response generation
            openaiWs.send(JSON.stringify({
              type: 'response.create',
              response: {
                modalities: ['text', 'audio']
              }
            }));
          }, 500);
        } else if (hasMessages) {
          // User paused and is now resuming - "ready to continue" message
          setTimeout(() => {
            console.log('👋 Sending welcome back message (resume after pause)');
            openaiWs.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [
                  {
                    type: 'input_text',
                    text: 'Say "Welcome back! Ready to continue?" in a friendly tone.'
                  }
                ]
              }
            }));
            
            // Trigger response generation
            openaiWs.send(JSON.stringify({
              type: 'response.create',
              response: {
                modalities: ['text', 'audio']
              }
            }));
          }, 500);
        } else {
          console.log('🔄 Auto-reconnection - no greeting');
        }
      });

      openaiWs.on('message', (data) => {
        const event = JSON.parse(data.toString());
        
        // Log important events (excluding audio deltas)
        if (event.type && !event.type.includes('audio.delta') && !event.type.includes('input_audio_buffer.append')) {
          console.log('Event:', event.type);
        }

        // User started speaking - INTERRUPT if assistant is responding
        if (event.type === 'input_audio_buffer.speech_started') {
          console.log('🎤 User started speaking');
          
          if (activeResponse && currentResponseId) {
            console.log('⚠️ Interrupting current response:', currentResponseId);
            
            // Mark current message as interrupted
            currentAssistantMessage.interrupted = true;
            currentAssistantMessage.content += '...';
            
            // Save the interrupted message
            conversationMessages.push({
              sequence: messageSequence++,
              role: currentAssistantMessage.role,
              content: currentAssistantMessage.content,
              timestamp: currentAssistantMessage.timestamp,
              interrupted: true
            });
            
            // CRITICAL: Save immediately after interruption (force)
            if (username) {
              saveConversation(username, conversationId, conversationMessages, sessionId, true);
            }
            
            // Cancel the current response
            openaiWs.send(JSON.stringify({
              type: 'response.cancel'
            }));
            
            // Notify client that response was interrupted
            clientWs.send(JSON.stringify({ type: 'response_interrupted' }));
            activeResponse = false;
            currentResponseId = null;
            
            // Reset current assistant message
            currentAssistantMessage = { role: 'assistant', content: '', timestamp: null, interrupted: false };
          }
        }

        // User stopped speaking
        if (event.type === 'input_audio_buffer.speech_stopped') {
          console.log('🔇 User stopped speaking');
        }

        // Transcription completed
        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          console.log('📝 Transcription:', event.transcript);
          
          // Save user message
          conversationMessages.push({
            sequence: messageSequence++,
            role: 'user',
            content: event.transcript,
            timestamp: new Date().toISOString()
          });
          
          // CRITICAL: Save immediately after user message (force)
          if (username) {
            saveConversation(username, conversationId, conversationMessages, sessionId, true);
          }
          
          clientWs.send(JSON.stringify({ type: 'user_transcription', text: event.transcript }));
        }

        // Response created (assistant is starting to generate)
        if (event.type === 'response.created') {
          console.log('🤖 Response created:', event.response.id);
          activeResponse = true;
          currentResponseId = event.response.id;
          
          // Initialize new assistant message
          currentAssistantMessage = {
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
            interrupted: false
          };
        }

        // Stream assistant text deltas (faster - comes before audio transcript)
        if (event.type === 'response.text.delta') {
          currentAssistantMessage.content += event.delta;
          clientWs.send(JSON.stringify({ type: 'assistant_transcript_delta', text: event.delta }));
        }
        
        // Stream assistant audio transcript deltas
        if (event.type === 'response.audio_transcript.delta') {
          currentAssistantMessage.content += event.delta;
          clientWs.send(JSON.stringify({ type: 'assistant_transcript_delta', text: event.delta }));
        }

        // Complete audio transcript (fallback for missing text)
        if (event.type === 'response.audio_transcript.done') {
          console.log('✅ Audio transcript complete:', event.transcript);
          
          // Use complete transcript if longer
          if (event.transcript.length > currentAssistantMessage.content.length) {
            currentAssistantMessage.content = event.transcript;
          }
          
          clientWs.send(JSON.stringify({ 
            type: 'assistant_transcript_complete', 
            text: event.transcript 
          }));
        }

        // Stream assistant AUDIO deltas (TTS)
        if (event.type === 'response.audio.delta') {
          clientWs.send(JSON.stringify({ type: 'assistant_audio_delta', audio: event.delta }));
        }

        // Response done
        if (event.type === 'response.done') {
          console.log('✅ Response completed');
          activeResponse = false;
          currentResponseId = null;
          
          // Save completed assistant message
          if (currentAssistantMessage.content.trim() !== '') {
            conversationMessages.push({
              sequence: messageSequence++,
              role: currentAssistantMessage.role,
              content: currentAssistantMessage.content,
              timestamp: currentAssistantMessage.timestamp,
              interrupted: false
            });
            
            // CRITICAL: Save immediately after assistant response (force)
            if (username) {
              saveConversation(username, conversationId, conversationMessages, sessionId, true);
            }
          }
          
          // Reset current assistant message
          currentAssistantMessage = { role: 'assistant', content: '', timestamp: null, interrupted: false };
          
          clientWs.send(JSON.stringify({ type: 'response_complete' }));
        }

        // Response cancelled (due to interruption)
        if (event.type === 'response.cancelled') {
          console.log('❌ Response cancelled');
          activeResponse = false;
          currentResponseId = null;
        }

        // Error handling
        if (event.type === 'error') {
          console.error('❌ OpenAI API Error:', event.error);
          
          // Reset state on error
          if (event.error.type === 'invalid_request_error') {
            activeResponse = false;
            currentResponseId = null;
          }
          
          // Don't send buffer errors to client
          if (!event.error.message.includes('buffer too small') && 
              !event.error.message.includes('active response')) {
            clientWs.send(JSON.stringify({ type: 'error', message: event.error.message }));
          }
        }
      });

      openaiWs.on('error', (err) => {
        console.error('❌ OpenAI WebSocket Error:', err.message);
        console.error('💡 Common causes:');
        console.error('   1. Invalid or expired API key');
        console.error('   2. No credits/billing not set up in OpenAI account');
        console.error('   3. Network/firewall blocking connection');
        console.error('   4. OpenAI API service issues');
        console.error('\n🔑 Check your API key at: https://platform.openai.com/api-keys');
        console.error('💳 Check billing at: https://platform.openai.com/account/billing\n');
        clientWs.send(JSON.stringify({ type: 'error', message: 'Connection error with OpenAI. Check server logs for details.' }));
      });

      openaiWs.on('close', () => {
        console.log('OpenAI connection closed');
        
        // CRITICAL: Final save when connection closes (force immediate)
        if (conversationMessages.length > 0 && username) {
          saveConversation(username, conversationId, conversationMessages, sessionId, true);
          console.log(`📊 Final conversation stats for ${username}: ${conversationMessages.length} messages`);
        }
      });
    }

    // Append audio
    if (msg.type === 'audio' && openaiWs && openaiWs.readyState === 1) {
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.audio }));
    }

    // Stop message - save conversation
    if (msg.type === 'stop') {
      const requestNewSession = msg.requestNewSession || false;
      
      console.log(`🛑 Stop received (New session requested: ${requestNewSession})`);
      
      // CRITICAL: Save current conversation before closing (force immediate)
      if (conversationMessages.length > 0 && username && conversationId) {
        console.log(`💾 Saving conversation before stop: ${username}_C_${conversationId} (${conversationMessages.length} messages)`);
        await saveConversation(username, conversationId, conversationMessages, sessionId, true);
        console.log(`✅ Conversation saved successfully`);
      } else {
        console.log('⚠️ No messages to save on stop');
      }
      
      // If requesting new session, remove from active sessions to force new row
      if (requestNewSession && sessionId) {
        activeSessions.delete(sessionId);
        console.log(`🆕 Session ${sessionId} removed - next start will create NEW row`);
      }
      
      if (openaiWs) {
        openaiWs.close();
      }
    }
    
    // Emergency save request from client
    if (msg.type === 'emergency_save') {
      console.log('🚨 Emergency save requested by client');
      if (conversationMessages.length > 0 && username && conversationId) {
        await saveConversation(username, conversationId, conversationMessages, sessionId, true);
      }
    }
  });

  clientWs.on('close', () => {
    console.log('Client disconnected');
    
    // Clear auto-save interval
    if (autoSaveInterval) {
      clearInterval(autoSaveInterval);
    }
    
    // CRITICAL: Save conversation when client disconnects (force immediate)
    if (conversationMessages.length > 0 && username && conversationId) {
      console.log(`💾 Final save on disconnect: ${username}_C_${conversationId} (${conversationMessages.length} messages)`);
      saveConversation(username, conversationId, conversationMessages, sessionId, true);
      console.log(`📊 Final conversation stats for ${username}: ${conversationMessages.length} messages`);
    }
    
    // Clean up session after a SHORT delay (5 seconds) to allow quick reconnections
    // but not so long that it prevents new sessions
    if (sessionId) {
      setTimeout(() => {
        if (activeSessions.has(sessionId)) {
          activeSessions.delete(sessionId);
          console.log(`🧹 Session cleaned up after disconnect: ${sessionId}`);
        }
      }, 5000); // Reduced from 60 seconds to 5 seconds
    }
    
    if (openaiWs) openaiWs.close();
  });

  clientWs.on('error', (err) => {
    console.error('Client WebSocket Error:', err.message);
    
    // CRITICAL: Save on error before potential crash (force immediate)
    if (conversationMessages.length > 0 && username && conversationId) {
      console.log('⚠️ Emergency save due to client error');
      saveConversation(username, conversationId, conversationMessages, sessionId, true);
    }
  });
});

server.listen(config.PORT || process.env.PORT || 3000, '0.0.0.0', () => {
  const port = config.PORT || process.env.PORT || 3000;
  console.log(`Server running on port ${port}`);
  console.log(`Local: http://localhost:${port}`);
  if (process.env.PORT) {
    console.log('🌍 Running in production mode');
  } else {
    console.log(`Local network access: http://[YOUR_IP]:${port}`);
  }
  console.log('Make sure your OpenAI API key is configured');
  console.log(`💾 Conversations will be saved to Supabase`);
  console.log('\n📱 To access from mobile:');
  console.log('1. Find your computer\'s IP address (ipconfig on Windows, ifconfig on Mac/Linux)');
  console.log(`2. On your phone, open: http://[YOUR_IP]:${port}`);
  console.log('3. Make sure your phone and computer are on the same WiFi network\n');
});
