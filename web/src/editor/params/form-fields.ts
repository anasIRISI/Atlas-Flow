import { FIELD_TYPES_WITH_OPTIONS, FORM_FIELD_TYPES, formOutputName, type FormFieldDef, type FormFieldType } from '@flowforge/shared';

// Pure helpers of the visual form builder (unit-tested in web/tests/form-fields.test.ts).

/** Fields as stored in the parameter ({ values: [...] }), keeping unfinished ones (empty label) visible. */
export function readFields(value: unknown): FormFieldDef[] {
  const list = Array.isArray(value) ? value : (value as { values?: unknown } | null)?.values;
  return Array.isArray(list) ? list.filter((f): f is FormFieldDef => !!f && typeof f === 'object').map((f) => ({ ...f, fieldLabel: String(f.fieldLabel ?? '') })) : [];
}

const typeLabel = (type: FormFieldType) => FORM_FIELD_TYPES.find((t) => t.value === type)?.label ?? 'Field';

const BASE_LABEL: Partial<Record<FormFieldType, string>> = {
  text: 'Text',
  email: 'Email',
  number: 'Number',
  textarea: 'Message',
  dropdown: 'Choose one',
  radio: 'Pick one',
  checkbox: 'Select all that apply',
  date: 'Date',
  file: 'File',
  hiddenField: 'Hidden value',
  password: 'Password',
};

function uniqueLabel(base: string, existing: FormFieldDef[]): string {
  const taken = new Set(existing.map((f) => f.fieldLabel.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
}

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));

const DEFAULT_OPTIONS = () => ({ values: [{ option: 'Option 1' }, { option: 'Option 2' }] });

export function newField(type: FormFieldType, existing: FormFieldDef[]): FormFieldDef {
  const field: FormFieldDef = { id: newId(), fieldLabel: uniqueLabel(BASE_LABEL[type] ?? typeLabel(type), existing), fieldType: type, requiredField: false };
  if (FIELD_TYPES_WITH_OPTIONS.includes(type)) field.fieldOptions = DEFAULT_OPTIONS();
  if (type === 'hiddenField') {
    field.fieldName = 'source';
    field.fieldValue = '';
  }
  return field;
}

/** Changes the type and drops the settings the new type does not use. */
export function changeType(field: FormFieldDef, type: FormFieldType): FormFieldDef {
  const next: FormFieldDef = { ...field, fieldType: type };
  if (FIELD_TYPES_WITH_OPTIONS.includes(type)) {
    if (!next.fieldOptions?.values?.length) next.fieldOptions = DEFAULT_OPTIONS();
  } else delete next.fieldOptions;
  if (type !== 'file') {
    delete next.multipleFiles;
    delete next.acceptFileTypes;
  }
  if (type !== 'hiddenField') {
    delete next.fieldName;
    delete next.fieldValue;
  } else {
    delete next.placeholder;
    delete next.helpText;
    delete next.requiredField;
    next.fieldName ??= field.fieldLabel.trim().replace(/\W+/g, '_').toLowerCase() || 'source';
  }
  if (['file', 'checkbox', 'radio', 'hiddenField'].includes(type)) delete next.placeholder;
  if (['file', 'hiddenField'].includes(type)) delete next.defaultValue;
  return next;
}

export function moveField<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const target = Math.max(0, Math.min(list.length - 1, to));
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item!);
  return next;
}

/** Problems worth telling the builder about (the form still works, but probably not as intended). */
export function fieldProblems(list: FormFieldDef[]): string[] {
  const problems: string[] = [];
  const blank = list.filter((f) => !f.fieldLabel.trim()).length;
  if (blank) problems.push(`${blank} field${blank > 1 ? 's have' : ' has'} no label and will not be shown.`);
  const seen = new Map<string, number>();
  for (const f of list) {
    if (!f.fieldLabel.trim()) continue;
    const name = formOutputName(f);
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  for (const [name, count] of seen) if (count > 1) problems.push(`${count} fields are named "${name}": only the last one is kept in the output.`);
  for (const f of list) {
    if (['dropdown', 'radio'].includes(f.fieldType ?? '') && !(f.fieldOptions?.values ?? []).some((o) => o.option?.trim())) {
      problems.push(`"${f.fieldLabel || 'A field'}" has no options to choose from.`);
    }
  }
  return problems;
}
