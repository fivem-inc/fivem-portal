import React, { useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { AuthUser, BusinessTripReport } from '../types';

interface Props {
  user: AuthUser;
  profileName: string | null;
}

const BusinessTripReportForm: React.FC<Props> = ({ user, profileName }) => {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const [reportType, setReportType] = useState<'到着' | '終了'>('到着');
  const [category, setCategory] = useState<'出張' | '園指導' | '試合' | '下見' | 'その他'>('出張');
  const [categoryOther, setCategoryOther] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleGetGps = () => {
    if (!navigator.geolocation) {
      alert('このブラウザはGPSに対応していません');
      return;
    }
    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
        setGpsLoading(false);
      },
      () => {
        alert('位置情報の取得に失敗しました。ブラウザの許可設定を確認してください。');
        setGpsLoading(false);
      }
    );
  };

  const handleSubmitConfirm = () => {
    if (!location.trim()) {
      alert('場所を入力してください');
      return;
    }
    if (category === 'その他' && !categoryOther.trim()) {
      alert('区分（その他）の内容を入力してください');
      return;
    }
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
        location,
        notes: notes || undefined,
        latitude: gps?.lat ?? null,
        longitude: gps?.lng ?? null,
        accuracy: gps?.accuracy ?? null,
      };

      const { error } = await supabase.from('business_trip_reports').insert([report]);
      if (error) {
        console.error('Supabase error code:', error.code);
        console.error('Supabase error message:', error.message);
        console.error('Supabase error details:', error.details);
        console.error('Supabase error hint:', error.hint);
        throw error;
      }

      setSubmitted(true);
      setShowConfirm(false);

      // フォームリセット
      setReportType('到着');
      setCategory('出張');
      setCategoryOther('');
      setLocation('');
      setNotes('');
      setGps(null);

      setTimeout(() => setSubmitted(false), 4000);
    } catch (err) {
      alert('送信に失敗しました。もう一度試してください。');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: 600, margin: '40px auto', padding: '0 16px' }}>
      <h2 style={{ textAlign: 'center', marginBottom: 24 }}>📍 出張報告</h2>

      {submitted && (
        <div style={{
          background: '#d4edda', color: '#155724', padding: '12px 16px',
          borderRadius: 8, marginBottom: 16, textAlign: 'center'
        }}>
          ✅ 報告を送信しました！
        </div>
      )}

      <div style={{ background: isDark ? '#343a40' : 'white', borderRadius: 12, padding: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.1)', color: isDark ? '#fff' : '#333' }}>

        {/* 報告種別 */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8, color: isDark ? '#fff' : '#333' }}>報告種別</label>
          <div style={{ display: 'flex', gap: 24 }}>
            {(['到着', '終了'] as const).map((type) => (
              <label key={type} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: isDark ? '#fff' : '#333' }}>
                <input
                  type="radio"
                  name="reportType"
                  value={type}
                  checked={reportType === type}
                  onChange={() => setReportType(type)}
                />
                {type}
              </label>
            ))}
          </div>
        </div>

        {/* 区分 */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8, color: isDark ? '#fff' : '#333' }}>区分</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as any)}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: isDark ? '1px solid #666' : '1px solid #ccc', fontSize: 16, background: isDark ? '#495057' : 'white', color: isDark ? '#fff' : '#333' }}
          >
            {['出張', '園指導', '試合', '下見', 'その他'].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          {category === 'その他' && (
            <input
              type="text"
              placeholder="内容を入力"
              value={categoryOther}
              onChange={(e) => setCategoryOther(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: isDark ? '1px solid #666' : '1px solid #ccc', fontSize: 16, marginTop: 8, boxSizing: 'border-box', background: isDark ? '#495057' : 'white', color: isDark ? '#fff' : '#333' }}
            />
          )}
        </div>

        {/* 場所 */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8, color: isDark ? '#fff' : '#333' }}>場所 <span style={{ color: 'red' }}>*</span></label>
          <input
            type="text"
            placeholder="出張先・園名など"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: isDark ? '1px solid #666' : '1px solid #ccc', fontSize: 16, boxSizing: 'border-box', background: isDark ? '#495057' : 'white', color: isDark ? '#fff' : '#333' }}
          />
        </div>

        {/* 備考 */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8, color: isDark ? '#fff' : '#333' }}>備考</label>
          <textarea
            placeholder="備考があれば入力"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: isDark ? '1px solid #666' : '1px solid #ccc', fontSize: 16, boxSizing: 'border-box', resize: 'vertical', background: isDark ? '#495057' : 'white', color: isDark ? '#fff' : '#333' }}
          />
        </div>

        {/* GPS */}
        <div style={{ marginBottom: 24 }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8, color: isDark ? '#fff' : '#333' }}>GPS位置情報</label>
          {gps ? (
            <div style={{ background: '#e8f5e9', padding: '10px 14px', borderRadius: 6, fontSize: 14 }}>
              ✅ 取得済み（精度: 約{Math.round(gps.accuracy)}m）<br />
              <a href={`https://www.google.com/maps?q=${gps.lat},${gps.lng}`} target="_blank" rel="noreferrer">
                Googleマップで確認
              </a>
            </div>
          ) : (
            <button
              onClick={handleGetGps}
              disabled={gpsLoading}
              style={{
                padding: '8px 16px', borderRadius: 6, border: '1px solid #28a745',
                background: '#28a745', color: 'white', cursor: 'pointer', fontSize: 15
              }}
            >
              {gpsLoading ? '取得中...' : '📍 現在地を取得'}
            </button>
          )}
        </div>

        {/* 送信ボタン */}
        <button
          onClick={handleSubmitConfirm}
          style={{
            width: '100%', padding: '12px', borderRadius: 8,
            background: '#007bff', color: 'white', border: 'none',
            fontSize: 16, fontWeight: 'bold', cursor: 'pointer'
          }}
        >
          送信
        </button>
      </div>

      {/* 確認モーダル */}
      {showConfirm && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{ background: isDark ? '#343a40' : 'white', borderRadius: 12, padding: 28, maxWidth: 400, width: '90%' }}>
            <h3 style={{ marginTop: 0, color: isDark ? '#fff' : '#333' }}>📋 送信内容の確認</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', color: isDark ? '#fff' : '#333' }}>
              <tbody>
                {[
                  ['報告者', profileName || user.email],
                  ['報告種別', reportType],
                  ['区分', category === 'その他' ? `その他（${categoryOther}）` : category],
                  ['場所', location],
                  ['備考', notes || 'なし'],
                  ['GPS', gps ? `取得済み` : '未取得'],
                ].map(([label, value]) => (
                  <tr key={label}>
                    <td style={{ padding: '6px 8px', fontWeight: 'bold', whiteSpace: 'nowrap', color: '#aaa' }}>{label}</td>
                    <td style={{ padding: '6px 8px', color: isDark ? '#fff' : '#333' }}>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
              <button
                onClick={() => setShowConfirm(false)}
                style={{ flex: 1, padding: '10px', borderRadius: 6, border: isDark ? '1px solid #666' : '1px solid #ccc', background: isDark ? '#444' : '#f8f9fa', color: isDark ? '#fff' : '#333', cursor: 'pointer', fontSize: 15 }}
              >
                戻る
              </button>
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                style={{
                  flex: 1, padding: '10px', borderRadius: 6, border: 'none',
                  background: isSubmitting ? '#6c757d' : '#007bff', color: 'white',
                  cursor: isSubmitting ? 'not-allowed' : 'pointer', fontSize: 15, fontWeight: 'bold'
                }}
              >
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
