# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Expense management application built with React/TypeScript frontend and Supabase backend.

## Development Setup

Working directory: `/mnt/c/Users/kohei/expense-app`

## Commands

**Deployment workflow:**
- `git add .` → `git commit -m "message"` → `git push`
- Vercel: Auto-deploys from GitHub (no manual action needed)
- Supabase Edge Functions: Manual deploy via dashboard when needed

## Architecture

- Frontend: React + TypeScript + Vite
- Backend: Supabase (database, auth, Edge Functions)
- Deployment: Vercel (frontend), Supabase (backend functions)
- Repository: GitHub integration with auto-deploy

## Notes

- Always use git workflow for deployments
- Vercel automatically deploys on git push
- Edge Functions require manual deployment in Supabase dashboard
- Project configured with proper TypeScript types and CORS handling

## Next Session TODO (明日の実装予定)

### ✅ 印刷機能完了 - 伝票番号・表示改善 (2025-08-01)
**実装完了内容**:
- ✅ 時刻ベース伝票番号: `#20250801-1430-01` (日付-時分-連番)
- ✅ ヘッダー表示: `[交通費請求明細書] #20250801-1430-01 【1/2】`
- ✅ 印刷日表示削除: シンプル化
- ✅ ローカルストレージ依存廃止: ブラウザ固有問題解決
- ✅ 中央寄せ角括弧形式: 視認性向上
- ✅ 印刷専用ウィンドウ使用: 余分ページ問題解決済み

### 🎯 その他優先実装
1. **ページ読み込み時の通知チェック** ✅完了
2. **却下理由付きのPOPアップ表示** ✅完了  
3. **メール通知は実装しない**

### 🚀 正しいデプロイ指示
```
「既存のfive-m-expense-appプロジェクトを更新して、
five-m-expense.vercel.appにデプロイして。
新しいプロジェクトは作らないで。」
```

### 📂 重要な設定
- **Root Directory**: `client` (Vercel設定済み)
- **vercel.json**: `/client/vercel.json` (正しい位置)
- **作業ディレクトリ**: `/mnt/c/Users/kohei/expense-app`
- **メインURL**: https://five-m-expense.vercel.app

### ✅ 現在完了済み
- 却下理由の表示機能 ✅
- 管理者パネルでの却下処理 ✅
- SPAルーティング修正 ✅
- 全体的なUI改善 ✅
- 404エラー解決 ✅
- **印刷機能の基本実装** ✅
  - 印刷選択UI
  - A4プレビューモーダル
  - 印刷履歴データベース更新
  - 伝票レイアウト（2伝票/ページ、10行/伝票）
- **ステータス色分け表示** ✅ (2025-07-26完了)
  - 申請中: 黒色
  - 承認: 青色・太字
  - 却下: 赤色・太字
  - 全画面（申請者履歴・管理者画面）に適用
- **交通費申請UI改善** ✅ (2025-08-01完了)
  - 項目名変更: 「通勤（単発）」「定期」「出張（園指導等）」
  - 勤務先入力欄追加（金額の後ろ、全角6文字程度、必須項目）
  - 申請履歴・管理者画面で勤務先表示
  - CSV出力・印刷出力に勤務先情報追加
  - データベース: rejected_reasonカラム追加済み
  - ログアウト機能修正（セッション管理改善）

### 📋 印刷機能詳細
**現在の状態**:
- プレビュー: 完全動作（A4サイズ、正確な伝票表示）
- 印刷データ生成: 正常（デバッグログで確認済み）
- **問題**: 実際の印刷で余分なページが出力される

**技術仕様**:
- CSS Grid: 2列レイアウト（1fr 1fr）
- 伝票サイズ: 87mm × 110mm
- ページサイズ: A4 (210mm × 297mm)
- 印刷時CSS: @media print + page-break制御

## ✅ 2025-08-02 作業完了

### 🎯 完了した機能実装
1. **申請種別セレクトボックス幅調整** ✅
   - 「出張（園指導等）」の文字切れを修正
   - `.single-select` CSS追加（min-width: 160px, max-width: 180px）

2. **申請フォーム説明文追加** ✅
   - 「申請履歴をテンプレートとして使用できます。」を追加
   - 改行付きで分かりやすく表示

3. **管理者画面フィルター機能実装** ✅
   - **申請種別フィルター**: 通勤（単発）、定期、出張（園指導等）、すべて
   - **ステータスフィルター**: 申請中、承認済み、却下、すべて
   - 承認待ち一覧・全申請履歴の両方に対応
   - リアルタイム絞り込み、軽量処理（フロントエンド配列フィルタリング）
   - 全選択・印刷機能もフィルター対応

4. **印刷プレビューと実際印刷の表示統一** ✅
   - App.cssに印刷プレビュー用CSS追加
   - 実際の印刷ウィンドウと完全一致する表示
   - 70%スケールでA4サイズを画面表示

5. **印刷処理の改善** ✅
   - 印刷キャンセル時に印刷済みマークが付かない仕様
   - 印刷キャンセル時に印刷ウィンドウを自動クローズ（4秒後）
   - `onafterprint`と`onbeforeunload`イベント活用

6. **承認・却下ボタンのUI改善** ✅
   - 承認ボタン: 緑色背景 + 濃い緑枠線（2px solid）
   - 却下ボタン: 赤色背景 + 濃い赤枠線（2px solid）
   - パディング、太字フォント、角丸で視認性向上

### 🚀 技術的実装詳細
- **フィルタリング**: `useCallback`と`useMemo`でパフォーマンス最適化
- **印刷制御**: `printWindow.onafterprint`で実際の印刷完了を検知
- **UI統一**: 印刷プレビューCSS（App.css）で実際印刷と完全一致
- **エラーハンドリング**: 印刷ウィンドウのtry-catch処理で安全性確保