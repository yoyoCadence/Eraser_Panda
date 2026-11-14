import { describe, expect, it } from 'vitest';
import { filesFromEntries, wantedFromFolder, type FsEntry } from '../src/ui/folderFiles';

const file = (name: string): FsEntry => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(new File(['x'], name)) });
/** a directory whose reader returns its children in batches of 2, like real readEntries() */
const dir = (name: string, children: FsEntry[]): FsEntry => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let i = 0;
    return { readEntries: (ok) => ok(children.slice(i, (i += 2))) };
  },
});

describe('folder drop', () => {
  it('keeps supported documents, skips Office lock files, hidden files and other types', () => {
    expect(['a.pdf', 'b.DOCX', 'c.xlsx', 'd.pptm', 'e.csv'].every(wantedFromFolder)).toBe(true);
    expect(['~$b.docx', '.DS_Store', 'Thumbs.db', 'photo.png', 'old.doc', 'notes'].some(wantedFromFolder)).toBe(false);
  });

  it('walks nested folders across readEntries batches', async () => {
    const tree = dir('root', [file('a.pdf'), file('~$a.docx'), dir('sub', [file('b.docx'), file('c.png'), dir('deeper', [file('d.xlsx')])]), file('e.txt'), file('.hidden.pdf')]);
    const { files, skipped } = await filesFromEntries([tree]);
    expect(files.map((f) => f.name).sort()).toEqual(['a.pdf', 'b.docx', 'd.xlsx', 'e.txt']);
    expect(skipped).toBe(3);
  });

  it('files dropped directly (not from a folder) are always passed through', async () => {
    const { files } = await filesFromEntries([file('report.doc')]);
    expect(files.map((f) => f.name)).toEqual(['report.doc']); // the app explains legacy formats itself
  });
});
