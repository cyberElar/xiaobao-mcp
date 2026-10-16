import { parentPort, workerData } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";

interface Input {
  bytes: Uint8Array;
  startPage: number;
  maxPages: number;
  maxChars: number;
  textOffset: number;
}

async function extract(input: Input) {
  const pdf = await getDocumentProxy(input.bytes, {
    useWorkerFetch: false, useSystemFonts: false,
    disableFontFace: true, verbosity: 0,
  });
  try {
    if (input.startPage > pdf.numPages) return { error: "INVALID_PAGE" };
    const end = Math.min(pdf.numPages, input.startPage + input.maxPages - 1);
    const pages: { page: number; text: string }[] = [];
    let remaining = input.maxChars;
    let nextPage: number | null = end < pdf.numPages ? end + 1 : null;
    let nextOffset = 0;
    for (let number = input.startPage; number <= end; number++) {
      const page = await pdf.getPage(number);
      try {
        const content = await page.getTextContent();
        const text = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("");
        const offset = number === input.startPage ? input.textOffset : 0;
        if (offset > text.length) return { error: "INVALID_OFFSET" };
        const part = text.slice(offset, offset + remaining);
        pages.push({ page: number, text: part });
        remaining -= part.length;
        if (offset + part.length < text.length) {
          nextPage = number;
          nextOffset = offset + part.length;
          break;
        }
        if (remaining === 0) {
          nextPage = number < pdf.numPages ? number + 1 : null;
          break;
        }
      } finally {
        page.cleanup();
      }
    }
    return {
      format: "pdf", pages, totalPages: pdf.numPages, nextPage, nextOffset,
      truncated: nextPage !== null, ocrPerformed: false,
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

try {
  parentPort!.postMessage(await extract(workerData as Input));
} catch {
  parentPort!.postMessage({ error: "PDF_EXTRACTION_FAILED" });
}
