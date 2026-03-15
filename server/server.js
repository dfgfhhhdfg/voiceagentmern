require('dotenv').config();
const express    = require('express');
const http       = require('http');
const socketIo   = require('socket.io');
const cors       = require('cors');
const mongoose   = require('mongoose');
const jwt        = require('jsonwebtoken');

const connectDB          = require('./config/database');
const appointmentRoutes  = require('./routes/appointmentRoutes');
const agentRoutes        = require('./routes/agentRoutes');
const voiceAgentService  = require('./services/voiceAgentService');
const sttService         = require('./services/sttService');
const authRoutes         = require('./routes/Authroutes');
const doctorRoutes       = require('./routes/Doctorroutes');
const Patient            = require('./models/usermodel');
const Doctor             = require('./models/doctor');

const app    = express();
const server = http.createServer(app);

const corsOptions = {
  origin:         ['http://localhost:3000','http://localhost:3001'],
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials:    true,
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));

const io = socketIo(server, {
  cors:          corsOptions,
  transports:    ['websocket', 'polling'],
  pingTimeout:   60000,
  pingInterval:  25000,
});

connectDB();
console.log("after");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/appointments', appointmentRoutes);
app.use('/api/agent',agentRoutes);
app.use('/api/auth',authRoutes);
app.use('/api/doctors',doctorRoutes);

app.get('/health', (req, res) => {
  res.json({
    status:            'OK',
    timestamp:         new Date(),
    socketConnections: io.engine.clientsCount,
    services: {
      deepgram: process.env.DEEPGRAM_API_KEY ? 'configured' : 'missing',
      mongodb:  mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    },
  });
});

/* ===============================
   JWT HELPER FOR SOCKETS
================================ */
async function resolvePatientFromSocket(socket) {
  try {
    const raw = socket.handshake.auth?.token || socket.handshake.headers?.authorization;
    if (!raw) return null;
    const token   = raw.replace(/^Bearer\s+/i, '').trim();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    let user;
    if (decoded.role === 'doctor') {
      user = await Doctor.findById(decoded.id).select('-password');
    } else {
      user = await Patient.findById(decoded.id).select('-password');
    }
    if (!user) return null;
    console.log(`🔐 Authenticated socket user: ${user.name} <${user.email}> [${decoded.role}]`);
    return {
      name:  user.name  || null,
      email: user.email || null,
      phone: user.phone || user.patientPhone || null,
      role:  decoded.role,
    };
  } catch (err) {
    console.warn(`⚠️  Socket JWT decode failed: ${err.message}`);
    return null;
  }
}

/* ===============================
   RECONNECT CONFIG
================================ */
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS  = 30000;
const RECONNECT_MAX_ATTEMPTS  = 5;

const isPermanentError = (message = '') => {
  const msg = message.toLowerCase();
  return (
    msg.includes('400') || msg.includes('401') || msg.includes('403') ||
    msg.includes('invalid api key') || msg.includes('unauthorized')
  );
};

/* ===============================
   SOCKET / VOICE SYSTEM
================================ */
console.log("srever ");

io.on('connection', async (socket) => {
  console.log(`✅ Client connected: ${socket.id}`);

  let patientContext     = await resolvePatientFromSocket(socket);
  let conversationId     = null;
  let deepgramConnection = null;
  let isDeepgramOpen     = false;
  let isCallActive       = false;
  let isalexSpeaking    = false;
  let sessionSampleRate  = 16000;
  let audioQueue         = [];
  let readyCheckInterval = null;
  let reconnectAttempts  = 0;
  let reconnectTimer     = null;

  // ── FIX 1: keepAlive runs for the ENTIRE call, not just while alex speaks.
  // Deepgram 1011 fires when NO data arrives for ~10s — this happens during
  // TTS playback. Sending KeepAlive every 8s prevents it unconditionally.
  let keepAliveInterval  = null;

  const startKeepAlive = () => {
    if (keepAliveInterval) return; // already running
    keepAliveInterval = setInterval(() => {
      if (deepgramConnection && isDeepgramOpen) {
        sttService.sendKeepAlive(deepgramConnection);
      }
    }, 8000);
  };

  const stopKeepAlive = () => {
    if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
  };

  // Emit personalised greeting immediately on connect
  const greeting = patientContext?.name
    ? `Hello ${patientContext.name}! Welcome back to SmileCare Dental. I'm alex. How can I help you today?`
    : `Hello! Welcome to SmileCare Dental. I'm alex, your virtual assistant. How can I help you today?`;
  socket.emit('assistant-response', { text: greeting, isFinal: true, timestamp: new Date() });

  /* ----------------------------
     Helpers
  ---------------------------- */
  const toBuffer = (data) => {
    if (Buffer.isBuffer(data))       return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (data?.buffer)                return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return Buffer.from(data);
  };

  const flushQueue = () => {
    if (!audioQueue.length) return;
    console.log(`📤 Flushing ${audioQueue.length} audio chunks`);
    audioQueue.forEach(chunk => { try { deepgramConnection.send(chunk); } catch {} });
    audioQueue = [];
  };

  const clearTimers = () => {
    if (readyCheckInterval) { clearInterval(readyCheckInterval); readyCheckInterval = null; }
    if (reconnectTimer)     { clearTimeout(reconnectTimer);      reconnectTimer     = null; }
    // NOTE: keepAlive is NOT cleared here — it stays alive for the whole call
  };

  const closeDeepgram = () => {
    clearTimers();
    stopKeepAlive(); // only stop keepAlive when the session fully ends
    isDeepgramOpen = false;
    audioQueue     = [];
    if (deepgramConnection) {
      try { sttService.closeConnection(deepgramConnection); } catch {}
      deepgramConnection = null;
    }
  };

  /* ----------------------------
     Deepgram Connection
  ---------------------------- */
  const openDeepgramConnection = () => {
    clearTimers();
    if (!isCallActive) return;

    if (!process.env.DEEPGRAM_API_KEY) {
      console.error('❌ DEEPGRAM_API_KEY is not set');
      socket.emit('error', { message: 'Deepgram API key is missing.' });
      isCallActive = false;
      return;
    }

    if (deepgramConnection) {
      try { sttService.closeConnection(deepgramConnection); } catch {}
      deepgramConnection = null;
    }

    console.log(`🔊 Opening Deepgram @ ${sessionSampleRate}Hz (attempt ${reconnectAttempts + 1}/${RECONNECT_MAX_ATTEMPTS})`);

    deepgramConnection = sttService.createLiveConnection(
      sessionSampleRate,

      /* onTranscript */
      async (transcriptData) => {
        // FIX 2: Don't silently swallow transcripts while alex speaks.
        // Just skip sending to AI — still reset reconnect counter.
        reconnectAttempts = 0;
        socket.emit('transcript', transcriptData);

        if (isalexSpeaking) return; // gate AI while alex speaks
        if (!transcriptData.isFinal || !transcriptData.text.trim()) return;

        try {
          socket.emit('typing', true);
          const response = await voiceAgentService.processUserInput(
            transcriptData.text,
            conversationId,
            patientContext
          );

          if (!response.text || response.suppressed) {
            socket.emit('typing', false);
            return;
          }

          if (!conversationId && response.conversationId) {
            conversationId = response.conversationId;
          }

          socket.emit('typing', false);
          socket.emit('assistant-response', {
            text:           response.text,
            conversationId: response.conversationId,
            isFinal:        true,
            timestamp:      new Date(),
          });
          console.log(`🤖 alex: ${response.text}`);

        } catch (err) {
          console.error('AI error:', err);
          socket.emit('typing', false);
          socket.emit('error', { message: 'AI processing failed' });
        }
      },

      /* onError */
      (err) => {
        const msg = err?.message || String(err);
        console.error('❌ Deepgram WS error:', msg);
        isDeepgramOpen = false;
        if (isPermanentError(msg)) {
          console.error('🚫 Permanent Deepgram error — stopping reconnects.');
          socket.emit('error', { message: `Deepgram error: ${msg}` });
          isCallActive = false;
        }
      },

      /* onClose */
      (code, reason) => {
        console.log(`🔌 Deepgram closed — code: ${code}, reason: ${reason}`);
        isDeepgramOpen     = false;
        deepgramConnection = null;

        // FIX 3: On reconnect, keepAlive keeps running so the NEW connection
        // also stays alive immediately after it opens. No gap.

        if (!isCallActive) return;

        // code 1000 = clean close (stop-voice-session) — don't reconnect
        if (code === 1000) return;

        reconnectAttempts++;
        if (reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
          console.error(`🚫 Deepgram failed after ${RECONNECT_MAX_ATTEMPTS} attempts — giving up.`);
          socket.emit('error', { message: `Could not connect to Deepgram after ${RECONNECT_MAX_ATTEMPTS} attempts.` });
          isCallActive = false;
          return;
        }

        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts - 1),
          RECONNECT_MAX_DELAY_MS
        );
        console.log(`🔄 Reconnecting Deepgram in ${delay}ms (attempt ${reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})…`);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (isCallActive) openDeepgramConnection();
        }, delay);
      }
    );

    /* Wait for ready then start keepAlive */
    let elapsed = 0;
    readyCheckInterval = setInterval(() => {
      elapsed += 50;
      if (deepgramConnection?.readyState === 1) {
        isDeepgramOpen    = true;
        reconnectAttempts = 0;
        clearInterval(readyCheckInterval);
        readyCheckInterval = null;
        flushQueue();
        startKeepAlive(); // FIX 1: start unconditional keepAlive on open
        socket.emit('session-started', { status: 'ready', sampleRate: sessionSampleRate });
        console.log(`✅ Deepgram ready (${elapsed}ms)`);
      }
      if (elapsed > 5000) {
        clearInterval(readyCheckInterval);
        readyCheckInterval = null;
        console.warn('⚠️ Deepgram readyState timeout');
      }
    }, 50);
  };

  /* ----------------------------
     Start Voice Session
  ---------------------------- */
  socket.on('start-voice-session', async (options = {}) => {
    sessionSampleRate = options.sampleRate || 16000;
    isCallActive      = true;
    isalexSpeaking   = false;
    reconnectAttempts = 0;

    if (!patientContext && options.authToken) {
      try {
        const token   = options.authToken.replace(/^Bearer\s+/i, '').trim();
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user    = decoded.role === 'doctor'
          ? await Doctor.findById(decoded.id).select('-password')
          : await Patient.findById(decoded.id).select('-password');
        if (user) {
          patientContext = {
            name:  user.name  || null,
            email: user.email || null,
            phone: user.phone || user.patientPhone || null,
            role:  decoded.role,
          };
          console.log(`🔐 Late-auth user: ${patientContext.name} <${patientContext.email}>`);
        }
      } catch (e) {
        console.warn('⚠️  start-voice-session token decode failed:', e.message);
      }
    }

    console.log(`🎤 Voice session started${patientContext ? ` for ${patientContext.name}` : ' (guest)'}`);
    openDeepgramConnection();

    // FIX 4: Don't re-emit greeting on start-voice-session — it was already
    // sent on socket connect. Sending it twice makes alex speak twice.
  });

  /* ----------------------------
     Patient Details & Location
  ---------------------------- */
  socket.on('patient-details', ({ name, email }) => {
    patientContext = patientContext
      ? { ...patientContext, name, email }
      : { name, email };
    console.log(`👤 Patient details updated: ${name}, ${email}`);
  });

  socket.on('patient-location', ({ lat, lng }) => {
    patientContext = patientContext
      ? { ...patientContext, lat, lng }
      : { lat, lng };
    console.log(`📍 Patient location updated: ${lat}, ${lng}`);
  });

  /* ----------------------------
     Audio Streaming
  ---------------------------- */
  socket.on('audio-chunk', (rawChunk) => {
    if (!isCallActive || isalexSpeaking) return;
    const buffer = toBuffer(rawChunk);
    if (!buffer?.length) return;
    try {
      if (isDeepgramOpen) {
        deepgramConnection.send(buffer);
      } else {
        audioQueue.push(buffer);
        if (audioQueue.length > 200) audioQueue.shift();
      }
    } catch (err) {
      console.error('audio send error:', err);
    }
  });

  /* ----------------------------
     alex Speaking Gate
     FIX 1: keepAlive now runs for the ENTIRE call.
     alex-speaking only controls the mic gate and audio queue.
  ---------------------------- */
  socket.on('alex-speaking', (speaking) => {
    isalexSpeaking = speaking;
    if (speaking) {
      console.log('🔇 alex speaking - mic gate closed');
      audioQueue = []; // discard any mic audio buffered before gate closed
    } else {
      console.log('🎙️ alex finished speaking');
    }
    // keepAlive intentionally NOT touched here — it runs throughout the call
  });

  /* ----------------------------
     Stop Voice Session
  ---------------------------- */
  socket.on('stop-voice-session', () => {
    console.log('🛑 Voice session stopped');
    isCallActive      = false;
    isalexSpeaking   = false;
    reconnectAttempts = 0;
    closeDeepgram(); // this calls stopKeepAlive()
  });

  /* ----------------------------
     Disconnect
  ---------------------------- */
  socket.on('disconnect', (reason) => {
    console.log(`❌ Client disconnected: ${reason}`);
    isCallActive      = false;
    isalexSpeaking   = false;
    reconnectAttempts = 0;
    closeDeepgram();
    conversationId = null;
  });
});

/* ===============================
   ERROR HANDLING
================================ */
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, error: 'Server error' });
});

app.use((req, res) =>
  res.status(404).json({ success: false, error: 'Route not found' })
);

/* ===============================
   START SERVER
================================ */
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════╗
║  🦷 SmileCare Voice Server       ║
╠══════════════════════════════════╣
║  http://localhost:${PORT}         ║
║  Deepgram: ${process.env.DEEPGRAM_API_KEY ? '✅' : '❌ MISSING KEY'}            ║
╚══════════════════════════════════╝
`);
});

const shutdown = (sig) => {
  console.log(`${sig} shutting down`);
  io.close(() => {
    mongoose.connection.close(false, () => process.exit(0));
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = { app, server, io };


