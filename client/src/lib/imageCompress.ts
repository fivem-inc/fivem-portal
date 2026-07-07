// レシート写真をアップロード前にブラウザ側でリサイズ・圧縮する（新規npm依存なし）
// ユーザーには見えない裏側処理として扱うこと（画面上に圧縮の説明は出さない）

export const MAX_LONG_EDGE = 1600;
export const JPEG_QUALITY = 0.8;
const MAX_SOURCE_FILE_BYTES = 20 * 1024 * 1024; // 20MB超の元ファイルは圧縮前に拒否

export class ImageTooLargeError extends Error {}

const canvasToJpegBlob = (canvas: HTMLCanvasElement): Promise<Blob> => (
  new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('画像の圧縮に失敗しました'));
    }, 'image/jpeg', JPEG_QUALITY);
  })
);

const drawToCanvas = (source: CanvasImageSource, width: number, height: number) => {
  const scale = Math.min(1, MAX_LONG_EDGE / Math.max(width, height));
  const targetW = Math.max(1, Math.round(width * scale));
  const targetH = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas未対応のブラウザです');
  ctx.drawImage(source, 0, 0, targetW, targetH);
  return canvas;
};

// 最新スマホは4800万画素超の写真を撮ることがあり、フル解像度のまま一度メモリに展開すると
// 端末によってはタブごとメモリ不足でクラッシュする。先に小さいプローブでアスペクト比だけ取得し、
// 本番デコードは resizeWidth/resizeHeight を指定してブラウザに縮小デコードさせることで
// フル解像度のピクセルバッファを一切確保しないようにする。
const compressWithBitmap = async (file: File): Promise<Blob> => {
  if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap未対応のブラウザです');

  const probe = await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: 256 });
  const aspect = probe.height / probe.width;
  probe.close?.();

  const targetW = aspect <= 1 ? MAX_LONG_EDGE : Math.max(1, Math.round(MAX_LONG_EDGE / aspect));
  const targetH = aspect <= 1 ? Math.max(1, Math.round(MAX_LONG_EDGE * aspect)) : MAX_LONG_EDGE;

  const bitmap = await createImageBitmap(file, {
    imageOrientation: 'from-image',
    resizeWidth: targetW,
    resizeHeight: targetH,
    resizeQuality: 'medium',
  });
  try {
    return await canvasToJpegBlob(drawToCanvas(bitmap, bitmap.width, bitmap.height));
  } finally {
    bitmap.close?.();
  }
};

const compressWithImageElement = async (file: File): Promise<Blob> => {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('画像を読み込めませんでした'));
      image.src = url;
    });
    return await canvasToJpegBlob(drawToCanvas(img, img.naturalWidth || img.width, img.naturalHeight || img.height));
  } finally {
    URL.revokeObjectURL(url);
  }
};

export async function compressImageFile(file: File): Promise<Blob> {
  if (file.size > MAX_SOURCE_FILE_BYTES) {
    throw new ImageTooLargeError('画像サイズが大きすぎます（20MB以下にしてください）');
  }

  try {
    return await compressWithBitmap(file);
  } catch (bitmapError) {
    try {
      return await compressWithImageElement(file);
    } catch {
      if (bitmapError instanceof ImageTooLargeError) throw bitmapError;
      // HEIC等、ブラウザ側で画像として読めない形式だけ元ファイルのままアップロードする
      return file;
    }
  }
}
