import { useEffect, useState, useCallback, useRef } from "react";

export default function VoicePage() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false); // Track if audio session is unlocked
  const audioRef = useRef(null);
  const [notifications, setNotifications] = useState([]);
  
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

  useEffect(() => {
    const interval = setInterval(() => {
      setNotifications(prev => prev.filter(n => 
        Date.now() - new Date(n.timestamp) < 5000
      ));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Function to enable the audio session upon user interaction (click or touch)
  const enableAudioSession = () => {
    if (!audioEnabled) {
      setAudioEnabled(true); // Unlock audio playback
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

  // Use the first user interaction (click or touch) to enable audio playback
  useEffect(() => {
    document.body.addEventListener('click', enableAudioSession);
    document.body.addEventListener('touchstart', enableAudioSession); // For mobile devices

    // Clean up the event listeners after the first interaction
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
        return;  // Don't play audio until the user has interacted with the page
      }
    
      console.log("Handling play command with text:", responseText);
    
      // Use SpeechSynthesis API to speak the responseText
      const speechSynthesis = window.speechSynthesis;
    
      if (speechSynthesis) {
        const utterance = new SpeechSynthesisUtterance(responseText);
        // You can customize the voice, pitch, and rate here
        utterance.pitch = 1; // Default pitch (range: 0 to 2)
        utterance.rate = 1;  // Default rate (range: 0.1 to 10)
        utterance.voice = speechSynthesis.getVoices().find(voice => voice.lang === 'en-US') || null;
    
        // Event listeners for speech events
        utterance.onstart = () => {
          console.log('Speech started');
          setIsPlaying(true);
        };
    
        utterance.onend = () => {
          console.log('Speech finished');
          setIsPlaying(false); // Update state to stop showing "Speaking..."
        };
    
        utterance.onerror = (error) => {
          console.error('Speech synthesis error:', error);
          addNotification('Speech synthesis error', 'error');
        };
    
        // Play the speech
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
        handlePlayCommand(event.data); // Process the received message
      }
    };

    return () => {
      console.log('Cleaning up WebSocket connection');
      ws.close();
    };
  }, [audioEnabled]);

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center">
      <NotificationToast />
      <div className="text-center">
        {/* Voice Assistant Avatar */}
        <div className="relative w-48 h-48 mx-auto mb-8">
          <div className="absolute inset-0 bg-blue-500 rounded-full animate-pulse"></div>
          <div className="absolute inset-2 bg-gray-800 rounded-full flex items-center justify-center">
            <svg
              className="w-24 h-24 text-blue-400"
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
        <div className="flex items-center justify-center space-x-1 h-16">
          {[...Array(12)].map((_, i) => (
            <div
              key={i}
              className="w-2 bg-blue-500 rounded-full animate-wave"
              style={{
                height: `${Math.random() * 30 + 10}px`,
                animationDelay: `${i * 0.1}s`,
                animationPlayState: isPlaying ? 'running' : 'paused'
              }}
            />
          ))}
        </div>

        <p className="mt-6 text-gray-400 text-lg">
          {isPlaying ? "Speaking..." : "Ready for response"}
        </p>
      </div>
    </div>
  );
}
