const SENSITIVE_LABEL = /\\b(?:mnemonic|recovery phrase|seed phrase|private key|secret key|api key|access token|refresh token|authorization|bearer|signed transaction|raw transaction|signature)\\b/i;

/** Redacts likely secrets before crash details are persisted, displayed, or shared. */
export function redactDiagnosticText(input: string): string {
  const lines = input.split(/\\r?\\n/).map(line => {
    if (SENSITIVE_LABEL.test(line)) {
      const separator = line.search(/[:=]/);
      return separator >= 0 ? `${line.slice(0, separator + 1)} [REDACTED]` : '[REDACTED SENSITIVE DIAGNOSTIC LINE]';
    }
    return line;
  });
  return lines.join('\\n')
    .replace(/\\b0x[a-fA-F0-9]{64}\\b/g, '[REDACTED_HEX_SECRET]')
    .replace(/\\b0x[a-fA-F0-9]{40}\\b/g, '[REDACTED_EVM_ADDRESS]')
    .replace(/\\b[a-fA-F0-9]{64}\\b/g, '[REDACTED_HEX_SECRET]')
    .replace(/\\bBearer\\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b/g, '[REDACTED_TOKEN]')
    .replace(/\\b(?:[a-z]{3,}\\s+){11,23}[a-z]{3,}\\b/gi, '[REDACTED_POSSIBLE_RECOVERY_PHRASE]')
    .replace(/\\b[1-9A-HJ-NP-Za-km-z]{80,100}\\b/g, '[REDACTED_POSSIBLE_PRIVATE_KEY]')
    .replace(/\\b[1-9A-HJ-NP-Za-km-z]{32,44}\\b/g, '[REDACTED_POSSIBLE_PUBLIC_KEY]');
}
