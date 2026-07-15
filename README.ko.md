# @cliwant/mcp-sam-gov

> **가장 포괄적인 keyless 연방 데이터 MCP 서버.**
> SAM.gov · USAspending · SEC EDGAR · OFAC · FDIC · Federal Register · Regulations.gov · eCFR · FAR/DFARS · BLS · Treasury · NIH · NSF · ClinicalTrials · CMS · NVD/CISA · USITC · Census · FRED · BEA · DOL · FEMA · openFDA · NHTSA · CPSC · EPA Envirofacts · CourtListener · IRS-990(ProPublica) 외 **44개 연방 데이터 소스, 134개 도구.** keyless 우선 — Census business-patterns · FRED · BEA · DOL 데이터 엔드포인트 4개 소스만 무료 키가 필요하고 나머지 40개 소스는 키가 필요 없습니다.
> API 키 / 등록 / 가입 불필요. Claude Desktop, Claude Code, Codex CLI, Cursor, Continue, Gemini CLI, 모든 MCP 호스트 호환.

[English README](./README.md) · [日本語 README](./README.ja.md)

> 이 문서는 [영문 README](./README.md) 의 미러입니다. 최신·상세 내용(호스트별 설정, 전체 도구 카탈로그 원문)은 영문을 기준으로 하세요.

---

## Claude (와 다른 AI 에이전트) 가 할 수 있는 것

| 영역 | 질문 예시 | 소스 |
|---|---|---|
| 🔍 **입찰 + 솔리시테이션** | "이번 달 마감되는 NAICS 541512 SAM.gov 입찰 — SOW·담당자·첨부까지" | SAM.gov, Grants.gov |
| 💰 **spending·수주·경쟁** | "VA 에서 Booz Allen 작년 수주, DoD PSC 카테고리 top 10" | USAspending, FPDS, GAO |
| 🕵️ **파트너·기업 검증** | "이 업체 스크리닝: OFAC 제재·SAM 배제·단일감사 지적·은행 건전성·EPA 준수+독성물질 배출" | OFAC, SAM, FAC, FDIC, EPA ECHO, EPA Envirofacts |
| 🛒 **제품 안전·리콜** | "이 공급업체 제품에 FDA/NHTSA/CPSC 리콜·집행 있나?" | openFDA, NHTSA, CPSC |
| ⚖️ **소송·법원** | "이 계약자 관련 연방청구법원 입찰 이의제기·연방순회항소법원 판례" | CourtListener (Free Law Project) |
| 🏢 **비영리 벤더** | "하청 전 이 비영리단체 IRS-990 재무 확인" | IRS 990 (ProPublica 경유) |
| 🏥 **의료 제공자·시설** | "이 provider Medicare 이용·지급, 병원 품질 등급, 취소 목록 여부" | CMS (data.cms.gov) |
| 📈 **재무 공시 (SEC)** | "이 상장사 매출 추이 + 최신 10-K" | SEC EDGAR |
| ⚖️ **규정·입법** | "이번 분기 VA 사이버보안 규정? 열려있는 Regulations.gov docket?" | Federal Register, Regulations.gov, eCFR, FAR/DFARS, Congress.gov, GovInfo |
| 💲 **가격·노무·재정** | "GSA CALC 노무 단가 밴드, 이 카운티 SCA 임금결정, CPI 에스컬레이션, 출장 per-diem 상한, 지역 산업별 GDP, DOL 임금·근로 집행 이력" | GSA CALC, SAM WD, BLS, US Census CBP, FRED, BEA, US Treasury, GSA per-diem, US DOL |
| 🏛 **로비·영향력** | "누가 VA 에 사이버보안으로 로비하나, 지출 규모는?" | US Senate LDA |
| 🏥 **보건·연구 자금** | "이 주제 NIH/NSF grant, 모집 중 임상시험, 이 의사에 대한 산업계 지급" | NIH RePORTER, NSF, ClinicalTrials, CMS, NPPES |
| 🛡 **사이버 준수** | "이 CVE 가 CISA KEV 필수 패치 목록에 있나?" | NVD, CISA KEV |
| 🌐 **무역·지리·재난** | "이 품목 HTS 관세, 이 주소 Census tract, 이 주의 FEMA 선포" | USITC HTS, Census, FEMA, Socrata, CKAN |
| 🎓 **grant·데이터셋** | "최근 30일 사이버보안 grant, 연방 오픈 데이터셋 발굴" | Grants.gov, data.gov |

**44개 연방 데이터 소스, 총 134개 도구 — keyless 우선: Census business-patterns · FRED · BEA · DOL 데이터 엔드포인트 4개 소스만 무료 키가 필요하고 나머지 40개 소스는 키가 필요 없습니다.** (초기 52-도구 빌드 기준 대략 p50 ~0.25s / p95 ~0.8s 측정 — 소스·업스트림 부하에 따라 변동하는 근사치이며 보장값이 아님.)

---

## 어떻게 설치하나? 본인에 맞는 경로 고르세요.

### 🟢 경로 1 — Claude Desktop 원클릭 (터미널 불필요)

비개발자 추천. 파일 하나 다운로드 → 더블클릭.

1. [최신 release](https://github.com/cliwant/mcp-sam-gov/releases/latest) 에서 **`mcp-sam-gov.mcpb`** 다운로드.
2. 파일 더블클릭. Claude Desktop 에서 "Install Extension" 다이얼로그 나타남.
3. **Install** 클릭.
4. 끝. 새 대화 열고 "Find active SAM.gov opportunities under NAICS 541512" 물어보기.

PowerShell, npm 등 필요 없음.

> Claude Desktop ≥ 1.0 필요 (자체 Node.js 런타임 포함).

### 🟡 경로 2 — Claude Code 한 줄

이미 Claude Code (CLI) 사용 중이라면:

```bash
/plugin install cliwant/mcp-sam-gov
```

MCP 서버 + Claude 가 134개 도구를 언제 / 어떻게 호출할지 가르치는 [SKILL.md 워크플로 가이드](./skills/sam-gov/SKILL.md) 동시 등록.

### 🔵 경로 3 — Codex / Cursor / Continue / Gemini 등 수동 설치

```bash
gh repo clone cliwant/mcp-sam-gov
cd mcp-sam-gov
npm install --omit=dev
npm install -g .
```

설치 후 `mcp-sam-gov` 가 PATH 등록됨. 호스트 config 에 추가:

```json
{
  "mcpServers": {
    "sam-gov": { "command": "mcp-sam-gov" }
  }
}
```

각 호스트별 config 위치는 [호스트별 설정](#host-configurations) 참조 (영문 README).

### ⚪ 경로 4 — 직접 경로 (글로벌 설치 없음)

```bash
gh repo clone cliwant/mcp-sam-gov
cd mcp-sam-gov
npm install --omit=dev
```

호스트 config 에 절대 경로:

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

## 어떤 질문 가능한가?

자연어로 질문하면 AI 가 알맞은 도구 시퀀스 자동 호출.

**입찰 발굴**
- "NAICS 541512 의 메릴랜드 입찰 중 30일 안에 마감되는 것"
- "'computer systems design' 의 표준 NAICS 코드?"

**RFP 분석**
- "noticeId 5ef3db5daeb54099a96d487783a38bd0 — SOW, 담당자, 첨부 다 보여줘"
- "그 공고의 전체 RFP 본문"

**경쟁 환경**
- "VA 의 NAICS 541519 작년 top 5 수주"
- "Booz Allen 의 DISA 수주 contract 개별"
- "Leidos 의 VA contract 의 sub-contractor 누구?"
- "USAspending 에서 'CMS' 정식 명칭?"

**트렌드 + 집계**
- "VA 541512 spending 5년 추이"
- "541512 spending top 10 주"
- "DoD 의 PSC 카테고리 top spending"
- "사이버보안 관련 grant 프로그램 by total $"

**기관 인텔리전스 (capture brief)**
- "VA 의 capture brief: mission, FY26 예산 분해, top 하위 기관"
- "VA FY25 transaction 볼륨"

**Recompete 레이더**
- "VA 541512 의 12개월 안에 expiring contract over $1M"
- "award CONT_AWD_... 의 period of performance"

**규정**
- "SDVOSB 가산점 관련 FAR 섹션"
- "이번 분기 VA 사이버보안 새 규정"
- "Federal Register doc 2026-08333 citation"

**Grant**
- "최근 30일 사이버보안 grant"
- "grant id 361238 상세"

---

## 선택 — 더 높은 rate limit + archive

기본 keyless. SAM.gov 의 rate limit 상향 + 12개월 이전 archive 가 필요하면 호스트 env 에 SAM.gov 키 추가:

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

무료 키: [sam.gov/SAM/pages/public/searchKeyData.jsf](https://sam.gov/SAM/pages/public/searchKeyData.jsf). AI 는 알 필요 없음 — 자동 우회.

### `DATA_GOV_API_KEY` — api.data.gov / api.gsa.gov 계열

일부 소스(Congress.gov, GovInfo, Regulations.gov, FAC, NPPES, data.gov v4 카탈로그)는 공유 **api.data.gov** 게이트웨이를 사용합니다. 기본은 공개 `DEMO_KEY` 로 **keyless** 동작(낮은 공유 시간당 쿼터). `DATA_GOV_API_KEY` 를 설정하면 한도가 크게 상향됩니다. [api.data.gov/signup](https://api.data.gov/signup) 에서 즉시 무료 발급(대기 없음). 하나의 키가 모든 api.data.gov / api.gsa.gov 소스에 통용됩니다. BLS 소스도 선택적 무료 `BLS_API_KEY` 로 일일 쿼터를 올릴 수 있습니다.

키가 *필수*인 소스는 4개뿐입니다 — **Census**(`census_business_patterns`), **FRED**(2개 FRED 도구), **BEA**(`bea_regional_data`), **DOL 데이터 엔드포인트**(`dol_get_dataset`; 카탈로그 `dol_list_datasets` 는 keyless). 모두 무료이며, 전체 키 인벤토리(필수/선택·발급 URL)는 [영문 README 의 키 섹션](./README.md#keys--higher-limits--the-full-inventory)을 기준으로 하세요.

---

## 도구 카탈로그 (134개)

워크플로별 그룹. keyless 우선 — 대부분 키가 필요 없고, Census business-patterns · FRED · BEA · DOL 데이터 엔드포인트는 무료 키가 필요합니다. 전체 per-tool 목록과 입력 schema·정직성 caveat 원문은 [영문 README 의 카탈로그 섹션](./README.md#tool-catalog-134-tools)을 기준으로 하세요.

- **입찰 + 솔리시테이션 — SAM.gov + Grants.gov (10)**: `sam_search_opportunities` `sam_search_shaping` `sam_get_opportunity` `sam_fetch_description` `sam_fetch_attachment_text` `sam_attachment_url` `sam_lookup_organization` `sam_lookup_notice_fields` `grants_search` `grants_get_opportunity`
- **spending·수주·경쟁 — USAspending + FPDS + GAO (29)**: `usas_search_awards` `usas_search_individual_awards` `usas_get_award_detail` `usas_search_awards_by_recipient` `usas_search_subawards` `usas_search_recompetes` `usas_search_expiring_contracts`(deprecated) `usas_analyze_incumbent` `usas_search_teaming_partners` `usas_spending_over_time` `usas_search_agency_spending` `usas_search_subagency_spending` `usas_search_psc_spending` `usas_search_cfda_spending` `usas_search_state_spending` `usas_search_federal_account_spending` `usas_search_recipients` `usas_get_recipient_profile` `usas_get_agency_profile` `usas_get_agency_awards_summary` `usas_get_agency_budget_function` `usas_list_toptier_agencies` `usas_lookup_agency` `usas_autocomplete_naics` `usas_autocomplete_recipient` `usas_naics_hierarchy` `usas_glossary` `fpds_search_awards` `gao_protest_lookup`
- **파트너·기업 검증 — OFAC · SAM · FAC · FDIC · EPA (15)**: `ofac_screen_entity` `sam_check_exclusions` `sam_integrity_lookup` `fac_search_audits` `fac_get_findings` `fdic_search_institutions` `fdic_institution_financials` `fdic_risk_ratios` `fdic_institution_history` `fdic_branch_deposits` `fdic_bank_failures` `fdic_industry_summary` `echo_search_facilities` `echo_facility_report` `epa_tri_facilities`(EPA Envirofacts TRI 독성물질 배출 시설 — 환경/ESG 검증)
- **제품 안전·리콜 — openFDA · NHTSA · CPSC (5)**: `openfda_enforcement`(FDA 의약품·의료기기·식품 리콜·집행) `openfda_device_clearances`(FDA 510(k) 의료기기 승인) `nhtsa_recalls`(NHTSA 차량 리콜) `nhtsa_complaints`(NHTSA 차량 안전 불만) `cpsc_recalls`(CPSC 소비자 제품 리콜)
- **소송·법원 — CourtListener (1)**: `courtlistener_search_opinions`(미 연방 법원 판례 — 연방청구법원 계약 청구/입찰 이의, 연방순회항소법원; CourtListener/Free Law Project 경유, 명시)
- **비영리 벤더 — IRS 990 via ProPublica (2)**: `nonprofit_search`(IRS-990 비영리 검색 by 이름/주/NTEE) `nonprofit_financials`(IRS-990 비영리 재무 by EIN) — ProPublica Nonprofit Explorer 경유(명시)
- **재무 공시 — SEC EDGAR (8)**: `edgar_lookup_cik` `edgar_company_filings` `edgar_company_facts` `edgar_company_concept` `edgar_xbrl_frames` `edgar_full_text_search` `edgar_filing_index` `edgar_daily_filing_index`
- **규정·입법 — Federal Register · Regulations.gov · eCFR · FAR · Congress · GovInfo (18)**: `fed_register_search_documents` `fed_register_get_document` `fed_register_public_inspection` `fed_register_list_agencies` `regulations_search_dockets` `regulations_search_documents` `regulations_search_comments` `regulations_get_docket` `ecfr_search` `ecfr_list_titles` `far_clause_lookup` `far_search` `far_compliance_matrix` `congress_search_bills` `congress_get_bill` `govinfo_search_packages` `govinfo_get_package` `govinfo_list_collections`
- **가격·노무·재정 — GSA CALC · SAM WD · BLS · Census CBP · FRED · BEA · Treasury · GSA per-diem (15)**: `gsa_benchmark_labor_rates` `sam_search_wage_determinations` `sam_get_wage_rates` `bls_timeseries` `bls_oews_wages` `bls_qcew` `treasury_debt_to_penny` `treasury_avg_interest_rates` `treasury_monthly_statement` `treasury_query_dataset` `bea_regional_data`(무료 BEA_API_KEY 필요) `census_business_patterns`(무료 CENSUS_API_KEY 필요) `fred_search_series`(무료 FRED_API_KEY 필요) `fred_series_observations`(무료 FRED_API_KEY 필요) `gsa_perdiem_rates`(DEMO_KEY keyless)
- **보건·연구 자금 — NIH · NSF · ClinicalTrials · CMS · NPPES (9)**: `nih_reporter_search_projects` `nsf_search_awards` `nsf_get_award` `clinicaltrials_search_studies` `clinicaltrials_get_study` `clinicaltrials_facet_counts` `cms_search_datasets` `cms_query_dataset` `nppes_lookup_provider`
- **의료 제공자·시설 — CMS (5)**: `cms_medicare_provider_services`(Medicare provider 이용·지급 — 의료 시장규모) `cms_hospital_compare`(CMS 병원 품질 등급) `cms_facility_directory`(요양원/재택의료/호스피스/투석 시설 디렉터리) `cms_dmepos_suppliers`(DMEPOS 의료기기 공급자 디렉터리 + Medicare 지출) `cms_revoked_providers`(Medicare 취소/배제 목록 — 준수 검증)
- **사이버 준수 — NVD + CISA KEV (2)**: `cve_lookup` `cisa_kev_lookup`
- **무역·관세 — USITC (1)**: `hts_lookup`
- **지리·재난·주/시 오픈데이터 — Census · FEMA · Socrata · CKAN (8)**: `census_geocode_address` `census_geographies_by_coordinates` `fema_disaster_declarations` `fema_search_public_assistance` `socrata_discover_datasets` `socrata_query` `ckan_discover_datasets` `ckan_query`
- **데이터셋 발굴 — data.gov (1)**: `datagov_search_datasets`
- **소상공인 — SBA (1)**: `sba_size_standard`
- **노무 준수 — US DOL (2)**: `dol_list_datasets`(DOL 집행·준수 데이터셋 카탈로그 탐색 — WHD, OFCCP 등, keyless) `dol_get_dataset`(DOL 집행 기록 조회 — WHD 임금·근로 / OFCCP; 무료 DOL_API_KEY 필요)
- **로비·영향력 — US Senate LDA (1)**: `lda_search_filings`(상원 로비 신고: 누가 어느 기관에, 어떤 이슈로, 얼마를 쓰는지; keyless)
- **서버 유틸리티 — 키 발견 (1)**: `api_key_status`(각 소스에 필요한 키·required/optional·발급 URL·현재 설정 여부 나열; 값은 노출 안 함)

---

## 신뢰성 & 오프라인 스냅샷

이 서버의 원칙은 하나입니다: **그럴듯한 조작보다 정직한 실패.** 아래는 모두 공개 데이터의 *가용성*에 관한 것이며, 어떤 접근 통제도 우회하지 않습니다.

- **Keyless 우선, 다운된 소스는 예외를 *던진다*.** 모든 소스가 API 키 없이 동작합니다. 소스가 rate-limit·차단·다운되면 도구는 **타입이 지정된 에러**(`rate_limited` / `upstream_unavailable` / `schema_drift` …)를 반환하며, 행을 지어내거나 다운된 서비스를 "결과 0" / "없음"으로 보고하지 않습니다. 진짜 빈 결과와 장애는 항상 구별됩니다.
- **오프라인 스냅샷 (기본 on).** 느리게 바뀌는 참조 데이터(toptier 기관 목록, 상위 NAICS 트리, USAspending 용어집, SBA 규모 기준, 최신 Treasury "Debt to the Penny")는, 라이브 연방 소스가 egress 에서 잠시 도달 불가일 때 서버가 기본적으로 `raw.githubusercontent.com/cliwant/mcp-sam-gov/snapshots` 에 호스팅된 **공개·주간 갱신 스냅샷**으로 폴백합니다. 라이브 **하드 실패**(장애 / IP 평판 차단) 시에만 가져오며 평상시엔 절대 아닙니다 — 공개 데이터, 텔레메트리 없음. 스냅샷이 서빙되면 **절대 라이브처럼 표시하지 않습니다** — 응답에 `_meta.dataPath: "snapshot"` + `asOf` 타임스탬프가 붙고 `complete` 는 강제로 꺼집니다. rate limit(429)은 항상 **준수**하며 미러로 우회하지 않습니다.
- **끄기(순수 라이브 전용):** `SAMGOV_SNAPSHOT_BASE_URL=off` 설정 시 스냅샷 경로가 추가되지 않고 라이브 전용 클라이언트와 byte-identical.
- **자체 미러 지정:** `SAMGOV_SNAPSHOT_BASE_URL` 을 자신의 base URL 로 설정하면 공개 기본값 대신 직접 호스팅.
- **스냅샷 빌드:** 차단되지 않은 깨끗한 egress(노트북 / 집 / 깨끗한 CI)에서 `node scripts/build-snapshots.mjs` 실행. **소스별 도달성을 자가 진단**하고 reachability 표 + `manifest.json` 을 출력합니다. 부분 커버리지에서는 도달 가능한 소스만 갱신하고 나머지는 **last-good 파일을 그대로 둡니다**(오래됐어도 정직, 절대 비우지 않음). *모든* 소스가 도달 불가일 때만 non-zero 종료(egress 전면 차단 신호 — 더 깨끗한 egress 에서 재실행).
- **정직한 경계.** 이것은 **공개-데이터 가용성만** 다룹니다. 빌더는 공개·재배포 가능(public-domain / CC0) 데이터만 수집하고, 리더는 `accessLevel: "public"` 이 아닌 봉투는 서빙을 거부합니다. **rate limit 을 준수**(429 를 우회하지 않음)하고 **프록시·IP 로테이션·인증/페이월/CAPTCHA 우회 없음**, off-host 리다이렉트도 거부합니다. 차단되면 정직한 해법은 더 깨끗한 egress 에서 빌드하는 것이지 차단을 회피하는 것이 아닙니다.

---

## 트러블슈팅

| 증상 | 해결 |
|---|---|
| Claude Desktop 🔨 메뉴에 `sam-gov` 안 보임 | Claude Desktop 완전 종료 (Windows: 시스템 트레이 / macOS: Quit) 후 재실행. 로그: `%APPDATA%\Claude\logs\mcp*.log` |
| `command not found: mcp-sam-gov` | `npm install -g .` 성공했나 확인. `npm config get prefix` 결과가 PATH 에 있나 확인 |
| `MODULE_NOT_FOUND ...dist/server.js` (Windows) | npm 의 git-dep + symlink 버그. 경로 3 (clone + `npm install -g .`) 사용 |
| `EPERM: operation not permitted` | `rmdir /s /q "%APPDATA%\npm\node_modules\@cliwant"` (또는 초기 버전 설치 경험이 있다면 `@govicon"`) 후 재시도 |
| 도구 결과 비어있음 | SAM.gov rate limit. 1분 대기 후 재시도 또는 `SAM_GOV_API_KEY` 설정 |

---

## 라이선스

MIT — [LICENSE](./LICENSE).

## 면책 조항

이 서버는 **공개된** federal API endpoint 만 사용합니다. 미국 GSA, SAM.gov, USAspending.gov, Office of the Federal Register, National Archives, Grants.gov 또는 연방 기관과 무관합니다. 연방 조달 / spending / 규정 데이터는 public domain.
