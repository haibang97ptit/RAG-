/**
 * Sửa chữ tiếng Việt bị lỗi bảng mã trong lớp chữ PDF.
 *
 * Một số PDF (thường do phần mềm chuyển đổi cũ tạo ra) ghi các chữ Latin-1 có dấu (á à â ã ê í ô ó
 * ò é è ù ú ý õ…) theo bảng mã Windows-1252 nhưng khai báo nhầm là bảng mã Macintosh, nên khi đọc ra
 * thành "kh·i" (khái), "TiÍu" (tiêu), "th‡nh" (thành), "ThÙng b·o" (thông báo). Các chữ riêng của tiếng
 * Việt (ă, ơ, ư, đ, ệ…) nằm ngoài bảng mã này nên vẫn đúng - vì vậy một trang có thể vừa đúng vừa sai.
 *
 * Chỉ sửa trang có dấu hiệu lỗi CHẮC CHẮN, và không bao giờ đổi một chữ tiếng Việt đúng thành chữ khác.
 */

const mac = new TextDecoder("macintosh");
const win = new TextDecoder("windows-1252");

// Chữ có dấu thuộc Latin-1 mà tiếng Việt dùng: đích của việc sửa
const VIETNAMESE_LATIN1 = "àáâãèéêìíòóôõùúýÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝ";

// Ký tự Macintosh → chữ Windows-1252 tương ứng. Bỏ các cặp có ký tự gốc là chữ tiếng Việt đúng
// (vd "à" của bảng Macintosh ứng với "ˆ" của Windows: đổi thì làm hỏng chữ "à" thật).
const SYMBOL_TO_LETTER = new Map<string, string>(); // ký tự gốc không phải chữ cái: ‡ · ‚ „ …
const UPPER_TO_LETTER = new Map<string, string>(); // ký tự gốc là chữ hoa: Í Ì Ù Û Ú È Ë Ï …
for (let b = 0x80; b <= 0xff; b++) {
  const from = mac.decode(new Uint8Array([b]));
  const to = win.decode(new Uint8Array([b]));
  if (from === to || !VIETNAMESE_LATIN1.includes(to) || from === " ") continue;
  if (!/\p{L}/u.test(from)) SYMBOL_TO_LETTER.set(from, to);
  else if (/\p{Lu}/u.test(from) && !"àáâãèéêìíòóôõùúý".includes(from)) UPPER_TO_LETTER.set(from, to);
}

const escapeClass = (chars: string) => chars.replace(/[\\\]^-]/g, "\\$&");
const SYMBOLS = escapeClass([...SYMBOL_TO_LETTER.keys()].join(""));
const UPPERS = escapeClass([...UPPER_TO_LETTER.keys()].join(""));

// Dấu hiệu chắc chắn: ký tự như ‡ · ‚ „ nằm GIỮA hai chữ cái ("kh·i", "nh„n") - không bao giờ gặp trong
// văn bản đúng, một chỗ là đủ. Đứng sát một bên chữ thì chưa chắc ("A · B" viết liền), cần ít nhất 2 chỗ.
const INSIDE_WORD = new RegExp(`\\p{L}[${SYMBOLS}]\\p{L}`, "u");
const BESIDE_WORD = new RegExp(`\\p{L}[${SYMBOLS}]|[${SYMBOLS}]\\p{L}`, "gu");
const MIN_BESIDE_MARKERS = 2;

// Ký tự (không phải chữ) sát một chữ cái → chữ đúng
const FIX_SYMBOL = new RegExp(`(?<=\\p{L})[${SYMBOLS}]|[${SYMBOLS}](?=\\p{L})`, "gu");
// Chữ hoa nằm kẹp giữa hai chữ thường ("TiÍu") → chữ thường đúng. Chữ hoa có dấu thật (Í trong "Ích")
// không bao giờ nằm giữa từ nên không bị đổi.
const FIX_UPPER = new RegExp(`(?<=\\p{Ll})[${UPPERS}](?=\\p{Ll})`, "gu");
// "Ê" (0xCA) đọc theo Macintosh là dấu cách không ngắt: chỉ sửa khi nằm giữa hai chữ in hoa ("NGUY N")
const UPPER_E = /(?<=\p{Lu}) (?=\p{Lu})/gu;

/** Sửa một trang. Trang không có dấu hiệu lỗi thì trả nguyên văn. */
export function repairMisencodedPage(text: string): string {
  const broken = INSIDE_WORD.test(text) || (text.match(BESIDE_WORD)?.length ?? 0) >= MIN_BESIDE_MARKERS;
  if (!broken) return text;
  return text
    .replace(FIX_SYMBOL, (c) => SYMBOL_TO_LETTER.get(c) ?? c)
    .replace(FIX_UPPER, (c) => UPPER_TO_LETTER.get(c) ?? c)
    .replace(UPPER_E, "Ê");
}
