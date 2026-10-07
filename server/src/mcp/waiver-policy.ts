/**
 * 豁免（waive）與取代（supersede）的收件標準 — 純函式，不碰 DB、不碰 fs。
 *
 * 背景（真實事故）：
 * 1. 檢查表只有 matched / missing / waived 三種出口。規格變更後檢查表字面過期
 *    （端點改路徑、回應欄位取消）時，程式明明沒錯卻只能一項項 waive——台帳上
 *    「規格改了」與「我們決定不做」長得一模一樣，而這兩件事的後續動作完全不同。
 *    → 新增 superseded 出口，並要求它**指出替代品**（現行規格出處 + 現行字面）；
 *      兩者缺一不收。這是它與豁免的結構差別：豁免只要理由，取代要能指出替代品。
 * 2. 豁免理由只有 minLength: 1，實務上出現過「不做」「N/A」這種等於沒寫的理由，
 *    而豁免通常由最有動機讓任務結案的那個人下。
 *    → 理由太短或只有樣板字樣一律拒收，並在錯誤訊息說明要寫到什麼精度。
 */

/** 豁免理由最短長度（以 Unicode 字元計——中文一個字算一個） */
export const MIN_WAIVE_REASON_CHARS = 20;

/**
 * 「等於沒寫」的樣板理由。整串理由把這些字樣與標點/空白拿掉後就空了 → 拒收。
 * 刻意只擋「通篇只有這些字」的情況，不做語意判斷：理由寫得爛但有內容的，
 * 交給下游的豁免複查（get_compliance_review_plan 的複查段）處理。
 */
const BOILERPLATE_TOKENS = [
  'n/a', 'na', 'not applicable', 'tbd', 'todo', 'skip', 'skipped', 'later', 'wontfix', 'no need',
  '不做', '不需要', '不用做', '無需', '沒做', '未做', '不實作', '不適用', '無',
  '暫時跳過', '暫時不做', '先跳過', '跳過', '略過', '之後再做', '以後再做', '待處理', '再說',
  '無法實作', '沒必要', '不影響',
];

/** 標點、空白、引號等——判斷「拿掉樣板字樣後還剩什麼」時一律視為雜訊 */
const PUNCT_RE = /[\s，。、；：！？~～·「」『』（）()[\]{}<>"'`,.;:!?\-_/\\|+*#@$%^&=]/g;

export interface PolicyResult {
  ok: boolean;
  /** ok=false 時的完整錯誤訊息（可直接回給呼叫端） */
  error?: string;
}

/** 豁免理由要寫到什麼精度——錯誤訊息與工具描述共用同一段文字（單一真相） */
export const WAIVE_REASON_PRECISION_RULE =
  '豁免理由必須寫清楚三件事：(1) **哪一句**——檢查表這一項對應規格的哪一句要求；'
  + '(2) **依據哪一條**——豁免的依據（使用者哪次裁決、哪張後續任務單、規格哪一節寫明不在本次範圍）；'
  + '(3) **現行是什麼**——現在的程式/規格實際是什麼狀態。'
  + '若真正的原因是「規格改了、程式沒錯、只有檢查表字面過期」，**不要用豁免**——'
  + '改用 supersede_checklist_item（需附現行規格出處與現行字面），豁免與取代在台帳上是兩件事。';

/**
 * 豁免理由是否可收。太短（< MIN_WAIVE_REASON_CHARS 字元）或只有樣板字樣 → 拒收。
 */
export function validateWaiveReason(raw: string): PolicyResult {
  const reason = (raw ?? '').trim();
  if (reason.length === 0) {
    return { ok: false, error: `Error: 豁免理由（reason）不可為空白。${WAIVE_REASON_PRECISION_RULE}` };
  }

  const charCount = [...reason].length;
  if (charCount < MIN_WAIVE_REASON_CHARS) {
    return {
      ok: false,
      error: `Error: 豁免理由太短（${charCount} 字，至少要 ${MIN_WAIVE_REASON_CHARS} 字）——「${reason}」沒有交代為什麼可以不做。\n${WAIVE_REASON_PRECISION_RULE}`,
    };
  }

  // 樣板偵測：拿掉樣板字樣與標點後若已無實質內容 → 等於沒寫
  let residue = reason.toLowerCase();
  for (const token of BOILERPLATE_TOKENS) {
    residue = residue.split(token).join('');
  }
  residue = residue.replace(PUNCT_RE, '');
  if (residue.length === 0) {
    return {
      ok: false,
      error: `Error: 豁免理由只有樣板字樣（「${reason}」），等於沒寫——台帳上看不出這一項為什麼可以不做。\n${WAIVE_REASON_PRECISION_RULE}`,
    };
  }

  return { ok: true };
}

export interface SupersedeInput {
  /** 現行規格的出處：檔名 + 節名（如 "SPEC_WA05.docx §3.2 登入 API"） */
  currentSpecRef: string;
  /** 現行規格的字面（取代這一項的實際文字/路徑/欄位名） */
  currentText: string;
}

/** 取代要求「指出替代品」的說明——錯誤訊息與工具描述共用 */
export const SUPERSEDE_PRECISION_RULE =
  '「已被取代」必須指出替代品，兩者缺一不可：'
  + 'currentSpecRef = **現行規格的出處**（檔名 + 節名，如 "SPEC_WA05.docx §3.2 登入 API"）；'
  + 'currentText = **現行的字面**（取代這一項的實際路徑/文字/欄位名，如 "/auth/login"）。'
  + '出處必須含節名或章節編號，不能只給檔名——「某份規格裡有寫」不算指出替代品。'
  + '若你講不出替代品（沒有任何一條現行規格接手這一項），那就不是「被取代」，'
  + '是「決定不做」——請改用 waive_checklist_item 並寫清楚依據。';

/** 出處是否具體到節（含 §／章節數字／# 標題／「第 X 節」等任一形式） */
function hasSectionHint(ref: string): boolean {
  return /§|#|\bch(apter)?\b|\bsec(tion)?\b|第\s*[0-9０-９一二三四五六七八九十]+\s*[章節條項]|[0-9]+\s*[.．][0-9]/i.test(ref);
}

/**
 * 取代的必填欄位是否齊備且具體。
 * 這是 superseded 與 waived 的**結構差別**：豁免只要理由，取代要能指出替代品。
 */
export function validateSupersede(input: SupersedeInput): PolicyResult {
  const specRef = (input.currentSpecRef ?? '').trim();
  const currentText = (input.currentText ?? '').trim();

  const missing: string[] = [];
  if (specRef.length === 0) missing.push('currentSpecRef（現行規格出處：檔名＋節名）');
  if (currentText.length === 0) missing.push('currentText（現行的字面）');
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Error: 標記「已被取代」缺少必填欄位：${missing.join('、')}。\n${SUPERSEDE_PRECISION_RULE}`,
    };
  }

  if (!hasSectionHint(specRef)) {
    return {
      ok: false,
      error: `Error: currentSpecRef「${specRef}」只給了檔名/籠統來源，沒有指到節——無法查證替代品。\n${SUPERSEDE_PRECISION_RULE}`,
    };
  }

  return { ok: true };
}
