import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useDarkMode } from '../../hooks/useDarkMode';
import { FAQ_PHONE_HOURS_KEY, FAQ_PHONE_HOURS_DEFAULT, FAQ_CONTACT_PHONE, FAQ_CONTACT_PHONE_LABEL, normalizePhoneHours } from '../../lib/faq';

// お客様向けFAQ（ホームページに埋め込むウィジェット）に出す「電話の受付時間」の設定。管理者だけが使う。
//
// 🚨 同じ受付時間が、公開Q&A「電話番号・受付時間を知りたい」の回答にも書かれている。
//    ここを直しても、Q&Aの回答は変わらない（逆も同じ）。
//    両方を直す必要があることを、画面にもそのまま書いてある。
// 🚨 鍵・初期値・整え方は lib/faq.ts の1か所（ウィジェットが読む側と食い違わないようにするため）。
// 🚨 空では保存させない。空にすると初期値に戻る作りなので、「消したつもりが古い時間が出る」になる。
const FaqContactHoursSetting: React.FC = () => {
  const isDarkMode = useDarkMode();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<string[]>(FAQ_PHONE_HOURS_DEFAULT);
  const [draft, setDraft] = useState(FAQ_PHONE_HOURS_DEFAULT.join('\n'));
  const [busy, setBusy] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const bg = isDarkMode ? '#343a40' : 'white';
  const text = isDarkMode ? '#fff' : '#333';
  const subText = isDarkMode ? '#adb5bd' : '#666';
  const borderColor = isDarkMode ? '#6c757d' : '#ddd';

  useEffect(() => {
    if (!open || loaded) return;
    (async () => {
      const { data, error } = await supabase.from('app_settings').select('value').eq('key', FAQ_PHONE_HOURS_KEY).maybeSingle();
      if (error) { setErrorMsg(`いまの設定を読み込めませんでした：${error.message}`); return; }
      const lines = normalizePhoneHours(data?.value) ?? FAQ_PHONE_HOURS_DEFAULT;
      setSaved(lines);
      setDraft(lines.join('\n'));
      setLoaded(true);
    })();
  }, [open, loaded]);

  const draftLines = draft.split('\n').map(l => l.trim()).filter(Boolean);
  const changed = draftLines.join('\n') !== saved.join('\n');

  const save = async () => {
    setErrorMsg('');
    if (draftLines.length === 0) { setErrorMsg('受付時間を1行以上入れてください。'); return; }
    setBusy(true);
    const { error } = await supabase.from('app_settings').upsert({ key: FAQ_PHONE_HOURS_KEY, value: draftLines }, { onConflict: 'key' });
    setBusy(false);
    if (error) { setErrorMsg(`保存できませんでした：${error.message}`); return; }
    setSaved(draftLines);
    setDraft(draftLines.join('\n'));
    setSavedMsg('受付時間を保存しました');
    setTimeout(() => setSavedMsg(''), 3000);
  };

  return (
    <div style={{ border: `1px solid ${borderColor}`, borderRadius: 8, marginBottom: 16, overflow: 'hidden' }}>
      <button type="button" onClick={() => setOpen(v => !v)}
        style={{ width: '100%', textAlign: 'left', padding: '10px 14px', background: isDarkMode ? '#495057' : '#f8f9fa', border: 'none', color: text, fontSize: 13, fontWeight: 'bold', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>🕐 お客様向けFAQに出す電話の受付時間</span>
        <span style={{ fontSize: 12, fontWeight: 'normal', color: subText }}>{open ? '閉じる ▲' : 'クリックして開く ▼'}</span>
      </button>
      {open && (
        <div style={{ padding: 14, background: bg }}>
          <p style={{ fontSize: 12, color: subText, margin: '0 0 10px', lineHeight: 1.7 }}>
            お客様向けFAQで答えが見つからなかったときの案内に、電話番号と一緒に表示されます。
            1行に1つずつ入れてください。<br />
            <strong>社外向けQ&amp;A「電話番号・受付時間を知りたい」の回答にも同じ受付時間が書かれています。時間が変わったときは、ここと両方を直してください。</strong>
          </p>
          {savedMsg && (
            <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 14, fontWeight: 'bold', color: '#166534' }}>
              ✓ {savedMsg}
            </div>
          )}
          {errorMsg && (
            <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 14, color: '#842029' }}>
              {errorMsg}
            </div>
          )}
          <label htmlFor="faq-phone-hours" style={{ display: 'block', fontSize: 12, color: subText, marginBottom: 4 }}>受付時間</label>
          <textarea id="faq-phone-hours" value={draft} onChange={e => setDraft(e.target.value)} rows={4} disabled={!loaded || busy}
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6, border: `1px solid ${borderColor}`, background: isDarkMode ? '#212529' : '#fff', color: text, fontSize: 14, lineHeight: 1.7, resize: 'vertical' }} />

          <div style={{ fontSize: 12, color: subText, margin: '12px 0 4px' }}>お客様には、こう表示されます</div>
          <div style={{ border: `1px solid ${borderColor}`, borderRadius: 8, padding: '10px 12px', background: '#fff', color: '#666', fontSize: 13, lineHeight: 1.7 }}>
            <div>お電話でも承ります</div>
            <div style={{ color: '#333', fontSize: 14, textDecoration: 'underline' }}>📞 {FAQ_CONTACT_PHONE}（{FAQ_CONTACT_PHONE_LABEL}）</div>
            {draftLines.length > 0
              ? draftLines.map((l, i) => <div key={i} style={{ fontSize: 12 }}>{l}</div>)
              : <div style={{ fontSize: 12, color: '#842029' }}>（受付時間が入っていません）</div>}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button type="button" onClick={save} disabled={!loaded || busy || !changed}
              style={{ padding: '7px 18px', background: '#007bff', color: '#fff', border: 'none', borderRadius: 6, cursor: (!loaded || busy || !changed) ? 'default' : 'pointer', fontSize: 13, fontWeight: 'bold', opacity: (!loaded || busy || !changed) ? 0.5 : 1 }}>
              {busy ? '保存中...' : '保存'}
            </button>
            {changed && (
              <button type="button" onClick={() => { setDraft(saved.join('\n')); setErrorMsg(''); }} disabled={busy}
                style={{ padding: '7px 14px', background: 'none', border: `1px solid ${borderColor}`, borderRadius: 6, color: subText, cursor: 'pointer', fontSize: 13 }}>
                やめる
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default FaqContactHoursSetting;
