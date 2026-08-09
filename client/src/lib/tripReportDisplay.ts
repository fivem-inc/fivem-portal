// 出張報告の「見た目」をここに集約する。
// 🚨 管理画面（admin/TripReportsTab.tsx）とスタッフ側の履歴タブ（BusinessTripReport.tsx）の
//    2画面で同じ報告を表示するため、色やラベルを両方に書くと必ず食い違う
//    （このプロジェクトでは種別ラベルの二重定義で管理画面が真っ白になる事故を過去に起こしている）。
//    種別を増やすとき・色を変えるときは、このファイルだけを直せば両画面に反映される。

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// 報告種別のバッジ色。面の色が意味を持つので固定色＋白文字がセット（ダークでも変えない）
const TRIP_TYPE_COLOR: Record<string, string> = {
  '到着': '#17a2b8',
  '終了': '#28a745',
};

// 未知の種別が来ても落ちないようにフォールバックを返す
export const tripTypeColor = (reportType: string | null | undefined): string =>
  TRIP_TYPE_COLOR[reportType ?? ''] ?? '#6c757d';

// 区分の表示（「その他」のときだけ自由入力の中身を括弧で添える）
export const tripCategoryLabel = (r: { category?: string | null; category_other?: string | null }): string =>
  r.category === 'その他' ? `その他（${r.category_other || ''}）` : (r.category || '');

// 次回（次月）予定：DBはカンマ区切りの YYYY-MM-DD。「9/3（水）」の形に整える
export const formatTripNextDates = (nextDates: string | null | undefined): string => {
  if (!nextDates) return '';
  return nextDates.split(',')
    .map(d => d.trim())
    .filter(Boolean)
    .map(d => {
      const dt = new Date(d);
      if (Number.isNaN(dt.getTime())) return d;
      return `${dt.getMonth() + 1}/${dt.getDate()}（${WEEKDAYS[dt.getDay()]}）`;
    })
    .join('、');
};

// 報告日時。「8/9 14:20」の形（先頭の0は付けない＝アプリ全体の表記に合わせる）
export const formatTripDateTime = (createdAt: string | null | undefined): string => {
  if (!createdAt) return '';
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// GPSの座標からGoogleマップのURLを作る
export const tripMapUrl = (lat: number | null | undefined, lng: number | null | undefined): string | null =>
  lat != null && lng != null ? `https://www.google.com/maps?q=${lat},${lng}` : null;
