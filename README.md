# 院内災害対応 調整ツール

> **このリポジトリのデータはすべて架空です。** 実在の患者・職員・病院・非公開資料は一切使っていません。病院名・職員名・患者情報・シナリオはすべて作品用に作ったものです。

院内調整本部が「誰が・どこに・どんな状態で、何を依頼し、何が実行されたか」を確認時刻つきで共有するための実務ツールです。同じ画面と同じ病院設定を使って、Claude を他部署の役にした机上訓練（AI訓練モード）もできるようにします。

- 看護師として院内BCP訓練に参加して見えた課題が出発点です（Claude Code ハッカソン 2026、テーマ1「あなたにしかない深さを」）
- 中核の機能（登録・共有・集計・搬送・要請・印刷）は Claude API なしで動きます。実運用モードでは AI を一切使いません
- AI は診断・トリアージ判定・治療の助言をしません。訓練モードで部署役を担い、決められた形の「提案」を出すだけです

設計の詳細は [docs/design.md](docs/design.md) にあります。

## しくみの要点

- **記録は追記のみ**：すべての操作をイベントとして追記し、画面の状態はイベントから集計します。訂正は「訂正イベント」で残します（SQLite のトリガーで UPDATE と DELETE を禁止しています）
- **実運用と訓練は別ファイル**：`data/live.sqlite` と `data/training.sqlite`。画面上部に常に「実運用／訓練」を表示します
- **病院ごとの設定**：場所・災害時の用途（ゾーン）・トリアージ区分の表示・職員一覧などは `config/hospitals/*.yaml` から読み込みます
- **同時編集の検知**：対象ごとの版番号（expectedVersion）で競合を検知します
- **重複は止めずに警告**：同じタッグ番号などは警告を出し、理由を記録すれば登録できます
- **全端末へ即時配信**：Server-Sent Events で各端末に配信します

## 起動方法

Node.js 22.13 以上が必要です（`node:sqlite` を使います）。

```bash
npm install
```

開発用（サーバー :4000 と画面 :5173 を同時に起動）：

```bash
npm run dev
```

ブラウザで http://localhost:5173/?terminal=hq を開きます。`terminal` は端末を置く場所のIDです（病院設定の `locations` の id）。訓練モードは `&mode=training` を付けます。

使う病院設定は環境変数 `HOSPITAL_CONFIG` で選べます（既定は `sakura`）。

## テストと検証

```bash
npm test
```

```bash
npx playwright install chromium
```

```bash
npm run test:e2e
```

```bash
npm run validate:config -- config/hospitals/sakura.yaml
```

## 構成

| フォルダ | 内容 |
| --- | --- |
| `shared/` | ドメインの型・イベント定義・病院設定のスキーマ・集計（reducer）・コマンドの検証 |
| `server/` | HTTP API、SQLite への追記保存、Server-Sent Events での配信 |
| `web/` | React + Vite の画面 |
| `config/hospitals/` | 病院設定（架空） |
| `scenarios/` | 訓練シナリオ（架空） |
| `e2e/` | Playwright の画面テスト |
| `.claude/` | Claude Code の Skills・サブエージェント・フック |

## ハッカソン期間中に作成したもの

このリポジトリの内容はすべてハッカソン期間中（2026-11-04〜）に作成しました。作業の履歴はコミット履歴で確認できます。

### 11/4

- 開発環境の土台（npm workspaces、TypeScript、Vitest、Playwright）
- Claude Code の設定（Skills、サブエージェント、フック）
- 記録（イベント）の仕組み：イベントの型、病院設定のスキーマ、集計、追記保存、コマンドAPI（競合検知と警告）、Server-Sent Events での配信
- 病院設定A（架空「さくら総合病院(仮)」）
- 患者の登録と一覧、本部画面の骨組み

## Claude Code の使い分け

`.claude/` に、目的ごとの設定を置いています。

| 種類 | 名前 | 目的 |
| --- | --- | --- |
| Skill | `webapp-testing` | 画面の動作確認（Playwright） |
| Skill | `frontend-design` | 画面デザインの方針 |
| Skill | `claude-api` | 訓練モードでの Claude API の使い方 |
| Skill（自作） | `hospital-config` | 病院設定 YAML の作成と検証の手順 |
| サブエージェント | `ux-reviewer` | 災害時に不慣れな職員・高齢の職員の視点で画面を点検 |
| サブエージェント | `invariant-auditor` | CLAUDE.md の「最優先の決まり」への違反を点検 |
| フック | PostToolUse | `config/`・`scenarios/` の YAML を編集したら自動でスキーマ検証 |

## 出典とライセンス

- 本作品：MIT License（[LICENSE](LICENSE)）
- `.claude/skills/webapp-testing`・`.claude/skills/frontend-design`・`.claude/skills/claude-api`：[anthropics/skills](https://github.com/anthropics/skills) から取得（2026-11-04、コミット `ca45fc496a3436251f191354091d557da31c15b5`）。各フォルダの `LICENSE.txt` のとおり Apache License 2.0 です。内容は改変していません
- フォント：[BIZ UDゴシック](https://fonts.google.com/specimen/BIZ+UDGothic)（SIL Open Font License 1.1、Google Fonts から読み込み）
