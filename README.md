# 院内災害対応 調整ツール

> **このリポジトリのデータはすべて架空です。** 実在の患者・職員・病院・非公開資料は一切使っていません。病院名・職員名・患者情報・シナリオはすべて作品用に作ったものです。

院内調整本部が「誰が・どこに・どんな状態で、何を依頼し、何が実行されたか」を確認時刻つきで共有するための実務ツールです。同じ画面と同じ病院設定を使って、Claude を他部署の役にした机上訓練（AI訓練モード）もできるようにします。

- 看護師として院内BCP訓練に参加して見えた課題が出発点です（Claude Code ハッカソン 2026、テーマ1「あなたにしかない深さを」）
- 中核の機能（登録・共有・集計・搬送・要請・印刷）は Claude API なしで動きます。実運用モードでは AI を一切使いません
- AI は診断・トリアージ判定・治療の助言をしません。訓練モードで部署役を担い、決められた形の「提案」を出すだけです

設計の詳細は [docs/design.md](docs/design.md) にあります。

## しくみの要点

- **記録は追記のみ**：すべての操作をイベントとして追記し、画面の状態はイベントから集計します。訂正は「訂正イベント」で残します（SQLite のトリガーで UPDATE と DELETE を禁止しています）
- **実運用と訓練は別ファイル**：実運用は `data/<病院id>/live.sqlite`、訓練は回ごとに `data/<病院id>/training/<回>.sqlite`、訓練のシミュレーターの記録は `training-sim.sqlite`。画面上部に常に「実運用／訓練」を表示します
- **病院ごとの設定**：場所・災害時の用途（ゾーン）・トリアージ区分の表示・職員一覧などは `config/hospitals/*.yaml` から読み込みます
- **同時編集の検知**：対象ごとの版番号（expectedVersion）で競合を検知します
- **重複は止めずに警告**：同じタッグ番号などは警告を出し、理由を記録すれば登録できます
- **全端末へ即時配信**：Server-Sent Events で各端末に配信します
- **調整と事実を分けて記録**：搬送・支援要請は「依頼したこと」と「起きたこと」を別に記録し、欠けた確認を「未記録」と示します
- **未確認と0の区別**：数値は確認時刻つきで持ち、報告がないものは「未確認」と表示します

## 画面

| 画面 | 開き方 | 内容 |
| --- | --- | --- |
| 本部 | `?hospital=claude&terminal=hq` | 患者・搬送・支援要請・院内の状況・対応記録のタブ。主要画面に白黒で読める印刷 |
| 各部署 | `?hospital=claude&terminal=or` など | 上部に「この部署への依頼・記録すること」を固定表示、「この部署」タブ |
| 掲示用 | `?hospital=claude&view=board` | 本部の大型モニター用。操作なし・自動更新・配置は固定 |
| 訓練 | `?hospital=claude&terminal=hq&mode=training` | 無線の受信、訓練タブ（シナリオの開始・一時停止・2倍速・部署への連絡・振り返り） |

## AI訓練モード

ホワイトボード型の机上訓練を電子化し、他部署の役を AI（部署役）が担います。参加者は本部の役で、実運用と同じ画面を使います。

- 部署役の連絡は「無線の受信」に届くだけで、**ボードは自動では変わりません**。参加者が聞いて自分で入力します
- 部署役が出せるのは、決められた7つの行動の「提案」だけです（strict tool use で形を固定）。シミュレーターが実際の状態で検証してから反映します（存在しない搬送、受け入れ枠の超過、事実と違う報告は却下）
- 振り返りの照合（何が記録されなかったか、確認項目を満たしたか）はプログラムが行い、AI は根拠の番号を示して説明文を書くだけです。点数や順位は付けず、「記録がない」と「実施されていない」を区別し、参加者が画面外の対応を補足できます
- AI は診断・トリアージ判定・治療の助言をしません

部署役は環境変数で切り替えます（`.env.example` を `.env` にコピーして使います。`.env` はコミットしません）。

| 変数 | 内容 |
| --- | --- |
| `AI_PROVIDER` | `mock`（既定。API を使わない決まった返事）か `anthropic`（Claude） |
| `ANTHROPIC_API_KEY` | Claude API のキー（サーバー側だけで使う） |
| `ANTHROPIC_MODEL` | 部署役のモデル（例：`claude-sonnet-5-5`） |
| `ANTHROPIC_REVIEW_MODEL` | 振り返りの説明文のモデル（省略時は `ANTHROPIC_MODEL`） |
| `ANTHROPIC_EFFORT` | 部署役の考える深さ（既定 `low`） |

## 起動方法

Node.js 22.13 以上が必要です（`node:sqlite` を使います）。

```bash
npm install
```

開発用（サーバー :4000 と画面 :5173 を同時に起動）：

```bash
npm run dev
```

ブラウザで http://localhost:5173/?hospital=claude&terminal=hq を開きます。`terminal` は端末を置く場所のIDです（病院設定の `locations` の id）。訓練モードは `&mode=training` を付けます。

`config/hospitals/` の病院設定（架空の「Claude総合病院(仮)」と「Hackathon中央病院(仮)」）はすべて読み込まれ、URL の `hospital` で選びます（例：`?hospital=hinata&terminal=hq`）。指定しないと病院を選ぶ画面が出ます。記録は病院ごと・実運用／訓練ごとに別のファイルに保存します。

掲示用画面（本部の大型モニター）は `?hospital=claude&view=board` で開きます。

サーバーのポートは `SERVER_PORT`（既定 4000）、記録の保存先は `DATA_DIR`（既定 `data/`）、配信する病院は `HOSPITALS`（カンマ区切り）、病院を指定せずに開いたときの病院は `DEFAULT_HOSPITAL` で変えられます。

院内の1台のPCで本番のように動かす場合（画面をビルドしてサーバーから配信、http://localhost:4000 ）：

```bash
npm start
```

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
npm run validate:config -- config/hospitals/claude.yaml
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
- 病院設定A（架空「Claude総合病院(仮)」）と病院設定B（架空「Hackathon中央病院(仮)」）、病院の切り替え
- 患者の登録と一覧（重複の警告、区分の履歴と取り消し、印刷）
- 搬送（調整と事実の記録、重複・稼働中・受け入れ枠超過の警告、搬送要員）、院内の状況（未確認と0の区別）
- 支援要請（未対応・未完了の表示）、各部署の画面、掲示用画面、対応記録（時系列の記録）と連絡メモ
- AI訓練モード：シナリオ、シミュレーター、mock と Claude API の部署役（strict tool use）、無線の受信、振り返り
- サブエージェント（ux-reviewer・invariant-auditor）による点検と、指摘の修正

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
