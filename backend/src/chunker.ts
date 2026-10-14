export interface ChunkOptions {
  chunkSize: number;
  chunkOverlap: number;
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;。？！])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function chunkParagraph(paragraph: string, options: ChunkOptions): string[] {
  const { chunkSize, chunkOverlap } = options;

  if (paragraph.length <= chunkSize) {
    return [paragraph];
  }

  const sentences = splitIntoSentences(paragraph);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const sentence of sentences) {
    if ((currentChunk + " " + sentence).length <= chunkSize) {
      currentChunk = currentChunk ? currentChunk + " " + sentence : sentence;
    } else {
      if (currentChunk) chunks.push(currentChunk.trim());
      if (chunkOverlap > 0 && chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1];
        const overlapText = lastChunk.slice(-chunkOverlap);
        currentChunk = overlapText + " " + sentence;
      } else {
        currentChunk = sentence;
      }
    }
  }

  if (currentChunk.trim()) chunks.push(currentChunk.trim());
  return chunks;
}

function splitLargeTable(tableLines: string[], chunkSize: number): string[] {
  if (tableLines.length < 3) return [tableLines.join("\n")];

  const header = tableLines[0];
  const separator = tableLines[1];
  const dataRows = tableLines.slice(2);

  const headerBlock = header + "\n" + separator + "\n";
  const fullTable = tableLines.join("\n");
  if (fullTable.length <= chunkSize) return [fullTable];

  const chunks: string[] = [];
  let currentChunk = headerBlock;

  for (const row of dataRows) {
    if ((currentChunk + row + "\n").length <= chunkSize) {
      currentChunk += row + "\n";
    } else {
      chunks.push(currentChunk.trim());
      currentChunk = headerBlock + row + "\n";
    }
  }

  if (currentChunk.trim() !== headerBlock.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

// Bảng (mã số, ngày tháng, dấu |) tốn nhiều token hơn văn xuôi trên cùng số ký tự:
// đo với multilingual-e5-base, 1200 ký tự bảng ≈ 550 token (giới hạn 512), văn xuôi ≈ 300.
const TABLE_CHUNK_RATIO = 0.75;

function isTableLine(line: string): boolean {
  return line.trim().startsWith("|") && line.trim().endsWith("|");
}

export function chunkText(text: string, options: ChunkOptions): string[] {
  const lines = text.split("\n");
  const blocks: { type: "table" | "text"; content: string[] }[] = [];

  let currentBlock: { type: "table" | "text"; content: string[] } = {
    type: "text",
    content: [],
  };

  for (const line of lines) {
    const isTable = isTableLine(line);

    if (isTable && currentBlock.type === "text") {
      if (currentBlock.content.length > 0) {
        blocks.push(currentBlock);
      }
      currentBlock = { type: "table", content: [line] };
    } else if (!isTable && currentBlock.type === "table") {
      blocks.push(currentBlock);
      currentBlock = { type: "text", content: [line] };
    } else {
      currentBlock.content.push(line);
    }
  }
  if (currentBlock.content.length > 0) blocks.push(currentBlock);

  const chunks: string[] = [];
  let textBuffer = "";

  const flushTextBuffer = () => {
    if (!textBuffer.trim()) return;
    const textChunks = chunkTextContent(textBuffer, options);
    chunks.push(...textChunks);
    textBuffer = "";
  };

  for (const block of blocks) {
    if (block.type === "table") {
      // Tiêu đề đứng ngay trước bảng là tiêu đề của bảng đó → gắn vào chunk đầu của bảng
      const { rest, headings } = splitTrailingHeadings(textBuffer);
      textBuffer = rest;
      flushTextBuffer();
      const tableChunks = splitLargeTable(
        block.content,
        Math.floor(options.chunkSize * TABLE_CHUNK_RATIO)
      );
      if (headings.length > 0 && tableChunks.length > 0) {
        tableChunks[0] = headings.join("\n\n") + "\n\n" + tableChunks[0];
      }
      chunks.push(...tableChunks);
    } else {
      textBuffer += block.content.join("\n") + "\n";
    }
  }
  flushTextBuffer();

  return chunks.filter((c) => c.trim().length > 0);
}

/**
 * Dòng tiêu đề mục: "## 5.3 Quản lý mật khẩu" (Word dùng style Heading), "6.2.1 Kiểm soát truy cập",
 * "4.5 User credentials" (đánh số, không kết thúc bằng dấu câu).
 */
export function isHeadingLine(paragraph: string): boolean {
  const text = paragraph.trim();
  if (text.includes("\n") || text.length > 110) return false;
  if (/^#{1,6}\s+\S/.test(text)) return true;
  return /^\d+(\.\d+)*[.)]?\s+\S/.test(text) && !/[.;:,]$/.test(text);
}

/** Cấp của tiêu đề: "## x" → 2, "5.3.1 x" → 3, "5 PROCEDURE" / "5. PROCEDURE" → 1. */
function headingLevel(heading: string): number {
  const text = heading.trim();
  const hashes = text.match(/^(#{1,6})\s/);
  if (hashes) return hashes[1].length;
  const numbers = text.match(/^(\d+(?:\.\d+)*)/);
  return numbers ? numbers[1].split(".").length : 1;
}

const cleanHeading = (heading: string) => heading.trim().replace(/^#{1,6}\s+/, "").slice(0, 80);

export interface SectionedChunk {
  text: string;
  section: string; // mục chứa đoạn này, vd "5. PROCEDURE › 5.3 Quản lý mật khẩu" ("" nếu chưa gặp tiêu đề nào)
}

/**
 * Như chunkText nhưng kèm tên mục của từng đoạn. Đoạn ở giữa một mục dài không chứa tiêu đề nào,
 * nên khi tách riêng ra thì không biết nó thuộc phần nào của SOP - tên mục giúp tìm kiếm và trả lời đúng ngữ cảnh.
 */
export function chunkTextWithSections(text: string, options: ChunkOptions): SectionedChunk[] {
  const chunks = chunkText(text, options);
  const path: { level: number; title: string }[] = [];
  const pathLabel = () => path.map((p) => p.title).join(" › ");

  return chunks.map((chunk) => {
    const paragraphs = chunk.split(/\n\n+/);
    // Đoạn mở đầu bằng tiêu đề thì thuộc mục đó; không thì thuộc mục đang mở từ trước
    let section = pathLabel();
    paragraphs.forEach((para, i) => {
      if (!isHeadingLine(para)) return;
      const level = headingLevel(para);
      while (path.length > 0 && path[path.length - 1].level >= level) path.pop();
      path.push({ level, title: cleanHeading(para) });
      if (path.length > 2) path.splice(0, path.length - 2); // giữ 2 cấp gần nhất cho gọn
      if (i === 0) section = pathLabel();
    });
    return { text: chunk, section };
  });
}

/** Tách các tiêu đề nằm ở CUỐI đoạn text (chúng thuộc về nội dung đứng sau). */
function splitTrailingHeadings(text: string): { rest: string; headings: string[] } {
  const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter((p) => p.length > 0);
  const headings: string[] = [];
  while (paragraphs.length > 0 && isHeadingLine(paragraphs[paragraphs.length - 1])) {
    headings.unshift(paragraphs.pop()!);
  }
  return { rest: paragraphs.join("\n\n"), headings };
}

function chunkTextContent(text: string, options: ChunkOptions): string[] {
  const paragraphs = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let buffer: string[] = [];
  const sizeWith = (para: string) => [...buffer, para].join("\n\n").length;

  // Đóng chunk hiện tại. Tiêu đề nằm cuối chunk thuộc về nội dung phía sau, nên không để nó
  // kết thúc chunk này mà trả về để mở đầu chunk kế tiếp - tiêu đề luôn đi cùng nội dung của nó.
  const flush = (): string[] => {
    const carried: string[] = [];
    while (buffer.length > 0 && isHeadingLine(buffer[buffer.length - 1])) {
      carried.unshift(buffer.pop()!);
    }
    if (buffer.length > 0) chunks.push(buffer.join("\n\n"));
    buffer = [];
    return carried;
  };

  for (const para of paragraphs) {
    if (para.length > options.chunkSize) {
      const carried = flush();
      const subChunks = chunkParagraph(para, options);
      if (carried.length > 0) subChunks[0] = carried.join("\n\n") + "\n\n" + subChunks[0];
      chunks.push(...subChunks);
    } else if (sizeWith(para) <= options.chunkSize) {
      buffer.push(para);
    } else {
      buffer = [...flush(), para];
    }
  }

  // Hết nội dung: không còn gì phía sau để mang tiêu đề sang
  if (buffer.length > 0) chunks.push(buffer.join("\n\n"));
  return chunks;
}
