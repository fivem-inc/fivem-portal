// 見積書PDFをアップロード前にブラウザ側で圧縮する。
// 各ページをラスタライズ（pdfjs-dist）し、画像圧縮（imageCompress.ts）と同じ基準
// （長辺1600px・JPEG品質80%）で再圧縮した上で、1ページ1画像のPDFとして作り直す（pdf-lib）。
// ユーザーには見えない裏側処理として扱うこと（画面上に圧縮の説明は出さない）。

import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument } from 'pdf-lib';
import { MAX_LONG_EDGE, JPEG_QUALITY } from './imageCompress';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const MAX_SOURCE_FILE_BYTES = 30 * 1024 * 1024; // 30MB超の元PDFは圧縮前に拒否

export class PdfTooLargeError extends Error {
  name = 'PdfTooLargeError';
}

export async function compressPdfFile(file: File): Promise<Blob> {
  if (file.size > MAX_SOURCE_FILE_BYTES) {
    throw new PdfTooLargeError('PDFのサイズが大きすぎます（30MB以下にしてください）');
  }

  try {
    const sourceBytes = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: sourceBytes.slice(0) }).promise;
    const outDoc = await PDFDocument.create();

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(2, MAX_LONG_EDGE / Math.max(baseViewport.width, baseViewport.height));
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas未対応のブラウザです');
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;

      const blob = await new Promise<Blob | null>(resolve => {
        canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
      });
      if (!blob) throw new Error('PDFページの圧縮に失敗しました');
      const jpgBytes = new Uint8Array(await blob.arrayBuffer());

      const jpgImage = await outDoc.embedJpg(jpgBytes);
      const outPage = outDoc.addPage([baseViewport.width, baseViewport.height]);
      outPage.drawImage(jpgImage, { x: 0, y: 0, width: baseViewport.width, height: baseViewport.height });
    }

    const outBytes = await outDoc.save();
    return new Blob([outBytes], { type: 'application/pdf' });
  } catch (e) {
    if (e instanceof PdfTooLargeError) throw e;
    // 暗号化PDF等、pdfjsが処理できない場合は元ファイルのままアップロードする
    return file;
  }
}
