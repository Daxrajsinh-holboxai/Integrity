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
  const mediaConnected = useRef(false);
  // const connectionRef = useRef(null);
  const [agent, setAgent] = useState(null);


  // Initialize CCP on component mount
  // Initialize CCP
  useEffect(() => {
    if (ccpContainerRef.current && !window.connect) {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/amazon-connect-streams@2.18.1/release/connect-streams.min.js";
      script.onload = () => initializeCCP();
      document.body.appendChild(script);
    } else if (window.connect) {
      initializeCCP();
    }
  }, []);

  const initializeCCP = () => {
    connect.core.initCCP(ccpContainerRef.current, {
      ccpUrl: "https://dax-holbox.awsapps.com/connect/ccp-v2/",
      loginPopup: true,
      softphone: {
        allowFramedSoftphone: true
      }
    });

    // Subscribe to agent events
    connect.agent((agent) => {
      setAgent(agent);
      
      agent.onContactPending((contact) => {
        const connection = contact.getConnections().find(
          c => c.getType() === connect.ConnectionType.OUTBOUND
        );
        
        if (connection) {
          setActiveConnection(connection);
          connection.onConnectionEvent(({ eventType }) => {
            if (eventType === connect.ConnectionEventType.CONNECTED) {
              mediaConnected.current = true;
            }
            if (eventType === connect.ConnectionEventType.DISCONNECTED) {
              mediaConnected.current = false;
              setActiveConnection(null);
            }
          });
        }
      });
    });
  };

  // DTMF Sending Function
  const sendDTMFDigits = useCallback((digits) => {
    if (!activeConnection || !mediaConnected.current) {
      addNotification("Cannot send DTMF - no active call", 'error');
      return false;
    }
    
    try {
      activeConnection.sendDigits(digits);
      addNotification(`Sent DTMF: ${digits}`, 'success');
      return true;
    } catch (error) {
      addNotification(`DTMF failed: ${error.message}`, 'error');
      return false;
    }
  }, [activeConnection]);

  const wsRef = useRef(null);
  const transcriptRef = useRef(null);
  
  const statusColors = {
    INITIATED: "text-yellow-600",
    QUEUED: "text-yellow-600",
    CONNECTING: "text-yellow-600",
    CONNECTED: "text-green-600",
    FAILED: "text-red-600",
    COMPLETED: "text-blue-600",
  };

  const messages = {
    INITIATED: "Call is being initiated...",
    QUEUED: "Call is in queue",
    CONNECTING: "Connecting to IVR system...",
    CONNECTED: "Connected to IVR system",
    FAILED: "Call failed",
    COMPLETED: "Call completed",
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
            : 'bg-green-100 border-green-400 text-green-700'
        }`}
      >
        <span className="mr-2">
          {notification.type === 'error' ? '❌' : '✅'}
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
    const digits = phone.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return "";
  };

  const setupWebSocket = (contactId) => {
    if (wsRef.current) wsRef.current.close();

    const newWs = new WebSocket(`ws://localhost:3001/ws/${contactId}`);
    wsRef.current = newWs;
    setWsStatus("connecting");

    newWs.onopen = () => setWsStatus("connected");

    newWs.onmessage = (event) => {
      // console.log("WebSocket message:", event.data);
      const data = JSON.parse(event.data);
      if (data.transcript) setTranscript(data.transcript);
      if (data.responseSent) {
        setSentResponses(prev => [...prev, data.responseSent]);

        // Check if we need to send DTMF
        // console.log("Response sent:", data.responseSent); 
        if (data.responseSent.field === "press a number") {
            console.log("DTMF condition true:", data.responseSent.value);
          // handleSendDTMF(data.responseSent.value);
          // notifications(`Response sent: ${data.responseSent.value}`);
          sendDTMFDigits(data.responseSent.value);
          console.log("DTMF sent:", data.responseSent.value);
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
    const reader = new FileReader();

    reader.onload = (evt) => {
      const wb = XLSX.read(evt.target.result, { type: "binary" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws, { defval: "" });
      setExcelData(data);
    };

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
    const status = callStatus.ContactStatus || callStatus.status;
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
                className="hover:bg-blue-50 cursor-pointer"
                onClick={() => handleExcelRowClick(row)}
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

        {/* Phone input */}
        <div className="mb-6">
          <label className="block text-sm font-medium mb-1">Or Enter Phone Number</label>
          <input
            type="text"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            className="w-full p-3 border border-gray-300 rounded-lg"
            placeholder="+1234567890"
          />
        </div>

        <button
          onClick={handleCall}
          disabled={!number || loading}
          className={`w-full p-3 text-white font-semibold rounded-lg mb-6 ${
            !number || loading ? "bg-gray-400" : "bg-black hover:bg-gray-800"
          } transition`}
        >
          {buttonText()}
        </button>

        {/* Status messages */}
        {message && <div className="text-sm mb-4 text-blue-700">{message}</div>}
        {getStatusMessage()}

        {/* Transcript - Fixed height */}
        {transcriptDisplay()}


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