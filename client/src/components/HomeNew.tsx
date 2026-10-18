// ホームの新着の「新着」の札と［確認した］（2026-10-18・計画 docs/計画-ホームの新着.md）
// ・ホーム（App.tsx の Dashboard）が HomeNewContext に「新しかったお知らせの印（key）」を入れ、各帯が NewTag を出す
// ・［確認した］は DB の home_ack（1人×1お知らせで1行）。書いたあとは lib/writeWatch が 'home' を立ててナビの数字も読み直す
// 🚨 札の色は青系（成功の緑・注意の黄色と混ぜない）。ボタンは［戻る］と同じ形の小さめ（lib/buttonStyles の backBtn）

import React, { useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { backBtn } from '../lib/buttonStyles';

/** inverse＝色のついた帯の上に置くとき（白地に青い字） */
export const NewTag: React.FC<{ inverse?: boolean }> = ({ inverse = false }) => (
  <span style={{ display: 'inline-block', fontSize: 11, fontWeight: 'bold', padding: '1px 8px', borderRadius: 10, marginRight: 6,
    background: inverse ? '#fff' : '#0d6efd', color: inverse ? '#0d6efd' : '#fff', verticalAlign: 'middle', flexShrink: 0 }}>新着</span>
);

export const AckedTag: React.FC = () => (
  <span style={{ display: 'inline-block', fontSize: 11, padding: '1px 8px', borderRadius: 10, marginRight: 6,
    background: '#e9ecef', color: '#495057', verticalAlign: 'middle', flexShrink: 0 }}>確認済み</span>
);

/** ［確認した］のボタン。keys を全部記録してから onDone（記録できなければ赤い1行） */
export const AckButton: React.FC<{ keys: string[]; isDark?: boolean; onDone?: () => void; label?: string }> = ({ keys, isDark = false, onDone, label = '確認した' }) => {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ack = async () => {
    if (keys.length === 0) return;
    setBusy(true); setErr('');
    for (const k of keys) {
      const { error } = await supabase.rpc('home_ack', { p_key: k });
      if (error) { setBusy(false); setErr('記録できませんでした。通信を確かめて、もう一度お試しください'); return; }
    }
    setBusy(false);
    onDone?.();
  };
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
      <button type="button" onClick={ack} disabled={busy}
        style={{ ...backBtn(isDark), padding: '5px 12px', fontSize: 12.5, borderRadius: 8, opacity: busy ? 0.6 : 1 }}>
        {busy ? '記録中…' : label}
      </button>
      {err && <span style={{ fontSize: 11.5, color: '#842029', marginTop: 2 }}>{err}</span>}
    </span>
  );
};
