// 連絡板「お知らせのテンプレート」（個人／全体）の型・絞り込み・並び・表示の判定（2026-09-26）。
//
// 🚨 supabase を読まない側（読み書きは lib/boardTemplatesApi.ts）。画面を開かずに tsx で検算できるように分けてある。
// 🚨 送信画面（BoardPage の一覧シート）と管理画面（BoardSettingsTab の全体テンプレの一覧）の**2か所が同じものを呼ぶ**。
//    片方に判定を書き写さないこと。
//
// ✅ ユーザー確定（2026-09-26）
//   ・テンプレに入るのは件名・本文だけ
//   ・個人＝本人だけが見る・誰でも登録できる／全体＝全員が読める・登録と修正・削除（他人のも）は権限 board_template_global
//   ・分類は id で結ぶ（名前の変更に耐える）。隠した分類を持つテンプレは「（旧）名前」で残す（黙って消えない）
//   ・並び：全体＝分類の順 → 名前順（誰かが直しても「いつもの位置」が変わらない）／自分の＝更新が新しい順

export type BoardTemplateScope = 'personal' | 'global';

export interface BoardTemplate {
  id: string;
  scope: BoardTemplateScope;
  /** 作った人。退職で消えると null（全体テンプレは残る） */
  owner_id: string | null;
  name: string;
  /** 分類の id。未分類は null。隠した分類の id のまま残ることもある */
  category_id: string | null;
  subject: string;
  body: string;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

export interface BoardTemplateCategory {
  id: string;
  name: string;
  sort_order: number;
  /** false＝管理画面で「使わない」にした（消していない） */
  active: boolean;
}

/** 分類の絞り込みの値。'all'＝すべて／'none'＝未分類（分類なし・隠した分類）／それ以外＝分類の id */
export type CategoryFilter = 'all' | 'none' | string;

/** 検索用に文字をそろえる：全角英数→半角・カタカナ→ひらがな・小文字・前後の空白なし */
export function normalizeForSearch(s: string): string {
  return (s ?? '')
    .normalize('NFKC')
    .replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .toLowerCase()
    .trim();
}

/** 分類の名前。隠した分類は「（旧）名前」、無い id・null は '' */
export function categoryLabel(categoryId: string | null, categories: BoardTemplateCategory[]): string {
  if (!categoryId) return '';
  const c = categories.find(x => x.id === categoryId);
  if (!c) return '';
  return c.active ? c.name : `（旧）${c.name}`;
}

/** 「未分類」として扱うか（分類なし・隠した分類・無い id） */
export function isUncategorized(t: BoardTemplate, categories: BoardTemplateCategory[]): boolean {
  if (!t.category_id) return true;
  const c = categories.find(x => x.id === t.category_id);
  return !c || !c.active;
}

/**
 * 絞り込み。scope → 分類 → 文字（名前・件名・本文の部分一致）の順に絞る。
 * 🚨 文字は normalizeForSearch でそろえて比べる（ひらがな・カタカナ・全角半角のゆれを吸収）。空文字は絞らない
 */
export function filterTemplates(
  list: BoardTemplate[],
  f: { scope: BoardTemplateScope; query: string; category: CategoryFilter },
  categories: BoardTemplateCategory[],
): BoardTemplate[] {
  const q = normalizeForSearch(f.query);
  return list.filter(t => {
    if (t.scope !== f.scope) return false;
    if (f.category === 'none') { if (!isUncategorized(t, categories)) return false; }
    else if (f.category !== 'all') { if (t.category_id !== f.category) return false; }
    if (!q) return true;
    return normalizeForSearch(t.name).includes(q)
      || normalizeForSearch(t.subject).includes(q)
      || normalizeForSearch(t.body).includes(q);
  });
}

/**
 * 並び。全体＝分類の順（未分類は最後）→ 名前順／自分の＝更新が新しい順。
 * 🚨 「上位◯件だけ出す」ときは、必ずこれで並べてから切ること（切ってから並べると上位が上位でなくなる）
 */
export function sortTemplates(list: BoardTemplate[], scope: BoardTemplateScope, categories: BoardTemplateCategory[]): BoardTemplate[] {
  const order = new Map(categories.filter(c => c.active).map(c => [c.id, c.sort_order] as const));
  const rank = (t: BoardTemplate) => (t.category_id && order.has(t.category_id)) ? (order.get(t.category_id) as number) : Number.MAX_SAFE_INTEGER;
  const copy = [...list];
  if (scope === 'global') {
    copy.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ja') || a.updated_at.localeCompare(b.updated_at));
  } else {
    copy.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.name.localeCompare(b.name, 'ja'));
  }
  return copy;
}

/** 修正・削除できるか。個人＝作った本人／全体＝権限がある人（他人のものも）。管理者は canGlobal を true で渡す */
export function canEditTemplate(t: BoardTemplate, userId: string | null | undefined, canGlobal: boolean): boolean {
  if (!userId) return false;
  return t.scope === 'personal' ? t.owner_id === userId : canGlobal;
}

/**
 * 絞り込みのチップに並べる分類。有効な分類（並び順）＋ いま見ている一覧に「未分類」のものがあれば最後に 'none'。
 * 🚨 隠した分類はチップに出さない（「未分類」にまとまる）。テンプレ側の表示は categoryLabel が「（旧）名前」を出す
 */
export function categoryChips(
  categories: BoardTemplateCategory[],
  visible: BoardTemplate[],
): { value: CategoryFilter; label: string }[] {
  const chips: { value: CategoryFilter; label: string }[] = [{ value: 'all', label: 'すべて' }];
  for (const c of [...categories].filter(c => c.active).sort((a, b) => a.sort_order - b.sort_order)) chips.push({ value: c.id, label: c.name });
  if (visible.some(t => isUncategorized(t, categories))) chips.push({ value: 'none', label: '未分類' });
  return chips;
}

/** テンプレの内容を送信画面に入れるときの確認が要るか（件名か本文に文字があるとき。宛先は見ない＝触らないため） */
export function needsReplaceConfirm(currentSubject: string, currentBody: string): boolean {
  return !!(currentSubject.trim() || currentBody.trim());
}

/** 保存前のチェック。問題なしは '' */
export function validateTemplateInput(v: { name: string; subject: string; body: string }): string {
  if (!v.name.trim()) return 'テンプレートの名前を入力してください';
  if (!v.subject.trim()) return '件名を入力してください';
  if (!v.body.trim()) return '本文を入力してください';
  return '';
}
