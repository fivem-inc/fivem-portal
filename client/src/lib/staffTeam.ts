// 所属チーム（こども・大人・管理部）の取り出し（2026-09-14 に共通化）
//
// ⚠️ profiles.group_names には配信用のグループ（マネージャー・リーダー／三役／正社員・契約社員／
//    パート・アルバイトスタッフ 等）も混ざっている。先頭を機械的に取ると「マネージャー・リーダー」を拾う。
//    チームの一覧は master_options の category='shift_report_group' が正。
// 🚨 以前は SafetyChecksTab の中にだけ同じ判定があった。シフト調整でも使うのでここに出した
//    （同じ判定を2か所に書かない）。
// 🚨 並びは group_names の順のまま（SafetyChecksTab の「最初の1つ」と同じ結果になるように）。
//    大人と管理部の両方に入っている人がいる（2026-09-14 実測でパート1名）。

/** その人の所属チームを、group_names の並び順で全部返す（無ければ空配列） */
export const teamsOf = (groups: string[] | null | undefined, teams: string[]): string[] =>
  (groups ?? []).filter(g => teams.includes(g));
