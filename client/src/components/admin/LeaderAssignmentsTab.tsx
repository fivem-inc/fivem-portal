import React, { useState, useEffect, useCallback } from 'react';
import { useAdminPanel } from './AdminPanelContext';

interface LeaderAssignment {
  id: string;
  course: string;
  school: string;
  leader: string;
  manager: string;
  display_order: number;
}

const emptyForm = { course: '', school: '', leader: '', manager: '', display_order: 0 };

const LeaderAssignmentsTab: React.FC = () => {
  const { isDarkMode, supabase } = useAdminPanel();
  const [items, setItems] = useState<LeaderAssignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [showAddForm, setShowAddForm] = useState(false);

  const text = isDarkMode ? '#fff' : '#000';
  const subText = isDarkMode ? '#adb5bd' : '#666';
  const borderColor = isDarkMode ? '#495057' : '#dee2e6';
  const inputBg = isDarkMode ? '#495057' : 'white';

  const fetchItems = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('leader_assignments').select('*').order('display_order', { ascending: true });
    if (!error && data) setItems(data as LeaderAssignment[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const startEdit = (item: LeaderAssignment) => {
    setEditingId(item.id);
    setShowAddForm(false);
    setForm({ course: item.course, school: item.school, leader: item.leader, manager: item.manager, display_order: item.display_order });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setShowAddForm(false);
    setForm(emptyForm);
  };

  const saveEdit = async () => {
    if (!form.course.trim() || !form.school.trim() || !form.leader.trim() || !form.manager.trim()) {
      alert('すべての項目を入力してください');
      return;
    }
    if (editingId) {
      const { error } = await supabase.from('leader_assignments').update({
        course: form.course, school: form.school, leader: form.leader, manager: form.manager, display_order: form.display_order,
        updated_at: new Date().toISOString(),
      }).eq('id', editingId);
      if (error) { alert('更新に失敗しました: ' + error.message); return; }
    } else {
      const { error } = await supabase.from('leader_assignments').insert({
        course: form.course, school: form.school, leader: form.leader, manager: form.manager, display_order: form.display_order,
      });
      if (error) { alert('追加に失敗しました: ' + error.message); return; }
    }
    cancelEdit();
    fetchItems();
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('この項目を削除しますか？')) return;
    const { error } = await supabase.from('leader_assignments').delete().eq('id', id);
    if (error) { alert('削除に失敗しました: ' + error.message); return; }
    fetchItems();
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 6, border: `1px solid ${borderColor}`,
    background: inputBg, color: text, fontSize: 13, marginBottom: 6,
  };
  const labelStyle: React.CSSProperties = { fontSize: 11, color: subText, marginBottom: 2, display: 'block' };

  const renderForm = () => (
    <div style={{ background: isDarkMode ? '#2d3136' : '#f8f9fa', border: `1px solid ${borderColor}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 6 }}>
        <div>
          <label style={labelStyle}>コース見出し（例: こども、ジュニア）</label>
          <input style={inputStyle} value={form.course} onChange={e => setForm(f => ({ ...f, course: e.target.value }))} />
        </div>
        <div>
          <label style={labelStyle}>校舎・対象（例: 四条本校、全校）</label>
          <textarea style={{ ...inputStyle, minHeight: 36, resize: 'vertical' }} value={form.school} onChange={e => setForm(f => ({ ...f, school: e.target.value }))} />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 6 }}>
        <div>
          <label style={labelStyle}>リーダー名（複数人は改行で区切る）</label>
          <textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} value={form.leader} onChange={e => setForm(f => ({ ...f, leader: e.target.value }))} />
        </div>
        <div>
          <label style={labelStyle}>マネージャー名</label>
          <input style={inputStyle} value={form.manager} onChange={e => setForm(f => ({ ...f, manager: e.target.value }))} />
        </div>
      </div>
      <div style={{ marginBottom: 10, maxWidth: 160 }}>
        <label style={labelStyle}>表示順（小さい数字が上に表示）</label>
        <input type="number" style={inputStyle} value={form.display_order} onChange={e => setForm(f => ({ ...f, display_order: parseInt(e.target.value) || 0 }))} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={saveEdit} style={{ padding: '8px 16px', background: '#0d6efd', color: 'white', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}>
          保存
        </button>
        <button onClick={cancelEdit} style={{ padding: '8px 16px', background: '#6c757d', color: 'white', border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}>
          キャンセル
        </button>
      </div>
    </div>
  );

  return (
    <div>
      <h3 style={{ textAlign: 'center', marginBottom: 8, color: text }}>📋 勤務校リーダー・マネージャー管理</h3>
      <p style={{ textAlign: 'center', fontSize: 13, color: subText, marginBottom: 16 }}>
        休暇申請ページに表示される「勤務校リーダー・マネージャー一覧」をここから編集できます。
      </p>

      {!showAddForm && !editingId && (
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <button onClick={() => { setShowAddForm(true); setForm(emptyForm); }} style={{ padding: '8px 16px', background: '#198754', color: 'white', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}>
            ＋ 新しい項目を追加
          </button>
        </div>
      )}

      {showAddForm && renderForm()}

      {loading ? (
        <p style={{ textAlign: 'center', color: subText }}>読み込み中...</p>
      ) : items.length === 0 ? (
        <p style={{ textAlign: 'center', color: subText }}>登録されている項目がありません</p>
      ) : (
        <div style={{ maxWidth: 700, margin: '0 auto' }}>
          {items.map(item => (
            <div key={item.id}>
              {editingId === item.id ? renderForm() : (
                <div style={{ background: isDarkMode ? '#2d3136' : '#fff', border: `1px solid ${borderColor}`, borderRadius: 10, padding: '12px 16px', marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ fontSize: 13, color: text, lineHeight: 1.7 }}>
                    <div style={{ fontWeight: 'bold', marginBottom: 2 }}>【{item.course}】　{item.school.replace(/\n/g, ' / ')}</div>
                    <div style={{ color: subText, fontSize: 12 }}>
                      リーダー: {item.leader.replace(/\n/g, '・')}　／　マネージャー: {item.manager}
                    </div>
                    <div style={{ color: subText, fontSize: 11, marginTop: 2 }}>表示順: {item.display_order}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button onClick={() => startEdit(item)} style={{ padding: '6px 12px', background: '#0d6efd', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                      編集
                    </button>
                    <button onClick={() => handleDelete(item.id)} style={{ padding: '6px 12px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                      削除
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default LeaderAssignmentsTab;
