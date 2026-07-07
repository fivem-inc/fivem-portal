// レシート撮影直後の「ぼやけていないか」を判定するための簡易な目安値。
// エッジの強さのばらつき（ラプラシアンの分散）を計算し、値が低いほどぼやけている可能性が高い。
// あくまで参考値であり完全な判定ではないため、警告のみに使い送信をブロックしない。
const BLUR_ANALYSIS_WIDTH = 300;
export const BLUR_WARNING_THRESHOLD = 80;

export function estimateBlurScore(canvas: HTMLCanvasElement): number {
  const scale = Math.min(1, BLUR_ANALYSIS_WIDTH / canvas.width);
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const ctx = small.getContext('2d');
  if (!ctx) return Infinity; // 判定できない場合は警告を出さない

  ctx.drawImage(canvas, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  let sum = 0, sumSq = 0, count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const lap = 4 * gray[idx] - gray[idx - 1] - gray[idx + 1] - gray[idx - w] - gray[idx + w];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (count === 0) return Infinity;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}
