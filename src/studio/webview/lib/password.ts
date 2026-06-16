// Client-side password strength estimate for the create/import wallet flows.
// Purely advisory UI feedback — the real guarantee is AES-256-GCM + PBKDF2 at
// rest (see WalletService/crypto). The minimum the host enforces is 8 chars.

export interface PasswordStrength {
  /** 0–4 — drives the number of filled meter bars. */
  score: number;
  label: 'Weak' | 'Fair' | 'Good' | 'Strong';
}

/**
 * Score by length + character-class variety. Short passwords are capped low no
 * matter how varied; long, varied passwords reach 'Strong'. Empty → score 0.
 */
export function passwordStrength(pw: string): PasswordStrength {
  if (!pw) return { score: 0, label: 'Weak' };

  let variety = 0;
  if (/[a-z]/.test(pw)) variety++;
  if (/[A-Z]/.test(pw)) variety++;
  if (/[0-9]/.test(pw)) variety++;
  if (/[^A-Za-z0-9]/.test(pw)) variety++;

  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (variety >= 2) score++;
  if (variety >= 3 && pw.length >= 10) score++;

  // Anything under the host minimum can never read above 'Weak'.
  if (pw.length < 8) score = Math.min(score, 1);
  score = Math.max(1, Math.min(score, 4));

  const label = score <= 1 ? 'Weak' : score === 2 ? 'Fair' : score === 3 ? 'Good' : 'Strong';
  return { score, label };
}
