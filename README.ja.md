# @cliwant/mcp-sam-gov

> **最も包括的なキーレス連邦データ MCP サーバー。**
> SAM.gov + USAspending + Federal Register + eCFR + Grants.gov の 36 ツール。
> API キー不要、登録不要、サインアップ不要。Claude Desktop, Claude Code, Codex CLI, Cursor, Continue, Gemini CLI、すべての MCP ホスト対応。

[English README](./README.md) · [한국어 README](./README.ko.md)

---

## Claude (および他の AI エージェント) ができること

| 領域 | 質問例 | ツール数 |
|---|---|---|
| 🔍 **アクティブな案件** | "今月締切の NAICS 541512 SAM.gov 案件を探して" | SAM.gov 5 |
| 💰 **受注 + 受注者** | "VA における Booz Allen の昨年度受注" | USAspending 8 |
| 📊 **集計分析** | "DoD の FY26 PSC カテゴリ Top 10" | USAspending 6 |
| 🏛 **機関プロフィール** | "VA のミッション? FY25 予算内訳?" | USAspending 3 |
| 🏢 **受注者プロフィール** | "Booz Allen の完全プロフィール + 別名" | USAspending 2 |
| 🧠 **幻覚防止** | NAICS / 受注者 / 機関 autocomplete + 用語集 | USAspending 5 |
| 📜 **Federal Register** | "今四半期の VA サイバーセキュリティ新規則?" | 3 |
| ⚖️ **規制 (FAR/CFR)** | "SDVOSB 優先発注の FAR 条項" | eCFR 2 |
| 🎓 **連邦助成金** | "過去 30 日のサイバーセキュリティ grant" | Grants.gov 2 |

**合計 36 ツール。API キー 0。p50 257ms, p95 766ms** (実際の federal API ベンチマーク)。

---

## どうインストール? あなたに合うパスを選択

### 🟢 パス 1 — Claude Desktop ワンクリック (ターミナル不要)

非開発者向け推奨。ファイル 1 つダウンロード → ダブルクリック。

1. [最新リリース](https://github.com/cliwant/mcp-sam-gov/releases/latest) から **`mcp-sam-gov.mcpb`** をダウンロード。
2. ファイルをダブルクリック。Claude Desktop で "Install Extension" ダイアログが表示される。
3. **Install** クリック。
4. 完了。新しい会話を開いて "Find active SAM.gov opportunities under NAICS 541512" と質問。

PowerShell, npm 等は不要。

> Claude Desktop ≥ 1.0 必須 (自身の Node.js ランタイムを同梱)。

### 🟡 パス 2 — Claude Code 一行

Claude Code (CLI) を既に使用している場合：

```bash
/plugin install cliwant/mcp-sam-gov
```

MCP サーバー + Claude が 36 ツールをいつ・どう呼ぶかを教える [SKILL.md ワークフローガイド](./skills/sam-gov/SKILL.md) を同時登録。

### 🔵 パス 3 — Codex / Cursor / Continue / Gemini 等の手動インストール

```bash
gh repo clone cliwant/mcp-sam-gov
cd mcp-sam-gov
npm install --omit=dev
npm install -g .
```

インストール後 `mcp-sam-gov` が PATH に登録される。ホスト config に追加：

```json
{
  "mcpServers": {
    "sam-gov": { "command": "mcp-sam-gov" }
  }
}
```

各ホスト別 config の場所は [Host configurations](#host-configurations) (英語 README) を参照。

### ⚪ パス 4 — 直接パス (グローバルインストールなし)

```bash
gh repo clone cliwant/mcp-sam-gov
cd mcp-sam-gov
npm install --omit=dev
```

ホスト config に絶対パス：

```jsonc
{
  "mcpServers": {
    "sam-gov": {
      "command": "node",
      "args": ["C:\\Users\\you\\mcp-sam-gov\\dist\\server.js"]
    }
  }
}
```

---

## どんな質問が可能?

自然言語で質問すると、AI が適切なツールシーケンスを自動呼び出し。

**案件発掘**
- "NAICS 541512 のメリーランド州案件で 30 日以内に締切のもの"
- "'computer systems design' の標準 NAICS コード?"

**RFP 分析**
- "noticeId 5ef3db5daeb54099a96d487783a38bd0 — SOW、担当者、添付すべて表示"
- "その案件の RFP 本文全体"

**競合環境**
- "VA の NAICS 541519 昨年 Top 5 受注"
- "Booz Allen の DISA 受注 contract 個別項目"
- "Leidos の VA contract の sub-contractor は誰?"
- "USAspending での 'CMS' の正式名称?"

**トレンド + 集計**
- "VA 541512 spending の 5 年推移"
- "541512 spending Top 10 州"
- "DoD の PSC カテゴリ Top spending"
- "サイバーセキュリティ関連 grant プログラム by total $"

**機関インテリジェンス (capture brief)**
- "VA の capture brief: ミッション、FY26 予算内訳、Top 下位機関"
- "VA FY25 transaction ボリューム"

**Recompete レーダー**
- "VA 541512 で 12 ヶ月以内に expiring contract over $1M"
- "award CONT_AWD_... の period of performance"

**規制**
- "SDVOSB 優先発注関連の FAR セクション"
- "今四半期の VA サイバーセキュリティ新規則"
- "Federal Register doc 2026-08333 の citation"

**Grant**
- "過去 30 日のサイバーセキュリティ grant"
- "grant id 361238 の詳細"

---

## オプション — レート制限緩和 + アーカイブ

デフォルトでキーレス。SAM.gov のレート制限緩和 + 12 ヶ月以前のアーカイブが必要な場合、ホスト env に SAM.gov キーを追加：

```json
{
  "mcpServers": {
    "sam-gov": {
      "command": "mcp-sam-gov",
      "env": { "SAM_GOV_API_KEY": "your-key-here" }
    }
  }
}
```

無料キー: [sam.gov/SAM/pages/public/searchKeyData.jsf](https://sam.gov/SAM/pages/public/searchKeyData.jsf)。AI は知る必要なし — 自動切り替え。

---

## 36 ツールカタログ

全ツール一覧 + 入力 schema は英語 README の collapsible セクション参照：https://github.com/cliwant/mcp-sam-gov#tool-catalog-36-tools

---

## トラブルシューティング

| 症状 | 解決 |
|---|---|
| Claude Desktop 🔨 メニューに `sam-gov` が表示されない | Claude Desktop を完全終了 (Windows: システムトレイ / macOS: Quit) して再起動。ログ: `%APPDATA%\Claude\logs\mcp*.log` |
| `command not found: mcp-sam-gov` | `npm install -g .` が成功したか確認。`npm config get prefix` の結果が PATH にあるか確認 |
| `MODULE_NOT_FOUND ...dist/server.js` (Windows) | npm の git-dep + symlink バグ。パス 3 (clone + `npm install -g .`) を使用 |
| `EPERM: operation not permitted` | `rmdir /s /q "%APPDATA%\npm\node_modules\@cliwant"` (初期バージョンをインストールしたことがある場合は `@govicon"`) 後に再試行 |
| ツールが空の結果を返す | SAM.gov のレート制限。1 分待機後に再試行 または `SAM_GOV_API_KEY` 設定 |

---

## ライセンス

MIT — [LICENSE](./LICENSE).

## 免責事項

このサーバーは **公開されている** federal API エンドポイントのみを使用します。米国 GSA、SAM.gov、USAspending.gov、Office of the Federal Register、National Archives、Grants.gov、または連邦機関とは無関係です。連邦調達 / spending / 規制データはパブリックドメインです。
