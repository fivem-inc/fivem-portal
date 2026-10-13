import React, { useCallback, useEffect, useState } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { supabase } from '../../lib/supabaseClient';
import { primaryBtn, tintBtn, TOGGLE_BLUE } from '../../lib/buttonStyles';
import { PayrollCloseCard } from '../PayrollCloseBanner';
import {
  PAYROLL_CLOSE_LINE_DEFS, PAYROLL_CLOSE_SETTINGS_KEY,
  type PayrollCloseLine, type PayrollCloseSettings,
} from '../../lib/payrollClose';

// 通知設定タブの「📅 締め日のお知らせ」（2026-10-14 ユーザー確定・計画は docs/計画-締め日のお知らせ.md）
// ・ここで直せるのは文面と ON/OFF だけ。誰にどの行が届くかは権限管理と雇用形態で決まる（DB の payroll_close_compose）
// ・見え方のプレビューは DB の payroll_close_lines を保存前の文で呼ぶ（画面で文を組み立て直さない）

type PreviewKind = 'part' | 'regular' | 'boss';
const PREVIEWS: { key: PreviewKind; label: string; flags: { p_ot: boolean; p_shift: boolean; p_expense: boolean; p_commuter: boolean; p_ot_pending: number; p_sr_pending: number } }[] = [
  { key: 'part',    label: 'パート',                     flags: { p_ot: false, p_shift: true,  p_expense: true, p_commuter: false, p_ot_pending: 0, p_sr_pending: 0 } },
  { key: 'regular', label: '正社員',                     flags: { p_ot: true,  p_shift: false, p_expense: true, p_commuter: true,  p_ot_pending: 0, p_sr_pending: 0 } },
  { key: 'boss',    label: '上長（受理まち3件・確認まち2件）', flags: { p_ot: true,  p_shift: false, p_expense: true, p_commuter: true,  p_ot_pending: 3, p_sr_pending: 2 } },
];

interface PreviewResult {
  title: string; lines: PayrollCloseLine[];
  next_close: string; next_send: string; enabled: boolean;
  last_close: string | null; last_sent_at: string | null; last_count: number | null;
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const jpDate = (ymd: string) => { const d = new Date(ymd + 'T00:00:00+09:00'); return `${d.getMonth() + 1}月${d.getDate()}日（${DOW[d.getDay()]}）`; };

const PayrollCloseNoticeSection: React.FC = () => {
  const { isDarkMode } = useAdminPanel();
  const [saved, setSaved] = useState<PayrollCloseSettings | null>(null);
  const [draft, setDraft] = useState<PayrollCloseSettings | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [previewKind, setPreviewKind] = useState<PreviewKind>('boss');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewErr, setPreviewErr] = useState('');
  const [testing, setTesting] = useState(false);

  const bg = isDarkMode ? '#343a40' : 'white';
  const text = isDarkMode ? '#fff' : '#333';
  const subText = isDarkMode ? '#adb5bd' : '#666';
  const borderColor = isDarkMode ? '#6c757d' : '#ddd';
  const inputBg = isDarkMode ? '#495057' : 'white';

  useEffect(() => {
    void (async () => {
      const { data, error } = await supabase.from('app_settings').select('value').eq('key', PAYROLL_CLOSE_SETTINGS_KEY).maybeSingle();
      if (error || !data) { setLoadErr('設定を読み込めませんでした' + (error ? '：' + error.message : '（設定の行がありません）')); return; }
      const v = data.value as PayrollCloseSettings;
      setSaved(v); setDraft(v);
    })();
  }, []);

  const dirty = !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);

  // 見え方（保存前の文で DB に組み立ててもらう）
  const loadPreview = useCallback(async (lines: PayrollCloseSettings['lines'], kind: PreviewKind) => {
    const f = PREVIEWS.find(p => p.key === kind)!.flags;
    const { data, error } = await supabase.rpc('payroll_close_notice_admin_preview', { ...f, p_lines_override: lines });
    if (error) { setPreviewErr('見え方を読み込めませんでした：' + error.message); return; }
    setPreviewErr(''); setPreview(data as PreviewResult);
  }, []);
  useEffect(() => {
    if (!draft) return;
    const t = setTimeout(() => { void loadPreview(draft.lines, previewKind); }, 400);
    return () => clearTimeout(t);
  }, [draft, previewKind, loadPreview]);

  if (loadErr) return <div style={{ marginBottom: 24, fontSize: 13, color: '#842029' }}>締め日のお知らせ：{loadErr}</div>;
  if (!draft || !saved) return null;

  const set = (patch: Partial<PayrollCloseSettings>) => { setDraft({ ...draft, ...patch }); setMsg(null); };
  const setLine = (k: keyof PayrollCloseSettings['lines'], v: string) => set({ lines: { ...draft.lines, [k]: v } });

  const save = async () => {
    setSaving(true); setMsg(null);
    const { data, error } = await supabase.from('app_settings')
      .update({ value: draft, updated_at: new Date().toISOString() }).eq('key', PAYROLL_CLOSE_SETTINGS_KEY).select('key');
    setSaving(false);
    if (error || !data || data.length === 0) { setMsg({ ok: false, text: '保存できませんでした' + (error ? '：' + error.message : '（権限がないか、設定の行がありません）') }); return; }
    setSaved(draft); setMsg({ ok: true, text: '保存しました' });
    void loadPreview(draft.lines, previewKind);
  };

  const testSend = async () => {
    setTesting(true); setMsg(null);
    const f = PREVIEWS.find(p => p.key === previewKind)!.flags;
    const { error } = await supabase.rpc('payroll_close_notice_test_send', f);
    setTesting(false);
    if (error) { setMsg({ ok: false, text: '試しに送れませんでした：' + error.message }); return; }
    setMsg({ ok: true, text: `「${PREVIEWS.find(p => p.key === previewKind)!.label}」の文面で、あなたのベルに送りました（スマホの通知を許可していれば、スマホにも届きます）。バナーは出ません` });
  };

  const field: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '7px 9px', border: `0.5px solid ${borderColor}`, borderRadius: 8,
    background: inputBg, color: text, fontSize: 13, lineHeight: 1.6, resize: 'vertical', fontFamily: 'inherit',
  };
  const nobody = !draft.bell && !draft.banner;

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ background: '#FFF8E1', borderLeft: '3px solid #F9A825', borderRadius: '0 6px 6px 0', padding: '8px 12px', fontSize: 13, fontWeight: 500, color: '#795548', marginBottom: 8 }}>
        📅 締め日のお知らせ
      </div>
      <div style={{ background: bg, border: `0.5px solid ${borderColor}`, borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ fontSize: 12, color: subText, lineHeight: 1.7, marginBottom: 10 }}>
          毎月14日 10:00 に送ります（14日が会社休なら、その前の会社休でない日）。ホームのバナーは15日の終わりまで出ます。<br />
          誰にどの行が届くかは、権限管理（残業・勤務変更報告・交通費申請）と雇用形態で決まります。ここで直せるのは文面と届け方だけです。
        </div>

        {preview && (
          <div style={{ fontSize: 12.5, color: text, marginBottom: 10, lineHeight: 1.7 }}>
            {saved.enabled
              ? <>次は <b>{jpDate(preview.next_send)} 10:00</b> に送ります（{jpDate(preview.next_close)}締め）。</>
              : <span style={{ color: '#842029' }}>いまは送りません（下の「送る」が OFF）。</span>}
            {preview.last_close && <span style={{ color: subText, marginLeft: 12 }}>前回：{jpDate(preview.last_close)}締め・{preview.last_count ?? 0}人</span>}
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 6 }}>
          {([['enabled', '送る'], ['bell', 'ベル'], ['push', 'スマホ'], ['banner', 'ホームのバナー']] as const).map(([k, l]) => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: text, cursor: 'pointer', opacity: k === 'push' && !draft.bell ? 0.5 : 1 }}>
              <input type="checkbox" checked={draft[k]} disabled={k === 'push' && !draft.bell}
                onChange={e => set({ [k]: e.target.checked } as Partial<PayrollCloseSettings>)} style={{ width: 16, height: 16 }} />
              {l}
            </label>
          ))}
        </div>
        <div style={{ fontSize: 11.5, color: subText, marginBottom: 10 }}>スマホの通知はベルが ON のときだけ届きます</div>
        {nobody && draft.enabled && <div style={{ fontSize: 12.5, color: '#842029', fontWeight: 'bold', marginBottom: 10 }}>ベルもバナーも OFF なので、誰にも届きません</div>}

        {PAYROLL_CLOSE_LINE_DEFS.map(d => {
          const v = draft.lines[d.key] ?? '';
          const needCount = (d.key === 'ot_pending' || d.key === 'sr_pending') && v.trim() !== '' && !v.includes('{件数}');
          return (
            <div key={d.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}>
              <div style={{ width: 76, flexShrink: 0, paddingTop: 6 }}>
                <div style={{ fontSize: 12.5, color: text, fontWeight: 600 }}>{d.label}</div>
                <div style={{ fontSize: 10.5, color: subText, lineHeight: 1.4 }}>{d.who}</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <textarea rows={2} value={v} onChange={e => setLine(d.key, e.target.value)} style={field} />
                {needCount && <div style={{ fontSize: 11.5, color: '#856404', background: '#fff3cd', borderRadius: 6, padding: '3px 8px', marginTop: 3 }}>{'{件数}'} が入っていません（件数が出なくなります）</div>}
                {d.key === 'commuter' && <div style={{ fontSize: 11.5, color: subText, marginTop: 3 }}>※交通費の画面の注意事項と同じ文です。決まりが変わったら両方を直してください</div>}
              </div>
            </div>
          );
        })}
        <div style={{ fontSize: 11.5, color: subText, lineHeight: 1.7, marginBottom: 12 }}>
          差し込み：{'{締め日}'}＝「11月15日（日）」の形／{'{件数}'}＝その人の件数。空にした行は出しません（はじめの行だけは、空なら最初の文を使います）。<br />
          送ったあとに文を直すと、ホームのバナーはすぐ新しい文になり、ベルの1行は送ったときのままです。
        </div>

        {/* 見え方 */}
        <div style={{ background: isDarkMode ? '#2d3136' : '#f4f6f4', borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: subText }}>見え方：</span>
            {PREVIEWS.map(p => (
              <button key={p.key} type="button" onClick={() => setPreviewKind(p.key)}
                style={{ padding: '4px 12px', borderRadius: 14, border: 'none', cursor: 'pointer', fontSize: 12,
                  background: previewKind === p.key ? TOGGLE_BLUE : (isDarkMode ? '#495057' : '#e9ecef'),
                  color: previewKind === p.key ? '#fff' : text, fontWeight: previewKind === p.key ? 'bold' : 'normal' }}>{p.label}</button>
            ))}
          </div>
          {previewErr && <div style={{ fontSize: 12.5, color: '#842029' }}>{previewErr}</div>}
          {preview && (
            <div style={{ maxWidth: 380 }}>
              <div style={{ fontSize: 11, color: subText, marginBottom: 4 }}>スマホのロック画面：15日は給与の締め日です。申請の確認をお願いします</div>
              <PayrollCloseCard title={preview.title} lines={preview.lines} onClose={() => {}} />
            </div>
          )}
        </div>

        {msg && <div style={{ fontSize: 13, marginBottom: 10, padding: '8px 12px', borderRadius: 8,
          background: msg.ok ? '#d1e7dd' : '#f8d7da', color: msg.ok ? '#0f5132' : '#842029' }}>{msg.text}</div>}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" onClick={save} disabled={!dirty || saving} style={{ ...primaryBtn({ disabled: !dirty || saving }), padding: '9px 22px', fontSize: 14 }}>
            {saving ? '保存中…' : '保存'}
          </button>
          <button type="button" onClick={testSend} disabled={dirty || testing}
            style={{ ...tintBtn(isDarkMode), padding: '9px 16px', fontSize: 13, opacity: dirty || testing ? 0.5 : 1, cursor: dirty || testing ? 'not-allowed' : 'pointer' }}>
            {testing ? '送っています…' : '自分に試しに送る'}
          </button>
          {dirty && <span style={{ fontSize: 11.5, color: subText }}>保存してから試せます</span>}
        </div>
      </div>
    </div>
  );
};

export default PayrollCloseNoticeSection;
