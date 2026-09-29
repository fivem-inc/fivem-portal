// 残業の申請を複数日まとめて送る（表入力・まとめて申請で共用・2026-09-29）。計画：docs/計画-残業のまとめて申請.md の「作る順番」2
//
// 🚨 表入力（OvertimeGrid.tsx の doSend）にあった送信の流れを、そのまま移した。
// 🚨 ここは supabase を読まない。DB への書き込み・お知らせ・カレンダーは「書き込み係」（BulkWriter）として外から渡す
//    （本物は lib/overtimeSubmitApi の supabaseBulkWriter。node の検算では偽物を渡して流れを確かめる）。
// 🚨 流れ：1行ずつ順に送る／途中で失敗しても他の行は止めない／送る直前にいまの時刻で行をもう一度判定する／
//    実績報告・再提出は送る直前に元の申請を読み直す／ベルは1件ずつ・メールは申請先ごとに1通・Slack は種類ごとに1通／
//    カレンダーは全部入れ終えてから1件ずつ

import { computeGridRow, sameGridReport, FURIKAE_ORIGIN_TAKEN_MSG, shortMd } from './overtimeGrid';
import type { GridReport, GridDayKind, RowDraft, GridRowCalc } from './overtimeGrid';
import { buildOvertimeRecord } from './overtimeSubmit';
import { editHistorySummary, reviewerPhaseLabel, shouldNotifyReviewer, effectiveClockReasonOf } from './overtimeFormParts';
import { isPayPeriodClosed, formatSignedMin } from './breakCalc';
import { overtimeAmountLabel } from './overtimeTypes';
import { toDbTime } from './timeInput';
import type { NormalShiftSnapshot } from './overtimeShift';
import type { SaveArgs, SaveResult } from './overtimeSubmitApi';

/** 送る行（表入力の1行・まとめて申請の箱の1件） */
export interface BulkRow {
  kind: GridDayKind;
  date: string;
  ns: NormalShiftSnapshot;
  main: GridReport | null;
  draft: RowDraft;
  /** この行の既定の申請先 */
  rowDefaultReviewer: string;
  /** 上長からの「申請の依頼」に答える行なら、その依頼 */
  req: { id: string } | null;
  /** この日を振替元にしている振替休日の日（computeGridRow の説明） */
  originOf?: string | null;
  /** 振替休日の行：振替元の日が使えない理由（表が知っている範囲） */
  furikaeOriginNg?: string;
}

/** 確認のときに見せた「送ると何になるか」。🚨 送る直前に種類が変わっていたら送らない */
export interface BulkTarget { date: string; label: string }

export type BulkRowStatus = 'waiting' | 'sending' | 'sent' | 'failed' | 'check';

/** 同じ日の申請（手入力・取消以外）が既にあったとき、中身を比べるための列 */
export interface ExistingManual {
  diff_minutes: number | null;
  reason: string | null;
  application_types: string[] | null;
  location: string | null;
  furikae_origin_date?: string | null;
}

/** DB・お知らせ・カレンダーの「書き込み係」 */
export interface BulkWriter {
  /** 実績報告・再提出の元の申請を読み直す（時間帯つき） */
  reread(id: string): Promise<{ data: (GridReport & Record<string, unknown>) | null; error: string | null }>;
  save(a: SaveArgs): Promise<SaveResult>;
  /** 同じ日の手入力の申請（取消以外）を1件 */
  findExistingManual(userId: string, date: string): Promise<{ data: ExistingManual | null; error: string | null }>;
  /** 依頼を「申請済み」にして申請と結び付ける。🚨 失敗しても申請そのものは成立している（依頼が open のまま残るだけ） */
  linkRequest(requestId: string, reportId: string): Promise<void>;
  bell(a: { reportId: string; reviewerId: string; applicantName: string; phaseLabel: string; dateLabel: string; timeLabel: string }): Promise<void>;
  email(a: { reviewerId: string; applicantName: string; phaseLabel: string; dateLabel: string; timeLabel: string }): Promise<void>;
  slack(reportIds: string[], eventKey: 'overtime:new_request' | 'overtime:confirmed'): Promise<void>;
  /** Google カレンダーへ。失敗したら false */
  gcal(reportId: string): Promise<boolean>;
  /** 休暇からの時間外調整休（自動計上）が同じ日にあるか。🚨 DB に網が無いので時間外調整休を出す直前に確かめる（読めなければ止める・1件フォームと同じ） */
  findLeaveAutoDuplicate(userId: string, date: string): Promise<{ dup: boolean; error: string | null }>;
  /**
   * その日を振替元にしている振替休日（取消以外）の日。
   * 🚨 DB のトリガーは「振替元の日に別の申請があるか」しか見ないので、同じ振替元の振替休日が2つできるのはここでしか止まらない
   */
  findFurikaeByOrigin(userId: string, originDate: string): Promise<{ dates: string[]; error: string | null }>;
}

export interface BulkCtx {
  userId: string;
  profileName: string;
  canSelfReview: boolean;
  advanceMaxDate: string;
  /** 経理から締め後の申請を許可された対象日 */
  grants: Set<string>;
  now: () => Date;
  /** 今日（JST の YYYY-MM-DD） */
  today: () => string;
  /** 申請先がマネージャー以上か（欠勤の申請先のチェック）。🚨 必須（リーダー宛の欠勤を止める網はここだけ。computeGridRow の説明） */
  reviewerIsManager: (id: string) => boolean;
  /** カレンダーに載せるかを自分で選べる人か（computeGridRow の説明） */
  canChooseCalendar: boolean;
}

export interface BulkResult {
  ok: number; failed: number; check: number;
  sentIds: string[];
  /** 送れた日（「すでに送信済みでした」を含む） */
  sentDates: string[];
  gcalFailedIds: string[];
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
/** "2026-10-03" → "2026-10-03（金）"（1件フォームの通知と同じ形） */
export function fullDateLabel(d: string): string {
  const [y, m, dd] = d.split('-').map(Number);
  return `${d}（${DOW[new Date(y, m - 1, dd).getDay()]}）`;
}

/**
 * 同じ日の申請が既にあったとき（23505）、送ろうとした中身と同じか。
 * 同じなら「すでに送信済み」（通信が切れて応答だけ届かなかった／2つのタブで送った）。違えば別の経路で作られた申請なので要確認。
 * 🚨 2026-09-29：比べるのを「組み立てた保存内容」にした（以前は下書きの理由と比べていて、保存時に理由を書き換える打刻ズレでは必ず要確認になった）。
 *    比べる項目：差分・理由・種別・勤務地・振替元の日
 */
export function existingMatchesRecord(ex: ExistingManual | null, rec: Record<string, unknown>): boolean {
  if (!ex) return false;
  const types = (v: unknown) => JSON.stringify([...((v as string[] | null) ?? [])].sort());
  return ex.diff_minutes === (rec.diff_minutes as number | null)
    && (ex.reason ?? '').trim() === String(rec.reason ?? '').trim()
    && types(ex.application_types) === types(rec.application_types)
    && (ex.location ?? '') === String(rec.location ?? '')
    && (ex.furikae_origin_date ?? null) === ((rec.furikae_origin_date as string | null | undefined) ?? null);
}

/** 送る直前の1行の判定（表入力・箱で同じもの）。🚨 いまの時刻で判定し直す */
export function recomputeRow(r: BulkRow, ctx: BulkCtx, now: Date = ctx.now()): GridRowCalc {
  const today = ctx.today();
  return computeGridRow({
    kind: r.kind, date: r.date, today, nowMin: now.getHours() * 60 + now.getMinutes(), advanceMaxDate: ctx.advanceMaxDate,
    ns: r.ns, main: r.main, draft: r.draft,
    defaultReviewerId: r.rowDefaultReviewer, canSelfReview: ctx.canSelfReview, selfId: ctx.userId,
    closeLocked: isPayPeriodClosed(r.date, today) && !ctx.grants.has(r.date), focused: false,
    reviewerIsManager: ctx.reviewerIsManager, canChooseCalendar: ctx.canChooseCalendar,
    originOf: r.originOf ?? null, furikaeOriginNg: r.furikaeOriginNg ?? '',
  });
}

/**
 * メールの「時間」。時間の申請は差分の合計、終日は種類ごとの件数（例「計+1:00・時間外調整休1件（2件）」）。
 * 終日だけの1件は種類の名前だけ（1件フォームのメールと同じ「時間外調整休」）
 */
export function mailTimeLabel(g: { diff: number; timeCount: number; fullDays: Record<string, number> }, total: number): string {
  const fd = Object.entries(g.fullDays);
  if (total === 1 && g.timeCount === 0 && fd.length === 1) return fd[0][0];
  const parts = [...(g.timeCount > 0 ? [`計${formatSignedMin(g.diff)}`] : []), ...fd.map(([k, n]) => `${k}${n}件`)];
  return `${parts.join('・')}（${total}件）`;
}

/**
 * まとめて送る。行ごとの結果は onRow で知らせる（画面はそれを表に出す）。
 * 🚨 同じ日が2つ入っていたら、2つ目は送らない（箱で同じ日を入れた場合の二重申請を防ぐ）
 */
export async function runBulkSend(
  targets: BulkTarget[],
  findRow: (date: string) => BulkRow | undefined,
  ctx: BulkCtx,
  writer: BulkWriter,
  onRow: (date: string, status: BulkRowStatus, message: string) => void,
  onProgress: (done: number, total: number) => void,
): Promise<BulkResult> {
  const sentIds: string[] = [];
  const sentDates: string[] = [];
  // メールは申請先ごとに1通（🚨 ベルは1件ずつ）
  // 🚨 終日（時間外調整休・欠勤）は時間の合計に混ぜず、種類ごとの件数で書く（2026-09-29。1件フォームのメールは「時間外調整休」と種類の名前）
  const mailGroups = new Map<string, { dates: string[]; diff: number; timeCount: number; fullDays: Record<string, number>; phases: Record<string, number> }>();
  // Slack は種類ごとに1通（🚨 宛先はチャンネルなので申請先ごとには分けない）
  const slackNew: string[] = [];
  const slackConfirmed: string[] = [];
  let ok = 0, failed = 0, check = 0;
  const seen = new Set<string>();
  // この送信で振替元に使った日（同じ振替元の振替休日を2つ送らない）
  const usedOrigins = new Set<string>();

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (seen.has(t.date)) {
      failed++; onRow(t.date, 'failed', '同じ日が2つ入っています。1つにしてください');
      onProgress(i + 1, targets.length);
      continue;
    }
    seen.add(t.date);
    onRow(t.date, 'sending', '');
    const r = findRow(t.date);
    const now = ctx.now();   // 🚨 この行の判定と保存の日時は同じ時刻を使う
    const c = r ? recomputeRow(r, ctx, now) : null;
    const isEdit = !!r && (r.kind === 'report' || r.kind === 'resubmit');
    // 🚨 実績報告・再提出は、送る直前にその申請を読み直す。
    //    表を開いている間に上長が受理・差し戻し・修正をしていたら、古い中身で上書きしないよう送らない
    let fresh: (GridReport & Record<string, unknown>) | null = null;
    let freshErr = '';
    if (isEdit && r?.main && c && (c.state === 'ok' || c.state === 'warn') && c.sendLabel === t.label) {
      const { data, error } = await writer.reread(r.main.id);
      if (error) freshErr = '申請を読み直せませんでした：' + error;
      else if (!data) freshErr = 'この申請が見つかりません（取り消された可能性があります）。表を読み直してください';
      else if (!sameGridReport(r.main, data as GridReport)) freshErr = '表を開いたあとで、この申請の状態か内容が変わっています（受理・差し戻し・修正など）。表を読み直してから、もう一度送ってください';
      else fresh = data;
    }
    // 🚨 時間外調整休は、休暇からの自動計上が同じ日に無いかを送る直前に確かめる（DB に網が無い・読めなければ止める・1件フォームと同じ文）
    let choseiNg = '';
    if (r && c && (c.state === 'ok' || c.state === 'warn') && c.sendLabel === t.label && c.fullDayType === 'chosei_off') {
      const x = await writer.findLeaveAutoDuplicate(ctx.userId, r.date);
      choseiNg = x.error ?? (x.dup ? 'この日は休暇申請の時間外調整休がすでに計上されています' : '');
    }
    // 🚨 振替休日は、送る直前に振替元の日をもう一度確かめる（振替元が別の給与期間だと表は知らない）。読めなければ止める
    if (!choseiNg && r && c && (c.state === 'ok' || c.state === 'warn') && c.sendLabel === t.label && c.fullDayType === 'furikae_off' && c.furikae) {
      const o = c.furikae.date;
      if (usedOrigins.has(o)) choseiNg = `振替元の日（${shortMd(o)}）は、この送信の別の振替休日でも使っています`;
      else {
        const ex = await writer.findExistingManual(ctx.userId, o);
        if (ex.error) choseiNg = '振替元の日の申請を確かめられませんでした（' + ex.error + '）。もう一度お試しください';
        else if (ex.data) choseiNg = FURIKAE_ORIGIN_TAKEN_MSG;
        else {
          const fb = await writer.findFurikaeByOrigin(ctx.userId, o);
          const other = fb.dates.filter(x => x !== r.date);
          if (fb.error) choseiNg = '振替元の日を確かめられませんでした（' + fb.error + '）。もう一度お試しください';
          else if (other.length > 0) choseiNg = `振替元の日（${shortMd(o)}）は、すでに ${shortMd(other[0])} の振替休日の振替元になっています`;
          else {
            // 🚨 休む日そのものが、ほかの振替休日の振替元になっていないか（DB のトリガーはこの組み合わせを止めない）
            const self = await writer.findFurikaeByOrigin(ctx.userId, r.date);
            if (self.error) choseiNg = '振替元の日を確かめられませんでした（' + self.error + '）。もう一度お試しください';
            else if (self.dates.length > 0) choseiNg = `この日（${shortMd(r.date)}）は、${shortMd(self.dates[0])} の振替休日の振替元です。この日を振替休日にはできません`;
          }
        }
      }
      if (!choseiNg) usedOrigins.add(o);
    }
    if (!r || !c || (c.state !== 'ok' && c.state !== 'warn')) {
      failed++; onRow(t.date, 'failed', c?.message || '送れる状態ではありません');
    } else if (c.sendLabel !== t.label) {
      failed++; onRow(t.date, 'failed', `種類が変わりました（${t.label} → ${c.sendLabel}）。確認し直してから送ってください`);
    } else if (isEdit && !fresh) {
      check++; onRow(t.date, 'check', freshErr);
    } else if (choseiNg) {
      failed++; onRow(t.date, 'failed', choseiNg);
    } else {
      const nowIso = now.toISOString();
      const record = buildOvertimeRecord({
        // 終日（2026-09-29・5回目）：保存の中身は buildOvertimeRecord の終日の枝（時刻なし・状態は自己受理なら確定／他人宛は申請中）
        userId: ctx.userId, date: r.date, mode: c.mode, phase: c.phase, fullDayMode: !!c.fullDayType, fullDayType: c.fullDayType,
        isSelfReview: c.isSelfReview, isPureZero: c.isPureZero, isReportPhase: c.isReportPhase, isResubmit: c.isResubmit, hasChanges: c.hasChanges,
        normalShift: r.ns, breakMin: c.breakMin, breakManual: r.draft.breakMin.trim() !== '', laborMin: c.laborMin, diffMin: c.diffMin,
        fdDiffMin: c.fullDayType ? c.diffMin : 0, legalOk: c.legalOk, reason: r.draft.reason, changeReason: r.draft.changeReason,
        fdLocation: c.fullDayType ? c.effectiveLocation : '', effectiveLocation: c.effectiveLocation,
        applicationTypes: c.applicationTypes,
        lateChoice: r.draft.lateChoice, earlyChoice: r.draft.earlyChoice,
        // 「📅 みんなのカレンダーに表示」（2026-09-29 案A）：出した行だけ本人の選択を保存。出さない行は新しい行＝null（種類ごとの既定）、
        //    実績報告は元の申請の値を引き継ぐ（buildOvertimeRecord の中で。1件フォームと同じ）
        offerCalendarChoice: c.offerCalendar, showOnCalendar: !!r.draft.showOnCalendar,
        editTargetShowOnCalendar: (fresh?.show_on_calendar as boolean | null | undefined) ?? undefined,
        // 振替休日の振替元（6回目）。振替休日以外は空（buildOvertimeRecord が振替休日のときだけ保存する）
        furikaeOriginDate: c.furikae?.date ?? '', effectiveFurikaeOriginLocation: c.furikae?.location ?? '',
        furikaeOriginStart: c.furikae?.start ?? '', furikaeOriginEnd: c.furikae?.end ?? '',
        furikaeOriginBreak: c.furikae?.breakMin ?? 0, furikaeOriginLabor: c.furikae?.laborMin ?? 0, furikaeHasTime: c.furikae?.hasTime ?? false,
        reviewerId: c.reviewerId, modifiedFromId: null,
        // 打刻ズレ（2026-09-29）：保存の中身は buildOvertimeRecord の打刻ズレの枝（確定・差分0・理由「残業ではありません（理由：…）」）
        clockOnlyMode: c.clockOnly,
        effectiveClockReason: c.clockOnly ? effectiveClockReasonOf(r.draft.clockReason ?? '', r.draft.clockReasonOther ?? '') : '',
        clockInAt: c.clockOnly ? (r.draft.clockInAt ?? '') : '', clockOutAt: c.clockOnly ? (r.draft.clockOutAt ?? '') : '', nowIso,
      }, toDbTime);
      // 🚨 再提出も元の値を引き継ぐ。buildOvertimeRecord は再提出では null にするので、ここで元の値に戻す。
      //    null にすると「載せない」を選んでいた人の申請が、直して出し直しただけでカレンダーに出てしまう
      //    （選び直しの欄を出した再提出は、本人の選択のまま）
      if (fresh && c.isResubmit && !c.offerCalendar) record.show_on_calendar = (fresh.show_on_calendar as boolean | null | undefined) ?? null;
      const saved = await writer.save({
        userId: ctx.userId, record, phase: c.phase, segments: c.workSegments, segRetries: 2,
        edit: fresh ? {
          id: fresh.id, status: fresh.status, snapshot: fresh,
          historySummary: editHistorySummary({ isReportPhase: c.isReportPhase, isPureZero: c.isPureZero, changedAxes: c.changedAxes, typeSwitched: null }),
          historyChangeReason: (c.isReportPhase && c.hasChanges) ? r.draft.changeReason.trim() : null,
        } : null,
      });
      if (!saved.ok) {
        if (saved.stage === 'conflict') {
          check++; onRow(r.date, 'check', saved.message);
        } else if (saved.code === '23505') {
          // 🚨 同じ日が既にある。中身が同じなら送信済み。違えば要確認。どちらも通知は送らない
          const ex = await writer.findExistingManual(ctx.userId, r.date);
          if (ex.error) { check++; onRow(r.date, 'check', '同じ日の申請がすでにあるようですが、確かめられませんでした（' + ex.error + '）。表を読み直して確認してください'); }
          else if (existingMatchesRecord(ex.data, record)) { ok++; sentDates.push(r.date); onRow(r.date, 'sent', 'すでに送信済みでした'); }
          else { check++; onRow(r.date, 'check', '同じ日の申請がすでにあります（内容が違います）。表を読み直して確認してください'); }
        } else if (saved.reportId) {
          // 申請は保存できたが時間帯が保存できなかった（入れ直しても失敗）。🚨 送り直すと重複になるので再送させない
          check++; onRow(r.date, 'check', `申請は保存されましたが、時間帯を保存できませんでした。履歴から「内容を修正する」で直してください（${saved.message}）`);
        } else {
          failed++; onRow(r.date, 'failed', saved.message);
        }
      } else {
        ok++; sentIds.push(saved.reportId); sentDates.push(r.date);
        onRow(r.date, 'sent', c.sendLabel);
        if (r.req) await writer.linkRequest(r.req.id, saved.reportId);
        // 🚨 呼び名と通知の条件は lib/overtimeFormParts（1件フォームと共用）
        const phaseLabel = reviewerPhaseLabel({ isResubmit: c.isResubmit, phase: c.phase, isModifiedReapply: false });
        // 🚨 打刻ズレは確認なしで確定するので、上長にもベル・メール・Slack を送らない（1件フォームと同じ）
        if (shouldNotifyReviewer({ isSelfReview: c.isSelfReview, isPureZero: c.isPureZero, clockOnly: c.clockOnly, reviewerId: c.reviewerId })) {
          await writer.bell({
            reportId: saved.reportId, reviewerId: c.reviewerId, applicantName: ctx.profileName,
            phaseLabel, dateLabel: fullDateLabel(r.date), timeLabel: overtimeAmountLabel(c.applicationTypes, c.diffMin),
          });
          const g = mailGroups.get(c.reviewerId) ?? { dates: [], diff: 0, timeCount: 0, fullDays: {}, phases: {} };
          g.dates.push(r.date); g.phases[phaseLabel] = (g.phases[phaseLabel] ?? 0) + 1;
          if (c.fullDayType) { const k = overtimeAmountLabel(c.applicationTypes, c.diffMin); g.fullDays[k] = (g.fullDays[k] ?? 0) + 1; }
          else { g.diff += c.diffMin; g.timeCount++; }
          mailGroups.set(c.reviewerId, g);
          slackNew.push(saved.reportId);
        } else if (c.isSelfReview && !c.isPureZero && !c.clockOnly) {
          // 🚨 自己受理の残業なし（差分0）は送らない（中身が無い。1件フォームと同じ条件）
          slackConfirmed.push(saved.reportId);
        }
      }
    }
    onProgress(i + 1, targets.length);
  }

  // メールを申請先ごとに1通
  for (const [reviewerId, g] of mailGroups) {
    const ds = [...g.dates].sort();
    await writer.email({
      reviewerId, applicantName: ctx.profileName,
      phaseLabel: Object.entries(g.phases).map(([k, v]) => `${k}${v}件`).join('・'),
      dateLabel: ds.length > 1 ? `${fullDateLabel(ds[0])}ほか${ds.length - 1}日` : fullDateLabel(ds[0]),
      timeLabel: mailTimeLabel(g, ds.length),
    });
  }

  // Slack を種類ごとに1通
  await writer.slack(slackNew, 'overtime:new_request');
  await writer.slack(slackConfirmed, 'overtime:confirmed');

  // カレンダーの同期は申請をすべて入れ終えてから1件ずつ（失敗は送信の失敗とは分けて出す）
  const gcalFailedIds: string[] = [];
  for (const id of sentIds) { if (!(await writer.gcal(id))) gcalFailedIds.push(id); }

  return { ok, failed, check, sentIds, sentDates, gcalFailedIds };
}
