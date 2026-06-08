import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import type { AuthUser, BusinessTripReport } from '../types';

interface Props {
  user: AuthUser;
  profileName: string | null;
}

const SLACK_CHANNELS = [
  { key: 'adult',             label: '03大人へ' },
  { key: 'kids_main',         label: '04本校こどもへ' },
  { key: 'kids_nishijin',     label: '05_2西陣校こどもへ' },
  { key: 'kids_kamikatsura',  label: '05_3上桂校こどもへ' },
  { key: 'kids_rakusaiguchi', label: '05_4洛西口校こどもへ' },
  { key: 'kids_minamisusita', label: '05_5南草津校こどもへ' },
  { key: 'junior',            label: '06ジュニアへ' },
  { key: 'support',           label: '07_1お客様サポートへ' },
];

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function formatDate(d: Date) {
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`;
}

interface CalendarProps {
  selected: string[];
  onToggle: (dateStr: string) => void;
  isDark: boolean;
}

const DateCalendar: React.FC<CalendarProps> = ({ selected, onToggle, isDark }) => {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  };

  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <button onClick={prevMonth} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: isDark ? '#fff' : '#333', padding: '4px 10px' }}>‹</button>
        <span style={{ fontWeight: 'bold', color: isDark ? '#fff' : '#333' }}>{viewYear}年{viewMonth + 1}月</span>
        <button onClick={nextMonth} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: isDark ? '#fff' : '#333', padding: '4px 10px' }}>›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
        {WEEKDAYS.map((w, i) => (
          <div key={w} style={{ textAlign: 'center', fontSize: 12, fontWeight: 'bold',
            color: i === 0 ? '#e74c3c' : i === 6 ? '#3498db' : isDark ? '#aaa' : '#666' }}>
            {w}
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((day, idx) => {
          if (!day) return <div key={idx} />;
          const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const isSelected = selected.includes(dateStr);
          const dow = (firstDay + day - 1) % 7;
          return (
            <button key={idx} onClick={() => onToggle(dateStr)}
              style={{
                padding: '6px 2px', borderRadius: 6, border: 'none', cursor: 'pointer',
                fontWeight: isSelected ? 'bold' : 'normal', fontSize: 14,
                background: isSelected ? '#007bff' : isDark ? '#495057' : '#f8f9fa',
                color: isSelected ? '#fff' : dow === 0 ? '#e74c3c' : dow === 6 ? '#3498db' : isDark ? '#fff' : '#333',
              }}>
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
};

const BusinessTripReportForm: React.FC<Props> = ({ user, profileName }) => {
  const isDark = useDarkMode();

  // 区分リスト・場所プリセット（DBから取得）
  const [categories, setCategories] = useState<string[]>(['出張', '園指導', '試合', '下見', 'その他']);
  const [locationPresets, setLocationPresets] = useState<Record<string, string[]>>({});

  useEffect(() => {
    Promise.all([
      supabase.from('master_options').select('value, sort_order').eq('category', 'trip_category').order('sort_order'),
      supabase.from('master_options').select('category, value, sort_order').like('category', 'trip_location_%').order('sort_order'),
    ]).then(([catRes, locRes]) => {
      if (catRes.data && catRes.data.length > 0) {
        setCategories(catRes.data.map(r => r.value));
      }
      if (locRes.data) {
        const map: Record<string, string[]> = {};
        locRes.data.forEach(row => {
          const catName = row.category.replace('trip_location_', '');
          if (!map[catName]) map[catName] = [];
          map[catName].push(row.value);
        });
        setLocationPresets(map);
      }
    });
  }, []);

  const [reportType, setReportType] = useState<'到着' | '終了'>('到着');
  const [category, setCategory] = useState<string>('出張');
  const [categoryOther, setCategoryOther] = useState('');
  const [location, setLocation] = useState('');
  const [locationCustom, setLocationCustom] = useState(''); // 直接入力
  const [useCustomLocation, setUseCustomLocation] = useState(false);
  const [notes, setNotes] = useState('');
  const [nextDates, setNextDates] = useState<string[]>([]);
  const [slackComment, setSlackComment] = useState('');
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsAttempted, setGpsAttempted] = useState(false);
  const [gpsUnavailable, setGpsUnavailable] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const presets = locationPresets[category] ?? [];
  const showNextDates = reportType === '終了' && (category === '出張' || category === '園指導');
  const effectiveLocation = useCustomLocation ? locationCustom : location;

  const toggleNextDate = (dateStr: string) => {
    setNextDates(prev => prev.includes(dateStr) ? prev.filter(d => d !== dateStr) : [...prev, dateStr]);
  };

  const toggleChannel = (key: string) => {
    setSelectedChannels(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const handleCategoryChange = (val: typeof category) => {
    setCategory(val);
    setLocation('');
    setLocationCustom('');
    setUseCustomLocation(false);
  };

  const handleGetGps = () => {
    if (!navigator.geolocation) { alert('このブラウザはGPSに対応していません'); return; }
    setGpsLoading(true);
    setGpsAttempted(true);
    setGpsUnavailable(false);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        setGps({ lat, lng, accuracy });
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=ja`,
            { headers: { 'Accept-Language': 'ja' } }
          );
          const data = await res.json();
          if (data?.address) {
            const a = data.address;
            // 「京都市左京区〇〇町」レベルの簡易住所
            const city = a.city || a.town || a.village || a.county || '';
            const district = a.city_district || a.suburb || '';
            const neighbourhood = a.neighbourhood || a.quarter || a.hamlet || a.road || '';
            const simplified = `${city}${district}${neighbourhood}`.trim() || data.display_name;
            setAddress(simplified);
          }
        } catch { /* 失敗は無視 */ }
        setGpsLoading(false);
      },
      () => {
        setGpsLoading(false);
        // 失敗 → チェックボックスを表示（alertは出さない）
      }
    );
  };

  // プレビュー用：Slackのmrkdwn記号（*）を除去して表示
  const buildSlackPreview = () => buildSlackMessage().replace(/\*/g, '');

  const buildSlackMessage = () => {
    const lines = [
      `📝 *【出張終了報告】*`,
      ``,
      `*報告者：* ${profileName || user.email}`,
      `*区分：* ${category === 'その他' ? `その他（${categoryOther}）` : category}`,
      `*場所：* ${effectiveLocation}`,
    ];
    if (nextDates.length > 0) {
      const formatted = [...nextDates].sort().map(d => formatDate(new Date(d)));
      lines.push(`*次回（次月）予定：* ${formatted.join('、')}`);
    }
    if (slackComment) lines.push(`📢 ${slackComment}`);
    return lines.join('\n');
  };

  const handleSubmitConfirm = () => {
    if (!effectiveLocation.trim()) { alert('場所を入力してください'); return; }
    if (category === 'その他' && !categoryOther.trim()) { alert('区分（その他）の内容を入力してください'); return; }
    if (!gps && !gpsUnavailable) { alert('📍 現在地を取得してください。\n取得できない場合は「取得できませんでした」にチェックしてください。'); return; }
    setShowConfirm(true);
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const report: BusinessTripReport = {
        user_id: user.id,
        report_type: reportType,
        category,
        category_other: category === 'その他' ? categoryOther : undefined,
        location: effectiveLocation,
        notes: notes || undefined,
        latitude: gps?.lat ?? null,
        longitude: gps?.lng ?? null,
        accuracy: gps?.accuracy ?? null,
        address: address || undefined,
        next_dates: nextDates.length > 0 ? nextDates.sort().join(',') : undefined,
      };

      const { error } = await supabase.from('business_trip_reports').insert([report]);
      if (error) throw error;

      // 終了報告 かつ チャンネルが1つ以上選択されている場合のみSlack送信
      if (reportType === '終了' && selectedChannels.length > 0) {
        try {
          await supabase.functions.invoke('send-trip-slack', {
            body: { message: buildSlackMessage(), channels: selectedChannels },
          });
        } catch (e) { console.error('Slack通知エラー:', e); }
      }

      setSubmitted(true);
      setShowConfirm(false);
      setReportType('到着'); setCategory('出張'); setCategoryOther('');
      setLocation(''); setLocationCustom(''); setUseCustomLocation(false);
      setNotes(''); setNextDates([]); setSlackComment('');
      setSelectedChannels([]); setGps(null); setAddress(null);
      setTimeout(() => setSubmitted(false), 4000);
    } catch {
      alert('送信に失敗しました。もう一度試してください。');
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', borderRadius: 6,
    border: isDark ? '1px solid #666' : '1px solid #ccc',
    fontSize: 16, boxSizing: 'border-box',
    background: isDark ? '#495057' : 'white',
    color: isDark ? '#fff' : '#333',
  };

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: '80px 16px 40px' }}>
      <h2 style={{ textAlign: 'center', marginBottom: 24, color: isDark ? '#fff' : '#333' }}>📍 出張報告</h2>

      {submitted && (
        <div style={{ background: '#d4edda', color: '#155724', padding: '12px 16px', borderRadius: 8, marginBottom: 16, textAlign: 'center' }}>
          ✅ 報告を送信しました！
        </div>
      )}

      <div style={{ background: isDark ? '#343a40' : 'white', borderRadius: 12, padding: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.1)', color: isDark ? '#fff' : '#333' }}>

        {/* 報告種別 */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8 }}>報告種別</label>
          <div style={{ display: 'flex', gap: 24 }}>
            {(['到着', '終了'] as const).map((type) => (
              <label key={type} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="radio" name="reportType" value={type}
                  checked={reportType === type} onChange={() => setReportType(type)} />
                {type}
              </label>
            ))}
          </div>
        </div>

        {/* 区分 */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8 }}>区分</label>
          <select value={category} onChange={(e) => handleCategoryChange(e.target.value as any)} style={inputStyle}>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          {category === 'その他' && (
            <input type="text" placeholder="内容を入力" value={categoryOther}
              onChange={(e) => setCategoryOther(e.target.value)}
              style={{ ...inputStyle, marginTop: 8 }} />
          )}
        </div>

        {/* 場所 */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8 }}>
            場所 <span style={{ color: 'red' }}>*</span>
          </label>

          {presets.length > 0 && !useCustomLocation ? (
            <>
              {/* プリセットボタン */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                {presets.map((p) => (
                  <button key={p} onClick={() => setLocation(p)}
                    style={{
                      padding: '8px 14px', borderRadius: 20, fontSize: 14, cursor: 'pointer',
                      border: location === p
                        ? '2px solid #007bff'
                        : isDark ? '1px solid #666' : '1px solid #ccc',
                      background: location === p ? '#007bff' : isDark ? '#495057' : '#f8f9fa',
                      color: location === p ? '#fff' : isDark ? '#fff' : '#333',
                      fontWeight: location === p ? 'bold' : 'normal',
                    }}>
                    {p}
                  </button>
                ))}
              </div>
              <button onClick={() => setUseCustomLocation(true)}
                style={{ background: 'none', border: 'none', color: isDark ? '#80c8ff' : '#007bff', cursor: 'pointer', fontSize: 13, padding: 0, textDecoration: 'underline' }}>
                ＋ 上記以外の場所を入力
              </button>
            </>
          ) : (
            <>
              <input type="text" placeholder="出張先・園名など" value={useCustomLocation ? locationCustom : location}
                onChange={(e) => useCustomLocation ? setLocationCustom(e.target.value) : setLocation(e.target.value)}
                style={inputStyle} autoFocus={useCustomLocation} />
              {presets.length > 0 && (
                <button onClick={() => { setUseCustomLocation(false); setLocationCustom(''); }}
                  style={{ background: 'none', border: 'none', color: isDark ? '#80c8ff' : '#007bff', cursor: 'pointer', fontSize: 13, padding: 0, marginTop: 4, textDecoration: 'underline' }}>
                  ← リストから選ぶ
                </button>
              )}
            </>
          )}
        </div>

        {/* 経理担当者への連絡事項 */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8 }}>経理担当者への連絡事項</label>
          <textarea placeholder="連絡事項があれば入力してください" value={notes}
            onChange={(e) => setNotes(e.target.value)} rows={3}
            style={{ ...inputStyle, resize: 'vertical' }} />
        </div>

        {/* GPS */}
        <div style={{ marginBottom: 24 }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8 }}>
            GPS位置情報 <span style={{ color: '#dc3545', fontSize: 13 }}>*</span>
          </label>
          {gps ? (
            <div style={{ background: isDark ? '#1d3a1d' : '#e8f5e9', padding: '10px 14px', borderRadius: 6, fontSize: 14, color: isDark ? '#adf5ad' : '#155724' }}>
              ✅ 取得済み
            </div>
          ) : (
            <div>
              <button onClick={handleGetGps} disabled={gpsLoading}
                style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #28a745', background: '#28a745', color: 'white', cursor: 'pointer', fontSize: 15 }}>
                {gpsLoading ? '取得中...' : '📍 現在地を取得'}
              </button>
              <div style={{ marginTop: 6, fontSize: 12, color: isDark ? '#adb5bd' : '#888', lineHeight: 1.6, textAlign: 'left' }}>
                <div>・許可を求めるダイアログが出たら「今回のみ」または「許可」を選んでください</div>
                <div>・位置情報はボタンを押したときのみ取得します（常時追跡はしません）</div>
              </div>
              {/* GPS取得試みたが失敗した場合のみチェックボックスを表示 */}
              {gpsAttempted && !gpsLoading && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, padding: '10px 12px', background: isDark ? '#3a2800' : '#fff9e6', border: `1px solid ${isDark ? '#5a4400' : '#ffe499'}`, borderRadius: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={gpsUnavailable} onChange={(e) => setGpsUnavailable(e.target.checked)} style={{ width: 18, height: 18, accentColor: '#fd7e14' }} />
                  <span style={{ fontSize: 14, color: isDark ? '#ffe082' : '#b8860b' }}>取得できませんでした（チェックして送信）</span>
                </label>
              )}
            </div>
          )}
        </div>

        {/* 次回（次月）予定（終了 かつ 出張・園指導のみ） */}
        {showNextDates && <hr style={{ border: 'none', borderTop: isDark ? '1px solid #555' : '1px solid #dee2e6', margin: '4px 0 20px' }} />}
        {showNextDates && (
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8 }}>
              次回（次月）予定 <span style={{ fontWeight: 'normal', fontSize: 13, color: isDark ? '#adb5bd' : '#6c757d' }}>（任意・複数選択可）</span>
            </label>
            <div style={{ background: isDark ? '#2c3136' : '#f8f9fa', borderRadius: 8, padding: 12, border: isDark ? '1px solid #555' : '1px solid #dee2e6' }}>
              <DateCalendar selected={nextDates} onToggle={toggleNextDate} isDark={isDark} />
              {nextDates.length > 0 && (
                <div style={{ marginTop: 10, padding: '8px 10px', background: isDark ? '#1a3a1d' : '#e8f5e9', borderRadius: 6, fontSize: 13, color: isDark ? '#adf5ad' : '#155724' }}>
                  📅 選択中: {[...nextDates].sort().map(d => formatDate(new Date(d))).join('、')}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 終了報告時のみ: Slack送信エリア */}
        {reportType === '終了' && (
          <div style={{ borderTop: isDark ? '1px solid #555' : '1px solid #dee2e6', paddingTop: 20 }}>
            <div style={{ fontWeight: 'bold', marginBottom: 4, fontSize: 15 }}>📢 Slack送信先チャンネル</div>
            <div style={{ fontSize: 12, color: isDark ? '#adb5bd' : '#6c757d', marginBottom: 12 }}>
              ※ 選択しない場合は送信されません
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              {SLACK_CHANNELS.map((ch) => (
                <label key={ch.key} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 15 }}>
                  <input type="checkbox" checked={selectedChannels.includes(ch.key)}
                    onChange={() => toggleChannel(ch.key)}
                    style={{ width: 20, height: 20, cursor: 'pointer' }} />
                  #{ch.label}
                </label>
              ))}
            </div>

            {/* コメント */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, fontSize: 14, color: isDark ? '#adb5bd' : '#6c757d' }}>
                💬 コメント <span style={{ fontWeight: 'normal' }}>（任意）</span>
              </label>
              <textarea placeholder="Slackに追加で送るコメントがあれば入力"
                value={slackComment} onChange={(e) => setSlackComment(e.target.value)}
                rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
            </div>

            {/* 送信プレビュー */}
            {selectedChannels.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 'bold', marginBottom: 6, fontSize: 14, color: isDark ? '#adb5bd' : '#6c757d' }}>
                  📋 送信イメージ
                </div>
                <div style={{
                  background: isDark ? '#1a1a2e' : '#f0f4ff',
                  border: isDark ? '1px solid #444' : '1px solid #c8d8ff',
                  borderRadius: 8, padding: '12px 14px',
                  fontSize: 13, whiteSpace: 'pre-wrap',
                  color: isDark ? '#ddd' : '#333', fontFamily: 'monospace', lineHeight: 1.6,
                }}>
                  {buildSlackPreview()}
                </div>
                <div style={{ fontSize: 12, color: isDark ? '#888' : '#999', marginTop: 4 }}>
                  送信先: {selectedChannels.map(k => '#' + (SLACK_CHANNELS.find(c => c.key === k)?.label ?? k)).join('、')}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 送信ボタン */}
        <button onClick={handleSubmitConfirm}
          style={{ width: '100%', padding: '12px', borderRadius: 8, background: '#007bff', color: 'white', border: 'none', fontSize: 16, fontWeight: 'bold', cursor: 'pointer', marginTop: 20 }}>
          送信
        </button>
      </div>

      {/* 確認モーダル */}
      {showConfirm && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }}>
          <div style={{ background: isDark ? '#343a40' : 'white', borderRadius: 12, padding: 28, maxWidth: 400, width: '90%', maxHeight: '80vh', overflowY: 'auto' }}>
            <h3 style={{ marginTop: 0, color: isDark ? '#fff' : '#333' }}>📋 送信内容の確認</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', color: isDark ? '#fff' : '#333' }}>
              <tbody>
                {[
                  ['報告種別', reportType],
                  ['区分', category === 'その他' ? `その他（${categoryOther}）` : category],
                  ['場所', effectiveLocation],
                  ['経理連絡事項', notes || 'なし'],
                  ...(nextDates.length > 0 ? [['次回（次月）予定', [...nextDates].sort().map(d => formatDate(new Date(d))).join('、')]] : []),
                  ['GPS', gps ? `取得済み（精度約${Math.round(gps.accuracy)}m）` : '未取得'],
                ].map(([label, value]) => (
                  <tr key={label}>
                    <td style={{ padding: '6px 8px', fontWeight: 'bold', whiteSpace: 'nowrap', color: '#aaa', verticalAlign: 'top' }}>{label}</td>
                    <td style={{ padding: '6px 8px', wordBreak: 'break-all' }}>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {reportType === '終了' && selectedChannels.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 'bold', fontSize: 13, color: '#aaa', marginBottom: 4 }}>Slack送信イメージ</div>
                <div style={{
                  background: isDark ? '#1a1a2e' : '#f0f4ff',
                  border: isDark ? '1px solid #444' : '1px solid #c8d8ff',
                  borderRadius: 8, padding: '10px 12px',
                  fontSize: 12, whiteSpace: 'pre-wrap',
                  color: isDark ? '#ddd' : '#333', fontFamily: 'monospace', lineHeight: 1.6,
                }}>
                  {buildSlackPreview()}
                </div>
                <div style={{ fontSize: 12, color: isDark ? '#888' : '#999', marginTop: 4 }}>
                  送信先: {selectedChannels.map(k => '#' + (SLACK_CHANNELS.find(c => c.key === k)?.label ?? k)).join('、')}
                </div>
              </div>
            )}
            {reportType === '終了' && selectedChannels.length === 0 && (
              <div style={{ marginTop: 12, fontSize: 13, color: isDark ? '#adb5bd' : '#6c757d' }}>
                ※ チャンネル未選択のためSlack送信なし
              </div>
            )}

            <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
              <button onClick={() => setShowConfirm(false)}
                style={{ flex: 1, padding: '10px', borderRadius: 6, border: isDark ? '1px solid #666' : '1px solid #ccc', background: isDark ? '#444' : '#f8f9fa', color: isDark ? '#fff' : '#333', cursor: 'pointer', fontSize: 15 }}>
                戻る
              </button>
              <button onClick={handleSubmit} disabled={isSubmitting}
                style={{ flex: 1, padding: '10px', borderRadius: 6, border: 'none', background: isSubmitting ? '#6c757d' : '#007bff', color: 'white', cursor: isSubmitting ? 'not-allowed' : 'pointer', fontSize: 15, fontWeight: 'bold' }}>
                {isSubmitting ? '送信中...' : '送信する'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BusinessTripReportForm;
