import { useState, useEffect, useRef } from "react";
import axios from "axios";

function App() {
  const [number, setNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [callStatus, setCallStatus] = useState(null);
  const [contactId, setContactId] = useState(null);
  const [retryDelay, setRetryDelay] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [wsStatus, setWsStatus] = useState("disconnected");
  
  // Reference to WebSocket for cleanup
  const wsRef = useRef(null);
  // Reference to transcript container for auto-scrolling
  const transcriptRef = useRef(null);

  // Auto-scroll transcript to bottom when it updates
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcript]);

  // Clean up WebSocket on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const setupWebSocket = (contactId) => {
    // Close existing connection if any
    if (wsRef.current) {
      wsRef.current.close();
    }

    setWsStatus("connecting");
    console.log("Setting up WebSocket for contact:", contactId);
    
    // Create new WebSocket connection
    const newWs = new WebSocket(`ws://localhost:3001/ws/${contactId}`);
    wsRef.current = newWs;
    
    // Connection opened
    newWs.onopen = () => {
      setWsStatus("connected");
      console.log("WebSocket connected");
    };
    
    // Listen for messages
    newWs.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      // Handle transcript updates
      if (data.transcript) {
          setTranscript(data.transcript);
      }
      
      // Update call status
      if (data.ContactStatus) {
          setCallStatus(data);
          
          // Show connection status
          if (['CONNECTED', 'IN_PROGRESS'].includes(data.ContactStatus)) {
              setIsConnected(true);
              setMessage("Connected to IVR - Transcription active");
          }

          if (['COMPLETED', 'FAILED'].includes(data.status)) {
            if (wsRef.current) {
              wsRef.current.close();
            }
      
            if (data.transcript && data.transcript.length > 30) {
              setMessage("Call completed. Transcript saved.");
            } else {
              setMessage("Call completed. No significant transcript available.");
            }
          }
      }
  };
    
    // Handle errors
    newWs.onerror = (error) => {
      console.error("WebSocket error:", error);
      setWsStatus("error");
      setMessage("Connection error. Please try refreshing the page.");
    };
    
    // Handle connection close
    newWs.onclose = (event) => {
      console.log("WebSocket connection closed:", event.code, event.reason);
      setWsStatus("disconnected");
      
      // Only show completion message if we haven't shown an error
      if (wsStatus !== "error") {
        if (transcript && transcript.length > 30) {
          setMessage("Call completed. Transcript saved.");
        } else {
          setMessage("Call completed. No significant transcript available.");
        }
      }
    };
  };

  const handleCall = async () => {
    if (retryDelay > 0) return; // Prevent calls during cooldown
    
    setLoading(true);
    setMessage("Initiating call...");
    setCallStatus(null);
    setRetryDelay(0);
    setTranscript("");
    setIsConnected(false);
    setWsStatus("disconnected");

    try {
      // Make API call to initiate the call
      const response = await axios.post("http://localhost:3001/initiate-call", {
        phoneNumber: number,
      });
      
      const newContactId = response.data.contact_id;
      setContactId(newContactId);
      setMessage(`Call initiated to ${number}. Connecting to IVR...`);
      
      // Setup WebSocket for real-time updates
      setupWebSocket(newContactId);
      
    } catch (error) {
      // Handle rate limiting
      if (error.response?.status === 429) {
        const delay = error.response?.data?.detail?.retry_after || 60;
        setRetryDelay(delay);
        
        // Start countdown timer
        const interval = setInterval(() => {
          setRetryDelay((prev) => {
            const newValue = prev - 1;
            if (newValue <= 0) {
              clearInterval(interval);
              return 0;
            }
            return newValue;
          });
        }, 1000);
      }
      
      setMessage(
        `Error: ${error.response?.data?.detail?.error || error.message}`
      );
    } finally {
      setLoading(false);
    }
  };

  // Generate descriptive status message based on call state
  const getStatusMessage = () => {
    if (!callStatus) return null;
    
    const status = callStatus.ContactStatus || callStatus.status;
    const statusColors = {
      INITIATED: "text-yellow-600",
      QUEUED: "text-yellow-600",
      CONNECTING: "text-yellow-600",
      CONNECTED: "text-green-600",
      FAILED: "text-red-600",
      COMPLETED: "text-blue-600"
    };
    
    const messages = {
      INITIATED: "Call is being initiated...",
      QUEUED: "Call is in queue",
      CONNECTING: "Connecting to IVR system...",
      CONNECTED: "Connected to IVR system",
      FAILED: "Call failed",
      COMPLETED: "Call completed"
    };
    
    return (
      <div className="mt-4 p-3 bg-gray-100 rounded-lg">
        <p className={`font-semibold ${statusColors[status] || "text-gray-800"}`}>
          Status: {messages[status] || status}
        </p>
        
        {(status === "CONNECTED" || status === "IN_PROGRESS") && (
          <p className="mt-2 text-green-600">
            <span className="inline-block h-2 w-2 rounded-full bg-green-600 mr-2"></span>
            Transcription active
          </p>
        )}
        
        {callStatus.DisconnectReason && (
          <p className="mt-2 text-red-500">
            Reason: {callStatus.DisconnectReason}
          </p>
        )}
      </div>
    );
  };

  // Display transcript with better formatting
  const transcriptDisplay = () => (
    <div className="mt-4">
      <div className="flex justify-between items-center mb-2">
        <h3 className="font-semibold">Live IVR Transcript:</h3>
        <span className={`text-xs px-2 py-1 rounded ${
          isConnected ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-800"
        }`}>
          {isConnected ? "Live" : "Waiting for connection"}
        </span>
      </div>
      
      <div 
        ref={transcriptRef}
        className="p-3 bg-gray-100 rounded-lg max-h-48 overflow-y-auto text-sm whitespace-pre-wrap text-black"
      >
        {transcript || "Waiting for IVR system to connect..."}
      </div>
    </div>
  );

  // Dynamic button text based on state
  const buttonText = () => {
    if (retryDelay > 0) return `Retry available in ${retryDelay}s`;
    if (loading) return "Initiating Call...";
    return "Make Call";
  };

  return (
    <div className="flex justify-center items-center min-h-screen bg-gray-50">
      <div className="w-full max-w-md p-6 bg-white shadow-lg rounded-lg">
        <h1 className="text-2xl font-bold text-center text-gray-800 mb-6">
          Integrity: Call Automation
        </h1>

        <div className="mb-4">
          <label htmlFor="phoneNumber" className="block text-sm font-medium text-gray-700 mb-1">
            Phone Number
          </label>
          <input
            id="phoneNumber"
            type="text"
            className="w-full p-3 border border-gray-300 rounded-lg text-gray-800 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="+1234567890"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />
        </div>

        <button
          onClick={handleCall}
          disabled={loading || !number || retryDelay > 0}
          className={`w-full p-3 text-white font-semibold rounded-lg ${
            loading || retryDelay > 0 || !number
              ? "bg-gray-400 cursor-not-allowed"
              : "bg-blue-500 hover:bg-blue-600"
          } transition`}
        >
          {buttonText()}
        </button>

        {message && (
          <div className={`mt-4 p-3 rounded-lg ${
            message.startsWith("Error")
              ? "bg-red-100 text-red-700"
              : "bg-blue-100 text-blue-700"
          }`}>
            {message}
          </div>
        )}
        
        {getStatusMessage()}
        {transcriptDisplay()}
        
        <div className="mt-6 text-xs text-gray-500 text-center">
          WebSocket Status: {wsStatus}
        </div>
      </div>
    </div>
  );
}

export default App;