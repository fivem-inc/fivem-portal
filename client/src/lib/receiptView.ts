import { supabase } from './supabaseClient';

// レシート写真は確認用の補助（正式な証憑は引き続き紙原本）。
// 5分で失効する使い切りの署名付きURLを都度発行する。download=trueの場合はブラウザに
// ダウンロード保存させる（Content-Dispositionをattachmentにする）

// 署名付きURLだけを返す。表示は呼び出し側（FileViewerModal）が画面内で行う。
// 🚨 iPhoneのSafariは「タップした瞬間」以外に開いた新しいタブをポップアップとみなして
// 無言でブロックするため、URLを取ってきた後に window.open してはいけない。
// 見る操作はアプリ内表示（この関数＋FileViewerModal）に寄せること。
export async function getReceiptSignedUrl(path: string): Promise<{ url?: string; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke<{ signedUrl?: string; error?: string; logError?: string | null }>(
      'receipt-signed-url',
      { body: { path, download: false } }
    );
    if (error || !data?.signedUrl) {
      return { error: data?.error ?? error?.message ?? 'ファイルを取得できませんでした。' };
    }
    return { url: data.signedUrl };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'ファイルを取得できませんでした。' };
  }
}

// ダウンロード用（管理者のみ）。保存はSafariでもブロックされないため従来どおり別タブに渡す
export async function openReceiptImage(path: string, download = false): Promise<string | null> {
  const { data, error } = await supabase.functions.invoke<{ signedUrl?: string; error?: string; logError?: string | null }>(
    'receipt-signed-url',
    { body: { path, download } }
  );
  if (error || !data?.signedUrl) {
    return data?.error ?? error?.message ?? 'レシート画像を取得できませんでした。';
  }
  if (data.logError) {
    // ダウンロード自体は成功しているため送信はブロックしない。原因調査用にコンソールへ記録するのみ
    console.error('receipt download log failed:', data.logError);
  }
  window.open(data.signedUrl, '_blank', 'noopener');
  return null;
}
