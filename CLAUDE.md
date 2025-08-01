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

### 🚨 緊急修正 - 印刷機能
**問題**: 1件の申請を選択しても3ページ印刷される
- ✅ プレビュー表示: 正常（1ページ、2個の伝票表示）
- ✅ DOM構造: 正常（console.logで確認済み）
- ❌ 印刷出力: 3ページ出力される（1ページ目は正常、2-3ページ目は白紙）

**調査済み項目**:
- page-break-after設定調整 → 効果なし
- display/visibility設定 → 白紙ページは削減できたが3ページ出力は継続
- CSS print設定最適化 → 部分的改善のみ

**次回調査項目**:
1. ブラウザ固有の印刷バグかどうか確認
2. 他のCSS print設定（@page size, margin）を調整
3. JavaScriptでの印刷制御（window.print()の代替手法）
4. 印刷用CSSフレームワーク導入検討

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