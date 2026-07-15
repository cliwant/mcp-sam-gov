# @cliwant/mcp-sam-gov

> **最も包括的なキーレス連邦データ MCP サーバー。**
> SAM.gov · USAspending · SEC EDGAR · OFAC · FDIC · Federal Register · Regulations.gov · eCFR · FAR/DFARS · BLS · Treasury · NIH · NSF · ClinicalTrials · CMS · NVD/CISA · USITC · Census · FRED · FEMA ほか **34 の連邦データソース、116 ツール。** キーレス優先 — Census business-patterns と FRED のみ無料キーが必要で、残り 32 ソースはキー不要。
> API キー不要、登録不要、サインアップ不要。Claude Desktop, Claude Code, Codex CLI, Cursor, Continue, Gemini CLI、すべての MCP ホスト対応。

[English README](./README.md) · [한국어 README](./README.ko.md)

> 本書は [英語 README](./README.md) のミラーです。最新・詳細(ホスト別設定、全ツールカタログの原文)は英語版を正とします。

---

## Claude (および他の AI エージェント) ができること

| 領域 | 質問例 | ソース |
|---|---|---|
| 🔍 **案件 + ソリシテーション** | "今月締切の NAICS 541512 SAM.gov 案件 — SOW・担当者・添付まで" | SAM.gov, Grants.gov |
| 💰 **spending・受注・競合** | "VA の Booz Allen 昨年度受注、DoD PSC カテゴリ Top 10" | USAspending, FPDS, GAO |
| 🕵️ **パートナー・企業の検証** | "この企業をスクリーニング: OFAC 制裁・SAM 除外・単一監査指摘・銀行健全性・EPA 遵守" | OFAC, SAM, FAC, FDIC, EPA ECHO |
| 📈 **財務開示 (SEC)** | "この上場企業の売上推移 + 最新 10-K" | SEC EDGAR |
| ⚖️ **規制・立法** | "今四半期の VA サイバーセキュリティ規則? 進行中の Regulations.gov docket?" | Federal Register, Regulations.gov, eCFR, FAR/DFARS, Congress.gov, GovInfo |
| 💲 **価格・労務・財政** | "GSA CALC 労務単価バンド、この郡の SCA 賃金決定、CPI エスカレーション、出張 per-diem 上限" | GSA CALC, SAM WD, BLS, US Census CBP, FRED, US Treasury, GSA per-diem |
| 🏥 **医療・研究資金** | "このテーマの NIH/NSF grant、募集中の臨床試験、この医師への業界支払" | NIH RePORTER, NSF, ClinicalTrials, CMS, NPPES |
| 🛡 **サイバー遵守** | "この CVE は CISA KEV 必須パッチ一覧にあるか?" | NVD, CISA KEV |
| 🌐 **貿易・地理・災害** | "この品目の HTS 関税、この住所の Census tract、この州の FEMA 宣言" | USITC HTS, Census, FEMA, Socrata, CKAN |
| 🎓 **grant・データセット** | "過去 30 日のサイバーセキュリティ grant、連邦オープンデータセット発見" | Grants.gov, data.gov |

**34 の連邦データソース、合計 116 ツール — キーレス優先: Census business-patterns と FRED のみ無料キーが必要で、残り 32 ソースはキー不要。** (初期の 52 ツール版でおおよそ p50 ~0.25s / p95 ~0.8s を計測 — ソースや上流負荷で変動する近似値であり保証値ではありません。)

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

MCP サーバー + Claude が 116 ツールをいつ・どう呼ぶかを教える [SKILL.md ワークフローガイド](./skills/sam-gov/SKILL.md) を同時登録。

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

### `DATA_GOV_API_KEY` — api.data.gov / api.gsa.gov ファミリー

一部のソース(Congress.gov, GovInfo, Regulations.gov, FAC, NPPES, data.gov v4 カタログ)は共有 **api.data.gov** ゲートウェイを利用します。既定では公開 `DEMO_KEY` で **キーレス**動作(低い共有時間あたりクォータ)。`DATA_GOV_API_KEY` を設定すると上限が大幅に緩和されます。[api.data.gov/signup](https://api.data.gov/signup) で即時無料発行(待ちなし)。1 つのキーがすべての api.data.gov / api.gsa.gov ソースで通用します。BLS ソースも任意の無料 `BLS_API_KEY` で日次クォータを引き上げられます。

---

## ツールカタログ (116)

ワークフロー別グループ。キーレス優先 — 大半はキー不要、Census business-patterns と FRED は無料キーが必要。全 per-tool 一覧と入力 schema・誠実性 caveat の原文は [英語 README のカタログセクション](./README.md#tool-catalog-116-tools) を正とします。

- **案件 + ソリシテーション — SAM.gov + Grants.gov (10)**: `sam_search_opportunities` `sam_search_shaping` `sam_get_opportunity` `sam_fetch_description` `sam_fetch_attachment_text` `sam_attachment_url` `sam_lookup_organization` `sam_lookup_notice_fields` `grants_search` `grants_get_opportunity`
- **spending・受注・競合 — USAspending + FPDS + GAO (29)**: `usas_search_awards` `usas_search_individual_awards` `usas_get_award_detail` `usas_search_awards_by_recipient` `usas_search_subawards` `usas_search_recompetes` `usas_search_expiring_contracts`(deprecated) `usas_analyze_incumbent` `usas_search_teaming_partners` `usas_spending_over_time` `usas_search_agency_spending` `usas_search_subagency_spending` `usas_search_psc_spending` `usas_search_cfda_spending` `usas_search_state_spending` `usas_search_federal_account_spending` `usas_search_recipients` `usas_get_recipient_profile` `usas_get_agency_profile` `usas_get_agency_awards_summary` `usas_get_agency_budget_function` `usas_list_toptier_agencies` `usas_lookup_agency` `usas_autocomplete_naics` `usas_autocomplete_recipient` `usas_naics_hierarchy` `usas_glossary` `fpds_search_awards` `gao_protest_lookup`
- **パートナー・企業の検証 — OFAC · SAM · FAC · FDIC · EPA (14)**: `ofac_screen_entity` `sam_check_exclusions` `sam_integrity_lookup` `fac_search_audits` `fac_get_findings` `fdic_search_institutions` `fdic_institution_financials` `fdic_risk_ratios` `fdic_institution_history` `fdic_branch_deposits` `fdic_bank_failures` `fdic_industry_summary` `echo_search_facilities` `echo_facility_report`
- **財務開示 — SEC EDGAR (8)**: `edgar_lookup_cik` `edgar_company_filings` `edgar_company_facts` `edgar_company_concept` `edgar_xbrl_frames` `edgar_full_text_search` `edgar_filing_index` `edgar_daily_filing_index`
- **規制・立法 — Federal Register · Regulations.gov · eCFR · FAR · Congress · GovInfo (18)**: `fed_register_search_documents` `fed_register_get_document` `fed_register_public_inspection` `fed_register_list_agencies` `regulations_search_dockets` `regulations_search_documents` `regulations_search_comments` `regulations_get_docket` `ecfr_search` `ecfr_list_titles` `far_clause_lookup` `far_search` `far_compliance_matrix` `congress_search_bills` `congress_get_bill` `govinfo_search_packages` `govinfo_get_package` `govinfo_list_collections`
- **価格・労務・財政 — GSA CALC · SAM WD · BLS · Census CBP · FRED · Treasury · GSA per-diem (14)**: `gsa_benchmark_labor_rates` `sam_search_wage_determinations` `sam_get_wage_rates` `bls_timeseries` `bls_oews_wages` `bls_qcew` `treasury_debt_to_penny` `treasury_avg_interest_rates` `treasury_monthly_statement` `treasury_query_dataset` `census_business_patterns`(無料 CENSUS_API_KEY 必要) `fred_search_series`(無料 FRED_API_KEY 必要) `fred_series_observations`(無料 FRED_API_KEY 必要) `gsa_perdiem_rates`(DEMO_KEY キーレス)
- **医療・研究資金 — NIH · NSF · ClinicalTrials · CMS · NPPES (9)**: `nih_reporter_search_projects` `nsf_search_awards` `nsf_get_award` `clinicaltrials_search_studies` `clinicaltrials_get_study` `clinicaltrials_facet_counts` `cms_search_datasets` `cms_query_dataset` `nppes_lookup_provider`
- **サイバー遵守 — NVD + CISA KEV (2)**: `cve_lookup` `cisa_kev_lookup`
- **貿易・関税 — USITC (1)**: `hts_lookup`
- **地理・災害・州/市オープンデータ — Census · FEMA · Socrata · CKAN (8)**: `census_geocode_address` `census_geographies_by_coordinates` `fema_disaster_declarations` `fema_search_public_assistance` `socrata_discover_datasets` `socrata_query` `ckan_discover_datasets` `ckan_query`
- **データセット発見 — data.gov (1)**: `datagov_search_datasets`
- **中小企業 — SBA (1)**: `sba_size_standard`
- **サーバーユーティリティ — キー探索 (1)**: `api_key_status`(各ソースに必要なキー・required/optional・登録 URL・現在の設定有無を列挙; 値は表示しない)

---

## 信頼性 & オフラインスナップショット

本サーバーの原則は一つ: **もっともらしい捏造より誠実な失敗。** 以下はすべて公開データの*可用性*に関するものであり、いかなるアクセス制御も回避しません。

- **キーレス優先、ダウンしたソースは例外を*投げる*。** すべてのソースが API キーなしで動作します。ソースが rate-limit・ブロック・ダウンした場合、ツールは**型付きエラー**(`rate_limited` / `upstream_unavailable` / `schema_drift` …)を返し、行を捏造したりダウンしたサービスを「結果 0」/「見つからない」と報告しません。本物の空結果と障害は常に区別できます。
- **オフラインスナップショット (既定 on)。** ゆっくり変わる参照データ(toptier 機関一覧、上位 NAICS ツリー、USAspending 用語集、SBA 規模基準、最新 Treasury「Debt to the Penny」)は、ライブの連邦ソースが egress から一時的に到達不能なとき、サーバーが既定で `raw.githubusercontent.com/cliwant/mcp-sam-gov/snapshots` にホストされた**公開・週次更新スナップショット**へフォールバックします。ライブの**ハード障害**(障害 / IP 評判ブロック)時のみ取得し、通常運用中は決して取得しません — 公開データ、テレメトリなし。スナップショットが提供されるとき**決してライブとして表示しません** — 応答に `_meta.dataPath: "snapshot"` + `asOf` タイムスタンプが付き、`complete` は強制的に off。rate limit(429)は常に**尊重**し、ミラーへ回避しません。
- **無効化(純ライブ専用):** `SAMGOV_SNAPSHOT_BASE_URL=off` を設定するとスナップショット経路は追加されず、ライブ専用クライアントと byte-identical。
- **自前ミラーを指定:** `SAMGOV_SNAPSHOT_BASE_URL` を自分の base URL に設定すれば、公開既定値の代わりに自前ホスティング。
- **スナップショットのビルド:** ブロックされていないクリーンな egress(ノート PC / 自宅 / クリーンな CI)から `node scripts/build-snapshots.mjs` を実行。**ソース別到達性を自己診断**し、reachability 表 + `manifest.json` を出力します。部分カバレッジでは到達できるソースのみ更新し、残りは **last-good ファイルをそのまま残します**(古くても誠実、決して空にしない)。*すべての*ソースが到達不能なときのみ非ゼロ終了(egress 全面ブロックの合図 — よりクリーンな egress で再実行)。
- **誠実な境界。** これは**公開データの可用性のみ**を扱います。ビルダーは公開・再配布可能(public-domain / CC0)なデータのみ取り込み、リーダーは `accessLevel: "public"` でない封筒の提供を拒否します。**rate limit を尊重**(429 を回避しない)し、**プロキシ・IP ローテーション・認証/ペイウォール/CAPTCHA 回避なし**、off-host リダイレクトも拒否します。ブロックされた場合の誠実な解決策は、よりクリーンな egress からビルドすることであり、ブロックの回避ではありません。

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
