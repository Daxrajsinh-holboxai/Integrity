import { useEffect, useState, useCallback, useRef } from "react";

export default function VoicePage() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [spokenTexts, setSpokenTexts] = useState([]);
  const audioRef = useRef(null);

  const addNotification = useCallback((message, type = 'success') => {
    setNotifications(prev => [
      ...prev.filter(n => Date.now() - n.id < 5000),
      {
        id: Date.now(),
        message,
        type,
        timestamp: Date.now()
      }
    ]);
  }, []);

  const addSpokenText = useCallback((text) => {
    setSpokenTexts(prev => [
      { id: Date.now(), text, timestamp: new Date().toLocaleTimeString() },
      ...prev.slice(0, 29) // Keep only last 10 items
    ]);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setNotifications(prev => prev.filter(n =>
        Date.now() - new Date(n.timestamp) < 5000
      ));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const enableAudioSession = () => {
    if (!audioEnabled) {
      setAudioEnabled(true);
      addNotification('Audio session unlocked', 'audio');
      console.log('Audio session unlocked');
    }
  };

  const NotificationToast = () => (
    <div className="fixed top-4 right-4 z-[9999] space-y-2">
      {notifications.map((notification) => (
        <div
          key={notification.id}
          className={`p-3 border rounded-lg shadow-lg flex items-center ${
            notification.type === 'error' 
              ? 'bg-red-100 border-red-400 text-red-700' 
              : notification.type === 'audio'
              ? 'bg-purple-100 border-purple-400 text-purple-700'
              : 'bg-green-100 border-green-400 text-green-700'
          }`}
        >
          <span className="mr-2">
            {notification.type === 'error' ? '❌' :
            notification.type === 'audio' ? '🔊' : '✅'}
          </span>
          {notification.message}
        </div>
      ))}
    </div>
  );

  useEffect(() => {
    document.body.addEventListener('click', enableAudioSession);
    document.body.addEventListener('touchstart', enableAudioSession);
    return () => {
      document.body.removeEventListener('click', enableAudioSession);
      document.body.removeEventListener('touchstart', enableAudioSession);
    };
  }, [audioEnabled]);

  useEffect(() => {
    const wsBaseUrl = import.meta.env.VITE_WS_URL;
    const wsUrl = `${wsBaseUrl}/voice-ws`;
    const ws = new WebSocket(wsUrl);

    const handlePlayCommand = (responseText) => {
      if (!audioEnabled) {
        console.log('Audio is not enabled yet');
        return;
      }

      console.log("Handling play command with text:", responseText);
      addSpokenText(responseText);

      const speechSynthesis = window.speechSynthesis;
      if (speechSynthesis) {
        const utterance = new SpeechSynthesisUtterance(responseText);
        utterance.pitch = 1;
        utterance.rate = 1;
        utterance.voice = speechSynthesis.getVoices().find(voice => voice.lang === 'en-US') || null;

        utterance.onstart = () => {
          console.log('Speech started');
          setIsPlaying(true);
        };

        utterance.onend = () => {
          console.log('Speech finished');
          setIsPlaying(false);
        };

        utterance.onerror = (error) => {
          console.error('Speech synthesis error:', error);
          addNotification('Speech synthesis error', 'error');
        };

        speechSynthesis.speak(utterance);
      } else {
        console.error('SpeechSynthesis API is not supported');
        addNotification('SpeechSynthesis API is not supported', 'error');
      }
    };

    ws.onopen = () => {
      console.log('WebSocket connection established');
      addNotification('WebSocket connection established');
      ws.send(JSON.stringify({ type: 'ping' }));
    };

    ws.onerror = (error) => {
      console.log('WebSocket error:', error);
      addNotification('WebSocket error:', error);
    };

    ws.onmessage = (event) => {
      console.log('Received WebSocket message:', event.data);
      if (typeof event.data === 'string') {
        handlePlayCommand(event.data);
      }
    };

    return () => {
      console.log('Cleaning up WebSocket connection');
      ws.close();
    };
  }, [audioEnabled]);

  return (
    <div className="h-screen w-screen fixed inset-0 bg-gray-900 flex flex-col overflow-hidden">
      {/* Audio Lock Overlay */}
      {!audioEnabled && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-70 backdrop-blur-lg transition-all duration-500"
          onClick={enableAudioSession}
        >
          <div className="text-center p-8 max-w-md bg-gray-800 rounded-xl border border-blue-500/30 shadow-2xl animate-pulse">
            <div className="mb-6">
              <svg
                className="w-20 h-20 mx-auto text-blue-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
                />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">Audio Session Locked</h2>
            <p className="text-gray-300 mb-6">Click anywhere to unlock audio capabilities</p>
            <button 
              className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
              onClick={enableAudioSession}
            >
              Unlock Audio
            </button>
          </div>
        </div>
      )}

      <NotificationToast />

      <header className="bg-gray-800/50 border-b border-gray-700 p-4">
        <h1 className="text-2xl font-bold text-blue-400">Integrity: Live Call Voice Assistant</h1>
      </header>

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 p-6 overflow-hidden">
        {/* Assistant Section */}
        <div className="lg:col-span-2 flex flex-col items-center justify-center h-full">
          {/* Voice Assistant Avatar */}
          <div className="relative w-64 h-64 mx-auto mb-8">
            <div 
              className={`absolute inset-0 bg-blue-500 rounded-full ${
                isPlaying ? 'animate-pulse' : 'opacity-20'
              } transition-all duration-300`}
            ></div>
            <div className="absolute inset-2 bg-gray-800 rounded-full flex items-center justify-center">
              <svg
                className="w-32 h-32 text-blue-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
                />
              </svg>
            </div>
          </div>

          {/* Waveform Animation */}
          <div className="flex items-center justify-center space-x-1 h-20 mb-8">
            {[...Array(12)].map((_, i) => (
              <div
                key={i}
                className="w-3 bg-blue-500 rounded-full animate-wave"
                style={{
                  height: `${Math.random() * 40 + 10}px`,
                  animationDelay: `${i * 0.1}s`,
                  animationPlayState: isPlaying ? 'running' : 'paused',
                  opacity: isPlaying ? 1 : 0.3
                }}
              />
            ))}
          </div>

          <div className="text-center">
            <p className="text-xl text-gray-300 mb-2">
              {isPlaying ? (
                <span className="text-blue-400">Speaking...</span>
              ) : (
                <span>Ready for response</span>
              )}
            </p>
            <p className="text-gray-400">
              {audioEnabled ? (
                <span className="text-green-400">Audio session active</span>
              ) : (
                <span>Click to enable audio</span>
              )}
            </p>
          </div>
        </div>

        {/* Spoken Text History */}
        <div className="bg-gray-800/50 rounded-xl border border-gray-700 p-6 overflow-hidden flex flex-col">
          <h2 className="text-xl font-semibold text-white mb-4 pb-2 border-b border-gray-700">
            Response History
          </h2>
          <div className="flex-1 overflow-y-auto pr-2 space-y-4">
            {spokenTexts.length > 0 ? (
              spokenTexts.map((item) => (
                <div 
                  key={item.id} 
                  className="bg-gray-700/50 rounded-lg p-4 border-l-4 border-blue-500"
                >
                  <div className="flex justify-between items-start mb-1">
                    <span className="text-xs text-gray-400">{item.timestamp}</span>
                  </div>
                  <p className="text-gray-200">{item.text}</p>
                </div>
              ))
            ) : (
              <div className="text-center py-8 text-gray-400 h-full flex items-center justify-center">
                <div>
                  <svg
                    className="w-12 h-12 mx-auto mb-4 text-gray-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1}
                      d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                    />
                  </svg>
                  <p>No responses yet</p>
                  <p className="text-sm mt-1">Responses will appear here</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}