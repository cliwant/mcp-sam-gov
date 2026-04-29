# @govicon/mcp-sam-gov

> SAM.gov + USAspending 용 **Model Context Protocol** 서버.
> Claude Desktop, Claude Code, Codex CLI, Cursor, Continue, Gemini CLI — MCP 지원 호스트라면 어디든 바로 연결.

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

## 설치 (private repo 단계)

```bash
# gh auth login 필요 (private repo clone 권한)
npm install -g github:seungdo-keum/govicon-mcp-sam-gov

# 설치 후 PATH 에 등록됨
govicon-mcp-sam-gov
```

또는 클론해서 직접:

```bash
gh repo clone seungdo-keum/govicon-mcp-sam-gov
cd govicon-mcp-sam-gov
npm install   # dist/ 자동 빌드
node dist/server.js
```

npm 공개 후에는:

```bash
npx -y @govicon/mcp-sam-gov
```

---

## AI 호스트별 연결 방법

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
