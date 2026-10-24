import { extractIfc } from "./core.js";
self.onmessage = async ({ data }) => {
  try {
    const result = await extractIfc(data.bytes, data.quality, {
      useWorker: false,
      wasmUrl: data.wasmUrl,
    });
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
