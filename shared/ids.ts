const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const ID_PATTERN = /^[0-9A-Za-z]{1,24}$/;

export function randomId(length = 10): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 62];
  return out;
}

export function idMaker(site = randomId(6)): () => string {
  let n = 0;
  return () => site + (n++).toString(36);
}
