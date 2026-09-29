// 残業の【注意事項】（休憩時間ルール・タイムカードの押し方の折りたたみを含む）。
// 🚨 1件フォーム（OvertimePage の［事前申請・事後報告］）と［まとめて申請］（OvertimeBox）で同じもの（2026-09-29 ユーザー指示・案A）。
//    文を直すときはここだけを直す（2か所に書き写さない）。OvertimePage の中にあったものを1文字も変えずに移した

import React, { useState } from 'react';
import { jpDateLabel } from '../lib/breakCalc';

const OvertimeNotes: React.FC<{
  isDark: boolean; advanceMaxDate: string; cardBg: string;
  /** 一覧の先頭に足す項目（［まとめて申請］の使い方・2026-09-29 ユーザー指示「注意事項から始めて、使い方もその中に」） */
  leadItems?: React.ReactNode[];
}> = ({ isDark, advanceMaxDate, cardBg, leadItems }) => {
  const [showRules, setShowRules] = useState(false);
  return (
    <div style={{
      background: isDark ? '#2c3e50' : '#e8f4fd',
      border: `1px solid ${isDark ? '#3d5a73' : '#bee5eb'}`,
      borderRadius: 8, padding: '12px 14px', marginBottom: 16, textAlign: 'left',
    }}>
      <p style={{ fontSize: 13, fontWeight: 'bold', color: isDark ? '#fff' : '#1a4a5a', marginBottom: 8, marginTop: 0 }}>【注意事項】</p>
      <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: isDark ? '#d0dde8' : '#2c5f6e', lineHeight: 1.8 }}>
        {(leadItems ?? []).map((it, i) => <li key={'lead' + i}>{it}</li>)}
        <li>残業・時間調整の申請と報告は、このページで行ってください（タイムカードの打刻＋このページの申請の2つセット。Slackへの個人の残業申請入力は不要です）。</li>
        <li>突発的な残業（急なお客様対応など）を除き、残業は事前に申請してください。申請がない場合は通常のシフト時間での勤務となります。</li>
        <li>事前申請した日は、その日の勤務が終わるころに「履歴・実績報告」タブのカードへ「実績を報告する」ボタンが出ます（受理を待たずに報告できます）。変更がなければそのまま送信（内容は入力済みです）、時間が変わった場合は直してから送信してください。</li>
        <li>休憩は自動計算されます。突発的な残業などで自動計算どおりに取れなかった場合は、休憩の「修正」から実際の時間に直してください（休憩後は1分以上業務をしてから退勤してください）。</li>
        <li>時間は1分単位で入力できます。外出・戻りのあるシフトは「＋勤務時間帯を追加」で入力してください。</li>
        <li>正社員の方は、残業分を別日で調整（時間調整・調整休）していただくようお願いします。</li>
        <li>調整休・欠勤（終日）は受理された時点で完了します（実績報告は不要です）。</li>
        <li>新規の申請は、支給月の17日までに提出してください。それ以降は前の給与期間の新規申請ができません（締め後に申請したい場合は経理にご相談ください）。</li>
        <li>事前申請ができるのは{jpDateLabel(advanceMaxDate)}までです（3か月先の給与期間まで）。それより先の予定は、その時期が近づいてから申請してください。</li>
      </ol>

      <button type="button" onClick={() => setShowRules(v => !v)}
        style={{ marginTop: 10, padding: '6px 12px', fontSize: 12, fontWeight: 'bold', background: isDark ? '#3d5a73' : '#d2e9f7', color: isDark ? '#fff' : '#1a4a5a', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
        {showRules ? '▲ 休憩時間ルール・タイムカードの押し方を閉じる' : '▼ 休憩時間ルール・タイムカードの押し方を表示'}
      </button>

      {showRules && (
        <div style={{ marginTop: 10, padding: '12px 14px', borderRadius: 8, background: cardBg, border: `1px solid ${isDark ? '#3d5a73' : '#bee5eb'}`, fontSize: 12, lineHeight: 1.8, color: isDark ? '#d0dde8' : '#2c5f6e' }}>
          <p style={{ margin: '0 0 4px', fontWeight: 'bold' }}>《休憩時間ルール（自動計算の基準）》</p>
          <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
            <li>昼休憩をはさむ（12:59までに出勤する）場合の休憩の最低単位は0:30</li>
            <li>13:00以降に出勤する場合に限り、勤務時間が5:45を超え6:15までは0:15</li>
            <li>勤務時間が6:15を超え6:30までは0:30</li>
            <li>勤務時間が6:30を超え8:45までは0:45</li>
            <li>勤務時間が8:45を超える場合は1:00</li>
          </ul>
          <p style={{ margin: '0 0 4px', fontWeight: 'bold' }}>《タイムカードの押し方》</p>
          <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
            <li>出勤時間の変更：「出勤」＋「早出」→「退勤」＋「残業」</li>
            <li>退勤時間の変更：「退勤」＋「残業」</li>
            <li>※1日トータルの時間がいつもの勤務とズレる場合は、退勤時に必ず「残業」ボタンを押してください</li>
          </ul>
          <p style={{ margin: '0 0 4px', fontWeight: 'bold' }}>《着替え時間》</p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>出勤時：着替え前に打刻し、2分30秒以内に着替えを完了して業務を開始してください</li>
            <li>退勤時：2分30秒以内に着替えを完了し、速やかに打刻してください</li>
          </ul>
        </div>
      )}
    </div>
  );
};

export default OvertimeNotes;
