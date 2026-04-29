# @cliwant/mcp-sam-gov

> **가장 포괄적인 keyless 연방 데이터 MCP 서버.**
> SAM.gov + USAspending + Federal Register + eCFR + Grants.gov 36개 도구.
> API 키 / 등록 / 가입 불필요. Claude Desktop, Claude Code, Codex CLI, Cursor, Continue, Gemini CLI, 모든 MCP 호스트 호환.

[English README](./README.md) · [日本語 README](./README.ja.md)

---

## Claude (와 다른 AI 에이전트) 가 할 수 있는 것

| 영역 | 질문 예시 | 도구 수 |
|---|---|---|
| 🔍 **활성 입찰** | "이번 달 마감되는 NAICS 541512 SAM.gov 입찰 찾아줘" | SAM.gov 5개 |
| 💰 **수주 + 수주자** | "VA 에서 Booz Allen 의 작년 수주 내역" | USAspending 8개 |
| 📊 **집계 분석** | "DoD 의 FY26 PSC 카테고리 top 10" | USAspending 6개 |
| 🏛 **기관 프로필** | "VA 의 미션? FY25 예산 분해?" | USAspending 3개 |
| 🏢 **수주자 프로필** | "Booz Allen 전체 프로필 + 별칭" | USAspending 2개 |
| 🧠 **환각 방지** | NAICS / 수주자 / 기관 autocomplete + 용어집 | USAspending 5개 |
| 📜 **Federal Register** | "이번 분기 VA 사이버보안 새 규정?" | 3개 |
| ⚖️ **규정 (FAR/CFR)** | "SDVOSB 가산점 관련 FAR 조항 찾아줘" | eCFR 2개 |
| 🎓 **연방 보조금** | "최근 30일 사이버보안 grant" | Grants.gov 2개 |

**총 36개 도구. API 키 0개. p50 257ms, p95 766ms** (실제 federal API 벤치마크).

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

MCP 서버 + Claude 가 36개 도구를 언제 / 어떻게 호출할지 가르치는 [SKILL.md 워크플로 가이드](./skills/sam-gov/SKILL.md) 동시 등록.

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

---

## 36개 도구 카탈로그

전체 도구 목록 + 입력 schema 는 영문 README 의 collapsible 섹션 참조: https://github.com/cliwant/mcp-sam-gov#tool-catalog-36-tools

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
