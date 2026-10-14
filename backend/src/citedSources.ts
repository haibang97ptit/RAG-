import { stripExtension } from "./fileCatalog.js";

/**
 * Chọn "nguồn tham khảo" hiển thị cho user SAU KHI đã có câu trả lời.
 *
 * Retrieval luôn trả về vài đoạn trích, kể cả khi câu hỏi không liên quan tới SOP, nên hiển thị
 * mọi file được truy xuất sẽ ra nguồn vô nghĩa. Thay vào đó:
 * - câu trả lời ngắn báo "không tìm thấy..." → không hiển thị nguồn
 * - câu trả lời có nhắc tên file / mã (LLM bắt buộc ghi) → chỉ hiển thị các file đó
 * - không nhận ra trích dẫn nào: câu trả lời ngắn (trò chuyện, ngoài lề) → không hiển thị;
 *   câu trả lời dài (có nội dung, nhiều khả năng lấy từ tài liệu) → hiển thị toàn bộ như cũ.
 */

export interface UiSource {
  fileName: string;
  category: string;
  sheetName?: string;
  score: number;
}

// Câu trả lời ngắn: lời chào, câu đáp ngoài lề, câu báo không có thông tin.
// Câu trả lời có nội dung từ tài liệu gần như luôn dài hơn mức này.
const SHORT_ANSWER_MAX_LENGTH = 400;
const NOT_FOUND_PHRASES = ["không tìm thấy", "chưa tìm thấy", "không có thông tin"];

const isShort = (answer: string) => answer.trim().length <= SHORT_ANSWER_MAX_LENGTH;

// Câu trả lời dài có lẫn "không tìm thấy" cho một ý thì vẫn là câu trả lời có nội dung.
export function isNotFoundAnswer(answer: string): boolean {
  const text = answer.normalize("NFC").toLowerCase();
  return isShort(answer) && NOT_FOUND_PHRASES.some((phrase) => text.includes(phrase));
}

// So khớp không phụ thuộc dấu phân cách: "FRM.QA.SOP-GEN.0005-F18" = "FRM/QA/SOP-GEN/0005/F18"
function squash(text: string): string {
  return (text.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join("");
}

// Các cách LLM có thể nhắc tới 1 file: tên đầy đủ, chỉ phần mã, hoặc mã bỏ số phiên bản ở cuối
function citationKeys(fileName: string): string[] {
  const baseName = stripExtension(fileName);
  const keys = [squash(baseName)];

  const codePart = baseName.split(/\s+/).find((segment) => /\d{3,}/.test(segment));
  if (codePart) {
    keys.push(squash(codePart));
    keys.push(squash(codePart.replace(/[-._/]\d{1,2}$/, "")));
  }

  // Khóa quá ngắn (vd "sop12") dễ khớp nhầm
  return keys.filter((k) => k.length >= 6);
}

export function selectDisplayedSources<T extends UiSource>(
  answer: string,
  sources: T[],
  maxSources: number
): T[] {
  if (sources.length === 0 || isNotFoundAnswer(answer)) return [];

  const squashedAnswer = squash(answer);
  const cited = sources.filter((s) =>
    citationKeys(s.fileName).some((key) => squashedAnswer.includes(key))
  );

  if (cited.length > 0) return cited.slice(0, maxSources);
  return isShort(answer) ? [] : sources.slice(0, maxSources);
}
