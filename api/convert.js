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
      properties: { name: { type: "string", description: "고객명. 원본 마스킹형(예: 김*섭)을 살려 '김*섭 고객님'. 전혀 알 수 없을 때만 '고객님'" }, analysisDate: { type: "string", description: "원본 분석일자" }, company: { type: "string", description: "주 계약 보험사명" }, org: { type: "string", description: "담당 설계사(LP) 정보를 '이름(소속/회사)' 형태로. 예: 김광섭(제주센트럴/(주)메타리치)" }, contact: { type: "string", description: "담당 설계사 연락처 전화번호(보험사 대표번호 아님)" } } },
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
- customer.name(고객명): 원본 마스킹 이름의 성(첫 글자)은 반드시 살리고 형태를 유지해 "김*섭 고객님"처럼 반환한다. 이름 전체를 "*"나 "＊ 고객님"으로만 만들지 마라. 전혀 알 수 없을 때만 "고객님".
- customer.org(소속): 원본 상단의 'LP'(담당 설계사) 항목을 "이름(소속/회사)" 형태로 넣는다. 예: "김광섭(제주센트럴/(주)메타리치)". 'LP' 항목이 없으면 '소속' 값을 사용.
- customer.contact(연락처): 원본 상단 '연락처'의 담당 설계사 전화번호. (보험사 고객센터·대표번호가 아님)
- customer.analysisDate는 원본 '분석일자', customer.company는 주 계약 보험사명.
- contracts.rows의 company(회사명)·product(상품명)는 '정상계약(가입계약) 리스트' 페이지에서 실제 표기된 값을 정확히 추출하라. 상품코드(예: 2604, Hi1308)만 보고 상품명을 지어내지 말고, 원문의 보험사명(예: 한화손해보험, 현대해상)과 상품명을 그대로 쓴다. 정말 불명확할 때만 "확인필요".
- 금액은 원본 표기 유지(천단위 콤마), 진단표 수치는 만원 단위 숫자.
- 단위 일치: 각 진단항목의 standard(표준)와 current(현재)는 같은 기준(연간 한도 또는 회당) 금액으로 비교하라. 통원·소액 담보 등에서 표준과 현재의 단위가 어긋나 비현실적 비율(수백~수천%)이 나오지 않도록 반드시 동일 기준 금액을 사용한다.
- status: 가입금액이 표준 이상이면 "충분"(초과 시 "초과"), 미만이면 "부족", 0/미가입이면 "미가입".
- diagnosis는 보통 5영역: 사망·후유장해 / 암·뇌혈관·심장 / 의료·수술·입원 / 요양·치매 / 운전자·생활. 원본 구조에 맞게 조정. 각 영역의 rows에는 대표 담보를 항목명 그대로(예: "일반암 진단비", "간병인사용·지원 상해입원비") 담는다.
- summary.text, plan.nextSteps, note는 한국어 한두 문장.
- plan.p1=미가입/최우선, p2=부족 보완, p3=생활·구조조정 (각 3~5개).`;

const path = require("path");
// PDF 텍스트를 pdfjs + cMap으로 추출 — 나눔고딕 CID 등 ToUnicode가 없어 이미지로는 안 읽히는
// 회사명·상품명·설계사·고객명을 디코딩해 Claude에 함께 넘긴다. 실패해도 빈 문자열 반환(PDF만으로 진행).
async function extractPdfText(buf) {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const cMapUrl = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "cmaps") + path.sep;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), cMapUrl, cMapPacked: true, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
    const parts = [];
    const N = Math.min(doc.numPages, LIMITS.maxPages);
    for (let p = 1; p <= N; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const t = tc.items.map((i) => i.str).join(" ").replace(/[ \t]+/g, " ").trim();
      if (t) parts.push("[p" + p + "] " + t);
    }
    try { await doc.destroy(); } catch (_) {}
    return parts.join("\n");
  } catch (e) { return ""; }
}

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

  let pdfText = "";
  try { pdfText = await extractPdfText(buf); } catch (_) {}

  const content = [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } }];
  if (pdfText) content.push({ type: "text", text:
    "아래는 같은 PDF에서 폰트(cMap)로 디코딩해 추출한 원문 텍스트다. PDF 이미지에서 글자가 깨져 회사명·상품명·설계사·고객명이 안 읽힐 때 이 텍스트를 우선 신뢰해 정확히 채워라(특히 contracts의 company·product, customer.org·name). 표·수치의 행 배치는 PDF 이미지를 참고한다.\n\n<추출텍스트>\n" + pdfText.slice(0, 40000) + "\n</추출텍스트>" });
  content.push({ type: "text", text: "이 보장분석 원본에서 데이터를 추출해 emit_analysis 도구로 반환해줘." });

  const body = {
    model: MODEL, max_tokens: LIMITS.maxTokensOut,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    tools: [{ name: "emit_analysis", description: "추출한 보장분석 데이터를 반환", input_schema: SCHEMA }],
    tool_choice: { type: "tool", name: "emit_analysis" },
    messages: [{ role: "user", content }]
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
