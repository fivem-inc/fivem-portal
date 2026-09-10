import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { globalIgnores } from 'eslint/config'

export default tseslint.config([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  // 🚨 役職名で判定する書き方を全体で禁止する（2026-09-10・役職の属性化 段7）。
  //
  // 【なぜ要るか】
  //   役職名（'社長' 等）で判定していたため、改名しただけで本番の権限が壊れた（2026-09-09）。
  //   判定は roles の属性（lib/roleAttrs.ts の attrsFor / useAuth の isLeaderPlus 等）で行い、
  //   DB を引くときは roles!inner(...) で属性を条件にする。
  //
  // 【何を止めるか】文字列ではなく「形」で止める（'マネージャー' 単独の比較は '社長' の grep に出ないため）
  //   ・role_title === '文字列' / !== '文字列'（役職名との直接比較）
  //   ・.eq('role_title', …) / .in('role_title', …) / .neq('role_title', …)（役職名で DB を引く）
  //   ・['…', '…'].includes(roleTitle)（役職名の配列で判定）
  //   🚨 表示だけ（ラベル・並び替えで名前で束ねる）は対象外＝ role_title を「値として使う」のはよい。
  //      引っかかった場合は attrsFor / roles!inner に書き換えること。例外を足すときは理由を書く
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "BinaryExpression[operator=/^(===|!==|==|!=)$/][left.property.name='role_title'][right.type='Literal']",
          message: '🚨 役職名で判定しないでください。roles の属性（lib/roleAttrs.ts の attrsFor）で判定します（2026-09-09 に改名で権限が壊れた）',
        },
        {
          selector: "BinaryExpression[operator=/^(===|!==|==|!=)$/][right.property.name='role_title'][left.type='Literal']",
          message: '🚨 役職名で判定しないでください。roles の属性（lib/roleAttrs.ts の attrsFor）で判定します',
        },
        {
          selector: "CallExpression[callee.property.name=/^(eq|in|neq)$/][arguments.0.value='role_title']",
          message: "🚨 役職名で DB を引かないでください。.select('…, roles!inner(属性)').eq('roles.属性', true) の形にします",
        },
        {
          selector: "CallExpression[callee.property.name='includes'][callee.object.type='ArrayExpression'][arguments.0.name=/^(roleTitle|_roleTitle|role_title|role)$/]",
          message: '🚨 役職名の配列で判定しないでください。roles の属性（attrsFor / useAuth の isLeaderPlus 等）で判定します',
        },
      ],
    },
  },
  // 🚨 失敗が静かに消える書き方を、片付いたファイルから順に禁止していく（2026-09-09）。
  //
  // 【なぜ要るか】
  //   supabase の .update() / .delete() は、RLS（権限）で弾かれても error にならず
  //   「0件成功」で返る。戻り値を受けないと、何も更新できていなくても先へ進んでしまう。
  //   実際に「受理が通っていないのに『受理されました』と通知が飛ぶ」
  //   「更新できていないのに Googleカレンダーの予定が消える」事故が起きていた。
  //
  // 【なぜ files で絞るか】
  //   🚨 全体に入れると 74件の違反が出て、「lint は常に0件」という決まりが壊れる。
  //   片付けたファイルをここに足していく。**足す前に、そのファイルが0件か必ず確かめること。**
  //
  // 【なぜ .then(null, …) を禁止していないか】
  //   受け手が supabase のビルダーなら意味がないが、素の async 関数（dispatchEmail 等）に
  //   対しては**正当な守り**で、外すと未処理エラーになる。
  //   AST では両者を区別できず、模範実装（lib/purchaseApprovalActions.ts）まで
  //   違反になってしまうため入れていない。
  {
    files: [
      'src/lib/statusUpdate.ts',
      'src/components/AdminPanel.tsx',
      'src/components/LeaveApprovals.tsx',
      'src/components/LeaveRequest.tsx',
      'src/components/admin/ShiftReportsTab.tsx',
      'src/components/admin/UsersTab.tsx',
      // 2026-09-09 追加（申請まわり）。いずれも追加後に0件であることを実測して足している
      'src/App.tsx',
      'src/lib/faq.ts',
      'src/pages/CalendarPage.tsx',
      'src/pages/OvertimePage.tsx',
      'src/components/OvertimeProposalResponse.tsx',
      'src/components/admin/LeaveRequestsTab.tsx',
      // 2026-09-10 追加（連絡板・設定/マスタ）。いずれも追加後に0件であることを実測して足している
      'src/pages/BoardPage.tsx',
      'src/components/admin/BoardSettingsTab.tsx',
      'src/components/admin/NotificationsTab.tsx',
      'src/components/admin/OvertimeAdminTab.tsx',
      'src/components/admin/GroupsTab.tsx',
      // 2026-09-10 追加（場所予約）。追加後に0件であることを実測して足している
      'src/pages/RoomBookingPage.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "ExpressionStatement > AwaitExpression CallExpression[callee.property.name=/^(update|delete)$/]",
        message: "🚨 .update() / .delete() は0件でもエラーになりません（RLSで弾かれても0件成功）。const { data, error } = await ….select('id') で受け、error と件数の両方を見てください（判定と文言は lib/statusUpdate.ts）",
      }],
    },
  },
])
