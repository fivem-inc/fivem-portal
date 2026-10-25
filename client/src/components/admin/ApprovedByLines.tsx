// 誰がいつ受理したか（2026-10-17 ユーザー確定）。管理画面の残業・休暇・勤務変更の一覧で、状況の札のすぐ下に小さな灰色の文字で出す。
// 🚨 3つの一覧が同じ部品を使う（形をそろえるため・書き写さない）。何を出すかは各一覧が決めて lines で渡す
//    例）受理：見本 一郎 10/16 23:30 ／ 1人目：見本 さくら ／ 2人目：見本 一郎 10/3 18:20
import React from 'react';

export interface ApprovedLine {
  /** 「受理」「1人目」「2人目」など */
  label: string;
  name: string;
  /** 受理した日時（ISO）。記録が無いときは出さない */
  at?: string | null;
}

/** 日時を「10/16 23:30」の形に（日本時間） */
function approvedAtText(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export const ApprovedByLines: React.FC<{ lines: ApprovedLine[]; color: string }> = ({ lines, color }) => {
  if (lines.length === 0) return null;
  return (
    <div style={{ marginTop: 3, fontSize: 10, lineHeight: 1.5, color, textAlign: 'left' }}>
      {lines.map((l, i) => (
        <div key={i} style={{ whiteSpace: 'nowrap' }}>
          {l.label}：{l.name}{l.at ? ` ${approvedAtText(l.at)}` : ''}
        </div>
      ))}
    </div>
  );
};
