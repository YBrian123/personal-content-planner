import 'fake-indexeddb/auto';
import {it,expect,vi,afterEach} from 'vitest';
import {drafts} from '../src/drafts';
import type {Draft} from '../src/drafts';
const sample=(user='owner',editor='window-a',version=1):Draft=>({key:[user,editor].join(':'),user,instance:'draft-test',item:'item',editor,version,generation:'generation',revision:1,updatedAt:'2026-10-15T00:00:00Z',values:{notes:'稿 '+version}});
afterEach(()=>vi.restoreAllMocks());
it('clearing submitted A never removes B saved while the request was in flight',async()=>{
  const a=sample();await drafts.save(a);const b={...a,version:2,values:{notes:'后写入的稿 B'}};
  await Promise.all([drafts.clearVersion(a.key,1),drafts.save(b)]);
  expect((await drafts.find(a.user,a.instance,a.item)).find(d=>d.key===a.key)?.values.notes).toBe('后写入的稿 B');
  await drafts.clearVersion(a.key,2);expect((await drafts.find(a.user,a.instance,a.item)).some(d=>d.key===a.key)).toBe(false);
});
it('logout clears all current-user drafts while preserving another user',async()=>{
  await Promise.all([drafts.save(sample('owner','window-a')),drafts.save(sample('owner','window-b')),drafts.save(sample('other','window-a'))]);
  await drafts.clearUser('owner');expect(await drafts.find('owner','draft-test','item')).toHaveLength(0);expect(await drafts.find('other','draft-test','item')).toHaveLength(1);
});
it('storage failure rejects the draft operation instead of reporting success',async()=>{
  await drafts.save(sample('quota'));const transaction=vi.spyOn(IDBDatabase.prototype,'transaction').mockImplementation(()=>{throw new DOMException('空间不足','QuotaExceededError');});
  await expect(drafts.save({...sample('quota'),version:2})).rejects.toThrow('空间不足');transaction.mockRestore();
  expect((await drafts.find('quota','draft-test','item'))[0].version).toBe(1);
});
