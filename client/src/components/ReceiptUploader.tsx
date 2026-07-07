import React, { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { compressImageFile, ImageTooLargeError } from '../lib/imageCompress';

export type ReceiptType = 'photo' | 'physical' | 'none';

export interface ReceiptValue {
  receiptType: ReceiptType | '';
  receiptStoragePath: string | null;
  receiptMissingReason: string;
}

interface ReceiptUploaderProps {
  isDarkMode: boolean;
  userId: string;
  draftId: string;
  value: ReceiptValue;
  onChange: (patch: Partial<ReceiptValue>) => void;
  onUploadingChange?: (uploading: boolean) => void;
}

const OPTIONS: { key: ReceiptType; icon: string; label: string }[] = [
  { key: 'photo', icon: '📷', label: '写真をアップロードする' },
  { key: 'physical', icon: '📄', label: 'レシートを直接提出する' },
  { key: 'none', icon: '✏️', label: 'レシートがない（理由を記入）' },
];

const MAX_CAMERA_EDGE = 1600;
const JPEG_QUALITY = 0.82;

const ReceiptUploader: React.FC<ReceiptUploaderProps> = ({ isDarkMode, userId, draftId, value, onChange, onUploadingChange }) => {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadingLabel, setUploadingLabel] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraFallbackInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);

  const cardBg = isDarkMode ? '#2d2d3e' : '#ffffff';
  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const activeBorder = '#28a745';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';
  const inputBg = isDarkMode ? '#3a3a5c' : '#f8f9fa';

  const setUploadState = (next: boolean) => {
    setUploading(next);
    onUploadingChange?.(next);
  };

  const stopCamera = () => {
    cameraStreamRef.current?.getTracks().forEach(track => track.stop());
    cameraStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  useEffect(() => () => stopCamera(), []);

  const handleSelectType = (type: ReceiptType) => {
    setUploadError('');
    onChange({ receiptType: type, receiptStoragePath: null, receiptMissingReason: '' });
    if (type !== 'photo') {
      setCameraOpen(false);
      stopCamera();
    }
  };

  const getUploadTarget = (contentType: string, originalName?: string) => {
    const extension = contentType === 'image/jpeg'
      ? 'jpg'
      : contentType === 'image/png'
        ? 'png'
        : contentType === 'image/webp'
          ? 'webp'
          : (originalName?.split('.').pop() || 'jpg').toLowerCase();

    return {
      path: `${userId}/${draftId}/${Date.now()}_receipt.${extension}`,
      contentType: contentType || 'image/jpeg',
    };
  };

  const uploadReceiptBlob = async (uploadFile: Blob, source: 'folder' | 'camera', originalName?: string) => {
    setUploadState(true);
    setUploadingLabel(source === 'camera' ? '撮影した写真をアップロード中...' : '写真をアップロード中...');
    setUploadError('');
    onChange({ receiptType: 'photo', receiptStoragePath: null, receiptMissingReason: '' });

    try {
      const { path, contentType } = getUploadTarget(uploadFile.type || 'image/jpeg', originalName);
      const { error } = await supabase.storage
        .from('purchase-receipts')
        .upload(path, uploadFile, { contentType, upsert: false });
      if (error) throw error;
      onChange({ receiptType: 'photo', receiptStoragePath: path, receiptMissingReason: '' });
      setCameraOpen(false);
      stopCamera();
    } catch (e) {
      setUploadError(
        e instanceof ImageTooLargeError
          ? e.message
          : e instanceof Error && e.message
            ? `画像のアップロードに失敗しました: ${e.message}`
            : '画像のアップロードに失敗しました。もう一度お試しください。'
      );
    } finally {
      setUploadState(false);
      setUploadingLabel('');
    }
  };

  const handleFileSelected = async (file: File) => {
    try {
      const uploadFile = await compressImageFile(file);
      await uploadReceiptBlob(uploadFile, 'folder', file.name);
    } catch (e) {
      setUploadError(e instanceof Error && e.message ? e.message : '画像を読み込めませんでした。もう一度お試しください。');
    }
  };

  const openCamera = async () => {
    setUploadError('');
    setCameraError('');
    onChange({ receiptType: 'photo', receiptStoragePath: null, receiptMissingReason: '' });

    if (!navigator.mediaDevices?.getUserMedia) {
      cameraFallbackInputRef.current?.click();
      return;
    }

    setCameraOpen(true);
    setCameraStarting(true);
    stopCamera();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1600 }, height: { ideal: 1200 } },
        audio: false,
      });
      cameraStreamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error('video element not mounted');
      video.srcObject = stream;
      // iOS Safariでは映像サイズが確定する前に撮影すると空画像になるため、metadata確定を待つ
      if (!video.videoWidth) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('camera metadata timeout')), 8000);
          video.onloadedmetadata = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      await video.play();
    } catch {
      stopCamera();
      setCameraError('カメラを起動できませんでした。写真フォルダから選ぶか、ブラウザのカメラ許可を確認してください。');
    } finally {
      setCameraStarting(false);
    }
  };

  const closeCamera = () => {
    setCameraOpen(false);
    setCameraError('');
    stopCamera();
  };

  const captureCameraPhoto = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      setCameraError('カメラ画像を取得できませんでした。もう一度撮影してください。');
      return;
    }

    const scale = Math.min(1, MAX_CAMERA_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setCameraError('このブラウザでは撮影画像を処理できません。写真フォルダから選んでください。');
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob) {
      setCameraError('撮影画像を保存できませんでした。もう一度撮影してください。');
      return;
    }

    await uploadReceiptBlob(blob, 'camera', 'camera_receipt.jpg');
  };

  const uploadChoicePanel = (
    <div style={{ marginTop: 8, padding: 10, border: `1px solid ${border}`, borderRadius: 10, background: inputBg }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          style={{ width: '100%', padding: '14px', borderRadius: 10, border: 'none', background: uploading ? subText : '#28a745', color: '#fff', fontSize: 15, fontWeight: 'bold', cursor: uploading ? 'default' : 'pointer' }}
        >
          写真フォルダから選ぶ
        </button>
        <button
          type="button"
          onClick={openCamera}
          disabled={uploading}
          style={{ width: '100%', padding: '14px', borderRadius: 10, border: `1px solid ${border}`, background: cardBg, color: text, fontSize: 15, fontWeight: 'bold', cursor: uploading ? 'default' : 'pointer' }}
        >
          カメラで撮影する
        </button>
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 8 }}>
        レシート <span style={{ color: '#dc3545' }}>*</span>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) handleFileSelected(file);
          e.target.value = '';
        }}
      />
      <input
        ref={cameraFallbackInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) handleFileSelected(file);
          e.target.value = '';
        }}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {OPTIONS.map(opt => {
          const active = value.receiptType === opt.key;
          return (
            <div key={opt.key}>
              <button
                type="button"
                onClick={() => handleSelectType(opt.key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '14px 16px', borderRadius: 10, cursor: 'pointer',
                  background: cardBg, border: `2px solid ${active ? activeBorder : border}`,
                  textAlign: 'left', width: '100%', boxSizing: 'border-box',
                }}
              >
                <span style={{ fontSize: 22 }}>{opt.icon}</span>
                <span style={{ fontSize: 14, color: text, fontWeight: active ? 'bold' : 'normal' }}>{opt.label}</span>
                {active && <span style={{ marginLeft: 'auto', color: activeBorder, fontSize: 18 }}>✓</span>}
              </button>
              {opt.key === 'photo' && active && !value.receiptStoragePath && !uploading && uploadChoicePanel}
            </div>
          );
        })}
      </div>

      {value.receiptType === 'photo' && (
        <div style={{ marginTop: 10 }}>
          {uploading && (
            <div style={{ padding: 12, textAlign: 'center', color: subText, fontSize: 13 }}>
              {uploadingLabel || 'アップロード中...'}このままお待ちください
            </div>
          )}
          {value.receiptStoragePath && !uploading && (
            <div style={{ padding: 10, background: inputBg, borderRadius: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ color: '#28a745', fontSize: 18 }}>✓</span>
                <span style={{ fontSize: 13, color: text, flex: 1 }}>レシートを添付しました</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  style={{ padding: '10px 8px', borderRadius: 8, border: `1px solid ${border}`, background: cardBg, color: '#4a90d9', fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}
                >
                  フォルダから差し替え
                </button>
                <button
                  type="button"
                  onClick={openCamera}
                  style={{ padding: '10px 8px', borderRadius: 8, border: `1px solid ${border}`, background: cardBg, color: '#4a90d9', fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}
                >
                  撮り直す
                </button>
              </div>
            </div>
          )}
          {uploadError && (
            <div style={{ marginTop: 8, padding: 10, background: '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, color: '#842029', fontSize: 13 }}>
              {uploadError}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  style={{ padding: '9px 8px', borderRadius: 8, border: '1px solid #f5c2c7', background: '#fff', color: '#842029', cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}
                >
                  フォルダから選ぶ
                </button>
                <button
                  type="button"
                  onClick={openCamera}
                  style={{ padding: '9px 8px', borderRadius: 8, border: '1px solid #f5c2c7', background: '#fff', color: '#842029', cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}
                >
                  撮り直す
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {value.receiptType === 'none' && (
        <div style={{ marginTop: 10 }}>
          <input
            type="text"
            value={value.receiptMissingReason}
            onChange={e => onChange({ receiptMissingReason: e.target.value })}
            placeholder="レシートがない理由を入力してください"
            style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 14 }}
          />
        </div>
      )}

      {cameraOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.86)', display: 'flex', flexDirection: 'column', padding: 16, boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#fff', marginBottom: 10 }}>
            <div style={{ fontSize: 16, fontWeight: 'bold' }}>レシートを撮影</div>
            <button type="button" onClick={closeCamera} style={{ border: 'none', background: 'rgba(255,255,255,0.16)', color: '#fff', borderRadius: 20, width: 36, height: 36, fontSize: 18 }}>
              x
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, borderRadius: 12, overflow: 'hidden', background: '#111', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {/* videoは常にマウントしておく（起動中に外すとvideoRefがnullになりストリームを接続できない） */}
            <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            {cameraStarting && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, background: '#111' }}>
                カメラを起動しています...
              </div>
            )}
            {cameraError && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, padding: 18, textAlign: 'center', lineHeight: 1.7, background: '#111', boxSizing: 'border-box' }}>
                {cameraError}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            <button
              type="button"
              onClick={captureCameraPhoto}
              disabled={cameraStarting || uploading || Boolean(cameraError)}
              style={{ width: '100%', padding: '15px', borderRadius: 12, border: 'none', background: cameraStarting || uploading || cameraError ? '#777' : '#28a745', color: '#fff', fontSize: 16, fontWeight: 'bold' }}
            >
              {uploading ? 'アップロード中...' : 'この写真を使う'}
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={{ width: '100%', padding: '13px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.28)', background: 'rgba(255,255,255,0.08)', color: '#fff', fontSize: 14, fontWeight: 'bold' }}
            >
              写真フォルダから選ぶ
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReceiptUploader;
