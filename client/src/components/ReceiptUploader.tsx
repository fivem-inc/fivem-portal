import React, { useState, useRef } from 'react';
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

const ReceiptUploader: React.FC<ReceiptUploaderProps> = ({ isDarkMode, userId, draftId, value, onChange, onUploadingChange }) => {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadingLabel, setUploadingLabel] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

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

  const handleSelectType = (type: ReceiptType) => {
    setUploadError('');
    onChange({ receiptType: type, receiptStoragePath: null, receiptMissingReason: '' });
  };

  const getUploadTarget = (file: File, uploadFile: Blob) => {
    const contentType = uploadFile.type || file.type || 'application/octet-stream';
    const extension = contentType === 'image/jpeg'
      ? 'jpg'
      : contentType === 'image/png'
        ? 'png'
        : contentType === 'image/webp'
          ? 'webp'
          : (file.name.split('.').pop() || 'jpg').toLowerCase();

    return {
      path: `${userId}/${draftId}/${Date.now()}_receipt.${extension}`,
      contentType,
    };
  };

  const handleFileSelected = async (file: File, source: 'folder' | 'camera') => {
    setUploadState(true);
    setUploadingLabel(source === 'camera' ? '撮影した写真をアップロード中...' : '写真をアップロード中...');
    setUploadError('');
    onChange({ receiptType: 'photo', receiptStoragePath: null, receiptMissingReason: '' });

    try {
      const uploadFile = await compressImageFile(file);
      const { path, contentType } = getUploadTarget(file, uploadFile);
      const { error } = await supabase.storage
        .from('purchase-receipts')
        .upload(path, uploadFile, { contentType, upsert: false });
      if (error) throw error;
      onChange({ receiptType: 'photo', receiptStoragePath: path, receiptMissingReason: '' });
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
          onClick={() => cameraInputRef.current?.click()}
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
          if (file) handleFileSelected(file, 'folder');
          e.target.value = '';
        }}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) handleFileSelected(file, 'camera');
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
                  onClick={() => cameraInputRef.current?.click()}
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
                  onClick={() => cameraInputRef.current?.click()}
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
    </div>
  );
};

export default ReceiptUploader;
