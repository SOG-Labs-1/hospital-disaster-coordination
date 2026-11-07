<div align="center">

# 🏥 病院リンクBCP

### Hospital Link BCP

**災害のとき、院内の「患者・人・物」の情報を、すべての端末で共有する。**<br>
**その同じ画面で、Claude を相手に本部の訓練ができる。**

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](#-技術と動作環境)
[![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)](#-技術と動作環境)
[![Node.js](https://img.shields.io/badge/Node.js_22.13+-339933?logo=nodedotjs&logoColor=white)](#-技術と動作環境)
[![Claude API](https://img.shields.io/badge/Claude_API-訓練モード-D97757?logo=anthropic&logoColor=white)](#-claude-の使いどころ)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

<a href="https://youtu.be/OWowj1tEUCE">
  <img src="https://img.youtube.com/vi/OWowj1tEUCE/maxresdefault.jpg" alt="デモ動画（YouTube・3分）" width="720">
</a>

▶️ **[デモ動画を見る（3分）](https://youtu.be/OWowj1tEUCE)** ・ 🚀 **[公開デモを触る](https://hospital-link-bcp-demo-926016263642.asia-northeast1.run.app)** ・ 📘 **[設計書](docs/design.md)**

</div>

> [!NOTE]
> **データはすべて架空です。** 実在の患者・職員・病院の情報は使っていません。

---

## 😣 解決したい課題

制作者は、災害対応に深く関わる病院で働く看護師です。

**いまの院内の災害対応**

| | いまのやり方 | 起きていること |
| --- | --- | --- |
| 📻 連絡 | **無線**か**院内電話** | 1対1でしか伝わらず、聞き違いや伝え漏れが起きる |
| 🗒️ 患者・人・物の場所と数 | **ホワイトボード**に手書き | 本部に行かないと見えず、いつの情報かも分からない |

多くの患者と職員が入り組む中で、**膨大な情報が錯綜し、正しく伝わらない・記録に残らない。**

## ✅ 病院リンクBCPの強み

> **錯綜する情報を、正確に伝え、確実に記録する。**

| | |
| --- | --- |
| 🎯 **正確に伝える** | 部署の端末で入れた情報が、そのまま本部とすべての端末に届く。人づての伝言を挟まない |
| 📝 **確実に記録する** | 誰が・いつ確かめ・何を頼み・何が起きたかを、消えない記録として残す |
| 🔁 **ふだんから練習できる** | 同じ画面で、Claude を相手に本部の訓練ができる |

## 💡 病院リンクBCPでできること

| 部署の端末で記録 | | 院内で共有 | | すぐに見える |
| :---: | :---: | :---: | :---: | :---: |
| 🚑 救急外来：患者の登録<br>🩺 手術室：受け入れの返事<br>🛏️ 病棟：応援の依頼 | ➡️ | 🖥️ **病院リンクBCP**<br>（院内のサーバー） | ➡️ | 🧭 災害対策本部<br>📺 掲示用モニター<br>💻 ほかの部署 |

**2つのモード、同じ画面**

| | 🟥 災害運用モード | 🔷 訓練モード |
| --- | --- | --- |
| 使うとき | 実際の災害 | ふだんの訓練 |
| 相手 | 院内の職員 | **Claude** が部署と搬送要員を演じる |
| AI | **使わない**（止まっても動く） | Claude API（提案だけ） |

**主な機能**

- 📍 **患者の居場所と状態**を、どの端末からでも登録・共有
- 🚑 **搬送の依頼 → 受け入れ → 出発 → 到着**を、段階ごとに記録
- 🙋 **人や物の応援の依頼**を、本部でまとめて手配
- ❓ 「未確認」と「0」、「頼んだこと」と「起きたこと」を**分けて記録**
- 📜 **記録は消さない**（訂正も履歴に残る）・🖨️ **白黒で読める印刷**
- 👀 大きな文字（BIZ UDゴシック）、色だけに頼らない表示（文字＋記号）
- 🏥 **病院ごとの設定ファイル**で、総合病院から中規模病院まで

| 本部（搬送） | 部署の画面 |
| --- | --- |
| ![本部の搬送の画面](docs/images/hq-transports.png) | ![部署の画面](docs/images/department.png) |
| **掲示用モニター** | **訓練モード** |
| ![掲示用画面](docs/images/board.png) | ![訓練モード](docs/images/training.png) |

## 🤖 Claude の使いどころ

訓練モードだけで使います。**災害運用モードでは AI を一切使いません。**

- 🎭 **部署を演じる**：手術室が受け入れを判断し、救急外来や病棟が「応援はまだ？」と催促する
- 📻 **搬送要員と無線**：「出発しました」「着きました」と返す
- 📝 **振り返り**：記録の抜けを、根拠の番号つきで説明する（照合はプログラム）
- 🛡️ **安全**：Claude が出せるのは決められた行動の「提案」だけ（strict tool use）。プログラムが検証してから記録に反映。**医療の判断や助言はしない**

👉 本物の Claude の返事の記録：[docs/training-with-claude.md](docs/training-with-claude.md)

## 🧰 技術と動作環境

| | |
| --- | --- |
| 言語 | TypeScript（npm workspaces：`shared` / `server` / `web`） |
| 画面 | React + Vite |
| サーバー | Node.js 22.13 以上、SQLite（`node:sqlite`、追記のみ）、Server-Sent Events |
| AI | Claude API（`claude-sonnet-5-5`、strict tool use）※ 訓練モードのみ |
| テスト | Vitest・Playwright |

**動かす場所**

- 🏥 **実際の病院**：院内のネットワークの中で動かします。院内の1台のPC（またはサーバー）で起動し、各部署のPCはブラウザで開くだけ。院外の回線が切れても使えます。
- 🧑‍⚖️ **審査用**：インストールなしで触れる[公開デモ](https://hospital-link-bcp-demo-926016263642.asia-northeast1.run.app)を用意しています（Google Cloud Run・**2026年11月13日まで**）。

## 🚀 セットアップ

Node.js 22.13 以上が必要です。

```bash
npm install
```

```bash
npm run demo
```

👉 http://localhost:4600 が開けば完了です（架空のデモ用データ入り）。

<details>
<summary><b>おすすめの試し方（3分）</b></summary>

ブラウザのタブを3つ並べると、端末どうしの同期が分かります。

1. **本部** http://localhost:4600/?hospital=claude&terminal=hq&mode=live で、入力者の名前を押す
2. **救急外来** http://localhost:4600/?hospital=claude&terminal=er&mode=live で患者を登録 → 本部にすぐ出る
3. 本部で「搬送を依頼する」→ **手術室** http://localhost:4600/?hospital=claude&terminal=or&mode=live で了承
4. 本部の「搬送」タブで、指示 → 出発 → 到着
5. **掲示用モニター** http://localhost:4600/?hospital=claude&view=board&mode=live は自動で更新

**訓練モード**：http://localhost:4600/?hospital=claude&terminal=hq&mode=training の「訓練」タブで「審査用5分シナリオ」を始めます。

</details>

<details>
<summary><b>Claude API で訓練する</b></summary>

既定は API を使わない決まった返事（mock）です。Claude に演じさせるときは：

```bash
cp .env.example .env
```

`.env` の `ANTHROPIC_API_KEY` にキーを入れて（`.env` はコミットしない）、起動します。

```bash
AI_PROVIDER=anthropic npm run demo
```

| 変数 | 内容 |
| --- | --- |
| `AI_PROVIDER` | `mock`（既定）か `anthropic` |
| `ANTHROPIC_API_KEY` | Claude API のキー（サーバー側だけで使う） |
| `ANTHROPIC_MODEL` | 部署役のモデル（例：`claude-sonnet-5-5`） |
| `ANTHROPIC_REVIEW_MODEL` | 振り返りのモデル（省略時は上と同じ） |
| `ANTHROPIC_EFFORT` | 考える深さ（既定 `low`） |

</details>

<details>
<summary><b>院内のPCで動かす・開発する・テストする</b></summary>

```bash
npm start
```

http://localhost:4000 で起動します。同じネットワークのPCからは `http://<このPCのアドレス>:4000` で開きます。

```bash
npm run dev
```

開発用（サーバー :4000、画面 :5173）。

```bash
npm test
```

```bash
npm run test:e2e
```

| 変数 | 内容 |
| --- | --- |
| `SERVER_PORT` | サーバーのポート（既定 4000） |
| `DATA_DIR` | 記録の保存先（既定 `data/`） |
| `HOSPITALS` / `DEFAULT_HOSPITAL` | 配信する病院／最初に開く病院 |
| `ALLOWED_HOSTS` | 院内の DNS 名などで開くときの名前 |
| `HOSPITAL_CREATION` | `0` で、画面から病院を作る機能を止める |

</details>

---

<details>
<summary><b>🛠️ Claude Code での作り方</b></summary>

制作者にプログラミングの経験はありません。Claude Code と一緒に作りました。

1. **先に決まりを書く**：設計書（[docs/design.md](docs/design.md)）と、守る決まり（[CLAUDE.md](CLAUDE.md)）を最初に書いた
2. **現場の言葉で頼み、触って直す**：看護師として操作して気づいたことを伝え、直してもらう
3. **Claude 自身が点検する**：サブエージェント `invariant-auditor`（決まりの違反）と `ux-reviewer`（不慣れな職員・高齢の職員の視点）。YAML はフックで自動検証
4. **並行して進める**：複数の Claude Code のセッションで、別々の作業を同時に進めた

| 種類 | 名前 | 目的 |
| --- | --- | --- |
| Skill | `webapp-testing` / `frontend-design` / `claude-api` | 画面の確認・デザイン・Claude API |
| Skill（自作） | `hospital-config` | 病院設定 YAML の作成と検証 |
| サブエージェント | `invariant-auditor` / `ux-reviewer` | 決まりと使いやすさの点検 |
| フック | PostToolUse | `config/`・`scenarios/` の YAML を自動検証 |

</details>

<details>
<summary><b>🔒 しくみと安全の要点</b></summary>

- **記録は追記のみ**：訂正も「訂正イベント」で残す。SQLite のトリガーで UPDATE・DELETE を禁止
- **重複は止めずに警告**：同じタッグ番号・2件目の搬送・受け入れ枠の超過などは、理由を記録すれば進められる
- **災害運用と訓練を取り違えない**：記録は別ファイル。画面と印刷に常に「■ 災害運用」「◇ 訓練」
- **キーはサーバーだけ**：API キーは画面のコードにも git の履歴にも入れていない
- **セキュリティの点検**：CSRF・DNS リバインディング・XSS・SQL インジェクションなどをサブエージェントで監査して修正（`shared/src/security.test.ts` ほか）

</details>

<details>
<summary><b>📦 フォルダ構成</b></summary>

| フォルダ | 内容 |
| --- | --- |
| `shared/` | ドメインの型・イベント・集計・検証・訓練のシミュレーター |
| `server/` | HTTP API・SQLite・SSE・Claude API の部署役 |
| `web/` | React の画面 |
| `config/` | 病院設定（架空） |
| `scenarios/` | 訓練シナリオ（架空） |
| `scripts/demo/` | 審査・デモ用の起動とデータ |
| `e2e/` / `e2e-demo/` | Playwright の画面テスト（手元／公開デモ） |
| `.claude/` | Skills・サブエージェント・フック |

</details>

<details>
<summary><b>🚧 今回の範囲外（実際の導入に必要なこと）</b></summary>

職員の認証と権限、通信の暗号化、バックアップと障害復旧、停電時の紙運用への切り替え、実際の訓練での評価。詳しくは [docs/design.md](docs/design.md) §12。

</details>

<details>
<summary><b>📅 ハッカソン期間中に作成したもの</b></summary>

このリポジトリの内容は、すべてハッカソン期間中（2026-11-03〜）に作成しました。作業の履歴はコミット履歴で確認できます。

- **11/4**：土台（npm workspaces・テスト・Claude Code の設定）、記録の仕組み、病院設定2つ、患者・搬送・支援要請・各部署・掲示用画面、訓練モード、病院の作成
- **11/5**：看護師として操作して気づいた点の修正、基準（WCAG 2.2・ISO 9241 など）による画面の点検、本物の Claude API での訓練の確認、`npm run demo`
- **11/6**：部署の記録が端末から入る訓練、部署の Claude の催促、製品名を「病院リンクBCP」に、審査用の公開デモ（Google Cloud Run）

</details>

## 📄 ライセンス

- 本作品：MIT License（[LICENSE](LICENSE)）
- `.claude/skills/webapp-testing`・`frontend-design`・`claude-api`：[anthropics/skills](https://github.com/anthropics/skills)（コミット `ca45fc4`、Apache License 2.0、改変なし）
- フォント：[BIZ UDゴシック](https://fonts.google.com/specimen/BIZ+UDGothic)（SIL Open Font License 1.1）

<div align="center">

**Built with Claude: Japan 2026** ・ テーマ1「あなたにしかない深さを」

</div>
