/**
 * Vector thưa cho tìm kiếm theo TỪ KHÓA (kiểu BM25), chạy song song với tìm theo nghĩa.
 *
 * Tìm theo nghĩa (embedding) kém với mã số, tên thiết bị, số hiệu: "F17", "HPLC-05", "21 CFR Part 11"
 * gần như không mang nghĩa nên vector không phân biệt được. Tìm theo từ khóa thì khớp chính xác.
 * Qdrant tự tính IDF (từ hiếm được điểm cao) nhờ modifier "idf" của collection; ở đây chỉ cần
 * đếm số lần mỗi từ xuất hiện.
 */

export interface SparseVector {
  indices: number[];
  values: number[];
}

// Từ quá phổ biến, không giúp phân biệt đoạn nào với đoạn nào
const STOP_WORDS = new Set([
  "và", "của", "các", "những", "là", "có", "được", "cho", "trong", "với", "theo", "khi", "để", "này", "đó",
  "thì", "một", "không", "phải", "từ", "tại", "về", "như", "hoặc", "nếu", "bao", "nhiêu", "nào", "gì",
  "the", "of", "and", "to", "in", "for", "a", "an", "is", "be", "by", "on", "or", "with", "as", "at", "are",
  "shall", "should", "will", "this", "that", "from",
]);

const stripDiacritics = (text: string) =>
  text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");

/** Từ dùng để đánh chỉ mục: chữ thường, kèm bản không dấu; số bỏ số 0 đầu ("0005" → cả "0005" và "5"). */
export function sparseTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    if (STOP_WORDS.has(raw)) continue;
    tokens.push(raw);
    const plain = stripDiacritics(raw);
    if (plain !== raw) tokens.push(plain);
    if (/^0+\d+$/.test(raw)) tokens.push(raw.replace(/^0+/, ""));
  }
  return tokens;
}

// FNV-1a 32 bit: từ → chỉ số trong vector thưa (Qdrant nhận số nguyên không âm 32 bit)
function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Từ lặp nhiều lần được tăng điểm nhưng chậm dần (1 + log), để đoạn lặp một từ không lấn át. */
export function toSparseVector(text: string): SparseVector {
  const counts = new Map<number, number>();
  for (const token of sparseTokens(text)) {
    const index = hashToken(token);
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  const indices = [...counts.keys()].sort((a, b) => a - b);
  return { indices, values: indices.map((i) => 1 + Math.log(counts.get(i)!)) };
}
