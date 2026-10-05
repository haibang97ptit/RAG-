import { pipeline, env, FeatureExtractionPipeline } from "@xenova/transformers";
import { config } from "./config.js";

env.cacheDir = config.cacheDir;
env.allowLocalModels = false;

let embedder: FeatureExtractionPipeline | null = null;

export async function initEmbedder(): Promise<void> {
  if (embedder) return;

  console.log(`🧠 Loading embedding model: ${config.embedModel}`);
  const t0 = Date.now();

  embedder = await pipeline("feature-extraction", config.embedModel, {
    quantized: true,
  });

  console.log(`   ✓ Loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

export async function embed(texts: string | string[]): Promise<number[][]> {
  if (!embedder) {
    throw new Error("Embedder chưa init. Gọi initEmbedder() trước.");
  }

  const inputs = Array.isArray(texts) ? texts : [texts];
  const prefixed = inputs.map((t) => `passage: ${t}`);

  const output = await embedder(prefixed, {
    pooling: "mean",
    normalize: true,
  });

  const dims = output.dims;
  const data = Array.from(output.data as Float32Array);
  const dim = dims[dims.length - 1];
  const vectors: number[][] = [];
  for (let i = 0; i < inputs.length; i++) {
    vectors.push(data.slice(i * dim, (i + 1) * dim));
  }
  return vectors;
}

export async function embedQuery(query: string): Promise<number[]> {
  if (!embedder) throw new Error("Embedder chưa init.");

  const output = await embedder(`query: ${query}`, {
    pooling: "mean",
    normalize: true,
  });

  return Array.from(output.data as Float32Array);
}

export function getEmbeddingDimension(): number {
  return 768;
}
