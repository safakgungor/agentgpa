import { franc } from 'franc-min';

/** The main language of a sample of prompt words, as an ISO 639-3 code or `und`, on the device. */
export function detectLanguage(sample: string): string {
  return franc(sample, { minLength: 10 });
}
