import React from 'react';
import { createRoot } from 'react-dom/client';
import type { MesaiApi } from '../shared/ipc-channels';
import { createTauriMesaiApi } from './tauri-bridge';
import { App } from './App';
import './styles.css';

declare global {
  interface Window {
    mesaiApi: MesaiApi;
  }
}

if (!window.mesaiApi) {
  window.mesaiApi = createTauriMesaiApi();
}

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
