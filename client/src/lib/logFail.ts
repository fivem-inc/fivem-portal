// 投げっぱなし（await しない）で呼ぶ supabase の処理が、**失敗したときに黙って消えない**ようにする部品。
//
// 【なぜ要るか】
// 🚨 `.then(null, () => {})` は **通信エラーしか拾えない**。
//    supabase は 4xx/5xx でも例外を投げず `{ data, error }` を**正常に返す**ので、
//    RLS で弾かれた・制約違反・関数が無い（PGRST202）といった失敗は
//    `null`（成功側）に来る＝**この書き方では1つも気づけない**。
//    このリポジトリで何度も事故になっている形（2026-09-05／09-10／09-11）。
//
// 【使い方】`.then(null, () => {})` を、そのまま次に置き換えるだけ
//    supabase.from('notifications').insert({ … }).then(...logFail('ベル通知の作成'))
//
// 🚨 **await できるところでは使わない。** 待てるなら
//    `const { error } = await …; if (error) …` と書いて、画面にも結果を出すこと。
//    これは「待たずに投げる（＝画面を止めたくない）」ところ専用の、最後の網。
// 🚨 例外を外へ出さない。出すと通信断で「未処理のエラー」になる（投げっぱなしなので誰も受けない）。

type MaybeResult = { error?: { message?: string; code?: string } | null } | null | undefined;

/**
 * `.then(...logFail('何をしたか'))` の形で使う。
 * 成功側では `{ error }` を見て、失敗側では通信エラーを受ける。どちらも console に出すだけ。
 */
export function logFail(label: string): [
  (r: MaybeResult) => void,
  (e: unknown) => void,
] {
  return [
    (r) => {
      const err = r?.error;
      if (err) console.error(`${label}に失敗:`, err.code ?? '', err.message ?? err);
    },
    (e) => {
      // 🚨 catch で受けたものは Error とは限らないので、そのまま .message を読まない
      console.error(`${label}に失敗（通信）:`, e instanceof Error ? e.message : String(e));
    },
  ];
}
