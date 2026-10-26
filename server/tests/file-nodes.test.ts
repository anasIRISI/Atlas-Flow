import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BinaryRef, Item, JsonObject, WorkflowNode } from '@flowforge/shared';
import { BinaryStore } from '../src/engine/binary-store.js';
import { parseCsv, parseCsvRows, toCsv } from '../src/nodes/_shared/csv.js';
import { findFiles, globToRegExp, resolveInRoot } from '../src/nodes/_shared/files.js';
import { emit, out, run, wf, type EdgeSpec, type NodeSpec } from './engine-helpers.js';

const store = new BinaryStore(mkdtempSync(join(tmpdir(), 'ff-bin-')));
let filesRoot: string;

beforeEach(() => {
  filesRoot = mkdtempSync(join(tmpdir(), 'ff-files-'));
});

const go = (nodes: NodeSpec[], edges: EdgeSpec[], settings: Record<string, unknown> = {}) => run(wf(nodes, edges), {}, {}, { binaryStore: store, filesRoot, settings });
/** Trigger → Data → Node. */
const exec = (type: string, params: JsonObject, data: JsonObject[], extra: Partial<WorkflowNode> = {}, settings: Record<string, unknown> = {}) =>
  go([['T', 'manual'], ['Data', 'test.emit', emit(data)], ['Node', `flowforge.${type}`, params, extra]], [['T', 'Data'], ['Data', 'Node']], settings);
const itemsOf = (r: Awaited<ReturnType<typeof run>>, node = 'Node', output = 0): Item[] => r.runData[node]?.[0]?.data.main[output] ?? [];
const fileOf = async (r: Awaited<ReturnType<typeof run>>, node = 'Node', index = 0, property = 'data') => {
  const ref = itemsOf(r, node)[index]?.binary?.[property] as BinaryRef;
  return { ref, text: (await store.read(ref)).toString('utf8'), data: await store.read(ref) };
};

const rows = [
  { id: 1, name: 'Ada', note: 'likes "quotes", commas', active: true },
  { id: 2, name: 'Alan', note: 'two\nlines', active: false, extra: { nested: 1 } },
  { id: 3, name: ' Grace ', note: '', active: null },
];

describe('CSV helpers', () => {
  it('writes RFC 4180 CSV: quotes, commas, line breaks, missing cells, objects', () => {
    expect(toCsv(rows)).toBe('id,name,note,active,extra\n1,Ada,"likes ""quotes"", commas",true,\n2,Alan,"two\nlines",false,"{""nested"":1}"\n3," Grace ",,,\n');
    expect(toCsv(rows.slice(0, 1), { delimiter: ';', headerRow: false })).toBe('1;Ada;"likes ""quotes"", commas";true\n');
    expect(toCsv([])).toBe('');
  });

  it('reads it back: quoted cells, escaped quotes, CRLF, BOM, blank lines, detected delimiter', () => {
    expect(parseCsvRows('a,b\r\n"1,5","say ""hi"""\r\n\r\n"multi\nline",x\n')).toEqual([['a', 'b'], ['1,5', 'say "hi"'], ['multi\nline', 'x']]);
    expect(parseCsvRows('﻿a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsvRows('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsvRows('a|b\n"x|y"|2')).toEqual([['a', 'b'], ['x|y', '2']]);
    expect(parseCsvRows('a,b,\n,,')).toEqual([['a', 'b', ''], ['', '', '']]);
    expect(parseCsvRows('a,""\n')).toEqual([['a', '']]);
    expect(parseCsvRows('')).toEqual([]);
    expect(() => parseCsvRows('a,b\n1,"oops')).toThrow('A quote opened on line 2 is never closed');
  });

  it('turns rows into objects with typed values', () => {
    expect(parseCsv('id,price,code,ok,name\n1,2.50,007,true,Ada\n-3,1e5,12345678901234567890,FALSE,\n')).toEqual([
      { id: 1, price: 2.5, code: '007', ok: true, name: 'Ada' },
      { id: -3, price: '1e5', code: '12345678901234567890', ok: false, name: '' },
    ]);
    expect(parseCsv('id,ok\n1,true', { readAsString: true })).toEqual([{ id: '1', ok: 'true' }]);
    expect(parseCsv('a,b\n1,2', { headerRow: false })).toEqual([{ row: ['a', 'b'] }, { row: [1, 2] }]);
    // Repeated or empty header names stay usable; short rows are padded.
    expect(parseCsv('x,x,,x\n1,2,3')).toEqual([{ x: 1, x_2: 2, column_3: 3, x_3: '' }]);
    expect(parseCsv('only,header\n')).toEqual([]);
  });
});

describe('Convert to File', () => {
  it('CSV: all items in one file', async () => {
    const r = await exec('convertToFile', { operation: 'csv' }, rows);
    expect(out(r, 'Node')).toEqual([{ fileName: 'file.csv', mimeType: 'text/csv', fileSize: expect.any(Number), itemCount: 3 }]);
    const file = await fileOf(r);
    expect(file.ref).toMatchObject({ fileName: 'file.csv', mimeType: 'text/csv', fileExtension: 'csv' });
    expect(file.text).toBe(toCsv(rows));
    expect(itemsOf(r)[0]!.pairedItem).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
  });

  it('CSV options: file name, delimiter, no header, BOM, other binary property', async () => {
    const r = await exec('convertToFile', { operation: 'csv', binaryPropertyName: 'report', options: { fileName: 'people.csv', delimiter: ';', headerRow: false, bom: true } }, [{ a: 1, b: 'x;y' }]);
    const file = await fileOf(r, 'Node', 0, 'report');
    expect(file.ref.fileName).toBe('people.csv');
    expect(file.data.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(file.text.slice(1)).toBe('1;"x;y"\n');
  });

  it('JSON: one file for all items, or one file per item', async () => {
    const all = await exec('convertToFile', { operation: 'json', options: { fileName: 'all.json' } }, [{ a: 1 }, { a: 2 }]);
    expect((await fileOf(all)).text).toBe('[\n  {\n    "a": 1\n  },\n  {\n    "a": 2\n  }\n]');
    expect((await fileOf(all)).ref).toMatchObject({ fileName: 'all.json', mimeType: 'application/json' });
    const each = await exec('convertToFile', { operation: 'json', mode: 'each', options: { fileName: '=item-{{ $json.a }}.json', pretty: false } }, [{ a: 1 }, { a: 2 }]);
    expect(out(each, 'Node')).toEqual([{ a: 1 }, { a: 2 }]);
    expect((await fileOf(each, 'Node', 1)).ref.fileName).toBe('item-2.json');
    expect((await fileOf(each, 'Node', 1)).text).toBe('{"a":2}');
  });

  it('HTML table, text file, Base64 string to file', async () => {
    const html = await fileOf(await exec('convertToFile', { operation: 'html' }, [{ name: 'Ada <x>' }]));
    expect(html.ref).toMatchObject({ fileName: 'file.html', mimeType: 'text/html' });
    expect(html.text).toContain('<meta charset="utf-8">');
    expect(html.text).toContain('Ada &lt;x&gt;');

    const text = await exec('convertToFile', { operation: 'text', sourceProperty: 'body.text', options: { fileName: 'note.txt' } }, [{ body: { text: 'héllo\nworld' }, keep: 1 }]);
    expect((await fileOf(text)).text).toBe('héllo\nworld');
    expect(out(text, 'Node')).toEqual([{ body: { text: 'héllo\nworld' }, keep: 1 }]);

    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const plain = await fileOf(await exec('convertToFile', { operation: 'base64', sourceProperty: 'b64', options: { fileName: 'pixel.png' } }, [{ b64: png.toString('base64') }]));
    expect(plain.data.equals(png)).toBe(true);
    expect(plain.ref).toMatchObject({ fileName: 'pixel.png', mimeType: 'image/png' });
    const dataUrl = await fileOf(await exec('convertToFile', { operation: 'base64', sourceProperty: 'b64' }, [{ b64: `data:image/png;base64,${png.toString('base64')}` }]));
    expect(dataUrl.ref).toMatchObject({ fileName: 'file.png', mimeType: 'image/png' });
    expect(dataUrl.data.equals(png)).toBe(true);
  });

  it('bad input: missing field, not Base64 (per item with On Error)', async () => {
    expect((await exec('convertToFile', { operation: 'text', sourceProperty: 'text' }, [{ other: 1 }])).error).toMatchObject({ message: 'Item 0 has no field "text"', hint: 'Fields of this item: other.' });
    const mixed = await exec('convertToFile', { operation: 'base64', sourceProperty: 'b' }, [{ b: 'aGk=' }, { b: 'not base64!!' }], { onError: 'continueRegularOutput' });
    expect(out(mixed, 'Node')).toEqual([{ b: 'aGk=' }, { error: 'Field "b" of item 1 is not a Base64 string' }]);
    expect((await fileOf(mixed)).text).toBe('hi');
  });
});

describe('Extract from File', () => {
  const chain = (convert: JsonObject, extract: JsonObject, data: JsonObject[], extra: Partial<WorkflowNode> = {}) =>
    go(
      [['T', 'manual'], ['Data', 'test.emit', emit(data)], ['File', 'flowforge.convertToFile', convert], ['Node', 'flowforge.extractFromFile', extract, extra]],
      [['T', 'Data'], ['Data', 'File'], ['File', 'Node']],
    );
  const fromText = (text: string, extract: JsonObject, extra: Partial<WorkflowNode> = {}) => chain({ operation: 'text', sourceProperty: 'text' }, extract, [{ text }], extra);

  it('CSV: one item per row, values typed — the round trip gives the data back', async () => {
    const r = await chain({ operation: 'csv' }, { operation: 'csv' }, rows);
    expect(out(r, 'Node')).toEqual([
      { id: 1, name: 'Ada', note: 'likes "quotes", commas', active: true, extra: '' },
      { id: 2, name: 'Alan', note: 'two\nlines', active: false, extra: '{"nested":1}' },
      { id: 3, name: ' Grace ', note: '', active: '', extra: '' },
    ]);
    expect(itemsOf(r).every((i) => JSON.stringify(i.pairedItem) === '{"item":0}')).toBe(true);
  });

  it('CSV options: detected or given delimiter, no header row, everything as text', async () => {
    expect(out(await fromText('a;b\n1;x,y', { operation: 'csv' }), 'Node')).toEqual([{ a: 1, b: 'x,y' }]);
    expect(out(await fromText('a;b,c\n1;2,3', { operation: 'csv', options: { delimiter: ',' } }), 'Node')).toEqual([{ 'a;b': '1;2', c: 3 }]);
    expect(out(await fromText('1,2\n3,4', { operation: 'csv', options: { headerRow: false } }), 'Node')).toEqual([{ row: [1, 2] }, { row: [3, 4] }]);
    expect(out(await fromText('zip\n01234', { operation: 'csv', options: { readAsString: true } }), 'Node')).toEqual([{ zip: '01234' }]);
  });

  it('JSON: a list gives one item per element, an object one item', async () => {
    expect(out(await chain({ operation: 'json' }, { operation: 'json' }, [{ a: 1 }, { a: 2 }]), 'Node')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(out(await fromText('{"x":{"y":1}}', { operation: 'json' }), 'Node')).toEqual([{ x: { y: 1 } }]);
    expect(out(await fromText('[1,"two",{"three":3}]', { operation: 'json' }), 'Node')).toEqual([{ data: 1 }, { data: 'two' }, { three: 3 }]);
  });

  it('text and Base64', async () => {
    expect(out(await fromText('héllo\nworld', { operation: 'text' }), 'Node')).toEqual([{ data: 'héllo\nworld' }]);
    expect(out(await fromText('abc', { operation: 'text', destinationKey: 'content.text', options: { keepSource: true } }), 'Node')).toEqual([{ text: 'abc', content: { text: 'abc' } }]);
    expect(out(await fromText('hi', { operation: 'binaryToProperty', destinationKey: 'b64' }), 'Node')).toEqual([{ b64: 'aGk=' }]);
  });

  it('bad input: no file, invalid JSON, broken CSV (per item with On Error)', async () => {
    const none = await exec('extractFromFile', { operation: 'csv' }, [{ a: 1 }]);
    expect(none.error).toMatchObject({ message: 'Item 0 has no file in "data"', hint: 'Binary properties of this item: none. Set "Input Binary Field" to one of them.' });
    expect((await fromText('{oops', { operation: 'json' })).error?.message).toMatch(/^"file.txt" is not valid JSON: /);
    expect((await fromText('a,b\n1,"x', { operation: 'csv' })).error).toMatchObject({ message: '"file.txt" is not valid CSV: A quote opened on line 2 is never closed' });
    expect(out(await fromText('{oops', { operation: 'json' }, { onError: 'continueRegularOutput' }), 'Node')).toEqual([{ error: expect.stringMatching(/is not valid JSON/) }]);
    expect((await fromText('x', { operation: 'csv', binaryPropertyName: 'attachment' })).error?.hint).toBe('Binary properties of this item: data. Set "Input Binary Field" to one of them.');
  });
});

describe('Read/Write Files from Disk', () => {
  const write = (fileName: string, text: string, options: JsonObject = {}, extra: Partial<WorkflowNode> = {}) =>
    go(
      [['T', 'manual'], ['Data', 'test.emit', emit([{ text, keep: 'me' }])], ['File', 'flowforge.convertToFile', { operation: 'text', sourceProperty: 'text' }], ['Node', 'flowforge.readWriteFile', { operation: 'write', fileName, options }, extra]],
      [['T', 'Data'], ['Data', 'File'], ['File', 'Node']],
    );
  const read = (fileSelector: string, options: JsonObject = {}, extra: Partial<WorkflowNode> = {}) => exec('readWriteFile', { operation: 'read', fileSelector, options }, [{}], extra);

  it('writes a file inside the files folder (creating sub-folders), then reads it back', async () => {
    const w = await write('reports/2026/hello.txt', 'bonjour');
    expect(w.status).toBe('success');
    expect(out(w, 'Node')).toEqual([{ text: 'bonjour', keep: 'me', fileName: 'reports/2026/hello.txt', fileSize: 7 }]);
    expect(readFileSync(join(filesRoot, 'reports/2026/hello.txt'), 'utf8')).toBe('bonjour');

    const r = await read('reports/2026/hello.txt');
    expect(out(r, 'Node')).toEqual([{ fileName: 'hello.txt', directory: 'reports/2026', path: 'reports/2026/hello.txt', fileExtension: 'txt', mimeType: 'text/plain', fileSize: 7 }]);
    expect((await fileOf(r)).text).toBe('bonjour');
    expect((await fileOf(r)).ref).toMatchObject({ fileName: 'hello.txt', mimeType: 'text/plain' });
  });

  it('append adds to the file; without it the file is replaced', async () => {
    await write('log.txt', 'one\n');
    await write('log.txt', 'two\n', { append: true });
    expect(readFileSync(join(filesRoot, 'log.txt'), 'utf8')).toBe('one\ntwo\n');
    await write('log.txt', 'fresh');
    expect(readFileSync(join(filesRoot, 'log.txt'), 'utf8')).toBe('fresh');
  });

  it('reads several files with a pattern', async () => {
    mkdirSync(join(filesRoot, 'in/deep/er'), { recursive: true });
    for (const f of ['in/a.csv', 'in/b.csv', 'in/c.txt', 'in/deep/d.csv', 'in/deep/er/e.csv', 'top.csv']) writeFileSync(join(filesRoot, f), f);
    const names = async (selector: string) => out(await read(selector), 'Node').map((j) => j.path);
    expect(await names('in/*.csv')).toEqual(['in/a.csv', 'in/b.csv']);
    expect(await names('in/**/*.csv')).toEqual(['in/a.csv', 'in/b.csv', 'in/deep/d.csv', 'in/deep/er/e.csv']);
    expect(await names('**/*.csv')).toEqual(['in/a.csv', 'in/b.csv', 'in/deep/d.csv', 'in/deep/er/e.csv', 'top.csv']);
    expect(await names('*.csv')).toEqual(['top.csv']);
    expect(await names('in/?.{csv,txt}')).toEqual(['in/a.csv', 'in/b.csv', 'in/c.txt']);
    expect(await names('in/*.pdf')).toEqual([]);
    const r = await read('in/*.csv', { dataPropertyName: 'file', mimeType: 'text/plain' });
    expect((await fileOf(r, 'Node', 1, 'file')).text).toBe('in/b.csv');
    expect(itemsOf(r)[1]!.binary!.file!.mimeType).toBe('text/plain');
  });

  it('refuses anything outside the files folder: "..", absolute paths, links', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ff-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    symlinkSync(outside, join(filesRoot, 'link'));
    for (const path of ['../secret.txt', '../../etc/passwd', '/etc/passwd', join(outside, 'secret.txt'), 'link/secret.txt', 'a/../../x.txt']) {
      const r = await read(path);
      expect(r.error?.message, path).toBe(`"${path}" is outside the files folder`);
      expect(r.error?.hint, path).toContain(filesRoot);
      const w = await write(path, 'nope');
      expect(w.error?.message, path).toBe(`"${path}" is outside the files folder`);
    }
    expect((await read('../*.txt')).error?.message).toBe('"../*.txt" is outside the files folder');
    expect((await read('link/*.txt')).error?.message).toMatch(/is outside the files folder/);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
    expect(existsSync(join(outside, 'x.txt'))).toBe(false);
    // An absolute path inside the folder is fine.
    writeFileSync(join(filesRoot, 'ok.txt'), 'ok');
    expect(out(await read(join(filesRoot, 'ok.txt')), 'Node')[0]).toMatchObject({ path: 'ok.txt' });
  });

  it('clear errors: file not found, a folder, empty path, no file to write (per item with On Error)', async () => {
    expect((await read('nope.txt')).error).toMatchObject({ message: 'File "nope.txt" not found' });
    mkdirSync(join(filesRoot, 'dir'));
    expect((await read('dir')).error).toMatchObject({ message: '"dir" is a folder', hint: 'Use a pattern such as "dir/*" to read its files.' });
    expect((await read(' ')).error?.message).toBe('The file selector is empty');
    expect((await write('', 'x')).error?.message).toBe('The file path is empty');
    expect((await write('dir', 'x')).error?.message).toBe('Could not write "dir" (EISDIR)');
    expect((await exec('readWriteFile', { operation: 'write', fileName: 'x.txt' }, [{ a: 1 }])).error?.message).toBe('Item 0 has no binary property "data"');
    expect(out(await read('nope.txt', {}, { onError: 'continueRegularOutput' }), 'Node')).toEqual([{ error: 'File "nope.txt" not found' }]);
    // Without a files folder (plain engine run) the node explains instead of guessing a path.
    const bare = await run(wf([['T', 'manual'], ['Node', 'flowforge.readWriteFile', { operation: 'read', fileSelector: 'x' }]], [['T', 'Node']]));
    expect(bare.error?.message).toBe('File access is not available in this run');
  });

  it('path helpers', async () => {
    expect(resolveInRoot(filesRoot, 'a/b.txt')).toBe(join(filesRoot, 'a/b.txt'));
    expect(resolveInRoot(filesRoot, './a/../b.txt')).toBe(join(filesRoot, 'b.txt'));
    expect(() => resolveInRoot(filesRoot, 'a\0b')).toThrow(/outside the files folder/);
    expect(globToRegExp('a/*.csv').test('a/x.csv')).toBe(true);
    expect(globToRegExp('a/*.csv').test('a/b/x.csv')).toBe(false);
    expect(globToRegExp('a/**/x.(1).csv').test('a/b/c/x.(1).csv')).toBe(true);
    expect(globToRegExp('**').test('any/thing.txt')).toBe(true);
    expect(await findFiles(filesRoot, 'missing-folder/*.txt')).toEqual([]);
  });
});

describe('Execute Command', () => {
  const enabled = { executeCommandEnabled: true };
  const command = (params: JsonObject, data: JsonObject[] = [{}], extra: Partial<WorkflowNode> = {}, settings: Record<string, unknown> = enabled) => exec('executeCommand', params, data, extra, settings);

  it('is disabled by default, with an error that says how to enable it — nothing runs', async () => {
    const marker = join(filesRoot, 'should-not-exist.txt');
    for (const settings of [{}, { executeCommandEnabled: false }, { executeCommandEnabled: 'true' }]) {
      const r = await command({ command: `echo hacked > "${marker}"` }, [{}], {}, settings);
      expect(r.status).toBe('error');
      expect(r.error).toMatchObject({
        message: 'The Execute Command node is disabled',
        hint: 'An administrator can turn it on in Settings → Security → "Allow the Execute Command node".',
        node: 'Node',
      });
    }
    expect(existsSync(marker)).toBe(false);
    // "On Error: continue" does not run the command either.
    const soft = await command({ command: `echo hacked > "${marker}"` }, [{}], { onError: 'continueRegularOutput' }, {});
    expect(out(soft, 'Node')).toEqual([{ error: 'The Execute Command node is disabled' }]);
    expect(existsSync(marker)).toBe(false);
  });

  it('once enabled: runs the command in the files folder and returns exit code, stdout and stderr', async () => {
    writeFileSync(join(filesRoot, 'here.txt'), 'x');
    expect(out(await command({ command: 'echo hello && echo warn 1>&2' }), 'Node')).toEqual([{ exitCode: 0, stdout: 'hello', stderr: 'warn' }]);
    expect(out(await command({ command: 'ls' }), 'Node')[0]!.stdout).toBe('here.txt');
    // Expressions build the command; "Execute Once" off runs it for every item.
    const each = await command({ command: '=echo "{{ $json.n * 2 }}"', executeOnce: false }, [{ n: 1 }, { n: 21 }]);
    expect(out(each, 'Node').map((j) => j.stdout)).toEqual(['2', '42']);
    expect(out(await command({ command: '=echo "{{ $json.n }}"' }, [{ n: 1 }, { n: 2 }]), 'Node')).toEqual([{ exitCode: 0, stdout: '1', stderr: '' }]);
  });

  it('a failing command is an error with its output; On Error works per item', async () => {
    const r = await command({ command: 'echo "disk full" 1>&2; exit 3' });
    expect(r.error).toMatchObject({ message: 'The command failed with exit code 3', description: 'disk full' });
    expect((await command({ command: 'definitely-not-a-command-xyz' })).error?.message).toMatch(/^The command failed with exit code (127|1)$/);
    expect((await command({ command: '  ' })).error?.message).toBe('The command is empty');
    const each = await command({ command: '=exit {{ $json.code }}', executeOnce: false }, [{ code: 0 }, { code: 2 }], { onError: 'continueRegularOutput' });
    expect(out(each, 'Node')).toEqual([{ exitCode: 0, stdout: '', stderr: '' }, { error: 'The command failed with exit code 2' }]);
    expect(out(await command({ command: 'exit 1' }, [{}], { onError: 'continueRegularOutput' }), 'Node')).toEqual([{ error: 'The command failed with exit code 1' }]);
  });

  it('a command that runs too long is stopped', async () => {
    const started = Date.now();
    const r = await command({ command: 'sleep 20', options: { timeout: 1 } });
    expect(r.error).toMatchObject({ message: 'The command did not finish within 1 s and was stopped' });
    expect(Date.now() - started).toBeLessThan(6000);
  });
});
