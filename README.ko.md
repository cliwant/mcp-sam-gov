# @govicon/mcp-sam-gov

> SAM.gov + USAspending 용 **MCP 서버 + Claude Skill**.
> 한 레포에 두 가지 배포 형식:
>
> 1. **MCP 서버** (범용) — Claude Desktop, Claude Code, Codex CLI, Cursor, Continue, Gemini CLI 모두 지원
> 2. **Claude Code Plugin / Skill** (Claude Code 전용) — `/plugin install` 한 번으로 MCP 서버 + 워크플로 가이드 skill 자동 등록

[English README](./README.md) · [日本語 README](./README.ja.md)

## 제공하는 것

AI 에이전트가 대화 중 직접 호출할 수 있는 8개 도구:

| 도구 | 용도 |
|---|---|
| `sam_search_opportunities` | SAM.gov 입찰 공고 검색 (키 없음) |
| `sam_get_opportunity` | noticeId 로 단일 공고 상세 조회 (POC, 마감일, 첨부, 본문) |
| `sam_fetch_description` | RFP 본문을 plain text 로 |
| `sam_attachment_url` | 첨부파일 public 다운로드 URL 생성 |
| `usas_search_awards` | USAspending — agency × NAICS 별 share-of-wallet |
| `usas_search_individual_awards` | USAspending — 개별 contract 라인 |
| `usas_search_subagency_spending` | USAspending — 구매 office 별 분해 |
| `usas_lookup_agency` | "VA" → "Department of Veterans Affairs" 정식명 변환 |

**인증:** 불필요. SAM.gov public + USAspending v2 모두 키리스. `SAM_GOV_API_KEY` 환경 변수를 주면 rate limit 상향 + 12개월 이전 archive 도 사용 가능 (선택).

---

## 두 가지 설치 흐름

| 흐름 | 사용 시점 | 형식 |
|---|---|---|
| **A. MCP 서버** | Claude Desktop, Codex CLI, Cursor, Continue, Gemini CLI 등 Claude Code 외 호스트 | npm 패키지 + 호스트 config 수동 설정 |
| **B. Claude Plugin** | Claude Code (CLI) | `/plugin install` 한 번 — MCP 서버 + SKILL.md 워크플로 가이드 동시 등록 |

흐름 A 는 모든 호스트에서 동작. 흐름 B 는 Claude Code 전용 superset (같은 MCP 서버 + skill 추가).

---

## 흐름 A — MCP 서버 (모든 호스트)


`npm install -g github:...` 직접 설치는 **Windows에서 깨집니다** — npm 의 git-dep
+ symlink 처리 버그 때문에 dist 파일이 추출되지 않습니다. 모든 OS 에서 동일하게
동작하는 **clone + local global-install** 을 권장합니다.

### 권장 — clone + 글로벌 설치 (Windows / macOS / Linux 동일)

```bash
# gh auth login 필요 (private repo clone 권한)
gh repo clone seungdo-keum/govicon-mcp-sam-gov
cd govicon-mcp-sam-gov
npm install --omit=dev   # 런타임 deps 만 — dist/ 는 git 에 미리 빌드되어 있음
npm install -g .         # `govicon-mcp-sam-gov` 가 PATH 에 등록됨

govicon-mcp-sam-gov   # stdio MCP 서버
```

### 대안 — 글로벌 설치 없이 직접 경로

`npm install -g .` 단계를 건너뛰고 host config 에서 절대 경로 사용:

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

### npm 공개 후

```bash
npx -y @govicon/mcp-sam-gov
```

---

## 흐름 B — Claude Code 플러그인 (MCP 서버 + Skill 워크플로 가이드)

**Claude Code (CLI)** 사용자는 plugin 시스템으로 MCP 서버 + [SKILL.md 워크플로 가이드](./skills/sam-gov/SKILL.md) 를 한 번에 받습니다. Skill 은 Claude 가 8개 도구를 언제 어떻게 사용할지 (opportunity discovery, recompete radar, teaming map 등 4개 표준 워크플로 + 환각 방지 가드) 가르칩니다.

### `/plugin` 으로 설치

Claude Code 세션에서:

```
/plugin install seungdo-keum/govicon-mcp-sam-gov
```

이 한 줄이:
1. Claude plugin 디렉토리에 repo clone
2. `.claude-plugin/plugin.json` 으로 plugin 등록
3. `.mcp.json` 으로 `sam-gov` MCP 서버 등록 (전역 `govicon-mcp-sam-gov` 바이너리 사용 — 흐름 A 를 먼저 실행해 PATH 등록 필요. 또는 `.mcp.json` 의 command 를 `node` + 절대경로로 직접 수정)
4. `skills/sam-gov/SKILL.md` 로드 → 자연어 질문 ("SAM.gov 입찰 찾아줘" 등) 에 자동 트리거

### Plugin 으로 얻는 것 (MCP 단독 대비)

| 기능 | 흐름 A (MCP 만) | 흐름 B (Plugin) |
|---|---|---|
| 8개 도구 | ✅ | ✅ |
| 워크플로 가이드 ("어떤 도구를 언제 호출?") | ❌ | ✅ — 4개 명명된 워크플로 |
| 자연어 자동 트리거 | 호스트 따라 | ✅ — skill description 으로 튜닝 |
| 환각 방지 가드 ("noticeId 절대 추측 금지") | ❌ | ✅ — skill body 에 명시 |
| 다단계 playbook (recompete radar, teaming map) | ❌ | ✅ |
| Claude Desktop / Codex / Cursor / Gemini 호환 | ✅ | ❌ Claude Code 전용 |

Claude Code 외 호스트는 흐름 A 만 사용.

---

## AI 호스트별 연결 방법 (흐름 A)

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) 또는
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "sam-gov": {
      "command": "govicon-mcp-sam-gov"
    }
  }
}
```

API 키 사용 시:

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

Claude Desktop 재시작 → 8개 도구가 🔨 메뉴에 노출.

### Claude Code

프로젝트 루트의 `.mcp.json`:

```json
{
  "mcpServers": {
    "sam-gov": { "command": "govicon-mcp-sam-gov" }
  }
}
```

또는 CLI:

```bash
claude mcp add sam-gov govicon-mcp-sam-gov
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.sam-gov]
command = "govicon-mcp-sam-gov"
args = []
```

### Cursor

설정 → MCP → 새 서버 추가:

```json
{
  "mcpServers": {
    "sam-gov": { "command": "govicon-mcp-sam-gov" }
  }
}
```

### Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "sam-gov": { "command": "govicon-mcp-sam-gov" }
  }
}
```

stdio MCP 를 지원하는 다른 호스트라면 `govicon-mcp-sam-gov` 바이너리만 가리키면 됩니다.

---

## 활용 예

연결되면 어시스턴트가 다음과 같은 질문에 자동으로 도구를 호출해 답합니다:

- "NAICS 541512 의 메릴랜드 입찰 중 30일 안에 마감되는 것 찾아줘"
- "noticeId 5ef3db5daeb54099a96d487783a38bd0 — SOW, 담당자, 첨부 다 보여줘"
- "VA 의 NAICS 541519 작년 top 5 수주 업체"
- "Booz Allen 의 DISA 수주 contract 개별 항목"
- "USAspending 에서 'CMS' 의 정식 명칭은?"

도구 시퀀스는 자동 결정됩니다 — 별도 prompt engineering 불필요.

---

## 라이선스

MIT — [LICENSE](./LICENSE).

## 면책 조항

이 서버는 **공개된** SAM.gov + USAspending 엔드포인트만 사용합니다. 미국 GSA, SAM.gov,
USAspending.gov 또는 연방 기관과 무관합니다. 연방 조달 데이터는 public domain.
