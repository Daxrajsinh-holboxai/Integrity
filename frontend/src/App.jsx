import { useState, useEffect, useRef, useCallback } from "react";
import axios from "axios";
import * as XLSX from "xlsx";
import "amazon-connect-streams";
// import CustomCCP from "./CustomCCP";

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
  const [excelData, setExcelData] = useState([]);
  const [activeCall, setActiveCall] = useState(false); // prevent overlapping calls
  const [selectedRow, setSelectedRow] = useState(null);
  const [sentResponses, setSentResponses] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [activeConnection, setActiveConnection] = useState(null);
  const ccpContainerRef = useRef(null);
  const [agent, setAgent] = useState(null);
  const [ccpLoaded, setCcpLoaded] = useState(false);
  const [currentRowIndex, setCurrentRowIndex] = useState(0);
  const [isAutoCallEnabled, setIsAutoCallEnabled] = useState(false);
  const [nextCallDelay, setNextCallDelay] = useState(5000);
  const [requiresConfirmation, setRequiresConfirmation] = useState(true);
  const [pendingProceed, setPendingProceed] = useState(false);
  const [awaitingAgentConnection, setAwaitingAgentConnection] = useState(false);
  const [lastTranscriptUpdate, setLastTranscriptUpdate] = useState(0);  
  const [audioContext] = useState(() => new (window.AudioContext || window.webkitAudioContext)());
  const [agentConnected, setAgentConnected] = useState(false);
  const [callProgress, setCallProgress] = useState('IVR_INTERACTION');
  const silenceDetectorRef = useRef(null);
  const audioAnalyserRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const transferInitiatedRef = useRef(false);
  const preTransferTranscriptLength = useRef(0);
  const beepBufferRef = useRef(null);
  const prevContactIdRef = useRef();
  const activeConnectionRef = useRef(null);
  const contactIdRef = useRef(null);
  const wsRef = useRef(null);
  const transcriptRef = useRef(null);
  const [readyToStartAutoCall, setReadyToStartAutoCall] = useState(false);
  
  // Update status messages and colors
const statusColors = {
  INIT: "text-yellow-600",
  CONNECTING: "text-yellow-600",
  CONNECTED: "text-green-600",
  ENDED: "text-blue-600",
  MISSED: "text-red-600",
  ERROR: "text-red-600",
};

const messages = {
  INIT: "Initializing call...",
  CONNECTING: "Connecting to recipient...",
  CONNECTED: "Call connected",
  ENDED: "Call completed",
  MISSED: "Call missed",
  ERROR: "Call failed",
};

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcript]);

  useEffect(() => {
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  useEffect(() => {
    contactIdRef.current = contactId;
  }, [contactId]);


  // Initialize beep sound
useEffect(() => {
  // Create a 1-second beep sound
  const duration = 0.2;
  const sampleRate = audioContext.sampleRate;
  const numFrames = duration * sampleRate;
  const buffer = audioContext.createBuffer(1, numFrames, sampleRate);
  const channelData = buffer.getChannelData(0);
  
  for (let i = 0; i < numFrames; i++) {
    channelData[i] = Math.sin(2 * Math.PI * 600 * i / sampleRate); // 600Hz tone
  }
  
  beepBufferRef.current = buffer;
}, [audioContext]);

  useEffect(() => {
    const prevContactId = prevContactIdRef.current;
    if (prevContactId && !contactId && isAutoCallEnabled) {
      const finalStatus = callStatus?.ContactStatus?.toUpperCase();
      setSentResponses([]);
      setTranscript("");
  
      // Always require confirmation after each call (including first)
    setPendingProceed(true);
    setMessage(`Call ${finalStatus}. Awaiting confirmation...`);
    }
    prevContactIdRef.current = contactId;
  }, [contactId, isAutoCallEnabled, callStatus, nextCallDelay, requiresConfirmation]);

  // Add useEffect for processing rows
useEffect(() => {
  if (isAutoCallEnabled && excelData.length > 0 && currentRowIndex < excelData.length && !pendingProceed) {
    const row = excelData[currentRowIndex];
    const raw = row["Payer Phone"] || row.Phone;
    const normalized = normalizePhone(raw);
    
    if (normalized) {
      handleExcelRowClick(row);
    } else {
      setMessage(`Skipping row ${currentRowIndex + 1} - invalid phone number`);
      setCurrentRowIndex(prev => prev + 1);
    }
  }
}, [currentRowIndex, excelData, isAutoCallEnabled, pendingProceed]);

  // Add useEffect to trigger calls
  useEffect(() => {
    if (isAutoCallEnabled && selectedRow && !activeCall && !pendingProceed) {
      handleCall();
    }
  }, [selectedRow]);

  useEffect(() => {
    if (isAutoCallEnabled && currentRowIndex < excelData.length) {
      const row = excelData[currentRowIndex];
      setSelectedRow(row); // Set the selected row based on the current index
    }
  }, [currentRowIndex, isAutoCallEnabled, excelData]);  

  // Add useEffect to handle completion
  useEffect(() => {
    if (isAutoCallEnabled && currentRowIndex >= excelData.length) {
      setIsAutoCallEnabled(false);
      setMessage("All calls completed");
    }
  }, [currentRowIndex, excelData.length, isAutoCallEnabled]);

  const agentRef = useRef();
  useEffect(() => {
    agentRef.current = agent;
  }, [agent]);


  const cleanupAudioAnalysis = () => {
    if (silenceDetectorRef.current) clearInterval(silenceDetectorRef.current);
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
    }
  };

  useEffect(() => {
    let ccpCleanup = null;
  
    const initializeCCP = () => {
      if (!window.connect || !ccpContainerRef.current) return;
  
      try {
        ccpCleanup = window.connect.core.initCCP(ccpContainerRef.current, {
          ccpUrl: "https://dax-holbox.awsapps.com/connect/ccp-v2/",
          loginPopup: true,
          softphone: {
            allowFramedSoftphone: true,
            disableRingtone: false
          },
        });
  
        // Agent callback
        window.connect.agent((agent) => {
          setAgent(agent);
          agent.onStateChange((newState) => {
            console.log("Agent state changed:", newState);
          });
        });
  
        // Contact callback
        window.connect.contact((contact) => {
          console.log("New contact received:", contact);

          activeConnectionRef.current = null;
          
          // Check if this is our tracked contact
          const isOurContact = contact.getContactId() === contactIdRef.current;
          if (!isOurContact) return;

          // Status handler
          const handleStatusChange = (status) => {
            const normalizedStatus = status.toUpperCase();
            setCallStatus({ ContactStatus: normalizedStatus });
            console.log("Contact status:", normalizedStatus);
          };

          // Contact event handlers
          contact.onConnecting(() => {
            handleStatusChange('CONNECTING');
            setMessage(`Call initiated to ${number}. Connecting...`);
          });

          contact.onConnected(() => {
            handleStatusChange('CONNECTED');
            setMessage('Connected to IVR - Transcription active');
            setIsConnected(true);
            setTranscript("");
            setSentResponses([]);

            // Mute the agent's microphone
            if (agentRef.current) {
              agentRef.current.mute()
                .then(() => {
                  addNotification("Microphone muted automatically");
                })
                .catch((error) => {
                  console.error("Mute failed:", error);
                  addNotification("Failed to mute microphone", "error");
                });
            }
          });

          contact.onEnded(() => {
            const finalState = contact.getState().type.toUpperCase();
            cleanupAudioAnalysis();
            setCallProgress('IVR_INTERACTION');
            handleStatusChange(finalState);
            setMessage(finalState === 'MISSED' ? 'Call missed' : 'Call ended');
            setIsConnected(false);
            setActiveCall(false);
            setContactId(null);
          });

          contact.onMissed(() => {
            handleStatusChange('MISSED');
            setMessage('Call missed');
            setIsConnected(false);
            setActiveCall(false);
            setContactId(null);
          });

          // Handle initial state
          const initialState = contact.getState().type;
          handleStatusChange(initialState);
          if (initialState === 'CONNECTING') {
            setMessage(`Call initiated to ${number}. Connecting...`);
          }
          
          contact.onAccepted(() => {
            addNotification("Contact accepted");
            if (agentRef.current) {
              agentRef.current.mute()
                .then(() => {
                  addNotification("Microphone muted on accept");
                })
                .catch((error) => {
                  console.error("Mute failed:", error);
                  addNotification("Failed to mute on accept", "error");
                });
            }
            const conn = contact.getInitialConnection();
            if (conn) {
              activeConnectionRef.current = null;
              activeConnectionRef.current = conn;
              console.log("Connection obtained:", conn);
              addNotification("Connection established");
              setupAudioAnalysis(conn);
              // Wait for media connection before setting active
              conn.onMediaConnected(() => {
                console.log("Media connected - Ready for DTMF");
                // setActiveConnection(conn);
                activeConnectionRef.current = conn;
                addNotification("Media connected - DTMF enabled");
                
                // Verify DTMF support
                const mediaInfo = conn.getMediaInfo();
                console.log("Media capabilities:", mediaInfo);
                if (!mediaInfo?.dtmfSupported) {
                  addNotification("DTMF not supported in this call", "error");
                }
              });

              conn.onDestroy(() => {
                activeConnectionRef.current = null;
              });
    
              // Handle connection state changes
              conn.onConnected(() => {
                console.log("Connection fully established");
              });
            // else addNotification("Connection not fully established");
            // setActiveConnection(conn);
            
            }
          });
          conn.onDisconnected(() => {
            activeConnectionRef.current = null;
          });
          contact.onEnded(() => {
            console.log("Contact ended");
            // setActiveConnection(null);
            activeConnectionRef.current = null;
          });
        });
  
        setCcpLoaded(true);
      } catch (error) {
        console.error("CCP initialization failed:", error);
      }
    };
  
    // Load streams script if not already loaded
    if (!window.connect) {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/amazon-connect-streams@2.18.1/release/connect-streams.min.js';
      script.async = true;
      script.onload = () => {
        console.log("Connect Streams loaded");
        initializeCCP();
      };
      script.onerror = () => console.error("Failed to load Connect Streams");
      document.body.appendChild(script);
    } else {
      initializeCCP();
    }
  
    // Cleanup function
    return () => {
      if (ccpCleanup) {
        ccpCleanup.unbind();
        ccpContainerRef.current.innerHTML = '';
      }
      setCcpLoaded(false);
      setAgent(null);
      // setActiveConnection(null);
      activeConnectionRef.current = null;
    };
  }, []);

  const handleProceed = () => {
    setPendingProceed(false);
    setCurrentRowIndex((prev) => prev + 1);
  };

// Modify addNotification to prevent state overwrites
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

// Add audio analysis setup
const setupAudioAnalysis = async (connection) => {
  try {
    const mediaController = connection.getMediaController();
    const stream = await mediaController.getAudioStream();
    mediaStreamRef.current = stream;
    
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    audioAnalyserRef.current = analyser;
    
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    
    analyser.fftSize = 256;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const checkAudioActivity = () => {
      analyser.getByteFrequencyData(dataArray);
      const sum = dataArray.reduce((a, b) => a + b, 0);
      
      if (sum > 1000 && callProgress === 'HOLD_MUSIC') { // Adjust threshold as needed
        setCallProgress('AGENT_SPEAKING');
        addNotification("Agent connected!");
      }
    };

    silenceDetectorRef.current = setInterval(checkAudioActivity, 500);
  } catch (error) {
    console.error("Audio analysis setup failed:", error);
  }
};


// Add DTMF sending function
const sendDTMFDigits = useCallback((digits) => {
  // Try to get connection from both state and ref
  const connection = activeConnectionRef.current || 
                    agent?.getContacts()?.[0]?.getAgentConnection();
  if (!connection || !connection.isActive()) {
    // console.error("No active connection");
    addNotification('No active call connection', 'error');
    return false;
  }
  const cleanDigits = digits.replace(/\D/g, '');
  try {
    addNotification(`Sending DTMF: ${cleanDigits}`);
    connection.sendDigits(cleanDigits, {
      success: () => {
        console.log(`DTMF ${cleanDigits} sent successfully`);
        addNotification(`Sent DTMF: ${cleanDigits}`);
      },
      failure: (err) => {
        console.error("DTMF send failed:", err);
        addNotification(`DTMF failed: ${err.message}`, 'error');
      }
    });
    return true;
  } catch (error) {
    console.error("DTMF error:", error);
    addNotification(`DTMF error: ${error.message}`, 'error');
    return false;
  }
}, [agent, addNotification]);

const playVoiceResponse = useCallback(async () => {
  addNotification('Playing voice response', 'audio');
  const connection = activeConnectionRef.current || 
                    agent?.getContacts()?.[0]?.getAgentConnection();
  if (!connection || !connection.isActive()) {
    addNotification('No active call connection for audio', 'error');
    return false;
  }

  try {
    const mediaController = connection.getMediaController();
    const dummyAudioUrl = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3";
    
    addNotification('Sending voice response to call', 'audio');
    
    // Play the audio through the call connection
    await new Promise((resolve, reject) => {
      mediaController.playAudio({
        url: dummyAudioUrl,
        interrupt: true
      }, {
        success: () => {
          addNotification('Voice response sent successfully', 'audio');
          resolve();
        },
        failure: (error) => {
          addNotification(`Voice response failed: ${error.message}`, 'error');
          reject(error);
        }
      });
    });
    
    return true;
  } catch (error) {
    console.error("Voice response failed:", error);
    addNotification(`Voice response failed: ${error.message}`, 'error');
    return false;
  }
}, [addNotification, agent]);

  // Function to handle DTMF sending from backend
  // const handleSendDTMF = async (digits) => {

  //   // if (!sendDTMFFunction) return false;
  //   try {
  //     console.log("Sending DTMF:", digits);
      
  //     const success = sendDTMFFunction(digits);
  //     if (success) {
  //       addNotification(`Sent DTMF: ${digits}`);
  //       return true;
  //     }
  //     return false;
  //   } catch (error) {
  //     addNotification(`DTMF Failed: ${error.message}`, 'error');
  //     return false;
  //   }
  // };

  // Add notification cleanup effect
useEffect(() => {
  const interval = setInterval(() => {
    setNotifications(prev => prev.filter(n => 
      Date.now() - new Date(n.timestamp) < 5000
    ));
  }, 1000);
  return () => clearInterval(interval);
}, []);

// Add notification component to render
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

// Memoize the callback
const handleSetActiveConnection = useCallback((connection) => {
  setActiveConnection(connection);
}, []);

const normalizePhone = (phone) => {
  if (!phone) {
    return ""; // Return an empty string if phone is null or undefined
  }

  const phoneStr = String(phone); // Ensure phone is a string

  const digits = phoneStr.replace(/\D/g, "");
  
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  
  return ""; // Return an empty string if phone number format is not valid
};



  useEffect(() => {
    if (!awaitingAgentConnection) return;
  
    const checkAgentConnection = () => {
      // If we've had 5 seconds of silence after transfer message
      if (Date.now() - lastTranscriptUpdate > 5000) {
        // Next transcript update will be considered agent speech
        const unsubscribe = watch(
          () => transcript,
          (value, previousValue) => {
            if (value.length > previousValue.length) {
              addNotification("Agent connected!");
              setAwaitingAgentConnection(false);
              unsubscribe();
            }
          }
        );
      }
    };
  
    const interval = setInterval(checkAgentConnection, 1000);
    return () => clearInterval(interval);
  }, [awaitingAgentConnection, lastTranscriptUpdate, transcript]);

  const AgentConnectionPopup = () => (
    <div className="fixed top-4 left-1/2 transform -translate-x-1/2 bg-green-500 text-white px-6 py-3 rounded-md shadow-lg flex items-center space-x-2 z-[9999] animate-pulse">
      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
      </svg>
      <span>AGENT CONNECTED!</span>
    </div>
  );

  // Add useEffect for agent connection detection
  useEffect(() => {
    if (!transferInitiatedRef.current) return;
  
    const silenceDuration = 5000;
    let timeoutId;
    let checkInterval;
    let active = true;
  
    const checkForAgent = () => {
      if (!active) return;
      
      // Check if we've had new transcript since transfer initiation
      if (transcript.length > preTransferTranscriptLength.current) {
        setAgentConnected(true);
        addNotification("Agent connected!");
        setAwaitingAgentConnection(false);
        setTimeout(() => setAgentConnected(false), 3000);
        transferInitiatedRef.current = false;
        preTransferTranscriptLength.current = 0;
        clearInterval(checkInterval);
      }
    };
  
    timeoutId = setTimeout(() => {
      if (!active) return;
      checkInterval = setInterval(checkForAgent, 500);
    }, silenceDuration);
  
    return () => {
      active = false;
      clearTimeout(timeoutId);
      clearInterval(checkInterval);
      transferInitiatedRef.current = false;
      preTransferTranscriptLength.current = 0;
      setAwaitingAgentConnection(false);
    };
  }, [transcript]); // Keep transcript as dependency

  const setupWebSocket = (contactId) => {
    if (wsRef.current) wsRef.current.close();

    const newWs = new WebSocket(`ws://localhost:3001/ws/${contactId}`);
    wsRef.current = newWs;
    setWsStatus("connecting");

    newWs.onopen = () => setWsStatus("connected");

    newWs.onmessage = (event) => {
      // console.log("WebSocket message:", event.data);
      const data = JSON.parse(event.data);
      // Clear previous data on new call
      if (data.ContactStatus === 'INIT') {
        setTranscript("");
        setSentResponses([]);
        setAwaitingAgentConnection(false);
        transferInitiatedRef.current = false;
        preTransferTranscriptLength.current = 0;
      }
      if (data.transcript) {
        setTranscript(prev => {
          const newPhrase = data.transcript.trim();
          return prev.endsWith(newPhrase) ? prev : `${prev} ${newPhrase}`;
        });
      }

      if (data.responseSent) {
        setSentResponses(prev => [...prev, data.responseSent]);

        // Check if we need to send DTMF
        // console.log("Response sent:", data.responseSent); 

        if (data.responseSent?.field === "transfer to agent") {
          // Store the transcript length at the moment of transfer initiation
          setCallProgress('HOLD_MUSIC');
          setTimeout(() => {
            if (callProgress === 'HOLD_MUSIC') {
              addNotification("Detecting agent connection...");
            }
          }, 5000);
          addNotification("Transferring to agent...");
        }

        if (data.responseSent.field === "voice only") {
          playVoiceResponse();
        }

        // Handle call termination
        if (["COMPLETED", "FAILED", "ENDED"].includes(data.ContactStatus?.toUpperCase())) {
          setAwaitingAgentConnection(false);
          transferInitiatedRef.current = false;
          preTransferTranscriptLength.current = 0;
        }

        if (
          data.responseSent.field === "press a number" || 
          /^[\d-#]+$/.test(data.responseSent.value)
        ) {
          const cleanedValue = data.responseSent.value.replace(/[-#]/g, '');
        
          console.log("DTMF condition true:", data.responseSent.value);
        
          sendDTMFDigits(cleanedValue);
          console.log("DTMF sent:", cleanedValue);
        }        
      }

      if (data.ContactStatus) {
        setCallStatus(data);
        if (["CONNECTED", "IN_PROGRESS"].includes(data.ContactStatus)) {
          setIsConnected(true);
          setMessage("Connected to IVR - Transcription active");
        }

        if (["COMPLETED", "FAILED"].includes(data.status)) {
          newWs.close();
          setActiveCall(false);
          setContactId(null); // Reset contact ID when call ends
          setMessage(
            data.transcript?.length > 30
              ? "Call completed. Transcript saved."
              : "Call completed. No significant transcript available."
          );
        }
      }
    };

    newWs.onerror = () => {
      setWsStatus("error");
      setMessage("Connection error. Try refreshing.");
      setActiveCall(false);
    };

    newWs.onclose = () => {
      setWsStatus("disconnected");
      setActiveCall(false);
    };
    newWs.onclose = () => {
    setWsStatus("disconnected");
    setActiveCall(false);
    wsRef.current = null;  // Clear the reference
  };
  };

  const handleCall = async () => {
    if (retryDelay > 0 || !number || activeCall) return;
    if (!selectedRow) {
      setMessage("Please select a row from the Excel sheet first");
      return;
    }

    setLoading(true);
    setMessage("Initiating call...");
    setTranscript("");
    setSentResponses([]);
    setCallStatus(null);
    setIsConnected(false);
    setWsStatus("disconnected");
    setActiveCall(true);
    setContactId(null); 
    
    try {
      const response = await axios.post("http://localhost:3001/initiate-call", {
        phoneNumber: number,
        rowData: selectedRow
      });

      const contactId = response.data.contact_id;
      setContactId(contactId);
      setupWebSocket(contactId);
      setMessage(`Call initiated to ${number}. Connecting...`);
    } catch (error) {
      setMessage(`Error: ${error.response?.data?.detail?.error || error.message}`);
      setActiveCall(false);
    } finally {
      setLoading(false);
    }
  };

  const handleExcelUpload = (e) => {
    const file = e.target.files[0];
  
    // Check if a file is selected
    if (!file) {
      setMessage("No file selected.");
      return;
    }
  
    const reader = new FileReader();
  
    reader.onload = (evt) => {
      try {
        // Parse the file into a workbook
        const wb = XLSX.read(evt.target.result, { type: "binary" });
  
        // Check if there are sheets in the workbook
        if (!wb.SheetNames.length) {
          setMessage("No sheets found in the Excel file.");
          return;
        }
  
        // Get the first sheet
        const ws = wb.Sheets[wb.SheetNames[0]];
  
        // Convert sheet data to JSON
        const data = XLSX.utils.sheet_to_json(ws, { defval: "" });
  
        // Check if the data is empty
        if (!data.length) {
          setMessage("The Excel sheet is empty.");
          return;
        }
  
        // Update state with the parsed data
        setExcelData(data);
        // setIsAutoCallEnabled(true);
        setCurrentRowIndex(0);
        setReadyToStartAutoCall(true);
        setMessage("Excel file loaded. Click 'Start Auto Call' to begin.");
      } catch (error) {
        setMessage(`Error reading Excel file: ${error.message}`);
        console.error("Excel file reading error:", error);
      }
    };
  
    reader.onerror = (error) => {
      setMessage("Error reading file.");
      console.error("File reader error:", error);
    };
  
    // Read the file as binary string
    reader.readAsBinaryString(file);
  };
  

  const handleExcelRowClick = (row) => {
    const raw = row["Payer Phone"] || row.Phone;
    const normalized = normalizePhone(raw);
    if (!normalized) {
      setMessage("Invalid phone number format.");
      return;
    }
    setNumber(normalized);
    setSelectedRow(row); // Store entire selected row
  };

  const getStatusMessage = () => {
    if (!callStatus) return null;
    const status = callStatus.ContactStatus?.toUpperCase() || callStatus.status;
    return (
      <div className="mt-4 p-3 bg-gray-100 rounded-lg text-sm text-gray-800">
        <p className={`font-semibold ${statusColors[status] || "text-gray-800"}`}>
          Status: {messages[status] || status}
        </p>
        {["CONNECTED", "IN_PROGRESS"].includes(status) && (
          <p className="mt-2 text-green-600">
            <span className="inline-block h-2 w-2 rounded-full bg-green-600 mr-2" />
            Transcription active
          </p>
        )}
        {callStatus.DisconnectReason && (
          <p className="mt-2 text-red-500">Reason: {callStatus.DisconnectReason}</p>
        )}
      </div>
    );
  };

  const transcriptDisplay = () => (
    <div className="mt-4" style={{ gridRow: 'span 1', height: '200px' }}>
      <h3 className="font-semibold mb-1">Live IVR Transcript:</h3>
      <div
        ref={transcriptRef}
        className="p-3 bg-gray-100 rounded-lg overflow-y-auto text-sm text-black"
        style={{ height: '160px' }} // Fixed height
      >
        {transcript || "Waiting for IVR system to connect..."}
      </div>
      <div className="mt-1 text-xs text-gray-500">WebSocket Status: {wsStatus}</div>
    </div>
  );

  const renderExcelTable = () => {
    if (excelData.length === 0) {
      return (
        <div className="h-full flex items-center justify-center">
          <p className="text-sm text-gray-600">No Excel file uploaded yet.</p>
        </div>
      );
    }

    const headers = Object.keys(excelData[0]);

    return (
      <div className="h-full overflow-auto">
        {isAutoCallEnabled && (
          <div className="mb-2 p-2 bg-blue-100 text-blue-800 rounded">
            Processing row {currentRowIndex + 1} of {excelData.length}
          </div>
        )}
        <h2 className="text-lg font-semibold mb-2 text-gray-800">Uploaded Contact List</h2>
        <table className="w-full border border-gray-300 rounded-lg text-sm bg-white text-gray-800">
          <thead className="bg-gray-200 sticky top-0 z-10">
            <tr>
              {headers.map((header, idx) => (
                <th key={idx} className="px-4 py-2 border-b font-semibold text-left">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {excelData.map((row, idx) => (
              <tr
              key={idx}
              className={`hover:bg-blue-50 ${
                isAutoCallEnabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
              }`}
              onClick={!isAutoCallEnabled ? () => handleExcelRowClick(row) : undefined}
            >
                {headers.map((header, i) => (
                  <td key={i} className="px-4 py-2 border-b">{row[header]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const buttonText = () => {
    if (retryDelay > 0) return `Retry in ${retryDelay}s`;
    return loading ? "Initiating Call..." : "Make Call";
  };

  return (
    <div className="grid grid-cols-[40%_60%] h-screen overflow-hidden font-sans">
      <NotificationToast />
      {/* LEFT SIDE - Fixed width */}
      <div className="p-6 bg-white border-r border-gray-300 text-gray-900 overflow-y-auto">
        <h1 className="text-2xl font-bold mb-6">Integrity: Call Automation</h1>

        {/* File upload */}
        <div className="mb-6">
          <label className="block text-sm font-medium mb-1">Upload Excel (.xlsx)</label>
          <input
            type="file"
            accept=".xlsx, .xls"
            onChange={handleExcelUpload}
            className="w-full p-2 border border-gray-300 rounded-lg"
          />
        </div>

        {/* Phone display (read-only) */}
<div className="mb-6">
  <label className="block text-sm font-medium mb-1">Selected Phone Number</label>
  <div className="w-full p-3 border border-gray-300 rounded-lg bg-gray-100">
    {number ? (
      <span>{number}</span>
    ) : (
      <span className="text-gray-400">No number selected</span>
    )}
  </div>
</div>

<button
        onClick={handleCall}
        disabled={!number || loading || isAutoCallEnabled}
        className="w-full p-3 text-white font-semibold rounded-lg mb-6 transition 
                   bg-black hover:bg-gray-800 
                   disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed"
      >
        {buttonText()}
      </button>

      <div className="mb-4">
  <label className="block text-sm font-medium mb-1">
    Delay between calls (seconds):
  </label>
  <input
    type="number"
    value={nextCallDelay / 1000}
    onChange={(e) => setNextCallDelay(Math.max(1, e.target.value) * 1000)}
    className="w-full p-2 border border-gray-300 rounded-lg"
    min="1"
    max="60"
  />
</div>

{isAutoCallEnabled && pendingProceed && (
  <div className="mb-4 p-3 bg-yellow-100 rounded-lg">
    <p className="text-sm mb-2">Proceed to next call (Row {currentRowIndex + 2})?</p>
    <div className="flex gap-2">
      <button
        onClick={handleProceed}  // Proceed to next row when user confirms
        className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
      >
        Proceed to Row {currentRowIndex + 2}
      </button>
      <button
        onClick={() => {
          setIsAutoCallEnabled(false);
          setPendingProceed(false);
          setCurrentRowIndex(0); // Reset to the first row
        }}
        className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
      >
        Stop Sequence
      </button>
    </div>
  </div>
)}

{readyToStartAutoCall && !isAutoCallEnabled && (
  <div className="mb-4 p-3 bg-blue-100 rounded-lg">
    <p className="text-sm mb-2">Ready to start auto-call sequence ({excelData.length} contacts)</p>
    <button
      onClick={() => {
        setIsAutoCallEnabled(true);
        setReadyToStartAutoCall(false);
      }}
      className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
    >
      Start Auto Call
    </button>
  </div>
)}

<div className="mb-4">
  <label className="flex items-center space-x-2">
    <input
      type="checkbox"
      checked={requiresConfirmation}
      onChange={(e) => setRequiresConfirmation(e.target.checked)}
      className="form-checkbox"
    />
    <span className="text-sm">Require confirmation between calls</span>
  </label>
</div>


        {/* Status messages */}
        {message && <div className="text-sm mb-4 text-blue-700">{message}</div>}
        {getStatusMessage()}

        {/* Transcript - Fixed height */}
        {transcriptDisplay()}

        {agentConnected && <AgentConnectionPopup />}


        <div className="mt-4 p-3 bg-blue-50 rounded-lg">
          <h3 className="font-semibold mb-2">Automated Responses:</h3>
          {sentResponses.length === 0 ? (
            <p className="text-sm text-gray-600">Waiting for customer questions...</p>
          ) : (
            sentResponses.map((res, i) => (
              <div key={i} className="mb-2 p-2 border border-blue-200 rounded text-sm text-gray-800 bg-white">
                <div><span className="font-semibold text-blue-600">🗣 Question:</span> {res.question}</div>
                <div><span className="font-semibold text-green-600">📄 Field:</span> {res.field}</div>
                <div><span className="font-semibold text-purple-600">✅ Answer:</span> {res.value}</div>
                <div className="text-xs text-gray-400 mt-1">{res.timestamp}</div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* RIGHT SIDE */}
      <div
      ref={ccpContainerRef}
      style={{
        width: "340px",
        height: "600px",
        position: "fixed",
        bottom: "20px",
        right: "20px",
        border: "1px solid #ccc",
        zIndex: 1000,
        backgroundColor: "white",
        borderRadius: "4px",
        boxShadow: "0 2px 10px rgba(0,0,0,0.1)"
      }}
    />

      <div className="p-6 bg-gray-100 overflow-y-auto" style={{ height: '100vh' }}>
        {renderExcelTable()}
      </div>
    </div>
  );
}

export default App;