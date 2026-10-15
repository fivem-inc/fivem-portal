import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './App.css'
import App from './App.tsx'
import { bootMark } from './lib/bootMark'
import { initTextScale } from './lib/textScale'
// 🚨 「ホーム画面に追加」の合図（beforeinstallprompt）は開いた直後に1回だけ来るので、画面より先に受け取る
import './lib/installPrompt'

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// 🚨 起動の通過時刻の印（lib/bootMark.ts）。処理は増やしていない
bootMark('boot:1 アプリが動き出した');

// 文字の大きさ（右上のメニューで本人が選ぶ・lib/textScale.ts）。画面を描く前に効かせて、一瞬小さく見えるのを防ぐ
initTextScale();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)