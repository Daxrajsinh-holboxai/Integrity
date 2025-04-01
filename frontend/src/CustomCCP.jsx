// CustomCCP.jsx
import React, { useEffect, useRef } from "react";

const CustomCCP = ({ setActiveConnection }) => {
  const ccpContainerRef = useRef(null);
  const scriptLoaded = useRef(false); // Track if the script has been loaded
  const ccpInitialized = useRef(false); // Track initialization state

  useEffect(() => {
    let ccpCleanup;

    const initializeCCP = () => {
      if (!window.connect || !ccpContainerRef.current || ccpInitialized.current) return;

      ccpCleanup = window.connect.core.initCCP(ccpContainerRef.current, {
        ccpUrl: "https://dax-holbox.awsapps.com/connect/ccp-v2/",
        loginPopup: true,
        loginPopupAutoClose: true,
        softphone: {
          allowFramedSoftphone: true,
          disableRingtone: false
        },
        pageOptions: {
          enableAudioDeviceSettings: true,
          enablePhoneTypeSettings: true
        },
        ccpAckTimeout: 10000,
        ccpLoadTimeout: 30000
      });

      ccpInitialized.current = true; // Mark as initialized

      window.connect.agent((agent) => {
        agent.onStateChange((agentStateChange) => {
          console.log("Agent state:", agentStateChange.newState);
        });
      });

      window.connect.contact((contact) => {
        contact.onAccepted(() => {
          const connection = contact.getAgentConnection();
          setActiveConnection(connection);
        });

        // Monitor connection media status
        connection.onMediaConnected(() => {
          console.log("Media connected - DTMF capable");
        });

        connection.onMediaDisconnected(() => {
          console.warn("Media disconnected - DTMF unavailable");
        });

        contact.onEnded(() => {
          setActiveConnection(null);
        });
      });
    };

    // Load streams only once
    if (!scriptLoaded.current) {
        const script = document.createElement("script");
        script.src =
          "https://cdn.jsdelivr.net/npm/amazon-connect-streams@2.18.1/release/connect-streams.min.js";
        script.onload = () => {
          scriptLoaded.current = true; // Mark the script as loaded
          initializeCCP(); // Initialize CCP after the script is loaded
        };
        script.onerror = () => {
          console.error("Error loading Amazon Connect Streams script");
        };
        document.body.appendChild(script);
      } else {
        initializeCCP(); // Initialize CCP if the script is already loaded
      }

    return () => {
      if (ccpCleanup) {
        ccpCleanup.unbind();
        ccpCleanup = null;
      }
      if (ccpContainerRef.current) {
        ccpContainerRef.current.innerHTML = '';
      }
      ccpInitialized.current = false;
    };
  }, [setActiveConnection]);

  return (
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
  );
};

export default CustomCCP;
