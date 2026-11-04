// Keep the deadline active through headers, redirects and response-body reads.
export async function withWebRequest(config = {}, { abortSignal } = {}, run) {
  abortSignal?.throwIfAborted();
  const timeoutMs = Number(config.webRequestTimeoutMs) || 10000;
  const deadline = new AbortController();
  const signal = AbortSignal.any([deadline.signal, ...(abortSignal ? [abortSignal] : [])]);
  const timer = setTimeout(() => deadline.abort(new DOMException('Web request timed out.', 'TimeoutError')), timeoutMs);
  timer.unref?.();
  try {
    const result = await run(signal);
    abortSignal?.throwIfAborted();
    return result;
  } catch (error) {
    abortSignal?.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
