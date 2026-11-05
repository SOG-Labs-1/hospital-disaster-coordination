// 3分版の「Claude Code での作り方」に出す、実際の開発の出力（2026-11-05 にこのリポジトリで実行して写したもの）。
// 個人のメールアドレス・APIキー・.env の中身は含めない。数字が変わったら、このファイルを作り直す。
export const DEV = {
  "vitest": [
    " ✓ shared/src/transport.test.ts (34 tests)",
    " ✓ shared/src/security.test.ts (30 tests)",
    " ✓ shared/src/domain.test.ts (25 tests)",
    " ✓ shared/src/simulator.test.ts (19 tests)",
    " ✓ server/src/server.test.ts (17 tests)",
    " ✓ server/src/training.test.ts (15 tests)",
    " ✓ shared/src/support.test.ts (11 tests)",
    " ✓ server/src/config.test.ts (10 tests)",
    " ✓ shared/src/staff-zone.test.ts (8 tests)",
    "",
    " Test Files  20 passed (20)",
    "      Tests  213 passed (213)"
  ],
  "playwright": "Total: 30 tests in 10 files",
  "gitLog": [
    "62467ce セキュリティ監査の指摘（高・中）を修正",
    "856ed29 審査・デモ用の起動（npm run demo）と README の見直し",
    "9a491b1 修正の確認で見つかった点を直す",
    "bb178e5 最終点検（正しさ・決まり）の指摘を直す",
    "0b91353 使いやすさの最終点検の指摘を直す",
    "da3cc9b 操作して気になった点の修正：タブの件数、掲示用画面の入口、要員の割り当ての制限、小さな残りの解消",
    "af83b2a 決まりの点検の指摘を直す、訓練の無線の受信箱のフックの順番を直す、画面録画とデモ用データのスクリプトを追加"
  ],
  "rules": [
    "1. 架空データのみ。",
    "2. AIは状態を直接変えない。",
    "3. 中核機能はAPIなしで動く。",
    "4. AIは医療判断をしない。",
    "5. 記録は追記のみ。",
    "6. 病院固有の値をコードに書かない。",
    "7. 災害運用と訓練のデータは別ファイルに保存する。",
    "8. APIキーはサーバー側の環境変数のみ。"
  ],
  "commits": 68,
  "tsLines": 14934,
  "tests": 243
} as const;
