import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useAdminPanel } from './AdminPanelContext';

// 管理者向け「調整提案」一覧（読み取り専用・情報用）。
// 誰が誰に何を提案し、どうなったか（採用/見送り/カスタム）と理由を俯瞰する。
// 理由（体調・家庭事情が入りうる）は既定で畳み、タップで開く。

interface OptRow { id: string; kind: string; work_date: string; adjust_time: string | null; location: string | null; selection: string; custom_date: string | null; custom_time: string | null; }
interface Row {
  id: string; created_at: string; status: string; remarks: string | null; recipient_note: string | null;
  proposer_id: string; recipient_id: string; pay_period_start: string; options: OptRow[];
}

const KIND_LABEL: Record<string, string> = { late_start: '遅出', early_end: '早退', chosei_off: '調整休' };
const SEL_LABEL: Record<string, string> = { pending: '未回答', accepted: '採用', declined: '見送り', custom: '採用(変更)' };
const STATUS_LABEL: Record<string, string> = { open: '未回答', responded: '回答あり', withdrawn: '取り下げ' };

const OvertimeProposalsTab: React.FC = () => {
  const { isDarkMode } = useAdminPanel();
  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const subText = isDarkMode ? '#adb5bd' : '#6c757d';
  const border = isDarkMode ? '#495057' : '#dee2e6';
  const cardBg = isDarkMode ? '#343a40' : '#fff';

  const [rows, setRows] = useState<Row[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [openNotes, setOpenNotes] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const { data } = await supabase.from('overtime_adjustment_proposals')
        .select('id, created_at, status, remarks, recipient_note, proposer_id, recipient_id, pay_period_start, options:overtime_adjustment_proposal_options(id, kind, work_date, adjust_time, location, selection, custom_date, custom_time)')
        .order('created_at', { ascending: false });
      if (!alive) return;
      const list = (data as Row[] | null) ?? [];
      setRows(list);
      const ids = [...new Set(list.flatMap(r => [r.proposer_id, r.recipient_id]))];
      if (ids.length) {
        const { data: profs } = await supabase.from('profiles').select('id, name').in('id', ids);
        setNames(Object.fromEntries(((profs as { id: string; name: string }[] | null) ?? []).map(p => [p.id, p.name])));
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  const toggleNote = (id: string) => setOpenNotes(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div style={{ maxWidth: 820, margin: '0 auto' }}>
      <h3 style={{ fontSize: 16, color: text, margin: '4px 0 4px' }}>🤝 残業調整の提案 一覧</h3>
      <p style={{ fontSize: 12.5, color: subText, margin: '0 0 14px' }}>誰が誰に調整を提案し、どうなったかの記録です（読み取り専用）。理由は「理由を見る」で開けます。</p>
      {loading ? <p style={{ color: subText, textAlign: 'center' }}>読み込み中…</p>
      : rows.length === 0 ? <p style={{ color: subText, textAlign: 'center' }}>提案はまだありません</p>
      : rows.map(r => (
        <div key={r.id} style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ fontSize: 13.5, fontWeight: 'bold', color: text }}>
              {names[r.proposer_id] ?? '?'} → {names[r.recipient_id] ?? '?'}
            </span>
            <span style={{ fontSize: 12, color: r.status === 'responded' ? '#1e8449' : subText }}>{r.created_at.slice(0, 10)}　{STATUS_LABEL[r.status] ?? r.status}</span>
          </div>
          {r.options.map(o => (
            <div key={o.id} style={{ fontSize: 12.5, color: text, padding: '2px 0' }}>
              ・{KIND_LABEL[o.kind] ?? o.kind}　{(o.custom_date ?? o.work_date)}{o.kind !== 'chosei_off' ? ` ${(o.custom_time ?? o.adjust_time ?? '').slice(0, 5)}` : ''}
              <span style={{ marginLeft: 8, color: o.selection === 'accepted' || o.selection === 'custom' ? '#1e8449' : subText }}>［{SEL_LABEL[o.selection] ?? o.selection}］</span>
              {o.location ? <span style={{ color: subText }}>／{o.location}</span> : null}
            </div>
          ))}
          {r.remarks && <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>備考：{r.remarks}</div>}
          {r.recipient_note && (
            <div style={{ marginTop: 6 }}>
              <button onClick={() => toggleNote(r.id)} style={{ fontSize: 11.5, color: '#1565c0', background: 'none', border: `1px solid ${border}`, borderRadius: 6, padding: '2px 10px', cursor: 'pointer' }}>
                {openNotes.has(r.id) ? '理由を隠す' : '理由を見る'}
              </button>
              {openNotes.has(r.id) && <div style={{ fontSize: 12.5, color: text, marginTop: 4 }}>相手のひとこと：{r.recipient_note}</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

export default OvertimeProposalsTab;
