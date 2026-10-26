import { describe, expect, it } from 'vitest';
import { FORM_FIELD_TYPES, normalizeFormFields, type FormFieldDef } from '@flowforge/shared';
import { Box } from 'lucide-react';
import { previewHtml } from '../src/editor/ndv/FormPreview';
import { changeType, fieldProblems, moveField, newField, readFields } from '../src/editor/params/form-fields';
import { iconFor } from '../src/lib/node-types';

describe('form builder helpers', () => {
  it('reads the stored value, keeping unfinished fields visible', () => {
    expect(readFields({ values: [{ fieldLabel: 'A' }, { fieldType: 'email' }, null, 'x'] })).toEqual([{ fieldLabel: 'A' }, { fieldType: 'email', fieldLabel: '' }]);
    expect(readFields([{ fieldLabel: 'B' }])).toEqual([{ fieldLabel: 'B' }]);
    expect(readFields(undefined)).toEqual([]);
    expect(readFields('nope')).toEqual([]);
    // …while the form itself only shows fields that have a label.
    expect(normalizeFormFields({ values: readFields({ values: [{ fieldLabel: 'A' }, { fieldType: 'email' }] }) })).toEqual([{ fieldLabel: 'A' }]);
  });

  it('adds fields with a unique label and sensible defaults per type', () => {
    const list: FormFieldDef[] = [];
    for (const type of ['email', 'email', 'dropdown', 'checkbox', 'hiddenField', 'file'] as const) list.push(newField(type, list));
    expect(list.map((f) => f.fieldLabel)).toEqual(['Email', 'Email 2', 'Choose one', 'Select all that apply', 'Hidden value', 'File']);
    expect(new Set(list.map((f) => f.id)).size).toBe(list.length);
    expect(list[2]!.fieldOptions).toEqual({ values: [{ option: 'Option 1' }, { option: 'Option 2' }] });
    expect(list[4]).toMatchObject({ fieldName: 'source', fieldValue: '' });
    expect(list[0]).toMatchObject({ fieldType: 'email', requiredField: false });
    expect(fieldProblems(list)).toEqual([]);
  });

  it('changing the type keeps the label and drops what the new type does not use', () => {
    const choice: FormFieldDef = { id: 'x', fieldLabel: 'Size', fieldType: 'radio', requiredField: true, fieldOptions: { values: [{ option: 'S' }] }, helpText: 'h' };
    expect(changeType(choice, 'dropdown')).toEqual({ ...choice, fieldType: 'dropdown' });
    expect(changeType(choice, 'text')).toEqual({ id: 'x', fieldLabel: 'Size', fieldType: 'text', requiredField: true, helpText: 'h' });
    expect(changeType({ fieldLabel: 'Doc', fieldType: 'file', multipleFiles: true, acceptFileTypes: '.pdf' }, 'text')).toEqual({ fieldLabel: 'Doc', fieldType: 'text' });
    expect(changeType({ fieldLabel: 'Shop name', fieldType: 'text', placeholder: 'p', requiredField: true, defaultValue: 'd' }, 'hiddenField')).toEqual({
      fieldLabel: 'Shop name',
      fieldType: 'hiddenField',
      fieldName: 'shop_name',
    });
    expect(changeType({ fieldLabel: 'Pick', fieldType: 'text' }, 'checkbox').fieldOptions?.values).toHaveLength(2);
  });

  it('moves fields (drag and drop / arrows) without mutating the list', () => {
    const list = ['a', 'b', 'c', 'd'];
    expect(moveField(list, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveField(list, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveField(list, 1, 99)).toEqual(['a', 'c', 'd', 'b']);
    expect(moveField(list, 2, -5)).toEqual(['c', 'a', 'b', 'd']);
    expect(moveField(list, 1, 1)).toBe(list);
    expect(moveField(list, 9, 0)).toBe(list);
    expect(list).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reports duplicate names, missing labels and empty choices', () => {
    const problems = fieldProblems([
      { fieldLabel: 'Name' },
      { fieldLabel: ' Name ' },
      { fieldLabel: '' },
      { fieldLabel: 'Pick', fieldType: 'dropdown', fieldOptions: { values: [{ option: ' ' }] } },
      { fieldLabel: 'Tracking', fieldType: 'hiddenField', fieldName: 'Pick' },
      { fieldLabel: 'Agree', fieldType: 'checkbox' },
    ]);
    expect(problems).toEqual([
      '1 field has no label and will not be shown.',
      '2 fields are named "Name": only the last one is kept in the output.',
      '2 fields are named "Pick": only the last one is kept in the output.',
      '"Pick" has no options to choose from.',
    ]);
  });

  it('every field type has an icon that exists', () => {
    for (const t of FORM_FIELD_TYPES) expect(iconFor(`lucide:${t.icon}`), t.icon).not.toBe(Box);
  });
});

describe('live preview', () => {
  it('renders the same page as the server from the node parameters (and its defaults)', () => {
    const defaults = { formTitle: 'Contact us', formTheme: 'midnight', formFields: { values: [{ fieldLabel: 'Name' }] }, options: {} };
    const html = previewHtml({ formTitle: '=Hello {{ $now.year }}', formTheme: 'sunset', options: { buttonLabel: 'Go', appendAttribution: false } }, defaults);
    expect(html).toContain('data-mode="preview"');
    expect(html).toContain('data-theme="sunset"');
    expect(html).toContain('<h1>Hello {{ $now.year }}</h1>');
    expect(html).toContain('>Go</span>');
    expect(html).toContain('for="field-0">Name</label>');
    expect(html).not.toContain('Powered by FlowForge');
    // Wait node: its own button parameter.
    expect(previewHtml({ formButtonLabel: 'Approve' }, defaults)).toContain('>Approve</span>');
    expect(previewHtml({}, defaults)).toContain('<h1>Contact us</h1>');
  });
});
