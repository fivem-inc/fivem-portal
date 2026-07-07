import { supabase } from './supabaseClient';

// レシート写真は確認用の補助（正式な証憑は引き続き紙原本）。
// 5分で失効する使い切りの署名付きURLを都度発行する。download=trueの場合はブラウザに
// ダウンロード保存させる（Content-Dispositionをattachmentにする）
export async function openReceiptImage(path: string, download = false): Promise<string | null> {
  const { data, error } = await supabase.functions.invoke<{ signedUrl?: string; error?: string }>(
    'receipt-signed-url',
    { body: { path, download } }
  );
  if (error || !data?.signedUrl) {
    return data?.error ?? error?.message ?? 'レシート画像を取得できませんでした。';
  }
  window.open(data.signedUrl, '_blank', 'noopener');
  return null;
}
