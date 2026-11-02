import { unfoldValue } from "../mail/headers.ts";

/** RFC 8617 §3.9: position is 1*2DIGIT. Share extraction between verification
 * and sealing, including malformed sets whose duplicate tags require cv=fail. */
export function arcFieldInstance(rawValue: string): number | null {
  let value = "";
  let depth = 0;
  let escaped = false;
  for (const character of unfoldValue(rawValue)) {
    if (depth > 0) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "(") depth++;
      else if (character === ")") depth--;
    } else if (character === "(") {
      depth++;
      value += " ";
    } else value += character;
  }
  let highest: number | null = null;
  for (const tag of value.split(";")) {
    const match = /^\s*i\s*=\s*(\d{1,2})\s*$/.exec(tag);
    if (match && Number(match[1]) > 0) highest = Math.max(highest ?? 0, Number(match[1]));
  }
  return highest;
}
