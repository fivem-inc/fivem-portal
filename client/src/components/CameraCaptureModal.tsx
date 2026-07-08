import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { estimateBlurScore, BLUR_WARNING_THRESHOLD } from '../lib/blurDetect';

const MAX_CAMERA_EDGE = 1600;
const JPEG_QUALITY = 0.82;

export interface CameraCaptureHandle {
  open: () => void;
}

interface CameraCaptureModalProps {
  title: string;
  uploading: boolean;
  onCapture: (blob: Blob) => void;
  onOpenFolderPicker: () => void;
  onUseStandardCamera: () => void;
}

// レシート撮影（ReceiptUploader.tsx）・見積書撮影（QuoteFileUploader.tsx）で共通利用する
// アプリ内カメラ撮影モーダル。撮影後は必ず確認画面を挟み、ぼやけ具合をヒント表示する。
const CameraCaptureModal = forwardRef<CameraCaptureHandle, CameraCaptureModalProps>(
  ({ title, uploading, onCapture, onOpenFolderPicker, onUseStandardCamera }, ref) => {
    const [cameraOpen, setCameraOpen] = useState(false);
    const [cameraStarting, setCameraStarting] = useState(false);
    const [cameraError, setCameraError] = useState('');
    const [capturedPhoto, setCapturedPhoto] = useState<{ blob: Blob; url: string; blurWarning: boolean } | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const cameraStreamRef = useRef<MediaStream | null>(null);

    const stopCamera = () => {
      cameraStreamRef.current?.getTracks().forEach(track => track.stop());
      cameraStreamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };

    const discardCapturedPhoto = () => {
      setCapturedPhoto(prev => {
        if (prev) URL.revokeObjectURL(prev.url);
        return null;
      });
    };

    useEffect(() => () => { stopCamera(); discardCapturedPhoto(); }, []);

    const openCamera = async () => {
      setCameraError('');
      discardCapturedPhoto();

      if (!navigator.mediaDevices?.getUserMedia) {
        onOpenFolderPicker();
        return;
      }

      setCameraOpen(true);
      setCameraStarting(true);
      stopCamera();

      try {
        // widthだけ指定すると機種が動画撮影用の縦長プリセット（9:16等）を選ぶことがあり、
        // width+heightを固定すると逆にズームした狭い画角になる機種がある。
        // aspectRatioで自然な縦横比だけ緩く指定し、実際の解像度は機種のカメラに選ばせる
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1600 }, aspectRatio: { ideal: 3 / 4 } },
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
        setCameraError('カメラを起動できませんでした。下のボタンからお試しください。');
      } finally {
        setCameraStarting(false);
      }
    };

    useImperativeHandle(ref, () => ({ open: openCamera }));

    const closeCamera = () => {
      setCameraOpen(false);
      setCameraError('');
      stopCamera();
      discardCapturedPhoto();
    };

    const captureCameraPhoto = async () => {
      const video = videoRef.current;
      if (!video || !video.videoWidth || !video.videoHeight) {
        setCameraError('カメラ画像を取得できませんでした。下のボタンからお試しください。');
        return;
      }

      // プレビューはobject-fit: coverで画面いっぱいに表示しているため、
      // 撮影結果もプレビューで見えている範囲だけを切り出す（見た目通りに撮れるように）
      const rect = video.getBoundingClientRect();
      const containerAspect = rect.width / rect.height;
      const videoAspect = video.videoWidth / video.videoHeight;
      let sx = 0, sy = 0, sWidth = video.videoWidth, sHeight = video.videoHeight;
      if (videoAspect > containerAspect) {
        sHeight = video.videoHeight;
        sWidth = sHeight * containerAspect;
        sx = (video.videoWidth - sWidth) / 2;
      } else {
        sWidth = video.videoWidth;
        sHeight = sWidth / containerAspect;
        sy = (video.videoHeight - sHeight) / 2;
      }

      const scale = Math.min(1, MAX_CAMERA_EDGE / Math.max(sWidth, sHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sWidth * scale));
      canvas.height = Math.max(1, Math.round(sHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setCameraError('このブラウザでは撮影画像を処理できません。下のボタンからお試しください。');
        return;
      }
      ctx.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
      if (!blob) {
        setCameraError('撮影画像を保存できませんでした。もう一度撮影してください。');
        return;
      }

      // 撮影直後は必ず確認画面を挟み、本人が写真を見てから送るかどうかを判断できるようにする。
      // ぼやけ具合の自動判定はあくまでヒントとして警告表示するだけで、送信のブロックはしない
      const blurWarning = estimateBlurScore(canvas) < BLUR_WARNING_THRESHOLD;
      stopCamera();
      setCapturedPhoto({ blob, url: URL.createObjectURL(blob), blurWarning });
    };

    const confirmCapturedPhoto = () => {
      if (!capturedPhoto) return;
      onCapture(capturedPhoto.blob);
    };

    const retakePhoto = () => {
      discardCapturedPhoto();
      openCamera();
    };

    if (!cameraOpen) return null;

    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: '#000', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#fff', padding: '12px 16px' }}>
          <div style={{ fontSize: 16, fontWeight: 'bold' }}>{capturedPhoto ? '撮影内容を確認' : title}</div>
          <button type="button" onClick={closeCamera} style={{ border: 'none', background: 'rgba(255,255,255,0.16)', color: '#fff', borderRadius: 20, width: 36, height: 36, fontSize: 18 }}>
            ✕
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, background: '#000', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {capturedPhoto ? (
            <img src={capturedPhoto.url} alt="撮影内容" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          ) : (
            // videoは常にマウントしておく（起動中に外すとvideoRefがnullになりストリームを接続できない）
            <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          )}
          {!capturedPhoto && cameraStarting && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, background: '#000' }}>
              カメラを起動しています...
            </div>
          )}
          {!capturedPhoto && cameraError && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, padding: 18, textAlign: 'center', lineHeight: 1.7, background: '#000', boxSizing: 'border-box' }}>
              {cameraError}
            </div>
          )}
          {capturedPhoto?.blurWarning && (
            <div style={{ position: 'absolute', top: 10, left: 10, right: 10, padding: '10px 12px', background: 'rgba(224,168,0,0.92)', color: '#000', borderRadius: 8, fontSize: 13, lineHeight: 1.5 }}>
              ⚠️ 画像がぼやけている可能性があります。文字が読み取れるか確認し、必要なら撮り直してください。
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 16px 20px' }}>
          {capturedPhoto ? (
            <>
              <button
                type="button"
                onClick={confirmCapturedPhoto}
                disabled={uploading}
                style={{ width: '100%', padding: '15px', borderRadius: 12, border: 'none', background: uploading ? '#777' : '#28a745', color: '#fff', fontSize: 16, fontWeight: 'bold' }}
              >
                {uploading ? 'アップロード中...' : 'この写真を使う'}
              </button>
              <button
                type="button"
                onClick={retakePhoto}
                disabled={uploading}
                style={{ width: '100%', padding: '13px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.28)', background: 'rgba(255,255,255,0.08)', color: '#fff', fontSize: 14, fontWeight: 'bold' }}
              >
                撮り直す
              </button>
            </>
          ) : cameraError ? (
            <button
              type="button"
              onClick={() => { closeCamera(); onUseStandardCamera(); }}
              style={{ width: '100%', padding: '15px', borderRadius: 12, border: 'none', background: '#28a745', color: '#fff', fontSize: 16, fontWeight: 'bold' }}
            >
              標準カメラアプリで撮影する
            </button>
          ) : (
            <button
              type="button"
              onClick={captureCameraPhoto}
              disabled={cameraStarting}
              style={{ width: '100%', padding: '15px', borderRadius: 12, border: 'none', background: cameraStarting ? '#777' : '#28a745', color: '#fff', fontSize: 16, fontWeight: 'bold' }}
            >
              撮影する
            </button>
          )}
          {!capturedPhoto && (
            <button
              type="button"
              onClick={() => { closeCamera(); onOpenFolderPicker(); }}
              style={{ width: '100%', padding: '13px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.28)', background: 'rgba(255,255,255,0.08)', color: '#fff', fontSize: 14, fontWeight: 'bold' }}
            >
              写真フォルダから選ぶ
            </button>
          )}
        </div>
      </div>
    );
  }
);

CameraCaptureModal.displayName = 'CameraCaptureModal';

export default CameraCaptureModal;
