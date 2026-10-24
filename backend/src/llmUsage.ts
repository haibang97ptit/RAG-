import { AsyncLocalStorage } from "async_hooks";

/**
 * Đếm token mọi lần gọi AI trong MỘT câu hỏi (hiểu câu hỏi, chấm đoạn, trả lời...), để biết chi phí thật
 * của mỗi câu thay cho ước tính. Server mở một "phiên đếm" cho mỗi request (runWithUsage); các hàm gọi AI
 * chỉ cần recordUsage, không phải truyền tham số qua từng tầng.
 */

export interface StepUsage {
  calls: number;
  input: number; // prompt_tokens
  output: number; // completion_tokens (gồm cả token suy luận của gpt-oss)
}

export interface UsageTotals {
  calls: number;
  input: number;
  output: number;
  byStep: Record<string, StepUsage & { model: string }>;
}

const storage = new AsyncLocalStorage<UsageTotals>();

export const newUsage = (): UsageTotals => ({ calls: 0, input: 0, output: 0, byStep: {} });

export function runWithUsage<T>(totals: UsageTotals, fn: () => T): T {
  return storage.run(totals, fn);
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** Ghi số token của một lần gọi AI vào phiên đếm hiện tại (ngoài request thì bỏ qua). */
export function recordUsage(step: string, model: string, usage: RawUsage | null | undefined): void {
  const totals = storage.getStore();
  if (!totals || !usage) return;
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  totals.calls++;
  totals.input += input;
  totals.output += output;
  const s = (totals.byStep[step] ??= { model, calls: 0, input: 0, output: 0 });
  s.calls++;
  s.input += input;
  s.output += output;
}
