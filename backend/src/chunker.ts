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
      flushTextBuffer();
      const tableChunks = splitLargeTable(block.content, options.chunkSize);
      chunks.push(...tableChunks);
    } else {
      textBuffer += block.content.join("\n") + "\n";
    }
  }
  flushTextBuffer();

  return chunks.filter((c) => c.trim().length > 0);
}

function chunkTextContent(text: string, options: ChunkOptions): string[] {
  const paragraphs = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let buffer = "";

  for (const para of paragraphs) {
    if (para.length > options.chunkSize) {
      if (buffer) {
        chunks.push(buffer.trim());
        buffer = "";
      }
      const subChunks = chunkParagraph(para, options);
      chunks.push(...subChunks);
    } else {
      if ((buffer + "\n\n" + para).length <= options.chunkSize) {
        buffer = buffer ? buffer + "\n\n" + para : para;
      } else {
        if (buffer) chunks.push(buffer.trim());
        buffer = para;
      }
    }
  }

  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}
