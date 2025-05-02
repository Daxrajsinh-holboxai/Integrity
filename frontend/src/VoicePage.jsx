import { useEffect, useState, useRef } from "react";

export default function VoicePage() {
  const [isPlaying, setIsPlaying] = useState(false);
  const channelRef = useRef(null);
  const audioRef = useRef(null);

  useEffect(() => {
    // Initialize communication channel
    channelRef.current = new BroadcastChannel('voice_channel');

    const handlePlayCommand = (responseText) => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }

      const audioUrl = `/audio/${responseText.replace(/ /g, '_')}.mp3`;
      console.log('Attempting to play:', audioUrl);
      
      audioRef.current = new Audio(audioUrl);
      audioRef.current.play()
        .then(() => {
          setIsPlaying(true);
          localStorage.removeItem('voiceResponseText');
        })
        .catch(error => {
          console.error('Playback failed:', error);
          localStorage.removeItem('voiceResponseText');
        });

      audioRef.current.onended = () => {
        setIsPlaying(false);
        audioRef.current = null;
      };
    };

    // Handle broadcast messages
    const handleMessage = (event) => {
      if (event.data?.type === 'play_audio') {
        handlePlayCommand(event.data.text);
      }
    };

    // Handle localStorage changes
    const handleStorage = (e) => {
      if (e.key === 'voiceResponseText' && e.newValue) {
        try {
          const data = JSON.parse(e.newValue);
          handlePlayCommand(data.text);
        } catch (error) {
          console.error('Storage parse error:', error);
        }
      }
    };

    // Set up listeners
    channelRef.current.addEventListener('message', handleMessage);
    window.addEventListener('storage', handleStorage);

    // Cleanup
    return () => {
      channelRef.current.close();
      window.removeEventListener('storage', handleStorage);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center">
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
