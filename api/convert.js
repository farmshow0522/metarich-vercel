// 메타리치 PDF 변환기 — Vercel 서버리스 함수 (최대 60초)
// Claude API 키는 서버(이 파일)에만 존재 → 사이트 방문자에게 노출되지 않는다.

const MODEL = "claude-sonnet-4-6"; // 품질(Sonnet) + thinking off/effort low 로 속도 확보
const LIMITS = { maxBytes: 3 * 1048576, maxPages: 25, maxTokensOut: 6000 }; // Vercel 요청 본문 4.5MB 한도 → 3MB로 제한

// ▼▼▼ Claude API 키 — Vercel 환경변수(ANTHROPIC_API_KEY)에서만 읽는다 (소스에 키를 남기지 않음) ▼▼▼
// 설정: Vercel 프로젝트 → Settings → Environment Variables → ANTHROPIC_API_KEY 추가 후 재배포
const HARDCODED_KEY = process.env.ANTHROPIC_API_KEY;
// ▲▲▲ 키를 바꾸려면 소스가 아니라 Vercel 환경변수 값을 교체 후 재배포 ▲▲▲

const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["customer", "summary", "diagnosis", "contracts", "plan"],
  properties: {
    customer: { type: "object", additionalProperties: false, required: ["name", "analysisDate", "company", "org", "contact"],
      properties: { name: { type: "string" }, analysisDate: { type: "string" }, company: { type: "string" }, org: { type: "string" }, contact: { type: "string" } } },
    summary: { type: "object", additionalProperties: false, required: ["sufficient", "insufficient", "none", "monthlyPremium", "totalPremium", "paidRate", "remainingPremium", "text"],
      properties: { sufficient: { type: "integer" }, insufficient: { type: "integer" }, none: { type: "integer" }, monthlyPremium: { type: "string" }, totalPremium: { type: "string" }, paidRate: { type: "string" }, remainingPremium: { type: "string" }, text: { type: "string" } } },
    diagnosis: { type: "array", items: { type: "object", additionalProperties: false, required: ["group", "note", "rows"],
      properties: { group: { type: "string" }, note: { type: "string" }, rows: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "standard", "current", "status"],
        properties: { name: { type: "string" }, standard: { type: "string" }, current: { type: "string" }, status: { type: "string", enum: ["충분", "부족", "미가입", "초과", "충족"] } } } } } } },
    contracts: { type: "object", additionalProperties: false, required: ["rows", "totalMonthly", "note"],
      properties: { rows: { type: "array", items: { type: "object", additionalProperties: false, required: ["company", "product", "contractDate", "maturity", "payTerm", "monthly"],
        properties: { company: { type: "string" }, product: { type: "string" }, contractDate: { type: "string" }, maturity: { type: "string" }, payTerm: { type: "string" }, monthly: { type: "string" } } } }, totalMonthly: { type: "string" }, note: { type: "string" } } },
    plan: { type: "object", additionalProperties: false, required: ["p1", "p2", "p3", "nextSteps"],
      properties: { p1: { type: "array", items: { type: "string" } }, p2: { type: "array", items: { type: "string" } }, p3: { type: "array", items: { type: "string" } }, nextSteps: { type: "string" } } }
  }
};

const SYSTEM = `너는 보험 보장분석 원본 PDF를 구조화 데이터로 추출하는 분석기다. 첨부된 PDF를 읽고 emit_analysis 도구를 호출해 값을 채워라.
원칙:
- 원본에 없는 수치·회사·상품명을 절대 지어내지 마라. 불명확하면 "-" 또는 "확인필요".
- 개인정보가 마스킹돼 있으면 그대로 두고 name은 "고객님".
- 금액은 원본 표기 유지(천단위 콤마), 진단표 수치는 만원 단위 숫자.
- status: 가입금액이 표준 이상이면 "충분"(초과 시 "초과"), 미만이면 "부족", 0/미가입이면 "미가입".
- diagnosis는 보통 5영역: 사망·후유장해 / 암·뇌혈관·심장 / 의료·수술·입원 / 요양·치매 / 운전자·생활. 원본 구조에 맞게 조정.
- summary.text, plan.nextSteps, note는 한국어 한두 문장.
- plan.p1=미가입/최우선, p2=부족 보완, p3=생활·구조조정 (각 3~5개).`;

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST 요청만 허용됩니다." }); return; }

  const key = HARDCODED_KEY;
  if (!key) { res.status(500).json({ error: "서버에 API 키가 설정되지 않았습니다." }); return; }

  let pdfBase64;
  if (req.body && typeof req.body === "object") pdfBase64 = req.body.pdfBase64;
  else if (typeof req.body === "string") { try { pdfBase64 = JSON.parse(req.body).pdfBase64; } catch (_) {} }
  if (!pdfBase64) { res.status(400).json({ error: "PDF 데이터가 없습니다." }); return; }

  const buf = Buffer.from(pdfBase64, "base64");
  if (buf.length > LIMITS.maxBytes) { res.status(413).json({ error: `파일이 너무 큽니다 (${(buf.length / 1048576).toFixed(1)}MB). 최대 ${(LIMITS.maxBytes / 1048576)}MB까지만 변환합니다.` }); return; }
  const s = buf.toString("latin1");
  let pages = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const m = s.match(/\/Count\s+(\d+)/);
  if (m) pages = Math.max(pages, parseInt(m[1], 10));
  if (pages > LIMITS.maxPages) { res.status(413).json({ error: `페이지가 너무 많습니다 (약 ${pages}p). 최대 ${LIMITS.maxPages}p까지만 변환합니다.` }); return; }

  const body = {
    model: MODEL, max_tokens: LIMITS.maxTokensOut,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    tools: [{ name: "emit_analysis", description: "추출한 보장분석 데이터를 반환", input_schema: SCHEMA }],
    tool_choice: { type: "tool", name: "emit_analysis" },
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
      { type: "text", text: "이 보장분석 원본에서 데이터를 추출해 emit_analysis 도구로 반환해줘." }
    ] }]
  };

  let r, data;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body)
    });
    data = await r.json();
  } catch (e) { res.status(502).json({ error: "Claude API 연결 실패: " + e.message }); return; }

  if (!r.ok) { res.status(r.status).json({ error: (data && data.error && data.error.message) || ("API 오류 " + r.status) }); return; }
  const tu = (data.content || []).find(b => b.type === "tool_use");
  if (!tu) { res.status(502).json({ error: "추출 결과를 받지 못했습니다." }); return; }

  res.status(200).json({ data: tu.input, usage: data.usage || {} });
};
