/**
 * Default file handler — no skill extractors installed.
 * Returns null to let the default fallback handle it.
 *
 * Skills can override this file on their branch to add extractors
 * (e.g., pdf-extract for pdftotext extraction).
 */
export async function handleFile(_filePath: string): Promise<any[] | null> {
  return null;
}
