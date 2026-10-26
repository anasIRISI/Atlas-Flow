import { describe, expect, it } from 'vitest';
import {
  FORM_FIELD_TYPES,
  FORM_HONEYPOT,
  FORM_THEMES,
  formBinaryKey,
  formOutputName,
  normalizeFormFields,
  renderFormMessage,
  renderFormPage,
  validateFormSubmission,
  type FormFieldDef,
} from '../src/forms.js';

const page = (fields: FormFieldDef[], extra: Partial<Parameters<typeof renderFormPage>[0]> = {}) =>
  renderFormPage({ title: 'T', fields, action: '/form/x', ...extra });

describe('form rendering', () => {
  it('escapes every user-provided text', () => {
    const html = page(
      [
        { fieldLabel: '<img src=x onerror=alert(1)>', placeholder: '"><script>alert(2)</script>', helpText: '<b>help</b>' },
        { fieldLabel: 'Pick', fieldType: 'dropdown', fieldOptions: { values: [{ option: '"><script>alert(3)</script>' }] } },
      ],
      { title: '</title><script>alert(0)</script>', description: '<i>desc</i>', buttonLabel: '<u>go</u>', action: '/form/x"><script>' },
    );
    expect(html).not.toMatch(/<script>alert/);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>help</b>');
    expect(html).not.toContain('<i>desc</i>');
    expect(html).not.toContain('<u>go</u>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // The inline script can never be closed by form content.
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it('has the three themes, the honeypot and a multipart form only when a file is asked', () => {
    expect(FORM_THEMES.map((t) => t.value)).toEqual(['midnight', 'daylight', 'sunset']);
    for (const theme of FORM_THEMES) {
      const html = page([{ fieldLabel: 'A' }], { theme: theme.value });
      expect(html).toContain(`data-theme="${theme.value}"`);
      expect(html).toContain('--accent:');
    }
    expect(page([{ fieldLabel: 'A' }], { theme: 'nope' as never })).toContain('data-theme="midnight"');
    const text = page([{ fieldLabel: 'A' }]);
    expect(text).toContain(`name="${FORM_HONEYPOT}"`);
    expect(text).toContain('application/x-www-form-urlencoded');
    expect(page([{ fieldLabel: 'A', fieldType: 'file' }])).toContain('multipart/form-data');
    expect(page([{ fieldLabel: 'A' }], { attribution: false })).not.toContain('Powered by FlowForge');
  });

  it('shows default values, submitted values and errors', () => {
    const fields: FormFieldDef[] = [
      { fieldLabel: 'City', defaultValue: 'Paris' },
      { fieldLabel: 'Size', fieldType: 'radio', defaultValue: 'M', fieldOptions: { values: [{ option: 'S' }, { option: 'M' }] } },
      { fieldLabel: 'Tags', fieldType: 'checkbox', fieldOptions: { values: [{ option: 'a' }, { option: 'b' }, { option: 'c' }] } },
    ];
    const fresh = page(fields);
    expect(fresh).toContain('value="Paris"');
    expect(fresh).toContain('value="M" checked');
    const again = page(fields, { values: { 'field-0': 'Lyon', 'field-2': ['a', 'c'] }, errors: { 'field-0': 'Too far' }, formError: 'Fix it' });
    expect(again).toContain('value="Lyon"');
    expect(again).toContain('value="a" id="field-2" checked');
    expect(again).toContain('value="c" checked');
    expect(again).not.toContain('value="b" checked');
    expect(again).toContain('<div class="field invalid" data-field="field-0">');
    expect(again).toContain('role="alert">Too far</p>');
    expect(again).toContain('role="alert">Fix it</p>');
  });

  it('marks test and preview modes', () => {
    expect(page([], { mode: 'test' })).toContain('Test form');
    expect(page([], { mode: 'preview' })).toContain('data-mode="preview"');
    expect(page([], { mode: 'production' })).not.toContain('class="banner"');
  });

  it('message pages: confetti only for success', () => {
    expect(renderFormMessage({ title: 'Done', message: 'Line 1\nLine 2' })).toContain('data-confetti="1"');
    expect(renderFormMessage({ title: 'Done', message: 'Line 1\nLine 2' })).toContain('Line 1<br>Line 2');
    const error = renderFormMessage({ title: 'Oops', message: '<x>', tone: 'error' });
    expect(error).not.toContain('data-confetti="1"');
    expect(error).toContain('&lt;x&gt;');
  });
});

describe('form helpers', () => {
  it('normalizes the stored value and names outputs', () => {
    expect(normalizeFormFields({ values: [{ fieldLabel: 'A' }, { fieldLabel: '  ' }, null, { nope: 1 }] })).toEqual([{ fieldLabel: 'A' }]);
    expect(normalizeFormFields([{ fieldLabel: 'B' }])).toEqual([{ fieldLabel: 'B' }]);
    expect(normalizeFormFields(undefined)).toEqual([]);
    expect(normalizeFormFields('junk')).toEqual([]);
    expect(formOutputName({ fieldLabel: 'Source', fieldType: 'hiddenField', fieldName: 'utm' })).toBe('utm');
    expect(formOutputName({ fieldLabel: 'Source', fieldType: 'hiddenField' })).toBe('Source');
    expect(formOutputName({ fieldLabel: 'Name', fieldName: 'ignored' })).toBe('Name');
    expect(formBinaryKey({ fieldLabel: 'Your CV (pdf)' }, 2)).toBe('Your_CV_pdf');
    expect(formBinaryKey({ fieldLabel: 'été' }, 2)).toBe('t');
    expect(formBinaryKey({ fieldLabel: '???' }, 2)).toBe('file_2');
  });

  it('every field type has a label and an icon', () => {
    expect(FORM_FIELD_TYPES.map((t) => t.value)).toEqual(
      expect.arrayContaining(['text', 'email', 'number', 'textarea', 'dropdown', 'radio', 'checkbox', 'date', 'file', 'hiddenField']),
    );
    for (const type of FORM_FIELD_TYPES) expect(type.label && type.icon).toBeTruthy();
  });
});

describe('form validation', () => {
  it('accepts optional empty fields and trims text', () => {
    const fields: FormFieldDef[] = [{ fieldLabel: 'Name' }, { fieldLabel: 'Age', fieldType: 'number' }, { fieldLabel: 'Ok', fieldType: 'checkbox' }, { fieldLabel: 'Day', fieldType: 'date' }];
    const { values, errors } = validateFormSubmission(fields, { 'field-0': '  Ada  ' });
    expect(errors).toEqual({});
    expect(values).toEqual({ Name: 'Ada', Age: null, Ok: false, Day: '' });
  });

  it('limits the length of answers', () => {
    const fields: FormFieldDef[] = [{ fieldLabel: 'Short' }, { fieldLabel: 'Long', fieldType: 'textarea' }];
    expect(validateFormSubmission(fields, { 'field-0': 'x'.repeat(10_001), 'field-1': 'x'.repeat(10_001) }).errors).toEqual({ 'field-0': 'This answer is too long' });
    expect(validateFormSubmission(fields, { 'field-1': 'x'.repeat(50_001) }).errors).toEqual({ 'field-1': 'This answer is too long' });
  });

  it('checks dates, numbers and e-mail addresses strictly', () => {
    const fields: FormFieldDef[] = [{ fieldLabel: 'D', fieldType: 'date' }, { fieldLabel: 'N', fieldType: 'number' }, { fieldLabel: 'E', fieldType: 'email' }];
    const bad = validateFormSubmission(fields, { 'field-0': '2026-13-45', 'field-1': 'Infinity', 'field-2': 'a b@c.d' });
    expect(Object.keys(bad.errors)).toEqual(['field-0', 'field-1', 'field-2']);
    const good = validateFormSubmission(fields, { 'field-0': '2026-02-28', 'field-1': '-1.5e3', 'field-2': 'a.b+c@d.co' });
    expect(good.errors).toEqual({});
    expect(good.values).toEqual({ D: '2026-02-28', N: -1500, E: 'a.b+c@d.co' });
  });

  it('file rules: accepted types by extension, exact MIME type or wildcard', () => {
    const field = (accept: string): FormFieldDef[] => [{ fieldLabel: 'F', fieldType: 'file', acceptFileTypes: accept }];
    const file = { field: 'field-0', fileName: 'Photo.JPG', mimeType: 'image/jpeg', size: 10 };
    expect(validateFormSubmission(field('.jpg'), {}, [file]).errors).toEqual({});
    expect(validateFormSubmission(field('jpg, png'), {}, [file]).errors).toEqual({});
    expect(validateFormSubmission(field('image/*'), {}, [file]).errors).toEqual({});
    expect(validateFormSubmission(field('image/jpeg'), {}, [file]).errors).toEqual({});
    expect(validateFormSubmission(field('.pdf, application/pdf'), {}, [file]).errors).toEqual({ 'field-0': '"Photo.JPG" is not an accepted file type (.pdf, application/pdf)' });
    // Browsers send an empty file part when nothing was chosen.
    expect(validateFormSubmission(field(''), {}, [{ ...file, fileName: '', size: 0 }]).values).toEqual({ F: null });
  });
});
