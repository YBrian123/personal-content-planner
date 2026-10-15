import {describe,it,expect,vi} from 'vitest';
import {recordClock,mutation} from '../src/commands';
import {chinaDate,elapsed,emptyItem,reviewDate,due,safeUrl,validateBackup,checksum} from '../src/domain';
import {shouldClearDraft} from '../src/drafts';
import type {Context} from '../src/domain';
describe('independent business examples',()=>{
  it('54 hours of elapsed is distinct from manual work',()=>expect(elapsed({...emptyItem(),actualStart:'2026-10-14T01:00:00Z',actualFinish:'2026-10-16T07:00:00Z',status:'done'})).toBe('历时 54 小时'));
  it('does not fabricate missing start or minute precision',()=>{
    expect(elapsed({...emptyItem(),actualFinish:'2026-10-16T07:00:00Z'})).toBe('缺少开始记录');
    expect(elapsed({...emptyItem(),actualStart:'2026-10-14',actualFinish:'2026-10-16',startPrecision:'date',finishPrecision:'date'})).toBe('2 天（按日估算）');
  });
  it('calendar month and leap year boundaries',()=>{
    expect(reviewDate('2026-08-31','B')).toBe('2026-11-30'); expect(reviewDate('2026-08-31','A')).toBe('2027-02-28');
    expect(reviewDate('2027-08-31','A')).toBe('2028-02-29');expect(reviewDate('','A')).toBe('');
  });
  it('uses China midnight independent of device timezone',()=>{
    expect(chinaDate('2026-10-14T16:00:00Z')).toBe('2026-10-15');
    expect(due({...emptyItem(),planEnd:'2026-10-14'},'2026-10-15')).toBe('计划日期已过');
    expect(due({...emptyItem(),planEnd:'2026-10-14',status:'cancelled'},'2026-10-15')).toBe('');
  });
  it('rejects executable links',()=>{expect(safeUrl('javascript:alert(1)')).toBe(null);expect(safeUrl('https://example.com')).toBe('https://example.com/');});
  it('preserves newer and other-window drafts',()=>{
    expect(shouldClearDraft({key:'a',version:1},{key:'a',version:2})).toBe(false);
    expect(shouldClearDraft({key:'a',version:1},{key:'b',version:1})).toBe(false);
    expect(shouldClearDraft({key:'a',version:1},{key:'a',version:1})).toBe(true);
  });
  it('operation timestamps follow the server clock despite device clock skew',()=>{
    const c:Context={generation:'test',revision:1,schemaVersion:1,serverTime:'2026-10-15T00:00:00Z',records:[]};
    recordClock(c);const spy=vi.spyOn(Date,'now').mockReturnValue(Date.parse('2080-01-01'));
    const m=mutation(c,'status',{id:'test',status:'doing'},1);spy.mockRestore();
    expect(String(m.payload.occurredAt).slice(0,10)).toBe('2026-10-15');
  });
  it('detects truncated or modified backup',async()=>{
    const payload=JSON.stringify({schemaVersion:1,records:[]});const b={format:'personal-planner',payload,checksum:await checksum(payload),count:0,exportedAt:'2026-10-15T00:00:00Z'};
    expect((await validateBackup(b)).rows).toHaveLength(0);
    await expect(validateBackup({...b,payload:payload+'x'})).rejects.toThrow('校验');
  });
});
it('error messages keep specific date ordering and CSV cells stay literal',async()=>{
  const {errorText}=await import('../src/errors');const {csv,emptyItem,matchesView}=await import('../src/domain');
  expect(errorText(new Error('INVALID_DATE_ORDER'))).toBe('计划结束不能早于计划开始');
  expect(csv([{id:'x',kind:'item',parent_id:null,revision:1,created_at:'',updated_at:'',data:{...emptyItem(),title:'=1+1,"换行\n内容"'}}])).toContain('"\'=1+1,""换行\n内容"""');
  expect(matchesView({...emptyItem(),planEnd:'2026-01-01'},'overdue',false,'2026-01-02')).toBe(true);
});
