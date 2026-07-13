import * as vscode from 'vscode';
import { fmtDuration, parseDuration } from '../lib/duration';

export interface ConvertDurationArgs {
  /** Field label used in the input box title, e.g. "Max execution time". */
  title?: string;
  /** Current field value in ms — prefills the box when it round-trips losslessly. */
  currentMs?: number;
  /** Skip the copy-to-clipboard notification (the Studio panel fills its field instead). */
  quiet?: boolean;
}

/**
 * Human-readable duration → milliseconds, behind the clock buttons next to the
 * Studio panel's ms fields and the `Acurast: Convert Duration to Milliseconds`
 * palette command. The input box shows the parsed ms live while typing.
 * Returns the ms (for the panel to fill into its field) or undefined when
 * dismissed; palette runs also copy the result to the clipboard.
 */
export async function convertDuration(args?: ConvertDurationArgs): Promise<number | undefined> {
  // Prefill with the current value's human form, but only when parsing it back
  // yields exactly the same ms — fmtDuration keeps two units, and a lossy
  // prefill accepted with a plain Enter would silently change the field.
  let value: string | undefined;
  if (typeof args?.currentMs === 'number' && args.currentMs > 0) {
    const human = fmtDuration(args.currentMs);
    if (parseDuration(human) === args.currentMs) value = human;
  }

  const input = await vscode.window.showInputBox({
    title: args?.title ? `${args.title}: duration → ms` : 'Convert duration to milliseconds',
    prompt: 'Units: y mo w d h m s ms — combine freely',
    placeHolder: 'e.g. 1d 12h · 90m · 45s',
    value,
    validateInput: (text) => {
      if (!text.trim()) return undefined;
      const ms = parseDuration(text);
      if (ms === null) return 'Use units like "1d 2h 30m 45s 500ms" — or a plain millisecond number';
      return {
        message: `= ${ms.toLocaleString('en-US')} ms`,
        severity: vscode.InputBoxValidationSeverity.Info,
      };
    },
  });
  if (input === undefined) return undefined;
  const ms = parseDuration(input);
  if (ms === null) return undefined;

  if (!args?.quiet) {
    await vscode.env.clipboard.writeText(String(ms));
    vscode.window.setStatusBarMessage(`${fmtDuration(ms)} = ${ms.toLocaleString('en-US')} ms — copied to clipboard`, 3000);
  }
  return ms;
}
