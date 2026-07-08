import React, { useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { compressImageFile, ImageTooLargeError } from '../lib/imageCompress';
import CameraCaptureModal, { type CameraCaptureHandle } from './CameraCaptureModal';

interface QuoteFileUploaderProps {
  isDarkMode: boolean;
  userId: string;
  draftId: string;
  value: string | null;
  onChange: (path: string | null) => void;
}

const QuoteFileUploader: React.FC<QuoteFileUploaderProps> = ({ isDarkMode, userId, draftId, value, onChange }) => {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraFallbackInputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<CameraCaptureHandle>(null);

  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';
  const inputBg = isDarkMode ? '#3a3a5c' : '#f8f9fa';

  const uploadBlob = async (blob: Blob, isPdf: boolean) => {
    setUploading(true);
    setUploadError('');
    try {
      const finalBlob = isPdf
        ? blob
        : blob instanceof File
          ? await compressImageFile(blob)
          : blob; // カメラ撮影blobは既に圧縮済み
      const ext = isPdf ? 'pdf' : 'jpg';
      const contentType = isPdf ? 'application/pdf' : 'image/jpeg';
      const path = `${userId}/${draftId}/${Date.now()}_quote.${ext}`;
      const { error } = await supabase.storage
        .from('purchase-receipts')
        .upload(path, finalBlob, { contentType, upsert: false });
      if (error) throw error;
      onChange(path);
    } catch (e) {
      const isPdfTooLarge = e instanceof Error && e.name === 'PdfTooLargeError';
      setUploadError(
        e instanceof ImageTooLargeError || isPdfTooLarge
          ? (e as Error).message
          : 'アップロードに失敗しました。もう一度お試しください。'
      );
    } finally {
      setUploading(false);
    }
  };

  const handleFileSelected = async (file: File) => {
    const isPdf = file.type === 'application/pdf';
    if (isPdf) {
      setUploading(true);
      setUploadError('');
      try {
        // pdfjs-dist/pdf-libは容量が大きいため、PDFが実際に選択された時だけ動的読み込みする
        const { compressPdfFile } = await import('../lib/pdfCompress');
        const compressed = await compressPdfFile(file);
        await uploadBlob(compressed, true);
      } catch (e) {
        const isPdfTooLarge = e instanceof Error && e.name === 'PdfTooLargeError';
        setUploadError(isPdfTooLarge ? (e as Error).message : 'アップロードに失敗しました。もう一度お試しください。');
        setUploading(false);
      }
      return;
    }
    await uploadBlob(file, false);
  };

  const handleCameraCapture = async (blob: Blob) => {
    await uploadBlob(blob, false);
  };

  const openCameraFallback = () => cameraFallbackInputRef.current?.click();
  const openCamera = () => {
    setUploadError('');
    cameraRef.current?.open();
  };

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6 }}>見積書の写真・PDF（任意）</div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf"
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

      {!value && !uploading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            style={{ width: '100%', padding: '10px', borderRadius: 8, border: `1px dashed ${border}`, background: 'transparent', color: subText, fontSize: 13, cursor: 'pointer' }}
          >
            📎 フォルダから選ぶ（写真 / PDF）
          </button>
          <button
            type="button"
            onClick={openCamera}
            style={{ width: '100%', padding: '10px', borderRadius: 8, border: `1px dashed ${border}`, background: 'transparent', color: subText, fontSize: 13, cursor: 'pointer' }}
          >
            📷 カメラで撮影する
          </button>
        </div>
      )}
      {uploading && <div style={{ padding: 10, textAlign: 'center', color: subText, fontSize: 13 }}>アップロード中...</div>}
      {value && !uploading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, background: inputBg, borderRadius: 8 }}>
          <span style={{ color: '#28a745', fontSize: 16 }}>✓</span>
          <span style={{ fontSize: 13, color: text, flex: 1 }}>見積書を添付しました</span>
          <button type="button" onClick={() => fileInputRef.current?.click()} style={{ background: 'none', border: 'none', color: '#4a90d9', fontSize: 12, cursor: 'pointer' }}>
            差し替える
          </button>
          <button type="button" onClick={() => onChange(null)} style={{ background: 'none', border: 'none', color: '#dc3545', fontSize: 12, cursor: 'pointer' }}>
            削除
          </button>
        </div>
      )}
      {uploadError && (
        <div style={{ marginTop: 8, padding: 10, background: '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, color: '#842029', fontSize: 13 }}>
          {uploadError}
        </div>
      )}

      <CameraCaptureModal
        ref={cameraRef}
        title="見積書を撮影"
        uploading={uploading}
        onCapture={handleCameraCapture}
        onOpenFolderPicker={() => fileInputRef.current?.click()}
        onUseStandardCamera={openCameraFallback}
      />
    </div>
  );
};

export default QuoteFileUploader;
