import "@fontsource/work-sans/400.css";
import "@fontsource/work-sans/500.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "./styles/app.css";
import "./styles/voice-caption.css";

import React from "react";
import { VoiceCaptionWindow } from "./components/voice/VoiceCaptionWindow";
import { renderReactRoot } from "./lib/react-root";

const root = document.getElementById("root")!;
if (/Windows/i.test(navigator.userAgent)) {
  root.dataset.platform = "windows";
}

renderReactRoot(
  root,
  <React.StrictMode><VoiceCaptionWindow /></React.StrictMode>,
  import.meta.hot?.data,
);

if (import.meta.hot) {
  import.meta.hot.accept();
}
