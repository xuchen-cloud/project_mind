import "@fontsource/work-sans/400.css";
import "@fontsource/work-sans/500.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "./styles/app.css";
import "./styles/voice-caption.css";

import React from "react";
import ReactDOM from "react-dom/client";
import { VoiceCaptionWindow } from "./components/voice/VoiceCaptionWindow";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><VoiceCaptionWindow /></React.StrictMode>,
);
