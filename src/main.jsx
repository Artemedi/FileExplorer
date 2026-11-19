import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

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

// Initialize the application
ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);