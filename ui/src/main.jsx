import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import App from './App.jsx';
import './theme.css';
import './app.css';

// ?shot=1: screenshot mode — no SSE (api.js) and no animations, so headless
// virtual time can expire and the capture shows the settled page.
if (new URLSearchParams(location.search).get('shot')) {
  document.documentElement.classList.add('no-anim');
}

createRoot(document.getElementById('root')).render(
  <MotionConfig reducedMotion="user">
    <App />
  </MotionConfig>
);
