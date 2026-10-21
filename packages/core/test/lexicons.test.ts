import { describe, expect, it } from 'vitest';
import {
  fold,
  hasCodeReference,
  isCapsCrisis,
  LEXICONS,
  languageSample,
  normalizePrompt,
  referencesPlanFile,
  wordCount,
} from '../src/index.ts';

const has = (lexicon: keyof typeof LEXICONS, text: string) => LEXICONS[lexicon].test(fold(text));

describe('fold (Turkish dotted and dotless I)', () => {
  it('treats I, ı, İ and i as one letter in every locale', () => {
    expect(fold('HAYIR')).toBe(fold('hayır'));
    expect(fold('İYİ')).toBe(fold('iyi'));
    expect(fold('TEŞEKKÜRLER')).toBe('teşekkürler');
    expect(fold('It’s')).toBe("it's");
  });
});

describe('lexicons', () => {
  it.each([
    ['thanks', 'Thanks, that worked'],
    ['thanks', 'TEŞEKKÜRLER ustam'],
    ['thanks', 'çok teşekkür ederim'],
    ['thanks', 'muchas gracias'],
    ['thanks', 'Vielen Dank!'],
    ['swears', 'what the fuck is this'],
    ['swears', 'AMK yine mi'],
    ['swears', 'putain de bug'],
    ['corrections', 'No, that is not what I asked'],
    ['corrections', 'HAYIR öyle değil'],
    ['corrections', '  ...nope'],
    ['plan', 'Make a plan first, then build'],
    ['plan', 'önce plan yapalım'],
    ['apology', 'I apologize for the confusion.'],
    ['apology', 'Özür dilerim, haklısınız.'],
    ['absolutelyRight', "You're absolutely right!"],
    ['absolutelyRight', 'Kesinlikle haklısınız.'],
    ['sycophancy', 'Great question.'],
    ['sycophancy', 'Haklısın.'],
  ] as const)('%s matches "%s"', (lexicon, text) => {
    expect(has(lexicon, text)).toBe(true);
  });

  it.each([
    ['thanks', 'Thanksgiving dinner plans'],
    ['swears', 'shitake mushrooms and a hello'],
    ['corrections', 'I said no to that idea earlier'],
    ['corrections', 'notes about the build'],
    ['absolutelyRight', 'This is absolutely rightward'],
    ['sycophancy', 'perfection is the enemy'],
  ] as const)('%s does not match "%s"', (lexicon, text) => {
    expect(has(lexicon, text)).toBe(false);
  });
});

describe('prompt text checks', () => {
  it('counts words in any script', () => {
    expect(wordCount('fix the parser, please')).toBe(4);
    expect(wordCount("it's a re-run")).toBe(3);
    expect(wordCount('şimdi düzelt')).toBe(2);
    expect(wordCount('   ')).toBe(0);
  });

  it('finds a caps lock crash-out, also in Turkish, and never in scripts without case', () => {
    expect(isCapsCrisis('WHY IS THIS STILL BROKEN')).toBe(true);
    expect(isCapsCrisis('NEDEN HALA ÇALIŞMIYOR BU İŞ')).toBe(true);
    expect(isCapsCrisis('Why is this still broken')).toBe(false);
    expect(isCapsCrisis('FIX IT')).toBe(false);
    expect(isCapsCrisis('なぜ まだ 壊れている の か')).toBe(false);
  });

  it('spots code references', () => {
    for (const text of [
      'look at `parse()`',
      'check src/app.ts please',
      'fix utils.py',
      'TypeError: x is undefined',
      'see line 42',
      '    at run (index.js:12:5)',
    ]) {
      expect(hasCodeReference(text)).toBe(true);
    }
    expect(hasCodeReference('make the button blue')).toBe(false);
    expect(hasCodeReference('version 2.1 is out')).toBe(false);
  });

  it('spots plan and spec files', () => {
    expect(referencesPlanFile('read SPEC.md first')).toBe(true);
    expect(referencesPlanFile('update agents.md')).toBe(true);
    expect(referencesPlanFile('planning.md is different')).toBe(false);
  });

  it('normalizes prompts for repeats', () => {
    expect(normalizePrompt('  Run the TESTS!!  ')).toBe(normalizePrompt('run the tests'));
  });
});

describe('the language sample', () => {
  it('keeps prompt words only, and stops at its cap', () => {
    const sample = languageSample(60);
    sample.add(
      'bitte den Parser umbauen und `parse()` testen, siehe https://example.org/docs und src/app.ts',
    );
    sample.add('ok');
    sample.add('```\nconst x = 1;\n```');
    sample.add('und danach die Dokumentation für alle neuen Funktionen schreiben');
    // 47 characters from the first prompt, then the 13 that still fit.
    expect(sample.text()).toBe('bitte den Parser umbauen und testen, siehe und und danach di');
    sample.clear();
    expect(sample.text()).toBe('');
  });
});
