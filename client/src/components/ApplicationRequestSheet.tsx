import React, { useEffect, useMemo, useState } from 'react';
import { useScrollIntoViewWhen } from '../hooks/useScrollIntoViewWhen';
import { supabase } from '../lib/supabaseClient';
import { insertNotification } from '../lib/notifications';
import { DateField } from './common/DateField';
import { ERROR_BORDER, errorBg } from '../lib/formHighlight';
import { primaryBtn, backBtn, TOGGLE_BLUE } from '../lib/buttonStyles';
import { APP_REQUEST_OT_CONTENTS, APP_REQUEST_OT_CONTENT_LABEL, type AppRequestOtContent } from '../lib/appRequests';
import { useAuth } from '../hooks/useAuth';
import { isReplaceableLeave, leaveDatesOf, leaveReplaceBlockFor, leaveChangeText, mdDowShort, type ReplaceableLeave } from '../lib/leaveReplace';
import LeaveKindGuideCard from './LeaveKindGuideCard';

// 上長がスタッフに「この内容で申請してください」と依頼するシート（2026-09-09 ユーザー確定）。
//
// 🚨 既存の「残業調整の提案」（OvertimeProposalSheet）とは目的が違う。
//    提案 … 相手が受諾した瞬間に記録ができる
//    依頼 … 相手が自分で申請する。ここで書くのは相談で聞いた内容のメモ（本人が書き直す前提）
//    混ぜると「受諾で終わるのか、自分で申請するのか」が分からなくなるので分けてある。
//
// 🚨 日付の入力は共通部品 DateField を使う。ここに新しい日付ピッカーを作らないこと。

type Kind = 'overtime' | 'leave';

const KIND_LABEL: Record<Kind, string> = {
  overtime: '残業・時間管理',
  leave: '休暇',
};
// 種類のボタンの下の説明（2026-10-15 ユーザー確定）。きっかけ：調整休の依頼を「休暇」で作り、本人が申請できずにやり直しになった
const KIND_HINT: Record<Kind, string> = {
  overtime: '残業・早出・調整休・振替休日など',
  leave: '有給休暇・慶弔休暇など',
};

// メモの入力例。🚨 種類ごとに出し分ける（2026-09-10 実機指摘・ユーザー確定＝案1）。
//    1つの文を共通で使っていたため、休暇の依頼でも残業の例文（「雨でレッスンが…」）が出ていた。
// 🚨 「相談で聞いた内容」を書く欄なので、事実＋時刻の短い形にする。
// 🚨 休暇の例は「私用のため」までにとどめる。**有給は理由を問わないのが原則**なので、
//    詳しい理由を書かせる例文を置かない（例文は手本として真似されるため）。
const MEMO_PLACEHOLDER: Record<Kind, string> = {
  overtime: '例：お客様対応が延びたため、18:00まで勤務',
  leave: '例：私用のため有休を取得',
};

// 🚨 その申請を実際に使える人にしか依頼できないようにする（2026-09-09 実機指摘）。
//    役職名を書かず、管理画面「役職・機能権限」の値を見る。本番の実測では
//    残業＝マネージャー・リーダー・社長・管理者／休暇＝パート以外 だった。
//    「パートを外す」だけでは足りない（残業は一般・フロア責任者も使えない）。
const KIND_FEATURE: Record<Kind, string> = { overtime: 'overtime', leave: 'leave_request' };

// 🚨 実際の申請の形に合わせる（2026-09-09 ユーザー指摘）。
//    残業 … DBが「本人×日付で1件」（uq_overtime_manual_per_day）なので、複数日は申請も別々。
//           依頼も1日ずつにする。まとめて受けると「1日ぶんだけ申請して残りが忘れられる」ことになる。
//    休暇 … 複数日を1件で申請できる（leave_dates が配列）ので、依頼も複数日でよい。
const KIND_MULTI_DATE: Record<Kind, boolean> = { overtime: false, leave: true };

interface Staff { id: string; name: string; role_title: string | null; group_names: string[] | null }

interface Props {
  requesterId: string;
  requesterName: string;
  isDark: boolean;
  onClose: () => void;
  onSubmitted: () => void;
  /** 最初から入れておく種類・相手・日付（勤怠カレンダーで正社員を選んだときの［残業の申請を依頼する］など・2026-10-23）。
   *  🚨 種類は押したボタンで本人が選んだものなので入れてよい（何も押さずに開いたときは今までどおり何も選ばない） */
  initialKind?: Kind;
  initialRecipientId?: string;
  initialDates?: string[];
}

const ApplicationRequestSheet: React.FC<Props> = ({
  requesterId, requesterName, isDark, onClose, onSubmitted, initialKind, initialRecipientId, initialDates,
}) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const cardBg = isDark ? '#343a40' : '#fff';
  const inputBg = isDark ? '#2b3035' : '#fff';

  // 🚨 最初は何も選ばない（2026-10-15 ユーザー確定）。休暇の受理ページから開いても「休暇」を選んでおかない
  //    （選ばれたまま調整休の依頼を作り、本人が申請できなかった実例があるため）。選ぶまで下の入力は出さない
  const [kind, setKind] = useState<Kind | null>(initialKind ?? null);
  // 残業の依頼の申請内容（必須）。終日の3つは本人の申請画面に最初から入る（lib/appRequests）
  const [otContent, setOtContent] = useState<AppRequestOtContent | null>(null);
  const [recipientId, setRecipientId] = useState(initialRecipientId ?? '');
  const [dates, setDates] = useState<string[]>(initialDates && initialDates.length > 0 ? initialDates : ['']);
  const [memo, setMemo] = useState('');
  const [dueDate, setDueDate] = useState('');
  // 相談した日（任意）。🚨 依頼を作った日（created_at）では代用しない。口頭で話した日と
  //    画面から依頼を作る日は数日ずれることがあり、ずれた日を出すと画面が嘘をつく
  const [consultedOn, setConsultedOn] = useState('');
  const [staff, setStaff] = useState<Staff[]>([]);
  const [permByFeature, setPermByFeature] = useState<Record<string, Set<string>>>({});
  const [teams, setTeams] = useState<string[]>([]);
  const [teamFilter, setTeamFilter] = useState('');
  const [staffQuery, setStaffQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [errFields, setErrFields] = useState<Set<string>>(new Set());
  // 相手に通知が飛ぶので、送信前に必ず確認を出す（提案シートと同じ流儀）
  const [showConfirm, setShowConfirm] = useState(false);
  // 🚨 確認の枠はいちばん下に伸びるので、開いたらそこまで動かす（2026-09-25 実機指摘：
  //    ［内容を確認する］を押しても［この内容で依頼する］が画面の外に出て見えなかった）
  const confirmBoxRef = useScrollIntoViewWhen<HTMLDivElement>(showConfirm);

  useEffect(() => {
    (async () => {
      const [profRes, permRes, teamRes] = await Promise.all([
        supabase.from('profiles').select('id, name, role_title, group_names').eq('is_active', true).order('name'),
        supabase.from('feature_permissions').select('feature_key, enabled, roles(name)'),
        supabase.from('master_options').select('value').eq('category', 'shift_report_group').order('sort_order'),
      ]);
      if (profRes.data) setStaff(profRes.data as Staff[]);
      // 「どの役職が、どの申請を使えるか」の表を作る
      const map: Record<string, Set<string>> = {};
      for (const row of ((permRes.data ?? []) as { feature_key: string; enabled: boolean; roles: { name: string } | { name: string }[] | null }[])) {
        if (!row.enabled) continue;
        const rn = Array.isArray(row.roles) ? row.roles[0]?.name : row.roles?.name;
        if (!rn) continue;
        (map[row.feature_key] ??= new Set()).add(rn);
      }
      setPermByFeature(map);
      setTeams(((teamRes.data ?? []) as { value: string }[]).map(t => t.value));
    })();
  }, []);

  // 候補の絞り込み。権限 → チーム → 名前 の順で絞る。
  // 🚨 いちばん大事なのは1つ目。その申請を使えない人に依頼しても、本人は申請できない
  //    （残業はマネージャー・リーダー・社長・管理者だけ／休暇はパート以外）。
  const allowedRoles = kind ? permByFeature[KIND_FEATURE[kind]] : undefined;
  const shownStaff = useMemo(() => {
    const q = staffQuery.trim();
    let list = staff.filter(s => s.id !== requesterId);   // 自分には依頼しない
    // 権限の表がまだ読めていないときは絞らない（空の一覧を出して「誰もいない」と誤解させない）
    if (allowedRoles) list = list.filter(s => allowedRoles.has(s.role_title ?? ''));
    if (teamFilter) list = list.filter(s => (s.group_names ?? []).includes(teamFilter));
    if (q) list = list.filter(s => (s.name ?? '').includes(q) || (s.role_title ?? '').includes(q));
    return list;
  }, [staff, staffQuery, requesterId, allowedRoles, teamFilter]);

  // 🚨 「1日だけ」の種類に切り替えたら、入っている日付を先頭の1つに詰める。
  //    残したままだと、送信できても本人は1日ぶんしか申請できない。
  useEffect(() => {
    if (kind && !KIND_MULTI_DATE[kind]) setDates(prev => (prev.length > 1 ? [prev[0] ?? ''] : prev));
    // 休暇に切り替えたら申請内容は外す（残業の依頼だけのもの）
    if (kind !== 'overtime') setOtContent(null);
  }, [kind]);

  // 🚨 種類を変えると、選んでいた相手がその申請を使えなくなることがある。
  //    選んだままだと「申請できない人に依頼」が通ってしまうので、対象外になったら外す。
  useEffect(() => {
    if (!recipientId || !allowedRoles) return;
    const cur = staff.find(s => s.id === recipientId);
    if (cur && !allowedRoles.has(cur.role_title ?? '')) setRecipientId('');
  }, [kind, recipientId, staff, allowedRoles]);

  const recipient = staff.find(s => s.id === recipientId);
  const filledDates = dates.map(d => d.trim()).filter(Boolean);

  // その日にすでに申請があるか（2026-09-19 ユーザー確定）。
  // きっかけ：先に有給が入っている日に依頼を出すと、依頼が「未申請」のまま残り、取り下げたら
  //   「休暇 取り下げ」と出て有給が消えたように見えた（依頼が「申請済み」になるのは依頼のあとに出した申請だけ）。
  // 🚨 止めない。気づけるように出すだけ。読めなかったら何も出さない（「無い」と言わない）
  const datesKey = filledDates.join(',');
  const [existing, setExisting] = useState<{ date: string; label: string }[]>([]);
  useEffect(() => {
    setExisting([]);
    if (!kind || !recipientId || !datesKey) return;
    const want = datesKey.split(',');
    let alive = true;
    (async () => {
      const found: { date: string; label: string }[] = [];
      if (kind === 'leave') {
        const min = [...want].sort()[0]; const max = [...want].sort()[want.length - 1];
        const { data, error: e } = await supabase.from('leave_requests')
          .select('leave_type, status, leave_dates, start_date, end_date')
          .eq('user_id', recipientId).not('status', 'in', '(rejected,cancelled)')
          .lte('start_date', max).gte('end_date', min);
        if (e || !data) return;
        for (const r of data as { leave_type: string | null; status: string; leave_dates: string | null; start_date: string; end_date: string | null }[]) {
          let days: string[] = [];
          try { const a = r.leave_dates ? JSON.parse(r.leave_dates) : null; if (Array.isArray(a)) days = a.map(String); } catch { /* 下で範囲から作る */ }
          for (const d of want) {
            const hit = days.length > 0 ? days.includes(d) : (r.start_date <= d && d <= (r.end_date ?? r.start_date));
            if (hit) found.push({ date: d, label: `${r.leave_type ?? '休暇'}・${['approved', 'manager_approved', 'admin_approved'].includes(r.status) ? '受理済み' : '確認待ち'}` });
          }
        }
      } else {
        const { data, error: e } = await supabase.from('overtime_reports')
          .select('work_date, status').eq('applicant_id', recipientId).in('work_date', want).neq('status', 'cancelled');
        if (e || !data) return;
        for (const r of data as { work_date: string; status: string }[]) {
          found.push({ date: r.work_date, label: ['confirmed', 'request_confirmed'].includes(r.status) ? '受理済み' : r.status === 'returned' ? '差し戻し中' : '確認待ち' });
        }
      }
      if (alive) setExisting(found);
    })();
    return () => { alive = false; };
  }, [kind, recipientId, datesKey]);

  // 休暇の種類のご案内（2026-10-27 段2a・lib/leaveReplace）。時間外調整休の依頼で、その日にご本人の有休があるとき、
  // 「この有休を、時間外調整休に変更できることをご本人に案内する」にできる（権限「休暇の種類のご案内」の人だけ・DB も同じ権限を見る）。
  // 🚨 文言は 2026-10-27 ユーザー確定（法律の専門家のレビューのあと）。ご本人には components/LeaveKindGuideCard が出る
  const { canLeaveTypeChange } = useAuth();
  const [replaceLeave, setReplaceLeave] = useState<ReplaceableLeave | null>(null);
  const [replaceBlock, setReplaceBlock] = useState<string | null>(null);
  const [replaceOn, setReplaceOn] = useState(true);
  useEffect(() => {
    setReplaceLeave(null); setReplaceBlock(null);
    if (!canLeaveTypeChange || kind !== 'overtime' || otContent !== 'chosei_off' || !recipientId || filledDates.length !== 1) return;
    const d = filledDates[0];
    let alive = true;
    (async () => {
      const { data, error: e } = await supabase.from('leave_requests')
        .select('id, leave_type, status, reason, leave_dates')
        .eq('user_id', recipientId).not('status', 'in', '(rejected,cancelled)')
        .lte('start_date', d).gte('end_date', d);
      if (e || !data || !alive) return;
      const hit = (data as ReplaceableLeave[]).find(l => isReplaceableLeave(l) && leaveDatesOf(l).includes(d));
      if (!hit) return;
      setReplaceLeave(hit);
      setReplaceOn(true);
      const b = await leaveReplaceBlockFor(hit.id, recipientId, d);
      if (alive) setReplaceBlock(b);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canLeaveTypeChange, kind, otContent, recipientId, datesKey]);
  const replacing = !!replaceLeave && replaceOn && !replaceBlock;

  const validate = (): string => {
    const bad = new Set<string>();
    if (!kind) { bad.add('kind'); }
    if (kind === 'overtime' && !otContent) { bad.add('otContent'); }
    if (!recipientId) { bad.add('recipient'); }
    if (filledDates.length === 0) { bad.add('dates'); }
    setErrFields(bad);
    if (bad.has('kind')) return '依頼の種類を選んでください';
    if (bad.has('otContent')) return '申請内容を選んでください';
    if (bad.has('recipient')) return '依頼する相手を選んでください';
    if (bad.has('dates')) return '対象の日付を1つ以上入れてください';
    return '';
  };

  const submit = async () => {
    const msg = validate();
    if (msg || !kind) { setError(msg || '依頼の種類を選んでください'); setShowConfirm(false); return; }
    setSubmitting(true);
    setError('');
    // 🚨 insert は error を見ないと RLS 拒否を握りつぶす
    const { data, error: err } = await supabase.from('application_requests').insert({
      requester_id: requesterId,
      recipient_id: recipientId,
      kind,
      target_dates: filledDates,
      memo: replacing ? null : (memo.trim() || null),
      due_date: replacing ? null : (dueDate || null),   // 休暇の種類のご案内に期限は付けない（DB も消す）
      consulted_on: replacing ? null : (consultedOn || null),
      ot_content: kind === 'overtime' ? otContent : null,
      ...(replacing && replaceLeave ? { replaces_leave_id: replaceLeave.id } : {}),
    }).select('id').single();
    if (err) {
      setSubmitting(false);
      setShowConfirm(false);
      // 🚨 「通信を確認してください」で握りつぶさない。理由をそのまま出す
      setError(leaveChangeText(err) ?? ('送信できませんでした：' + err.message));
      return;
    }

    // 相手へのお知らせ。文言は形式的に、何をすればよいかが分かる形にする（2026-09-09 ユーザー確定）
    const dateLabel = filledDates.map(d => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`).join('・');
    const dueLabel = dueDate ? `（申請期限 ${Number(dueDate.slice(5, 7))}/${Number(dueDate.slice(8, 10))}）` : '';
    // 🚨 休暇の依頼は種類を鍵に付ける（2026-09-26）。ベル・スマホから休暇ページへ着くため
    //    （それまでは休暇の依頼でも残業ページに着いていた）。設定（ON/OFF）は先頭2つ＝application_request:received を見るので新しい行は要らない
    const eventKey = kind === 'leave' ? 'application_request:received:leave' : 'application_request:received';
    // 申請内容（時間・本人が選択 のときは付けない＝何も決まっていないので）
    const contentLabel = kind === 'overtime' && otContent && otContent !== 'time' && otContent !== 'self' ? `（${APP_REQUEST_OT_CONTENT_LABEL[otContent]}）` : '';
    await insertNotification(
      recipientId,
      // 休暇の種類のご案内は、案内であることが分かる文（2026-10-27 ユーザー確定：日付と上長の名前を入れる）
      replacing ? `📩 休暇の種類のご案内（${mdDowShort(filledDates[0])}・${requesterName}さんから）`
        : `📩 ${requesterName}さんより申請依頼：${dateLabel} ${KIND_LABEL[kind]}${contentLabel}${dueLabel}`,
      replacing ? undefined : (memo.trim() || undefined),
      eventKey,
      data.id,
      eventKey,
    );

    setSubmitting(false);
    onSubmitted();
  };

  const label: React.CSSProperties = { display: 'block', fontSize: 12.5, fontWeight: 'bold', color: text, marginBottom: 6 };
  const field = (bad: boolean): React.CSSProperties => ({
    width: '100%', padding: '9px 12px', borderRadius: 8, fontSize: 14,
    border: `1px solid ${bad ? ERROR_BORDER : border}`,
    background: bad ? errorBg(isDark) : inputBg, color: text, boxSizing: 'border-box',
  });

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9998,
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: cardBg, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto',
        borderRadius: '16px 16px 0 0', padding: '18px 16px 28px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <span style={{ fontSize: 16, fontWeight: 'bold', color: text }}>📩 申請の依頼（正社員向け）</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: subText }}>✕</button>
        </div>

        <p style={{ margin: '0 0 14px', fontSize: 12, color: subText, lineHeight: 1.7 }}>
          相談で聞いた内容を伝えて、本人に申請してもらいます。<br />
          ここに書いたメモは案内として表示されます。<b style={{ color: text }}>申請の中身は本人が入力します</b>。<br />
          選べるのは、その申請を使える方だけです（パート・アルバイトの方は出てきません）。
        </p>

        {/* 種類 */}
        <div style={{ marginBottom: 14 }}>
          <span style={label}>依頼の種類 <span style={{ color: '#dc3545' }}>*</span></span>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['overtime', 'leave'] as Kind[]).map(k => (
              <button key={k} type="button" onClick={() => { setKind(k); setErrFields(prev => { const n = new Set(prev); n.delete('kind'); return n; }); }}
                style={{
                  flex: 1, padding: '9px 6px', borderRadius: 8, cursor: 'pointer',
                  border: `2px solid ${kind === k ? '#4a90d9' : errFields.has('kind') ? ERROR_BORDER : border}`,
                  background: kind === k ? (isDark ? '#1e3a5f' : '#e8f4fd') : 'transparent',
                }}>
                <span style={{ display: 'block', fontSize: 13.5, fontWeight: 'bold', color: kind === k ? (isDark ? '#90caf9' : '#1565c0') : text }}>{KIND_LABEL[k]}</span>
                <span style={{ display: 'block', fontSize: 11, color: subText, marginTop: 3, lineHeight: 1.5 }}>{KIND_HINT[k]}</span>
              </button>
            ))}
          </div>
          {!kind && <div style={{ fontSize: 11.5, color: subText, textAlign: 'center', marginTop: 6 }}>どちらかを押して選んでください</div>}
          <div style={{ marginTop: 8, padding: '7px 10px', borderRadius: 8, fontSize: 12, lineHeight: 1.6,
            background: isDark ? '#3a2e10' : '#fff8e1', border: `1px solid ${isDark ? '#8a6d1f' : '#f0c36d'}`, color: isDark ? '#f5e3b0' : '#7a5a00' }}>
            ⚠️ 時間外調整休・振替休日は「残業・時間管理」で申請します。「休暇」を選ぶと、相手は申請できません。
          </div>
        </div>

        {/* 申請内容（残業の依頼だけ・必須・2026-10-15 ユーザー確定） */}
        {kind === 'overtime' && (
          <div style={{ marginBottom: 14 }}>
            <span style={label}>申請内容 <span style={{ color: '#dc3545' }}>*</span></span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {APP_REQUEST_OT_CONTENTS.map(c => {
                const on = otContent === c;
                return (
                  <button key={c} type="button" onClick={() => { setOtContent(c); setErrFields(prev => { const n = new Set(prev); n.delete('otContent'); return n; }); }}
                    style={{
                      padding: '6px 12px', borderRadius: 16, cursor: 'pointer', fontSize: 12.5,
                      border: `1px solid ${errFields.has('otContent') && !on ? ERROR_BORDER : TOGGLE_BLUE}`,
                      background: on ? TOGGLE_BLUE : 'transparent', color: on ? '#fff' : (isDark ? '#90caf9' : TOGGLE_BLUE),
                      fontWeight: on ? 'bold' : 'normal',
                    }}>
                    {APP_REQUEST_OT_CONTENT_LABEL[c]}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 11.5, color: subText, marginTop: 6 }}>選択した内容が、相手の申請画面にあらかじめ入力されます。</div>
          </div>
        )}

        {kind && (<>

        {/* 相手 */}
        <div style={{ marginBottom: 14 }}>
          <span style={label}>依頼する相手 <span style={{ color: '#dc3545' }}>*</span></span>
          {recipient ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 'bold', color: text }}>
                {recipient.name}{recipient.role_title ? `（${recipient.role_title}）` : ''}
              </span>
              <button type="button" onClick={() => { setRecipientId(''); setStaffQuery(''); }}
                style={{ padding: '5px 12px', borderRadius: 12, fontSize: 11.5, cursor: 'pointer', border: `1px solid ${border}`, background: 'transparent', color: subText }}>
                選び直す
              </button>
            </div>
          ) : (
            <>
              {/* チームで絞る（2026-09-09 実機指摘）。人数が多く、名前を打つ前に絞れるようにする。
                  🚨 区分は master_options の shift_report_group（こども／大人／管理部）から取る。
                     画面に書き写すと、区分が増えたときに出てこない */}
              {teams.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {['', ...teams].map(t => (
                    <button key={t || 'all'} type="button" onClick={() => setTeamFilter(t)}
                      style={{
                        padding: '5px 14px', borderRadius: 14, fontSize: 12, fontWeight: 'bold', cursor: 'pointer',
                        border: `1px solid ${teamFilter === t ? '#4a90d9' : border}`,
                        background: teamFilter === t ? '#e8f4fd' : 'transparent',
                        color: teamFilter === t ? '#1565c0' : subText,
                      }}>
                      {t || 'すべて'}
                    </button>
                  ))}
                </div>
              )}
              <input value={staffQuery} onChange={e => setStaffQuery(e.target.value)}
                placeholder="お名前で絞り込む" style={field(errFields.has('recipient'))} />
              <div style={{ maxHeight: 180, overflowY: 'auto', marginTop: 6, border: `1px solid ${border}`, borderRadius: 8 }}>
                {shownStaff.slice(0, 30).map(s => (
                  <button key={s.id} type="button"
                    // 🚨 候補は先に blur が起きるとクリックが届かない。押せなくなるので mousedown を止める
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => { setRecipientId(s.id); setErrFields(p => { const n = new Set(p); n.delete('recipient'); return n; }); }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px',
                      border: 'none', borderBottom: `1px solid ${border}`, background: 'transparent',
                      color: text, fontSize: 13.5, cursor: 'pointer',
                    }}>
                    {s.name}<span style={{ color: subText, fontSize: 11.5, marginLeft: 8 }}>{s.role_title ?? ''}</span>
                  </button>
                ))}
                {shownStaff.length === 0 && (
                  <div style={{ padding: '10px 12px', fontSize: 12.5, color: subText, lineHeight: 1.7 }}>
                    該当する方がいません。<br />
                    {KIND_LABEL[kind]}を使える方だけが出ます{teamFilter ? `（いまは「${teamFilter}」で絞っています）` : ''}。
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* 対象日 */}
        <div style={{ marginBottom: 14 }}>
          <span style={label}>
            対象の日付 <span style={{ color: '#dc3545' }}>*</span>
            <span style={{ fontWeight: 'normal', fontSize: 11.5, color: subText, marginLeft: 6 }}>
              {KIND_MULTI_DATE[kind] ? '（連休なども まとめて選べます）' : '（1日ずつ）'}
            </span>
          </span>
          {dates.map((d, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <DateField value={d} isDark={isDark} placeholder="日付を選ぶ"
                  onChange={v => { setDates(p => p.map((x, j) => (j === i ? v : x))); setErrFields(p => { const n = new Set(p); n.delete('dates'); return n; }); }} />
              </div>
              {/* 🚨 増やせるなら必ず減らせるようにする */}
              {dates.length > 1 && (
                <button type="button" onClick={() => setDates(p => p.filter((_, j) => j !== i))}
                  style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${border}`, background: 'transparent', color: subText, cursor: 'pointer', fontSize: 13 }}>
                  ✕
                </button>
              )}
            </div>
          ))}
          {KIND_MULTI_DATE[kind] ? (
            <button type="button" onClick={() => setDates(p => [...p, ''])}
              style={{ padding: '6px 14px', borderRadius: 12, fontSize: 12, cursor: 'pointer', border: `1px solid ${border}`, background: 'transparent', color: subText }}>
              ＋ 日付を追加
            </button>
          ) : (
            <p style={{ margin: '2px 0 0', fontSize: 11.5, color: subText, lineHeight: 1.6 }}>
              残業・時間管理は1日ごとに申請する決まりのため、依頼も1日ずつです。<br />
              複数日をお願いするときは、日ごとに依頼を作ってください。
            </p>
          )}
        </div>

        {existing.length > 0 && (
          <div style={{ margin: '-6px 0 14px', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.7,
            background: isDark ? '#3d3520' : '#fff8e1', border: `1px solid ${isDark ? '#8a6d1f' : '#ffe08a'}`, color: isDark ? '#ffd54f' : '#8a5a00' }}>
            ⚠️ すでに申請があります：{existing.map(x => `${Number(x.date.slice(5, 7))}/${Number(x.date.slice(8, 10))}（${x.label}）`).join('、')}<br />
            この日の依頼を出しても、「未申請」のまま残ります。
          </div>
        )}
        {/* 休暇の種類のご案内（2026-10-27 段2a・文言はユーザー確定） */}
        {replaceLeave && (
          <div style={{ margin: '-6px 0 14px', padding: '9px 12px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.7, textAlign: 'left',
            background: isDark ? '#3d3520' : '#fff3cd', border: `1px solid ${isDark ? '#8a6d1f' : '#ffe0a3'}`, color: isDark ? '#ffd54f' : '#856404' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', cursor: replaceBlock ? 'default' : 'pointer' }}>
              <input type="checkbox" checked={replacing} disabled={!!replaceBlock} onChange={e => setReplaceOn(e.target.checked)} style={{ marginTop: 4 }} />
              <span style={{ fontWeight: 'bold' }}>この有休を、時間外調整休に変更できることをご本人に案内する</span>
            </label>
            {/* 2026-10-27 ユーザー確定（労働基準法で不当にならないように・依頼ではなく案内） */}
            <div style={{ marginTop: 4 }}>・これは変更の依頼ではなく、ご案内です。選ぶのはご本人です。</div>
            <div>・時間外調整休に変更すると、ご本人の残業時間が減り、残業代も少なくなります。</div>
            <div>・有給休暇のままとされても、不利益な取扱いをすることはできません。</div>
            <div>・同じ日の案内は1回限りです。</div>
            {replaceBlock && <div style={{ marginTop: 4, color: '#c62828' }}>{replaceBlock}</div>}
          </div>
        )}

        {/* 相談した日（任意）。メモ（相談で聞いた内容）のすぐ上に置く＝相談まわりをまとめる。
            🚨 休暇の種類のご案内では、相談した日・メモ・期限は出さない（ご本人のカードは数字だけ・2026-10-27 ユーザー確定） */}
        {!replacing && (<>
        <div style={{ marginBottom: 14 }}>
          <span style={label}>相談した日（任意）</span>
          <DateField value={consultedOn} onChange={setConsultedOn} isDark={isDark} placeholder="指定しない" />
        </div>

        {/* メモ */}
        <div style={{ marginBottom: 14 }}>
          <span style={label}>メモ（相談で聞いた内容）</span>
          <textarea value={memo} onChange={e => setMemo(e.target.value)} rows={3}
            placeholder={MEMO_PLACEHOLDER[kind]}
            style={{ ...field(false), resize: 'vertical', lineHeight: 1.6 }} />
        </div>
        </>)}

        {/* 期限。🚨 休暇の種類のご案内には期限を付けない（回答しなければ有給休暇のまま・法律の専門家のレビュー）＝出さない */}
        {!replacing && (
        <div style={{ marginBottom: 16 }}>
          <span style={label}>いつまでに申請してほしいか（任意）</span>
          <DateField value={dueDate} onChange={setDueDate} isDark={isDark} placeholder="指定しない" />
        </div>
        )}

        </>)}

        {error && (
          <div style={{ marginBottom: 12, padding: '9px 12px', borderRadius: 8, fontSize: 12.5,
            background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029' }}>{error}</div>
        )}

        {showConfirm ? (
          <div ref={confirmBoxRef} style={{ padding: '12px 14px', borderRadius: 10, background: isDark ? '#2c3e50' : '#e8f4fd', border: `1px solid ${isDark ? '#3d5a73' : '#bee5eb'}`, marginBottom: 10 }}>
            <p style={{ margin: '0 0 10px', fontSize: 12.5, lineHeight: 1.8, color: isDark ? '#fff' : '#0d47a1' }}>
              {replacing ? (
                // 休暇の種類のご案内（2026-10-27 段2a）。依頼ではなく案内の文にそろえる
                <>{recipient?.name}さんに、{mdDowShort(filledDates[0])}の有休を時間外調整休に変更できることを案内します。<br />ご本人には、次のカードが届きます。</>
              ) : (<>
              {recipient?.name}さんに、{kind ? KIND_LABEL[kind] : ''}の申請をお願いします。<br />
              {kind === 'overtime' && otContent && <>申請内容：{APP_REQUEST_OT_CONTENT_LABEL[otContent]}<br /></>}
              対象日：{filledDates.map(d => d.slice(5).replace('-', '/')).join('・')}
              </>)}
              {!replacing && dueDate && <><br />申請期限：{dueDate.slice(5).replace('-', '/')}</>}
              <br />相手にお知らせが届きます。
            </p>
            {/* 送る前に、ご本人に届く実際のカードを見せる（2026-10-27 ユーザー確定・ボタンは押せない見本） */}
            {replacing && replaceLeave && (
              <LeaveKindGuideCard preview isDark={isDark} userId={recipientId}
                r={{ id: 'preview', requester_id: requesterId, requester_name: requesterName, kind: 'overtime', target_dates: [filledDates[0]], memo: null, due_date: null, status: 'open', consulted_on: null, segments: null, ot_content: 'chosei_off', replaces_leave_id: replaceLeave.id }}
                onStart={() => {}} onKept={() => {}} onError={() => {}} />
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setShowConfirm(false)} disabled={submitting}
                style={{ ...backBtn(isDark), flex: 1 }}>
                戻る
              </button>
              <button onClick={submit} disabled={submitting}
                style={{ ...primaryBtn({ disabled: submitting }), flex: 2 }}>
                {submitting ? '送信中…' : (replacing ? 'この内容で案内する' : 'この内容で依頼する')}
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => { const m = validate(); if (m) { setError(m); return; } setError(''); setShowConfirm(true); }}
            style={{ ...primaryBtn(), width: '100%' }}>
            内容を確認する
          </button>
        )}
      </div>
    </div>
  );
};

export default ApplicationRequestSheet;
