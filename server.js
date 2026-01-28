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
  console.log('🌐 Using environment variables (production mode)');
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
const RETRY_DELAY = 2000;

// Track active sessions to prevent duplicates
const activeSessions = new Map();

// Store conversation history in memory for quick resume
const conversationHistory = new Map();

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

// Function to load existing conversation
async function loadConversation(username, conversationId) {
  console.log(`🔍 Loading conversation: ${username}_C_${conversationId}`);
  
  try {
    if (supabase) {
      const { data, error } = await supabase
        .from('conversations')
        .select('messages')
        .eq('username', username)
        .eq('conversation_id', conversationId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          console.log('📭 No existing conversation found');
          return null;
        }
        throw error;
      }

      if (data && data.messages) {
        console.log(`✅ Loaded ${data.messages.length} messages from Supabase`);
        return data.messages;
      }
    } else {
      // Try local file
      const conversationsDir = './conversations';
      const filename = `${conversationsDir}/${username}_C_${conversationId}.json`;
      
      if (fs.existsSync(filename)) {
        const data = JSON.parse(fs.readFileSync(filename));
        console.log(`✅ Loaded ${data.messages.length} messages from local file`);
        return data.messages;
      }
    }
  } catch (error) {
    console.error('❌ Error loading conversation:', error);
  }
  
  return null;
}

// Function to save conversation to Supabase with deduplication
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
  
  // Store in memory for quick resume
  const historyKey = `${username}_${conversationId}`;
  conversationHistory.set(historyKey, [...messages]);
  
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

// Fallback function for local storage
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
    console.log(`💾 Conversation saved locally: ${filename} (${conversationData.total_messages} messages)`);
  } catch (error) {
    console.error('❌ Error saving conversation to local file:', error);
  }
}

wss.on('connection', (clientWs) => {
  console.log('Client connected');
  
  let openaiWs;
  let conversationMessages = [];
  let messageSequence = 0;
  let username = null;
  let sessionId = null;
  let conversationId = null;
  let autoSaveInterval = null;
  let activeResponse = false;
  let currentResponseId = null;
  let currentAssistantMessage = { role: 'assistant', content: '', timestamp: null, interrupted: false };

  clientWs.on('message', async (data) => {
    const msg = JSON.parse(data);

    if (msg.type === 'start') {
      username = msg.username;
      sessionId = msg.sessionId;
      conversationId = msg.conversationId;
      const isReconnection = msg.isReconnection || false;
      const hasMessages = msg.hasMessages || false;

      console.log(`🎬 Start request - User: ${username}, Session: ${sessionId}, Conversation: ${conversationId}`);
      console.log(`   Reconnection: ${isReconnection}, Has messages: ${hasMessages}`);

      // Try to load existing conversation from memory first, then from database
      const historyKey = `${username}_${conversationId}`;
      let loadedMessages = conversationHistory.get(historyKey);
      
      if (!loadedMessages && hasMessages) {
        loadedMessages = await loadConversation(username, conversationId);
      }

      if (loadedMessages && loadedMessages.length > 0) {
        conversationMessages = [...loadedMessages];
        messageSequence = Math.max(...conversationMessages.map(m => m.sequence || 0)) + 1;
        console.log(`✅ Resumed conversation with ${conversationMessages.length} messages, next sequence: ${messageSequence}`);
      } else {
        conversationMessages = [];
        messageSequence = 0;
        console.log(`🆕 Starting new conversation`);
      }

      // Auto-save every 10 seconds
      autoSaveInterval = setInterval(() => {
        if (conversationMessages.length > 0 && username && conversationId) {
          saveConversation(username, conversationId, conversationMessages, sessionId, false);
        }
      }, 10000);

      const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';
      openaiWs = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${config.OPENAI_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      openaiWs.on('open', () => {
        console.log('Connected to OpenAI Realtime API');

        // Build conversation items from history
        const conversationItems = [];
        
        for (const msg of conversationMessages) {
          if (msg.role === 'user') {
            conversationItems.push({
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: msg.content }]
            });
          } else if (msg.role === 'assistant' && msg.content.trim() !== '') {
            conversationItems.push({
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: msg.content }]
            });
          }
        }

        const sessionConfig = {
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: hasMessages && conversationMessages.length > 0 
              ? "You are a helpful AI assistant. Continue the conversation naturally based on the history provided. Do not re-introduce yourself or repeat previous greetings."
              : "You are a helpful and friendly AI voice assistant. Greet the user warmly and ask how you can help them today.",
            voice: 'alloy',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500
            },
            temperature: 0.8,
            max_response_output_tokens: 4096
          }
        };

        openaiWs.send(JSON.stringify(sessionConfig));
        console.log('✅ Session configured with OpenAI');

        // If we have conversation history, send it to maintain context
        if (conversationItems.length > 0) {
          console.log(`📜 Sending ${conversationItems.length} conversation items to OpenAI for context`);
          
          for (const item of conversationItems) {
            openaiWs.send(JSON.stringify({
              type: 'conversation.item.create',
              item: item
            }));
          }
          
          console.log('✅ Conversation history sent to OpenAI');
        }
      });

      openaiWs.on('message', (message) => {
        const event = JSON.parse(message);

        if (event.type !== 'response.audio.delta' && 
            event.type !== 'input_audio_buffer.speech_started' &&
            event.type !== 'input_audio_buffer.speech_stopped') {
          console.log('Event:', event.type);
        }

        if (event.type === 'input_audio_buffer.speech_started') {
          console.log('🎤 User started speaking');
          
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
            
            openaiWs.send(JSON.stringify({
              type: 'response.cancel'
            }));
            
            clientWs.send(JSON.stringify({ type: 'response_interrupted' }));
            activeResponse = false;
            currentResponseId = null;
            
            currentAssistantMessage = { role: 'assistant', content: '', timestamp: null, interrupted: false };
          }
        }

        if (event.type === 'input_audio_buffer.speech_stopped') {
          console.log('🔇 User stopped speaking');
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
          
          clientWs.send(JSON.stringify({ 
            type: 'assistant_transcript_complete', 
            text: event.transcript 
          }));
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
        clientWs.send(JSON.stringify({ type: 'error', message: 'Connection error with OpenAI. Check server logs for details.' }));
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
      console.log(`🛑 Stop received - preserving conversation state`);
      
      if (conversationMessages.length > 0 && username && conversationId) {
        console.log(`💾 Saving conversation before stop: ${username}_C_${conversationId} (${conversationMessages.length} messages)`);
        await saveConversation(username, conversationId, conversationMessages, sessionId, true);
        console.log(`✅ Conversation saved - ready to resume`);
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
  console.log('💾 Conversations will be saved to Supabase');
});
