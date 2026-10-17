// 管理画面の設定の枠の下に出す「保存の帯」（2026-10-17・役職・機能権限管理のページを ［変更する］→［保存］ にそろえた）
//
// ・変える内容の一覧（「一般：残業申請 オフ → オン」）→「保存するまで変わりません」→［やめる］［保存］→ 結果の知らせ（押したボタンのすぐ下）
// ・warn：保存の前に読んでほしい注意（例：「全員にスマホ通知を送れるようになります」）。黄色（🎨🔒 #fff3cd／#ffc107／#856404）
// ・sticky：長い表では、編集中は画面の下にくっつけて出す（スクロールしても［保存］が見える）
// 🚨 ボタンの色と形は lib/buttonStyles（送る＝青・戻る＝枠）。知らせは成功＝薄緑・失敗＝薄赤（🎨🔒 の固定色）
// 🚨 知らせ（msg）は編集中でなくても出す（保存したあとは編集が終わるため）。出す場所はこの部品の中だけ

import React, { useState } from 'react';
import { backBtn, primaryBtn } from '../../lib/buttonStyles';

export interface SaveMsg { text: string; fail: boolean }

/** 保存したあとの知らせだけ（編集中でないとき） */
export const SaveNotice: React.FC<{ msg: SaveMsg | null }> = ({ msg }) => msg ? (
  <div role="status" style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 13, lineHeight: 1.6,
    ...(msg.fail ? { background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029' } : { background: '#d4edda', border: '1px solid #c3e6cb', color: '#155724' }) }}>
    {msg.fail ? '' : '✓ '}{msg.text}
  </div>
) : null;

const SaveBar: React.FC<{
  isDark: boolean;
  changes: string[];
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
  msg: SaveMsg | null;
  warn?: React.ReactNode;
  sticky?: boolean;
  saveLabel?: string;
}> = ({ isDark, changes, saving, onCancel, onSave, msg, warn, sticky, saveLabel = '保存' }) => {
  const [showAll, setShowAll] = useState(false);
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const text = isDark ? '#e9ecef' : '#212529';
  const border = isDark ? '#495057' : '#dee2e6';
  const shown = showAll ? changes : changes.slice(0, 6);
  const none = changes.length === 0;
  return (
    <div style={{
      marginTop: 12, paddingTop: 10, borderTop: `1px solid ${border}`,
      ...(sticky ? { position: 'sticky', bottom: 0, zIndex: 3, background: isDark ? '#2d3136' : '#ffffff', padding: '10px 12px', boxShadow: '0 -2px 8px rgba(0,0,0,0.08)' } : {}),
    }}>
      {none ? (
        <div style={{ fontSize: 12.5, color: sub, marginBottom: 8 }}>まだ何も変えていません。</div>
      ) : (
        <div style={{ fontSize: 12.5, color: text, marginBottom: 8, lineHeight: 1.7 }}>
          <div style={{ fontWeight: 'bold', marginBottom: 2 }}>変える内容（{changes.length}件）</div>
          {shown.map((c, i) => <div key={i}>・{c}</div>)}
          {changes.length > 6 && (
            <button type="button" onClick={() => setShowAll(v => !v)}
              style={{ border: 'none', background: 'none', color: '#1976d2', cursor: 'pointer', fontSize: 12.5, padding: 0 }}>
              {showAll ? '閉じる' : `ほか${changes.length - 6}件を見る`}
            </button>
          )}
          <div style={{ color: sub, marginTop: 2 }}>［{saveLabel}］を押すまで変わりません。</div>
        </div>
      )}
      {warn && !none && (
        <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.6,
          background: '#fff3cd', border: '1px solid #ffc107', color: '#856404' }}>⚠️ {warn}</div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={{ ...backBtn(isDark), flex: 1 }} disabled={saving} onClick={onCancel}>やめる</button>
        <button type="button" style={{ ...primaryBtn({ disabled: saving || none }), flex: 2 }} disabled={saving || none} onClick={onSave}>
          {saving ? '保存しています…' : saveLabel}
        </button>
      </div>
      <SaveNotice msg={msg} />
    </div>
  );
};

export default SaveBar;
