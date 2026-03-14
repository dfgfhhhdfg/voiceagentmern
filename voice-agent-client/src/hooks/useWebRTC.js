import { useEffect, useRef, useState, useCallback } from "react";
import io from "socket.io-client";

export const useWebRTC = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [assistantMessage, setAssistantMessage] = useState("");
  const [error, setError] = useState(null);
  const [audioLevel, setAudioLevel] = useState(0);

  const socketRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const processorRef = useRef(null);
  const animationFrameRef = useRef(null);
  const isSpeakingRef = useRef(false);
  const isMutedRef = useRef(false);
  const bargeInRef = useRef(false);
  const bargeFramesRef = useRef(0);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  /* =========================================================
     PRE-LOAD TTS VOICES
  ========================================================= */
  useEffect(() => {
    const load = () => window.speechSynthesis.getVoices();
    if (window.speechSynthesis.getVoices().length > 0) load();
    else
      window.speechSynthesis.addEventListener("voiceschanged", load, {
        once: true,
      });
    return () =>
      window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  /* =========================================================
     SOCKET CONNECTION
     — token passed in handshake.auth so server.js can identify
       the logged-in patient and skip asking for name/email
  ========================================================= */
  useEffect(() => {
    const socketUrl =
      import.meta.env.VITE_SOCKET_URL || "http://localhost:5000";

    // ── CHANGE 1: read JWT from localStorage and pass in auth ──
    const token = localStorage.getItem("token");
    if (token) console.log("Token exists:", token.substring(0, 20) + "...");

    socketRef.current = io(socketUrl, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      auth: {
        token: token ? `Bearer ${token}` : null, // ← server reads this
      },
    });

    socketRef.current.on("connect", () => {
      console.log("✅ Socket connected:", socketRef.current.id);
      setError(null);
    });

    socketRef.current.on("assistant-response", (data) => {
      console.log("🤖 Sarah:", data.text);
      setAssistantMessage(data.text);
      speakText(data.text);
    });

    socketRef.current.on("transcript", (data) => {
      setTranscript(data.text);
      setIsListening(!data.isFinal);
    });

    socketRef.current.on("session-started", (data) => {
      console.log("🎤 Session ready:", data);
    });

    socketRef.current.on("error", (err) => {
      console.error("🔴 Server error:", err);
      setError(err?.message || "Unknown error");
    });

    socketRef.current.on("connect_error", (err) => {
      setError(`Connection failed: ${err.message}`);
    });

    socketRef.current.on("disconnect", (reason) => {
      setIsConnected(false);
      if (reason === "io server disconnect") socketRef.current.connect();
    });

    return () => socketRef.current?.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* =========================================================
     SET SPEAKING STATE
  ========================================================= */
  const setSpeaking = useCallback((speaking) => {
    isSpeakingRef.current = speaking;
    setIsSpeaking(speaking);
    socketRef.current?.emit("sarah-speaking", speaking);

    if (!speaking) {
      bargeInRef.current = false;
      bargeFramesRef.current = 0;
      if (!isMutedRef.current) {
        streamRef.current?.getAudioTracks().forEach((t) => {
          t.enabled = true;
        });
      }
      setIsListening(false);
      setTranscript("");
    }
  }, []);

  /* =========================================================
     TEXT TO SPEECH
  ========================================================= */
  const speakText = useCallback(
    (text) => {
      if (!text?.trim()) return;
      try {
        window.speechSynthesis.cancel();
        setSpeaking(true);
        console.log("🔇 Mic gated — Sarah speaking");

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "en-US";
        utterance.rate = 1.0;
        utterance.pitch = 1.0;

        const voices = window.speechSynthesis.getVoices();
        const male = voices.find(
          (v) =>
            /male|man|alex|daniel|fred|google us english|microsoft david|microsoft mark|microsoft ryan/i.test(
              v.name,
            ) ||
            (v.lang === "en-US" && /male|man/.test(v.name.toLowerCase())),
        );
        if (male) utterance.voice = male;

        const done = () => {
          setTimeout(() => {
            setSpeaking(false);
            console.log("🎙️ Mic re-enabled");
          }, 800);
        };

        utterance.onend = done;
        utterance.onerror = (e) => {
          if (e.error !== "interrupted") console.error("TTS error:", e.error);
          done();
        };

        window.speechSynthesis.speak(utterance);
      } catch (err) {
        console.error("TTS error:", err);
        setSpeaking(false);
      }
    },
    [setSpeaking],
  );

  /* =========================================================
     AUDIO VISUALIZER
  ========================================================= */
  const analyzeAudio = useCallback(() => {
    if (!analyserRef.current) return;
    const data = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(data);
    setAudioLevel(data.reduce((a, b) => a + b, 0) / data.length / 128);
    animationFrameRef.current = requestAnimationFrame(analyzeAudio);
  }, []);

  /* =========================================================
     START CALL
  ========================================================= */
  const startCall = useCallback(async () => {
    try {
      console.log("🎙️ Starting call...");
      setError(null);

      streamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      console.log("✅ Microphone granted");

      audioContextRef.current = new (
        window.AudioContext || window.webkitAudioContext
      )({ sampleRate: 16000 });
      const actualRate = audioContextRef.current.sampleRate;
      console.log("🎵 Sample rate:", actualRate);

      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;

      const source = audioContextRef.current.createMediaStreamSource(
        streamRef.current,
      );
      source.connect(analyserRef.current);
      analyzeAudio();

      processorRef.current = audioContextRef.current.createScriptProcessor(
        4096,
        1,
        1,
      );
      processorRef.current.onaudioprocess = (event) => {
        if (!socketRef.current?.connected) return;
        const float32 = event.inputBuffer.getChannelData(0);
        // If Sarah is speaking, only allow audio after a real barge-in.
        if (isSpeakingRef.current && !bargeInRef.current) {
          let sum = 0;
          for (let i = 0; i < float32.length; i++)
            sum += float32[i] * float32[i];
          const rms = Math.sqrt(sum / float32.length);
          // Require stronger, sustained speech to avoid cutting off Sarah
          if (rms > 0.03) bargeFramesRef.current += 1;
          else bargeFramesRef.current = 0;

          if (bargeFramesRef.current >= 5) {
            bargeInRef.current = true;
            console.log("🛑 Barge-in detected — stopping TTS");
            window.speechSynthesis.cancel();
            setSpeaking(false);
          }
          return;
        }
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 32768 : s * 32767;
        }
        socketRef.current.emit("audio-chunk", int16.buffer);
      };

      source.connect(processorRef.current);
      processorRef.current.connect(audioContextRef.current.destination);

      if (!socketRef.current?.connected)
        throw new Error("Socket not connected.");

      // ── CHANGE 2: also send token at session-start as fallback ──
      // Handles the edge case where the socket connected before login
      const token = localStorage.getItem("token");
      socketRef.current.emit("start-voice-session", {
        sampleRate: actualRate,
        authToken: token ? `Bearer ${token}` : null, // ← server uses this if handshake token was missing
      });

      // ─────────────────────────────────────────────────────────────────────────
      // ADD THIS to useWebRTC.js (or wherever startCall is called in server.js)
      // Pass patient's GPS coordinates through the socket so Sarah can use them.
      // ─────────────────────────────────────────────────────────────────────────
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            socketRef.current.emit("patient-location", {
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
            });
          },
          () => {
            /* permission denied — gracefully ignore */
          },
        );
      }

      // Send patient details if available
      const user = JSON.parse(localStorage.getItem("user") || "{}");
      if (user.name && user.email) {
        socketRef.current.emit("patient-details", {
          name: user.name,
          email: user.email,
        });
      }

      setIsConnected(true);
      console.log("🎙️ Voice session active @ LINEAR16", actualRate, "Hz");
    } catch (err) {
      console.error("startCall error:", err);
      if (err.name === "NotAllowedError") setError("Microphone access denied.");
      else if (err.name === "NotFoundError") setError("No microphone found.");
      else setError(err.message || "Failed to start call.");
      stopCall();
    }
  }, [analyzeAudio]); // eslint-disable-line react-hooks/exhaustive-deps

  /* =========================================================
     STOP CALL
  ========================================================= */
  const stopCall = useCallback(() => {
    console.log("🛑 Stopping call...");
    window.speechSynthesis.cancel();

    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch (_) {}
      processorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    analyserRef.current = null;
    isSpeakingRef.current = false;

    if (socketRef.current?.connected) {
      socketRef.current.emit("sarah-speaking", false);
      socketRef.current.emit("stop-voice-session");
    }

    setIsConnected(false);
    setIsListening(false);
    setIsSpeaking(false);
    setTranscript("");
    setAudioLevel(0);
  }, []);

  /* =========================================================
     MUTE / UNMUTE
  ========================================================= */
  const toggleMute = useCallback(() => {
    if (!streamRef.current) return;
    if (!isMuted && isSpeakingRef.current) return;
    const willMute = !isMuted;
    streamRef.current.getAudioTracks().forEach((t) => {
      t.enabled = !willMute;
    });
    setIsMuted(willMute);
    console.log(willMute ? "🔇 Muted" : "🔊 Unmuted");
  }, [isMuted]);

  useEffect(() => () => stopCall(), [stopCall]);

  return {
    isConnected,
    isMuted,
    isListening,
    isSpeaking,
    transcript,
    assistantMessage,
    error,
    audioLevel,
    startCall,
    stopCall,
    toggleMute,
  };
};
