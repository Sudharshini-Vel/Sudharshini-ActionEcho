import { useState, useEffect, useRef, useCallback } from "react";
import { Camera, Settings, History, MessageSquare, Volume2, Trash2, Download, Languages, User, Activity, Sparkles, Mic, Search, BrainCircuit, Radio } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "./lib/utils";
import type { Language, VoiceGender, ConversationItem, SystemStatus } from "./types";
import CameraFeed from "./components/CameraFeed";
import { GoogleGenAI, Modality, ThinkingLevel } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export default function App() {
  const [isCameraOn, setIsCameraOn] = useState(true);
  const [language, setLanguage] = useState<Language>("ISL");
  const [voice, setVoice] = useState<VoiceGender>("Female");
  const [sensitivity, setSensitivity] = useState(0.7);
  const [speed, setSpeed] = useState(1.0);
  const [currentText, setCurrentText] = useState("");
  const [history, setHistory] = useState<ConversationItem[]>([]);
  const [status, setStatus] = useState<SystemStatus>({ camera: "Active", model: "Loading" });
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [isSearchEnabled, setIsSearchEnabled] = useState(false);
  const [isThinkingMode, setIsThinkingMode] = useState(true);
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [gestureBuffer, setGestureBuffer] = useState<string[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const liveSessionRef = useRef<any>(null);
  const [currentGesture, setCurrentGesture] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState(false);
  const bufferTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  const lastSpokenRef = useRef<string>("");
  const lastSpokenTimeRef = useRef<number>(0);

  // Mock model loading
  useEffect(() => {
    const timer = setTimeout(() => {
      setStatus(prev => ({ ...prev, model: "Ready" }));
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  const speakText = useCallback(async (text: string) => {
    if (!text || typeof window === "undefined") return;
    
    const now = Date.now();
    if (text === lastSpokenRef.current && now - lastSpokenTimeRef.current < 2000) return;

    console.log(`[DEBUG] Triggering Audio: "${text}"`);

    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `Say in a ${voice === "Male" ? "male" : "female"} voice: ${text}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice === "Male" ? "Fenrir" : "Kore" },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const audioBlob = new Blob([Uint8Array.from(atob(base64Audio), c => c.charCodeAt(0))], { type: "audio/wav" });
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        audio.play();
      }
      
      lastSpokenRef.current = text;
      lastSpokenTimeRef.current = now;
    } catch (error) {
      console.error("Gemini TTS Error:", error);
      // Fallback to Web Speech API
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = speed;
      window.speechSynthesis.speak(utterance);
    }
  }, [speed, voice]);

  const processBuffer = useCallback(async (buffer: string[]) => {
    if (buffer.length === 0) return;
    setIsProcessing(true);
    
    try {
      const model = isThinkingMode ? "gemini-3.1-pro-preview" : "gemini-3-flash-preview";
      const config: any = {
        tools: isSearchEnabled ? [{ googleSearch: {} }] : [],
      };
      
      if (isThinkingMode) {
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.HIGH };
      }

      const prompt = `Translate this sequence of detected sign language gestures into a natural, grammatically correct sentence in English. 
      Gestures: ${buffer.join(", ")}
      Language context: ${language}
      Note: The user's facial expressions and body language are being tracked to help with tone.
      Output ONLY the translated sentence, nothing else. Keep it concise.`;

      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config,
      });

      const translatedText = response.text?.trim() || buffer.join(" ");
      setCurrentText(translatedText);
      
      if (autoSpeak) {
        speakText(translatedText);
      }

      const newItem: ConversationItem = {
        id: Date.now().toString(),
        text: translatedText,
        timestamp: Date.now(),
        type: "ai",
      };
      setHistory(prev => [newItem, ...prev]);
      setGestureBuffer([]);
    } catch (error) {
      console.error("AI Translation Error:", error);
      setGestureBuffer([]);
    } finally {
      setIsProcessing(false);
    }
  }, [language, autoSpeak, speakText, isThinkingMode, isSearchEnabled]);

  const handleGesture = useCallback((gesture: string, context?: string) => {
    if (gesture === "None" || gesture === "Background") return;
    
    console.log(`[DEBUG] handleGesture received: ${gesture} (Context: ${context})`);
    
    // IMMEDIATE FEEDBACK: Show the raw gesture instantly
    setCurrentGesture(gesture);
    
    // Immediate Speech for single words if Auto-Speak is on and buffer is empty
    if (autoSpeak && gestureBuffer.length === 0) {
      speakText(gesture);
    }

    setGestureBuffer(prev => {
      if (prev[prev.length - 1] === gesture) return prev;
      // We could potentially include context in the buffer, but for now we just use it for the prompt
      return [...prev, gesture];
    });

    if (bufferTimerRef.current) clearTimeout(bufferTimerRef.current);
    bufferTimerRef.current = setTimeout(() => {
      setGestureBuffer(currentBuffer => {
        if (currentBuffer.length > 0) {
          processBuffer(currentBuffer);
        }
        return currentBuffer;
      });
      setCurrentGesture(""); // Clear live feedback after processing
    }, 1500); // Wait for a natural pause before sentence translation
  }, [processBuffer, autoSpeak, speakText, gestureBuffer.length]);

  const startTranscription = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/wav" });
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
          const base64Audio = (reader.result as string).split(",")[1];
          setIsTranscribing(true);
          try {
            const response = await ai.models.generateContent({
              model: "gemini-3-flash-preview",
              contents: [
                {
                  parts: [
                    { text: "Transcribe this audio accurately." },
                    { inlineData: { data: base64Audio, mimeType: "audio/wav" } },
                  ],
                },
              ],
            });
            const transcription = response.text?.trim() || "";
            if (transcription) {
              const newItem: ConversationItem = {
                id: Date.now().toString(),
                text: transcription,
                timestamp: Date.now(),
                type: "user",
              };
              setHistory(prev => [newItem, ...prev]);
              processTranscription(transcription);
            }
          } catch (error) {
            console.error("Transcription Error:", error);
          } finally {
            setIsTranscribing(false);
          }
        };
      };

      mediaRecorder.start();
      setIsTranscribing(true);
    } catch (error: any) {
      console.error("Mic Access Error:", error);
      setIsTranscribing(false);
      const errorMessage = error.name === "NotFoundError" || error.name === "DevicesNotFoundError"
        ? "No microphone detected. Please connect a microphone and try again."
        : error.name === "NotAllowedError" || error.name === "PermissionDeniedError"
        ? "Microphone access denied. Please enable microphone permissions in your browser settings."
        : "Could not access microphone. Please check your device settings.";
      
      const newItem: ConversationItem = {
        id: Date.now().toString(),
        text: `Error: ${errorMessage}`,
        timestamp: Date.now(),
        type: "system",
      };
      setHistory(prev => [newItem, ...prev]);
    }
  };

  const stopTranscription = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      setIsTranscribing(false);
    }
  };

  const processTranscription = async (text: string) => {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `The user said: "${text}". Provide a helpful, concise response.`,
      });
      const aiResponse = response.text?.trim() || "";
      if (aiResponse) {
        const newItem: ConversationItem = {
          id: Date.now().toString(),
          text: aiResponse,
          timestamp: Date.now(),
          type: "ai",
        };
        setHistory(prev => [newItem, ...prev]);
        if (autoSpeak) speakText(aiResponse);
      }
    } catch (error) {
      console.error("AI Response Error:", error);
    }
  };

  const toggleLiveMode = async () => {
    if (isLiveActive) {
      if (liveSessionRef.current) {
        liveSessionRef.current.close();
        liveSessionRef.current = null;
      }
      setIsLiveActive(false);
      return;
    }

    try {
      const session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: "You are a helpful AI interpreter for ActionEcho. Listen to the user and provide real-time voice assistance.",
        },
        callbacks: {
          onopen: () => {
            console.log("Live Session Opened");
            setIsLiveActive(true);
          },
          onmessage: (message) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              const audioBlob = new Blob([Uint8Array.from(atob(base64Audio), c => c.charCodeAt(0))], { type: "audio/pcm;rate=16000" });
              console.log("Received Live Audio Chunk");
            }
          },
          onclose: () => setIsLiveActive(false),
          onerror: (err) => console.error("Live Error:", err),
        },
      });
      liveSessionRef.current = session;
    } catch (error) {
      console.error("Live Connect Error:", error);
    }
  };

  const handleManualSpeak = () => {
    if (!currentText) return;
    speakText(currentText);
    
    const newItem: ConversationItem = {
      id: Date.now().toString(),
      text: currentText,
      timestamp: Date.now(),
      type: "user",
    };
    setHistory(prev => [newItem, ...prev]);
    setCurrentText("");
  };

  const clearHistory = () => setHistory([]);
  const exportHistory = () => {
    const text = history.map(h => `[${new Date(h.timestamp).toLocaleString()}] ${h.text}`).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "actionecho-history.txt";
    a.click();
  };

  return (
    <div className="flex h-screen w-full bg-primary overflow-hidden text-text">
      {/* Left Panel: Controls */}
      <aside className="w-72 glass border-r border-accent/20 p-6 flex flex-col gap-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-accent rounded-lg flex items-center justify-center glow">
            <Activity className="text-white" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">ActionEcho</h1>
        </div>

        <div className="space-y-6 flex-1 overflow-y-auto pr-2 custom-scrollbar">
          <section>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted mb-3 block">Camera Control</label>
            <button 
              onClick={() => setIsCameraOn(!isCameraOn)}
              className={cn(
                "w-full py-3 rounded-xl flex items-center justify-center gap-2 font-medium transition-all",
                isCameraOn ? "bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20" : "bg-accent text-white hover:bg-accent/80"
              )}
            >
              <Camera size={18} />
              {isCameraOn ? "Stop Camera" : "Start Camera"}
            </button>
          </section>

          <section>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted mb-3 block">Language</label>
            <div className="grid grid-cols-2 gap-2">
              {(["ISL", "ASL"] as Language[]).map(lang => (
                <button
                  key={lang}
                  onClick={() => setLanguage(lang)}
                  className={cn(
                    "py-2 rounded-lg border transition-all text-sm font-medium",
                    language === lang ? "bg-accent border-accent text-white" : "border-accent/20 text-muted hover:border-accent/40"
                  )}
                >
                  {lang}
                </button>
              ))}
            </div>
          </section>

          <section>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted mb-3 block">Voice Engine</label>
            <div className="grid grid-cols-2 gap-2">
              {(["Male", "Female"] as VoiceGender[]).map(v => (
                <button
                  key={v}
                  onClick={() => setVoice(v)}
                  className={cn(
                    "py-2 rounded-lg border transition-all text-sm font-medium flex items-center justify-center gap-2",
                    voice === v ? "bg-accent border-accent text-white" : "border-accent/20 text-muted hover:border-accent/40"
                  )}
                >
                  <User size={14} />
                  {v}
                </button>
              ))}
            </div>
          </section>

          <section className="grid grid-cols-2 gap-2">
            <button 
              onClick={() => setIsSearchEnabled(!isSearchEnabled)}
              className={cn(
                "p-3 rounded-xl border transition-all flex flex-col items-center gap-2",
                isSearchEnabled ? "bg-accent/20 border-accent text-accent" : "border-accent/10 text-muted hover:border-accent/30"
              )}
            >
              <Search size={18} />
              <span className="text-[10px] font-bold uppercase">Search</span>
            </button>
            <button 
              onClick={() => setIsThinkingMode(!isThinkingMode)}
              className={cn(
                "p-3 rounded-xl border transition-all flex flex-col items-center gap-2",
                isThinkingMode ? "bg-accent/20 border-accent text-accent" : "border-accent/10 text-muted hover:border-accent/30"
              )}
            >
              <BrainCircuit size={18} />
              <span className="text-[10px] font-bold uppercase">Thinking</span>
            </button>
          </section>

          <section className="flex gap-2">
            <button 
              onMouseDown={startTranscription}
              onMouseUp={stopTranscription}
              className={cn(
                "flex-1 p-4 rounded-2xl border transition-all flex items-center justify-center gap-3",
                isTranscribing ? "bg-red-500/20 border-red-500 text-red-500 animate-pulse" : "bg-accent/10 border-accent/20 text-accent hover:bg-accent/20"
              )}
            >
              <Mic size={20} />
              <span className="text-xs font-bold uppercase tracking-wider">{isTranscribing ? "Listening..." : "Hold to Talk"}</span>
            </button>
            <button 
              onClick={toggleLiveMode}
              className={cn(
                "p-4 rounded-2xl border transition-all flex items-center justify-center",
                isLiveActive ? "bg-green-500/20 border-green-500 text-green-500" : "bg-accent/10 border-accent/20 text-accent hover:bg-accent/20"
              )}
            >
              <Radio size={20} />
            </button>
          </section>

          <section>
            <div className="flex items-center justify-between mb-3">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted block">Auto-Speak</label>
              <button 
                onClick={() => setAutoSpeak(!autoSpeak)}
                className={cn(
                  "w-10 h-5 rounded-full transition-all relative",
                  autoSpeak ? "bg-accent" : "bg-white/10"
                )}
              >
                <div className={cn(
                  "absolute top-1 w-3 h-3 rounded-full bg-white transition-all",
                  autoSpeak ? "left-6" : "left-1"
                )} />
              </button>
            </div>
          </section>

          <section className="space-y-4">
            <label className="text-xs font-semibold uppercase tracking-wider text-muted block">Settings</label>
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span>Sensitivity</span>
                <span>{Math.round(sensitivity * 100)}%</span>
              </div>
              <input 
                type="range" min="0" max="1" step="0.1" value={sensitivity} 
                onChange={(e) => setSensitivity(parseFloat(e.target.value))}
                className="w-full h-1 bg-accent/20 rounded-lg appearance-none cursor-pointer accent-accent"
              />
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span>Speech Speed</span>
                <span>{speed}x</span>
              </div>
              <input 
                type="range" min="0.5" max="2" step="0.1" value={speed} 
                onChange={(e) => setSpeed(parseFloat(e.target.value))}
                className="w-full h-1 bg-accent/20 rounded-lg appearance-none cursor-pointer accent-accent"
              />
            </div>
          </section>
        </div>

        <div className="pt-6 border-t border-accent/10 space-y-2">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-muted">
            <span>Camera Status</span>
            <span className={cn("flex items-center gap-1", isCameraOn ? "text-green-400" : "text-red-400")}>
              <div className={cn("w-1.5 h-1.5 rounded-full", isCameraOn ? "bg-green-400 animate-pulse" : "bg-red-400")} />
              {isCameraOn ? "Active" : "Inactive"}
            </span>
          </div>
          <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-muted">
            <span>Model Status</span>
            <span className={cn("flex items-center gap-1", status.model === "Ready" ? "text-green-400" : "text-yellow-400")}>
              <div className={cn("w-1.5 h-1.5 rounded-full", status.model === "Ready" ? "bg-green-400" : "bg-yellow-400 animate-pulse")} />
              {status.model}
            </span>
          </div>
        </div>
      </aside>

      {/* Center Panel: Camera Feed */}
      <main className="flex-1 flex flex-col p-6 gap-6 relative">
        <div className="flex-1 glass rounded-3xl overflow-hidden relative group">
          <CameraFeed 
            isCameraOn={isCameraOn} 
            sensitivity={sensitivity} 
            onGesture={handleGesture} 
          />
          
          {/* Overlay UI */}
          <div className="absolute top-6 left-6 flex gap-2">
            <div className="px-3 py-1 bg-black/60 backdrop-blur-md rounded-full border border-white/10 text-[10px] font-mono uppercase tracking-widest flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-green-400 rounded-full" />
              Live Feed
            </div>
          </div>

          {/* Live Detection Badge */}
          <AnimatePresence>
            {currentGesture && (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="absolute bottom-10 left-1/2 -translate-x-1/2 px-8 py-4 bg-accent/90 backdrop-blur-xl rounded-2xl border border-white/20 shadow-2xl glow flex items-center gap-4"
              >
                <div className="w-3 h-3 bg-white rounded-full animate-pulse" />
                <div className="flex flex-col">
                  <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-white/60">Live Detection</span>
                  <span className="text-2xl font-black text-white tracking-tight">{currentGesture}</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {gestureBuffer.length > 0 && (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="absolute bottom-6 left-6 flex gap-2"
              >
                {gestureBuffer.map((g, i) => (
                  <div key={i} className="px-4 py-2 bg-accent text-white rounded-xl text-sm font-bold shadow-lg glow">
                    {g}
                  </div>
                ))}
                {isProcessing && (
                  <div className="px-4 py-2 bg-white/10 backdrop-blur-md rounded-xl text-sm flex items-center gap-2">
                    <Sparkles size={14} className="animate-pulse text-accent" />
                    Processing...
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Bottom Panel: Text Output */}
        <div className="h-32 glass rounded-3xl p-6 flex items-center gap-6">
          <div className="flex-1 relative">
            <input
              type="text"
              value={currentText}
              onChange={(e) => setCurrentText(e.target.value)}
              placeholder="Detected signs will appear here..."
              className="w-full bg-transparent border-none focus:ring-0 text-2xl font-medium placeholder:text-muted/30"
            />
            <div className="absolute -bottom-2 left-0 w-full h-px bg-gradient-to-r from-accent/50 to-transparent" />
          </div>
          <div className="flex gap-3">
            <button 
              onClick={() => setCurrentText("")}
              className="p-4 rounded-2xl bg-white/5 hover:bg-white/10 text-muted transition-all"
              title="Clear Text"
            >
              <Trash2 size={24} />
            </button>
            <button 
              onClick={handleManualSpeak}
              className="px-8 py-4 rounded-2xl bg-accent text-white font-bold flex items-center gap-3 hover:bg-accent/80 transition-all glow"
            >
              <Volume2 size={24} />
              Speak
            </button>
          </div>
        </div>
      </main>

      {/* Right Panel: History */}
      <aside className="w-80 glass border-l border-accent/20 p-6 flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History size={18} className="text-accent" />
            <h2 className="font-bold">History</h2>
          </div>
          <div className="flex gap-1">
            <button onClick={exportHistory} className="p-2 hover:bg-white/5 rounded-lg text-muted" title="Export">
              <Download size={16} />
            </button>
            <button onClick={clearHistory} className="p-2 hover:bg-white/5 rounded-lg text-muted" title="Clear">
              <Trash2 size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
          <AnimatePresence initial={false}>
            {history.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center opacity-30 space-y-4">
                <MessageSquare size={48} />
                <p className="text-sm">No conversations yet</p>
              </div>
            ) : (
              history.map((item) => (
                <motion.div
                  key={item.id}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className={cn(
                    "p-4 rounded-2xl border transition-all group",
                    item.type === "user" ? "bg-accent/10 border-accent/20 ml-4" : "bg-white/5 border-white/5 mr-4"
                  )}
                >
                  <div className="flex items-center gap-2 mb-2">
                    {item.type === "user" ? <User size={12} className="text-accent" /> : <Sparkles size={12} className="text-accent" />}
                    <span className="text-[10px] uppercase font-bold tracking-wider opacity-50">
                      {item.type === "user" ? "User" : "AI"}
                    </span>
                  </div>
                  <p className="text-sm mb-2">{item.text}</p>
                  <div className="flex justify-between items-center text-[10px] text-muted">
                    <span>{new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    <button 
                      onClick={() => speakText(item.text)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-accent hover:underline"
                    >
                      Replay
                    </button>
                  </div>
                </motion.div>
              ))
            )}
          </AnimatePresence>
        </div>
      </aside>
    </div>
  );
}


