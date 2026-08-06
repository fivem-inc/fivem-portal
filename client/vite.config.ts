import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ビルドするたびに変わる番号。
// 🚨 アプリに埋め込む番号と version.json に書く番号は必ず同じでなければならない。
//    ここで1回だけ作って両方に渡す（別々に作ると永久に食い違い、更新の案内が出っぱなしになる）
const BUILD_ID = new Date().toISOString()

// 出力先（dist）。configResolved で確定した値を closeBundle で使う
let outDir = ''

// https://vite.dev/config/
export default defineConfig({
  // アプリのコードから __BUILD_ID__ で「いま動いている版の番号」を読めるようにする
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [
    react(),
    {
      // 出来上がったファイル一式の中に version.json を置く。
      // アプリはこれを見に来て「サーバーにある最新は何番か」を知る
      name: 'fivem-write-version-json',
      apply: 'build',
      configResolved(config) {
        outDir = resolve(config.root, config.build.outDir)
      },
      closeBundle() {
        writeFileSync(resolve(outDir, 'version.json'), JSON.stringify({ buildId: BUILD_ID }))
      },
    },
  ],
})
