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
    ],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "ExpressionStatement > AwaitExpression CallExpression[callee.property.name=/^(update|delete)$/]",
        message: "🚨 .update() / .delete() は0件でもエラーになりません（RLSで弾かれても0件成功）。const { data, error } = await ….select('id') で受け、error と件数の両方を見てください（判定と文言は lib/statusUpdate.ts）",
      }],
    },
  },
])
