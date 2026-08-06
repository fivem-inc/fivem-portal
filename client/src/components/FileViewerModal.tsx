import React, { useEffect, useState } from 'react';
import { getReceiptSignedUrl } from '../lib/receiptView';

interface FileViewerModalProps {
  path: string;
  title: string;
  isDarkMode: boolean;
  onClose: () => void;
}

// 🚨 見積書・レシートは「アプリの中」で表示する。
// iPhoneのSafariは、サーバーから署名付きURLを取ってきた後に window.open で開いた
// 新しいタブをポップアップとみなして無言でブロックするため、以前は押しても何も起きなかった。
// PDFだけは画面内に埋め込むと真っ白になる端末があるので、本物のリンク（<a>）を出す。
// リンクの直接タップは操作した瞬間の遷移なのでブロックされない。
const FileViewerModal: React.FC<FileViewerModalProps> = ({ path, title, isDarkMode, onClose }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');

  const isPdf = /\.pdf$/i.test(path);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setError('');
    (async () => {
      const res = await getReceiptSignedUrl(path);
      if (!alive) return;
      if (res.error || !res.url) setError(res.error ?? 'ファイルを取得できませんでした。');
      else setUrl(res.url);
    })();
    return () => { alive = false; };
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cardBg = isDarkMode ? '#343a40' : '#ffffff';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';
  const border = isDarkMode ? '#495057' : '#e0e0e0';
  const imgBg = isDarkMode ? '#212529' : '#f8f9fa';

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: cardBg, borderRadius: 12, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${border}` }}>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 'bold', color: text }}>{title}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            style={{ background: 'none', border: 'none', color: subText, cursor: 'pointer', fontSize: 18, padding: '0 4px', lineHeight: 1 }}
          >
            ✕
          </button>
        </div>

        {/* エラーは配色ルールどおりライト・ダーク共通の薄赤（暗い赤地だと文字が沈んで読めない） */}
        {error && (
          <div style={{ margin: 12, padding: '10px 12px', borderRadius: 8, background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029', fontSize: 13 }}>
            {error}
          </div>
        )}

        {!error && !url && (
          <div style={{ padding: '28px 12px', textAlign: 'center', fontSize: 13, color: subText }}>取得中...</div>
        )}

        {!error && url && isPdf && (
          <div style={{ padding: '20px 14px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 13, color: subText }}>📄 PDFのファイルです</div>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'block', width: '100%', maxWidth: 260, textAlign: 'center', padding: '10px 12px', borderRadius: 8, background: '#e3f2fd', border: '2px solid #90caf9', color: '#1565c0', fontSize: 14, fontWeight: 'bold', textDecoration: 'none' }}
            >
              PDFを開く
            </a>
            <div style={{ fontSize: 12, color: subText }}>新しいタブで開きます</div>
          </div>
        )}

        {!error && url && !isPdf && (
          <div>
            <div style={{ background: imgBg }}>
              <img
                src={url}
                alt={title}
                onError={() => setError('画像を表示できませんでした。もう一度開いてみてください。')}
                style={{ display: 'block', width: '100%', height: 'auto' }}
              />
            </div>
            {/* 🚨 index.html の viewport に user-scalable=no が入っているため、アプリの中では
                つまんでも拡大できない。細かく読みたいときはブラウザの画像画面で開いてもらう。
                リンクの直接タップなので、iPhoneのポップアップ扱いでブロックされることもない */}
            <div style={{ padding: '12px 14px', display: 'flex', justifyContent: 'center' }}>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: 'block', width: '100%', maxWidth: 260, textAlign: 'center', padding: '10px 12px', borderRadius: 8, background: '#e3f2fd', border: '2px solid #90caf9', color: '#1565c0', fontSize: 14, fontWeight: 'bold', textDecoration: 'none' }}
              >
                画像を大きく開く
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default FileViewerModal;
