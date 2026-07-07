import { supabase } from './supabaseClient';

// 選択されたレシート画像をzip1ファイルにまとめてダウンロードする。
// Edge Function側でzip化するため、クライアントは1回のダウンロードで済む
// （連続ダウンロードによるブラウザの確認ダイアログ連発を避けるため）
export async function downloadReceiptsAsZip(paths: string[]): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return 'ログイン状態を確認できませんでした。';

  const projectUrl = (import.meta.env.VITE_SUPABASE_URL as string) ?? '';
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) ?? '';

  const res = await fetch(`${projectUrl}/functions/v1/receipt-bulk-zip`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
      apikey: anonKey,
    },
    body: JSON.stringify({ paths }),
  });

  if (!res.ok) {
    try {
      const body = await res.json();
      return body.error ?? `ダウンロードに失敗しました（${res.status}）`;
    } catch {
      return `ダウンロードに失敗しました（${res.status}）`;
    }
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `receipts_${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return null;
}
