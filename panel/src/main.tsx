import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/theme.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('No se encontró el contenedor #root en index.html');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Non-blocking PWA registration in dev or restricted contexts
    });
  });
}
