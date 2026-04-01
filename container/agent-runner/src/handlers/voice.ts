/**
 * Default voice handler — no skill transcription installed.
 * Returns null to let the default fallback handle it.
 *
 * Skills can override this file on their branch to add transcription
 * (e.g., voice-openai for OpenAI Whisper API).
 */
export async function handleVoice(_filePath: string): Promise<any[] | null> {
  return null;
}
