# @govicon/mcp-sam-gov

> SAM.gov + USAspending 用 **Model Context Protocol** サーバー。
> Claude Desktop, Claude Code, Codex CLI, Cursor, Continue, Gemini CLI — MCP 対応のホストならどこでもそのまま接続。

[English README](./README.md) · [한국어 README](./README.ko.md)

## 提供する機能

AI エージェントが会話中に直接呼び出せる 8 つのツール：

| ツール | 用途 |
|---|---|
| `sam_search_opportunities` | SAM.gov 案件検索（キー不要） |
| `sam_get_opportunity` | noticeId で単一案件の詳細取得（POC、締切、添付、本文） |
| `sam_fetch_description` | RFP 本文をプレーンテキストで |
| `sam_attachment_url` | 添付ファイルのパブリックダウンロード URL 生成 |
| `usas_search_awards` | USAspending — agency × NAICS の share-of-wallet |
| `usas_search_individual_awards` | USAspending — 個別契約ライン |
| `usas_search_subagency_spending` | USAspending — 購入 office 別の内訳 |
| `usas_lookup_agency` | "VA" → "Department of Veterans Affairs" 正式名変換 |

**認証：** 不要。SAM.gov public + USAspending v2 ともにキーレス。`SAM_GOV_API_KEY` 環境変数を指定するとレート制限緩和 + 12 ヶ月以前のアーカイブも利用可能（任意）。

---

## インストール（private repo 段階）

`npm install -g github:...` の直接インストールは **Windows で動作しません** —
npm の git-dep + symlink 処理のバグにより dist ファイルが展開されないためです。
全 OS で同じように動く **clone + local global-install** を推奨します。

### 推奨 — clone + グローバルインストール（Windows / macOS / Linux 共通）

```bash
# gh auth login が必要（private repo の clone 権限）
gh repo clone seungdo-keum/govicon-mcp-sam-gov
cd govicon-mcp-sam-gov
npm install --omit=dev   # ランタイム deps のみ — dist/ は git に事前ビルド済み
npm install -g .         # `govicon-mcp-sam-gov` が PATH に登録される

govicon-mcp-sam-gov   # stdio MCP サーバー
```

### 代替 — グローバルインストールなしで直接パス

`npm install -g .` をスキップして、host config で絶対パスを指定：

```jsonc
{
  "mcpServers": {
    "sam-gov": {
      "command": "node",
      "args": ["C:\\Users\\you\\govicon-mcp-sam-gov\\dist\\server.js"]
    }
  }
}
```

### npm 公開後

```bash
npx -y @govicon/mcp-sam-gov
```

---

## AI ホストへの接続方法

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) または
`%APPDATA%\Claude\claude_desktop_config.json` (Windows)：

```json
{
  "mcpServers": {
    "sam-gov": { "command": "govicon-mcp-sam-gov" }
  }
}
```

API キー使用時：

```json
{
  "mcpServers": {
    "sam-gov": {
      "command": "govicon-mcp-sam-gov",
      "env": { "SAM_GOV_API_KEY": "your-key" }
    }
  }
}
```

Claude Desktop を再起動 → 🔨 メニューに 8 つのツールが表示されます。

### Claude Code

プロジェクトルートの `.mcp.json`：

```json
{
  "mcpServers": {
    "sam-gov": { "command": "govicon-mcp-sam-gov" }
  }
}
```

または CLI：

```bash
claude mcp add sam-gov govicon-mcp-sam-gov
```

### Codex CLI

`~/.codex/config.toml`：

```toml
[mcp_servers.sam-gov]
command = "govicon-mcp-sam-gov"
args = []
```

### Cursor

設定 → MCP → 新しいサーバー追加：

```json
{
  "mcpServers": {
    "sam-gov": { "command": "govicon-mcp-sam-gov" }
  }
}
```

### Gemini CLI

`~/.gemini/settings.json`：

```json
{
  "mcpServers": {
    "sam-gov": { "command": "govicon-mcp-sam-gov" }
  }
}
```

stdio MCP に対応する他のホストでも `govicon-mcp-sam-gov` バイナリを指定するだけです。

---

## 活用例

接続後、アシスタントは以下のような質問に対して自動でツールを呼び出して回答します：

- "NAICS 541512 のメリーランド州案件で 30 日以内に締切のものを探して"
- "noticeId 5ef3db5daeb54099a96d487783a38bd0 — SOW、担当者、添付すべて表示して"
- "VA の NAICS 541519 の昨年の上位 5 受注先は？"
- "Booz Allen の DISA 受注契約の個別項目を見せて"
- "USAspending での 'CMS' の正式名称は？"

ツールの呼び出しシーケンスは自動決定されます — プロンプトエンジニアリング不要。

---

## ライセンス

MIT — [LICENSE](./LICENSE).

## 免責事項

このサーバーは **公開されている** SAM.gov + USAspending エンドポイントのみを使用します。米国
GSA、SAM.gov、USAspending.gov、または連邦機関とは無関係です。連邦調達データはパブリックドメインです。
