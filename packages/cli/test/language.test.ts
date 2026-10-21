import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../src/language.ts';

describe('the prompt language', () => {
  it('is named from words alone, on the device', () => {
    expect(
      detectLanguage(
        'please refactor the parser so that it handles every date format and add tests for each case',
      ),
    ).toBe('eng');
    expect(
      detectLanguage(
        'lütfen bu fonksiyonu düzelt ve her tarih biçimi için yeni testler ekle, sonra da belgeleri güncelle',
      ),
    ).toBe('tur');
    expect(detectLanguage('ok')).toBe('und');
  });
});
