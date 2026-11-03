---
name: hospital-config
description: 病院設定ファイル（config/hospitals/*.yaml）を新しく作る・書き換える・検証するときの手順。場所、災害時の用途（ゾーン）、トリアージ区分の表示、役職、職種、職員一覧、受け入れ能力、警告の理由などを追加・変更するときに使う。
---

# 病院設定ファイルの作成と検証

病院固有の値はコードに書かず、すべて `config/hospitals/<病院id>.yaml` に書く（CLAUDE.md 最優先の決まり 6）。スキーマは `shared/src/config.ts` の `HospitalConfigSchema`。

## 守ること

- **架空データのみ。** 病院名・職員名は作品用に作った名前にする。実在の病院名、実在の人物を連想させる名前（有名人・実在の医療者など）、非公開資料の内容を使わない。病院名には「(仮)」を付ける
- `fictional: true` を必ず書く（スキーマで true 以外は受け付けない）
- 架空でも、患者の個人情報はこのファイルに書かない（患者は画面から登録する記録であり、設定ではない）
- 数値が未決定なら仮の値を入れ、行末に `# 仮` とコメントを書く

## 手順

1. 既存の `config/hospitals/sakura.yaml` を開き、構成をまねる
2. 次の順に書く。id は英小文字・数字・ハイフン（例: `er`, `ward-3`）。後から変えると記録と合わなくなるので、名前を変えたいときは `name` だけを変える
   1. `id`・`name`・`fictional`・`staleAfterMinutes`
   2. `locations`：物理的な場所。`kind` は `headquarters` `emergency` `outpatient` `ward` `operating-room` `icu` `hall` `rehabilitation` `other` から選ぶ。端末を置く場所は `hasTerminal: true`
   3. `triageCategories`：表示の文字（`label`）・記号（`symbol`）・説明・色・文字色・印刷時の枠線（`printBorder`）。**色だけで区別しない**ため、記号と枠線は区分ごとに違うものにする。`color` と `textColor` は WCAG 2.2 AA（4.5:1 以上）を満たす組み合わせにする
   4. `zones`：災害時の用途。場所とは別の概念。`triage` で主に受け入れる区分を書く
   5. `zoneAssignments`：ゾーンと場所の対応。1つの場所に複数のゾーンを割り当ててよい。途中から変わる対応は `from` に開始時刻を書く
   6. `capacity`：場所・区分ごとの受け入れ能力の初期値
   7. `professions`・`positions`・`staff`：職種、役職、入力者として選ぶ職員（架空の名前）
   8. `warningReasons`：重複などの警告を承知で実行するときの理由の選択肢
   9. `resources`・`checklist`：資源と、訓練の振り返りで照合する確認項目
3. 検証する

   ```bash
   npm run validate:config -- config/hospitals/<病院id>.yaml
   ```

   Claude Code で編集した場合は、PostToolUse フック（`.claude/settings.json`）が自動で同じ検証を実行する。エラーが出たら、表示された項目のパス（例: `capacity.3.triage`）を直す
4. 参照の整合性（存在しない場所・区分・職種を指していないか、id の重複がないか）もスキーマが検証する
5. 画面で確認する：`HOSPITAL_CONFIG=<病院id> npm run dev` で起動し、`http://localhost:5173/?terminal=<場所id>` を開く

## よくある誤り

- 場所とゾーンを混同する（「赤ゾーン」は場所ではなく用途。場所は「救急外来」）
- 記号や枠線を区分間で使い回す（白黒印刷で区別できなくなる）
- トリアージ区分の id を変える（過去の記録の区分が読めなくなる）
