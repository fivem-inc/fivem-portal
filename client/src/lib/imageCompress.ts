// レシート写真をアップロード前にブラウザ側でリサイズ・圧縮する（新規npm依存なし）
// ユーザーには見えない裏側処理として扱うこと（画面上に圧縮の説明は出さない）

export const MAX_LONG_EDGE = 1600;
export const JPEG_QUALITY = 0.8;
const MAX_SOURCE_FILE_BYTES = 20 * 1024 * 1024; // 20MB超の元ファイルは圧縮前に拒否

export class ImageTooLargeError extends Error {}

export async function compressImageFile(file: File): Promise<Blob> {
  if (file.size > MAX_SOURCE_FILE_BYTES) {
    throw new ImageTooLargeError('画像サイズが大きすぎます（20MB以下にしてください）');
  }

  try {
    // imageOrientation: 'from-image' を指定しないと、iPhone等の縦撮り写真が
    // EXIF回転情報を無視されてcanvas上で横向きに描画されてしまう
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
    const targetW = Math.round(bitmap.width * scale);
    const targetH = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas未対応のブラウザです');
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);

    const blob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
    });
    if (!blob) throw new Error('画像の圧縮に失敗しました');
    return blob;
  } catch (e) {
    if (e instanceof ImageTooLargeError) throw e;
    // HEIC等、ブラウザがcanvas処理できない形式の場合は元ファイルのままアップロードする
    return file;
  }
}
