import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import DetachedTerminal from "./components/terminal/DetachedTerminal.jsx";

// Import CSS in the correct order
// 1. Variables first (design tokens)
import "./styles/variables.css";
// 2. Base/reset styles
import "./styles/global.css";
// 3. Theme styles for light/dark mode
import "./styles/theme.css";
// 4. Component styles
import "./styles/components.css";
// 5. Modern enhancements and effects
import "./styles/modern.css";

// Do not initialize Explorer state in a standalone terminal WebView.
let isDetachedTerminal = false;
try {
    isDetachedTerminal = getCurrentWebviewWindow().label.startsWith("terminal-");
} catch {
    // Browser development/test environment.
}

// Initialize the application
ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
        {isDetachedTerminal ? <DetachedTerminal /> : <App />}
    </React.StrictMode>
);