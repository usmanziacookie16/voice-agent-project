import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

// Load config
let config = {
  PORT: process.env.PORT || 3000,
  OPENAI_KEY: process.env.OPENAI_KEY,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY
};

if (fs.existsSync('./config.json')) {
  const fileConfig = JSON.parse(fs.readFileSync('./config.json'));
  config = { ...config, ...fileConfig };
  console.log('📋 Using config.json (development mode)');
} else {
  console.log('☁️  Using environment variables (production mode)');
}

if (!config.OPENAI_KEY || !config.SUPABASE_URL || !config.SUPABASE_KEY) {
  console.error('❌ Missing required configuration!');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files from the 'client' directory
const clientPath = './client';
if (!fs.existsSync(clientPath)) {
    console.warn(`⚠️ Warning: Client folder not found at ${clientPath}. Ensure your folder structure is:
    /main
      |-- server.js
      |-- config.json
      |-- package.json
      |-- /client
           |-- index.html
           |-- ...
    `);
}

app.use(express.static(clientPath));
console.log(`📂 Serving static files from: ${clientPath}`);

app.use(express.json());

// Auth Routes
app.post('/api/signup', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const { data, error } = await supabase
      .from('users')
      .insert([{ username, password }])
      .select();

    if (error) {
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

// Supabase
const supabaseUrl = config.SUPABASE_URL;
const supabaseKey = config.SUPABASE_KEY;
let supabase;

const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;

const activeSessions = new Map();

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

async function saveConversation(username, conversationId, messages, sessionId = null, forceImmediate = false) {
  if (!messages || messages.length === 0) {
    console.log('⏭️ No messages to save');
    return;
  }

  if (!forceImmediate && sessionId && activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    const now = Date.now();
    
    if (session.messageCount === messages.length) {
      console.log(`⏭️ Skipped save (no new messages): ${username}_C`);
      return;
    }
    
    if (session.lastSaveTime && (now - session.lastSaveTime) < 1000) {
      console.log(`⏭️ Skipped save (debounce): ${username}_C`);
      return;
    }
    
    session.messageCount = messages.length;
    session.lastSaveTime = now;
  } else if (sessionId) {
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
    condition: 'C',
    timestamp: new Date().toISOString(),
    messages: messages,
    total_messages: messages.length,
    updated_at: new Date().toISOString()
  };
  
  try {
    if (supabase) {
      await retryOperation(async () => {
        const { data: existing, error: selectError } = await supabase
          .from('conversations')
          .select('id, total_messages')
          .eq('username', username)
          .eq('conversation_id', conversationId)
          .single();

        if (selectError && selectError.code !== 'PGRST116') {
          throw selectError;
        }

        if (existing) {
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
          const { error: insertError } = await supabase
            .from('conversations')
            .insert([conversationData]);
          
          if (insertError) {
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
      saveFallbackLocal(username, conversationId, conversationData);
    }
  } catch (error) {
    console.error('❌ Error saving conversation:', error);
    saveFallbackLocal(username, conversationId, conversationData);
  }
}

function saveFallbackLocal(username, conversationId, conversationData) {
  try {
    const conversationsDir = './conversations';
    if (!fs.existsSync(conversationsDir)) {
      fs.mkdirSync(conversationsDir);
    }
    const filename = `${conversationsDir}/${username}_C_${conversationId}.json`;
    
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
  
  let lastSavedMessageCount = 0;
  const autoSaveInterval = setInterval(() => {
    if (conversationMessages.length > lastSavedMessageCount && username && conversationId) {
      console.log('⏰ Auto-save triggered (10s interval)');
      saveConversation(username, conversationId, conversationMessages, sessionId, false);
      lastSavedMessageCount = conversationMessages.length;
    }
  }, 10000);

  clientWs.on('message', async (message) => {
    const msg = JSON.parse(message);

    if (msg.type === 'start') {
      username = msg.username || 'anonymous';
      sessionId = msg.sessionId || Date.now();
      conversationId = msg.conversationId || sessionId;
      isReconnection = msg.isReconnection || false;
      const hasMessages = msg.hasMessages || false;
      const isPauseResume = msg.isPauseResume || false;
      
      // NEW: Get previous messages to restore context
      const previousMessages = msg.previousMessages || [];
      
      console.log(`👤 User: ${username} | Session: ${sessionId} | Conversation: ${conversationId} | Reconnection: ${isReconnection} | Messages: ${previousMessages.length} | Pause Resume: ${isPauseResume}`);
      
      // If we received previous messages (resuming a session), populate local array
      if (previousMessages.length > 0 && conversationMessages.length === 0) {
        previousMessages.forEach(m => conversationMessages.push(m));
        messageSequence = conversationMessages.length;
        console.log(`📥 Loaded ${conversationMessages.length} messages into local memory`);
      }

      if (activeSessions.has(sessionId)) {
        const existingConversationId = activeSessions.get(sessionId).conversationId;
        console.log(`🔄 Reconnecting to existing conversation: ${existingConversationId}`);
      } else {
        console.log(`🆕 Using conversation: ${conversationId}`);
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
        
        // 1. Send Session Update
        openaiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: `Act as a facilitator to help the user write a self-reflection. The user recently wrote a term paper. Your task is to facilitate the user writing the self-reflection via multi-turn dialogue
You will ask open-ended questions that should align with the six stages of Gibbs’ Reflective Cycle in this order: Description, Feelings, Evaluation, Analysis, Conclusion, and Action Plan. You are to remain implicit regarding the phases of Gibbs’ Reflective Cycle throughout the session.
 
At the start of each phase, ask one of the following questions in this order and with exactly the same wording as they are written below:
1. Can you describe the process of writing your term paper, from planning to completion?
2. How did you feel while working on the term paper, especially during challenging moments?
3. What aspects of your term paper do you think went well, and what didn’t work as effectively?
4. Why do you think certain parts of the process were successful or unsuccessful? Were there any factors or strategies that contributed to the outcome?
5. What have you learned from writing this term paper, both about the subject and your own writing process?
6. What will you do differently in your next term paper to improve your approach and results?
 
 
Ask follow-up questions if the response is brief or lacks detail. Please ask at least one follow-up question per phase and not more than three follow-up questions per phase. Ask specific questions rather than generic questions. Request specific examples from the user. If the student mentions a shift in views, prompt him for examples from his experience that illustrate this change. Do not give any examples and don’t do the reflection for the user.
Do Not Respond with more than 1-3 sentences or questions. Always respond in English Language.
 
Provide feedback on each answer provided by the user. The feedback should focus on the level of reflection rather than the content of the experience. Encourage, supervise, and incorporate social and personal values.`,
            voice: 'alloy',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: { 
              type: 'server_vad', 
              threshold: 0.6,
              prefix_padding_ms: 300,
              silence_duration_ms: 2000
            },
            temperature: 1.0,
            max_response_output_tokens: 800
          }
        }));

        // 2. Restore Conversation History for OpenAI Context
        if (previousMessages.length > 0) {
            console.log(`🔄 Restoring context for OpenAI (${previousMessages.length} items)...`);
            previousMessages.forEach(msg => {
                if (msg.role === 'user' || msg.role === 'assistant') {
                    const item = {
                        type: 'conversation.item.create',
                        item: {
                            type: 'message',
                            role: msg.role,
                            content: [
                                {
                                    type: msg.role === 'user' ? 'input_text' : 'text',
                                    text: msg.content
                                }
                            ]
                        }
                    };
                    // OpenAI expects just the content, no timestamp in the item
                    openaiWs.send(JSON.stringify(item));
                }
            });
            console.log('✅ Context restored.');
        }

        // 3. Greeting (Only if NEW session and NO history)
        if (!isReconnection && !hasMessages && previousMessages.length === 0) {
          setTimeout(() => {
            console.log('🎤 Sending initial greeting (first time)');
            openaiWs.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [{
                  type: 'input_text',
                  text: 'Say "Hello there, I am Lexi. I am here to assist you in writing the self-reflection on the term paper you wrote. Can you describe your experience there?"'
                }]
              }
            }));
            
            openaiWs.send(JSON.stringify({
              type: 'response.create',
              response: { modalities: ['text', 'audio'] }
            }));
          }, 500);
        } else {
          console.log('🔄 Resuming silently (pause resume or reconnection) - Waiting for user input');
        }
      });

      openaiWs.on('message', (data) => {
        const event = JSON.parse(data.toString());
        
        if (event.type && !event.type.includes('audio.delta') && !event.type.includes('input_audio_buffer.append')) {
          // Reduce log noise
          if (event.type !== 'response.audio_transcript.delta' && event.type !== 'response.text.delta') {
             console.log('Event:', event.type);
          }
        }

        if (event.type === 'input_audio_buffer.speech_started') {
          console.log('🎤 User started speaking');
          clientWs.send(JSON.stringify({ type: 'speech_started' }));
          
          if (activeResponse && currentResponseId) {
            console.log('⚠️ Interrupting current response:', currentResponseId);
            
            currentAssistantMessage.interrupted = true;
            currentAssistantMessage.content += '...';
            
            conversationMessages.push({
              sequence: messageSequence++,
              role: currentAssistantMessage.role,
              content: currentAssistantMessage.content,
              timestamp: currentAssistantMessage.timestamp,
              interrupted: true
            });
            
            if (username) {
              saveConversation(username, conversationId, conversationMessages, sessionId, true);
            }
            
            openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
            clientWs.send(JSON.stringify({ type: 'response_interrupted' }));
            activeResponse = false;
            currentResponseId = null;
            currentAssistantMessage = { role: 'assistant', content: '', timestamp: null, interrupted: false };
          }
        }

        if (event.type === 'input_audio_buffer.speech_stopped') {
          console.log('⏹️ User stopped speaking');
          clientWs.send(JSON.stringify({ type: 'speech_stopped' }));
        }

        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          console.log('📝 Transcription:', event.transcript);
          
          conversationMessages.push({
            sequence: messageSequence++,
            role: 'user',
            content: event.transcript,
            timestamp: new Date().toISOString()
          });
          
          if (username) {
            saveConversation(username, conversationId, conversationMessages, sessionId, true);
          }
          
          clientWs.send(JSON.stringify({ type: 'user_transcription', text: event.transcript }));
        }

        if (event.type === 'response.created') {
          console.log('🤖 Response created:', event.response.id);
          activeResponse = true;
          currentResponseId = event.response.id;
          
          // Send thinking indicator to client
          clientWs.send(JSON.stringify({ type: 'response_creating' }));
          
          currentAssistantMessage = {
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
            interrupted: false
          };
        }

        if (event.type === 'response.text.delta') {
          currentAssistantMessage.content += event.delta;
          clientWs.send(JSON.stringify({ type: 'assistant_transcript_delta', text: event.delta }));
        }
        
        if (event.type === 'response.audio_transcript.delta') {
          currentAssistantMessage.content += event.delta;
          clientWs.send(JSON.stringify({ type: 'assistant_transcript_delta', text: event.delta }));
        }

        if (event.type === 'response.audio_transcript.done') {
          console.log('✅ Audio transcript complete:', event.transcript);
          
          if (event.transcript.length > currentAssistantMessage.content.length) {
            currentAssistantMessage.content = event.transcript;
          }
          
          clientWs.send(JSON.stringify({ type: 'assistant_transcript_complete', text: event.transcript }));
        }

        if (event.type === 'response.audio.delta') {
          clientWs.send(JSON.stringify({ type: 'assistant_audio_delta', audio: event.delta }));
        }

        if (event.type === 'response.done') {
          console.log('✅ Response completed');
          activeResponse = false;
          currentResponseId = null;
          
          if (currentAssistantMessage.content.trim() !== '') {
            conversationMessages.push({
              sequence: messageSequence++,
              role: currentAssistantMessage.role,
              content: currentAssistantMessage.content,
              timestamp: currentAssistantMessage.timestamp,
              interrupted: false
            });
            
            if (username) {
              saveConversation(username, conversationId, conversationMessages, sessionId, true);
            }
          }
          
          currentAssistantMessage = { role: 'assistant', content: '', timestamp: null, interrupted: false };
          clientWs.send(JSON.stringify({ type: 'response_complete' }));
        }

        if (event.type === 'response.cancelled') {
          console.log('❌ Response cancelled');
          activeResponse = false;
          currentResponseId = null;
        }

        if (event.type === 'error') {
          console.error('❌ OpenAI API Error:', event.error);
          
          if (event.error.type === 'invalid_request_error') {
            activeResponse = false;
            currentResponseId = null;
          }
          
          if (!event.error.message.includes('buffer too small') && 
              !event.error.message.includes('active response')) {
            clientWs.send(JSON.stringify({ type: 'error', message: event.error.message }));
          }
        }
      });

      openaiWs.on('error', (err) => {
        console.error('❌ OpenAI WebSocket Error:', err.message);
        clientWs.send(JSON.stringify({ type: 'error', message: 'Connection error with OpenAI.' }));
      });

      openaiWs.on('close', () => {
        console.log('OpenAI connection closed');
        
        if (conversationMessages.length > 0 && username) {
          saveConversation(username, conversationId, conversationMessages, sessionId, true);
          console.log(`📊 Final conversation stats for ${username}: ${conversationMessages.length} messages`);
        }
      });
    }

    if (msg.type === 'audio' && openaiWs && openaiWs.readyState === 1) {
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.audio }));
    }

    if (msg.type === 'stop') {
      const requestNewSession = msg.requestNewSession || false;
      
      console.log(`🛑 Stop received (New session requested: ${requestNewSession})`);
      
      if (conversationMessages.length > 0 && username && conversationId) {
        console.log(`💾 Saving conversation before stop: ${username}_C_${conversationId} (${conversationMessages.length} messages)`);
        await saveConversation(username, conversationId, conversationMessages, sessionId, true);
        console.log(`✅ Conversation saved successfully`);
      } else {
        console.log('⚠️ No messages to save on stop');
      }
      
      if (requestNewSession && sessionId) {
        activeSessions.delete(sessionId);
        console.log(`🆕 Session ${sessionId} removed - next start will create NEW row`);
      }
      
      if (openaiWs) {
        openaiWs.close();
      }
    }
    
    if (msg.type === 'emergency_save') {
      console.log('🚨 Emergency save requested by client');
      if (conversationMessages.length > 0 && username && conversationId) {
        await saveConversation(username, conversationId, conversationMessages, sessionId, true);
      }
    }
  });

  clientWs.on('close', () => {
    console.log('Client disconnected');
    
    if (autoSaveInterval) {
      clearInterval(autoSaveInterval);
    }
    
    if (conversationMessages.length > 0 && username && conversationId) {
      console.log(`💾 Final save on disconnect: ${username}_C_${conversationId} (${conversationMessages.length} messages)`);
      saveConversation(username, conversationId, conversationMessages, sessionId, true);
      console.log(`📊 Final conversation stats for ${username}: ${conversationMessages.length} messages`);
    }
    
    if (sessionId) {
      setTimeout(() => {
        if (activeSessions.has(sessionId)) {
          activeSessions.delete(sessionId);
          console.log(`🧹 Session cleaned up after disconnect: ${sessionId}`);
        }
      }, 5000);
    }
    
    if (openaiWs) openaiWs.close();
  });

  clientWs.on('error', (err) => {
    console.error('Client WebSocket Error:', err.message);
    
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
  console.log('💾 Conversations will be saved to Supabase');
});